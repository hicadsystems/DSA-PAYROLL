// ============================================================================
// FILE: services/Reports/salaryHistoryService.js
// Data layer for salary history — called by SalaryHistoryController
// ============================================================================
const pool = require('../../config/db');

class SalaryHistoryService {

  // ==========================================================================
  // MAIN: Call SP and return shaped data
  // ==========================================================================
  async generateSalaryHistory(params) {
    const {
      empnoFrom,
      empnoTo,
      fromPeriod,
      toPeriod,
      payrollClass,
      username,
      printRange,
      useIppis
    } = params;

    const p_empnumber    = empnoFrom    || '';
    const p_lastno       = empnoTo      || '';
    const p_payrollclass = payrollClass || '';
    const p_printind     = printRange   ? '1' : '0';
    const p_useippis     = useIppis     || 'N';

    // Call stored procedure
    const [results] = await pool.query(
      'CALL py_generate_salary_history(?, ?, ?, ?, ?, ?, ?, ?)',
      [p_empnumber, p_lastno, fromPeriod, toPeriod, p_payrollclass, username, p_printind, p_useippis]
    );

    const summary = results[0][0];

    // Fetch raw rows from output table
    const [rawRows] = await pool.query(
      `SELECT * FROM py_websalaryhistory
       WHERE work_station = ? AND fromperiod = ? AND toperiod = ?
       ORDER BY numb, bpc, his_type`,
      [username, fromPeriod, toPeriod]
    );

    return { summary, rawRows };
  }

  // ==========================================================================
  // MAP: Shape raw DB rows into per-employee frontend objects
  // ==========================================================================
  mapData(rawRows, fromPeriod, toPeriod, numPeriods, useIppis, className) {
    // Build ordered period list
    const periods = [];
    let yr = parseInt(fromPeriod.substring(0, 4));
    let mo = parseInt(fromPeriod.substring(4, 6));
    for (let i = 0; i < numPeriods; i++) {
      periods.push(String(yr) + String(mo).padStart(2, '0'));
      mo++;
      if (mo > 12) { mo = 1; yr++; }
    }

    const empMap = new Map();

    rawRows.forEach(row => {
      if (!empMap.has(row.numb)) {
        empMap.set(row.numb, {
          numb:          row.numb,
          surname:       row.surname,
          othername:     row.othername,
          payclass:      row.payclass,
          payclass_name: className || row.payclass,
          fromPeriod,
          toPeriod,
          periods,
          useIppis,
          rows: []
        });
      }

      // Align amounts to periods array
      const amounts = periods.map((_, idx) => parseFloat(row[`amt${idx + 1}`]) || 0);

      empMap.get(row.numb).rows.push({
        his_type:    row.his_type,
        description: row.description,
        bpc:         row.bpc,
        bpa:         row.bpa,
        source:      row.source,
        amounts
      });
    });

    return Array.from(empMap.values());
  }
}

module.exports = new SalaryHistoryService();