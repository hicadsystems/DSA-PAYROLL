/**
 * FILE: routes/user-dashboard/emolument/admin/role-catalog.repository.js
 *
 * SQL for custom admin role definitions (ef_admin_roles)
 * and their menu assignments (ef_rolemenus).
 *
 * ef_admin_roles  — id, name, description, is_active
 * ef_rolemenus    — Id, MenuId, RoleId (→ ef_admin_roles.id), IsActive
 * ef_menus        — Id, Name, Code, Description, MenuGroupId, IsActive
 */

'use strict';

const pool   = require('../../../../config/db');
const config = require('../../../../config');

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// ROLE CATALOG
// ─────────────────────────────────────────────────────────────

async function getAllRoles() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id, name, description, is_active, created_at, updated_at
     FROM ef_admin_roles
     WHERE is_active = 1
     ORDER BY id ASC`,
  );
  return rows;
}

async function getRoleById(id) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id, name, description, is_active, created_at, updated_at
     FROM ef_admin_roles WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function getRoleByName(name) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id FROM ef_admin_roles WHERE name = ? LIMIT 1`,
    [name],
  );
  return rows[0] || null;
}

async function createRole({ name, description, createdBy }) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `INSERT INTO ef_admin_roles (name, description, is_active, created_by)
     VALUES (?, ?, 1, ?)`,
    [name, description || null, createdBy],
  );
  return result.insertId;
}

async function updateRole(id, { name, description, updatedBy }) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_admin_roles
     SET name        = ?,
         description = ?,
         updated_by  = ?,
         updated_at  = NOW()
     WHERE id = ? AND id != 1`,
    [name, description || null, updatedBy, id],
  ); // protect EMOL_ADMIN, built-in
  return result.affectedRows > 0;
}

async function deleteRole(id) {
  pool.useDatabase(DB());
  // Soft delete — mark inactive. id=1 (EMOL_ADMIN) is protected.
  const [result] = await pool.query(
    `UPDATE ef_admin_roles SET is_active = 0 WHERE id = ? AND id != 1`,
    [id],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// MENUS
// ─────────────────────────────────────────────────────────────

async function getAllMenus() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT m.Id, m.Name, m.Code, m.Description, m.MenuGroupId,
            mg.Name AS groupName
     FROM ef_menus m
     LEFT JOIN ef_menugroups mg ON mg.Id = m.MenuGroupId
     WHERE m.IsActive = 1
     ORDER BY mg.Id ASC, m.Id ASC`,
  );
  return rows;
}

// Returns array of MenuIds currently assigned to a given admin role id
async function getMenuIdsByRoleId(roleId) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT MenuId FROM ef_rolemenus
     WHERE RoleId = ? AND IsActive = 1`,
    [roleId],
  );
  return rows.map(r => r.MenuId);
}

// Full replace — deactivate existing, insert new set
async function setMenusForRole(roleId, menuIds) {
  pool.useDatabase(DB());
  const now = new Date();

  await pool.query(
    `UPDATE ef_rolemenus SET IsActive = 0, UpdatedOn = ? WHERE RoleId = ?`,
    [now, roleId],
  );

  if (!menuIds.length) return;

  const values = menuIds.map(mid => [mid, roleId, 1, now, now]);
  await pool.query(
    `INSERT INTO ef_rolemenus (MenuId, RoleId, IsActive, CreatedOn, UpdatedOn)
     VALUES ?
     ON DUPLICATE KEY UPDATE IsActive = 1, UpdatedOn = VALUES(UpdatedOn)`,
    [values],
  );
}

// ─────────────────────────────────────────────────────────────
// USER ASSIGNMENTS
// ─────────────────────────────────────────────────────────────

// List active assignments for custom admin roles only
// (excludes DO/FO/CPO which have admin_role_id = NULL)
async function getAssignments(adminRoleId) {
  pool.useDatabase(DB());
  const conditions = ['ur.is_active = 1', 'ur.admin_role_id IS NOT NULL'];
  const params     = [];

  if (adminRoleId) {
    conditions.push('ur.admin_role_id = ?');
    params.push(adminRoleId);
  }

  const [rows] = await pool.query(
    `SELECT
       ur.id, ur.user_id, ur.admin_role_id,
       ar.name          AS role_name,
       ar.description   AS role_description,
       p.Surname, p.OtherName, p.ship,
       ur.assigned_by, ur.assigned_at
     FROM ef_user_roles ur
     INNER JOIN ef_admin_roles     ar ON ar.id = ur.admin_role_id
     LEFT  JOIN ef_personalinfos   p  ON p.serviceNumber = ur.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ar.name ASC, p.Surname ASC`,
    params,
  );
  return rows;
}

// Upsert — one active custom role per user at a time.
// If user already has an active custom role assignment, overwrite it.
async function upsertAssignment({ userId, adminRoleId, assignedBy }) {
  pool.useDatabase(DB());

  // Deactivate any existing custom role assignment for this user
  await pool.query(
    `UPDATE ef_user_roles
     SET is_active  = 0,
         revoked_at = NOW(),
         revoked_by = ?
     WHERE user_id       = ?
       AND admin_role_id IS NOT NULL
       AND is_active      = 1`,
    [assignedBy, userId],
  );

  // Insert new assignment
  const [result] = await pool.query(
    `INSERT INTO ef_user_roles
       (user_id, role, admin_role_id, scope_type, is_active, assigned_by, assigned_at)
     VALUES (?, 'EMOL_ADMIN', ?, 'GLOBAL', 1, ?, NOW())`,
    [userId, adminRoleId, assignedBy],
  );
  return result.insertId;
}

// ─────────────────────────────────────────────────────────────
// AUDIT
// ─────────────────────────────────────────────────────────────

async function insertAuditLog({ tableName, action, recordKey, oldValues, newValues, performedBy, ipAddress }) {
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_audit_logs
       (table_name, action, record_key, old_values, new_values, performed_by, ip_address, performed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      tableName, action, recordKey,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      performedBy, ipAddress || null,
    ],
  );
}

module.exports = {
  getAllRoles,
  getRoleById,
  getRoleByName,
  createRole,
  updateRole,
  deleteRole,
  getAllMenus,
  getMenuIdsByRoleId,
  setMenusForRole,
  getAssignments,
  upsertAssignment,
  insertAuditLog,
};