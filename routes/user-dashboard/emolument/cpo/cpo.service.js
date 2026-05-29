/**
 * FILE: routes/user-dashboard/emolument/cpo/cpo.service.js
 *
 * Business logic for CPO confirmation workflow.
 *
 * CPO rules (from old UpdatePayroll SP):
 *   - Individual confirm only — no bulk
 *   - Gates on ef_personalinfos.Status = 'CPO' (legacy FO_APPROVED)
 *   - Sets emolumentform = 'Yes', exittype = 'Yes', Status = 'Verified'
 *   - Sets hod_svcno = CPO's own service number (confirming officer)
 *   - Writes full JSON snapshot to ef_emolument_forms.snapshot
 *     (fixes the old hardcoded WHERE Id=332 bug)
 *   - Copies record into ef_personalinfoshist (year-on-year archive)
 *   - Rejection resets both tables to NULL/REJECTED
 *
 * Snapshot includes all form data at the moment of confirmation:
 * core, nok, spouse, children, loans, allowances, documents.
 * This snapshot is the permanent record of what was confirmed.
 */

"use strict";

const repo = require("./cpo.repository");
const { invalidateCommandCache } = require("../reports/reports.service");
const {
  FORM_STATUS,
  LEGACY_STATUS,
  toLegacyStatus,
} = require("../emolument.constants");

// ─────────────────────────────────────────────────────────────
// LIST FO_APPROVED FORMS — scoped to CPO's command
// ─────────────────────────────────────────────────────────────

async function listFoApprovedForms(command) {
  if (!command)
    return { success: false, code: 400, message: "Command is required." };

  const forms = await repo.getFoApprovedForms(command);
  return { success: true, data: forms };
}

// ─────────────────────────────────────────────────────────────
// GET FULL FORM — for CPO to view before confirming
// ─────────────────────────────────────────────────────────────

async function getForm(formId, cpoCommands) {
  const form = await repo.getFormDetail(formId);
  if (!form) {
    return {
      success: false,
      code: 404,
      message: "Form not found or not in FO_APPROVED status.",
    };
  }

  // Scope check — CPO scoped to command
  if (cpoCommands !== "ALL" && !cpoCommands.includes(form.command)) {
    return {
      success: false,
      code: 403,
      message: "Access denied. This form is not under your command.",
    };
  }

  const [nok, spouse, children, loans, allowances, documents] =
    await Promise.all([
      repo.getNok(form.serviceNumber),
      repo.getSpouse(form.serviceNumber),
      repo.getChildren(form.serviceNumber),
      repo.getLoans(form.serviceNumber),
      repo.getAllowances(form.serviceNumber),
      repo.getDocuments(form.serviceNumber),
    ]);

  return {
    success: true,
    data: {
      ...form,
      nok,
      spouse,
      children,
      loans,
      allowances,
      documents: {
        passport: documents["PASSPORT"] || null,
        nokPassport: documents["NOK_PASSPORT"] || null,
        altNokPassport: documents["ALT_NOK_PASSPORT"] || null,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// CONFIRM FORM
// CPO's service number always comes from req.user_id.
// Snapshot is built from live data at confirm time.
// ─────────────────────────────────────────────────────────────

async function confirmForm(formId, cpoCommand, performedBy, ip) {
  const form = await repo.getFormDetail(formId);
  if (!form) {
    return {
      success: false,
      code: 404,
      message: "Form not found or not in FO_APPROVED status.",
    };
  }

  if (cpoCommand !== "ALL" && form.command !== cpoCommand) {
    return {
      success: false,
      code: 403,
      message: "Access denied. This form is not under your command.",
    };
  }

  // Build full snapshot from live data at confirm time
  // This is the permanent record — all child tables included
  const [nok, spouse, children, loans, allowances, documents] =
    await Promise.all([
      repo.getNok(form.serviceNumber),
      repo.getSpouse(form.serviceNumber),
      repo.getChildren(form.serviceNumber),
      repo.getLoans(form.serviceNumber),
      repo.getAllowances(form.serviceNumber),
      repo.getDocuments(form.serviceNumber),
    ]);

  const snapshot = {
    confirmedAt: new Date().toISOString(),
    confirmedBy: performedBy,
    core: form,
    nok,
    spouse,
    children,
    loans,
    allowances,
    documents,
  };

  // Legacy status for ef_personalinfos
  const legacyStatus = toLegacyStatus(FORM_STATUS.CPO_CONFIRMED); // → 'Verified'

  const confirmed = await repo.confirmFormWithHistory(
    form.serviceNumber,
    formId,
    form.command,
    performedBy,
    legacyStatus,
    snapshot,
    form.FormYear,       // ← new param — was passed to insertHistoryRecord before
  );

  if (!confirmed) {
    return {
      success: false,
      code: 409,
      message:
        "Form could not be confirmed. It may have already been confirmed or is not in FO_APPROVED status.",
    };
  }

  invalidateCommandCache(form.command);

  // Write to history archive (ef_personalinfoshist)
  // await repo.insertHistoryRecord(form.serviceNumber, form.FormYear);

  // Approval trail
  await repo.insertFormApproval({
    formId,
    action: "CPO_CONFIRMED",
    fromStatus: FORM_STATUS.FO_APPROVED,
    toStatus: FORM_STATUS.CPO_CONFIRMED,
    performedBy,
    performerRole: "CPO",
    remarks: null,
  });

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: form.serviceNumber,
    oldValues: { Status: LEGACY_STATUS.FO_APPROVED, emolumentform: null },
    newValues: {
      Status: legacyStatus,
      emolumentform: "Yes",
      exittype: "Yes",
      hod_svcno: performedBy,
      confirmedBy: performedBy,
    },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: "Form confirmed successfully.",
    data: {
      formId,
      serviceNumber: form.serviceNumber,
      formNumber: form.formNumber,
      formYear: form.FormYear,
      newStatus: FORM_STATUS.CPO_CONFIRMED,
      confirmedBy: performedBy,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// REJECT — FO_APPROVED form reset to NULL
// Body: { remarks }
// ─────────────────────────────────────────────────────────────

async function rejectForm(formId, cpoCommand, body, performedBy, ip) {
  const { remarks } = body;

  if (!remarks || !remarks.trim()) {
    return {
      success: false,
      code: 400,
      message: "Rejection reason (remarks) is required.",
    };
  }

  const form = await repo.getFormDetail(formId);
  if (!form) {
    return {
      success: false,
      code: 404,
      message: "Form not found or not in FO_APPROVED status.",
    };
  }

  if (cpoCommand !== "ALL" && form.command !== cpoCommand) {
    return {
      success: false,
      code: 403,
      message: "Access denied. This form is not under your command.",
    };
  }

  const reset = await repo.rejectForm(form.serviceNumber, formId, form.command);
  if (!reset) {
    return {
      success: false,
      code: 409,
      message:
        "Form could not be rejected. It may have already been processed.",
    };
  }

  await repo.insertFormApproval({
    formId,
    action: "REJECTED",
    fromStatus: FORM_STATUS.FO_APPROVED,
    toStatus: FORM_STATUS.REJECTED,
    performedBy,
    performerRole: "CPO",
    remarks: remarks.trim(),
  });

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: form.serviceNumber,
    oldValues: { Status: LEGACY_STATUS.FO_APPROVED },
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
    message: "Form rejected. Personnel will need to re-fill and resubmit.",
    data: {
      formId,
      serviceNumber: form.serviceNumber,
      newStatus: FORM_STATUS.REJECTED,
    },
  };
}

module.exports = {
  listFoApprovedForms,
  getForm,
  confirmForm,
  rejectForm,
};
