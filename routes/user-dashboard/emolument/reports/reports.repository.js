/**
 * FILE: modules/emolument/reports/reports.repository.js
 *
 * All SQL for emolument reports and dashboard.
 *
 *   getDashboardCounts — correlated subquery in unfiledShips replaced with
 *     a CTE-based approach.
 *     Caching is applied at the service layer, not here.
 *
 * All functions here are pure data fetchers. Caching lives in
 * reports.service.js so the repository stays testable without cache state.
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// PROGRESS REPORT — ProgressReport SP equivalent
// Per ship: total / submitted / do_reviewed / fo_approved /
//           cpo_confirmed / rejected / not_filed
// ─────────────────────────────────────────────────────────────

async function getProgressReport() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       s.shipName                                                AS ship_name,
       s.commandid,
       cmd.commandName,
       COUNT(p.Id)                                              AS total,
       SUM(CASE WHEN p.Status = 'Filled'    THEN 1 ELSE 0 END) AS submitted,
       SUM(CASE WHEN p.Status = 'FO'        THEN 1 ELSE 0 END) AS do_reviewed,
       SUM(CASE WHEN p.Status = 'CPO'       THEN 1 ELSE 0 END) AS fo_approved,
       SUM(CASE WHEN p.Status = 'Verified'  THEN 1 ELSE 0 END) AS cpo_confirmed,
       SUM(CASE WHEN p.emolumentform = 'Yes' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN p.Id IS NOT NULL
                 AND (p.Status IS NULL OR p.Status = '')
                 AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
                THEN 1 ELSE 0 END)                             AS not_filed
     FROM ef_ships s
     LEFT JOIN ef_personalinfos p  ON s.shipName = p.ship
     LEFT JOIN ef_commands      cmd ON cmd.Id    = s.commandid
     GROUP BY s.Id, s.shipName, s.commandid, cmd.commandName
     ORDER BY cmd.commandName ASC, s.shipName ASC`,
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// SHIP DETAIL — breakdown for one ship
// ─────────────────────────────────────────────────────────────

async function getShipReport(ship) {
  pool.useDatabase(DB());

  // Summary counts and per-class breakdown run in parallel —
  // they're independent queries on the same filter set.
  const [[[summary]], [byClass], [personnel]] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)                                               AS total,
         SUM(CASE WHEN Status = 'Filled'   THEN 1 ELSE 0 END) AS submitted,
         SUM(CASE WHEN Status = 'FO'       THEN 1 ELSE 0 END) AS do_reviewed,
         SUM(CASE WHEN Status = 'CPO'      THEN 1 ELSE 0 END) AS fo_approved,
         SUM(CASE WHEN Status = 'Verified' THEN 1 ELSE 0 END) AS cpo_confirmed,
         SUM(CASE WHEN emolumentform = 'Yes' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN (Status IS NULL OR Status = '')
                   AND (emolumentform IS NULL OR emolumentform != 'Yes')
                  THEN 1 ELSE 0 END)                          AS not_filed
       FROM ef_personalinfos
       WHERE ship = ?`,
      [ship],
    ),
    pool.query(
      `SELECT
         classes,
         payrollclass,
         COUNT(*)                                               AS total,
         SUM(CASE WHEN Status = 'Filled'   THEN 1 ELSE 0 END) AS submitted,
         SUM(CASE WHEN Status = 'FO'       THEN 1 ELSE 0 END) AS do_reviewed,
         SUM(CASE WHEN Status = 'CPO'      THEN 1 ELSE 0 END) AS fo_approved,
         SUM(CASE WHEN Status = 'Verified' THEN 1 ELSE 0 END) AS cpo_confirmed,
         SUM(CASE WHEN emolumentform = 'Yes' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN (Status IS NULL OR Status = '')
                   AND (emolumentform IS NULL OR emolumentform != 'Yes')
                  THEN 1 ELSE 0 END)                          AS not_filed
       FROM ef_personalinfos
       WHERE ship = ?
       GROUP BY classes, payrollclass
       ORDER BY classes ASC`,
      [ship],
    ),
    pool.query(
      `SELECT serviceNumber, Surname, OtherName, \`Rank\`,
         payrollclass, classes, Status, emolumentform,
         formNumber, FormYear, datecreated
       FROM ef_personalinfos
       WHERE ship = ?
       ORDER BY Surname ASC, OtherName ASC`,
      [ship],
    ),
  ]);

  return { summary, byClass, personnel };
}

// ─────────────────────────────────────────────────────────────
// COMMAND REPORT — breakdown for one command
// ─────────────────────────────────────────────────────────────

async function getCommandReport(command) {
  pool.useDatabase(DB());

  const [[[summary]], [byShip]] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)                                               AS total,
         SUM(CASE WHEN p.Status = 'Filled'   THEN 1 ELSE 0 END) AS submitted,
         SUM(CASE WHEN p.Status = 'FO'       THEN 1 ELSE 0 END) AS do_reviewed,
         SUM(CASE WHEN p.Status = 'CPO'      THEN 1 ELSE 0 END) AS fo_approved,
         SUM(CASE WHEN p.Status = 'Verified' THEN 1 ELSE 0 END) AS cpo_confirmed,
         SUM(CASE WHEN p.emolumentform = 'Yes' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN (p.Status IS NULL OR p.Status = '')
                   AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
                  THEN 1 ELSE 0 END)                          AS not_filed
       FROM ef_personalinfos p
       WHERE p.command = ?`,
      [command],
    ),
    pool.query(
      `SELECT
         p.ship,
         COUNT(*)                                               AS total,
         SUM(CASE WHEN p.Status = 'Filled'   THEN 1 ELSE 0 END) AS submitted,
         SUM(CASE WHEN p.Status = 'FO'       THEN 1 ELSE 0 END) AS do_reviewed,
         SUM(CASE WHEN p.Status = 'CPO'      THEN 1 ELSE 0 END) AS fo_approved,
         SUM(CASE WHEN p.Status = 'Verified' THEN 1 ELSE 0 END) AS cpo_confirmed,
         SUM(CASE WHEN p.emolumentform = 'Yes' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN (p.Status IS NULL OR p.Status = '')
                   AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
                  THEN 1 ELSE 0 END)                          AS not_filed
       FROM ef_personalinfos p
       WHERE p.command = ?
       GROUP BY p.ship
       ORDER BY p.ship ASC`,
      [command],
    ),
  ]);

  return { command, summary, byShip };
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD — aggregate counts
//
// pre-aggregate ship totals in a CTE, then LEFT JOIN
// the unfiled counts against it. One pass through the table, not n+1.
// ─────────────────────────────────────────────────────────────

async function getDashboardCounts() {
  pool.useDatabase(DB());

  // Global counts and class breakdown run in parallel —
  // they're independent aggregations on the same table.
  const [[[global]], [byClass], unfiledAndTop] = await Promise.all([
    // 1. Global aggregate
    pool.query(
      `SELECT
         COUNT(*)                                                   AS total_personnel,
         SUM(CASE WHEN emolumentform = 'Yes'  THEN 1 ELSE 0 END)   AS total_confirmed,
         SUM(CASE WHEN Status = 'Filled'      THEN 1 ELSE 0 END)   AS total_submitted,
         SUM(CASE WHEN Status = 'FO'          THEN 1 ELSE 0 END)   AS total_do_reviewed,
         SUM(CASE WHEN Status = 'CPO'         THEN 1 ELSE 0 END)   AS total_fo_approved,
         SUM(CASE WHEN Status = 'Verified'    THEN 1 ELSE 0 END)   AS total_cpo_confirmed,
         SUM(CASE WHEN (Status IS NULL OR Status = '')
                   AND (emolumentform IS NULL OR emolumentform != 'Yes')
                  THEN 1 ELSE 0 END)                               AS total_not_filed
       FROM ef_personalinfos`,
    ),

    // 2. Breakdown by form class
    pool.query(
      `SELECT
         classes,
         COUNT(*)                                                   AS total,
         SUM(CASE WHEN emolumentform = 'Yes'  THEN 1 ELSE 0 END)   AS confirmed,
         SUM(CASE WHEN Status = 'Filled'      THEN 1 ELSE 0 END)   AS submitted,
         SUM(CASE WHEN Status = 'FO'          THEN 1 ELSE 0 END)   AS do_reviewed,
         SUM(CASE WHEN Status = 'CPO'         THEN 1 ELSE 0 END)   AS fo_approved,
         SUM(CASE WHEN Status = 'Verified'    THEN 1 ELSE 0 END)   AS cpo_confirmed,
         SUM(CASE WHEN (Status IS NULL OR Status = '')
                   AND (emolumentform IS NULL OR emolumentform != 'Yes')
                  THEN 1 ELSE 0 END)                               AS not_filed
       FROM ef_personalinfos
       GROUP BY classes
       ORDER BY classes ASC`,
    ),

    // 3. Unfiled ships + top 10 by completion — combined CTE query
    //    Both need the same per-ship aggregation, so compute it once.
    pool.query(
      `WITH ship_stats AS (
         SELECT
           ship,
           COUNT(*)                                                 AS total,
           SUM(CASE WHEN emolumentform = 'Yes' THEN 1 ELSE 0 END)  AS confirmed,
           SUM(CASE WHEN (Status IS NULL OR Status = '')
                     AND (emolumentform IS NULL OR emolumentform != 'Yes')
                    THEN 1 ELSE 0 END)                             AS not_filed
         FROM ef_personalinfos
         WHERE ship IS NOT NULL AND ship != ''
         GROUP BY ship
       )
       SELECT
         ship,
         total,
         confirmed,
         not_filed,
         ROUND(confirmed / total * 100, 1)                         AS completion_pct,
         (not_filed = total)                                        AS fully_unfiled
       FROM ship_stats
       WHERE total > 0
       ORDER BY completion_pct DESC, confirmed DESC`,
    ),
  ]);

  // Split the combined result into the two lists the caller expects
  const [unfiledAndTopRows] = unfiledAndTop;
  const unfiledShips = unfiledAndTopRows
    .filter((r) => r.fully_unfiled)
    .map(({ ship, total }) => ({ ship, total_personnel: total }));

  const topShips = unfiledAndTopRows
    .slice(0, 10)
    .map(({ ship, total, confirmed, completion_pct }) => ({
      ship,
      total,
      confirmed,
      completion_pct,
    }));

  return { global, byClass, unfiledShips, topShips };
}

// ─────────────────────────────────────────────────────────────
// FORM APPROVAL HISTORY — trail for one personnel
// ─────────────────────────────────────────────────────────────

async function getPersonnelApprovalHistory(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       fa.id, fa.action, fa.from_status, fa.to_status,
       fa.performed_by, fa.performer_role, fa.remarks,
       fa.performed_at,
       ef.form_year, ef.form_number, ef.payroll_class
     FROM ef_form_approvals fa
     JOIN ef_emolument_forms ef ON ef.id = fa.form_id
     WHERE ef.service_no = ?
     ORDER BY fa.performed_at ASC`,
    [serviceNo],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// PROCESSING YEAR SUMMARY
// ─────────────────────────────────────────────────────────────

async function getYearSummary() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       FormYear,
       COUNT(*)                                          AS total_forms,
       SUM(CASE WHEN classes = 1 THEN 1 ELSE 0 END)     AS officers,
       SUM(CASE WHEN classes = 2 THEN 1 ELSE 0 END)     AS ratings,
       SUM(CASE WHEN classes = 3 THEN 1 ELSE 0 END)     AS training
     FROM ef_personalinfoshist
     GROUP BY FormYear
     ORDER BY FormYear DESC`,
  );
  return rows;
}

module.exports = {
  getProgressReport,
  getShipReport,
  getCommandReport,
  getDashboardCounts,
  getPersonnelApprovalHistory,
  getYearSummary,
};
