"use strict";

/**
 * FILE: routes/user-dashboard/emolument/system/system.repository.js
 *
 * All SQL for ef_control CRUD.
 * This is now the single source of truth for emolument open/close state.
 *
 * Table columns (after migration):
 *   Id, processingyear, ship, formtype, startdate, enddate,
 *   status, notes, createdby, datecreated, updatedby, updatedat
 */

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * Return every ef_control row ordered by processingyear DESC, Id ASC.
 */
async function getAllControlRows() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       Id, processingyear, ship, formtype,
       startdate, enddate, status, notes,
       createdby, datecreated, updatedby, updatedat
     FROM ef_control
     ORDER BY processingyear DESC, Id ASC`,
  );
  return rows;
}

/**
 * Return a single ef_control row by primary key.
 */
async function getControlRowById(id) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       Id, processingyear, ship, formtype,
       startdate, enddate, status, notes,
       createdby, datecreated, updatedby, updatedat
     FROM ef_control
     WHERE Id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Resolve the effective open/close state for a given ship + formtype.
 *
 * Priority:
 *   1. Exact ship + formtype match
 *   2. Exact ship + formtype = 'ALL'
 *   3. ship = 'All' + formtype match
 *   4. ship = 'All' + formtype = 'ALL'   ← global fallback
 *
 * Returns the winning row or null if no row exists at all.
 */
async function resolveEffectiveStatus(shipName, formtype) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT Id, ship, formtype, status, startdate, enddate, processingyear
     FROM ef_control
     WHERE NOW() BETWEEN startdate AND enddate
     ORDER BY
       (ship = ? AND formtype = ?)    DESC,
       (ship = ? AND formtype = 'ALL') DESC,
       (ship = 'All' AND formtype = ?) DESC,
       (ship = 'All' AND formtype = 'ALL') DESC
     LIMIT 1`,
    [shipName, formtype, shipName, formtype],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new ef_control row.
 * Returns the newly created Id.
 */
async function createControlRow({
  processingyear,
  ship,
  formtype,
  startdate,
  enddate,
  status,
  notes,
  createdby,
}) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `INSERT INTO ef_control
       (processingyear, ship, formtype, startdate, enddate, status, notes, createdby, datecreated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      String(processingyear),
      ship || "All",
      formtype || "ALL",
      startdate,
      enddate,
      status || "Open",
      notes || null,
      createdby,
    ],
  );
  return result.insertId;
}

// ─────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────

/**
 * Update an existing ef_control row by Id.
 * Returns true if a row was modified.
 */
async function updateControlRow(
  id,
  {
    processingyear,
    ship,
    formtype,
    startdate,
    enddate,
    status,
    notes,
    updatedby,
  },
) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_control
     SET processingyear = ?,
         ship           = ?,
         formtype       = ?,
         startdate      = ?,
         enddate        = ?,
         status         = ?,
         notes          = ?,
         updatedby      = ?,
         updatedat      = NOW()
     WHERE Id = ?`,
    [
      String(processingyear),
      ship || "All",
      formtype || "ALL",
      startdate,
      enddate,
      status || "Open",
      notes || null,
      updatedby,
      id,
    ],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────

/**
 * Hard-delete a control row by Id.
 * Returns true if a row was removed.
 */
async function deleteControlRow(id) {
  pool.useDatabase(DB());
  const [result] = await pool.query(`DELETE FROM ef_control WHERE Id = ?`, [
    id,
  ]);
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// AUDIT (re-uses the shared pattern from system.repository)
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

// ─────────────────────────────────────────────────────────────
// SET ALL SHIPS OPEN STATUS
// Called when a Global (ship='All') ef_control row is created
// or updated. Syncs ef_ships.openship to match the control status.
//   open=1  → Open/Reopen  → personnel can access forms
//   open=0  → Close        → forms blocked at ship level
// ─────────────────────────────────────────────────────────────
async function setAllShipsOpenStatus(open) {
  pool.useDatabase(DB());
  await pool.query(`UPDATE ef_ships SET openship = ?`, [open ? 1 : 0]);
}

module.exports = {
  getAllControlRows,
  getControlRowById,
  resolveEffectiveStatus,
  createControlRow,
  updateControlRow,
  deleteControlRow,
  setAllShipsOpenStatus,
  insertAuditLog,
};
