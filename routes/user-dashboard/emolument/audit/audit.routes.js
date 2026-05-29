/**
 * FILE: routes/user-dashboard/emolument/admin/audit.routes.js
 *
 * Audit log endpoints — EMOL_ADMIN only.
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  GET  /audit        → paginated audit log (with filters)
 *  GET  /audit/meta     → distinct action types + table names
 *                               (used to populate filter dropdowns)
 *
 * Query params for GET /audit:
 *   action      – exact action value  (e.g. UPDATE, REJECTED)
 *   tableName   – exact table name    (e.g. ef_personalinfos)
 *   performedBy – partial service number / user id
 *   recordKey   – partial record key
 *   dateFrom    – YYYY-MM-DD inclusive start
 *   dateTo      – YYYY-MM-DD inclusive end
 *   page        – page number (default 1)
 *   pageSize    – rows per page (default 50, max 200)
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");
const verifyToken = require("../../../../middware/authentication");
const { requireEmolRole } = require("../../../../middware/emolumentAuth");
const auditService = require("./audit.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for all routes in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All audit routes require authentication + EMOL_ADMIN role
router.use(verifyToken, requireEmolRole("EMOL_ADMIN"));

// ─────────────────────────────────────────────────────────────
// GET /admin/audit/meta
// Must be declared BEFORE /admin/audit to avoid 'meta' being
// treated as a query-string-only route catch-all.
// ─────────────────────────────────────────────────────────────

router.get("/meta", async (req, res) => {
  try {
    const result = await auditService.getFilterMeta();
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/audit/meta:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/audit
// ─────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const filters = {
    action: req.query.action || undefined,
    tableName: req.query.tableName || undefined,
    performedBy: req.query.performedBy || undefined,
    recordKey: req.query.recordKey || undefined,
    dateFrom: req.query.dateFrom || undefined,
    dateTo: req.query.dateTo || undefined,
  };

  try {
    const result = await auditService.listAuditLogs(
      filters,
      req.query.page,
      req.query.pageSize,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/audit:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
