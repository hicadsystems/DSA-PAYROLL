/**
 * FILE: routes/user-dashboard/emolument/emolument.scheduler.js
 *
 * Scheduled job that keeps ef_ships.openship in sync with the
 * live state of ef_control every minute.
 *
 * Logic:
 *   1. Find all ef_control rows where NOW() is within the date window
 *      (startdate <= NOW() <= enddate) and status IN ('Open','Reopen').
 *      These are the currently active open windows.
 *
 *   2. For each such row:
 *      - ship = 'All'  → set ALL ef_ships.openship = 1
 *      - ship = <name> → set that specific ship's openship = 1
 *
 *   3. Any ship NOT covered by an active open window gets openship = 0.
 *
 * Mount in your app entry point:
 *   require('./routes/user-dashboard/emolument/emolument.scheduler');
 *
 * Requires: node-cron  (npm install node-cron)
 */

"use strict";

const cron = require("node-cron");

// Pool initialises asynchronously — we must not call pool.useDatabase()
// until the async IIFE in db.js has completed and dbConfig is set.
// We wait by polling pool.getAvailableDatabases() until it returns entries.
async function waitForPool(pool, retries = 30, intervalMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const dbs = pool.getAvailableDatabases();
      if (dbs && dbs.length > 0) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Pool did not become ready within the expected time.");
}

// Resolve DB name the same way all repositories do —
// process.env.MYSQL_DB_OFFICERS is always set in this project.
function getDB() {
  if (process.env.MYSQL_DB_OFFICERS) return process.env.MYSQL_DB_OFFICERS;
  if (process.env.DB_OFFICERS) return process.env.DB_OFFICERS;
  // Last resort: ask pool directly
  try {
    const pool = require("../../../config/db");
    const dbs = pool.getAvailableDatabases();
    return dbs[0] || null;
  } catch {
    return null;
  }
}

async function syncOpenship() {
  const pool = require("../../../config/db");
  const DB = getDB();
  try {
    pool.useDatabase(DB);

    // 1. Get all currently active open windows
    const [activeRows] = await pool.query(
      `SELECT ship, formtype, status
       FROM ef_control
       WHERE NOW() BETWEEN startdate AND enddate
         AND status IN ('Open', 'Reopen')`,
    );

    const isAnyOpen = activeRows.length > 0;
    const hasGlobal = activeRows.some((r) => r.ship === "All" || !r.ship);
    const openShipNames = new Set(
      activeRows.filter((r) => r.ship && r.ship !== "All").map((r) => r.ship),
    );

    // 2. Sync ef_ships.openship
    if (hasGlobal) {
      await pool.query(`UPDATE ef_ships SET openship = 1`);
    } else if (openShipNames.size > 0) {
      await pool.query(`UPDATE ef_ships SET openship = 0`);
      const placeholders = [...openShipNames].map(() => "?").join(",");
      await pool.query(
        `UPDATE ef_ships SET openship = 1 WHERE shipName IN (${placeholders})`,
        [...openShipNames],
      );
    } else {
      await pool.query(`UPDATE ef_ships SET openship = 0`);
    }

    // 3. ef_systeminfos.SiteStatus is no longer used as a gate —
    //    checkFormEligibility now reads ef_control directly.
    //    No SiteStatus update needed here.
  } catch (err) {
    console.error("❌ emolument.scheduler syncOpenship error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// AUTO-ARCHIVE PREVIOUS CYCLE ON STARTUP
//
// Every person fills the form every year. On a new cycle:
//
// 1. Snapshot ALL ef_emolument_forms rows from the previous year
//    where snapshot is null — preserves history for everyone
//    regardless of confirmation status.
//
// 2. Reset ALL ef_personalinfos cycle fields:
//    Status = NULL, formNumber = NULL, FormYear = NULL,
//    emolumentform = NULL  ← clears the re-fill gate.
//    hr_employees.emolumentform stays 'Yes' as the permanent
//    payroll sync record — not touched here.
//
// 3. Reset ef_systeminfos form number counters to 1 so the new
//    cycle starts with fresh sequential form numbers.
// ─────────────────────────────────────────────────────────────
async function archivePreviousCycleIfNeeded() {
  const pool = require("../../../config/db");
  const DB = getDB();
  try {
    pool.useDatabase(DB);

    const [yearRows] = await pool.query(
      `SELECT processingyear FROM ef_control
       WHERE status IN ('Open','Reopen')
       ORDER BY processingyear DESC LIMIT 1`,
    );

    if (!yearRows.length) return;

    const currentYear = String(yearRows[0].processingyear);

    // All personnel whose FormYear is from a previous cycle
    const [staleRows] = await pool.query(
      `SELECT serviceNumber, FormYear FROM ef_personalinfos
       WHERE FormYear IS NOT NULL
         AND FormYear != ?`,
      [currentYear],
    );

    if (!staleRows.length) return;

    const prevYear = String(staleRows[0].FormYear);
    console.log(
      `📦 New cycle: ${prevYear} → ${currentYear}. Archiving ${staleRows.length} records.`,
    );

    // Step 1: Snapshot ALL ef_emolument_forms from previous year (no snapshot yet)
    await pool.query(
      `UPDATE ef_emolument_forms f
       INNER JOIN ef_personalinfos p ON p.serviceNumber = f.service_no
       SET f.snapshot   = COALESCE(f.snapshot, JSON_OBJECT(
                            'archived', true,
                            'archivedAt', NOW(),
                            'previousYear', ?,
                            'previousStatus', p.Status,
                            'wasConfirmed', IF(p.emolumentform = 'Yes', true, false)
                          )),
           f.updated_at = NOW()
       WHERE f.form_year = ?
         AND f.snapshot  IS NULL`,
      [prevYear, prevYear],
    );

    // Step 2: Reset ALL ef_personalinfos cycle fields for everyone
    await pool.query(
      `UPDATE ef_personalinfos
       SET Status        = NULL,
           formNumber    = NULL,
           FormYear      = NULL,
           emolumentform = NULL,
           dateModify    = NOW()`,
    );

    // Step 3: Reset form number counters for the new cycle
    await pool.query(
      `UPDATE ef_systeminfos
       SET OfficersFormNo = 1,
           RatingsFormNo  = 1,
           TrainingFormNo = 1`,
    );

    console.log(
      `✅ Archive complete. ${staleRows.length} records reset for cycle ${currentYear}.`,
    );
  } catch (err) {
    console.error(
      "❌ emolument.scheduler archivePreviousCycleIfNeeded error:",
      err.message,
    );
  }
}

// Run every minute
cron.schedule("* * * * *", syncOpenship);

// On startup: wait for pool to be ready, then sync + archive
(async () => {
  try {
    const pool = require("../../../config/db");
    await waitForPool(pool);
    await syncOpenship();
    await archivePreviousCycleIfNeeded();
  } catch (err) {
    console.error("❌ emolument.scheduler startup error:", err.message);
  }
})();

console.log("✅ Emolument scheduler started — syncing openship every minute.");

module.exports = { syncOpenship, archivePreviousCycleIfNeeded };
