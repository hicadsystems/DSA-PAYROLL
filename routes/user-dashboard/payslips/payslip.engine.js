// ============================================================
// SELF-SERVICE PAYSLIP ENGINE
// routes/user-dashboard/payslips/payslip.engine.js
//
// Builds payslips for the user dashboard with exactly the same pipeline
// as the payroll payslip report (sections/pay-slips.html):
//   payslipGenerationService  → py_tempslipnlpc rows
//   reportsController._mapPayslipData → earnings / deductions / net
//   templates/payslip-template.html   → PDF
//
// Differences from the report route, on purpose:
//   • Each call runs in its own DB session context (never the shared
//     "default" bucket) and switches to the employee's payroll DB.
//   • Historical months are transformed per call with a private copy of the
//     historical wrapper instead of activating the global one, so personnel
//     requests can't flip an admin's in-flight report (or each other's).
// ============================================================

"use strict";

const path = require("path");
const crypto = require("crypto");
const pool = require("../../../config/db");
const config = require("../../../config");
const seamlessWrapper = require("../../../services/helpers/historicalReportWrapper");
const periodValidator = require("../../../services/helpers/periodValidatorService");
const payslipGenService = require("../../../services/Reports/payslipGenerationService");
const reportsController = require("../../../controllers/Reports/reportsControllers");
const companySettings = require("../../../controllers/helpers/companySettings");

const MASTER_DB = () => process.env.DB_OFFICERS || config.databases.officers;
const TEMPLATE = path.join(__dirname, "../../../templates/payslip-template.html");
const PDF_BATCH_SIZE = 50;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// pool.query without the global historical interceptor.
function rawQuery(sql, params) {
  const q = seamlessWrapper.originalQuery || pool.query.bind(pool);
  return q(sql, params);
}

// Run fn with its own session-context DB, cleaned up afterwards.
async function runIsolated(dbName, fn) {
  const ctx = pool._getSessionContext ? pool._getSessionContext() : null;
  const key = `payslip:${crypto.randomUUID()}`;
  const run = async () => {
    try {
      pool.useDatabase(dbName, key);
      return await fn();
    } finally {
      try {
        pool.clearSession(key);
      } catch (_) {
        /* ignore */
      }
    }
  };
  return ctx ? ctx.run(key, run) : run();
}

// Unique py_tempslipnlpc.work_station per request (no cross-request collisions).
function stationKey(prefix, userId) {
  return `${prefix}-${String(userId).slice(0, 20)}-${crypto.randomBytes(3).toString("hex")}`;
}

function monthName(m) {
  return MONTHS[parseInt(m, 10) - 1] || String(m);
}

/**
 * Validate year/month input. Returns { year, month } or throws {status,message}.
 */
function parsePeriod(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!y || !m || m < 1 || m > 12) {
    throw { status: 400, message: "Invalid year or month." };
  }
  return { year: y, month: m };
}

/**
 * Employee → payroll class + payroll DB, from the master DB.
 * @returns {Promise<Map<string, {payrollclass, targetDb, classname}>>}
 */
async function classifyEmployees(empIds) {
  const ids = [...new Set((empIds || []).map(String))];
  if (!ids.length) return new Map();
  return runIsolated(MASTER_DB(), async () => {
    const [rows] = await rawQuery(
      `SELECT e.Empl_ID, e.payrollclass, p.db_name AS targetDb, p.classname
         FROM hr_employees e
         JOIN py_payrollclass p
           ON p.classcode = e.payrollclass
          AND p.status    = 'active'
        WHERE e.Empl_ID IN (?)`,
      [ids],
    );
    const map = new Map();
    for (const r of rows) {
      map.set(String(r.Empl_ID), {
        payrollclass: String(r.payrollclass),
        targetDb: r.targetDb,
        classname: r.classname,
      });
    }
    return map;
  });
}

/**
 * Generate mapped payslips for employees of ONE payroll class.
 *
 * @returns {Promise<{ok:true, data:Array} | {ok:false, notReady:boolean, message:string}>}
 */
async function generateForClass({ targetDb, payrollclass, empIds, year, month, station }) {
  return runIsolated(targetDb, async () => {
    // Same period rules as the payroll report (future / not calculated /
    // no history), via the same validator.
    const v = await periodValidator.validateAndGetDataSource(year, month, targetDb);
    if (!v.isValid) {
      const calcPending =
        v.dataSource === "current" && /calculation not completed/i.test(v.errorMessage || "");
      return {
        ok: false,
        notReady: calcPending,
        message: calcPending
          ? `Payslip for ${monthName(month)} ${year} is not ready yet. Please check again later.`
          : v.errorMessage || "Payslip could not be generated.",
      };
    }

    let tx = null;
    if (v.dataSource !== "current") {
      // Private copy of the wrapper's transformer — same SQL rewriting the
      // report uses for history, without touching the shared instance.
      tx = Object.create(seamlessWrapper);
      tx.currentYear = year;
      tx.currentMonth = month;
    }
    const q = (sql, params) => rawQuery(tx ? tx.transformQuery(sql) : sql, params);
    const svc = payslipGenService.withQuery(q);

    try {
      const gen = await svc.generatePayslips({
        empIds,
        branch: payrollclass,
        station,
        year,
        month,
      });
      if (!gen.success) {
        const calcPending = /calculation not completed/i.test(gen.message || "");
        return {
          ok: false,
          notReady: calcPending,
          message: calcPending
            ? `Payslip for ${monthName(month)} ${year} is not ready yet. Please check again later.`
            : gen.message || "No payslip found.",
        };
      }
      const raw = await svc.getPayslipsGroupedByEmployee(station);
      return { ok: true, data: reportsController._mapPayslipData(raw) };
    } finally {
      await rawQuery(`DELETE FROM py_tempslipnlpc WHERE work_station = ?`, [station]).catch(
        (e) => console.warn("⚠️ payslip temp cleanup failed:", e.message),
      );
    }
  });
}

/**
 * Render mapped payslips with the payroll payslip template (A5).
 * Goes through the app-wide PDF gate (lib/pdfGate.js):
 *   priority "high" — personnel's own payslip (may be refused with PDF_BUSY)
 *   priority "low"  — admin batches (wait their turn, never refused)
 */
async function renderPdf(employees, { priority = "low" } = {}) {
  const image = await companySettings.getSettingsFromFile("./public/photos/logo.png");
  return reportsController.generateBatchedPDF(
    TEMPLATE,
    employees,
    PDF_BATCH_SIZE,
    {
      format: "A5",
      landscape: false,
      timeout: 120000,
      priority,
      options: { timeout: 120000, reportTimeout: 120000 },
    },
    { payDate: new Date(), ...image },
  );
}

function payslipFileName(emp, fallbackMonth, fallbackYear) {
  const parts = [
    (emp?.surname || "").trim().toUpperCase(),
    (emp?.othername || "").trim().toUpperCase(),
    emp?.payroll_month || fallbackMonth || "",
    String(emp?.payroll_year || fallbackYear || ""),
    "Payslip",
  ].filter(Boolean);
  return parts.join(" ").replace(/[\\/:*?"<>|]/g, "-") + ".pdf";
}

module.exports = {
  MASTER_DB,
  monthName,
  parsePeriod,
  stationKey,
  classifyEmployees,
  generateForClass,
  renderPdf,
  payslipFileName,
};
