"use strict";

/**
 * FILE: routes/user-dashboard/emolument/system/system.routes.js
 *
 * CRUD endpoints for ef_control — the single source of truth
 * for emolument open / close state.
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  GET    /system/control           → list all rows
 *  GET    /system/control/:id       → single row
 *  POST   /system/control           → create row  (EMOL_ADMIN)
 *  PUT    /system/control/:id       → update row  (EMOL_ADMIN)
 *  DELETE /system/control/:id       → delete row  (EMOL_ADMIN)
 *
 *  GET    /system/control/resolve   → resolve effective status
 *         ?ship=NNS_ARADU&formtype=OFFICERS
 *
 * ─────────────────────────────────────────────────────────────
 * Mount in your main router as:
 *   const controlRoutes = require('./control.routes');
 *   router.use('/system/control', controlRoutes);
 * ─────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");

const verifyToken = require("../../../../middware/authentication");
const {
  requireEmolRole,
  requireAnyEmolRole,
} = require("../../../../middware/emolumentAuth");
const controlService = require("./system.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for every request in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All routes require a valid token
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function parseId(param) {
  const id = Number(param);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendResult(res, result) {
  if (!result.success) {
    return res.status(result.code).json({ error: result.message });
  }
  const body = { message: result.message };
  if (result.data !== undefined && result.data !== null)
    body.data = result.data;
  return res.json(body);
}

// ─────────────────────────────────────────────────────────────
// GET /system/control/resolve
// Query: ?ship=NNS_ARADU&formtype=OFFICERS
// Any elevated emolument role — used by form-submission routes.
// NOTE: must be declared before /:id to avoid 'resolve' being
//       treated as a numeric id parameter.
// ─────────────────────────────────────────────────────────────

router.get("/resolve", requireAnyEmolRole, async (req, res) => {
  const { ship, formtype } = req.query;

  if (!ship) {
    return res.status(400).json({ error: "ship query param is required." });
  }

  try {
    const result = await controlService.resolveEffectiveStatus(
      ship,
      formtype || "ALL",
    );
    return res.json(result);
  } catch (err) {
    console.error("❌ GET /system/control/resolve:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /system/control
// List all ef_control rows — any elevated emolument role.
// ─────────────────────────────────────────────────────────────

router.get("/", requireAnyEmolRole, async (req, res) => {
  try {
    const result = await controlService.listControlRows();
    // Return the array directly so the frontend can treat the
    // response as a plain array (matches the existing /status pattern).
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /system/control:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /system/control/:id
// Single row — any elevated emolument role.
// ─────────────────────────────────────────────────────────────

router.get("/:id", requireAnyEmolRole, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid control row ID." });

  try {
    const result = await controlService.getControlRow(id);
    return sendResult(res, result);
  } catch (err) {
    console.error("❌ GET /system/control/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /system/control
// Create a new cycle row — EMOL_ADMIN only.
//
// Body:
//   processingyear  string  required   e.g. "2026"
//   ship            string  optional   ship name or "All" (default "All")
//   formtype        string  optional   ALL|OFFICERS|RATINGS|TRAINING (default "ALL")
//   startdate       string  required   ISO datetime
//   enddate         string  required   ISO datetime
//   status          string  optional   Open|Reopen|Close (default "Open")
//   notes           string  optional
// ─────────────────────────────────────────────────────────────

router.post("/", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  const { processingyear, ship, formtype, startdate, enddate, status, notes } =
    req.body;

  if (!processingyear || !startdate || !enddate) {
    return res
      .status(400)
      .json({ error: "processingyear, startdate and enddate are required." });
  }

  try {
    const result = await controlService.createControlRow(
      { processingyear, ship, formtype, startdate, enddate, status, notes },
      req.user_id,
      req.ip,
    );
    if (!result.success) return sendResult(res, result);
    // 201 Created with the new row + its generated Id
    return res.status(201).json({
      message: result.message,
      id: result.data.Id,
      data: result.data,
    });
  } catch (err) {
    console.error("❌ POST /system/control:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /system/control/:id
// Update an existing cycle row — EMOL_ADMIN only.
// Body: same fields as POST, all required for a full replace.
// ─────────────────────────────────────────────────────────────

router.put("/:id", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid control row ID." });

  const { processingyear, ship, formtype, startdate, enddate, status, notes } =
    req.body;

  if (!processingyear || !startdate || !enddate) {
    return res
      .status(400)
      .json({ error: "processingyear, startdate and enddate are required." });
  }

  try {
    const result = await controlService.updateControlRow(
      id,
      { processingyear, ship, formtype, startdate, enddate, status, notes },
      req.user_id,
      req.ip,
    );
    return sendResult(res, result);
  } catch (err) {
    console.error("❌ PUT /system/control/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /system/control/:id
// Remove a cycle row — EMOL_ADMIN only.
// ─────────────────────────────────────────────────────────────

router.delete("/:id", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid control row ID." });

  try {
    const result = await controlService.deleteControlRow(
      id,
      req.user_id,
      req.ip,
    );
    return sendResult(res, result);
  } catch (err) {
    console.error("❌ DELETE /system/control/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;