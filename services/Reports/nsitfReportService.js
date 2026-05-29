// ============================================================================
// services/Reports/nsitfReportService.js
//   1. Same CROSS JOIN fix as NHF/reportServices — period resolved once via
//      _getPeriod(), scalar values used in query instead of cross join.
//
//   2. Batching loop removed — single query replaces COUNT + N paginated SELECTs.
//
//   3. NEW: accepts paymentCodes[] from frontend (same format as earnings
//      analysis elements). For each employee, aggregates amtthismth and
//      totpaidtodate from py_masterpayded for those specific codes.
//
//   4. NEW: filters to employees who have BOTH pfacode AND nsitfcode populated.
//      Previously only checked pfacode IS NOT NULL.
//
//   5. paymentCodes is optional — if not supplied, report shows employee
//      info only (net_pay from mastercum) without contribution columns.
//      This preserves backward compatibility with existing calls.
// ============================================================================

const pool = require('../../config/db');

class NSITFReportService {

  async _getPeriod(year, month) {
    if (year && month) return { year: String(year), month: String(month) };
    const [rows] = await pool.query(
      `SELECT ord AS year, mth AS month FROM py_stdrate WHERE type = 'BT05' LIMIT 1`
    );
    if (!rows || rows.length === 0) throw new Error("Current period (BT05) not found in py_stdrate");
    return { year: String(rows[0].year), month: String(rows[0].month) };
  }

  // ==========================================================================
  // NSITF REPORT
  //
  // filters.paymentCodes — string or array of payment type codes from frontend
  //   e.g. 'PR309' or ['PR309','PR310']
  //   These are the specific deduction codes whose amtthismth + totpaidtodate
  //   should appear on the report.
  //
  // Only employees with BOTH he.pfacode and we.NSITFcode populated are included.
  // ==========================================================================
  async getNSITFReport(filters = {}) {
    const { year, month, pfaCode, summaryOnly, paymentCodes } = filters;
    const isSummary = summaryOnly === true || summaryOnly === '1' || summaryOnly === 'true';
    const period    = await this._getPeriod(year, month);
 
    // Normalise paymentCodes to an array (frontend may send string or array)
    const codes = paymentCodes
      ? (Array.isArray(paymentCodes) ? paymentCodes : String(paymentCodes).split(',').map(s => s.trim())).filter(Boolean)
      : [];
 
    const hasCodes = codes.length > 0;
 
    // ── Payment contribution subquery ────────────────────────────────────────
    // If the frontend supplied payment codes, aggregate amtthismth and
    // totpaidtodate from py_masterpayded for those codes, per employee.
    // This is a single derived table JOIN — one scan regardless of how many
    // codes are passed, using conditional SUM (same pattern as Report 6).
    const paymentJoin = hasCodes ? `
      LEFT JOIN (
        SELECT
          his_empno,
          ROUND(SUM(amtthismth),    2) AS contribution_this_month,
          ROUND(SUM(totpaidtodate), 2) AS contribution_paid_todate
        FROM py_masterpayded
        WHERE his_type IN (${codes.map(() => '?').join(',')})
          AND amtthismth > 0
        GROUP BY his_empno
      ) pd_nsitf ON pd_nsitf.his_empno = we.empl_id` : '';
 
    const paymentSelect = hasCodes ? `,
          COALESCE(pd_nsitf.contribution_this_month,  0) AS contribution_this_month,
          COALESCE(pd_nsitf.contribution_paid_todate, 0) AS contribution_paid_todate` : '';
 
    if (isSummary) {
      // ── Summary: aggregate by PFA ─────────────────────────────────────────
      const params = [period.month, ...(hasCodes ? codes : [])];
      if (pfaCode) params.push(pfaCode);
 
      const [rows] = await pool.query(
        `SELECT
           '${period.year}'  AS year,
           '${period.month}' AS month,
           he.pfacode                              AS pfa_code,
           COALESCE(pfa.pfadesc, '')               AS pfa_name,
           COUNT(DISTINCT mc.his_empno)            AS employee_count,
           ROUND(SUM(mc.his_netmth), 2)            AS total_net_pay,
           ROUND(AVG(mc.his_netmth), 2)            AS avg_net_pay,
           ROUND(MIN(mc.his_netmth), 2)            AS min_net_pay,
           ROUND(MAX(mc.his_netmth), 2)            AS max_net_pay
           ${hasCodes ? `,
           ROUND(SUM(COALESCE(pd_nsitf.contribution_this_month,  0)), 2) AS total_contribution_this_month,
           ROUND(SUM(COALESCE(pd_nsitf.contribution_paid_todate, 0)), 2) AS total_contribution_paid_todate` : ''}
         FROM py_wkemployees we
         INNER JOIN py_mastercum mc
                 ON mc.his_empno = we.empl_id
                AND mc.his_type  = ?
         INNER JOIN hr_employees he ON he.Empl_ID = we.empl_id
         LEFT  JOIN py_pfa        pfa ON pfa.pfacode  = he.pfacode
         ${paymentJoin}
         WHERE he.pfacode   IS NOT NULL AND he.pfacode   != ''
           AND we.NSITFcode IS NOT NULL AND we.NSITFcode != ''
           ${pfaCode ? 'AND he.pfacode = ?' : ''}
         GROUP BY he.pfacode, pfa.pfadesc
         ORDER BY pfa.pfadesc, total_net_pay DESC`,
        params
      );
      return rows;
 
    } else {
      // ── Detail: one row per employee ──────────────────────────────────────
      // Single query — no loop, no pagination, no COUNT pre-flight.
      const params = [period.month, ...(hasCodes ? codes : [])];
      if (pfaCode) params.push(pfaCode);
 
      const [rows] = await pool.query(
        `SELECT
           '${period.year}'  AS year,
           '${period.month}' AS month,
           we.empl_id                                                          AS employee_id,
           CONCAT(TRIM(we.Surname), ' ', TRIM(IFNULL(we.OtherName, '')))       AS full_name,
           st.Statename                                                         AS state,
           we.Sex,
           we.Title,
           tt.Description                                                       AS title,
           DATE_FORMAT(we.dateempl, '%Y-%m-%d')                                AS date_employed,
           we.NSITFcode                                                         AS nsitf_code,
           we.gradetype                                                         AS grade_type,
           SUBSTRING(we.gradelevel, 1, 2)                                      AS grade_level,
           ROUND(TIMESTAMPDIFF(YEAR, we.datepmted, NOW()), 0)                  AS years_in_level,
           he.pfacode                                                           AS pfa_code,
           COALESCE(pfa.pfadesc, '')                                            AS pfa_name,
           ROUND(mc.his_netmth, 2)                                              AS net_pay
           ${paymentSelect}
         FROM py_wkemployees we
         INNER JOIN py_mastercum mc
                 ON mc.his_empno = we.empl_id
                AND mc.his_type  = ?
         INNER JOIN hr_employees he ON he.Empl_ID  = we.empl_id
         LEFT  JOIN py_pfa        pfa ON pfa.pfacode  = he.pfacode
         LEFT  JOIN py_tblstates  st  ON st.Statecode = we.StateofOrigin
         LEFT  JOIN py_Title      tt  ON tt.Titlecode = we.Title
         ${paymentJoin}
         WHERE he.pfacode   IS NOT NULL AND he.pfacode   != ''
           AND we.NSITFcode IS NOT NULL AND we.NSITFcode != ''
           ${pfaCode ? 'AND he.pfacode = ?' : ''}
         ORDER BY ${pfaCode ? 'mc.his_netmth DESC' : 'pfa.pfadesc, mc.his_netmth DESC'}`,
        params
      );
      return rows;
    }
  }

  // ==========================================================================
  // GET AVAILABLE PFAs (unchanged)
  // ==========================================================================
  async getAvailablePFAs() {
    const [rows] = await pool.query(
      `SELECT DISTINCT
         pfa.pfacode                  AS pfa_code,
         COALESCE(pfa.pfadesc, '')    AS pfa_name
       FROM py_pfa pfa
       LEFT JOIN hr_employees he ON he.pfacode = pfa.pfacode
       WHERE pfa.pfacode IS NOT NULL
       ORDER BY pfa_code`
    );
    return rows;
  }

  // ==========================================================================
  // GET AVAILABLE PAYMENT CODES for NSITF
  // Returns deduction-type codes (PR/PL) so the frontend can populate its
  // payment element selector — same data shape as earnings analysis uses.
  // ==========================================================================
  async getNSITFPaymentCodes() {
    const [rows] = await pool.query(
      `SELECT DISTINCT
         mp.his_type          AS payment_code,
         et.elmDesc           AS payment_description,
         'Deductions'         AS category
       FROM py_masterpayded mp
       LEFT JOIN py_elementType et ON et.PaymentType = mp.his_type
       WHERE LEFT(mp.his_type, 2) IN ('PR', 'PL')
         AND mp.amtthismth > 0
       ORDER BY mp.his_type`
    );
    return rows;
  }

  // ==========================================================================
  // HELPER: Get Current Period
  // ==========================================================================
  async getCurrentPeriod() {
    const [rows] = await pool.query(
      `SELECT ord AS year, mth AS month, pmth AS prev_month
       FROM py_stdrate WHERE type = 'BT05' LIMIT 1`
    );
    return rows[0];
  }
}

module.exports = new NSITFReportService();