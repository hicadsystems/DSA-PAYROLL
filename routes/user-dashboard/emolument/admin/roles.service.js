/**
 * FILE: routes/user-dashboard/emolument/admin/role-catalog.service.js
 *
 * Business logic for custom admin role catalog.
 *
 *   listRoles        → all active custom roles
 *   getRole          → single role with its menu ids
 *   createRole       → new role + menu assignments
 *   updateRole       → edit name/description + replace menus
 *   deleteRole       → soft-delete (not EMOL_ADMIN)
 *   listMenus        → all available menus for checkbox list
 *   listAssignments  → active custom role assignments (with name + ship)
 *   assignRole       → upsert — overwrites existing assignment for that user
 */

"use strict";

const repo = require("./roles.repository");

const BUILTIN_ID = 1; // ef_admin_roles.id for EMOL_ADMIN — protected

// ─────────────────────────────────────────────────────────────
// ROLE CATALOG
// ─────────────────────────────────────────────────────────────

async function listRoles() {
  const roles = await repo.getAllRoles();

  // Attach menu ids to each role
  const withMenus = await Promise.all(
    roles.map(async (r) => ({
      ...r,
      menuIds: await repo.getMenuIdsByRoleId(r.id),
    })),
  );

  return { success: true, data: withMenus };
}

async function getRole(id) {
  const role = await repo.getRoleById(id);
  if (!role) return { success: false, code: 404, message: "Role not found." };

  const menuIds = await repo.getMenuIdsByRoleId(id);
  return { success: true, data: { ...role, menuIds } };
}

async function createRole(body, performedBy, ip) {
  const { name, description, menuIds = [] } = body;

  if (!name?.trim())
    return { success: false, code: 400, message: "name is required." };

  const existing = await repo.getRoleByName(name.trim());
  if (existing)
    return {
      success: false,
      code: 409,
      message: `Role "${name}" already exists.`,
    };

  const id = await repo.createRole({
    name: name.trim(),
    description,
    createdBy: performedBy,
  });

  if (menuIds.length) {
    await repo.setMenusForRole(
      id,
      menuIds.map(Number).filter((n) => n > 0),
    );
  }

  await repo.insertAuditLog({
    tableName: "ef_admin_roles",
    action: "INSERT",
    recordKey: String(id),
    oldValues: null,
    newValues: { name, description, menuIds },
    performedBy,
    ipAddress: ip,
  });

  const created = await repo.getRoleById(id);
  return {
    success: true,
    data: { ...created, menuIds },
    message: `Role "${name}" created.`,
  };
}

async function updateRole(id, body, performedBy, ip) {
  if (Number(id) === BUILTIN_ID)
    return {
      success: false,
      code: 403,
      message: "EMOL_ADMIN is a built-in role and cannot be modified.",
    };

  const existing = await repo.getRoleById(id);
  if (!existing)
    return { success: false, code: 404, message: "Role not found." };

  const { name, description, menuIds = [] } = body;
  if (!name?.trim())
    return { success: false, code: 400, message: "name is required." };

  // Check name collision with another role
  const nameCheck = await repo.getRoleByName(name.trim());
  if (nameCheck && nameCheck.id !== Number(id))
    return {
      success: false,
      code: 409,
      message: `Role "${name}" already exists.`,
    };

  await repo.updateRole(id, {
    name: name.trim(),
    description,
    updatedBy: performedBy,
  });
  await repo.setMenusForRole(
    id,
    menuIds.map(Number).filter((n) => n > 0),
  );

  await repo.insertAuditLog({
    tableName: "ef_admin_roles",
    action: "UPDATE",
    recordKey: String(id),
    oldValues: { name: existing.name, description: existing.description },
    newValues: { name, description, menuIds },
    performedBy,
    ipAddress: ip,
  });

  const updated = await repo.getRoleById(id);
  const newMenus = await repo.getMenuIdsByRoleId(id);
  return {
    success: true,
    data: { ...updated, menuIds: newMenus },
    message: `Role "${name}" updated.`,
  };
}

async function deleteRole(id, performedBy, ip) {
  if (Number(id) === BUILTIN_ID)
    return {
      success: false,
      code: 403,
      message: "EMOL_ADMIN cannot be deleted.",
    };

  const existing = await repo.getRoleById(id);
  if (!existing)
    return { success: false, code: 404, message: "Role not found." };

  await repo.deleteRole(id);

  await repo.insertAuditLog({
    tableName: "ef_admin_roles",
    action: "DELETE",
    recordKey: String(id),
    oldValues: { name: existing.name },
    newValues: { is_active: 0 },
    performedBy,
    ipAddress: ip,
  });

  return { success: true, message: `Role "${existing.name}" deleted.` };
}

// ─────────────────────────────────────────────────────────────
// MENUS
// ─────────────────────────────────────────────────────────────

async function listMenus() {
  const menus = await repo.getAllMenus();
  return { success: true, data: menus };
}

// ─────────────────────────────────────────────────────────────
// ASSIGNMENTS
// ─────────────────────────────────────────────────────────────

async function listAssignments(adminRoleId) {
  const rows = await repo.getAssignments(adminRoleId || null);
  return { success: true, data: rows };
}

async function assignRole(body, performedBy, ip) {
  const { user_id, admin_role_id } = body;

  if (!user_id)
    return { success: false, code: 400, message: "user_id is required." };
  if (!admin_role_id)
    return { success: false, code: 400, message: "admin_role_id is required." };

  const role = await repo.getRoleById(Number(admin_role_id));
  if (!role) return { success: false, code: 404, message: "Role not found." };

  await repo.upsertAssignment({
    userId: user_id,
    adminRoleId: Number(admin_role_id),
    assignedBy: performedBy,
  });

  await repo.insertAuditLog({
    tableName: "ef_user_roles",
    action: "INSERT",
    recordKey: `${user_id}:${role.name}`,
    oldValues: null,
    newValues: { user_id, admin_role_id, role_name: role.name },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `${role.name} assigned to ${user_id}.`,
    data: {
      user_id,
      admin_role_id: Number(admin_role_id),
      role_name: role.name,
    },
  };
}

module.exports = {
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  listMenus,
  listAssignments,
  assignRole,
};
