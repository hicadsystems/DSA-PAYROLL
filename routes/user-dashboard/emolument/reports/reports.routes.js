/**
 * FILE: routes/user-dashboard/emolument/reports/reports.routes.js
 *
 * Routes for emolument reports and dashboard.
 *
 * Access tiers:
 *   requireAnyEmolRole   → DO, FO, CPO, EMOL_ADMIN
 *   requireShipAccess    → DO or FO for their ship (admin: all ships)
 *   requireCommandAccess → CPO for their command (admin: all commands)
 *   requirePersonnel     → own approval history only
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  GET  /reports/progress                    → all ships (grouped by command)
 *  GET  /reports/dashboard                   → aggregate counts + top ships
 *  GET  /reports/years                       → historical year summary
 *  GET  /reports/ship/:ship                  → one ship detail + personnel list
 *  GET  /reports/command/:command            → one command detail + ship breakdown
 *  GET  /reports/personnel/:svcno/history    → approval trail for one person
 *  POST /reports/cache/bust                  → invalidate report caches (any auth user)
 *  GET  /reports/cache/status                → cache key + stats (EMOL_ADMIN only)
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");
const verifyToken = require("../../../../middware/authentication");
const {
  requireAnyEmolRole,
  requireShipAccess,
  requireCommandAccess,
  requirePersonnel,
  requireEmolRole,
} = require("../../../../middware/emolumentAuth");
const reportsService = require("./reports.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for all routes in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All routes require authentication
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────
// GET /reports/progress
// All ships grouped by command.
// Visible to any elevated role.
// ─────────────────────────────────────────────────────────────

router.get("/progress", requireAnyEmolRole, async (req, res) => {
  try {
    const result = await reportsService.progressReport();
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /reports/progress:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /reports/dashboard
// Aggregate counts + class breakdown + unfiled + top ships.
// ─────────────────────────────────────────────────────────────

router.get("/dashboard", requireAnyEmolRole, async (req, res) => {
  try {
    const result = await reportsService.dashboard();
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /reports/dashboard:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /reports/years
// Historical year summary from ef_personalinfoshist.
// EMOL_ADMIN only — historical data is sensitive.
// ─────────────────────────────────────────────────────────────

router.get("/years", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  try {
    const result = await reportsService.yearSummary();
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /reports/years:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /reports/ship/:ship
// Detailed breakdown for one ship.
// requireShipAccess: DO/FO for their ship, EMOL_ADMIN all ships.
// ─────────────────────────────────────────────────────────────

router.get("/ship/:ship", requireShipAccess, async (req, res) => {
  const { ship } = req.params;
  try {
    const result = await reportsService.shipReport(ship);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /reports/ship/:ship:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /reports/command/:command
// Breakdown for one command + per-ship detail within it.
// requireCommandAccess: CPO for their command, EMOL_ADMIN all.
// ─────────────────────────────────────────────────────────────

router.get("/command/:command", requireCommandAccess, async (req, res) => {
  const { command } = req.params;
  try {
    const result = await reportsService.commandReport(command);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /reports/command/:command:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /reports/personnel/:svcno/history
// Approval trail for a specific personnel.
// Own record: requirePersonnel (svcno must match req.user_id).
// Other personnel: requireAnyEmolRole (officers can view anyone's trail).
// ─────────────────────────────────────────────────────────────

router.get("/personnel/:svcno/history", async (req, res) => {
  const { svcno } = req.params;
  const isSelf = svcno === req.user_id;

  const guard = isSelf ? requirePersonnel : requireAnyEmolRole;

  guard(req, res, async () => {
    try {
      const result = await reportsService.personnelHistory(svcno);
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json(result.data);
    } catch (err) {
      console.error("❌ GET /reports/personnel/:svcno/history:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// POST /reports/cache/bust
// Invalidates report caches so the next request re-queries live data.
// Any authenticated user can call this — useful after a bulk approve
// or confirmation so the dashboard reflects changes immediately.
//
// Optional body:
//   { scope: "ship",    value: "NNS EXAMPLE" }  → bust one ship only
//   { scope: "command", value: "WNC" }           → bust one command only
//   {}                                            → bust everything (default)
// ─────────────────────────────────────────────────────────────

router.post("/cache/bust", async (req, res) => {
  try {
    const { scope, value } = req.body || {};

    if (scope === "ship" && value) {
      reportsService.invalidateShipCache(value);
      return res.json({
        success: true,
        message: `Cache cleared for ship: ${value}`,
      });
    }

    if (scope === "command" && value) {
      reportsService.invalidateCommandCache(value);
      return res.json({
        success: true,
        message: `Cache cleared for command: ${value}`,
      });
    }

    reportsService.invalidateAll();
    return res.json({ success: true, message: "All report caches cleared." });
  } catch (err) {
    console.error("❌ POST /reports/cache/bust:", err);
    return res.status(500).json({ error: "Cache bust failed." });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /reports/cache/status
// Shows live cache keys and hit/miss stats.
// EMOL_ADMIN only — this is a debugging/ops endpoint.
// ─────────────────────────────────────────────────────────────

router.get("/cache/status", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  try {
    const result = reportsService.cacheStatus();
    return res.json(result);
  } catch (err) {
    console.error("❌ GET /reports/cache/status:", err);
    return res.status(500).json({ error: "Could not retrieve cache status." });
  }
});

module.exports = router;