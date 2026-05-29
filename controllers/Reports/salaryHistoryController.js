// ============================================================================
// FILE: controllers/Reports/salaryHistoryController.js
// Follows same pattern as ConsolidatedPayslipController
// Data logic lives in salaryHistoryService — this handles HTTP only
// ============================================================================
const BaseReportController  = require('../Reports/reportsFallbackController');
const salaryHistorySvc      = require('../../services/Reports/salaryHistoryService');
const pool = require('../../config/db');
const fs   = require('fs');
const path = require('path');

class SalaryHistoryController extends BaseReportController {

  constructor() {
    super();
    this._registerSalaryHistoryHelpers();
  }

  // Register custom helpers needed by salary-history.html template
  // into Handlebars so the Chromium fallback path can compile them
  _registerSalaryHistoryHelpers() {
    const Handlebars = require('handlebars');

    Handlebars.registerHelper('periodLabel', function(p) {
      if (!p || p.length < 6) return p || '';
      const M = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return (M[parseInt(p.substring(4,6))] || '???') + ' ' + p.substring(0,4);
    });

    Handlebars.registerHelper('amtAt', function(amounts, idx) {
      const v = parseFloat((amounts || [])[idx]) || 0;
      return v === 0 ? '' : v.toLocaleString('en-NG', { minimumFractionDigits:2, maximumFractionDigits:2 });
    });

    Handlebars.registerHelper('colSum', function(rows, idx) {
      const total = (rows || []).reduce(function(s, r) {
        return s + (parseFloat((r.amounts || [])[idx]) || 0);
      }, 0);
      return total;
    });

    Handlebars.registerHelper('netAt', function(earnings, deductions, idx) {
      const e = (earnings   || []).reduce(function(s,r){ return s+(parseFloat((r.amounts||[])[idx])||0); },0);
      const d = (deductions || []).reduce(function(s,r){ return s+(parseFloat((r.amounts||[])[idx])||0); },0);
      return e - d;
    });

    Handlebars.registerHelper('filterByBpc', function(rows, bpcList, source) {
      return (rows || []).filter(function(r) {
        return bpcList.indexOf(r.bpc) !== -1 && (!source || r.source === source);
      });
    });

    // Helper to create inline arrays in templates: (array "IPPIS" "NAVY")
    Handlebars.registerHelper('array', function() {
      return Array.prototype.slice.call(arguments, 0, arguments.length - 1);
    });

    Handlebars.registerHelper('formatTime', function(date) {
      return new Date(date).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    });
  }

  // ==========================================================================
  // GENERATE — POST /salary-history/generate
  // ==========================================================================
  async generateSalaryHistory(req, res) {
    const {
      empnoFrom, empnoTo,
      fromPeriod, toPeriod,
      payrollClass, printRange, useIppis
    } = req.body;

    const username = req.user_fullname || req.user_id;

    if (!username) {
      return res.status(401).json({ success: false, error: 'User authentication required. Please log in again.' });
    }
    if (!fromPeriod || !toPeriod || !payrollClass) {
      return res.status(400).json({ success: false, error: 'From period, To period and payroll class are required.' });
    }

    const fromYr = parseInt(fromPeriod.substring(0, 4));
    const fromMo = parseInt(fromPeriod.substring(4, 6));
    const toYr   = parseInt(toPeriod.substring(0, 4));
    const toMo   = parseInt(toPeriod.substring(4, 6));

    if (isNaN(fromYr) || isNaN(fromMo) || fromMo < 1 || fromMo > 12 ||
        isNaN(toYr)   || isNaN(toMo)   || toMo   < 1 || toMo   > 12) {
      return res.status(400).json({ success: false, error: 'Invalid period format. Expected YYYYMM (e.g., 202501).' });
    }

    const months = (toYr - fromYr) * 12 + (toMo - fromMo) + 1;
    if (months < 1)  return res.status(400).json({ success: false, error: 'To period must be after or equal to From period.' });
    if (months > 12) return res.status(400).json({ success: false, error: 'Date range cannot exceed 12 months.' });

    console.log('=== SALARY HISTORY PARAMETERS ===');
    console.log('empnoFrom:   ', empnoFrom);
    console.log('empnoTo:     ', empnoTo);
    console.log('fromPeriod:  ', fromPeriod);
    console.log('toPeriod:    ', toPeriod);
    console.log('payrollClass:', payrollClass);
    console.log('username:    ', username);
    console.log('printRange:  ', printRange);
    console.log('useIppis:    ', useIppis);
    console.log('=================================');

    try {
      const { summary, rawRows } = await salaryHistorySvc.generateSalaryHistory({
        empnoFrom, empnoTo, fromPeriod, toPeriod,
        payrollClass, username,
        printRange: !!printRange,
        useIppis: useIppis || 'N'
      });

      console.log('Salary history SP summary:', summary);
      console.log('Raw rows fetched:', rawRows.length);

      if (!rawRows || rawRows.length === 0) {
        return res.json({ success: false, error: 'No salary history data found for the selected criteria.' });
      }

      const className  = await this.getDatabaseNameFromRequest(req);
      const mappedData = salaryHistorySvc.mapData(
        rawRows, fromPeriod, toPeriod, months, useIppis === 'Y', className
      );

      console.log('Mapped employees:', mappedData.length);

      return res.json({
        success: true,
        message: `Salary history generated for ${mappedData.length} employee(s)`,
        data: mappedData,
        summary: {
          totalEmployees:   summary.total_employees,
          totalRecords:     summary.total_records,
          periodsProcessed: summary.periods_processed,
          fromPeriod:       summary.from_period,
          toPeriod:         summary.to_period
        }
      });

    } catch (error) {
      console.error('Salary history generate error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // EXPORT PDF — POST /salary-history/export/pdf
  // ==========================================================================
  async generateSalaryHistoryPDF(req, res) {
    const mappedData = req.body.data || [];

    if (mappedData.length === 0) {
      return res.status(404).json({ success: false, error: 'No salary history data provided for PDF generation.' });
    }

    try {
      const templatePath = path.join(__dirname, '../../templates/salary-history.html');

      const logoPath = './public/photos/logo.png';
      let logoDataUrl = '';
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        logoDataUrl = `data:image/png;base64,${logoBuffer.toString('base64')}`;
      }

      const className = await this.getDatabaseNameFromRequest(req);

      console.log(`📄 Generating salary history PDF for ${mappedData.length} employee(s)`);

      const pdfBuffer = await this.generateBatchedPDF(
        templatePath,
        mappedData,
        100,
        {
          format:    'A4',
          landscape: true,
          timeout:   120000,
          helpers:   this._getCommonHelpers() + this._getSalaryHistoryHelpers(),
          options: { timeout: 120000, reportTimeout: 120000 }
        },
        {
          reportDate:  new Date(),
          logoDataUrl: logoDataUrl,
          className:   className
        }
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=salary_history.pdf');
      res.send(pdfBuffer);

    } catch (error) {
      console.error('Salary history PDF error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // EXPORT EXCEL — POST /salary-history/export/excel
  // ==========================================================================
  async generateSalaryHistoryExcel(req, res) {
    const mappedData = req.body.data || [];

    if (mappedData.length === 0) {
      return res.status(404).json({ success: false, error: 'No salary history data provided for Excel generation.' });
    }

    try {
      const ExcelJS  = require('exceljs');
      const workbook = new ExcelJS.Workbook();

      mappedData.forEach(emp => {
        const sheetName = `${emp.numb}`.replace(/[/\\?*[\]]/g, '_').substring(0, 31);
        const ws = workbook.addWorksheet(sheetName, {
          pageSetup: { orientation: 'landscape', paperSize: 9 }
        });

        const periods  = emp.periods  || [];
        const rows     = emp.rows     || [];
        const useIppis = !!emp.useIppis;
        const n        = periods.length;

        // Title block
        ws.mergeCells(1, 1, 1, n + 1);
        Object.assign(ws.getCell('A1'), {
          value: 'Nigerian Navy (Naval Headquarters) — CENTRAL PAY OFFICE',
          font:  { bold: true, size: 12, color: { argb: 'FF1E40AF' } },
          alignment: { horizontal: 'center' }
        });

        ws.mergeCells(2, 1, 2, n + 1);
        Object.assign(ws.getCell('A2'), {
          value: `Salary History — ${emp.numb}  ${emp.surname} ${emp.othername} — ${emp.payclass_name}`,
          font:  { bold: true, size: 10 },
          alignment: { horizontal: 'center' }
        });

        ws.mergeCells(3, 1, 3, n + 1);
        Object.assign(ws.getCell('A3'), {
          value: `Period: ${this._periodLabel(emp.fromPeriod)} — ${this._periodLabel(emp.toPeriod)}`,
          font:  { size: 9, color: { argb: 'FF4A4A4A' } },
          alignment: { horizontal: 'center' }
        });

        // Column headers — row 4 (rows 1-3 are title block)
        const hdr = ws.addRow(['Description', ...periods.map(p => this._periodLabel(p))]);
        hdr.eachCell(cell => {
          cell.font      = { bold: true, color: { argb: 'FF1E40AF' } };
          cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
          cell.alignment = { horizontal: cell.col === 1 ? 'left' : 'right' };
          cell.border    = {
            top:    { style: 'thin', color: { argb: 'FF93C5FD' } },
            bottom: { style: 'medium', color: { argb: 'FF0056A0' } },
            left:   { style: 'thin', color: { argb: 'FF93C5FD' } },
            right:  { style: 'thin', color: { argb: 'FF93C5FD' } }
          };
        });
        ws.getColumn(1).width = 35;
        for (let i = 2; i <= n + 1; i++) ws.getColumn(i).width = 16;

        // Freeze: row 4 (header row) + column A (description)
        ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4, activeCell: 'B5' }];

        // Helpers
        const fmtNum    = v => parseFloat(v) || 0;
        const colTotals = subset => {
          const s = new Array(n).fill(0);
          subset.forEach(r => (r.amounts || []).forEach((a, i) => { s[i] += fmtNum(a); }));
          return s;
        };
        const addLabel  = (label, bg = 'FFE8F0FE', fg = 'FF1E40AF') => {
          const r = ws.addRow([label, ...new Array(n).fill('')]);
          r.eachCell(c => {
            c.font = { bold: true, color: { argb: fg } };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
          });
          ws.mergeCells(r.number, 1, r.number, n + 1);
        };
        const cellBorder = {
          top:   { style: 'thin', color: { argb: 'FFC8D4E8' } },
          bottom:{ style: 'thin', color: { argb: 'FFC8D4E8' } },
          left:  { style: 'thin', color: { argb: 'FFC8D4E8' } },
          right: { style: 'thin', color: { argb: 'FFC8D4E8' } }
        };

        const addData   = (desc, amounts) => {
          const r = ws.addRow([desc, ...amounts.map(fmtNum)]);
          r.getCell(1).font   = { color: { argb: 'FF4A4A4A' } };
          r.getCell(1).border = cellBorder;
          for (let i = 2; i <= n + 1; i++) {
            r.getCell(i).numFmt    = '#,##0.00';
            r.getCell(i).alignment = { horizontal: 'right' };
            r.getCell(i).border    = cellBorder;
          }
        };
        const addTotal  = (label, sums) => {
          const r = ws.addRow([label, ...sums.map(fmtNum)]);
          r.eachCell(c => {
            c.font   = { bold: true };
            c.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
            c.border = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
          });
          for (let i = 2; i <= n + 1; i++) {
            r.getCell(i).numFmt    = '#,##0.00';
            r.getCell(i).alignment = { horizontal: 'right' };
          }
        };
        const addNet    = (label, sums) => {
          const r = ws.addRow([label, ...sums.map(fmtNum)]);
          r.eachCell(c => {
            c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
          });
          for (let i = 2; i <= n + 1; i++) {
            r.getCell(i).numFmt    = '#,##0.00';
            r.getCell(i).alignment = { horizontal: 'right' };
          }
        };

        if (!useIppis) {
          const earnings   = rows.filter(r => ['BP','PT'].includes(r.bpc));
          const deductions = rows.filter(r => ['PR','OT'].includes(r.bpc));
          const emolTotals = colTotals(earnings);
          const dedTotals  = colTotals(deductions);
          const netTotals  = emolTotals.map((v, i) => v - dedTotals[i]);

          addLabel('EARNINGS');
          earnings.forEach(r => addData(r.description, r.amounts));
          addTotal('Total Emolument', emolTotals);
          addLabel('DEDUCTIONS');
          deductions.forEach(r => addData(r.description, r.amounts));
          addTotal('Total Deduction', dedTotals);
          addNet('NET', netTotals);

        } else {
          // ── IPPIS block: Taxable + Deductions ──
          const ippisTaxable    = rows.filter(r => r.source === 'IPPIS' && r.bpc === 'BP');
          const ippisDeductions = rows.filter(r => r.source === 'IPPIS' && ['PR','OT'].includes(r.bpc));
          const ippisTaxTotals  = colTotals(ippisTaxable);
          const ippisDedTotals  = colTotals(ippisDeductions);
          const ippisNet        = ippisTaxTotals.map((v, i) => v - ippisDedTotals[i]);

          addLabel('IPPIS', 'FFFEF3C7', 'FF92400E');
          if (ippisTaxable.length) {
            addLabel('Taxable Payment');
            ippisTaxable.forEach(r => addData(r.description, r.amounts));
            addTotal('Total Taxable Payment', ippisTaxTotals);
          }
          if (ippisDeductions.length) {
            addLabel('Deductions');
            ippisDeductions.forEach(r => addData(r.description, r.amounts));
          }
          addTotal('IPPIS Total', ippisNet);

          // ── NAVY block: Non-Taxable + Deductions ──
          const navyNonTaxable  = rows.filter(r => r.source === 'NAVY' && r.bpc === 'PT');
          const navyDeductions  = rows.filter(r => r.source === 'NAVY' && ['PR','OT'].includes(r.bpc));
          const navyNTTotals    = colTotals(navyNonTaxable);
          const navyDedTotals   = colTotals(navyDeductions);
          const navyNet         = navyNTTotals.map((v, i) => v - navyDedTotals[i]);

          addLabel('NAVY', 'FFFEF3C7', 'FF92400E');
          if (navyNonTaxable.length) {
            addLabel('Non-Taxable Payment');
            navyNonTaxable.forEach(r => addData(r.description, r.amounts));
          }
          if (navyDeductions.length) {
            addLabel('Deductions');
            navyDeductions.forEach(r => addData(r.description, r.amounts));
          }
          addTotal('NAVY Total', navyNet);

          // ── Grand NET ──
          const allEarnings   = rows.filter(r => ['BP','PT'].includes(r.bpc));
          const allDeductions = rows.filter(r => ['PR','OT'].includes(r.bpc));
          const grandNet      = colTotals(allEarnings).map((v, i) => v - colTotals(allDeductions)[i]);
          addNet('NET(IPPIS + NAVY)', grandNet);
        }
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=salary_history.xlsx');
      await workbook.xlsx.write(res);
      res.end();

    } catch (error) {
      console.error('Salary history Excel error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==========================================================================
  // PRIVATE: PERIOD LABEL  202501 → 'Jan 2025'
  // ==========================================================================
  _periodLabel(p) {
    if (!p || p.length < 6) return p || '';
    const M = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return (M[parseInt(p.substring(4, 6))] || '???') + ' ' + p.substring(0, 4);
  }

  // ==========================================================================
  // PRIVATE: HANDLEBARS HELPERS FOR TEMPLATE
  // ==========================================================================
  _getSalaryHistoryHelpers() {
    return `
      function formatCurrency(value) {
        if (!value && value !== 0) return '';
        const v = parseFloat(value);
        return v === 0 ? '' : v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      function formatDate(date) {
        const d = new Date(date);
        const m = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        return d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
      }
      function formatTime(date) {
        return new Date(date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      function periodLabel(p) {
        if (!p || p.length < 6) return p || '';
        const m = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return (m[parseInt(p.substring(4,6))] || '???') + ' ' + p.substring(0,4);
      }
      function amtAt(amounts, idx) {
        const v = parseFloat((amounts || [])[idx]) || 0;
        return v === 0 ? '' : v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      function colSum(rows, idx) {
        return (rows || []).reduce(function(s, r) { return s + (parseFloat((r.amounts||[])[idx])||0); }, 0);
      }
      function netAt(earnings, deductions, idx) {
        const e = (earnings   || []).reduce(function(s,r){ return s+(parseFloat((r.amounts||[])[idx])||0); },0);
        const d = (deductions || []).reduce(function(s,r){ return s+(parseFloat((r.amounts||[])[idx])||0); },0);
        return e - d;
      }
      function filterByBpc(rows, bpcList, source) {
        return (rows || []).filter(function(r) {
          return bpcList.indexOf(r.bpc) !== -1 && (!source || r.source === source);
        });
      }
      function add(a, b) { return (parseInt(a)||0) + (parseInt(b)||0); }
      function eq(a, b)  { return a === b; }
      function gt(a, b)  { return parseFloat(a) > parseFloat(b); }
    `;
  }

  // ==========================================================================
  // GET CLASS NAME (same pattern as consolidated controller)
  // ==========================================================================
  async getDatabaseNameFromRequest(req) {
    const currentDb = req.current_class;
    if (!currentDb) return 'OFFICERS';
    const [classInfo] = await pool.query(
      'SELECT classname FROM py_payrollclass WHERE db_name = ?',
      [currentDb]
    );
    return classInfo.length > 0 ? classInfo[0].classname : currentDb;
  }
}

module.exports = SalaryHistoryController;