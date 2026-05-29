/**
 * FILE: routes/user-dashboard/emolument/fo/fo.routes.js
 *
 * Routes for the First Officer (FO) approval workflow.
 *
 * All routes: verifyToken + requireFormRole('FO') or requireEmolRole('FO')
 * EMOL_ADMIN passes all guards automatically.
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  GET  /fo/ship/:ship/personnel          → list DO_REVIEWED forms on ship
 *  GET  /fo/forms/:form_id               → view full form detail
 *  POST /fo/forms/:form_id/approve       → individual approve → FO_APPROVED
 *  POST /fo/ship/:ship/bulk-approve      → bulk approve by ship + classes
 *  POST /fo/forms/:form_id/reject        → reject → reset to NULL
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
} = require("../../../../middware/emolumentAuth");
const foService = require("./fo.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for all routes in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All routes require authentication
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────
// HELPER — extract FO's assigned ships from req.emolRoles
// Returns array of ship names, or 'ALL' if EMOL_ADMIN.
// ─────────────────────────────────────────────────────────────

function resolveForShips(req) {
  if (req.isEmolAdmin) return "ALL";
  return (req.emolRoles || [])
    .filter((r) => r.role === "FO" && r.scope_type === "SHIP" && r.scope_value)
    .map((r) => r.scope_value);
}

// ─────────────────────────────────────────────────────────────
// GET /fo/ship/:ship/personnel
// List all DO_REVIEWED forms on a ship.
// requireEmolRole('FO') scopes from req.params.ship.
// ─────────────────────────────────────────────────────────────

router.get("/ship/:ship/personnel", requireEmolRole("FO"), async (req, res) => {
  const { ship } = req.params;
  try {
    const result = await foService.listDoReviewedForms(ship);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /fo/ship/:ship/personnel:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /fo/forms/:form_id
// View full form detail. requireFormRole resolves ship from form.
// ─────────────────────────────────────────────────────────────

router.get("/forms/:form_id", requireFormRole("FO"), async (req, res) => {
  const formId = Number(req.params.form_id);
  const foShips = resolveForShips(req);

  if (!Number.isInteger(formId) || formId < 1) {
    return res.status(400).json({ error: "Invalid form ID." });
  }

  try {
    const result = await foService.getForm(formId, foShips);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /fo/forms/:form_id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /fo/forms/:form_id/approve
// Individual approval. fo_svcno taken from req.user_id.
// Body: { fo_name, fo_rank, fo_date }
// ─────────────────────────────────────────────────────────────

router.post(
  "/forms/:form_id/approve",
  requireFormRole("FO"),
  async (req, res) => {
    const formId = Number(req.params.form_id);

    if (!Number.isInteger(formId) || formId < 1) {
      return res.status(400).json({ error: "Invalid form ID." });
    }

    const foShip = req.isEmolAdmin ? "ALL" : req.formScope?.ship || null;

    try {
      const result = await foService.approveForm(
        formId,
        foShip,
        req.body,
        req.user_id,
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /fo/forms/:form_id/approve:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// ─────────────────────────────────────────────────────────────
// POST /fo/ship/:ship/bulk-approve
// Bulk approval for a ship + classes combination.
// requireEmolRole('FO') scopes from req.params.ship.
// Body: { fo_name, fo_rank, fo_date, classes }
//
// Note: classes is required — FO bulk processes one class at
// a time (1=Officers, 2=Ratings, 3=Training) to match old SP.
// ─────────────────────────────────────────────────────────────

router.post(
  "/ship/:ship/bulk-approve",
  requireEmolRole("FO"),
  async (req, res) => {
    const { ship } = req.params;

    if (!req.body?.classes) {
      return res
        .status(400)
        .json({
          error: "classes is required (1=Officers, 2=Ratings, 3=Training).",
        });
    }

    try {
      const result = await foService.approveBulk(
        ship,
        req.body,
        req.user_id,
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /fo/ship/:ship/bulk-approve:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// ─────────────────────────────────────────────────────────────
// POST /fo/forms/:form_id/reject
// Reject a DO_REVIEWED form. Resets to NULL.
// Body: { remarks }
// ─────────────────────────────────────────────────────────────

router.post(
  "/forms/:form_id/reject",
  requireFormRole("FO"),
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

    const foShip = req.isEmolAdmin ? "ALL" : req.formScope?.ship || null;

    try {
      const result = await foService.rejectForm(
        formId,
        foShip,
        req.body,
        req.user_id,
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /fo/forms/:form_id/reject:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

module.exports = router;
