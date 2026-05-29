/**
 * FILE: routes/user-dashboard/emolument/system/ships.routes.js
 *
 * Ships and Commands management.
 * Mounted at /system by the emolument index router.
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  Commands (read-only):
 *  GET    /system/commands               → list all commands
 *
 *  Ships:
 *  GET    /system/ships                  → list ships (?commandid=&openship=)
 *  GET    /system/ships/:id              → single ship
 *  POST   /system/ships                  → create ship      (EMOL_ADMIN)
 *  PUT    /system/ships/:id              → update ship      (EMOL_ADMIN)
 *  DELETE /system/ships/:id              → delete ship      (EMOL_ADMIN)
 *
 * ─────────────────────────────────────────────────────────────
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");

const verifyToken = require("../../../../middware/authentication");
const {
  requireEmolRole,
  requireAnyEmolRole,
} = require("../../../../middware/emolumentAuth");
const repo = require("./ships.repository");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function parseId(param) {
  const n = Number(param);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ─────────────────────────────────────────────────────────────
// GET /system/commands
// ─────────────────────────────────────────────────────────────

router.get("/commands", requireAnyEmolRole, async (req, res) => {
  try {
    const rows = await repo.getAllCommands();
    return res.json(rows);
  } catch (err) {
    console.error("❌ GET /system/commands:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /system/ships
// Query: ?commandid=3&openship=1
// ─────────────────────────────────────────────────────────────

router.get("/ships", requireAnyEmolRole, async (req, res) => {
  const filters = {};
  if (req.query.commandid !== undefined)
    filters.commandid = Number(req.query.commandid);
  if (req.query.openship !== undefined)
    filters.openship =
      req.query.openship === "1" || req.query.openship === "true";

  try {
    const rows = await repo.getAllShips(filters);
    return res.json(rows);
  } catch (err) {
    console.error("❌ GET /system/ships:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /system/ships/:id
// ─────────────────────────────────────────────────────────────

router.get("/ships/:id", requireAnyEmolRole, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid ship ID." });

  try {
    const ship = await repo.getShipById(id);
    if (!ship) return res.status(404).json({ error: "Ship not found." });
    return res.json(ship);
  } catch (err) {
    console.error("❌ GET /system/ships/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /system/ships
// Body: { shipName, commandid, code?, LandSea?, openship? }
// ─────────────────────────────────────────────────────────────

router.post("/ships", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  const { shipName, commandid, code, LandSea, openship } = req.body;

  if (!shipName?.trim())
    return res.status(400).json({ error: "shipName is required." });
  if (!commandid)
    return res.status(400).json({ error: "commandid is required." });

  try {
    const insertId = await repo.createShip({
      code: code?.trim() || null,
      shipName: shipName.trim(),
      LandSea: LandSea?.trim() || null,
      commandid: Number(commandid),
      openship: openship ?? false,
    });

    await repo.insertAuditLog({
      tableName: "ef_ships",
      action: "INSERT",
      recordKey: String(insertId),
      oldValues: null,
      newValues: { shipName, commandid, code, LandSea, openship },
      performedBy: req.user_id,
      ipAddress: req.ip,
    });

    const created = await repo.getShipById(insertId);
    return res.status(201).json({ message: "Ship created.", data: created });
  } catch (err) {
    console.error("❌ POST /system/ships:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /system/ships/:id
// Body: { shipName, commandid, code?, LandSea?, openship? }
// ─────────────────────────────────────────────────────────────

router.put("/ships/:id", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid ship ID." });

  const { shipName, commandid, code, LandSea, openship } = req.body;
  if (!shipName?.trim())
    return res.status(400).json({ error: "shipName is required." });
  if (!commandid)
    return res.status(400).json({ error: "commandid is required." });

  try {
    const existing = await repo.getShipById(id);
    if (!existing) return res.status(404).json({ error: "Ship not found." });

    const ok = await repo.updateShip(id, {
      code: code?.trim() || null,
      shipName: shipName.trim(),
      LandSea: LandSea?.trim() || null,
      commandid: Number(commandid),
      openship: openship ?? false,
    });

    if (!ok) return res.status(500).json({ error: "Failed to update ship." });

    await repo.insertAuditLog({
      tableName: "ef_ships",
      action: "UPDATE",
      recordKey: String(id),
      oldValues: existing,
      newValues: { shipName, commandid, code, LandSea, openship },
      performedBy: req.user_id,
      ipAddress: req.ip,
    });

    const updated = await repo.getShipById(id);
    return res.json({ message: "Ship updated.", data: updated });
  } catch (err) {
    console.error("❌ PUT /system/ships/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /system/ships/:id
// ─────────────────────────────────────────────────────────────

router.delete("/ships/:id", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid ship ID." });

  try {
    const existing = await repo.getShipById(id);
    if (!existing) return res.status(404).json({ error: "Ship not found." });

    const ok = await repo.deleteShip(id);
    if (!ok) return res.status(500).json({ error: "Failed to delete ship." });

    await repo.insertAuditLog({
      tableName: "ef_ships",
      action: "DELETE",
      recordKey: String(id),
      oldValues: existing,
      newValues: null,
      performedBy: req.user_id,
      ipAddress: req.ip,
    });

    return res.json({ message: `Ship '${existing.shipName}' deleted.` });
  } catch (err) {
    console.error("❌ DELETE /system/ships/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
