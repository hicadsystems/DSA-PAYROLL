// ============================================================================
// FILE: services/Reports/payrollRegisterService.js
// Data layer for Payroll Register — called by PayrollRegisterController
// ============================================================================
const pool = require("../../config/db");

class PayrollRegisterService {
  // ==========================================================================
  // MAIN: Call SP then fetch shaped data
  //
  // reportType: 'both' | 'earnings' | 'deductions'
  //   - SP always generates the full dataset into py_webpayregister
  //   - reportType filter is applied HERE at fetch time, not in the SP
  //   - This means switching reportType never requires re-running the SP
  // ==========================================================================
  async generatePayrollRegister(params) {
    const {
      empnoFrom,
      empnoTo,
      period,
      payrollClass,
      username,
      printRange,
      useIppis,
      reportType,
    } = params;

    const p_empnumber = empnoFrom || "";
    const p_lastno = empnoTo || "";
    const p_payrollclass = payrollClass || "";
    const p_printind = printRange ? "1" : "0";
    const p_useippis = useIppis || "N";

    // ── 1. Run the stored procedure ─────────────────────────────────────────
    const [results] = await pool.query(
      "CALL py_generate_payregister(?, ?, ?, ?, ?, ?, ?)",
      [
        p_empnumber,
        p_lastno,
        period,
        p_payrollclass,
        username,
        p_printind,
        p_useippis,
      ],
    );

    const summary = results[0][0];

    // ── 2. Resolve bpc WHERE clause from reportType ─────────────────────────
    //    earnings   → BP / BT / PT
    //    deductions → PR
    //    both       → no filter (default)
    const bpcFilter = this._bpcFilter(reportType);

    // ── 3. Fetch column definitions (filtered to match reportType) ───────────
    const [colRows] = await pool.query(
      `SELECT his_type, description, bpc, bpa, col_order
       FROM py_webpayregister_cols
       WHERE work_station = ? AND period = ? AND payclass = ?
       ${bpcFilter}
       ORDER BY col_order`,
      [username, period, p_payrollclass],
    );

    // ── 4. Fetch raw data rows (same filter) ─────────────────────────────────
    const [rawRows] = await pool.query(
      `SELECT *
       FROM py_webpayregister
       WHERE work_station = ? AND period = ? AND payclass = ?
       ${bpcFilter}
       ORDER BY serviceno, col_order`,
      [username, period, p_payrollclass],
    );

    return { summary, colRows, rawRows };
  }

  // ==========================================================================
  // MAP: Shape raw DB rows into per-employee objects
  //
  // Returns:
  //   {
  //     columns:   { earningCols, deductionCols, allCols }
  //     employees: [ { serviceno, title, fullname, ..., earnings[], deductions[], totals } ]
  //   }
  // ==========================================================================
  mapData(rawRows, colRows, period, useIppis, className, reportType) {
    const earningCols = colRows.filter((c) =>
      ["BP", "BT", "PT"].includes(c.bpc),
    );
    const deductionCols = colRows.filter((c) => c.bpc === "PR");

    // Determine which summary columns the report should show
    const mode = (reportType || "both").toLowerCase();
    const showEarningsTotal = mode === "both" || mode === "earnings";
    const showDeductionsTotal = mode === "both" || mode === "deductions";
    const showNetPay = mode === "both";

    const empMap = new Map();

    rawRows.forEach((row) => {
      const key = row.serviceno;

      if (!empMap.has(key)) {
        empMap.set(key, {
          serviceno: row.serviceno,
          title: row.title,
          fullname: row.fullname,
          gradelevel: row.gradelevel,
          deptname: row.deptname,
          factname: row.factname,
          payclass: row.payclass,
          payclass_name: className || row.payclass,
          period,
          useIppis,
          earnings: [],
          deductions: [],
          totals: {
            totalEarnings: 0,
            totalDeductions: 0,
            netPay: null, // null = not applicable for this reportType
          },
        });
      }

      const emp = empMap.get(key);
      const amount = parseFloat(row.amount) || 0;

      const entry = {
        his_type: row.his_type,
        description: row.description,
        bpc: row.bpc,
        bpa: row.bpa,
        source: row.source,
        col_order: row.col_order,
        amount,
      };

      if (["BP", "BT", "PT"].includes(row.bpc)) {
        emp.earnings.push(entry);
        emp.totals.totalEarnings += amount;
      } else if (row.bpc === "PR") {
        emp.deductions.push(entry);
        emp.totals.totalDeductions += amount;
      }

      // Only compute netPay when both sides are present
      if (showNetPay) {
        emp.totals.netPay =
          emp.totals.totalEarnings - emp.totals.totalDeductions;
      }
    });

    return {
      columns: {
        earningCols,
        deductionCols,
        allCols: colRows,
      },
      // Flags the controller/template uses to decide which summary columns to render
      reportMeta: {
        reportType: mode,
        showEarningsTotal,
        showDeductionsTotal,
        showNetPay,
      },
      employees: Array.from(empMap.values()),
    };
  }

  // ==========================================================================
  // HELPER: Build report-ready column header list
  //
  // useCodeHeader = true  → label = his_type      e.g. "BP01"
  // useCodeHeader = false → label = description   e.g. "BASIC PAY"
  //
  // Returns { earningHeaders[], deductionHeaders[] }
  // each entry: { label, his_type, description, bpc, bpa, col_order }
  // ==========================================================================
  buildColumnHeaders(
    colRows,
    useCodeHeader = false,
    rawRows = [],
    reportType = "both",
  ) {
    const mode = (reportType || "both").toLowerCase();

    const sourceMap = {};
    rawRows.forEach((row) => {
      if (row.his_type && row.source) {
        sourceMap[row.his_type] = row.source;
      }
    });

    const toHeader = (col) => ({
      label: useCodeHeader ? col.his_type : col.description || col.his_type,
      his_type: col.his_type,
      description: col.description,
      bpc: col.bpc,
      bpa: col.bpa,
      col_order: col.col_order,
      source: sourceMap[col.his_type] || "NAVY",
    });

    return {
      earningHeaders:
        mode === "deductions"
          ? []
          : colRows
              .filter((c) => ["BP", "BT", "PT"].includes(c.bpc))
              .map(toHeader),
      deductionHeaders:
        mode === "earnings"
          ? []
          : colRows.filter((c) => c.bpc === "PR").map(toHeader),
    };
  }

  // ==========================================================================
  // HELPER: Pivot one employee's entries into a flat { his_type: amount } map
  //
  // Used by the Excel exporter for O(1) cell lookups per column:
  //   const amtMap = service.buildAmountMap(emp);
  //   const val    = amtMap['BP01'] ?? 0;
  // ==========================================================================
  buildAmountMap(employee) {
    const map = {};
    [...employee.earnings, ...employee.deductions].forEach((entry) => {
      map[entry.his_type] = entry.amount;
    });
    return map;
  }

  // ==========================================================================
  // PRIVATE: Resolve SQL WHERE fragment for bpc from reportType param
  // ==========================================================================
  _bpcFilter(reportType) {
    switch ((reportType || "both").toLowerCase()) {
      case "earnings":
        return `AND bpc IN ('BP', 'BT', 'PT')`;
      case "deductions":
        return `AND bpc = 'PR'`;
      default:
        return ""; // 'both' — no filter
    }
  }
}

module.exports = new PayrollRegisterService();
