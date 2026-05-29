/**
 * FILE: routes/user-dashboard/emolument/admin/role-catalog.routes.js
 *
 * Custom admin role catalog + assignments.
 * Mount at /admin in the emolument index router.
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  Role catalog:
 *  GET    /admin/role-catalog              → list all custom roles (with menuIds)
 *  GET    /admin/role-catalog/menus        → all available menus for checkbox list
 *  GET    /admin/role-catalog/:id          → single role with menuIds
 *  POST   /admin/role-catalog              → create role { name, description, menuIds }
 *  PUT    /admin/role-catalog/:id          → update role { name, description, menuIds }
 *  DELETE /admin/role-catalog/:id          → soft-delete role (not EMOL_ADMIN)
 *
 *  Assignments:
 *  GET    /admin/role-assignments          → list active custom role assignments
 *                                            ?admin_role_id=2  (optional filter)
 *  POST   /admin/role-assignments          → assign (upsert) { user_id, admin_role_id }
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");

const verifyToken = require("../../../../middware/authentication");
const { requireEmolRole } = require("../../../../middware/emolumentAuth");
const svc = require("./roles.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});
router.use(verifyToken, requireEmolRole("EMOL_ADMIN"));

function parseId(p) {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function send(res, result) {
  if (!result.success)
    return res.status(result.code).json({ error: result.message });
  const body = {};
  if (result.message) body.message = result.message;
  if (result.data !== undefined) body.data = result.data;
  return res.json(body);
}

// ─────────────────────────────────────────────────────────────
// ROLE CATALOG
// ─────────────────────────────────────────────────────────────

// GET /admin/role-catalog/menus — must be before /:id
router.get("/role-catalog/menus", async (req, res) => {
  try {
    return send(res, await svc.listMenus());
  } catch (err) {
    console.error("❌ GET /admin/role-catalog/menus:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/role-catalog", async (req, res) => {
  try {
    return send(res, await svc.listRoles());
  } catch (err) {
    console.error("❌ GET /admin/role-catalog:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/role-catalog/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid role ID." });
  try {
    return send(res, await svc.getRole(id));
  } catch (err) {
    console.error("❌ GET /admin/role-catalog/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/role-catalog", async (req, res) => {
  try {
    const result = await svc.createRole(req.body, req.user_id, req.ip);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.status(201).json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/role-catalog:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.put("/role-catalog/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid role ID." });
  try {
    return send(res, await svc.updateRole(id, req.body, req.user_id, req.ip));
  } catch (err) {
    console.error("❌ PUT /admin/role-catalog/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/role-catalog/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid role ID." });
  try {
    return send(res, await svc.deleteRole(id, req.user_id, req.ip));
  } catch (err) {
    console.error("❌ DELETE /admin/role-catalog/:id:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// MY ROLE — returns the calling user's assigned role + menuIds
// Used by the nav filter on page load. No EMOL_ADMIN guard —
// any authenticated user can call this to discover their access.
// ─────────────────────────────────────────────────────────────

router.get("/my-role", async (req, res) => {
  try {
    // Get this user's active custom role assignment
    const repo = require("./roles.repository");
    const rows = await repo.getAssignments(null);
    const mine = rows.find((r) => r.user_id === req.user_id);

    if (!mine) {
      // No custom role — treat as EMOL_ADMIN (full access) or no access
      // Return null so the nav filter shows everything
      return res.json({ role: null, menuIds: [], menuCodes: [] });
    }

    const menuIds = await repo.getMenuIdsByRoleId(mine.admin_role_id);
    const allMenus = await repo.getAllMenus();
    const menuCodes = allMenus
      .filter((m) => menuIds.includes(m.Id))
      .map((m) => m.Code);

    return res.json({
      role: { id: mine.admin_role_id, name: mine.role_name },
      menuIds,
      menuCodes,
    });
  } catch (err) {
    console.error("❌ GET /admin/my-role:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// ASSIGNMENTS
// ─────────────────────────────────────────────────────────────

router.get("/role-assignments", async (req, res) => {
  const roleId = req.query.admin_role_id
    ? Number(req.query.admin_role_id)
    : null;
  try {
    return send(res, await svc.listAssignments(roleId));
  } catch (err) {
    console.error("❌ GET /admin/role-assignments:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/role-assignments — { user_id, admin_role_id }
// Upsert: overwrites any existing active custom role for this user.
router.post("/role-assignments", async (req, res) => {
  try {
    const result = await svc.assignRole(req.body, req.user_id, req.ip);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.status(201).json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /admin/role-assignments:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
