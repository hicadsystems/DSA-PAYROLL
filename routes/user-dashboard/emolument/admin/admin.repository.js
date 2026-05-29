/**
 * FILE: routes/user-dashboard/emolument/admin/admin.repository.js
 *
 * All SQL for EMOL_ADMIN functions.
 *
 * Admin capabilities (from old SPs):
 *   Role management    → assign/revoke DO, FO, CPO, EMOL_ADMIN roles
 *   Personnel mgmt     → search, update contact details, commission upload
 *   Bulk ship approve  → UpdateShipPersonnelByAdmin (bypass DO entirely)
 *   Form reject        → RejectForm (any stage, any ship)
 *   Exit personnel     → RemoveExitPersonnel
 *   Payroll sync       → UpdatePayrollEF (sync confirmed → HICADDATA)
 *   New personnel      → UploadUploadPerson equivalent
 *   Service number     → CommisionedPersonnelUpload equivalent
 *
 * TRANSACTION SAFETY:
 *   bulkApproveShip and adminRejectForm each write to two tables.
 *   Both are wrapped in explicit transactions.
 *   bulkApproveShip also uses FOR UPDATE on the pre-fetch to prevent
 *   a concurrent admin session from approving the same ship simultaneously.
 *   Audit log inserts after bulk operations use a single multi-row INSERT
 *   instead of N individual inserts.
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// TRANSACTION HELPER
// ─────────────────────────────────────────────────────────────

async function withTransaction(fn) {
  pool.useDatabase(DB());
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────
// ROLE MANAGEMENT — ef_user_roles
// ─────────────────────────────────────────────────────────────

async function getAllRoles(filters = {}) {
  pool.useDatabase(DB());
  const conditions = ["is_active = 1"];
  const params = [];

  if (filters.role) {
    conditions.push("role = ?");
    params.push(filters.role);
  }
  if (filters.scope_type) {
    conditions.push("scope_type = ?");
    params.push(filters.scope_type);
  }
  if (filters.scope_value) {
    conditions.push("scope_value = ?");
    params.push(filters.scope_value);
  }
  if (filters.user_id) {
    conditions.push("user_id = ?");
    params.push(filters.user_id);
  }

  const [rows] = await pool.query(
    `SELECT ur.id, ur.user_id, ur.role, ur.scope_type, ur.scope_value,
            ur.assigned_by, ur.assigned_at, ur.is_active,
            p.Surname, p.OtherName, p.Rank, p.ship, p.command
     FROM ef_user_roles ur
     LEFT JOIN ef_personalinfos p ON p.serviceNumber = ur.user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ur.role ASC, ur.scope_value ASC`,
    params,
  );
  return rows;
}

async function getRoleById(roleId) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id, user_id, role, scope_type, scope_value, is_active
     FROM ef_user_roles WHERE id = ? LIMIT 1`,
    [roleId],
  );
  return rows[0] || null;
}

async function assignRole(userId, role, scopeType, scopeValue, assignedBy) {
  pool.useDatabase(DB());
  // Upsert — if same user+role+scope_value exists but was revoked, reactivate it
  const [result] = await pool.query(
    `INSERT INTO ef_user_roles
       (user_id, role, scope_type, scope_value, is_active, assigned_by, assigned_at)
     VALUES (?, ?, ?, ?, 1, ?, NOW())
     ON DUPLICATE KEY UPDATE
       is_active   = 1,
       assigned_by = VALUES(assigned_by),
       assigned_at = NOW(),
       revoked_at  = NULL,
       revoked_by  = NULL`,
    [userId, role, scopeType, scopeValue ?? null, assignedBy],
  );
  return result.affectedRows > 0;
}

async function revokeRole(roleId, revokedBy) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_user_roles
     SET is_active  = 0,
         revoked_at = NOW(),
         revoked_by = ?
     WHERE id = ? AND is_active = 1`,
    [revokedBy, roleId],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// ROLE MENUS — ef_menus + ef_menugroups + ef_rolemenus
//
// ef_rolemenus.RoleId holds the numeric Id of a row whose
// Code in ef_menus encodes the emol role string.
// We map DO/FO/CPO/EMOL_ADMIN ↔ ef_menus.Code for lookups.
// ─────────────────────────────────────────────────────────────

async function getAllMenus() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT m.Id, m.Name, m.Code, m.Description, m.IsActive,
            m.MenuGroupId,
            mg.Name AS groupName
     FROM ef_menus m
     LEFT JOIN ef_menugroups mg ON mg.Id = m.MenuGroupId
     WHERE m.IsActive = 1
     ORDER BY mg.Id ASC, m.Id ASC`,
  );
  return rows;
}

// Returns array of MenuId values currently assigned to a role
async function getMenuIdsByRole(role) {
  pool.useDatabase(DB());
  // ef_rolemenus.RoleId stores the Id of the ef_menus row whose Code = role
  const [rows] = await pool.query(
    `SELECT rm.MenuId
     FROM ef_rolemenus rm
     INNER JOIN ef_menus m ON m.Id = rm.RoleId
     WHERE m.Code = ? AND rm.IsActive = 1`,
    [role],
  );
  return rows.map((r) => r.MenuId);
}

// Full replace: deactivate all current assignments for this role, insert new set.
async function setMenusForRole(role, menuIds) {
  pool.useDatabase(DB());

  // Find the ef_menus row that represents this role
  const [roleMenuRows] = await pool.query(
    `SELECT Id FROM ef_menus WHERE Code = ? LIMIT 1`,
    [role],
  );

  if (!roleMenuRows.length) {
    // Role has no menu-definition row yet — nothing to set
    return;
  }

  const roleMenuId = roleMenuRows[0].Id;
  const now = new Date();

  // Deactivate all existing assignments for this role
  await pool.query(
    `UPDATE ef_rolemenus SET IsActive = 0, UpdatedOn = ? WHERE RoleId = ?`,
    [now, roleMenuId],
  );

  if (!menuIds.length) return;

  // Insert new assignments (upsert — reactivate if row already exists)
  const values = menuIds.map((mid) => [mid, roleMenuId, 1, now, now]);
  await pool.query(
    `INSERT INTO ef_rolemenus (MenuId, RoleId, IsActive, CreatedOn, UpdatedOn)
     VALUES ?
     ON DUPLICATE KEY UPDATE IsActive = 1, UpdatedOn = VALUES(UpdatedOn)`,
    [values],
  );
}

// ─────────────────────────────────────────────────────────────
// PERSONNEL SEARCH + UPDATE
// ─────────────────────────────────────────────────────────────

async function searchPersonnel(filters = {}, limit = 50, offset = 0) {
  pool.useDatabase(DB());

  // Hard cap — never let a missing limit parameter return unbounded rows
  const safeLimit = Math.min(Number(limit) || 50, 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const conditions = [];
  const params = [];

  if (filters.serviceNumber) {
    conditions.push("p.serviceNumber LIKE ?");
    params.push(`${filters.serviceNumber}%`); // prefix-only — index-safe
  }
  if (filters.surname) {
    // Use FULLTEXT if the ft_pi_name index exists (added in index migration).
    // Fall back to prefix LIKE — never leading-wildcard LIKE.
    conditions.push(
      "MATCH(p.Surname, p.OtherName) AGAINST (? IN BOOLEAN MODE)",
    );
    params.push(`${filters.surname}*`);
  }
  if (filters.ship) {
    conditions.push("p.ship = ?");
    params.push(filters.ship);
  }
  if (filters.command) {
    conditions.push("p.command = ?");
    params.push(filters.command);
  }
  if (filters.payrollclass) {
    conditions.push("p.payrollclass = ?");
    params.push(filters.payrollclass);
  }
  if (filters.status !== undefined) {
    if (filters.status === null || filters.status === "") {
      conditions.push("(p.Status IS NULL OR p.Status = '')");
    } else {
      conditions.push("p.Status = ?");
      params.push(filters.status);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.ship, p.command,
       p.email, p.gsm_number, p.Status, p.emolumentform,
       p.formNumber, p.FormYear
     FROM ef_personalinfos p
     ${where}
     ORDER BY p.Surname ASC, p.OtherName ASC
     LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset],
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM ef_personalinfos p ${where}`,
    params,
  );

  return { rows, total };
}

async function getPersonnelByServiceNo(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT p.*,
            cmd.commandName, br.branchName,
            lga.lgaName, st.Name AS stateName
     FROM ef_personalinfos p
     LEFT JOIN ef_commands   cmd ON cmd.code   = p.command
     LEFT JOIN ef_branches   br  ON br.code    = p.branch
     LEFT JOIN ef_localgovts lga ON lga.Id     = p.LocalGovt
     LEFT JOIN ef_states     st  ON st.StateId = p.StateofOrigin
     WHERE p.serviceNumber = ? LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function updatePersonnelContact(serviceNo, email, phoneNumber) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_personalinfos
     SET email      = ?,
         gsm_number = ?,
         dateModify = NOW()
     WHERE serviceNumber = ?`,
    [email, phoneNumber, serviceNo],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// BULK SHIP APPROVE — UpdateShipPersonnelByAdmin equivalent
//
// TRANSACTION: pre-fetch + two UPDATE statements are in one transaction.
// FOR UPDATE on the pre-fetch prevents a concurrent admin session from
// approving the same ship in parallel.
//
// Returns affected service numbers for approval trail.
// ─────────────────────────────────────────────────────────────

async function bulkApproveShip(
  ship,
  foName,
  foRank,
  foSvcNo,
  foDate,
  legacyStatus,
) {
  return withTransaction(async (conn) => {
    // 1. Pre-fetch inside transaction + lock rows
    const [affected] = await conn.query(
      `SELECT serviceNumber FROM ef_personalinfos
     WHERE ship   = ?
       AND Status = 'Filled'
         AND (emolumentform IS NULL OR emolumentform != 'Yes')
       FOR UPDATE`,
      [ship],
    );

    if (affected.length === 0) return { count: 0, serviceNumbers: [] };

    // 2. Bulk update ef_personalinfos
    const [result] = await conn.query(
      `UPDATE ef_personalinfos
     SET fo_name    = ?,
         fo_svcno   = ?,
         fo_rank    = ?,
         fo_date    = ?,
         Status     = ?,
         dateModify = NOW()
     WHERE ship   = ?
       AND Status = 'Filled'
       AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
      [foName, foSvcNo, foRank, foDate, legacyStatus, ship],
    );

    const serviceNumbers = affected.map((r) => r.serviceNumber);

    // 3. Bulk update ef_emolument_forms
    const placeholders = serviceNumbers.map(() => "?").join(",");
    await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'FO_APPROVED',
           updated_at = NOW()
       WHERE service_no IN (${placeholders})
         AND ship     = ?
         AND status   IN ('SUBMITTED', 'DO_REVIEWED')`,
      [...serviceNumbers, ship],
    );

    return { count: result.affectedRows, serviceNumbers };
  });
}

async function getFormIdsByServiceNos(serviceNumbers, ship) {
  if (!serviceNumbers.length) return [];
  pool.useDatabase(DB());
  const placeholders = serviceNumbers.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT id, service_no FROM ef_emolument_forms
     WHERE service_no IN (${placeholders}) AND ship = ?`,
    [...serviceNumbers, ship],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// FORM REJECT — RejectForm equivalent (admin can reject any stage)
//
// TRANSACTION: two-table write.
// Admin reject has no Status gate on ef_personalinfos (intentional —
// admin can reject at any stage). The only guard is emolumentform != 'Yes'
// which prevents rejecting an already-confirmed form.
// ─────────────────────────────────────────────────────────────

async function adminRejectForm(serviceNo, formId, ship) {
  return withTransaction(async (conn) => {
    // 1. Reset ef_personalinfos — no status gate, admin can reject any stage
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
     SET Status     = NULL,
         dateModify = NOW()
     WHERE serviceNumber = ?
       AND ship          = ?
       AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
      [serviceNo, ship],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(
        new Error(
          "Form is already confirmed or personnel not found on this ship",
        ),
        { code: "CANNOT_REJECT" },
      );
    }

    // 2. Reset ef_emolument_forms — any non-final status
    await conn.query(
      `UPDATE ef_emolument_forms
     SET status     = 'REJECTED',
         updated_at = NOW()
     WHERE id     = ?
       AND status NOT IN ('CPO_CONFIRMED', 'REJECTED')`,
      [formId],
    );

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// EXIT PERSONNEL — RemoveExitPersonnel equivalent
// Single-table delete — no transaction needed.
// ─────────────────────────────────────────────────────────────

async function removeExitPersonnel(payrollclass) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `DELETE FROM ef_personalinfos
     WHERE upload       = 0
       AND payrollclass = ?
       AND (serviceNumber IS NULL OR serviceNumber = '')`,
    [payrollclass],
  );
  return result.affectedRows;
}

// ─────────────────────────────────────────────────────────────
// NEW PERSONNEL UPLOAD — UploadUploadPerson equivalent
// Single-table upsert — no transaction needed.
// ─────────────────────────────────────────────────────────────

async function upsertPersonnel(data) {
  pool.useDatabase(DB());

  const {
    serviceNumber,
    surname,
    otherName,
    rank,
    email,
    phoneNumber,
    accountNo,
    bankCode,
    ship,
    payrollclass,
    classes,
    dateOfBirth,
    dateOfJoining,
  } = data;

  const [existing] = await pool.query(
    `SELECT serviceNumber FROM ef_personalinfos WHERE serviceNumber = ? LIMIT 1`,
    [serviceNumber],
  );

  if (existing.length === 0) {
    await pool.query(
      `INSERT INTO ef_personalinfos
         (serviceNumber, Surname, OtherName, email, gsm_number, Rank,
          ship, AccountName, BankACNumber, Bankcode, DateEmpl,
          Birthdate, classes, payrollclass)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        serviceNumber,
        surname,
        otherName,
        email,
        phoneNumber,
        rank,
        ship ?? null,
        `${surname} ${otherName}`,
        accountNo ?? null,
        bankCode ?? null,
        dateOfJoining ?? null,
        dateOfBirth ?? null,
        classes,
        payrollclass,
      ],
    );
  } else {
    await pool.query(
      `UPDATE ef_personalinfos
       SET formyear     = YEAR(NOW()),
           exittype     = NULL,
           Status       = NULL,
           Surname      = ?,
           OtherName    = ?,
           email        = ?,
           gsm_number   = ?,
           Rank         = ?,
           ship         = ?,
           AccountName  = ?,
           BankACNumber = ?,
           Bankcode     = ?,
           DateEmpl     = ?,
           Birthdate    = ?,
           classes      = ?,
           payrollclass = ?
       WHERE serviceNumber = ?`,
      [
        surname,
        otherName,
        email,
        phoneNumber,
        rank,
        ship ?? null,
        `${surname} ${otherName}`,
        accountNo ?? null,
        bankCode ?? null,
        dateOfJoining ?? null,
        dateOfBirth ?? null,
        classes,
        payrollclass,
        serviceNumber,
      ],
    );
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// COMMISSION — CommisionedPersonnelUpload equivalent
// Single-table update — no transaction needed.
// ─────────────────────────────────────────────────────────────

async function updateServiceNumber(oldSvcNo, newSvcNo) {
  pool.useDatabase(DB());
  const isCommissioned = newSvcNo.toUpperCase().startsWith("N");

  if (isCommissioned) {
    await pool.query(
      `UPDATE ef_personalinfos
       SET serviceNumber = ?,
           payrollclass  = 1,
           classes       = 1
       WHERE serviceNumber = ?`,
      [newSvcNo, oldSvcNo],
    );
  } else {
    await pool.query(
      `UPDATE ef_personalinfos
       SET serviceNumber = ?
       WHERE serviceNumber = ?`,
      [newSvcNo, oldSvcNo],
    );
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// PAYROLL SYNC
// getConfirmedForSync now accepts a single class string.
// The multi-class iteration is handled in admin.service.js.
// ─────────────────────────────────────────────────────────────

async function getConfirmedForSync(payrollclass) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT serviceNumber FROM ef_personalinfos
     WHERE emolumentform = 'Yes'
       AND payrollclass  = ?
       AND Status IN ('Verified', 'Updated')`,
    [payrollclass],
  );
  return rows.map((r) => r.serviceNumber);
}

// Returns { serviceNumber → formId } map for CPO_CONFIRMED forms
// in a given payrollclass — used by syncPayroll to write SYNCED
// approval rows without a separate per-record query.
async function getFormIdMapForSync(payrollclass) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT f.id AS formId, f.service_no AS serviceNo
     FROM ef_emolument_forms f
     INNER JOIN ef_personalinfos p ON p.serviceNumber = f.service_no
     WHERE p.emolumentform = 'Yes'
       AND p.payrollclass  = ?
       AND p.Status       IN ('Verified', 'Updated')
       AND f.status        = 'CPO_CONFIRMED'`,
    [payrollclass],
  );
  // Build a plain object map: serviceNo → formId
  return Object.fromEntries(rows.map((r) => [r.serviceNo, r.formId]));
}

async function markSyncedInPersonnel(serviceNo, payrollclass) {
  pool.useDatabase(DB());
  await pool.query(
    `UPDATE ef_personalinfos
     SET Status = 'Updated'
     WHERE serviceNumber = ?
       AND payrollclass  = ?`,
    [serviceNo, payrollclass],
  );
}

// Sync confirmed emolument status back to hr_employees.
// This is the cross-table write that UpdatePayrollEF SP did to
// HICADDATA..hr_employees. In the new system hr_employees is in
// the same officers DB — no cross-DB call needed.
async function syncToHrEmployees(serviceNo) {
  pool.useDatabase(DB());
  await pool.query(
    `UPDATE hr_employees
     SET emolumentform = 'Yes'
     WHERE Empl_ID = ?`,
    [serviceNo],
  );
}

// ─────────────────────────────────────────────────────────────
// CYCLE CONTROL
// ─────────────────────────────────────────────────────────────

async function getControlRowById(id) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT Id, processingyear, ship, formtype,
            startdate, enddate, status, notes,
            createdby, datecreated, updatedby, updatedat
     FROM ef_control
     WHERE Id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function extendCycle(id, newEnddate, notes, performedBy) {
  pool.useDatabase(DB());
  await pool.query(
    `UPDATE ef_control
     SET enddate   = ?,
         status    = 'Reopen',
         notes     = COALESCE(?, notes),
         updatedby = ?,
         updatedat = NOW()
     WHERE Id = ?`,
    [newEnddate, notes ?? null, performedBy, id],
  );
}

// ─────────────────────────────────────────────────────────────
// FORM HISTORY — admin view
// ─────────────────────────────────────────────────────────────

// Distinct years for which this personnel has a form record
async function getFormYearsForPersonnel(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT DISTINCT form_year
     FROM ef_emolument_forms
     WHERE service_no = ?
     ORDER BY form_year DESC`,
    [serviceNo],
  );
  return rows.map((r) => r.form_year);
}

// Current period: use the active processingyear from ef_control
async function getCurrentFormForPersonnel(serviceNo) {
  pool.useDatabase(DB());
  // Resolve current year from ef_control (most recent open or latest row)
  const [ctrlRows] = await pool.query(
    `SELECT processingyear FROM ef_control
     WHERE status IN ('Open','Reopen')
     ORDER BY processingyear DESC
     LIMIT 1`,
  );
  const currentYear =
    ctrlRows[0]?.processingyear ?? String(new Date().getFullYear());

  const [rows] = await pool.query(
    `SELECT id, service_no, form_year, form_number, payroll_class,
            ship, command, status, snapshot, submitted_at, updated_at
     FROM ef_emolument_forms
     WHERE service_no = ? AND form_year = ?
     LIMIT 1`,
    [serviceNo, currentYear],
  );

  if (!rows.length) return null;

  const row = rows[0];
  // Parse snapshot
  if (row.snapshot && typeof row.snapshot === "string") {
    try {
      row.snapshot = JSON.parse(row.snapshot);
    } catch {
      row.snapshot = null;
    }
  }

  return row;
}

async function getFormByServiceNoAndYear(serviceNo, year) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id, service_no, form_year, form_number, payroll_class,
            ship, command, status, snapshot, submitted_at, updated_at
     FROM ef_emolument_forms
     WHERE service_no = ? AND form_year = ?
     LIMIT 1`,
    [serviceNo, String(year)],
  );
  return rows[0] || null;
}

// Full approval trail for a specific form_id, ordered chronologically
async function getFormApprovals(formId) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id, form_id, action, from_status, to_status,
            performed_by, performer_role, remarks, performed_at
     FROM ef_form_approvals
     WHERE form_id = ?
     ORDER BY performed_at ASC`,
    [formId],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// APPROVAL TRAIL + AUDIT
// ─────────────────────────────────────────────────────────────

async function insertFormApproval({
  formId,
  action,
  fromStatus,
  toStatus,
  performedBy,
  performerRole,
  remarks,
}) {
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_form_approvals
       (form_id, action, from_status, to_status, performed_by, performer_role, remarks, performed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      formId,
      action,
      fromStatus || null,
      toStatus,
      performedBy,
      performerRole || null,
      remarks || null,
    ],
  );
}

async function bulkInsertFormApprovals(
  formIds,
  action,
  fromStatus,
  toStatus,
  performedBy,
  performerRole,
  remarks,
) {
  if (!formIds.length) return;
  pool.useDatabase(DB());
  const now = new Date();
  const values = formIds.map((id) => [
    id,
    action,
    fromStatus || null,
    toStatus,
    performedBy,
    performerRole || null,
    remarks || null,
    now,
  ]);
  await pool.query(
    `INSERT INTO ef_form_approvals
       (form_id, action, from_status, to_status, performed_by, performer_role, remarks, performed_at)
     VALUES ?`,
    [values],
  );
}

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
  getAllRoles,
  getRoleById,
  assignRole,
  revokeRole,
  // menus
  getAllMenus,
  getMenuIdsByRole,
  setMenusForRole,
  // personnel
  searchPersonnel,
  getPersonnelByServiceNo,
  updatePersonnelContact,
  upsertPersonnel,
  updateServiceNumber,
  // bulk approve
  bulkApproveShip,
  getFormIdsByServiceNos,
  // form reject
  adminRejectForm,
  // exits
  removeExitPersonnel,
  upsertPersonnel,
  updateServiceNumber,
  getConfirmedForSync,
  getFormIdMapForSync,
  markSyncedInPersonnel,
  syncToHrEmployees,
  // cycle
  getControlRowById,
  extendCycle,
  // form history (admin)
  getFormYearsForPersonnel,
  getCurrentFormForPersonnel,
  getFormByServiceNoAndYear,
  getFormApprovals,
  // approval trail + audit
  insertFormApproval,
  bulkInsertFormApprovals,
  insertAuditLog,
};
