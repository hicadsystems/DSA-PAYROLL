/**
 * FILE: routes/user-dashboard/emolument/admin/admin.routes.js
 *
 * Routes for EMOL_ADMIN functions.
 * Every route requires verifyToken + requireEmolRole('EMOL_ADMIN').
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  Role management:
 *  GET    /admin/roles                        → list active role assignments
 *  POST   /admin/roles/assign                 → assign a role
 *  DELETE /admin/roles/:role_id/revoke        → revoke a role
 *
 *  Role menus:
 *  GET    /admin/menus                        → list all menus (grouped by MenuGroup)
 *  GET    /admin/roles/:role/menus            → menus visible to a given emol role
 *  PUT    /admin/roles/:role/menus            → set menu visibility for a role
 *                                               Body: { menuIds: [1, 3, 5] }
 *
 *  Personnel:
 *  GET    /admin/personnel                    → search personnel (filters + pagination)
 *  GET    /admin/personnel/search             → quick search by ?q= (service no or name)
 *  GET    /admin/personnel/:svcno             → get single personnel record
 *  PUT    /admin/personnel/:svcno/contact     → update email + phone
 *  PUT    /admin/personnel/commission         → update service number (JSON body)
 *  POST   /admin/personnel/change-svcno       → alias for commission (frontend compat)
 *  POST   /admin/personnel/batch-upload       → upsert personnel batch (JSON array)
 *  POST   /admin/personnel/commission-upload  → commission update from JSON payload
 *  DELETE /admin/personnel/exits/:payrollclass → remove exit personnel
 *
 *  Ships (admin-scoped read):
 *  GET    /admin/ships                        → list all ships (flat, for dropdowns)
 *
 *  Form actions:
 *  GET    /admin/bulk-approve/preview         → preview forms eligible for bulk approve (?ship=)
 *  POST   /admin/bulk-approve                 → bulk approve ship (bypass DO)
 *                                               Body: { ship, fo_name, fo_rank, fo_date }
 *  POST   /admin/forms/:form_id/reject        → reject any form at any stage
 *
 *  Payroll sync:
 *  GET    /admin/payroll/sync-preview         → list confirmed forms pending sync (?payrollclass=)
 *  POST   /admin/payroll/sync                 → sync confirmed → Updated (?all=true or body.payrollclass)
 *
 *  Extend cycle:
 *  POST   /admin/system/extend_cycle          → extend a cycle's end date (reopen)
 *                                               Body: { control_id, new_enddate, notes? }
 *
 *  Form history (admin access to any personnel):
 *  GET    /admin/forms/:svcno/years           → list available form years for a personnel
 *  GET    /admin/forms/:svcno/current         → current period form + approval status
 *  GET    /admin/forms/:svcno/history/:year   → historical snapshot for a given year
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");
const verifyToken = require("../../../../middware/authentication");
const { requireEmolRole } = require("../../../../middware/emolumentAuth");
const adminService = require("./admin.service");
const shipsRepo = require("../system/ships.repository");
const adminRepo = require("./admin.repository");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});
router.use(verifyToken, requireEmolRole("EMOL_ADMIN"));

// ─────────────────────────────────────────────────────────────
// ROLE MANAGEMENT
// ─────────────────────────────────────────────────────────────

router.get("/roles", async (req, res) => {
  const filters = {
    role: req.query.role || undefined,
    scope_type: req.query.scope_type || undefined,
    scope_value: req.query.scope_value || undefined,
    user_id: req.query.user_id || undefined,
  };
  try {
    const result = await adminService.listRoles(filters);
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/roles:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/roles/assign", async (req, res) => {
  try {
    const result = await adminService.assignRole(req.body, req.user_id, req.ip);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.status(201).json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/roles/assign:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/roles/:role_id/revoke", async (req, res) => {
  const roleId = Number(req.params.role_id);
  if (!Number.isInteger(roleId) || roleId < 1)
    return res.status(400).json({ error: "Invalid role ID." });
  try {
    const result = await adminService.revokeRole(roleId, req.user_id, req.ip);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ DELETE /admin/roles/:role_id/revoke:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// ROLE MENUS
// Admin can control which nav sections each emol role sees.
// ef_rolemenus maps MenuId → RoleId, where RoleId here is the
// emol role name string ('DO','FO','CPO','EMOL_ADMIN') stored
// as a Code in ef_menus for quick lookup.
// ─────────────────────────────────────────────────────────────

// GET /admin/menus
// Returns all menus grouped by MenuGroupId, with IsActive flag.
router.get("/menus", async (req, res) => {
  try {
    const result = await adminService.listMenus();
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/menus:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/roles/:role/menus
// Returns menu Ids visible to the given emol role.
router.get("/roles/:role/menus", async (req, res) => {
  try {
    const result = await adminService.getMenusForRole(req.params.role);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/roles/:role/menus:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /admin/roles/:role/menus
// Body: { menuIds: [1, 3, 5] }
// Full replace — removes any existing assignments for the role,
// then inserts the supplied set.
router.put("/roles/:role/menus", async (req, res) => {
  const { menuIds } = req.body;
  if (!Array.isArray(menuIds))
    return res.status(400).json({ error: "menuIds must be an array." });
  try {
    const result = await adminService.setMenusForRole(
      req.params.role,
      menuIds,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ PUT /admin/roles/:role/menus:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// PERSONNEL MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /admin/personnel
// Full filter search used by ships.html and the main personnel section.
router.get("/personnel", async (req, res) => {
  const filters = {
    serviceNumber: req.query.serviceNumber || undefined,
    surname: req.query.surname || undefined,
    ship: req.query.ship || undefined,
    command: req.query.command || undefined,
    payrollclass: req.query.payrollclass || undefined,
    status: req.query.status !== undefined ? req.query.status : undefined,
  };
  try {
    const result = await adminService.searchPersonnel(
      filters,
      req.query.page,
      req.query.pageSize,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/personnel:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/personnel/search?q=
// Quick single-field search used by personnel.html.
// Tries to match as service number prefix first, then as surname prefix.
router.get("/personnel/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q is required." });

  // Heuristic: starts with a letter that looks like a service-no prefix → serviceNumber,
  // otherwise treat as surname search.  Both are index-safe prefix matches.
  const looksLikeSvcNo = /^[A-Za-z]\d/i.test(q);
  const filters = looksLikeSvcNo ? { serviceNumber: q } : { surname: q };

  try {
    const result = await adminService.searchPersonnel(filters, 1, 50);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/personnel/search:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /admin/personnel/commission  — JSON body: { old_svc_no, new_svc_no }
// MUST be before /:svcno routes.
router.put("/personnel/commission", async (req, res) => {
  try {
    const result = await adminService.updateServiceNumber(
      req.body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ PUT /admin/personnel/commission:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/personnel/change-svcno  — frontend compat alias for commission update
// Body: { old_svc_no, new_svc_no }
router.post("/personnel/change-svcno", async (req, res) => {
  try {
    const result = await adminService.updateServiceNumber(
      req.body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/personnel/change-svcno:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/personnel/batch-upload
// Body: JSON array of personnel objects (same shape as /admin/upload/personnel)
router.post("/personnel/batch-upload", async (req, res) => {
  if (!req.body || (Array.isArray(req.body) && req.body.length === 0))
    return res
      .status(400)
      .json({
        error: "Request body must contain at least one personnel record.",
      });
  try {
    const result = await adminService.uploadPersonnel(
      req.body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/personnel/batch-upload:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/personnel/commission-upload
// Accepts an array of commission change objects: [{ old_svc_no, new_svc_no }, ...]
// Processes each in sequence, collecting successes and failures.
router.post("/personnel/commission-upload", async (req, res) => {
  const records = Array.isArray(req.body) ? req.body : [req.body];
  if (!records.length)
    return res
      .status(400)
      .json({ error: "At least one commission record is required." });

  const results = { updated: 0, failed: [] };

  for (const rec of records) {
    const { old_svc_no, new_svc_no } = rec;
    if (!old_svc_no || !new_svc_no) {
      results.failed.push({
        record: old_svc_no ?? "unknown",
        reason: "old_svc_no and new_svc_no are required.",
      });
      continue;
    }
    try {
      const r = await adminService.updateServiceNumber(
        rec,
        req.user_id,
        req.ip,
      );
      if (!r.success) {
        results.failed.push({ record: old_svc_no, reason: r.message });
      } else {
        results.updated++;
      }
    } catch (err) {
      results.failed.push({ record: old_svc_no, reason: err.message });
    }
  }

  return res.json({
    message: `Commission upload complete. ${results.updated} updated, ${results.failed.length} failed.`,
    data: results,
  });
});

// DELETE /admin/personnel/exits/:payrollclass
router.delete("/personnel/exits/:payrollclass", async (req, res) => {
  const { payrollclass } = req.params;
  try {
    const result = await adminService.removeExitPersonnel(
      payrollclass,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ DELETE /admin/personnel/exits/:payrollclass:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/personnel/:svcno
router.get("/personnel/:svcno", async (req, res) => {
  try {
    const result = await adminService.getPersonnel(req.params.svcno);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/personnel/:svcno:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /admin/personnel/:svcno/contact
router.put("/personnel/:svcno/contact", async (req, res) => {
  try {
    const result = await adminService.updateContact(
      req.params.svcno,
      req.body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ PUT /admin/personnel/:svcno/contact:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/upload/personnel  — original route kept for backward compat
router.post("/upload/personnel", async (req, res) => {
  if (!req.body || (Array.isArray(req.body) && req.body.length === 0))
    return res
      .status(400)
      .json({
        error: "Request body must contain at least one personnel record.",
      });
  try {
    const result = await adminService.uploadPersonnel(
      req.body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/upload/personnel:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// SHIPS (admin-scoped read — flat list for dropdowns)
// ─────────────────────────────────────────────────────────────

// GET /admin/ships
// Returns a flat list of ships joined with command name.
router.get("/ships", async (req, res) => {
  try {
    const rows = await shipsRepo.getAllShips();
    return res.json(rows);
  } catch (err) {
    console.error("❌ GET /admin/ships:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// FORM ACTIONS
// ─────────────────────────────────────────────────────────────

// GET /admin/bulk-approve/preview?ship=NNS+BEECROFT
// Returns count + list of personnel with Status='Filled' on that ship.
router.get("/bulk-approve/preview", async (req, res) => {
  const ship = req.query.ship;
  if (!ship)
    return res.status(400).json({ error: "ship query param is required." });
  try {
    const result = await adminService.bulkApprovePreview(ship);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/bulk-approve/preview:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/bulk-approve
// Body: { ship, fo_name, fo_rank, fo_date }
router.post("/bulk-approve", async (req, res) => {
  const { ship, fo_name, fo_rank, fo_date } = req.body;
  if (!ship) return res.status(400).json({ error: "ship is required." });
  try {
    const result = await adminService.bulkApproveShip(
      ship,
      { fo_name, fo_rank, fo_date },
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/bulk-approve:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/ship/:ship/bulk-approve  — original URL kept for backward compat
router.post("/ship/:ship/bulk-approve", async (req, res) => {
  const { ship } = req.params;
  try {
    const result = await adminService.bulkApproveShip(
      ship,
      req.body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/ship/:ship/bulk-approve:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/forms/:form_id/reject
router.post("/forms/:form_id/reject", async (req, res) => {
  const formId = Number(req.params.form_id);
  if (!Number.isInteger(formId) || formId < 1)
    return res.status(400).json({ error: "Invalid form ID." });
  try {
    const result = await adminService.rejectForm(
      formId,
      req.body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/forms/:form_id/reject:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// PAYROLL SYNC
// ─────────────────────────────────────────────────────────────

// Payroll class labels (1-5):
//   1 = OFFICERS
//   2 = W/OFFICERS
//   3 = RATE A
//   4 = RATE B
//   5 = RATE C
// Frontend can send payrollclass=1..5 OR payrollclass=ALL.

// GET /admin/payroll/sync-preview?payrollclass=1 (or ALL)
// Returns confirmed-but-unsynced personnel without committing anything.
router.get("/payroll/sync-preview", async (req, res) => {
  const cls = req.query.payrollclass;
  if (!cls)
    return res
      .status(400)
      .json({ error: "payrollclass is required. Use 1-5 or ALL." });

  try {
    const result = await adminService.syncPayrollPreview(cls);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/payroll/sync-preview:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/payroll/sync
// Body: { payrollclass }  — accepts 1-5 or "ALL"
router.post("/payroll/sync", async (req, res) => {
  if (!req.body?.payrollclass)
    return res
      .status(400)
      .json({ error: "payrollclass is required. Use 1-5 or ALL." });
  try {
    const result = await adminService.syncPayroll(
      req.body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/payroll/sync:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// EXTEND CYCLE (reopen with new end date)
// Body: { control_id, new_enddate, notes? }
// Sets ef_control.status = 'Reopen' and extends enddate.
// ─────────────────────────────────────────────────────────────

router.post("/system/extend_cycle", async (req, res) => {
  const { control_id, new_enddate, notes } = req.body;
  if (!control_id)
    return res.status(400).json({ error: "control_id is required." });
  if (!new_enddate)
    return res.status(400).json({ error: "new_enddate is required." });

  try {
    const result = await adminService.extendCycle(
      Number(control_id),
      new_enddate,
      notes ?? null,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/system/extend_cycle:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// FORM HISTORY — admin access to any personnel's form
// ─────────────────────────────────────────────────────────────

// GET /admin/forms/:svcno/years
// Returns list of form_year values that exist for this personnel in ef_emolument_forms.
router.get("/forms/:svcno/years", async (req, res) => {
  try {
    const result = await adminService.getPersonnelFormYears(req.params.svcno);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/forms/:svcno/years:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/forms/:svcno/current
// Returns the current-period form data + full approval trail.
router.get("/forms/:svcno/current", async (req, res) => {
  try {
    const result = await adminService.getPersonnelCurrentForm(req.params.svcno);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/forms/:svcno/current:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/forms/:svcno/history/:year
// Returns historical snapshot + approval trail for a specific year.
router.get("/forms/:svcno/history/:year", async (req, res) => {
  const { svcno, year } = req.params;
  if (!/^\d{4}$/.test(year))
    return res.status(400).json({ error: "year must be a 4-digit value." });
  try {
    const result = await adminService.getPersonnelFormHistory(svcno, year);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /admin/forms/:svcno/history/:year:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
