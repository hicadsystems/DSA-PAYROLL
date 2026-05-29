const BaseReportController = require("../Reports/reportsFallbackController");
const reconciliationService = require("../../services/Reports/reconciliationService");
const companySettings = require("../helpers/companySettings");
const fs = require("fs");
const path = require("path");
const pool = require("../../config/db");

class ReconciliationController extends BaseReportController {
  constructor() {
    super();
  }

  // ─── shared error handler ──────────────────────────────────────────────────
  _handleError(res, error, fallbackMessage) {
    console.error(fallbackMessage, error);
    if (res.headersSent) return;

    if (error.message?.includes("Calculation not completed")) {
      return res
        .status(400)
        .json({
          success: false,
          error: error.message,
          errorType: "CALCULATION_INCOMPLETE",
        });
    }
    if (error.message?.includes("No payroll data found")) {
      return res
        .status(404)
        .json({ success: false, error: error.message, errorType: "NO_DATA" });
    }
    if (error.message?.includes("No salary variance detected")) {
      return res
        .status(400)
        .json({ success: false, error: error.message, errorType: "BALANCED" });
    }
    return res
      .status(500)
      .json({ success: false, error: fallbackMessage, details: error.message });
  }

  /**
   * GET /api/reconciliation/summary
   */
  async getSummary(req, res) {
    try {
      const { year, month } = req.query;
      const database = req.current_class;

      const summary =
        await reconciliationService.getSalaryReconciliationSummary({
          year,
          month,
          database,
        });
      res.json({ success: true, data: summary });
    } catch (error) {
      this._handleError(res, error, "Failed to get reconciliation summary");
    }
  }

  /**
   * GET /api/reconciliation/employees
   *
   * FIX: Run the summary check FIRST.  If variance is 0.00 return immediately
   * with an empty array — no employee loop, no 87-second wait.
   */
  async getEmployeeReconciliation(req, res) {
    try {
      const { year, month, showErrorsOnly } = req.query;
      const database = req.current_class;
      const filters = {
        year,
        month,
        database,
        showErrorsOnly: showErrorsOnly !== "false",
      };

      // ── Variance pre-check ─────────────────────────────────────────────────
      // getSalaryReconciliationSummary also validates that calculation is complete,
      // so we get that guard for free here too.
      const summary =
        await reconciliationService.getSalaryReconciliationSummary(filters);
      const summaryData = summary[0] || null;

      if (!summaryData) {
        return res.json({
          success: true,
          count: 0,
          data: [],
          status: "NO_DATA",
        });
      }

      if (!summaryData.has_variance) {
        const monthName = reconciliationService.getMonthName(summaryData.month);
        console.log(
          `✅ No variance for ${monthName} ${summaryData.year} — skipping employee loop`,
        );
        return res.json({
          success: true,
          count: 0,
          data: [],
          status: "BALANCED",
          summary: summaryData,
        });
      }
      // ── Variance detected — run the loop ──────────────────────────────────
      console.log(`⚠️  Variance detected — running employee reconciliation...`);
      const result =
        await reconciliationService.getEmployeeReconciliation(filters);

      res.json({ success: true, count: result.length, data: result });
    } catch (error) {
      this._handleError(res, error, "Failed to get employee reconciliation");
    }
  }

  /**
   * GET /api/reconciliation/report
   */
  async getReport(req, res) {
    try {
      const { year, month } = req.query;
      const database = req.current_class;

      const report = await reconciliationService.getReconciliationReport({
        year,
        month,
        database,
      });
      res.json({ success: true, data: report });
    } catch (error) {
      this._handleError(res, error, "Failed to generate reconciliation report");
    }
  }

  /**
   * GET /api/reconciliation/quick-check
   * Lightweight status check — never triggers the employee loop.
   */
  async quickCheck(req, res) {
    try {
      const { year, month } = req.query;
      const database = req.current_class;

      const result = await reconciliationService.quickReconciliationCheck({
        year,
        month,
        database,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      this._handleError(res, error, "Failed to run quick reconciliation check");
    }
  }

  /**
   * GET /api/reconciliation/payment-type-analysis
   */
  async getPaymentTypeAnalysis(req, res) {
    try {
      const { year, month } = req.query;
      const database = req.current_class;

      const analysis = await reconciliationService.getPaymentTypeErrorAnalysis({
        year,
        month,
        database,
      });
      res.json({ success: true, data: analysis });
    } catch (error) {
      this._handleError(res, error, "Failed to get payment type analysis");
    }
  }

  /**
   * GET /api/reconciliation/export
   * Export reconciliation report as PDF.
   * Also guarded — will not generate a PDF if payroll is balanced.
   */
  async exportReconciliationPDF(req, res) {
    try {
      const { year, month, showErrorsOnly } = req.query;
      const database = req.current_class;
      const errorsOnly = showErrorsOnly === "false" ? false : true;

      if (!year || !month) {
        return res
          .status(400)
          .json({ success: false, error: "Year and month are required" });
      }

      console.log(
        `📄 Export: year=${year}, month=${month}, errorsOnly=${errorsOnly}, db=${database}`,
      );

      const filters = { year, month, database, showErrorsOnly: false };
      const result =
        await reconciliationService.getReconciliationReport(filters);

      if (result.status === "BALANCED") {
        throw new Error(
          `No salary variance detected for ${reconciliationService.getMonthName(result.summary.month)}, ${result.summary.year}.`,
        );
      }

      await this.generateSalaryReconciliationPDF(req, res, result, {
        ...filters,
        showErrorsOnly: errorsOnly,
      });
    } catch (error) {
      this._handleError(res, error, "Failed to export reconciliation PDF");
    }
  }

  // ─── PDF generation helper ─────────────────────────────────────────────────
  async generateSalaryReconciliationPDF(req, res, result, filters) {
    try {
      const showErrorsOnly = filters.showErrorsOnly !== false;
      const data = showErrorsOnly
        ? result.details || []
        : result.all_details || [];

      if (!data.length) {
        throw new Error("No data available for PDF generation");
      }

      console.log(
        `📄 PDF: ${showErrorsOnly ? "errors only" : "all employees"}, rows=${data.length}`,
      );

      const grandTotals = {
        total_employees: data.length,
        employees_with_errors:
          result.employees_with_errors ??
          data.filter((d) => d.status === "ERROR").length,
        total_error_amount:
          result.total_error_amount ??
          data.reduce((s, d) => s + Math.abs(d.error_amount || 0), 0),
        total_earnings: data.reduce((s, d) => s + (d.total_earnings || 0), 0),
        total_allowances: data.reduce(
          (s, d) => s + (d.total_allowances || 0),
          0,
        ),
        total_deductions: data.reduce(
          (s, d) => s + (d.total_deductions || 0),
          0,
        ),
        total_gross_cum: data.reduce((s, d) => s + (d.gross_from_cum || 0), 0),
        total_net_cum: data.reduce((s, d) => s + (d.net_from_cum || 0), 0),
        total_tax_cum: data.reduce((s, d) => s + (d.tax_from_cum || 0), 0),
        total_roundup: data.reduce((s, d) => s + (d.roundup || 0), 0),
      };

      const templatePath = path.join(
        __dirname,
        "../../templates/salary-reconciliation.html",
      );
      const image = await companySettings.getSettingsFromFile(
        "./public/photos/logo.png",
      );

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      const monthStr = filters.month?.toString() ?? "";
      const monthNum =
        monthStr.length === 6
          ? parseInt(monthStr.substring(4, 6))
          : parseInt(monthStr);
      const period =
        filters.month && filters.year
          ? `${monthNames[monthNum - 1] ?? filters.month}, ${filters.year}`
          : "N/A";

      const pdfBuffer = await this.generatePDFWithFallback(
        templatePath,
        {
          data,
          grandTotals,
          reportDate: new Date(),
          period,
          year: filters.year,
          month: filters.month,
          className: await this.getDatabaseNameFromRequest(req),
          showErrorsOnly,
          ...image,
        },
        {
          format: "A4",
          landscape: true,
          marginTop: "5mm",
          marginBottom: "5mm",
          marginLeft: "5mm",
          marginRight: "5mm",
        },
      );

      const suffix = showErrorsOnly ? "errors_only" : "all_employees";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=salary_reconciliation_${suffix}_${filters.month}_${filters.year}.pdf`,
      );
      res.send(pdfBuffer);

      console.log("✅ PDF sent");
    } catch (error) {
      console.error("❌ PDF generation error:", error);
      throw error;
    }
  }

  async getDatabaseNameFromRequest(req) {
    const currentDb = req.current_class;
    if (!currentDb) return "OFFICERS";
    const [classInfo] = await pool.query(
      "SELECT classname FROM py_payrollclass WHERE db_name = ?",
      [currentDb],
    );
    return classInfo.length > 0 ? classInfo[0].classname : currentDb;
  }
}

module.exports = new ReconciliationController();