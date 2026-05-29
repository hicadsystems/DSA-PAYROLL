// ============================================================================
// FILE: controllers/Reports/payrollRegisterController.js
// Follows same pattern as SalaryHistoryController
// Data logic lives in payrollRegisterService — this handles HTTP only
// ============================================================================
const BaseReportController = require("./reportsFallbackController");
const payrollRegisterSvc = require("../../services/Reports/payrollRegisterService");
const { GenericExcelExporter } = require("../helpers/excel");
const pool = require("../../config/db");
const fs = require("fs");
const path = require("path");

class PayrollRegisterController extends BaseReportController {
  constructor() {
    super();
    this._registerPayrollRegisterHelpers();
  }

  // Register custom Handlebars helpers needed by payroll-register.html template
  // into Handlebars so the Chromium fallback path can compile them
  _registerPayrollRegisterHelpers() {
    const Handlebars = require("handlebars");

    Handlebars.registerHelper("periodLabel", function (p) {
      if (!p || p.length < 6) return p || "";
      const M = [
        "",
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      return (
        (M[parseInt(p.substring(4, 6))] || "???") + " " + p.substring(0, 4)
      );
    });

    // Lookup an employee's amount for a given his_type column
    Handlebars.registerHelper("amtFor", function (entries, hisType) {
      const entry = (entries || []).find((e) => e.his_type === hisType);
      if (!entry || !entry.amount) return "";
      const v = parseFloat(entry.amount);
      return v === 0
        ? ""
        : v.toLocaleString("en-NG", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
    });

    Handlebars.registerHelper("fmtCurrency", function (v) {
      const n = parseFloat(v) || 0;
      return n === 0
        ? ""
        : n.toLocaleString("en-NG", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
    });

    Handlebars.registerHelper("formatDate", function (date) {
      const d = new Date(date);
      const M = [
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
      return `${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()}`;
    });

    Handlebars.registerHelper("formatTime", function (date) {
      return new Date(date).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    });

    Handlebars.registerHelper("colTotal", function (employees, hisType, area) {
      // area = 'earnings' | 'deductions'
      return (employees || []).reduce((sum, emp) => {
        const list = area === "deductions" ? emp.deductions : emp.earnings;
        const entry = (list || []).find((e) => e.his_type === hisType);
        return sum + (parseFloat(entry && entry.amount) || 0);
      }, 0);
    });

    Handlebars.registerHelper("eq", function (a, b) {
      return a === b;
    });
    Handlebars.registerHelper("add", function (a, b) {
      return (parseFloat(a) || 0) + (parseFloat(b) || 0);
    });
  }

  // ==========================================================================
  // GENERATE — POST /payroll-register/generate
  // ==========================================================================
  async generatePayrollRegister(req, res) {
    const { empnoFrom, empnoTo, period, printRange, useIppis } = req.body;

    const username = req.user_fullname || req.user_id;
    const payrollClass = await this.getDatabaseCodeFromRequest(req);

    if (!username) {
      return res.status(401).json({
        success: false,
        error: "User authentication required. Please log in again.",
      });
    }
    if (!period || !payrollClass) {
      return res.status(400).json({
        success: false,
        error: "Period and payroll class are required.",
      });
    }

    const yr = parseInt(period.substring(0, 4));
    const mo = parseInt(period.substring(4, 6));

    if (isNaN(yr) || isNaN(mo) || mo < 1 || mo > 12) {
      return res.status(400).json({
        success: false,
        error: "Invalid period format. Expected YYYYMM (e.g., 202501).",
      });
    }

    console.log("=== PAYROLL REGISTER PARAMETERS ===");
    console.log("empnoFrom:   ", empnoFrom);
    console.log("empnoTo:     ", empnoTo);
    console.log("period:      ", period);
    console.log("payrollClass:", payrollClass);
    console.log("username:    ", username);
    console.log("printRange:  ", printRange);
    console.log("useIppis:    ", useIppis);
    console.log("===================================");

    try {
      const { summary, colRows, rawRows } =
        await payrollRegisterSvc.generatePayrollRegister({
          empnoFrom,
          empnoTo,
          period,
          payrollClass,
          username,
          printRange: printRange === '1' || printRange === true,
          useIppis: useIppis || "N",
        });

      console.log("Payroll register SP summary:", summary);
      console.log("Column rows fetched:", colRows.length);
      console.log("Raw data rows fetched:", rawRows.length);

      if (!rawRows || rawRows.length === 0) {
        return res.json({
          success: false,
          error: "No payroll register data found for the selected criteria.",
        });
      }

      const className = await this.getDatabaseNameFromRequest(req);
      const mappedData = payrollRegisterSvc.mapData(
        rawRows,
        colRows,
        period,
        useIppis === "Y",
        className,
      );

      console.log("Mapped employees:", mappedData.employees.length);

      return res.json({
        success: true,
        message: `Payroll register generated for ${mappedData.employees.length} employee(s)`,
        data: mappedData,
        summary: {
          totalEmployees: summary.total_employees,
          totalRecords: summary.total_records,
          period: summary.period,
        },
      });
    } catch (error) {
      console.error("Payroll register generate error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // EXPORT PDF — POST /payroll-register/export/pdf
  // Direct single-step PDF — no JSON round-trip
  // ==========================================================================
  async generatePayrollRegisterPDF(req, res) {
    const { empnoFrom, empnoTo, period, printRange, useIppis } = req.body;

    const username = req.user_fullname || req.user_id;
    const payrollClass = await this.getDatabaseCodeFromRequest(req);

    if (!username) {
      return res.status(401).json({
        success: false,
        error: "User authentication required. Please log in again.",
      });
    }
    if (!period || !payrollClass) {
      return res.status(400).json({
        success: false,
        error: "Period and payroll class are required.",
      });
    }

    try {
      // ── 1. Fetch data directly (no pre-generated JSON needed) ──────────────
      const { summary, colRows, rawRows } =
        await payrollRegisterSvc.generatePayrollRegister({
          empnoFrom,
          empnoTo,
          period,
          payrollClass,
          username,
          printRange: printRange === '1' || printRange === true,
          useIppis: useIppis || "N",
        });

      if (!rawRows || rawRows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No payroll register data found for the selected criteria.",
        });
      }

      const className = await this.getDatabaseNameFromRequest(req);
      const mappedData = payrollRegisterSvc.mapData(
        rawRows,
        colRows,
        period,
        useIppis === "Y",
        className,
      );

      if (mappedData.employees.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No payroll register data to render.",
        });
      }

      // ── 2. Logo ─────────────────────────────────────────────────────────────
      const logoPath = "./public/photos/logo.png";
      let logoDataUrl = "";
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        logoDataUrl = `data:image/png;base64,${logoBuffer.toString("base64")}`;
      }

      const templatePath = path.join(
        __dirname,
        "../../templates/payroll-register.html",
      );

      console.log(
        `📄 Generating payroll register PDF for ${mappedData.employees.length} employee(s)`,
      );

      // ── 3. Render directly to PDF ────────────────────────────────────────────
      const pdfBuffer = await this.generateBatchedPDF(
        templatePath,
        mappedData.employees,
        100,
        {
          format: "A4",
          landscape: true,
          timeout: 120000,
          helpers: this._getCommonHelpers() + this._getPayrollRegisterHelpers(),
          options: { timeout: 120000, reportTimeout: 120000 },
        },
        {
          reportDate: new Date(),
          logoDataUrl: logoDataUrl,
          className: className,
          period: period,
          columns: mappedData.columns, // earningCols + deductionCols passed to template
          summary: summary,
          useIppis: useIppis === "Y",
        },
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=payroll_register.pdf",
      );
      res.send(pdfBuffer);
    } catch (error) {
      console.error("Payroll register PDF error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // EXPORT EXCEL — POST /payroll-register/export/excel
  // Uses GenericExcelExporter design style.
  // Identity columns (S/N → Svc No.) are frozen; dynamic pay columns follow.
  // Description headers get word-wrap + 20-char width.
  // ==========================================================================
  async generatePayrollRegisterExcel(req, res) {
    const {
      empnoFrom,
      empnoTo,
      period,
      printRange,
      useIppis,
      useCodeHeader,
      reportType,
    } = req.body;

    const username = req.user_fullname || req.user_id;
    const payrollClass = await this.getDatabaseCodeFromRequest(req);

    if (!username) {
      return res
        .status(401)
        .json({
          success: false,
          error: "User authentication required. Please log in again.",
        });
    }
    if (!period || !payrollClass) {
      return res
        .status(400)
        .json({
          success: false,
          error: "Period and payroll class are required.",
        });
    }

    try {
      // ── 1. Fetch data ──────────────────────────────────────────────────────
      const { colRows, rawRows } =
        await payrollRegisterSvc.generatePayrollRegister({
          empnoFrom,
          empnoTo,
          period,
          payrollClass,
          username,
          printRange: printRange === '1' || printRange === true,
          useIppis: useIppis || "N",
          reportType,
        });

      if (!rawRows || rawRows.length === 0) {
        return res
          .status(404)
          .json({
            success: false,
            error: "No payroll register data found for the selected criteria.",
          });
      }

      const className = await this.getDatabaseNameFromRequest(req);
      const mappedData = payrollRegisterSvc.mapData(
        rawRows,
        colRows,
        period,
        useIppis === "Y",
        className,
      );
      const { employees } = mappedData;

      if (employees.length === 0) {
        return res
          .status(404)
          .json({
            success: false,
            error: "No payroll register data to export.",
          });
      }

      // ── 2. Resolve headers ─────────────────────────────────────────────────
      const useCode = useCodeHeader === "true" || useCodeHeader === true;
      const isIppis = useIppis === "Y";
      const headersAreDesc = !useCode;
      const mode = (reportType || "both").toLowerCase();

      const { earningHeaders, deductionHeaders } =
        payrollRegisterSvc.buildColumnHeaders(
          colRows,
          useCode,
          rawRows,
          reportType,
        );

      // ── 3. Color tokens (muted) ────────────────────────────────────────────
      const GREEN = "F3FBF4"; // muted green  — IPPIS earnings
      const RED = "FEF5F5"; // muted red    — IPPIS deductions
      const YELLOW = "FFFEF2"; // muted yellow — IPPIS total
      const BLUE = "F5F9FF"; // muted blue   — NAVY total

      const dynW = headersAreDesc ? 17 : 14;
      const EARN_FMT = "₦#,##0.00";
      const DED_FMT = "₦#,##0.00;(₦#,##0.00)";

      // ── 4. Build columns ───────────────────────────────────────────────────
      const columns = [
        { header: "S/N", key: "sn", width: 6, align: "center" },
        { header: "Svc No.", key: "serviceno", width: 14, align: "center" },
        { header: "Rank", key: "title", width: 10, align: "left" },
        { header: "Full Name", key: "fullname", width: 28, align: "left" },

        ...(isIppis
          ? [
              // ── IPPIS mode ─────────────────────────────────────────────────────
              ...(mode !== "deductions"
                ? [
                    // IPPIS Earnings
                    ...earningHeaders
                      .filter((c) => c.source === "IPPIS")
                      .map((c) => ({
                        header: c.label,
                        key: `e_${c.his_type}`,
                        width: dynW,
                        align: "right",
                        numFmt: EARN_FMT,
                        wrapText: headersAreDesc,
                        bgColor: GREEN,
                      })),
                    // IPPIS Deductions
                    ...deductionHeaders
                      .filter((c) => c.source === "IPPIS")
                      .map((c) => ({
                        header: c.label,
                        key: `d_${c.his_type}`,
                        width: dynW,
                        align: "right",
                        numFmt: DED_FMT,
                        wrapText: headersAreDesc,
                        bgColor: RED,
                      })),
                    // IPPIS Total (earnings or both)
                    {
                      header: "IPPIS Total",
                      key: "ippisTotal",
                      width: 18,
                      align: "right",
                      numFmt: EARN_FMT,
                      bgColor: YELLOW,
                      bold: true,
                    },
                  ]
                : [
                    // IPPIS Deductions only
                    ...deductionHeaders
                      .filter((c) => c.source === "IPPIS")
                      .map((c) => ({
                        header: c.label,
                        key: `d_${c.his_type}`,
                        width: dynW,
                        align: "right",
                        numFmt: DED_FMT,
                        wrapText: headersAreDesc,
                        bgColor: RED,
                      })),
                    // IPPIS Deductions Total
                    {
                      header: "IPPIS Deductions Total",
                      key: "ippisDedTotal",
                      width: 20,
                      align: "right",
                      numFmt: DED_FMT,
                      bgColor: RED,
                      bold: true,
                    },
                  ]),

              // ── NAVY group ─────────────────────────────────────────────────────
              ...(mode !== "deductions"
                ? [
                    // NAVY Earnings
                    ...earningHeaders
                      .filter((c) => c.source === "NAVY")
                      .map((c) => ({
                        header: c.label,
                        key: `e_${c.his_type}`,
                        width: dynW,
                        align: "right",
                        numFmt: EARN_FMT,
                        wrapText: headersAreDesc,
                        bgColor: GREEN,
                      })),
                    // NAVY Deductions
                    ...deductionHeaders
                      .filter((c) => c.source === "NAVY")
                      .map((c) => ({
                        header: c.label,
                        key: `d_${c.his_type}`,
                        width: dynW,
                        align: "right",
                        numFmt: DED_FMT,
                        wrapText: headersAreDesc,
                        bgColor: RED,
                      })),
                    // NAVY Total
                    {
                      header: "NAVY Total",
                      key: "navyTotal",
                      width: 18,
                      align: "right",
                      numFmt: EARN_FMT,
                      bgColor: BLUE,
                      bold: true,
                    },
                  ]
                : [
                    // NAVY Deductions only
                    ...deductionHeaders
                      .filter((c) => c.source === "NAVY")
                      .map((c) => ({
                        header: c.label,
                        key: `d_${c.his_type}`,
                        width: dynW,
                        align: "right",
                        numFmt: DED_FMT,
                        wrapText: headersAreDesc,
                        bgColor: RED,
                      })),
                    // NAVY Deductions Total
                    {
                      header: "NAVY Deductions Total",
                      key: "navyDedTotal",
                      width: 20,
                      align: "right",
                      numFmt: DED_FMT,
                      bgColor: RED,
                      bold: true,
                    },
                  ]),

              // Net Pay — only for 'both'
              ...(mode === "both"
                ? [
                    {
                      header: "Net Pay",
                      key: "netPay",
                      width: 18,
                      align: "right",
                      numFmt: EARN_FMT,
                      bold: true,
                    },
                  ]
                : []),
            ]
          : [
              // ── Navy only mode — NO colors ─────────────────────────────────────
              ...(mode !== "deductions"
                ? [
                    // Earnings
                    ...earningHeaders.map((c) => ({
                      header: c.label,
                      key: `e_${c.his_type}`,
                      width: dynW,
                      align: "right",
                      numFmt: EARN_FMT,
                      wrapText: headersAreDesc,
                    })),
                    // Total Emolument
                    {
                      header: "Total Emolument",
                      key: "totalEarnings",
                      width: 18,
                      align: "right",
                      numFmt: EARN_FMT,
                      bold: true,
                    },
                  ]
                : []),

              ...(mode !== "earnings"
                ? [
                    // Deductions
                    ...deductionHeaders.map((c) => ({
                      header: c.label,
                      key: `d_${c.his_type}`,
                      width: dynW,
                      align: "right",
                      numFmt: DED_FMT,
                      wrapText: headersAreDesc,
                    })),
                    // Total Deduction
                    {
                      header: "Total Deduction",
                      key: "totalDeductions",
                      width: 18,
                      align: "right",
                      numFmt: DED_FMT,
                      bold: true,
                    },
                  ]
                : []),

              // Net Pay — only for 'both'
              ...(mode === "both"
                ? [
                    {
                      header: "Net Pay",
                      key: "netPay",
                      width: 18,
                      align: "right",
                      numFmt: EARN_FMT,
                      bold: true,
                    },
                  ]
                : []),
            ]),
      ];

      // ── 5. Map employees to flat row data ──────────────────────────────────
      const dataRows = employees.map((emp, idx) => {
        const amtMap = payrollRegisterSvc.buildAmountMap(emp);

        let ippisEarn = 0,
          ippisDed = 0,
          navyEarn = 0,
          navyDed = 0;
        if (isIppis) {
          earningHeaders.forEach((c) => {
            const v = parseFloat(amtMap[c.his_type]) || 0;
            c.source === "IPPIS" ? (ippisEarn += v) : (navyEarn += v);
          });
          deductionHeaders.forEach((c) => {
            const v = parseFloat(amtMap[c.his_type]) || 0;
            c.source === "IPPIS" ? (ippisDed += v) : (navyDed += v);
          });
        }

        const row = {
          sn: idx + 1,
          serviceno: emp.serviceno,
          title: emp.title,
          fullname: emp.fullname,
        };

        if (isIppis) {
          if (mode !== "deductions") {
            earningHeaders
              .filter((c) => c.source === "IPPIS")
              .forEach((c) => {
                row[`e_${c.his_type}`] = parseFloat(amtMap[c.his_type]) || 0;
              });
            deductionHeaders
              .filter((c) => c.source === "IPPIS")
              .forEach((c) => {
                row[`d_${c.his_type}`] = parseFloat(amtMap[c.his_type]) || 0;
              });
            row.ippisTotal = ippisEarn - ippisDed;
            earningHeaders
              .filter((c) => c.source === "NAVY")
              .forEach((c) => {
                row[`e_${c.his_type}`] = parseFloat(amtMap[c.his_type]) || 0;
              });
            deductionHeaders
              .filter((c) => c.source === "NAVY")
              .forEach((c) => {
                row[`d_${c.his_type}`] = parseFloat(amtMap[c.his_type]) || 0;
              });
            row.navyTotal = navyEarn - navyDed;
          } else {
            deductionHeaders
              .filter((c) => c.source === "IPPIS")
              .forEach((c) => {
                row[`d_${c.his_type}`] = parseFloat(amtMap[c.his_type]) || 0;
              });
            row.ippisDedTotal = ippisDed;
            deductionHeaders
              .filter((c) => c.source === "NAVY")
              .forEach((c) => {
                row[`d_${c.his_type}`] = parseFloat(amtMap[c.his_type]) || 0;
              });
            row.navyDedTotal = navyDed;
          }
          if (mode === "both") row.netPay = parseFloat(emp.totals.netPay) || 0;
        } else {
          if (mode !== "deductions") {
            earningHeaders.forEach((c) => {
              row[`e_${c.his_type}`] = parseFloat(amtMap[c.his_type]) || 0;
            });
            row.totalEarnings = parseFloat(emp.totals.totalEarnings) || 0;
          }
          if (mode !== "earnings") {
            deductionHeaders.forEach((c) => {
              row[`d_${c.his_type}`] = parseFloat(amtMap[c.his_type]) || 0;
            });
            row.totalDeductions = parseFloat(emp.totals.totalDeductions) || 0;
          }
          if (mode === "both") row.netPay = parseFloat(emp.totals.netPay) || 0;
        }

        return row;
      });

      // ── 6. Subtitle ────────────────────────────────────────────────────────
      const metaParts = [];
      if (empnoFrom || empnoTo)
        metaParts.push(`Svc No: ${empnoFrom || "*"} – ${empnoTo || "*"}`);
      metaParts.push(`Period: ${this._periodLabel(period)}`);
      metaParts.push(`Class: ${className || payrollClass}`);
      const subtitle = metaParts.join("   |   ").toUpperCase();

      // ── 7. Grand totals ────────────────────────────────────────────────────
      let ippisTotalSum = 0,
        navyTotalSum = 0,
        ippisDedSum = 0,
        navyDedSum = 0;
      if (isIppis) {
        employees.forEach((emp) => {
          let iE = 0,
            iD = 0,
            nE = 0,
            nD = 0;
          const amtMap = payrollRegisterSvc.buildAmountMap(emp);
          earningHeaders.forEach((c) => {
            const v = parseFloat(amtMap[c.his_type]) || 0;
            c.source === "IPPIS" ? (iE += v) : (nE += v);
          });
          deductionHeaders.forEach((c) => {
            const v = parseFloat(amtMap[c.his_type]) || 0;
            c.source === "IPPIS" ? (iD += v) : (nD += v);
          });
          ippisTotalSum += iE - iD;
          navyTotalSum += nE - nD;
          ippisDedSum += iD;
          navyDedSum += nD;
        });
      }

      const totalsValues = {};
      columns.forEach((col, idx) => {
        const colNum = idx + 1;
        if (col.key === "totalEarnings")
          totalsValues[colNum] = employees.reduce(
            (s, e) => s + (parseFloat(e.totals.totalEarnings) || 0),
            0,
          );
        if (col.key === "totalDeductions")
          totalsValues[colNum] = employees.reduce(
            (s, e) => s + (parseFloat(e.totals.totalDeductions) || 0),
            0,
          );
        if (col.key === "netPay")
          totalsValues[colNum] = employees.reduce(
            (s, e) => s + (parseFloat(e.totals.netPay) || 0),
            0,
          );
        if (col.key === "ippisTotal") totalsValues[colNum] = ippisTotalSum;
        if (col.key === "navyTotal") totalsValues[colNum] = navyTotalSum;
        if (col.key === "ippisDedTotal") totalsValues[colNum] = ippisDedSum;
        if (col.key === "navyDedTotal") totalsValues[colNum] = navyDedSum;
        if (col.key.startsWith("e_")) {
          const his_type = col.key.replace("e_", "");
          totalsValues[colNum] = employees.reduce((s, emp) => {
            const e = emp.earnings.find((r) => r.his_type === his_type);
            return s + (parseFloat(e?.amount) || 0);
          }, 0);
        }
        if (col.key.startsWith("d_")) {
          const his_type = col.key.replace("d_", "");
          totalsValues[colNum] = employees.reduce((s, emp) => {
            const d = emp.deductions.find((r) => r.his_type === his_type);
            return s + (parseFloat(d?.amount) || 0);
          }, 0);
        }
      });

      // ── 8. Create workbook ─────────────────────────────────────────────────
      const exporter = new GenericExcelExporter();
      const workbook = await exporter.createWorkbook({
        title: "PAYROLL REGISTER",
        subtitle,
        columns,
        data: dataRows,
        totals: { label: "GRAND TOTALS:", values: totalsValues },
        sheetName: "Payroll Register",
      });

      // ── 9. Apply bgColors — header row and grand totals row ONLY ──────────
      const worksheet = workbook.worksheets[0];
      const HEADER_ROW = 5;
      const TOTALS_ROW = worksheet.rowCount;

      const colBgMap = {};
      columns.forEach((col, idx) => {
        if (col.bgColor) colBgMap[idx + 1] = col.bgColor;
      });

      [HEADER_ROW, TOTALS_ROW].forEach((rowNum) => {
        const row = worksheet.getRow(rowNum);
        Object.entries(colBgMap).forEach(([colNum, bg]) => {
          const cell = row.getCell(parseInt(colNum));
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF" + bg },
          };
          // Re-apply numFmt after fill
          const col = columns[parseInt(colNum) - 1];
          if (col?.numFmt) cell.numFmt = col.numFmt;
        });
      });

      // ── 10. Freeze + print setup ───────────────────────────────────────────
      worksheet.views = [{ state: "frozen", xSplit: 3, ySplit: 5 }];
      worksheet.pageSetup = {
        ...worksheet.pageSetup,
        scale: 50,
        fitToPage: false,
        orientation: "landscape",
        paperSize: 9,
      };

      // ── 11. Stream response ────────────────────────────────────────────────
      await exporter.exportToResponse(
        workbook,
        res,
        `payroll_register_${period}.xlsx`,
      );
    } catch (error) {
      console.error("Payroll register Excel error:", error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message });
      }
    }
  }

  // ==========================================================================
  // PRIVATE: PERIOD LABEL  202501 → 'Jan 2025'
  // ==========================================================================
  _periodLabel(p) {
    if (!p || p.length < 6) return p || "";
    const M = [
      "",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return (M[parseInt(p.substring(4, 6))] || "???") + " " + p.substring(0, 4);
  }

  // ==========================================================================
  // PRIVATE: Column letter from 1-based index  (3 → 'C', 28 → 'AB')
  // ==========================================================================
  _colLetter(n) {
    let s = "";
    while (n > 0) {
      s = String.fromCharCode(64 + (n % 26 || 26)) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // ==========================================================================
  // PRIVATE: Quick cell styler
  // ==========================================================================
  _styleCell(
    cell,
    value,
    { bg, fg, bold = false, align = "left", size = 9 } = {},
  ) {
    cell.value = value;
    cell.font = { bold, size, color: { argb: fg || "FF000000" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: bg || "FFFFFFFF" },
    };
    cell.alignment = { horizontal: align, vertical: "middle" };
  }

  // ==========================================================================
  // PRIVATE: HANDLEBARS HELPERS STRING FOR TEMPLATE (Chromium path)
  // ==========================================================================
  _getPayrollRegisterHelpers() {
    return `
      function periodLabel(p) {
        if (!p || p.length < 6) return p || '';
        const m = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return (m[parseInt(p.substring(4,6))] || '???') + ' ' + p.substring(0,4);
      }
      function fmtCurrency(v) {
        const n = parseFloat(v) || 0;
        return n === 0 ? '' : n.toLocaleString('en-NG', { minimumFractionDigits:2, maximumFractionDigits:2 });
      }
      function amtFor(entries, hisType) {
        const entry = (entries || []).find(e => e.his_type === hisType);
        return entry ? fmtCurrency(entry.amount) : '';
      }
      function colTotal(employees, hisType, area) {
        return (employees || []).reduce(function(s, emp) {
          var list = area === 'deductions' ? emp.deductions : emp.earnings;
          var e = (list || []).find(function(x){ return x.his_type === hisType; });
          return s + (parseFloat(e && e.amount) || 0);
        }, 0);
      }
      function formatDate(date) {
        const d = new Date(date);
        const M = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear();
      }
      function formatTime(date) {
        return new Date(date).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      }
      function eq(a, b)  { return a === b; }
      function add(a, b) { return (parseFloat(a)||0) + (parseFloat(b)||0); }
    `;
  }

  // ==========================================================================
  // GET CLASS NAME (same pattern as salary history controller)
  // ==========================================================================
  async getDatabaseNameFromRequest(req) {
    const currentDb = req.current_class;
    if (!currentDb) return "OFFICERS";
    const [classInfo] = await pool.query(
      "SELECT classname FROM py_payrollclass WHERE db_name = ?",
      [currentDb],
    );
    return classInfo.length > 0 ? classInfo[0].classname : currentDb;
  }

  async getDatabaseCodeFromRequest(req) {
    const currentDb = req.current_class;
    if (!currentDb) return "OFFICERS";
    const [classInfo] = await pool.query(
      "SELECT classcode FROM py_payrollclass WHERE db_name = ?",
      [currentDb],
    );
    return classInfo.length > 0 ? classInfo[0].classcode : currentDb;
  }
}

module.exports = new PayrollRegisterController();
