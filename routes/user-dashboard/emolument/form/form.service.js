/**
 * FILE: routes/user-dashboard/emolument/form/form.service.js
 *
 * Business logic for emolument form lifecycle.
 * Assembles form data from normalized tables.
 * Writes back to multiple tables on save/submit.
 *
 * Status mapping is handled entirely through emolument.constants:
 *   ef_emolument_forms.status  → clean enum  (FORM_STATUS)
 *   ef_personalinfos.Status    → legacy string (LEGACY_STATUS)
 *   toLegacyStatus()           → converts for writes to ef_personalinfos
 *   toFormStatus()             → converts for reads from ef_personalinfos
 *
 * First-timer init (no ef_ records at all):
 *   loadForm() detects getPersonCore() === null and falls back to
 *   hr_employees lookup. If found with emolumentform != 'Yes',
 *   a bare ef_personalinfos row is auto-created and the form loads
 *   prefilled from hr_employees fields. Completely transparent to the
 *   frontend — the response shape is identical to an existing personnel.
 */

"use strict";

const pool = require("../../../../config/db");
const repo = require("./form.repository");
const {
  FORM_STATUS,
  VALID_LOAN_TYPES,
  VALID_ALLOW_TYPES,
  toLegacyStatus,
  toFormStatus,
  resolveFormType,
  resolveFormNoColumn,
} = require("../emolument.constants");

// ─────────────────────────────────────────────────────────────
// GATE CHECK
// Checks ef_control directly — no ef_systeminfos dependency.
// resolveEffectiveStatus queries NOW() BETWEEN startdate AND enddate
// and returns isOpen based on status IN ('Open','Reopen').
// ef_ships.openship is kept in sync by the scheduler but we check
// ef_control here as the single source of truth.
// ─────────────────────────────────────────────────────────────

const controlService = require("../system/system.service");

async function checkFormEligibility(person) {
  const formType = resolveFormType(person.payrollclass);

  // Resolve against ef_control — ship='All' covers everyone
  const { isOpen } = await controlService.resolveEffectiveStatus(
    person.ship || "All",
    formType,
  );

  if (!isOpen) {
    return {
      allowed: false,
      reason:
        "The emolument form collection is currently closed for your ship/unit.",
    };
  }

  if (person.emolumentform === "Yes") {
    return {
      allowed: false,
      reason: "Your form has already been completed and confirmed.",
    };
  }

  const currentFormStatus = toFormStatus(person.Status);
  if (currentFormStatus !== FORM_STATUS.DRAFT) {
    return {
      allowed: false,
      reason: `Your form is currently under review (status: ${person.Status ?? "submitted"}). You cannot edit it at this stage.`,
    };
  }

  return { allowed: true, reason: null };
}

// ─────────────────────────────────────────────────────────────
// LOAD FORM
// Fetches all pieces in parallel then assembles into one object.
//
// First-timer path (no ef_ record exists):
//   1. getPersonCore() returns null
//   2. Lookup hr_employees WHERE Empl_ID = serviceNo
//      AND emolumentform != 'Yes'
//   3. If found → INSERT bare row into ef_personalinfos from hr_employees
//   4. Continue with normal load — child tables return empty (expected)
//   5. Frontend gets a prefilled form from hr_employees fields
//      with all extended fields blank, ready to fill in
//
// Existing personnel path (ef_ record exists):
//   Normal load — all child tables fetched in parallel.
// ─────────────────────────────────────────────────────────────

async function loadForm(serviceNo) {
  let person = await repo.getPersonCore(serviceNo);

  // ── First-timer path ─────────────────────────────────────
  if (!person) {
    const hrEmp = await repo.getFromHrEmployees(serviceNo);

    if (!hrEmp) {
      // Either not in hr_employees at all, or already confirmed (emolumentform='Yes')
      return {
        success: false,
        code: 404,
        message: "Personnel record not found or form already completed.",
      };
    }

    // Create the bare ef_personalinfos row from hr_employees data
    await repo.initPersonnelFromHr(hrEmp);

    // Re-fetch so person has the correct shape for all downstream logic
    person = await repo.getPersonCore(serviceNo);
    if (!person) {
      return {
        success: false,
        code: 500,
        message:
          "Failed to initialise personnel record. Contact administrator.",
      };
    }
  }
  // ── End first-timer path ─────────────────────────────────

  const formType = resolveFormType(person.payrollclass);
  const isTraining = formType === "TRAINING";

  const [core, nok, spouse, children, loans, allowances, documents, formYear] =
    await Promise.all([
      repo.loadPersonCore(serviceNo),
      repo.loadNok(serviceNo),
      repo.loadSpouse(serviceNo),
      repo.loadChildren(serviceNo),
      repo.loadLoans(serviceNo),
      repo.loadAllowances(serviceNo),
      repo.loadDocuments(serviceNo),
      repo.getProcessingYear(isTraining),
    ]);

  if (!core)
    return {
      success: false,
      code: 404,
      message: "Personnel record not found.",
    };

  const eligibility = await checkFormEligibility(person);
  const currentFormStatus = toFormStatus(person.Status);

  // Ensure ef_emolument_forms row exists from first open.
  // Idempotent — does nothing if row already exists.
  // This gives the form a stable form_id before submission so
  // DO/FO/CPO routes can always reference it via ef_emolument_forms.
  let formId = null;
  if (formYear && currentFormStatus === FORM_STATUS.DRAFT) {
    formId = await repo.initDraftForm(
      serviceNo,
      formYear,
      person.payrollclass,
      person.ship,
      person.command,
    );
  }

  return {
    success: true,
    data: {
      ...core,

      // Stable form ID from ef_emolument_forms — present from first load
      formId,

      // Clean enum status for frontend — never expose raw legacy strings
      formStatus: currentFormStatus,

      // Related tables — structured, not flat
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

      // Form metadata
      formYear,
      formType,
      canEdit: eligibility.allowed,
      editBlocked: eligibility.reason,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// LOAD FORM OPTIONS
// Fetches all form options from their respective tables
// ─────────────────────────────────────────────────────────────

async function loadFormOptions() {
  const options = await repo.getFormOptions();

  return {
    success: true,
    data: options,
    message: "Options Retrieved Successfully",
  };
}

// ─────────────────────────────────────────────────────────────
// LOAD HISTORICAL FORM
// Full data comes from ef_emolument_forms.snapshot.
// ef_personalinfoshist provides index metadata only.
// ─────────────────────────────────────────────────────────────

async function loadFormHistory(serviceNo, year) {
  const formData = await repo.loadHistoricalForm(serviceNo, year);
  if (!formData) {
    return {
      success: false,
      code: 404,
      message: `No confirmed form found for year ${year}.`,
    };
  }

  // If snapshot exists, the frontend gets the full form data.
  // If not (pre-migration legacy form), the frontend gets index
  // metadata only and should display a notice.
  return {
    success: true,
    data: formData,
    notice: formData.hasSnapshot
      ? null
      : "Full form data not available for this year. Only confirmation metadata is shown.",
  };
}

// ─────────────────────────────────────────────────────────────
// SAVE DRAFT
// Writes to all relevant tables. Does NOT change Status.
// ─────────────────────────────────────────────────────────────

async function saveDraft(serviceNo, body, performedBy, ip) {
  const person = await repo.getPersonCore(serviceNo);
  if (!person)
    return {
      success: false,
      code: 404,
      message: "Personnel record not found.",
    };

  const eligibility = await checkFormEligibility(person);
  if (!eligibility.allowed)
    return { success: false, code: 403, message: eligibility.reason };

  await repo.savePersonCore(serviceNo, body.core || {});
  await repo.saveNok(serviceNo, body.nok?.primary, body.nok?.alternate);
  await repo.saveSpouse(serviceNo, body.spouse);
  await repo.saveChildren(serviceNo, body.children);
  await repo.saveLoans(serviceNo, body.loans, VALID_LOAN_TYPES);
  await repo.saveAllowances(serviceNo, body.allowances, VALID_ALLOW_TYPES);

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: serviceNo,
    oldValues: null,
    newValues: { action: "DRAFT_SAVED" },
    performedBy,
    ipAddress: ip,
  });

  return { success: true, message: "Draft saved successfully." };
}

// ─────────────────────────────────────────────────────────────
// SUBMIT FORM
// All 7 table writes are wrapped in a single transaction.
// If any write fails, everything rolls back — no partial state.
//
// Steps INSIDE transaction (repo.submitAllTables):
//   savePersonCore, saveNok, saveSpouse, saveChildren,
//   saveLoans, saveAllowances, markSubmitted
//
// Steps OUTSIDE transaction (after commit):
//   upsertEmolumentForm, incrementFormNumber,
//   insertFormApproval, insertAuditLog
//
// Form number assignment strategy:
//   Read current counter → use it → commit all writes → increment.
//   Gaps in form numbers are acceptable (crash between commit + increment).
//   Duplicate form numbers are NOT acceptable — the gate in markSubmitted
//   (WHERE Status IS NULL) prevents double submission.
// ─────────────────────────────────────────────────────────────

async function submitForm(serviceNo, body, performedBy, ip) {
  const person = await repo.getPersonCore(serviceNo);
  if (!person)
    return {
      success: false,
      code: 404,
      message: "Personnel record not found.",
    };

  const eligibility = await checkFormEligibility(person);
  if (!eligibility.allowed)
    return { success: false, code: 403, message: eligibility.reason };

  const formType = resolveFormType(person.payrollclass);
  const isTraining = formType === "TRAINING";
  const formYear = await repo.getProcessingYear(isTraining);

  if (!formYear) {
    return {
      success: false,
      code: 500,
      message: "Processing year not configured. Contact administrator.",
    };
  }

  // Resolve form number column from constants
  const formNoCol = resolveFormNoColumn(person.payrollclass);
  const formNumber = await repo.getCurrentFormNumber(formNoCol);

  // Legacy status string for ef_personalinfos
  const legacyStatus = toLegacyStatus(FORM_STATUS.SUBMITTED); // → 'Filled'

  // Clean enum status for ef_emolument_forms
  const formStatus = FORM_STATUS.SUBMITTED;

  // ── Atomic write — all 7 tables in one transaction ────────
  let affectedRows;
  try {
    affectedRows = await pool.smartTransaction(async (conn) => {
      return repo.submitAllTables(
        conn,
        serviceNo,
        body,
        String(formNumber),
        formYear,
        legacyStatus,
        VALID_LOAN_TYPES,
        VALID_ALLOW_TYPES,
      );
    });
  } catch (err) {
    console.error("❌ submitForm transaction failed:", err.message);
    return {
      success: false,
      code: 500,
      message: "Form submission failed. Please try again.",
    };
  }

  if (!affectedRows) {
    return {
      success: false,
      code: 409,
      message:
        "Form could not be submitted. It may already be in review or completed.",
    };
  }
  // ── Transaction committed ─────────────────────────────────

  // Upsert ef_emolument_forms — safe outside transaction, idempotent
  await repo.upsertEmolumentForm(
    serviceNo,
    formYear,
    String(formNumber),
    person.payrollclass,
    person.ship,
    person.command,
    formStatus,
  );

  // Get form id for approval log
  const formId = await repo.getEmolumentFormId(serviceNo, formYear);

  // Increment form number counter — outside transaction intentionally.
  // A gap (crash here) is acceptable. A duplicate is not.
  await repo.incrementFormNumber(formNoCol);

  // Approval trail
  if (formId) {
    await repo.insertFormApproval({
      formId,
      action: "SUBMITTED",
      fromStatus: null,
      toStatus: formStatus,
      performedBy,
      performerRole: "PERSONNEL",
      remarks: null,
    });
  }

  // Audit log
  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: serviceNo,
    oldValues: { Status: null },
    newValues: {
      Status: legacyStatus,
      formNumber: String(formNumber),
      FormYear: formYear,
    },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: "Form submitted successfully.",
    data: { formNumber: String(formNumber), formYear, status: formStatus },
  };
}

// ─────────────────────────────────────────────────────────────
// OPEN NEW CYCLE
//
// Called by admin when creating/activating a new processing year.
// Archives unconfirmed submissions from the previous year and
// resets their Status so they can fill the form again.
//
// previousYear: the year being closed e.g. '2025'
// ─────────────────────────────────────────────────────────────

async function openNewCycle(previousYear, performedBy, ip) {
  if (!previousYear || !/^\d{4}$/.test(String(previousYear))) {
    return {
      success: false,
      code: 400,
      message: "previousYear must be a 4-digit year.",
    };
  }

  const resetCount = await repo.archiveAndResetCycle(
    String(previousYear),
    performedBy,
  );

  await repo.insertAuditLog({
    tableName: "ef_personalinfos",
    action: "UPDATE",
    recordKey: `NEW_CYCLE:prev=${previousYear}`,
    oldValues: { Status: "various", FormYear: previousYear },
    newValues: { Status: null, FormYear: null, resetCount },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `New cycle opened. ${resetCount} personnel record(s) archived and reset for year ${previousYear}.`,
    data: { previousYear, resetCount },
  };
}

module.exports = {
  loadForm,
  loadFormHistory,
  saveDraft,
  submitForm,
  loadFormOptions,
};
