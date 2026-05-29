// ============================================================
// USER PAYSLIP CONTROLLER
// routes/user-dashboard/userPayslip.js
// Single-user payslip: validate → DB switch → SP → render/PDF
// ============================================================

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const pool = require("../../../config/db");
const verifyToken = require("../../../middware/authentication");
const BaseReportController = require("../../../controllers/Reports/reportsFallbackController");

// ── Payrollclass → DB name map ────────────────────────────
async function getPayrollClassDb(classcode) {
  const [[row]] = await pool.query(
    `SELECT db_name
     FROM py_payrollclass
     WHERE classcode = ? AND status = 'active'
     LIMIT 1`,
    [classcode],
  );

  return row ? row.db_name : null;
}

// Lazy singleton for PDF generation
let _controller = null;
function getController() {
  if (!_controller) _controller = new BaseReportController();
  return _controller;
}

// ============================================================
// HELPERS
// ============================================================

function zeroPad(n) {
  return String(n).padStart(2, "0");
}

function buildPeriod(year, month) {
  return `${year}${zeroPad(month)}`;
}

/**
 * Map flat py_webpayslip rows for a single employee into structured object.
 * Mirrors _mapConsolidatedPayslipData but for one employee only.
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

  rows.forEach((row) => {
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
  });

  // Calculate nets
  emp.ippis.net =
    emp.ippis.taxable_total +
    emp.ippis.nontaxable_total -
    emp.ippis.deductions_total;
  emp.navy.net =
    emp.navy.taxable_total +
    emp.navy.nontaxable_total -
    emp.navy.deductions_total;
  emp.net_pay = emp.ippis.net + emp.navy.net;

  // Null out empty sections
  const isEmpty = (s) =>
    s.taxable.length === 0 &&
    s.nontaxable.length === 0 &&
    s.deductions.length === 0;
  if (isEmpty(emp.ippis)) emp.ippis = null;
  if (isEmpty(emp.navy)) emp.navy = null;

  return emp;
}

// ============================================================
// POST /payslip/generate
// Body: { year: "2025", month: "3" }
// ============================================================
router.post("/generate", verifyToken, async (req, res) => {
  const userId = req.user_id;
  const { year, month } = req.body;

  // ── 1. Basic input validation ──────────────────────────
  const inputYear = parseInt(year);
  const inputMonth = parseInt(month);

  if (!inputYear || !inputMonth || inputMonth < 1 || inputMonth > 12) {
    return res.status(400).json({ error: "Invalid year or month." });
  }

  // ── 2. Block future periods ────────────────────────────
  const now = new Date();
  if (
    inputYear > now.getFullYear() ||
    (inputYear === now.getFullYear() && inputMonth > now.getMonth() + 1)
  ) {
    return res.status(400).json({
      error: "Cannot generate payslip for a future period.",
    });
  }

  const period = buildPeriod(inputYear, inputMonth);

  // ── Fetch payrollclass from master DB (pool is still on hicaddata here) ──
  let payrollclass, targetDb;
  try {
    // ── 3. Fetch employee payrollclass from master DB ──
    // hr_employees lives in hicaddata (officers / master DB)
    const [empRows] = await pool.query(
      `SELECT payrollclass FROM hr_employees WHERE EMPL_ID = ? LIMIT 1`,
      [userId],
    );

    if (!empRows || empRows.length === 0) {
      return res.status(404).json({
        error: "No employee record found for your service number.",
      });
    }

    payrollclass = String(empRows[0].payrollclass);
    targetDb = await getPayrollClassDb(payrollclass);

    if (!targetDb) {
      return res.status(400).json({
        error: `Unsupported payroll class: ${payrollclass}.`,
      });
    }
  } catch (err) {
    console.error("❌ Payslip lookup error:", err);
    return res
      .status(500)
      .json({ error: "An error occurred while generating your payslip." });
  }

  // ── 4. All payroll DB work on a dedicated connection ──────────
  const conn = await pool.getConnection();
  let switchedDb = false;

  try {
    await conn.query(`USE \`${targetDb}\``);
    switchedDb = true;

    // ── 5. Fetch BT05 (current processing period) ──────
    const [[bt05]] = await pool.query(
      `SELECT ord, mth FROM py_stdrate WHERE type = 'BT05' LIMIT 1`,
    );

    if (!bt05) {
      return res
        .status(500)
        .json({ error: "Could not determine current processing period." });
    }

    const currentYear = parseInt(bt05.ord);
    const currentMonth = parseInt(bt05.mth);
    const isCurrentPeriod =
      inputYear === currentYear && inputMonth === currentMonth;

    // ── 6. IPPIS check — always required for any period ──
    // If no IPPIS rows exist for this employee + period, payslip is not ready.
    // For current period this means upload hasn't happened yet.
    // For historical periods it means IPPIS was never uploaded for that month.
    const [[ippisCheck]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM py_ipis_payhistory
       WHERE numb = ? AND period = ?`,
      [userId, period],
    );

    if (!ippisCheck || ippisCheck.cnt === 0) {
      // For historical periods that had no IPPIS (e.g. NAVY-only months),
      // allow through — block only if it's the current processing period
      if (isCurrentPeriod) {
        return res.status(202).json({
          notReady: true,
          error:
            "Sorry, payslip for selected month and year is not ready yet. Please check again later.",
        });
      }
      // Historical with no IPPIS is fine — SP will just produce NAVY rows
    }

    // ── 7. Call stored procedure ───────────────────────
    await pool.query(`CALL py_generate_combined_payslip(?, ?, ?, ?, ?, ?)`, [
      userId,
      userId,
      period,
      payrollclass,
      userId,
      "1",
    ]);

    // ── 8. Fetch generated rows ────────────────────────
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

    // ── Fetch generated rows ──────────────────────────────────
    const [rawRows] = await conn.query(
      `SELECT * FROM py_webpayslip
       WHERE work_station = ? AND ord = ? AND desc1 = ?
       ORDER BY source DESC, bpc, bp`,
      [userId, String(inputYear), monthdesc],
    );

    if (!rawRows || rawRows.length === 0) {
      return res.status(404).json({
        error:
          "Sorry, no payslip information found for the selected year and month.",
      });
    }

    // ── 9. Map and return ──────────────────────────────
    const mapped = mapPayslipRows(rawRows);
    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("❌ Payslip generate error:", err);
    return res
      .status(500)
      .json({ error: "An error occurred while generating your payslip." });
  } finally {
    // ── Safe connection return — same pattern as adminPayslip ──
    if (switchedDb) {
      try {
        await conn.query(`USE \`hicaddata\``);
        conn.release();
      } catch (_) {
        console.warn("⚠️ Failed to reset DB context — destroying connection.");
        conn.destroy();
      }
    } else {
      conn.release();
    }
  }
});

// ============================================================
// POST /payslip/pdf
// Body: { data: <mapped employee object>, stamp: true/false }
// ============================================================
router.post("/pdf", verifyToken, async (req, res) => {
  const { data, stamp } = req.body;

  if (!data) {
    return res.status(400).json({ error: "No payslip data provided." });
  }

  try {
    const templatePath = path.join(
      __dirname,
      "../../../templates/user-payslip.html",
    );

    // Load logo as base64
    const logoPath = path.join(__dirname, "../../../public/photos/logo.png");
    let logoDataUrl = "";
    if (fs.existsSync(logoPath)) {
      const buf = fs.readFileSync(logoPath);
      logoDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    }

    // Only load stamp when requested
    let stampDataUrl = "";
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

    const pdfBuffer = await controller.generateBatchedPDF(
      templatePath,
      [{ ...data, stampDataUrl, showStamp: !!stamp }], // single employee array — template iterates {{#each employees}}
      1,
      {
        format: "A5",
        landscape: false,
        timeout: 60000,
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
      },
      {
        payDate: new Date(),
        logoDataUrl,
        stampDataUrl,
        showStamp: !!stamp,
      },
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=payslip.pdf");
    return res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ Payslip PDF error:", err);
    return res.status(500).json({ error: "PDF generation failed." });
  }
});

module.exports = router;
