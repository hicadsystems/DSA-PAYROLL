/**
 * FILE: routes/user-dashboard/emolument/do/do.routes.js
 *
 * Routes for the Divisional Officer (DO) review workflow.
 *
 * All routes: verifyToken + requireFormRole('DO') or requireEmolRole('DO')
 * EMOL_ADMIN passes all guards automatically.
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  GET  /do/ship/:ship/personnel      → list SUBMITTED forms on ship
 *  GET  /do/forms/:form_id            → view full form detail
 *  POST /do/forms/:form_id/review     → mark DO_REVIEWED
 *  POST /do/forms/:form_id/reject     → reject → reset to NULL
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");
const verifyToken = require("../../../../middware/authentication");
const {
  requireEmolRole,
  requireFormRole,
  fetchEmolRoles,
} = require("../../../../middware/emolumentAuth");
const doService = require("./do.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for all routes in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All routes require authentication
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────
// HELPER — extract DO's assigned ships from req.emolRoles
// Returns array of ship names, or 'ALL' if EMOL_ADMIN.
// ─────────────────────────────────────────────────────────────

function resolveDoShips(req) {
  if (req.isEmolAdmin) return "ALL";
  return (req.emolRoles || [])
    .filter((r) => r.role === "DO" && r.scope_type === "SHIP" && r.scope_value)
    .map((r) => r.scope_value);
}

// ─────────────────────────────────────────────────────────────
// GET /do/ship/:ship/personnel
// List all SUBMITTED forms on a ship.
// requireEmolRole('DO') scopes the ship from req.params.ship.
// ─────────────────────────────────────────────────────────────

router.get("/ship/:ship/personnel", requireEmolRole("DO"), async (req, res) => {
  const { ship } = req.params;
  try {
    const result = await doService.listSubmittedForms(ship);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /do/ship/:ship/personnel:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /do/forms/:form_id
// View full form detail for a specific submission.
// requireFormRole('DO') resolves ship from ef_emolument_forms.
// ─────────────────────────────────────────────────────────────

router.get("/forms/:form_id", requireFormRole("DO"), async (req, res) => {
  const formId = Number(req.params.form_id);
  const doShips = resolveDoShips(req);

  if (!Number.isInteger(formId) || formId < 1) {
    return res.status(400).json({ error: "Invalid form ID." });
  }

  try {
    const result = await doService.getForm(formId, doShips);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /do/forms/:form_id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /do/forms/:form_id/review
// DO marks form as reviewed. Forwards to FO.
// Body: { do_name, do_rank, do_date }
// do_svcno is taken from req.user_id (the DO themselves).
// ─────────────────────────────────────────────────────────────

router.post(
  "/forms/:form_id/review",
  requireFormRole("DO"),
  async (req, res) => {
    const formId = Number(req.params.form_id);
    const doShips = resolveDoShips(req);

    if (!Number.isInteger(formId) || formId < 1) {
      return res.status(400).json({ error: "Invalid form ID." });
    }

    // For scoped DOs, resolve their specific ship from formScope
    // requireFormRole attaches req.formScope = { ship, command }
    const doShip = req.isEmolAdmin
      ? "ALL"
      : req.formScope?.ship || doShips[0] || null;

    try {
      const result = await doService.reviewForm(
        formId,
        doShip,
        req.body,
        req.user_id,
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /do/forms/:form_id/review:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// ─────────────────────────────────────────────────────────────
// POST /do/forms/:form_id/reject
// DO rejects form. Resets status to NULL — personnel must re-fill.
// Body: { remarks }
// ─────────────────────────────────────────────────────────────

router.post(
  "/forms/:form_id/reject",
  requireFormRole("DO"),
  async (req, res) => {
    const formId = Number(req.params.form_id);

    if (!Number.isInteger(formId) || formId < 1) {
      return res.status(400).json({ error: "Invalid form ID." });
    }

    if (!req.body?.remarks?.trim()) {
      return res
        .status(400)
        .json({ error: "Rejection reason (remarks) is required." });
    }

    const doShip = req.isEmolAdmin ? "ALL" : req.formScope?.ship || null;

    try {
      const result = await doService.rejectForm(
        formId,
        doShip,
        req.body,
        req.user_id,
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /do/forms/:form_id/reject:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

module.exports = router;
