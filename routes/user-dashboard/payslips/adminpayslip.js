// ============================================================
// ADMIN PAYSLIP CONTROLLER
// routes/admin/adminPayslip.js
//
// Performance model (after SP rewrite):
//
//   BEFORE:  500 employees  →  500 SP calls  (one per employee)
//   AFTER:   500 employees  →  N SP calls    (one per payroll class)
//            N is typically 1-5 for most organisations.
//
// Flow:
//   1. Resolve employee IDs                         (1 query)
//   2. Bulk-classify → group by payroll class       (1 JOIN query)
//   3. For each class-group: call SP once with the
//      full EMPL_ID range, under a unique session key
//                                                   (N SP calls, parallel)
//   4. Fetch all written rows in one SELECT per group
//   5. Map rows → per-employee payslip objects
// ============================================================

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const pool = require("../../../config/db");
const verifyToken = require("../../../middware/authentication");
const BaseReportController = require("../../../controllers/Reports/reportsFallbackController");

// ── Tuning ───────────────────────────────────────────────────
const PDF_BATCH_SIZE = 50;

// ── Lazy PDF controller singleton ────────────────────────────
let _controller = null;
function getController() {
  if (!_controller) _controller = new BaseReportController();
  return _controller;
}

// ============================================================
// PURE HELPERS
// ============================================================

function zeroPad(n) {
  return String(n).padStart(2, "0");
}

function buildPeriod(year, month) {
  return `${year}${zeroPad(month)}`;
}

/**
 * Unique write key for py_webpayslip.work_station.
 * Scopes each admin request's output rows so concurrent requests
 * don't collide, and so the final SELECT reads only this batch.
 * Format: "adm_{timestamp}_{random4hex}"
 */
function makeSessionKey() {
  return `adm_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`;
}

/**
 * Convert a flat array of py_webpayslip rows (all belonging to one employee)
 * into the structured payslip object the PDF template expects.
 */
function mapPayslipRows(rows) {
  if (!rows || rows.length === 0) return null;

  const first = rows[0];
  const emp = {
    employee_id: first.numb || first.NUMB || "",
    surname: first.surname,
    othername: first.othername,
    title: first.title,
    gradelevel: first.gradelevel,
    department: first.location || first.Location || "",
    factory: first.factory || "",
    bank_name: first.bankname || "",
    bank_account_number: first.bankacnumber || "",
    nsitfcode: first.nsitfcode || "",
    payroll_month: first.desc1,
    payroll_year: first.ord,
    ippis: {
      taxable: [],
      nontaxable: [],
      deductions: [],
      taxable_total: 0,
      nontaxable_total: 0,
      deductions_total: 0,
      net: 0,
    },
    navy: {
      taxable: [],
      nontaxable: [],
      deductions: [],
      taxable_total: 0,
      nontaxable_total: 0,
      deductions_total: 0,
      net: 0,
    },
    net_pay: 0,
  };

  for (const row of rows) {
    const source = (row.source || "").toUpperCase();
    const category = (row.bpc || "").toUpperCase();
    const amount = parseFloat(row.bpm || row.BPM) || 0;
    const lbal = parseFloat(row.lbal) || 0;
    const lmth = parseInt(row.lmth) || 0;

    const item = {
      description: row.bp || row.BP || "",
      amount,
      loan_balance: lbal > 0 ? lbal : null,
      outstanding_months: lmth > 0 ? lmth : null,
    };

    const bucket = source === "IPPIS" ? emp.ippis : emp.navy;

    if (category === "BP" || category === "BT") {
      bucket.taxable.push(item);
      bucket.taxable_total += amount;
    } else if (category === "PT") {
      bucket.nontaxable.push(item);
      bucket.nontaxable_total += amount;
    } else if (category === "PR" || category === "PL") {
      bucket.deductions.push(item);
      bucket.deductions_total += amount;
    }
  }

  emp.ippis.net =
    emp.ippis.taxable_total +
    emp.ippis.nontaxable_total -
    emp.ippis.deductions_total;
  emp.navy.net =
    emp.navy.taxable_total +
    emp.navy.nontaxable_total -
    emp.navy.deductions_total;
  emp.net_pay = emp.ippis.net + emp.navy.net;

  const isEmpty = (s) =>
    s.taxable.length === 0 &&
    s.nontaxable.length === 0 &&
    s.deductions.length === 0;
  if (isEmpty(emp.ippis)) emp.ippis = null;
  if (isEmpty(emp.navy)) emp.navy = null;

  return emp;
}

// ============================================================
// RESOLVE EMPLOYEE IDs
// ============================================================

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
// BULK CLASSIFY
// One JOIN → Map<empId, { payrollclass, targetDb }>
// ============================================================

async function classifyEmployees(empIds) {
  if (empIds.length === 0) return new Map();

  const [rows] = await pool.query(
    `SELECT e.EMPL_ID, e.payrollclass, p.db_name AS targetDb
     FROM hr_employees e
     JOIN py_payrollclass p
       ON  p.classcode = e.payrollclass
       AND p.status    = 'active'
     WHERE e.EMPL_ID IN (?)`,
    [empIds],
  );

  const map = new Map();
  for (const r of rows) {
    map.set(String(r.EMPL_ID), {
      payrollclass: String(r.payrollclass),
      targetDb: r.targetDb,
    });
  }
  return map;
}

// ============================================================
// PROCESS ONE CLASS-GROUP
//
// One dedicated connection → USE targetDb → call SP ONCE for the
// entire group → fetch all written rows → split per empId.
//
// The SP's p_username is a unique session key scoped to this
// request — NOT an employee ID. This means:
//   - Concurrent admin requests never overwrite each other's rows
//   - The final SELECT reads exactly this batch's output
//   - Rows are cleaned up immediately after reading
// ============================================================

async function processClassGroup(
  targetDb,
  payrollclass,
  empIds,
  period,
  inputYear,
  inputMonth,
  monthdesc,
) {
  const conn = await pool.getConnection();
  const sessionKey = makeSessionKey();
  let switchedDb = false;

  try {
    // ── Switch to payroll DB ──────────────────────────────────
    await conn.query(`USE \`${targetDb}\``);
    switchedDb = true;

    // ── BT05: determine current processing period ─────────────
    const [[bt05]] = await conn.query(
      `SELECT ord, mth FROM py_stdrate WHERE type = 'BT05' LIMIT 1`,
    );
    if (!bt05) {
      return empIds.map((empId) => ({
        empId,
        skipped: true,
        reason: "Could not determine processing period from payroll DB.",
      }));
    }

    const isCurrentPeriod =
      inputYear === parseInt(bt05.ord) && inputMonth === parseInt(bt05.mth);

    // ── Current period: bulk readiness check ──────────────────
    let notReadyIds = new Set();
    if (isCurrentPeriod) {
      const [readyRows] = await conn.query(
        `SELECT DISTINCT numb
         FROM py_ipis_payhistory
         WHERE period = ? AND numb IN (?)`,
        [period, empIds],
      );
      const readySet = new Set(readyRows.map((r) => String(r.numb)));
      for (const id of empIds) {
        if (!readySet.has(id)) notReadyIds.add(id);
      }
    }

    const processable = empIds.filter((id) => !notReadyIds.has(id));
    const skippedEarly = [...notReadyIds].map((empId) => ({
      empId,
      skipped: true,
      reason: "Payslip not ready yet for the current period.",
    }));

    if (processable.length === 0) {
      return skippedEarly;
    }

    // ── Single SP call for the whole group ────────────────────
    const sortedIds = [...processable].sort();
    const fromId = sortedIds[0];
    const toId = sortedIds[sortedIds.length - 1];

    await conn.query(`CALL py_generate_combined_payslip(?, ?, ?, ?, ?, '1')`, [
      fromId,
      toId,
      period,
      payrollclass,
      sessionKey,
    ]);

    // ── Fetch all rows written by this SP call ────────────────
    const [allRows] = await conn.query(
      `SELECT * FROM py_webpayslip
       WHERE work_station = ? AND ord = ? AND desc1 = ?
       ORDER BY numb, source DESC, bpc, bp`,
      [sessionKey, String(inputYear), monthdesc],
    );

    // ── Async cleanup — don't block the response ──────────────
    conn
      .query(`DELETE FROM py_webpayslip WHERE work_station = ?`, [sessionKey])
      .catch((e) => console.warn("⚠️ Session cleanup failed:", e.message));

    // ── Group rows by employee ────────────────────────────────
    const rowsByEmp = new Map();
    for (const row of allRows) {
      const id = String(row.numb || row.NUMB);
      if (!rowsByEmp.has(id)) rowsByEmp.set(id, []);
      rowsByEmp.get(id).push(row);
    }

    // ── Build result array ────────────────────────────────────
    const groupResults = processable.map((empId) => {
      const empRows = rowsByEmp.get(empId);
      if (!empRows || empRows.length === 0) {
        return {
          empId,
          skipped: true,
          reason: "No payslip rows found after SP execution.",
        };
      }
      return { empId, data: mapPayslipRows(empRows) };
    });

    return [...skippedEarly, ...groupResults];
  } catch (err) {
    // Best-effort cleanup of any written rows
    conn
      .query(`DELETE FROM py_webpayslip WHERE work_station = ?`, [sessionKey])
      .catch(() => {});
    throw err;
  } finally {
    // ── Safe connection return ────────────────────────────────
    // If we switched DB, we must either reset the connection back
    // to the master DB before releasing, or destroy it entirely.
    // Never release a connection still pointing at a non-master DB —
    // it will contaminate subsequent unrelated requests from the pool.
    if (switchedDb) {
      try {
        await conn.query(`USE \`hicaddata\``);
        conn.release();
      } catch (_) {
        // Reset failed — destroy so the dirty connection
        // never goes back into the pool.
        console.warn("⚠️ Failed to reset DB context — destroying connection.");
        conn.destroy();
      }
    } else {
      // Never switched — safe to release as-is
      conn.release();
    }
  }
}

// ============================================================
// POST /admin/payslip/generate
// ============================================================

router.post("/generate", verifyToken, async (req, res) => {
  const { mode, employeeId, employeeIds, fromId, toId, year, month } = req.body;

  const inputYear = parseInt(year);
  const inputMonth = parseInt(month);

  if (!inputYear || !inputMonth || inputMonth < 1 || inputMonth > 12) {
    return res.status(400).json({ error: "Invalid year or month." });
  }

  const now = new Date();
  if (
    inputYear > now.getFullYear() ||
    (inputYear === now.getFullYear() && inputMonth > now.getMonth() + 1)
  ) {
    return res
      .status(400)
      .json({ error: "Cannot generate payslip for a future period." });
  }

  const period = buildPeriod(inputYear, inputMonth);

  try {
    // 1. Resolve IDs
    let empIds;
    try {
      empIds = await resolveEmployeeIds(mode, {
        employeeId,
        employeeIds,
        fromId,
        toId,
      });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    // 2. Month description
    const [monthData] = await pool.query(
      `SELECT mthdesc FROM ac_months WHERE cmonth = ? LIMIT 1`,
      [inputMonth],
    );
    if (!monthData || monthData.length === 0) {
      return res
        .status(500)
        .json({ error: "Could not resolve month description." });
    }
    const monthdesc = monthData[0].mthdesc;

    // 3. Bulk classify — 1 query
    const classMap = await classifyEmployees(empIds);

    // 4. Bucket by payroll DB
    const dbGroups = new Map();
    const earlySkips = [];

    for (const empId of empIds) {
      const meta = classMap.get(empId);
      if (!meta) {
        earlySkips.push({
          empId,
          skipped: true,
          reason: "Employee not found or no active payroll class.",
        });
        continue;
      }
      if (!dbGroups.has(meta.targetDb)) {
        dbGroups.set(meta.targetDb, {
          payrollclass: meta.payrollclass,
          empIds: [],
        });
      }
      dbGroups.get(meta.targetDb).empIds.push(empId);
    }

    // 5. One SP call per class-group — all groups run in parallel
    const groupResultArrays = await Promise.all(
      [...dbGroups.entries()].map(
        ([targetDb, { payrollclass, empIds: gIds }]) =>
          processClassGroup(
            targetDb,
            payrollclass,
            gIds,
            period,
            inputYear,
            inputMonth,
            monthdesc,
          ),
      ),
    );

    // 6. Flatten and return
    const results = [...earlySkips, ...groupResultArrays.flat()];
    const successful = results.filter((r) => !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    return res.json({
      success: true,
      summary: { total: empIds.length, successful, skipped },
      results,
    });
  } catch (err) {
    console.error("❌ Admin payslip generate error:", err);
    return res
      .status(500)
      .json({ error: "An error occurred while generating payslips." });
  }
});

// ============================================================
// POST /admin/payslip/pdf
// ============================================================

router.post("/pdf", verifyToken, async (req, res) => {
  const { results, delivery = "merged", stamp = false } = req.body;

  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: "No results provided." });
  }

  const validEntries = results.filter((r) => r.data);
  if (validEntries.length === 0) {
    return res.status(400).json({ error: "No valid payslip data to render." });
  }

  const templatePath = path.join(
    __dirname,
    "../../../templates/user-payslip.html",
  );
  const logoPath = path.join(__dirname, "../../../public/photos/logo.png");

  let logoDataUrl = "";
  let stampDataUrl = "";

  if (fs.existsSync(logoPath)) {
    const buf = fs.readFileSync(logoPath);
    logoDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  }

  //Only load stamp from disk if stamp is requested
  if (stamp) {
    const stampPath = path.join(
      __dirname,
      "../../../public/photos/cpo-stamp.png",
    );
    if (fs.existsSync(stampPath)) {
      const buf = fs.readFileSync(stampPath);
      stampDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    }
  }

  const controller = getController();
  const firstEmp = validEntries[0]?.data || {};
  const periodMonth = firstEmp.payroll_month || "";
  const periodYear = String(firstEmp.payroll_year || "");
  const sharedGlobals = {
    payDate: new Date(),
    logoDataUrl,
    stampDataUrl,
    showStamp: !!stamp,
  };

  const pdfOptions = {
    format: "A5",
    landscape: false,
    timeout: 120000,
    helpers: `
      function formatCurrency(value) {
        if (!value && value !== 0) return '0.00';
        return parseFloat(value).toFixed(2).replace(/\\d(?=(\\d{3})+\\.)/g, '$&,');
      }
      function formatDate(date) {
        const d = new Date(date);
        const months = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
        return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
      }
      function ifCond(a, b, options) {
        return a === b ? options.fn(this) : options.inverse(this);
      }
    `,
  };

  try {
    if (delivery === "merged") {
      console.log(
        `📄 Generating merged PDF for ${validEntries.length} employees`,
      );

      // AFTER
      const mergedBuffer = await controller.generateBatchedPDF(
        templatePath,
        validEntries.map((e) => ({
          // ← stamp/showStamp injected into each employee
          ...e.data,
          stampDataUrl,
          showStamp: !!stamp,
        })),
        PDF_BATCH_SIZE,
        pdfOptions,
        sharedGlobals,
      );

      const mergedName = `Payslips ${periodMonth} ${periodYear}.pdf`.trim();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${mergedName}"`,
      );
      return res.send(mergedBuffer);
    }

    if (delivery === "zip") {
      const zipName = `Payslips ${firstEmp.payroll_month || periodMonth} ${firstEmp.payroll_year || periodYear}.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (err) => {
        throw err;
      });
      archive.pipe(res);

      for (const entry of validEntries) {
        const buf = await controller.generateBatchedPDF(
          templatePath,
          [{ ...entry.data, stampDataUrl, showStamp: !!stamp }],
          1,
          pdfOptions,
          sharedGlobals,
        );
        const d = entry.data || {};
        const parts = [
          (d.surname || "").trim().toUpperCase(),
          (d.othername || "").trim().toUpperCase(),
          d.payroll_month || periodMonth,
          String(d.payroll_year || periodYear),
          "Payslip",
        ].filter(Boolean);
        archive.append(buf, { name: parts.join(" ") + ".pdf" });
      }

      await archive.finalize();
      return;
    }

    return res
      .status(400)
      .json({ error: "delivery must be 'merged' or 'zip'." });
  } catch (err) {
    console.error("❌ Admin payslip PDF error:", err);
    return res.status(500).json({ error: "PDF generation failed." });
  }
});

// ============================================================
// GET /admin/payslip/search
// ============================================================

function looksLikeId(q) {
  return (
    /^[A-Z]{1,3}\d+$/i.test(q) ||
    /^\d+$/.test(q) ||
    /^[A-Z]{2}\/\d{4}$/i.test(q)
  );
}

router.get("/search", verifyToken, async (req, res) => {
  const { q, max } = req.query;

  if (!q || String(q).trim().length < 2) {
    return res
      .status(400)
      .json({ error: "Search query must be at least 2 characters." });
  }

  const term = String(q).trim();
  const limit = Math.min(parseInt(max) || 15, 30);

  const activePredicate = `(
    (DateLeft IS NULL OR DateLeft = '' OR DateLeft > DATE_FORMAT(CURDATE(), '%Y%m%d'))
    AND (exittype IS NULL OR exittype = '')
  )`;

  try {
    let rows;

    if (looksLikeId(term)) {
      const [r] = await pool.query(
        `SELECT EMPL_ID AS id, Title AS title, Surname AS surname, OtherName AS othername
         FROM hr_employees
         WHERE ${activePredicate} AND EMPL_ID LIKE ?
         ORDER BY EMPL_ID ASC LIMIT ?`,
        [term + "%", limit],
      );
      rows = r;
    } else {
      const startsWith = term + "%";
      const [r] = await pool.query(
        `(SELECT EMPL_ID AS id, Title AS title, Surname AS surname, OtherName AS othername
          FROM hr_employees
          WHERE ${activePredicate} AND Surname LIKE ?
          ORDER BY Surname ASC LIMIT ?)
         UNION
         (SELECT EMPL_ID AS id, Title AS title, Surname AS surname, OtherName AS othername
          FROM hr_employees
          WHERE ${activePredicate} AND OtherName LIKE ?
          ORDER BY OtherName ASC LIMIT ?)
         LIMIT ?`,
        [startsWith, limit, startsWith, limit, limit],
      );
      rows = r;
    }

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
