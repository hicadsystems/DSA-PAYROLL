// ============================================================
// ADMIN PAYSLIP (self-service dashboard, payroll admins)
// routes/user-dashboard/payslips/adminpayslip.js
//
// Same layout and figures as the payroll payslip report — see
// payslip.engine.js. One generation run per payroll class.
// ============================================================

"use strict";

const express = require("express");
const router = express.Router();
const archiver = require("archiver");
const pool = require("../../../config/db");
const verifyToken = require("../../../middware/authentication");
const engine = require("./payslip.engine");

// Only payroll admins (role "hicad" — same flag the payslip page uses to show
// the admin tab) may search for or generate other personnel's payslips.
function requirePayslipAdmin(req, res, next) {
  if (String(req.user_role || "").toLowerCase() === "hicad") return next();
  return res
    .status(403)
    .json({ error: "You are not authorised to access other personnel payslips." });
}

async function resolveEmployeeIds(
  mode,
  { employeeId, employeeIds, fromId, toId },
) {
  switch (mode) {
    case "single": {
      if (!employeeId)
        throw {
          status: 400,
          message: "employeeId is required for single mode.",
        };
      return [String(employeeId)];
    }
    case "multi": {
      if (!Array.isArray(employeeIds) || employeeIds.length === 0)
        throw {
          status: 400,
          message: "employeeIds must be a non-empty array for multi mode.",
        };
      if (employeeIds.length > 500)
        throw {
          status: 400,
          message: "Maximum 500 employees per multi request.",
        };
      return employeeIds.map(String);
    }
    case "range": {
      if (!fromId || !toId)
        throw {
          status: 400,
          message: "fromId and toId are required for range mode.",
        };
      const [rows] = await pool.query(
        `SELECT EMPL_ID FROM hr_employees
         WHERE EMPL_ID >= ? AND EMPL_ID <= ?
         ORDER BY EMPL_ID ASC`,
        [String(fromId), String(toId)],
      );
      if (!rows || rows.length === 0)
        throw {
          status: 404,
          message: "No employees found in the specified range.",
        };
      if (rows.length > 500)
        throw {
          status: 400,
          message: "Range exceeds 500 employees. Please narrow the range.",
        };
      return rows.map((r) => String(r.EMPL_ID));
    }
    default:
      throw {
        status: 400,
        message: "mode must be one of: single, multi, range.",
      };
  }
}

// ============================================================
// POST /adm/payslip/generate
// Body: { mode, employeeId | employeeIds | fromId+toId, year, month }
// ============================================================
router.post("/generate", verifyToken, requirePayslipAdmin, async (req, res) => {
  const { mode, employeeId, employeeIds, fromId, toId } = req.body;

  let period;
  try {
    period = engine.parsePeriod(req.body.year, req.body.month);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  try {
    let empIds;
    try {
      empIds = await resolveEmployeeIds(mode, { employeeId, employeeIds, fromId, toId });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    // Group by payroll DB — one generation run per class
    const classMap = await engine.classifyEmployees(empIds);
    const groups = new Map();
    const results = [];

    for (const empId of empIds) {
      const meta = classMap.get(empId);
      if (!meta) {
        results.push({
          empId,
          skipped: true,
          reason: "Employee not found or no active payroll class.",
        });
        continue;
      }
      if (!groups.has(meta.targetDb)) {
        groups.set(meta.targetDb, { payrollclass: meta.payrollclass, ids: [] });
      }
      groups.get(meta.targetDb).ids.push(empId);
    }

    const groupOutputs = await Promise.all(
      [...groups.entries()].map(async ([targetDb, g]) => {
        const out = await engine.generateForClass({
          targetDb,
          payrollclass: g.payrollclass,
          empIds: g.ids,
          year: period.year,
          month: period.month,
          station: engine.stationKey("AP", req.user_id),
        });
        if (!out.ok) {
          return g.ids.map((empId) => ({ empId, skipped: true, reason: out.message }));
        }
        const byId = new Map(out.data.map((e) => [String(e.employee_id), e]));
        return g.ids.map((empId) =>
          byId.has(empId)
            ? { empId, data: byId.get(empId) }
            : { empId, skipped: true, reason: "No payslip found for this period." },
        );
      }),
    );

    results.push(...groupOutputs.flat());
    const successful = results.filter((r) => !r.skipped).length;

    return res.json({
      success: true,
      summary: { total: empIds.length, successful, skipped: results.length - successful },
      results,
    });
  } catch (err) {
    console.error("❌ Admin payslip generate error:", err);
    return res.status(500).json({ error: "An error occurred while generating payslips." });
  }
});

// ============================================================
// POST /adm/payslip/pdf   Body: { results, delivery: "merged" | "zip" }
// ============================================================
router.post("/pdf", verifyToken, requirePayslipAdmin, async (req, res) => {
  const { results, delivery = "merged" } = req.body;

  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: "No results provided." });
  }
  const entries = results.filter((r) => r && r.data);
  if (entries.length === 0) {
    return res.status(400).json({ error: "No valid payslip data to render." });
  }

  const first = entries[0].data || {};
  const periodLabel = `${first.payroll_month || ""} ${first.payroll_year || ""}`.trim();

  try {
    if (delivery === "merged") {
      const pdf = await engine.renderPdf(entries.map((e) => e.data), { priority: "low" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${`Payslips ${periodLabel}`.trim()}.pdf"`,
      );
      return res.send(Buffer.from(pdf));
    }

    if (delivery === "zip") {
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${`Payslips ${periodLabel}`.trim()}.zip"`,
      );
      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (err) => {
        console.error("❌ Payslip zip error:", err);
        res.destroy(err);
      });
      archive.pipe(res);
      for (const entry of entries) {
        const buf = await engine.renderPdf([entry.data], { priority: "low" });
        archive.append(Buffer.from(buf), { name: engine.payslipFileName(entry.data) });
      }
      await archive.finalize();
      return;
    }

    return res.status(400).json({ error: "delivery must be 'merged' or 'zip'." });
  } catch (err) {
    console.error("❌ Admin payslip PDF error:", err);
    if (!res.headersSent) return res.status(500).json({ error: "PDF generation failed." });
    res.destroy(err);
  }
});

// ============================================================
// GET /adm/payslip/search
// ============================================================
// One search over service number AND names, so any ID format works
// (DSA uses N/9995, S10703F, plain numbers…). Exact ID first, then IDs that
// start with the term, then surname / other-name matches.
router.get("/search", verifyToken, requirePayslipAdmin, async (req, res) => {
  const { q, max } = req.query;

  if (!q || String(q).trim().length < 2) {
    return res
      .status(400)
      .json({ error: "Search query must be at least 2 characters." });
  }

  const term = String(q).trim();
  const limit = Math.min(parseInt(max) || 15, 30);
  const startsWith = term.replace(/[\\%_]/g, "\\$&") + "%";

  const activePredicate = `(
    (DateLeft IS NULL OR DateLeft = '' OR DateLeft > DATE_FORMAT(CURDATE(), '%Y%m%d'))
    AND (exittype IS NULL OR exittype = '')
  )`;

  try {
    const [rows] = await pool.query(
      `SELECT EMPL_ID AS id, Title AS title, Surname AS surname, OtherName AS othername
         FROM hr_employees
        WHERE ${activePredicate}
          AND (EMPL_ID LIKE ? OR Surname LIKE ? OR OtherName LIKE ?)
        ORDER BY (EMPL_ID = ?) DESC,
                 (EMPL_ID LIKE ?) DESC,
                 Surname ASC, OtherName ASC
        LIMIT ?`,
      [startsWith, startsWith, startsWith, term, startsWith, limit],
    );

    return res.json(
      (rows || []).map((row) => ({
        id: String(row.id || ""),
        title: String(row.title || ""),
        surname: String(row.surname || ""),
        othername: String(row.othername || ""),
      })),
    );
  } catch (err) {
    console.error("❌ Employee search error:", err);
    return res
      .status(500)
      .json({ error: "An error occurred during employee search." });
  }
});

module.exports = router;
