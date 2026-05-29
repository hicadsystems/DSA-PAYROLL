// ============================================================================
// services/Reports/NHFReportService.js============================================================================

const pool = require('../../config/db');

class NHFReportService {

  // ==========================================================================
  // INTERNAL: resolve period to scalar values (same pattern as reportServices)
  // ==========================================================================
  async _getPeriod(year, month) {
    if (year && month) {
      return { year: String(year), month: String(month) };
    }
    const [rows] = await pool.query(
      `SELECT ord AS year, mth AS month FROM py_stdrate WHERE type = 'BT05' LIMIT 1`
    );
    if (!rows || rows.length === 0) {
      throw new Error("Current period (BT05) not found in py_stdrate");
    }
    return { year: String(rows[0].year), month: String(rows[0].month) };
  }

  // ==========================================================================
  // NHF REPORT
  // ==========================================================================
  async getNHFReport(filters = {}) {
    const { year, month, summaryOnly } = filters;
    const isSummary = summaryOnly === true || summaryOnly === '1' || summaryOnly === 'true';
    const period    = await this._getPeriod(year, month);

    if (isSummary) {
      // ── Summary: one aggregate row ────────────────────────────────────────
      // Period scalars injected as literals — no cross join needed.
      // mc.his_type = period.month correctly uses the index on py_mastercum.
      const [rows] = await pool.query(
        `SELECT
           '${period.year}'  AS year,
           '${period.month}' AS month,
           COUNT(DISTINCT mp.his_empno)        AS employee_count,
           ROUND(SUM(mc.his_netmth),    2)     AS total_net_pay,
           ROUND(AVG(mc.his_netmth),    2)     AS avg_net_pay,
           ROUND(SUM(mp.amtthismth),    2)     AS total_nhf_contribution,
           ROUND(AVG(mp.amtthismth),    2)     AS avg_nhf_contribution,
           ROUND(SUM(mp.totpaidtodate), 2)     AS total_nhf_paid_todate,
           ROUND(MIN(mp.amtthismth),    2)     AS min_nhf_contribution,
           ROUND(MAX(mp.amtthismth),    2)     AS max_nhf_contribution
         FROM py_masterpayded mp
         INNER JOIN py_mastercum mc
                 ON mc.his_empno = mp.his_empno
                AND mc.his_type  = ?
         INNER JOIN py_wkemployees we ON we.empl_id = mp.his_empno
         WHERE mp.his_type     = 'PR309'
           AND mp.amtthismth   > 0`,
        [period.month]
      );
      return rows;

    } else {
      // ── Detail: one row per employee ──────────────────────────────────────
      // BEFORE: COUNT query + loop of 40 paginated queries (41 round-trips,
      //         MySQL reads up to 80k rows total due to offset scanning).
      // AFTER:  Single query, all rows returned at once (1 round-trip).
      //
      // The DB is better at sorting and returning 4000 rows in one shot than
      // Node is at reassembling 40 paginated slices.
      //
      // Drive the query from py_masterpayded (already filtered to PR309)
      // rather than py_wkemployees — avoids a full employee table scan
      // before the NHF filter is applied.
      const [rows] = await pool.query(
        `SELECT
           '${period.year}'  AS year,
           '${period.month}' AS month,
           we.empl_id                                                         AS employee_id,
           CONCAT(TRIM(we.Surname), ' ', TRIM(IFNULL(we.OtherName, '')))      AS full_name,
           tt.Description                                                      AS title,
           we.Title,
           DATE_FORMAT(we.dateempl, '%Y-%m-%d')                               AS date_employed,
           we.NSITFcode                                                        AS nsitf_code,
           we.gradetype                                                        AS grade_type,
           SUBSTRING(we.gradelevel, 1, 2)                                     AS grade_level,
           ROUND(TIMESTAMPDIFF(YEAR, we.datepmted, NOW()), 0)                 AS years_in_level,
           we.Location                                                         AS location_code,
           COALESCE(cc.unitdesc, '')                                           AS location_name,
           ROUND(mc.his_netmth,      2)                                       AS net_pay,
           ROUND(mp.amtthismth,      2)                                       AS nhf_contribution,
           ROUND(mp.totpaidtodate,   2)                                       AS nhf_paid_todate,
           ROUND((mp.amtthismth / NULLIF(mc.his_netmth, 0)) * 100, 2)        AS nhf_percentage,
           we.Bankcode,
           we.BankACNumber
         FROM py_masterpayded mp
         INNER JOIN py_wkemployees we ON we.empl_id  = mp.his_empno
         INNER JOIN py_mastercum   mc ON mc.his_empno = mp.his_empno
                                     AND mc.his_type  = ?
         LEFT  JOIN py_Title        tt ON tt.Titlecode  = we.Title
         LEFT  JOIN ac_costcentre   cc ON cc.unitcode   = we.Location
         WHERE mp.his_type   = 'PR309'
           AND mp.amtthismth > 0
         ORDER BY mp.amtthismth DESC`,
        [period.month]
      );
      return rows;
    }
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

module.exports = new NHFReportService();