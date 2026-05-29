// ============================================
// CONSOLIDATED PAYSLIP CONTROLLER
// Generates IPPIS + NAVY combined payslips
// ============================================
const BaseReportController = require("../Reports/reportsFallbackController");
const pool = require("../../config/db");
//const PDFDocument = require('pdfkit');
const jsreport = require("jsreport-core")();
const fs = require("fs");
const path = require("path");

class ConsolidatedPayslipController extends BaseReportController {
  constructor() {
    super(); // Initialize base class
  }

  // ==========================================================================
  // GENERATE CONSOLIDATED PAYSLIPS
  // ==========================================================================
  async generateConsolidatedPayslips(req, res) {
    const {
      period, // Required: YYYYMM format
      payrollClass, // Required: e.g., 'FE'
      employeeFrom, // Optional
      employeeTo, // Optional
      printRange, // Optional: true/false
    } = req.body;

    const username = req.user_fullname || req.user_id;
    const sessionKey = `${username}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`;

    if (!username) {
      return res.status(401).json({
        success: false,
        error: "User authentication required. Please log in again.",
      });
    }

    if (!period || !payrollClass) {
      return res.status(400).json({
        success: false,
        error: "Period and payroll class are required",
      });
    }

    const inputYear = parseInt(period.substring(0, 4));
    const inputMonth = parseInt(period.substring(4, 6));

    if (
      isNaN(inputYear) ||
      isNaN(inputMonth) ||
      inputMonth < 1 ||
      inputMonth > 12
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid period format. Expected YYYYMM (e.g., 202501)",
      });
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 0-indexed

    const isFuture =
      inputYear > currentYear ||
      (inputYear === currentYear && inputMonth > currentMonth);

    if (isFuture) {
      return res.status(400).json({
        success: false,
        error: `Period ${period} is in the future. Payslips can only be generated for the current or past months.`,
      });
    }

    try {
      // ✅ Add debug logging
      const paramEmployeeFrom = employeeFrom || "A";
      const paramEmployeeTo = employeeTo || "Z";
      const paramPrintRange = printRange ? "1" : "0";

      console.log("=== STORED PROCEDURE PARAMETERS ===");
      console.log("employeeFrom:", paramEmployeeFrom);
      console.log("employeeTo:", paramEmployeeTo);
      console.log("period:", period);
      console.log("payrollClass:", payrollClass);
      console.log("username:", username);
      console.log("printRange:", paramPrintRange);
      console.log("===================================");

      // Call stored procedure to generate payslips
      const [results] = await pool.query(
        "CALL py_generate_combined_payslip(?, ?, ?, ?, ?, ?)",
        [
          paramEmployeeFrom,
          paramEmployeeTo,
          period,
          payrollClass,
          sessionKey,
          paramPrintRange,
        ],
      );

      const summary = results[0][0];

      console.log("Stored procedure summary:", summary);

      // Fetch generated payslips
      const year = period.substring(0, 4);
      const monthNum = parseInt(period.substring(4, 6));

      const [monthData] = await pool.query(
        "SELECT mthdesc FROM ac_months WHERE cmonth = ?",
        [monthNum],
      );

      const month = monthData[0].mthdesc;

      const [rawPayslips] = await pool.query(
        `SELECT * FROM py_webpayslip
        WHERE work_station = ?
          AND ord = ?
          AND desc1 = ?
        ORDER BY numb, source DESC, bpc, bp`,
        [sessionKey, year, month],
      );

      console.log("Total raw payslip records fetched:", rawPayslips.length);

      if (!rawPayslips || rawPayslips.length === 0) {
        throw new Error(
          `No payslip records found for period ${period} and payroll class ${payrollClass}`,
        );
      }

      console.log(
        "Unique employees:",
        [...new Set(rawPayslips.map((r) => r.NUMB || r.numb))].length,
      );

      // Transform data for template
      const mappedData = this._mapConsolidatedPayslipData(rawPayslips);

      console.log("Mapped data employees:", mappedData.length);

      return res.json({
        success: true,
        message: `Generated ${summary.total_employees} consolidated payslips`,
        data: mappedData,
        summary: {
          totalEmployees: summary.total_employees,
          totalRecords: summary.total_records,
          ippisRecords: summary.ippis_records,
          navyRecords: summary.navy_records,
        },
      });
    } catch (error) {
      console.error("Consolidated payslip generation error:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "An unexpected error occurred",
      });
    }
  }

  // ==========================================================================
  // GENERATE CONSOLIDATED PAYSLIP PDF
  // ==========================================================================
  async generateConsolidatedPayslipPDF(req, res) {
    const mappedData = req.body.data || [];

    if (mappedData.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No payslip data provided for PDF generation.",
      });
    }

    try {
      const templatePath = path.join(
        __dirname,
        "../../templates/consolidated-payslip.html",
      );

      const logoPath = "./public/photos/logo.png";
      let logoDataUrl = "";

      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        const logoBase64 = logoBuffer.toString("base64");
        logoDataUrl = `data:image/png;base64,${logoBase64}`;
      }

      const className = await this.getDatabaseNameFromRequest(req);

      console.log(
        `📄 Generating consolidated payslips for ${mappedData.length} employees`,
      );

      const BATCH_SIZE = 100;

      const pdfBuffer = await this.generateBatchedPDF(
        templatePath,
        mappedData,
        BATCH_SIZE,
        {
          format: "A5",
          landscape: false,
          timeout: 120000,
          helpers: this._getCommonHelpers() + this._getConsolidatedHelpers(),
          options: {
            timeout: 120000,
            reportTimeout: 120000,
          },
        },
        {
          payDate: new Date(),
          logoDataUrl: logoDataUrl,
          className: className,
        },
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=consolidated_payslips.pdf",
      );
      res.send(pdfBuffer);
    } catch (error) {
      console.error("Consolidated PDF generation error:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "An error occurred during PDF generation.",
      });
    }
  }

  // ==========================================================================
  // GENERATE CONSOLIDATED PAYSLIP EXCEL
  // ==========================================================================
  async generateConsolidatedPayslipExcel(req, res) {
    const mappedData = req.body.data || [];

    if (mappedData.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No payslip data provided for Excel generation.",
      });
    }

    try {
      const ExcelJS = require("exceljs");
      const workbook = new ExcelJS.Workbook();
      const className = await this.getDatabaseNameFromRequest(req);

      // ── Colours taken directly from the payslip CSS ──────────────────────
      // #1e40af  → FF1E40AF  (blue — headings, section headers)
      // #4a4a4a  → FF4A4A4A  (muted grey — info values, descriptions)
      // #1a1a1a  → FF1A1A1A  (near-black — amounts, bold labels)
      // #f5f5f5  → FFF5F5F5  (light grey — total-row bg)
      // #f0f0f0  → FFF0F0F0  (slightly darker grey — net-pay bg)
      // #fafafa  → FFFafafa  (near-white — employee-info box bg)
      // #d0d0d0  → FFD0D0D0  (grey border)
      // #fef3c7  → FFFEF3C7  (amber — IPPIS/NAVY source band bg)
      // #92400e  → FF92400E  (amber dark — IPPIS/NAVY source band text)
      // #7c3aed  → FF7C3AED  (violet — outstanding months)
      // white    → FFFFFFFF

      const BLUE = "FF1E40AF";
      const GREY_DARK = "FF1A1A1A";
      const GREY_MID = "FF4A4A4A";
      const GREY_BG = "FFF5F5F5"; // .total-row background
      const NET_BG = "FFF0F0F0"; // .net-pay background
      const INFO_BG = "FFFafafa"; // .employee-info background
      const BORDER = "FFD0D0D0"; // border colour
      const CELL_LINE = "FFC8D4E8"; // .info-row border (subtle)
      const AMBER_BG = "FFFEF3C7"; // source header band bg
      const AMBER_FG = "FF92400E"; // source header band text
      const WHITE = "FFFFFFFF";
      const SECTION_BG = "FFE8F0FE"; // light blue used on section headers

      const CURRENCY_FMT = "#,##0.00";
      const COLS = 4; // Description | Amount | L.Bal | Os.Mths

      mappedData.forEach((emp) => {
        // Sheet name = service number, sanitised
        const sheetName = `${emp.employee_id || emp.numb || "EMP"}`
          .replace(/[/\\?*[\]:]/g, "_")
          .substring(0, 31);

        const ws = workbook.addWorksheet(sheetName, {
          pageSetup: { orientation: "portrait", paperSize: 9 },
        });

        // Fixed column widths
        ws.getColumn(1).width = 42; // description
        ws.getColumn(2).width = 20; // amount
        ws.getColumn(3).width = 18; // L.Bal
        ws.getColumn(4).width = 12; // Os.Mths

        // ── Utility helpers ─────────────────────────────────────────────────

        // Full-width merged row (used for org header lines)
        const titleRow = (
          text,
          { bold, size, fg, bg, height = 18, italic = false } = {},
        ) => {
          const r = ws.addRow([text]);
          ws.mergeCells(r.number, 1, r.number, COLS);
          const c = r.getCell(1);
          c.value = text;
          c.font = { name: "Calibri", bold, italic, size, color: { argb: fg } };
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
          c.alignment = { horizontal: "center", vertical: "middle" };
          r.height = height;
          return r;
        };

        // Section header — mirrors .section-header (blue text, no bold bg)
        const addSectionHeader = (text) => {
          const r = ws.addRow([text]);
          ws.mergeCells(r.number, 1, r.number, COLS);
          const c = r.getCell(1);
          c.value = text;
          c.font = {
            name: "Calibri",
            bold: true,
            size: 10,
            color: { argb: BLUE },
          };
          c.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: SECTION_BG },
          };
          c.alignment = { horizontal: "left", vertical: "middle" };
          r.height = 17;
        };

        // Source band — mirrors .source-header (IPPIS / NAVY centred underline)
        const addSourceHeader = (text) => {
          const r = ws.addRow([text]);
          ws.mergeCells(r.number, 1, r.number, COLS);
          const c = r.getCell(1);
          c.value = text;
          c.font = {
            name: "Calibri",
            bold: true,
            size: 11,
            color: { argb: AMBER_FG },
          };
          c.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: AMBER_BG },
          };
          c.alignment = { horizontal: "center", vertical: "middle" };
          c.border = { bottom: { style: "medium", color: { argb: BLUE } } };
          r.height = 18;
        };

        // Data row — mirrors .items-table tbody td
        // For deduction rows pass lbal / osmths; for earnings leave them undefined
        const addDataRow = (description, amount, lbal, osmths) => {
          const r = ws.addRow([
            description,
            amount,
            lbal || null,
            osmths || null,
          ]);
          r.height = 16;
          const desc = r.getCell(1);
          desc.font = { name: "Calibri", size: 10, color: { argb: GREY_MID } };
          desc.border = {
            bottom: { style: "thin", color: { argb: CELL_LINE } },
          };
          desc.alignment = { vertical: "middle" };

          const amt = r.getCell(2);
          amt.value = amount;
          amt.numFmt = CURRENCY_FMT;
          amt.font = {
            name: "Courier New",
            bold: true,
            size: 10,
            color: { argb: GREY_DARK },
          };
          amt.alignment = { horizontal: "right", vertical: "middle" };
          amt.border = {
            bottom: { style: "thin", color: { argb: CELL_LINE } },
          };

          // L.Bal — col 3 (mirrors .ded-lbal); suppress zero / empty / dash
          const lbalCell = r.getCell(3);
          const lbalNum = parseFloat(lbal);
          if (
            lbal != null &&
            lbal !== "" &&
            lbal !== "-" &&
            !isNaN(lbalNum) &&
            lbalNum !== 0
          ) {
            lbalCell.value = lbalNum;
            lbalCell.numFmt = CURRENCY_FMT;
            lbalCell.font = {
              name: "Courier New",
              bold: true,
              size: 10,
              color: { argb: GREY_DARK },
            };
            lbalCell.alignment = { horizontal: "right", vertical: "middle" };
          }
          lbalCell.border = {
            bottom: { style: "thin", color: { argb: CELL_LINE } },
          };

          // Os.Mths — col 4 (mirrors .ded-osmth, violet)
          const osmthCell = r.getCell(4);
          if (osmths != null && osmths !== "" && osmths !== "-") {
            osmthCell.value = osmths;
            osmthCell.font = {
              name: "Courier New",
              bold: true,
              size: 10,
              color: { argb: "FF7C3AED" },
            };
            osmthCell.alignment = { horizontal: "right", vertical: "middle" };
          }
          osmthCell.border = {
            bottom: { style: "thin", color: { argb: CELL_LINE } },
          };
        };

        // Total row — mirrors .total-row
        const addTotalRow = (label, amount) => {
          const r = ws.addRow([label, amount]);
          r.height = 18;
          [1, 2, 3, 4].forEach((col) => {
            const c = r.getCell(col);
            c.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: GREY_BG },
            };
            c.border = {
              top: { style: "thin", color: { argb: BORDER } },
              bottom: { style: "thin", color: { argb: BORDER } },
            };
            c.font = {
              name: "Calibri",
              bold: true,
              size: 10,
              color: { argb: GREY_DARK },
            };
          });
          r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
          r.getCell(2).numFmt = CURRENCY_FMT;
          r.getCell(2).font = {
            name: "Courier New",
            bold: true,
            size: 10,
            color: { argb: GREY_DARK },
          };
          r.getCell(2).alignment = { horizontal: "right", vertical: "middle" };
        };

        // Net pay row — mirrors .net-pay (bold border, slightly darker bg)
        const addNetPayRow = (label, amount) => {
          const r = ws.addRow([label, amount]);
          r.height = 22;
          [1, 2, 3, 4].forEach((col) => {
            const c = r.getCell(col);
            c.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: NET_BG },
            };
            c.border = {
              top: { style: "medium", color: { argb: GREY_DARK } },
              bottom: { style: "medium", color: { argb: GREY_DARK } },
              left: { style: "medium", color: { argb: GREY_DARK } },
              right: { style: "medium", color: { argb: GREY_DARK } },
            };
            c.font = {
              name: "Calibri",
              bold: true,
              size: 12,
              color: { argb: GREY_DARK },
            };
          });
          r.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
          r.getCell(2).numFmt = CURRENCY_FMT;
          r.getCell(2).font = {
            name: "Courier New",
            bold: true,
            size: 12,
            color: { argb: GREY_DARK },
          };
          r.getCell(2).alignment = { horizontal: "right", vertical: "middle" };
        };

        // Info row — mirrors .info-row inside .employee-info
        const addInfoRow = (label, value) => {
          const r = ws.addRow([label, value]);
          r.height = 16;
          const lc = r.getCell(1);
          lc.font = {
            name: "Calibri",
            bold: true,
            size: 10,
            color: { argb: GREY_DARK },
          };
          lc.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: INFO_BG },
          };
          lc.border = { bottom: { style: "thin", color: { argb: CELL_LINE } } };
          lc.alignment = { vertical: "middle" };

          const vc = r.getCell(2);
          vc.value = value;
          vc.font = { name: "Calibri", size: 10, color: { argb: GREY_MID } };
          vc.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: INFO_BG },
          };
          vc.border = { bottom: { style: "thin", color: { argb: CELL_LINE } } };
          vc.alignment = { vertical: "middle" };

          // Fill cols 3 & 4 so info box looks complete
          [3, 4].forEach((col) => {
            const c = r.getCell(col);
            c.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: INFO_BG },
            };
            c.border = {
              bottom: { style: "thin", color: { argb: CELL_LINE } },
            };
          });
        };

        // Blank spacer row
        const spacer = (height = 4) => {
          ws.addRow([]).height = height;
        };

        // ════════════════════════════════════════════════════════════════════
        // HEADER BLOCK  — mirrors .header-wrapper
        // ════════════════════════════════════════════════════════════════════
        titleRow("Nigerian Navy (Naval Headquarters)", {
          bold: true,
          size: 16,
          fg: BLUE,
          bg: WHITE,
          height: 28,
        });
        titleRow("CENTRAL PAY OFFICE, 23 POINT ROAD APAPA", {
          bold: false,
          size: 11,
          fg: GREY_MID,
          bg: WHITE,
          height: 16,
        });

        // Divider under header
        const divRow = ws.addRow([]);
        ws.mergeCells(divRow.number, 1, divRow.number, COLS);
        divRow.getCell(1).border = {
          bottom: { style: "medium", color: { argb: GREY_DARK } },
        };
        divRow.height = 3;

        spacer(4);

        // ── Pay period row — mirrors .pay-period ─────────────────────────────
        const payPeriod =
          `${emp.payroll_month || ""} ${emp.payroll_year || ""}`.trim();
        const producedOn = new Date().toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
        });
        const ppRow = ws.addRow([
          `Pay Period: ${payPeriod}`,
          "",
          `Produced On: ${producedOn}`,
          "",
        ]);
        ppRow.height = 15;
        ppRow.getCell(1).font = {
          name: "Calibri",
          size: 10,
          color: { argb: GREY_MID },
        };
        ppRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
        ws.mergeCells(ppRow.number, 3, ppRow.number, 4);
        ppRow.getCell(3).font = {
          name: "Calibri",
          size: 10,
          color: { argb: GREY_MID },
        };
        ppRow.getCell(3).alignment = {
          horizontal: "right",
          vertical: "middle",
        };

        // .pp-center — payclass name (not employee name, unlike consolidated)
        const classRow = ws.addRow([`${className} CONSOLIDATED PAYSLIP`]);
        ws.mergeCells(classRow.number, 1, classRow.number, COLS);
        classRow.getCell(1).font = {
          name: "Times New Roman",
          bold: true,
          italic: true,
          size: 8,
          color: { argb: GREY_DARK },
        };
        classRow.getCell(1).alignment = {
          horizontal: "center",
          vertical: "middle",
        };
        classRow.height = 14;

        spacer(5);

        // ════════════════════════════════════════════════════════════════════
        // EMPLOYEE PROFILE BLOCK  — mirrors .employee-info
        // ════════════════════════════════════════════════════════════════════
        addSectionHeader("PERSONNEL INFORMATION");
        addInfoRow(
          "Name:",
          `${emp.title ? emp.title + ". " : ""}${emp.surname || ""} ${emp.othername || ""}`.trim(),
        );
        addInfoRow("Service No:", emp.employee_id || "");
        addInfoRow("Grade:", emp.gradelevel || "");
        addInfoRow("Department:", emp.department || "");
        addInfoRow("Branch:", emp.factory || "");
        addInfoRow(
          "Bank Account:",
          `${emp.bank_account_number || ""}${emp.bank_name ? " (" + emp.bank_name + ")" : ""}`,
        );
        if (emp.nsitfcode) addInfoRow("RSA (Pension):", emp.nsitfcode);

        spacer(5);

        // ════════════════════════════════════════════════════════════════════
        // IPPIS BLOCK  — mirrors {{#if ippis}} section
        // ════════════════════════════════════════════════════════════════════
        if (emp.ippis) {
          addSourceHeader("IPPIS");

          // Column labels for the extra deduction columns — mirrors .sr-labels
          const ippLblRow = ws.addRow(["", "", "₦ L.Bal", "Os.Mths"]);
          ippLblRow.height = 13;
          [3, 4].forEach((col) => {
            const c = ippLblRow.getCell(col);
            c.font = {
              name: "Calibri",
              bold: true,
              size: 9,
              color: { argb: GREY_MID },
            };
            c.alignment = { horizontal: "right", vertical: "middle" };
          });

          if (emp.ippis.taxable && emp.ippis.taxable.length > 0) {
            addSectionHeader("TAXABLE PAYMENT");
            emp.ippis.taxable.forEach((item) =>
              addDataRow(item.description, item.amount),
            );
          }

          if (emp.ippis.nontaxable && emp.ippis.nontaxable.length > 0) {
            addSectionHeader("NON-TAXABLE PAYMENT");
            emp.ippis.nontaxable.forEach((item) =>
              addDataRow(item.description, item.amount),
            );
          }

          if (emp.ippis.deductions && emp.ippis.deductions.length > 0) {
            addSectionHeader("DEDUCTIONS");
            emp.ippis.deductions.forEach((item) =>
              addDataRow(
                item.description,
                -Math.abs(item.amount),
                item.loan_balance,
                item.outstanding_months,
              ),
            );
          }

          addTotalRow("IPPIS TOTAL", emp.ippis.net || 0);
          spacer(4);
        }

        // ════════════════════════════════════════════════════════════════════
        // NAVY BLOCK  — mirrors {{#if navy}} section
        // ════════════════════════════════════════════════════════════════════
        if (emp.navy) {
          addSourceHeader("NAVY");

          // Column labels for the extra deduction columns
          const navyLblRow = ws.addRow(["", "", "₦ L.Bal", "Os.Mths"]);
          navyLblRow.height = 13;
          [3, 4].forEach((col) => {
            const c = navyLblRow.getCell(col);
            c.font = {
              name: "Calibri",
              bold: true,
              size: 9,
              color: { argb: GREY_MID },
            };
            c.alignment = { horizontal: "right", vertical: "middle" };
          });

          if (emp.navy.taxable && emp.navy.taxable.length > 0) {
            addSectionHeader("TAXABLE PAYMENT");
            emp.navy.taxable.forEach((item) =>
              addDataRow(item.description, item.amount),
            );
          }

          if (emp.navy.nontaxable && emp.navy.nontaxable.length > 0) {
            addSectionHeader("NON-TAXABLE PAYMENT");
            emp.navy.nontaxable.forEach((item) =>
              addDataRow(item.description, item.amount),
            );
          }

          if (emp.navy.deductions && emp.navy.deductions.length > 0) {
            addSectionHeader("DEDUCTIONS");
            emp.navy.deductions.forEach((item) =>
              addDataRow(
                item.description,
                -Math.abs(item.amount),
                item.loan_balance,
                item.outstanding_months,
              ),
            );
          }

          addTotalRow("NAVY TOTAL", emp.navy.net || 0);
          spacer(4);
        }

        // ════════════════════════════════════════════════════════════════════
        // NET PAY ROW  — mirrors .net-pay
        // ════════════════════════════════════════════════════════════════════
        addNetPayRow("NET PAYMENT THIS MONTH", emp.net_pay || 0);

        spacer(6);

        // ════════════════════════════════════════════════════════════════════
        // FOOTER  — mirrors .footer
        // ════════════════════════════════════════════════════════════════════
        const footDivRow = ws.addRow([]);
        ws.mergeCells(footDivRow.number, 1, footDivRow.number, COLS);
        footDivRow.getCell(1).border = {
          top: { style: "medium", color: { argb: BORDER } },
        };
        footDivRow.height = 3;

        const footRow = ws.addRow([
          "All rights reserved © Hicad Systems Limited.",
        ]);
        ws.mergeCells(footRow.number, 1, footRow.number, COLS);
        footRow.getCell(1).font = {
          name: "Calibri",
          size: 7,
          color: { argb: GREY_MID },
        };
        footRow.getCell(1).alignment = { horizontal: "center" };
        footRow.height = 12;
      });

      // ── Send ──────────────────────────────────────────────────────────────
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=consolidated_payslips.xlsx",
      );
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      console.error("Consolidated Excel export error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // PRIVATE: MAP CONSOLIDATED PAYSLIP DATA
  // ==========================================================================
  _mapConsolidatedPayslipData(rawPayslips) {
    const employeeMap = {};

    // Group by employee
    rawPayslips.forEach((row) => {
      const empId = row.NUMB || row.numb; // Handle case sensitivity

      if (!employeeMap[empId]) {
        employeeMap[empId] = {
          employee_id: row.NUMB || row.numb,
          surname: row.surname,
          othername: row.othername,
          title: row.title,
          gradelevel: row.gradelevel,
          gradetype: row.gradetype,
          department: row.location || row.Location,
          factory: row.factory,
          bank_name: row.bankname,
          bank_account_number: row.bankacnumber,
          nsitfcode: row.nsitfcode,
          payclass: row.payclass,
          payclass_name: row.payclass,
          payroll_month: row.desc1,
          payroll_year: row.ord,
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
      }

      const emp = employeeMap[empId];
      const source = row.source;
      const category = row.bpc;
      const amount = parseFloat(row.BPM || row.bpm) || 0; // Handle case sensitivity

      const item = {
        description: row.BP || row.bp || "Unknown", // ✅ FIX: Use uppercase BP
        amount: amount,
        loan_balance: row.lbal ? parseFloat(row.lbal) : null,
        outstanding_months: row.lmth ? parseFloat(row.lmth) : null,
      };

      if (source === "IPPIS") {
        if (category === "BP" || category === "BT") {
          // ✅ Taxable: BP or BT
          emp.ippis.taxable.push(item);
          emp.ippis.taxable_total += amount;
        } else if (category === "PT") {
          // ✅ Non-taxable: PT
          emp.ippis.nontaxable.push(item);
          emp.ippis.nontaxable_total += amount;
        } else if (category === "PR" || category === "PL") {
          // ✅ Deductions: PR or PL
          emp.ippis.deductions.push(item);
          emp.ippis.deductions_total += amount;
        }
      } else if (source === "NAVY") {
        if (category === "BP" || category === "BT") {
          // ✅ Taxable: BP or BT
          emp.navy.taxable.push(item);
          emp.navy.taxable_total += amount;
        } else if (category === "PT") {
          // ✅ Non-taxable: PT
          emp.navy.nontaxable.push(item);
          emp.navy.nontaxable_total += amount;
        } else if (category === "PR" || category === "PL") {
          // ✅ Deductions: PR or PL
          emp.navy.deductions.push(item);
          emp.navy.deductions_total += amount;
        }
      }
    });

    // Calculate net amounts
    Object.values(employeeMap).forEach((emp) => {
      emp.ippis.net =
        emp.ippis.taxable_total +
        emp.ippis.nontaxable_total -
        emp.ippis.deductions_total;
      emp.navy.net =
        emp.navy.taxable_total +
        emp.navy.nontaxable_total -
        emp.navy.deductions_total;
      emp.net_pay = emp.ippis.net + emp.navy.net;

      // Remove empty sections
      if (
        emp.ippis.taxable.length === 0 &&
        emp.ippis.nontaxable.length === 0 &&
        emp.ippis.deductions.length === 0
      ) {
        emp.ippis = null;
      }
      if (
        emp.navy.taxable.length === 0 &&
        emp.navy.nontaxable.length === 0 &&
        emp.navy.deductions.length === 0
      ) {
        emp.navy = null;
      }
    });

    return Object.values(employeeMap);
  }

  // ==========================================================================
  // PRIVATE: HANDLEBARS HELPERS
  // ==========================================================================
  _getConsolidatedHelpers() {
    return `
      function formatCurrency(value) {
        if (!value && value !== 0) return '0.00';
        return parseFloat(value).toFixed(2).replace(/\\d(?=(\\d{3})+\\.)/g, '$&,');
      }

      function formatDate(date) {
        const d = new Date(date);
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
        return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
      }

      function add(a, b) {
        return (parseFloat(a) || 0) + (parseFloat(b) || 0);
      }

      function eq(a, b) {
        return a === b;
      }
    `;
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

module.exports = ConsolidatedPayslipController;
