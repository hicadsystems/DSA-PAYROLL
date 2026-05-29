/**
 * FILE: routes/user-dashboard/emolument/admin/audit.service.js
 *
 * Business logic for the emolument audit log viewer.
 * All mutations are EMOL_ADMIN only — enforced at route level.
 *
 * Functions:
 *   listAuditLogs   → paginated, filtered audit log records
 *   getFilterMeta   → distinct action types + table names for dropdowns
 */

"use strict";

const repo = require("./audit.repository");

// ─────────────────────────────────────────────────────────────
// LIST AUDIT LOGS
// ─────────────────────────────────────────────────────────────

/**
 * Returns a paginated page of audit log entries, optionally filtered.
 *
 * @param {object} filters   – { action, tableName, performedBy, recordKey, dateFrom, dateTo }
 * @param {number} page      – 1-based
 * @param {number} pageSize  – rows per page, capped at 200 in repo
 */
async function listAuditLogs(filters, page, pageSize) {
  try {
    const { logs, total } = await repo.getAuditLogs(filters, page, pageSize);

    // Parse JSON fields safely — old_values / new_values are stored as JSON strings
    const parsed = logs.map((row) => ({
      ...row,
      old_values: tryParseJSON(row.old_values),
      new_values: tryParseJSON(row.new_values),
    }));

    return {
      success: true,
      data: {
        logs: parsed,
        pagination: {
          total,
          page: Number(page) || 1,
          pageSize: Number(pageSize) || 50,
          pages: Math.ceil(total / (Number(pageSize) || 50)),
        },
      },
    };
  } catch (err) {
    console.error("❌ audit.service.listAuditLogs:", err);
    return {
      success: false,
      code: 500,
      message: "Failed to retrieve audit logs.",
    };
  }
}

// ─────────────────────────────────────────────────────────────
// FILTER METADATA
// ─────────────────────────────────────────────────────────────

/**
 * Returns distinct action types and table names from ef_audit_logs.
 * Used to populate the filter dropdowns on the frontend.
 */
async function getFilterMeta() {
  try {
    const [actionTypes, tableNames] = await Promise.all([
      repo.getAuditActionTypes(),
      repo.getAuditTableNames(),
    ]);
    return {
      success: true,
      data: { actionTypes, tableNames },
    };
  } catch (err) {
    console.error("❌ audit.service.getFilterMeta:", err);
    return {
      success: false,
      code: 500,
      message: "Failed to retrieve filter metadata.",
    };
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function tryParseJSON(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value; // already parsed by driver
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

module.exports = {
  listAuditLogs,
  getFilterMeta,
};
