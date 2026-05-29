/**
 * FILE: routes/user-dashboard/emolument/reports/reports.service.js
 *
 * Business logic for emolument reports and dashboard.
 *
 * CACHING:
 *   progressReport  → cached 120s (KEY.PROGRESS)
 *   dashboard       → cached 60s  (KEY.DASHBOARD)
 *   shipReport      → cached 60s  (KEY.ship(name))
 *   commandReport   → cached 60s  (KEY.command(code))
 *
 *   yearSummary and personnelHistory are NOT cached:
 *     - yearSummary  is a cheap query on a small history table
 *     - personnelHistory is a point lookup, already fast with the index
 *
 * CACHE BUST:
 *   invalidateReportCache() — exported for use by approve/confirm/reject
 *   service functions so the dashboard reflects changes immediately after
 *   any workflow action, without waiting for TTL expiry.
 *
 *   invalidateShipCache(ship)       — targeted bust after a ship-level action
 *   invalidateCommandCache(command) — targeted bust after a command-level action
 *
 * Access control is enforced at route level:
 *   progressReport   → requireAnyEmolRole
 *   shipReport       → requireShipAccess  (DO/FO for their ship, admin all)
 *   commandReport    → requireCommandAccess (CPO for their command, admin all)
 *   dashboard        → requireAnyEmolRole
 *   personnelHistory → requirePersonnel (own record) or requireAnyEmolRole
 *   yearSummary      → requireAnyEmolRole
 */

"use strict";

const repo = require("./reports.repository");
const cache = require("./reports.cache");
const { toFormStatus } = require("../emolument.constants");

// ─────────────────────────────────────────────────────────────
// CACHE INVALIDATION — exported so other services can call these
// after any workflow action that changes report data.
//
// Usage in fo.service.js after a bulk approve:
//   const { invalidateReportCache, invalidateShipCache } = require('../reports/reports.service');
//   invalidateShipCache(ship);
//   invalidateReportCache();   // also bust dashboard + progress
// ─────────────────────────────────────────────────────────────

function invalidateReportCache() {
  cache.invalidate(cache.KEY.DASHBOARD);
  cache.invalidate(cache.KEY.PROGRESS);
}

function invalidateShipCache(ship) {
  cache.invalidate(cache.KEY.ship(ship));
  // Also bust dashboard + progress since ship counts roll up into both
  invalidateReportCache();
}

function invalidateCommandCache(command) {
  cache.invalidate(cache.KEY.command(command));
  invalidateReportCache();
}

function invalidateAll() {
  cache.invalidateAll();
}

// ─────────────────────────────────────────────────────────────
// PROGRESS REPORT — all ships, grouped by command
// Cached 120s — changes only when forms are approved/confirmed.
// ─────────────────────────────────────────────────────────────

async function progressReport() {
  const cacheKey = cache.KEY.PROGRESS;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const rows = await repo.getProgressReport();

  // Group by command for easier frontend rendering
  const byCommand = {};
  for (const row of rows) {
    const key = row.commandName || "Unassigned";
    if (!byCommand[key]) {
      byCommand[key] = {
        commandName: key,
        ships: [],
        totals: {
          total: 0,
          submitted: 0,
          do_reviewed: 0,
          fo_approved: 0,
          cpo_confirmed: 0,
          completed: 0,
          not_filed: 0,
        },
      };
    }

    byCommand[key].ships.push({
      ship_name: row.ship_name,
      total: row.total,
      submitted: row.submitted,
      do_reviewed: row.do_reviewed,
      fo_approved: row.fo_approved,
      cpo_confirmed: row.cpo_confirmed,
      completed: row.completed,
      not_filed: row.not_filed,
      completion_pct:
        row.total > 0
          ? Math.round((row.completed / row.total) * 100 * 10) / 10
          : 0,
    });

    const t = byCommand[key].totals;
    t.total += Number(row.total || 0);
    t.submitted += Number(row.submitted || 0);
    t.do_reviewed += Number(row.do_reviewed || 0);
    t.fo_approved += Number(row.fo_approved || 0);
    t.cpo_confirmed += Number(row.cpo_confirmed || 0);
    t.completed += Number(row.completed || 0);
    t.not_filed += Number(row.not_filed || 0);
  }

  const result = {
    success: true,
    data: {
      commands: Object.values(byCommand),
      generatedAt: new Date().toISOString(),
      cached: false,
    },
  };

  cache.set(
    cacheKey,
    { ...result, data: { ...result.data, cached: true } },
    cache.TTL.PROGRESS,
  );
  return result;
}

// ─────────────────────────────────────────────────────────────
// SHIP REPORT — one ship detail
// Cached 60s, keyed by ship name.
// ─────────────────────────────────────────────────────────────

async function shipReport(ship) {
  if (!ship)
    return { success: false, code: 400, message: "Ship name is required." };

  const cacheKey = cache.KEY.ship(ship);
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const { summary, byClass, personnel } = await repo.getShipReport(ship);

  const personnelWithCleanStatus = personnel.map((p) => ({
    ...p,
    formStatus: toFormStatus(p.Status),
  }));

  const completionPct =
    summary.total > 0
      ? Math.round((summary.completed / summary.total) * 100 * 10) / 10
      : 0;

  const result = {
    success: true,
    data: {
      ship,
      summary: { ...summary, completion_pct: completionPct },
      byClass,
      personnel: personnelWithCleanStatus,
      generatedAt: new Date().toISOString(),
      cached: false,
    },
  };

  cache.set(
    cacheKey,
    { ...result, data: { ...result.data, cached: true } },
    cache.TTL.SHIP,
  );
  return result;
}

// ─────────────────────────────────────────────────────────────
// COMMAND REPORT — one command detail
// Cached 60s, keyed by command code.
// ─────────────────────────────────────────────────────────────

async function commandReport(command) {
  if (!command)
    return { success: false, code: 400, message: "Command is required." };

  const cacheKey = cache.KEY.command(command);
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const { summary, byShip } = await repo.getCommandReport(command);

  const completionPct =
    summary.total > 0
      ? Math.round((summary.completed / summary.total) * 100 * 10) / 10
      : 0;

  const byShipWithPct = byShip.map((s) => ({
    ...s,
    completion_pct:
      s.total > 0 ? Math.round((s.completed / s.total) * 100 * 10) / 10 : 0,
  }));

  const result = {
    success: true,
    data: {
      command,
      summary: { ...summary, completion_pct: completionPct },
      byShip: byShipWithPct,
      generatedAt: new Date().toISOString(),
      cached: false,
    },
  };

  cache.set(
    cacheKey,
    { ...result, data: { ...result.data, cached: true } },
    cache.TTL.COMMAND,
  );
  return result;
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD — aggregate view
// Cached 60s — the most expensive query set in the system.
// ─────────────────────────────────────────────────────────────

async function dashboard() {
  const cacheKey = cache.KEY.DASHBOARD;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const { global, byClass, unfiledShips, topShips } =
    await repo.getDashboardCounts();

  const completionPct =
    global.total_personnel > 0
      ? Math.round(
          (global.total_confirmed / global.total_personnel) * 100 * 10,
        ) / 10
      : 0;

  const classLabels = { 1: "Officers", 2: "Ratings", 3: "Training" };
  const byClassLabelled = byClass.map((c) => ({
    ...c,
    label: classLabels[c.classes] || `Class ${c.classes}`,
    completion_pct:
      c.total > 0 ? Math.round((c.confirmed / c.total) * 100 * 10) / 10 : 0,
  }));

  const result = {
    success: true,
    data: {
      global: { ...global, completion_pct: completionPct },
      byClass: byClassLabelled,
      unfiledShips,
      topShips,
      generatedAt: new Date().toISOString(),
      cached: false,
    },
  };

  cache.set(
    cacheKey,
    { ...result, data: { ...result.data, cached: true } },
    cache.TTL.DASHBOARD,
  );
  return result;
}

// ─────────────────────────────────────────────────────────────
// PERSONNEL APPROVAL HISTORY — point lookup, no cache needed
// ─────────────────────────────────────────────────────────────

async function personnelHistory(serviceNo) {
  if (!serviceNo)
    return {
      success: false,
      code: 400,
      message: "Service number is required.",
    };

  const history = await repo.getPersonnelApprovalHistory(serviceNo);
  return {
    success: true,
    data: { serviceNo, history, totalActions: history.length },
  };
}

// ─────────────────────────────────────────────────────────────
// YEAR SUMMARY — small table, cheap query, no cache needed
// ─────────────────────────────────────────────────────────────

async function yearSummary() {
  const rows = await repo.getYearSummary();
  return { success: true, data: rows };
}

// ─────────────────────────────────────────────────────────────
// CACHE STATUS — for the bust endpoint in the controller
// ─────────────────────────────────────────────────────────────

function cacheStatus() {
  return { success: true, data: cache.status() };
}

module.exports = {
  progressReport,
  shipReport,
  commandReport,
  dashboard,
  personnelHistory,
  yearSummary,
  cacheStatus,
  // Exported for other services to call after workflow actions
  invalidateReportCache,
  invalidateShipCache,
  invalidateCommandCache,
  invalidateAll,
};