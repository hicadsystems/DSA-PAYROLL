// ============================================================
// USER PAYSLIP (self-service)
// routes/user-dashboard/payslips/userpayslip.js
//
// Same layout and figures as the payroll payslip report — see
// payslip.engine.js. The PDF is rebuilt server-side from year/month;
// payslip figures are never accepted from the browser.
// ============================================================

"use strict";

const express = require("express");
const router = express.Router();
const verifyToken = require("../../../middware/authentication");
const engine = require("./payslip.engine");

// Shared by /generate and /pdf: the signed-in person's own payslip.
async function buildOwnPayslip(userId, body) {
  const { year, month } = engine.parsePeriod(body?.year, body?.month);

  const cls = (await engine.classifyEmployees([userId])).get(String(userId));
  if (!cls) {
    throw {
      status: 404,
      message: "No active payroll record was found for your User ID.",
    };
  }

  const out = await engine.generateForClass({
    targetDb: cls.targetDb,
    payrollclass: cls.payrollclass,
    empIds: [String(userId)],
    year,
    month,
    station: engine.stationKey("SS", userId),
  });

  if (!out.ok) {
    throw { status: out.notReady ? 202 : 404, notReady: out.notReady, message: out.message };
  }

  const emp = out.data.find((e) => String(e.employee_id) === String(userId)) || out.data[0];
  if (!emp) {
    throw {
      status: 404,
      message: `No payslip information found for ${engine.monthName(month)} ${year}.`,
    };
  }
  return { emp, year, month };
}

function sendError(res, err, label) {
  if (err && err.status) {
    return res
      .status(err.status)
      .json({ success: false, notReady: !!err.notReady, error: err.message });
  }
  console.error(`❌ ${label}:`, err);
  return res
    .status(500)
    .json({ success: false, error: "An error occurred while generating your payslip." });
}

// ============================================================
// POST /payslip/generate   Body: { year, month }
// ============================================================
router.post("/generate", verifyToken, async (req, res) => {
  try {
    const { emp } = await buildOwnPayslip(req.user_id, req.body);
    return res.json({ success: true, data: emp });
  } catch (err) {
    return sendError(res, err, "Payslip generate error");
  }
});

// ============================================================
// POST /payslip/pdf   Body: { year, month }
//
// Rendered on the app's one shared Chromium at high priority
// (lib/pdfGate.js). When too many people are waiting the answer is
// 503 + Retry-After, and the payslip page retries by itself.
// ============================================================
router.post("/pdf", verifyToken, async (req, res) => {
  try {
    const { emp, year, month } = await buildOwnPayslip(req.user_id, req.body);
    const pdf = await engine.renderPdf([emp], { priority: "high" });
    const name = engine.payslipFileName(emp, engine.monthName(month), year);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(Buffer.from(pdf));
  } catch (err) {
    if (err && err.code === "PDF_BUSY") {
      res.setHeader("Retry-After", String(err.retryAfter));
      return res
        .status(503)
        .json({ busy: true, retryAfter: err.retryAfter, error: err.message });
    }
    return sendError(res, err, "Payslip PDF error");
  }
});

// GET /payslip/pdf/status — how busy PDF generation is (for monitoring)
router.get("/pdf/status", verifyToken, (req, res) => {
  return res.json(require("../../../lib/pdfGate").stats());
});

module.exports = router;
