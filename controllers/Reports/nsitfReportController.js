// ============================================================================
// controllers/Reports/NSITFReportController.js
//   1. generateNSITFReport: extracts payment_codes from req.query,
//      normalises and passes as paymentCodes to service.
//   2. generateNSITFReportExcel: adds contribution_this_month and
//      contribution_paid_todate columns when they are present in the data.
//   3. getNSITFFilterOptions: also returns available payment codes so the
//      frontend can populate its element selector.
// ============================================================================

const BaseReportController = require("../Reports/reportsFallbackController");
const nsitfReportService = require("../../services/Reports/nsitfReportService");
const ExcelJS = require("exceljs");
const companySettings = require("../helpers/companySettings");
const { GenericExcelExporter } = require("../helpers/excel");
const pool = require("../../config/db");
const fs = require("fs");
const path = require("path");

class NSITFReportController extends BaseReportController {
  constructor() {
    super();
  }

  _getUniqueSheetName(baseName, tracker) {
    let sanitized = baseName
      .replace(/[\*\?\:\\\/\[\]]/g, "-")
      .substring(0, 31)
      .replace(/[\s\-]+$/, "");
    let finalName = sanitized;
    let counter = 1;
    while (tracker[finalName]) {
      const suffix = ` (${counter})`;
      finalName = sanitized.substring(0, 31 - suffix.length) + suffix;
      counter++;
    }
    tracker[finalName] = true;
    return finalName;
  }

  // ==========================================================================
  // MAIN ENDPOINT
  // ==========================================================================
  async generateNSITFReport(req, res) {
    try {
      const { format, summaryOnly, pfa_code, payment_codes, ...otherFilters } =
        req.query;

      // Normalise payment_codes — frontend may send repeated params or CSV
      let paymentCodes = [];
      if (payment_codes) {
        paymentCodes = Array.isArray(payment_codes)
          ? payment_codes
          : String(payment_codes)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
      }

      const filters = {
        ...otherFilters,
        summaryOnly: summaryOnly === "1" || summaryOnly === "true",
        pfaCode: pfa_code,
        paymentCodes: paymentCodes.length > 0 ? paymentCodes : undefined,
      };

      console.log("NSITF Report Filters:", filters);
      const data = await nsitfReportService.getNSITFReport(filters);
      console.log("NSITF Report Data rows:", data.length);
      console.log("NSITF Report Sample row:", data[0]);

      if (format === "excel")
        return this.generateNSITFReportExcel(
          data,
          req,
          res,
          filters.summaryOnly,
        );
      if (format === "pdf") return this.generateNSITFReportPDF(data, req, res);

      const summary = this.calculateSummary(data, filters.summaryOnly);
      res.json({ success: true, data, summary });
    } catch (error) {
      console.error("Error generating NSITF report:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // SUMMARY STATISTICS
  // ==========================================================================
  calculateSummary(data, isSummary) {
    if (data.length === 0) {
      return {
        totalEmployees: 0,
        totalNetPay: 0,
        averageNetPay: 0,
        pfaCount: 0,
      };
    }

    const hasContributions =
      data[0].hasOwnProperty("contribution_this_month") ||
      data[0].hasOwnProperty("total_contribution_this_month");

    if (isSummary) {
      const summary = {
        totalEmployees: data.reduce(
          (s, r) => s + parseInt(r.employee_count || 0),
          0,
        ),
        totalNetPay: data.reduce(
          (s, r) => s + parseFloat(r.total_net_pay || 0),
          0,
        ),
        averageNetPay:
          data.reduce((s, r) => s + parseFloat(r.avg_net_pay || 0), 0) /
          data.length,
        pfaCount: data.length,
      };
      if (hasContributions) {
        summary.totalContributionThisMonth = data.reduce(
          (s, r) => s + parseFloat(r.total_contribution_this_month || 0),
          0,
        );
        summary.totalContributionPaidTodate = data.reduce(
          (s, r) => s + parseFloat(r.total_contribution_paid_todate || 0),
          0,
        );
      }
      return summary;
    } else {
      const totalNet = data.reduce((s, r) => s + parseFloat(r.net_pay || 0), 0);
      const summary = {
        totalEmployees: data.length,
        totalNetPay: totalNet,
        averageNetPay: totalNet / data.length,
        pfaCount: [...new Set(data.map((r) => r.pfa_code))].length,
      };
      if (hasContributions) {
        summary.totalContributionThisMonth = data.reduce(
          (s, r) => s + parseFloat(r.contribution_this_month || 0),
          0,
        );
        summary.totalContributionPaidTodate = data.reduce(
          (s, r) => s + parseFloat(r.contribution_paid_todate || 0),
          0,
        );
      }
      return summary;
    }
  }

  // ==========================================================================
  // EXCEL
  // ==========================================================================
  async generateNSITFReportExcel(data, req, res, isSummary = false) {
    try {
      if (!data || data.length === 0) throw new Error('No NSITF contribution this month');
 
      const exporter  = new GenericExcelExporter();
      const period    = data.length > 0
        ? { year: data[0].year, month: data[0].month }
        : { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
      const className = await this.getDatabaseNameFromRequest(req);
 
      const hasContributions = data[0].hasOwnProperty('contribution_this_month')
                            || data[0].hasOwnProperty('total_contribution_this_month');
 
      if (isSummary) {
        const columns = [
          { header: 'S/N',            key: 'sn',             width: 8,  align: 'center' },
          { header: 'PFA Code',        key: 'pfa_code',       width: 15 },
          { header: 'PFA Name',        key: 'pfa_name',       width: 35 },
          { header: 'Record',          key: 'employee_count', width: 18, align: 'center' },
          { header: 'Total Net Pay',   key: 'total_net_pay',  width: 20, align: 'right', numFmt: '₦#,##0.00' },
          { header: 'Average Net Pay', key: 'avg_net_pay',    width: 20, align: 'right', numFmt: '₦#,##0.00' },
          { header: 'Min Net Pay',     key: 'min_net_pay',    width: 18, align: 'right', numFmt: '₦#,##0.00' },
          { header: 'Max Net Pay',     key: 'max_net_pay',    width: 18, align: 'right', numFmt: '₦#,##0.00' },
        ];
        if (hasContributions) {
          columns.push(
            { header: 'Contribution This Month',  key: 'total_contribution_this_month',  width: 24, align: 'right', numFmt: '₦#,##0.00' },
            { header: 'Contribution Paid To Date', key: 'total_contribution_paid_todate', width: 24, align: 'right', numFmt: '₦#,##0.00' }
          );
        }
 
        const dataWithSN     = data.map((item, idx) => ({ ...item, sn: idx + 1 }));
        const totalEmployees = data.reduce((s, i) => s + parseInt(i.employee_count || 0), 0);
        const totalNetPay    = data.reduce((s, i) => s + parseFloat(i.total_net_pay || 0), 0);
        const totalsValues   = { 4: totalEmployees, 5: totalNetPay };
        if (hasContributions) {
          totalsValues[columns.length - 1] = data.reduce((s, i) => s + parseFloat(i.total_contribution_this_month  || 0), 0);
          totalsValues[columns.length]     = data.reduce((s, i) => s + parseFloat(i.total_contribution_paid_todate || 0), 0);
        }
 
        let subtitle = 'NSITF Summary Report';
        if (data.length > 0) subtitle += ` - ${this.getMonthName(data[0].month)} ${data[0].year}`;
 
        const workbook = await exporter.createWorkbook({
          title: 'NIGERIAN NAVY - NSITF REPORT', subtitle, className,
          columns, data: dataWithSN,
          totals:    { label: 'GRAND TOTALS:', values: totalsValues },
          sheetName: 'NSITF Summary',
        });
 
        await exporter.exportToResponse(workbook, res, 'nsitf_report_summary.xlsx');
 
      } else {
        // Detailed — one sheet per PFA
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Payroll System';
        workbook.created = new Date();
 
        const sheetNameTracker = {};
        const periodStr        = `${this.getMonthName(period.month)} ${period.year}`;
 
        const columns = [
          { header: 'S/N',            key: 'sn',             width: 8,  align: 'center' },
          { header: 'Svc No.',        key: 'employee_id',    width: 15 },
          { header: 'Rank',           key: 'Title',          width: 12 },
          { header: 'Full Name',      key: 'full_name',      width: 35 },
          { header: 'Date Employed',  key: 'date_employed',  width: 15 },
          { header: 'NSITF Code',     key: 'nsitf_code',     width: 15 },
          { header: 'Grade Type',     key: 'grade_type',     width: 12 },
          { header: 'Grade Level',    key: 'grade_level',    width: 12 },
          { header: 'Years in Level', key: 'years_in_level', width: 15, align: 'center' },
          { header: 'Net Pay',        key: 'net_pay',        width: 18, align: 'right', numFmt: '₦#,##0.00' },
        ];
        if (hasContributions) {
          columns.push(
            { header: 'This Month',   key: 'contribution_this_month',  width: 18, align: 'right', numFmt: '₦#,##0.00' },
            { header: 'Paid To Date', key: 'contribution_paid_todate', width: 18, align: 'right', numFmt: '₦#,##0.00' }
          );
        }
 
        // Group by PFA in JS
        const pfaGroups = new Map();
        for (const row of data) {
          const key = `${row.pfa_code || 'Unknown'}_${row.pfa_name || 'Unknown'}`;
          if (!pfaGroups.has(key)) {
            pfaGroups.set(key, { pfa_code: row.pfa_code || 'Unknown', pfa_name: row.pfa_name || 'Unknown', employees: [] });
          }
          pfaGroups.get(key).employees.push(row);
        }
 
        let globalSN = 1;
 
        for (const pfaGroup of pfaGroups.values()) {
          const sheetName = this._getUniqueSheetName(`${pfaGroup.pfa_code}-${pfaGroup.pfa_name}`, sheetNameTracker);
          const worksheet = workbook.addWorksheet(sheetName);
 
          columns.forEach((col, idx) => { worksheet.getColumn(idx + 1).width = col.width || 15; });
 
          let row = 1;
 
          // Headers
          const addMergedRow = (value, font) => {
            worksheet.mergeCells(row, 1, row, columns.length);
            Object.assign(worksheet.getCell(row, 1), { value, font, alignment: { horizontal: 'center', vertical: 'middle' } });
            row++;
          };
 
          addMergedRow(exporter.config.company.name,              { size: 14, bold: true, color: { argb: exporter.config.colors.primary } });
          addMergedRow('NIGERIAN NAVY - NSITF REPORT',            { size: 12, bold: true });
          addMergedRow(`Class: ${className} | Period: ${periodStr}`, { size: 10, italic: true });
 
          // PFA group header
          worksheet.mergeCells(row, 1, row, columns.length);
          Object.assign(worksheet.getCell(row, 1), {
            value: `PFA Code: ${pfaGroup.pfa_code} | PFA Name: ${pfaGroup.pfa_name} | Employees: ${pfaGroup.employees.length}`,
            font:  { bold: true, size: 11, color: { argb: exporter.config.colors.primary } },
            fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E8E8E8' } },
            alignment: { horizontal: 'left', vertical: 'middle' },
          });
          row++;
          row++; // empty
 
          // Column header row (frozen)
          const headerRowNum = row;
          const headerRow    = worksheet.getRow(headerRowNum);
          columns.forEach((col, idx) => {
            const cell = headerRow.getCell(idx + 1);
            cell.value     = col.header;
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: exporter.config.colors.headerBg } };
            cell.font      = { bold: true, color: { argb: exporter.config.colors.primary }, size: 10 };
            cell.alignment = { horizontal: col.align || 'left', vertical: 'middle' };
            cell.border    = { top: { style: 'thin', color: { argb: 'd1d5db' } }, bottom: { style: 'thin', color: { argb: 'd1d5db' } }, left: { style: 'thin', color: { argb: 'd1d5db' } }, right: { style: 'thin', color: { argb: 'd1d5db' } } };
          });
          headerRow.height = 22;
          row++;
 
          // Freeze columns A+B (S/N, Svc No.) and all rows up to the header
          worksheet.views = [{
            state:       'frozen',
            xSplit:      2,
            ySplit:      headerRowNum,
            topLeftCell: `C${headerRowNum + 1}`,
            activeCell:  `C${headerRowNum + 1}`,
          }];
 
          // Data rows
          pfaGroup.employees.forEach((emp, empIdx) => {
            const dataRow = worksheet.getRow(row);
            const cells   = [
              globalSN++, emp.employee_id, emp.Title, emp.full_name,
              emp.date_employed, emp.nsitf_code, emp.grade_type,
              emp.grade_level, emp.years_in_level,
              parseFloat(emp.net_pay || 0),
            ];
            if (hasContributions) {
              cells.push(parseFloat(emp.contribution_this_month  || 0));
              cells.push(parseFloat(emp.contribution_paid_todate || 0));
            }
 
            cells.forEach((val, i) => {
              const cell = dataRow.getCell(i + 1);
              cell.value = val;
              if (columns[i].numFmt)   cell.numFmt   = columns[i].numFmt;
              if (columns[i].align)    cell.alignment = { horizontal: columns[i].align, vertical: 'middle' };
              cell.border = { top: { style: 'thin', color: { argb: 'E5E7EB' } }, bottom: { style: 'thin', color: { argb: 'E5E7EB' } } };
              if (empIdx % 2 === 0)    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: exporter.config.colors.altRow } };
            });
 
            dataRow.height = 18;
            row++;
          });
 
          // Hide Net Pay column AFTER data is written — setting hidden before
          // writing causes ExcelJS to corrupt cell values in that column
          worksheet.getColumn(10).hidden = true;
        }
 
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=nsitf_report_detailed.xlsx');
        await workbook.xlsx.write(res);
        res.end();
      }
 
    } catch (error) {
      console.error('NSITF Report Export error:', error);
      if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // PDF (unchanged except passes hasContributions flag to template)
  // ==========================================================================
  async generateNSITFReportPDF(data, req, res) {
    try {
      if (!data || data.length === 0)
        throw new Error("No NSITF contribution this month");

      const isSummary = !data[0].hasOwnProperty("employee_id");
      const summary = this.calculateSummary(data, isSummary);
      const image = await companySettings.getSettingsFromFile(
        "./public/photos/logo.png",
      );
      const templatePath = path.join(
        __dirname,
        "../../templates/nsitf-report.html",
      );

      const pdfBuffer = await this.generatePDFWithFallback(
        templatePath,
        {
          data,
          summary,
          reportDate: new Date(),
          period:
            data.length > 0
              ? `${this.getMonthName(data[0].month)} ${data[0].year}`
              : "N/A",
          className: await this.getDatabaseNameFromRequest(req),
          isSummary,
          hasContributions:
            data[0].hasOwnProperty("contribution_this_month") ||
            data[0].hasOwnProperty("total_contribution_this_month"),
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

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=nsitf_report_${data[0]?.month || "report"}_${data[0]?.year || "report"}.pdf`,
      );
      res.send(pdfBuffer);
    } catch (error) {
      console.error("NSITF Report PDF generation error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // FILTER OPTIONS — now includes payment codes for the element selector
  // ==========================================================================
  async getNSITFFilterOptions(req, res) {
    try {
      const [pfas, paymentCodes, currentPeriod] = await Promise.all([
        nsitfReportService.getAvailablePFAs(),
        nsitfReportService.getNSITFPaymentCodes(),
        nsitfReportService.getCurrentPeriod(),
      ]);
      res.json({ success: true, data: { pfas, paymentCodes, currentPeriod } });
    } catch (error) {
      console.error("Error getting NSITF filter options:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================
  getMonthName(month) {
    return (
      [
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
      ][month - 1] || ""
    );
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

module.exports = new NSITFReportController();