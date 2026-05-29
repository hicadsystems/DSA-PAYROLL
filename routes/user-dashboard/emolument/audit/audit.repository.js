/**
 * FILE: routes/user-dashboard/emolument/admin/audit.repository.js
 *
 * SQL for reading ef_audit_logs.
 *
 * Functions:
 *   getAuditLogs        → paginated, filterable audit log query
 *   getAuditActionTypes → distinct action values stored in ef_audit_logs
 *   getAuditTableNames  → distinct table_name values stored in ef_audit_logs
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// AUDIT LOGS — paginated read
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} filters
 * @param {string}  [filters.action]      – exact match on action column
 * @param {string}  [filters.tableName]   – exact match on table_name column
 * @param {string}  [filters.performedBy] – partial match on performed_by
 * @param {string}  [filters.recordKey]   – partial match on record_key
 * @param {string}  [filters.dateFrom]    – ISO date string, inclusive start
 * @param {string}  [filters.dateTo]      – ISO date string, inclusive end
 * @param {number}  page                  – 1-based page number
 * @param {number}  pageSize              – rows per page (max 200)
 * @returns {{ logs: object[], total: number }}
 */
async function getAuditLogs(filters = {}, page = 1, pageSize = 50) {
  pool.useDatabase(DB());

  const safePageSize = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const safeOffset = (Math.max(Number(page) || 1, 1) - 1) * safePageSize;

  const conditions = [];
  const params = [];

  if (filters.action) {
    conditions.push("action = ?");
    params.push(filters.action);
  }
  if (filters.tableName) {
    conditions.push("table_name = ?");
    params.push(filters.tableName);
  }
  if (filters.performedBy) {
    conditions.push("performed_by LIKE ?");
    params.push(`%${filters.performedBy}%`);
  }
  if (filters.recordKey) {
    conditions.push("record_key LIKE ?");
    params.push(`%${filters.recordKey}%`);
  }
  if (filters.dateFrom) {
    conditions.push("performed_at >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    // include the full end day
    conditions.push("performed_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(filters.dateTo);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM ef_audit_logs ${where}`,
    params,
  );
  const total = countRows[0]?.total ?? 0;

  const [logs] = await pool.query(
    `SELECT
       id,
       table_name,
       action,
       record_key,
       old_values,
       new_values,
       performed_by,
       ip_address,
       performed_at
     FROM ef_audit_logs
     ${where}
     ORDER BY performed_at DESC
     LIMIT ? OFFSET ?`,
    [...params, safePageSize, safeOffset],
  );

  return { logs, total };
}

// ─────────────────────────────────────────────────────────────
// DISTINCT ENUMERATIONS — used to populate filter dropdowns
// ─────────────────────────────────────────────────────────────

/**
 * Returns every distinct action value stored in ef_audit_logs,
 * sorted alphabetically.
 * @returns {string[]}
 */
async function getAuditActionTypes() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT DISTINCT action
     FROM ef_audit_logs
     WHERE action IS NOT NULL AND action <> ''
     ORDER BY action ASC`,
  );
  return rows.map((r) => r.action);
}

/**
 * Returns every distinct table_name value stored in ef_audit_logs,
 * sorted alphabetically.
 * @returns {string[]}
 */
async function getAuditTableNames() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT DISTINCT table_name
     FROM ef_audit_logs
     WHERE table_name IS NOT NULL AND table_name <> ''
     ORDER BY table_name ASC`,
  );
  return rows.map((r) => r.table_name);
}

module.exports = {
  getAuditLogs,
  getAuditActionTypes,
  getAuditTableNames,
};
