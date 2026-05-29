/**
 * FILE: routes/user-dashboard/emolument/system/ships.repository.js
 *
 * SQL for ef_ships and ef_commands (read + CRUD).
 *
 * ef_ships  columns: Id, code, shipName, LandSea, commandid, openship
 * ef_commands columns: Id, code, commandName
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// COMMANDS — read-only (admin cannot create/delete commands)
// ─────────────────────────────────────────────────────────────

async function getAllCommands() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT Id, code, commandName
     FROM ef_commands
     ORDER BY commandName ASC`,
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// SHIPS — list
// ─────────────────────────────────────────────────────────────

async function getAllShips({ commandid, openship } = {}) {
  pool.useDatabase(DB());

  const conditions = [];
  const params = [];

  if (commandid !== undefined) {
    conditions.push("s.commandid = ?");
    params.push(commandid);
  }
  if (openship !== undefined) {
    conditions.push("s.openship = ?");
    params.push(openship ? 1 : 0);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT s.Id, s.code, s.shipName, s.LandSea, s.commandid, s.openship,
            c.commandName
     FROM ef_ships s
     LEFT JOIN ef_commands c ON c.Id = s.commandid
     ${where}
     ORDER BY c.commandName ASC, s.shipName ASC`,
    params,
  );
  return rows;
}

async function getShipById(id) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT s.Id, s.code, s.shipName, s.LandSea, s.commandid, s.openship,
            c.commandName
     FROM ef_ships s
     LEFT JOIN ef_commands c ON c.Id = s.commandid
     WHERE s.Id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// SHIPS — create / update / delete
// ─────────────────────────────────────────────────────────────

async function createShip({ code, shipName, LandSea, commandid, openship }) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `INSERT INTO ef_ships (code, shipName, LandSea, commandid, openship)
     VALUES (?, ?, ?, ?, ?)`,
    [code ?? null, shipName, LandSea ?? null, commandid, openship ? 1 : 0],
  );
  return result.insertId;
}

async function updateShip(
  id,
  { code, shipName, LandSea, commandid, openship },
) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_ships
     SET code      = ?,
         shipName  = ?,
         LandSea   = ?,
         commandid = ?,
         openship  = ?
     WHERE Id = ?`,
    [code ?? null, shipName, LandSea ?? null, commandid, openship ? 1 : 0, id],
  );
  return result.affectedRows > 0;
}

async function deleteShip(id) {
  pool.useDatabase(DB());
  const [result] = await pool.query(`DELETE FROM ef_ships WHERE Id = ?`, [id]);
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// AUDIT
// ─────────────────────────────────────────────────────────────

async function insertAuditLog({
  tableName,
  action,
  recordKey,
  oldValues,
  newValues,
  performedBy,
  ipAddress,
}) {
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_audit_logs
       (table_name, action, record_key, old_values, new_values, performed_by, ip_address, performed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      tableName,
      action,
      recordKey,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      performedBy,
      ipAddress || null,
    ],
  );
}

module.exports = {
  getAllCommands,
  getAllShips,
  getShipById,
  createShip,
  updateShip,
  deleteShip,
  insertAuditLog,
};
