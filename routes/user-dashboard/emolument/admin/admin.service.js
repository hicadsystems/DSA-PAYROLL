/**
 * FILE: routes/user-dashboard/emolument/admin/admin.service.js
 *
 * Business logic for EMOL_ADMIN functions.
 * All functions here are EMOL_ADMIN only — enforced at route level.
 *
 * Functions:
 *   listRoles              → get all active role assignments (filterable)
 *   assignRole             → assign DO/FO/CPO/EMOL_ADMIN to a user
 *   revokeRole             → revoke an active role assignment
 *   listMenus              → all menus grouped by MenuGroup
 *   getMenusForRole        → menu IDs visible to a given emol role
 *   setMenusForRole        → full-replace menu visibility for a role
 *   searchPersonnel        → search personnel records with filters + pagination
 *   getPersonnel           → get single personnel record by service number
 *   updateContact          → update email + phone
 *   bulkApprovePreview     → preview personnel eligible for bulk approve on a ship
 *   bulkApproveShip        → approve entire ship bypassing DO
 *   rejectForm             → reject any form at any stage
 *   removeExitPersonnel    → delete unuploaded exit records by payrollclass
 *   uploadPersonnel        → upsert single or batch personnel records
 *   updateServiceNumber    → change service number on commission
 *   syncPayrollPreview     → list confirmed-but-unsynced personnel (no commit)
 *   syncPayroll            → sync confirmed forms → hr_employees
 *   extendCycle            → extend a control row's end date with Reopen status
 *   getPersonnelFormYears  → list form years available for a personnel (admin view)
 *   getPersonnelCurrentForm → current period form + approval trail (admin view)
 *   getPersonnelFormHistory → historical snapshot + trail for a given year (admin view)
 */

"use strict";

const repo = require("./admin.repository");
const { invalidateShipCache } = require("../reports/reports.service");
const {
  FORM_STATUS,
  LEGACY_STATUS,
  EMOL_ROLE,
  toLegacyStatus,
  FO_BULK_FILTER_STATUS,
} = require("../emolument.constants");

// ─────────────────────────────────────────────────────────────
// PAYROLL CLASS LABELS
// 1 = OFFICERS | 2 = W/OFFICERS | 3 = RATE A | 4 = RATE B | 5 = RATE C
// ─────────────────────────────────────────────────────────────

const PAYROLL_CLASS_LABELS = Object.freeze({
  1: "OFFICERS",
  2: "W/OFFICERS",
  3: "RATE A",
  4: "RATE B",
  5: "RATE C",
});

const VALID_PAYROLL_CLASSES = Object.keys(PAYROLL_CLASS_LABELS);

function resolvePayrollClasses(raw) {
  const val = String(raw || "")
    .toUpperCase()
    .trim();
  if (val === "ALL") return VALID_PAYROLL_CLASSES;
  if (!VALID_PAYROLL_CLASSES.includes(val)) return null; // signal invalid
  return [val];
}

// ─────────────────────────────────────────────────────────────
// ROLE MANAGEMENT
// ─────────────────────────────────────────────────────────────

const VALID_ROLES = Object.values(EMOL_ROLE);
const VALID_SCOPE_TYPES = ["SHIP", "COMMAND", "GLOBAL"];

async function listRoles(filters) {
  const roles = await repo.getAllRoles(filters || {});
  return { success: true, data: roles };
}

async function assignRole(body, performedBy, ip) {
  const { user_id, role, scope_type, scope_value } = body;

  if (!user_id || !role || !scope_type)
    return {
      success: false,
      code: 400,
      message: "user_id, role, and scope_type are required.",
    };
  if (!VALID_ROLES.includes(role))
    return {
      success: false,
      code: 400,
      message: `role must be one of: ${VALID_ROLES.join(", ")}.`,
    };
  if (!VALID_SCOPE_TYPES.includes(scope_type))
    return {
      success: false,
      code: 400,
      message: `scope_type must be one of: ${VALID_SCOPE_TYPES.join(", ")}.`,
    };
  if (scope_type !== "GLOBAL" && !scope_value)
    return {
      success: false,
      code: 400,
      message: `scope_value is required when scope_type is ${scope_type}.`,
    };
  if (scope_type === "GLOBAL" && role !== "EMOL_ADMIN")
    return {
      success: false,
      code: 400,
      message: "Only EMOL_ADMIN can have GLOBAL scope.",
    };

  const ok = await repo.assignRole(
    user_id,
    role,
    scope_type,
    scope_type === "GLOBAL" ? null : scope_value,
    performedBy,
  );

  if (!ok)
    return { success: false, code: 500, message: "Failed to assign role." };

  await repo.insertAuditLog({
    tableName: "ef_user_roles",
    action: "INSERT",
    recordKey: `${user_id}:${role}:${scope_value ?? "GLOBAL"}`,
    oldValues: null,
    newValues: { user_id, role, scope_type, scope_value },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Role ${role} assigned to ${user_id}${scope_value ? ` for ${scope_value}` : ""}.`,
    data: { user_id, role, scope_type, scope_value },
  };
}

async function revokeRole(roleId, performedBy, ip) {
  const existing = await repo.getRoleById(roleId);
  if (!existing)
    return { success: false, code: 404, message: "Role assignment not found." };
  if (!existing.is_active)
    return { success: false, code: 409, message: "Role is already revoked." };
  if (existing.user_id === performedBy && existing.role === "EMOL_ADMIN")
    return {
      success: false,
      code: 403,
      message: "You cannot revoke your own EMOL_ADMIN role.",
    };

  const ok = await repo.revokeRole(roleId, performedBy);
  if (!ok)
    return { success: false, code: 500, message: "Failed to revoke role." };

  await repo.insertAuditLog({
    tableName: "ef_user_roles",
    action: "UPDATE",
    recordKey: String(roleId),
    oldValues: { is_active: 1 },
    newValues: { is_active: 0, revoked_by: performedBy },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Role ${existing.role} revoked for ${existing.user_id}.`,
    data: { roleId, user_id: existing.user_id, role: existing.role },
  };
}

// ─────────────────────────────────────────────────────────────
// ROLE MENUS
// ─────────────────────────────────────────────────────────────

async function listMenus() {
  const menus = await repo.getAllMenus();
  return { success: true, data: menus };
}

async function getMenusForRole(role) {
  if (!VALID_ROLES.includes(role))
    return {
      success: false,
      code: 400,
      message: `role must be one of: ${VALID_ROLES.join(", ")}.`,
    };

  const menuIds = await repo.getMenuIdsByRole(role);
  return { success: true, data: { role, menuIds } };
}

async function setMenusForRole(role, menuIds, performedBy, ip) {
  if (!VALID_ROLES.includes(role))
    return {
      success: false,
      code: 400,
      message: `role must be one of: ${VALID_ROLES.join(", ")}.`,
    };

  const validIds = menuIds
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

  const oldMenuIds = await repo.getMenuIdsByRole(role);
  await repo.setMenusForRole(role, validIds);

  await repo.insertAuditLog({
    tableName: "ef_rolemenus",
    action: "UPDATE",
    recordKey: `role:${role}`,
    oldValues: { menuIds: oldMenuIds },
    newValues: { menuIds: validIds },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Menu visibility updated for role ${role}. ${validIds.length} menu(s) assigned.`,
    data: { role, menuIds: validIds },
  };
}

// ─────────────────────────────────────────────────────────────
// PERSONNEL MANAGEMENT
// ─────────────────────────────────────────────────────────────

async function searchPersonnel(filters, page = 1, pageSize = 50) {
  const limit = Math.min(Number(pageSize) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const { rows, total } = await repo.searchPersonnel(
    filters || {},
    limit,
    offset,
  );

  return {
    success: true,
    data: {
      rows,
      pagination: {
        total,
        page: Math.max(Number(page) || 1, 1),
        pageSize: limit,
        totalPages: Math.ceil(total / limit),
      },
    },
  };
}

async function getPersonnel(serviceNo) {
  if (!serviceNo)
    return {
      success: false,
      code: 400,
      message: "Service number is required.",
    };

  const person = await repo.getPersonnelByServiceNo(serviceNo);
  if (!person)
    return {
      success: false,
      code: 404,
      message: "Personnel record not found.",
    };

  return { success: true, data: person };
}

async function updateContact(serviceNo, body, performedBy, ip) {
  const { email, phone_number } = body;

  if (!email && !phone_number)
    return {
      success: false,
      code: 400,
      message: "At least one of email or phone_number is required.",
    };

  const person = await repo.getPersonnelByServiceNo(serviceNo);
  if (!person)
    return {
      success: false,
      code: 404,
      message: "Personnel record not found.",
    };

  const newEmail = email ?? person.email;
  const newPhone = phone_number ?? person.gsm_number;

  const ok = await repo.updatePersonnelContact(serviceNo, newEmail, newPhone);
  if (!ok)
    return {
      success: false,
      code: 500,
      message: "Failed to update contact details.",
    };

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: serviceNo,
    oldValues: { email: person.email, gsm_number: person.gsm_number },
    newValues: { email: newEmail, gsm_number: newPhone },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Contact details updated for ${serviceNo}.`,
    data: { serviceNumber: serviceNo, email: newEmail, phone_number: newPhone },
  };
}

// ─────────────────────────────────────────────────────────────
// BULK APPROVE PREVIEW
// Returns personnel with Status='Filled' on the given ship
// without touching any data.
// ─────────────────────────────────────────────────────────────

async function bulkApprovePreview(ship) {
  if (!ship) return { success: false, code: 400, message: "ship is required." };

  const { rows, total } = await repo.searchPersonnel(
    { ship, status: FO_BULK_FILTER_STATUS },
    200, // cap — if a ship has >200 pending that's unusual
    0,
  );

  return {
    success: true,
    data: {
      ship,
      eligible: total,
      rows,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// BULK SHIP APPROVE
// ─────────────────────────────────────────────────────────────

async function bulkApproveShip(ship, body, performedBy, ip) {
  const { fo_name, fo_rank, fo_date } = body;

  if (!ship) return { success: false, code: 400, message: "Ship is required." };
  if (!fo_name || !fo_rank || !fo_date)
    return {
      success: false,
      code: 400,
      message: "fo_name, fo_rank, and fo_date are required.",
    };

  const legacyStatus = toLegacyStatus(FORM_STATUS.FO_APPROVED); // 'CPO'

  const { count, serviceNumbers } = await repo.bulkApproveShip(
    ship,
    fo_name,
    fo_rank,
    performedBy,
    fo_date,
    legacyStatus,
  );

  if (count === 0) {
    return {
      success: false,
      code: 404,
      message: `No forms found with Status='${FO_BULK_FILTER_STATUS}' for ship '${ship}'.`,
    };
  }

  invalidateShipCache(ship);

  const formRows = await repo.getFormIdsByServiceNos(serviceNumbers, ship);
  await Promise.all(
    formRows.map((f) =>
      repo.insertFormApproval({
        formId: f.id,
        action: "FO_APPROVED",
        fromStatus: FORM_STATUS.SUBMITTED,
        toStatus: FORM_STATUS.FO_APPROVED,
        performedBy,
        performerRole: "EMOL_ADMIN",
        remarks: `Admin bulk approval — ship: ${ship} (DO bypassed)`,
      }),
    ),
  );

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: `ADMIN_BULK:${ship}`,
    oldValues: { Status: FO_BULK_FILTER_STATUS, ship },
    newValues: {
      Status: legacyStatus,
      fo_svcno: performedBy,
      affectedCount: count,
    },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Admin bulk approval complete. ${count} form(s) approved for ship '${ship}' (DO bypassed).`,
    data: { ship, approved: count, newStatus: FORM_STATUS.FO_APPROVED },
  };
}

// ─────────────────────────────────────────────────────────────
// FORM REJECT
// ─────────────────────────────────────────────────────────────

async function rejectForm(formId, body, performedBy, ip) {
  const { ship, remarks } = body;

  if (!ship) return { success: false, code: 400, message: "ship is required." };
  if (!remarks?.trim())
    return { success: false, code: 400, message: "remarks is required." };
  if (!Number.isInteger(Number(formId)) || Number(formId) < 1)
    return { success: false, code: 400, message: "Invalid form ID." };

  const pool2 = require("../../../../config/db");
  const [formRows] = await pool2.query(
    `SELECT service_no, status FROM ef_emolument_forms WHERE id = ? LIMIT 1`,
    [Number(formId)],
  );

  if (!formRows?.length)
    return { success: false, code: 404, message: "Form not found." };

  const { service_no: serviceNo, status: currentFormStatus } = formRows[0];

  if (currentFormStatus === FORM_STATUS.CPO_CONFIRMED)
    return {
      success: false,
      code: 409,
      message: "Cannot reject a CPO_CONFIRMED form.",
    };
  if (currentFormStatus === FORM_STATUS.REJECTED)
    return { success: false, code: 409, message: "Form is already rejected." };

  const reset = await repo.adminRejectForm(serviceNo, Number(formId), ship);
  if (!reset)
    return {
      success: false,
      code: 409,
      message:
        "Form could not be rejected. It may already be confirmed or rejected.",
    };

  await repo.insertFormApproval({
    formId: Number(formId),
    action: "REJECTED",
    fromStatus: currentFormStatus,
    toStatus: FORM_STATUS.REJECTED,
    performedBy,
    performerRole: "EMOL_ADMIN",
    remarks: remarks.trim(),
  });

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: serviceNo,
    oldValues: {
      Status: LEGACY_STATUS[currentFormStatus] ?? currentFormStatus,
    },
    newValues: {
      Status: null,
      rejectedBy: performedBy,
      remarks: remarks.trim(),
    },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message:
      "Form rejected successfully. Personnel will need to re-fill and resubmit.",
    data: {
      formId: Number(formId),
      serviceNo,
      newStatus: FORM_STATUS.REJECTED,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// REMOVE EXIT PERSONNEL
// ─────────────────────────────────────────────────────────────

async function removeExitPersonnel(payrollclass, performedBy, ip) {
  if (!payrollclass)
    return { success: false, code: 400, message: "payrollclass is required." };

  const deleted = await repo.removeExitPersonnel(payrollclass);

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "DELETE",
    recordKey: `EXIT:class=${payrollclass}`,
    oldValues: { payrollclass, upload: 0, serviceNumber: "empty" },
    newValues: { deleted },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `${deleted} exit personnel record(s) removed for payrollclass ${payrollclass}.`,
    data: { payrollclass, deleted },
  };
}

// ─────────────────────────────────────────────────────────────
// UPLOAD PERSONNEL
// ─────────────────────────────────────────────────────────────

async function uploadPersonnel(body, performedBy, ip) {
  const records = Array.isArray(body) ? body : [body];

  if (!records.length)
    return {
      success: false,
      code: 400,
      message: "At least one personnel record is required.",
    };

  const results = { inserted: 0, updated: 0, failed: [] };

  for (const record of records) {
    if (!record.serviceNumber || !record.surname) {
      results.failed.push({
        record: record.serviceNumber ?? "unknown",
        reason: "serviceNumber and surname are required.",
      });
      continue;
    }
    try {
      await repo.upsertPersonnel(record);
      await repo.insertAuditLog({
        tableName: "ef_personalinfos",
        action: "INSERT",
        recordKey: record.serviceNumber,
        oldValues: null,
        newValues: {
          serviceNumber: record.serviceNumber,
          surname: record.surname,
        },
        performedBy,
        ipAddress: ip,
      });
      results.inserted++;
    } catch (err) {
      results.failed.push({
        record: record.serviceNumber,
        reason: err.message,
      });
    }
  }

  return {
    success: true,
    message: `Upload complete. ${results.inserted} upserted, ${results.failed.length} failed.`,
    data: results,
  };
}

// ─────────────────────────────────────────────────────────────
// UPDATE SERVICE NUMBER (COMMISSION)
// ─────────────────────────────────────────────────────────────

async function updateServiceNumber(body, performedBy, ip) {
  const { old_svc_no, new_svc_no } = body;

  if (!old_svc_no || !new_svc_no)
    return {
      success: false,
      code: 400,
      message: "old_svc_no and new_svc_no are required.",
    };
  if (old_svc_no === new_svc_no)
    return {
      success: false,
      code: 400,
      message: "New service number must differ from old.",
    };

  const person = await repo.getPersonnelByServiceNo(old_svc_no);
  if (!person)
    return {
      success: false,
      code: 404,
      message: `Personnel not found: ${old_svc_no}`,
    };

  const isCommissioned = new_svc_no.toUpperCase().startsWith("N");

  await repo.updateServiceNumber(old_svc_no, new_svc_no);

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: old_svc_no,
    oldValues: {
      serviceNumber: old_svc_no,
      payrollclass: person.payrollclass,
      classes: person.classes,
    },
    newValues: {
      serviceNumber: new_svc_no,
      ...(isCommissioned ? { payrollclass: 1, classes: 1 } : {}),
    },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Service number updated: ${old_svc_no} → ${new_svc_no}${isCommissioned ? " (commissioned — payrollclass set to 1)" : ""}.`,
    data: { old_svc_no, new_svc_no, commissioned: isCommissioned },
  };
}

// ─────────────────────────────────────────────────────────────
// PAYROLL SYNC PREVIEW
// Lists confirmed-but-unsynced personnel for one or all classes.
// Does NOT commit anything.
// ─────────────────────────────────────────────────────────────

async function syncPayrollPreview(payrollclassRaw) {
  const classes = resolvePayrollClasses(payrollclassRaw);

  if (!classes)
    return {
      success: false,
      code: 400,
      message: `payrollclass must be one of: ${VALID_PAYROLL_CLASSES.join(", ")}, or ALL.`,
    };

  const preview = [];

  for (const cls of classes) {
    const serviceNumbers = await repo.getConfirmedForSync(cls);
    preview.push({
      payrollclass: cls,
      label: PAYROLL_CLASS_LABELS[cls],
      pendingSync: serviceNumbers.length,
      serviceNumbers,
    });
  }

  return {
    success: true,
    data: {
      classes: preview,
      totalPending: preview.reduce((sum, c) => sum + c.pendingSync, 0),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// PAYROLL SYNC — sync one class or all at once
// ─────────────────────────────────────────────────────────────

async function syncPayroll(body, performedBy, ip) {
  const { payrollclass: payrollclassRaw } = body;

  const classes = resolvePayrollClasses(payrollclassRaw);

  if (!classes)
    return {
      success: false,
      code: 400,
      message: `payrollclass must be one of: ${VALID_PAYROLL_CLASSES.join(", ")}, or ALL.`,
    };

  const summary = [];
  let totalSynced = 0;
  let totalFailed = 0;

  for (const cls of classes) {
    const serviceNumbers = await repo.getConfirmedForSync(cls);

    if (!serviceNumbers.length) {
      summary.push({
        payrollclass: cls,
        label: PAYROLL_CLASS_LABELS[cls],
        synced: 0,
        failed: [],
      });
      continue;
    }

    let synced = 0;
    const failed = [];

    // Resolve form IDs once for this class so we can write SYNCED approval rows
    const formIdMap = await repo.getFormIdMapForSync(cls);

    for (const svcNo of serviceNumbers) {
      try {
        await repo.markSyncedInPersonnel(svcNo, cls);
        await repo.syncToHrEmployees(svcNo);

        // Write immutable SYNCED row to the approval trail
        const formId = formIdMap[svcNo];
        if (formId) {
          await repo.insertFormApproval({
            formId,
            action: "SYNCED",
            fromStatus: "CPO_CONFIRMED",
            toStatus: "CPO_CONFIRMED", // status on ef_emolument_forms does not change on sync
            performedBy,
            performerRole: "EMOL_ADMIN",
            remarks: `Payroll sync — class ${cls} (${PAYROLL_CLASS_LABELS[cls]})`,
          });
        }

        synced++;
      } catch (err) {
        failed.push({ serviceNumber: svcNo, reason: err.message });
      }
    }

    await repo.insertAuditLog({
      tableName: "ef_personalinfos",
      action: "UPDATE",
      recordKey: `SYNC:class=${cls}`,
      oldValues: { Status: "Verified" },
      newValues: { Status: "Updated", synced, failed: failed.length },
      performedBy,
      ipAddress: ip,
    });

    summary.push({
      payrollclass: cls,
      label: PAYROLL_CLASS_LABELS[cls],
      synced,
      failed,
    });
    totalSynced += synced;
    totalFailed += failed.length;
  }

  return {
    success: true,
    message: `Payroll sync complete. ${totalSynced} record(s) synced, ${totalFailed} failed.`,
    data: { summary, totalSynced, totalFailed },
  };
}

// ─────────────────────────────────────────────────────────────
// EXTEND CYCLE
// Updates ef_control.enddate + sets status = 'Reopen'.
// Validates that the new date is after the current enddate.
// ─────────────────────────────────────────────────────────────

async function extendCycle(controlId, newEnddate, notes, performedBy, ip) {
  if (!Number.isInteger(controlId) || controlId < 1)
    return {
      success: false,
      code: 400,
      message: "control_id must be a positive integer.",
    };

  const row = await repo.getControlRowById(controlId);
  if (!row)
    return {
      success: false,
      code: 404,
      message: `Cycle control row not found: ${controlId}`,
    };

  if (row.status === "Close" && new Date(newEnddate) <= new Date(row.enddate))
    return {
      success: false,
      code: 400,
      message:
        "new_enddate must be after the current end date when reopening a closed cycle.",
    };

  await repo.extendCycle(controlId, newEnddate, notes, performedBy);

  await repo.insertAuditLog({
    tableName: "ef_control",
    action: "UPDATE",
    recordKey: String(controlId),
    oldValues: { enddate: row.enddate, status: row.status },
    newValues: { enddate: newEnddate, status: "Reopen", notes },
    performedBy,
    ipAddress: ip,
  });

  const updated = await repo.getControlRowById(controlId);
  return {
    success: true,
    message: `Cycle ${controlId} extended to ${newEnddate} with status Reopen.`,
    data: updated,
  };
}

// ─────────────────────────────────────────────────────────────
// FORM HISTORY — admin view of any personnel's form
// ─────────────────────────────────────────────────────────────

async function getPersonnelFormYears(serviceNo) {
  if (!serviceNo)
    return {
      success: false,
      code: 400,
      message: "Service number is required.",
    };

  const person = await repo.getPersonnelByServiceNo(serviceNo);
  if (!person)
    return {
      success: false,
      code: 404,
      message: "Personnel record not found.",
    };

  const years = await repo.getFormYearsForPersonnel(serviceNo);

  return {
    success: true,
    data: {
      serviceNumber: serviceNo,
      name: `${person.Surname} ${person.OtherName}`.trim(),
      years, // e.g. ['2024', '2025']
    },
  };
}

async function getPersonnelCurrentForm(serviceNo) {
  if (!serviceNo)
    return {
      success: false,
      code: 400,
      message: "Service number is required.",
    };

  const person = await repo.getPersonnelByServiceNo(serviceNo);
  if (!person)
    return {
      success: false,
      code: 404,
      message: "Personnel record not found.",
    };

  const formData = await repo.getCurrentFormForPersonnel(serviceNo);
  const approvals = formData ? await repo.getFormApprovals(formData.id) : [];

  return {
    success: true,
    data: {
      serviceNumber: serviceNo,
      name: `${person.Surname} ${person.OtherName}`.trim(),
      currentStatus: person.Status ?? null,
      form: formData ?? null,
      approvals,
    },
  };
}

async function getPersonnelFormHistory(serviceNo, year) {
  if (!serviceNo)
    return {
      success: false,
      code: 400,
      message: "Service number is required.",
    };

  const person = await repo.getPersonnelByServiceNo(serviceNo);
  if (!person)
    return {
      success: false,
      code: 404,
      message: "Personnel record not found.",
    };

  const formRow = await repo.getFormByServiceNoAndYear(serviceNo, year);
  if (!formRow)
    return {
      success: false,
      code: 404,
      message: `No form found for ${serviceNo} in year ${year}.`,
    };

  const approvals = await repo.getFormApprovals(formRow.id);

  // Parse snapshot if stored as string
  let snapshot = formRow.snapshot;
  if (snapshot && typeof snapshot === "string") {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      snapshot = null;
    }
  }

  return {
    success: true,
    data: {
      serviceNumber: serviceNo,
      name: `${person.Surname} ${person.OtherName}`.trim(),
      year,
      formId: formRow.id,
      formNumber: formRow.form_number,
      status: formRow.status,
      submittedAt: formRow.submitted_at,
      hasSnapshot: snapshot !== null,
      snapshot,
      approvals,
    },
  };
}

module.exports = {
  listRoles,
  assignRole,
  revokeRole,
  listMenus,
  getMenusForRole,
  setMenusForRole,
  searchPersonnel,
  getPersonnel,
  updateContact,
  bulkApprovePreview,
  bulkApproveShip,
  rejectForm,
  removeExitPersonnel,
  uploadPersonnel,
  updateServiceNumber,
  syncPayrollPreview,
  syncPayroll,
  extendCycle,
  getPersonnelFormYears,
  getPersonnelCurrentForm,
  getPersonnelFormHistory,
};
