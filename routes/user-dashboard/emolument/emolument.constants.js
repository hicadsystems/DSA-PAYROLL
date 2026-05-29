/**
 * FILE: modules/emolument/emolument.constants.js
 *
 * Single source of truth for emolument status values.
 *
 * ef_emolument_forms.status  → clean enum (authoritative workflow state)
 * ef_personalinfos.Status    → old SP strings (must stay for data compatibility)
 *
 * Every service module imports from here.
 * No status string is hardcoded anywhere else.
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// CLEAN ENUM — ef_emolument_forms.status
// These are the values stored in ef_emolument_forms.status
// ─────────────────────────────────────────────────────────────

const FORM_STATUS = Object.freeze({
  DRAFT:         'DRAFT',
  SUBMITTED:     'SUBMITTED',
  DO_REVIEWED:   'DO_REVIEWED',
  FO_APPROVED:   'FO_APPROVED',
  CPO_CONFIRMED: 'CPO_CONFIRMED',
  REJECTED:      'REJECTED',
});

// ─────────────────────────────────────────────────────────────
// OLD SP STRINGS — ef_personalinfos.Status
// These are the exact values the old stored procedures wrote.
// ef_personalinfos.Status must stay in sync with FORM_STATUS
// but uses these strings for backward compatibility.
// ─────────────────────────────────────────────────────────────

const LEGACY_STATUS = Object.freeze({
  DRAFT:         null,        // NULL in old system = not yet submitted
  SUBMITTED:     'Filled',    // Personnel submitted → waiting for DO
  DO_REVIEWED:   'FO',        // DO reviewed → waiting for FO   (old SP set 'FO' after DO action)
  FO_APPROVED:   'CPO',       // FO approved → waiting for CPO  (old SP set 'CPO' after FO action)
  CPO_CONFIRMED: 'Verified',  // CPO confirmed → complete
  REJECTED:      null,        // Rejected → reset to NULL (re-fill required)
});

// ─────────────────────────────────────────────────────────────
// MAPPING HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Get the ef_personalinfos.Status string for a given FORM_STATUS key.
 * Use this whenever writing to ef_personalinfos.Status.
 *
 * @param {string} formStatus  — a FORM_STATUS value
 * @returns {string|null}
 *
 * @example
 *   toLegacyStatus(FORM_STATUS.SUBMITTED)     // → 'Filled'
 *   toLegacyStatus(FORM_STATUS.DO_REVIEWED)   // → 'FO'
 *   toLegacyStatus(FORM_STATUS.REJECTED)      // → null
 */
function toLegacyStatus(formStatus) {
  const entry = Object.entries(FORM_STATUS).find(([, v]) => v === formStatus);
  if (!entry) return null;
  return LEGACY_STATUS[entry[0]] ?? null;
}

/**
 * Get the FORM_STATUS value for a given ef_personalinfos.Status string.
 * Use this when reading ef_personalinfos.Status and need the clean enum.
 *
 * @param {string|null} legacyStatus
 * @returns {string}
 *
 * @example
 *   toFormStatus('Filled')    // → 'SUBMITTED'
 *   toFormStatus('FO')        // → 'DO_REVIEWED'
 *   toFormStatus('CPO')       // → 'FO_APPROVED'
 *   toFormStatus(null)        // → 'DRAFT'
 */
function toFormStatus(legacyStatus) {
  if (!legacyStatus || legacyStatus.trim() === '') return FORM_STATUS.DRAFT;

  const entry = Object.entries(LEGACY_STATUS).find(
    ([, v]) => v === legacyStatus.trim(),
  );
  return entry ? FORM_STATUS[entry[0]] : FORM_STATUS.DRAFT;
}

// ─────────────────────────────────────────────────────────────
// ROLE CONSTANTS
// ─────────────────────────────────────────────────────────────

const EMOL_ROLE = Object.freeze({
  DO:         'DO',
  FO:         'FO',
  CPO:        'CPO',
  EMOL_ADMIN: 'EMOL_ADMIN',
});

// ─────────────────────────────────────────────────────────────
// FORM TYPE CONSTANTS
// ─────────────────────────────────────────────────────────────

const FORM_TYPE = Object.freeze({
  OFFICER:  'OFFICER',
  RATING:   'RATING',
  TRAINING: 'TRAINING',
});

/**
 * Resolve form type from payrollclass.
 * @param {string|number} payrollclass
 * @returns {'OFFICER'|'RATING'|'TRAINING'}
 */
function resolveFormType(payrollclass) {
  const c = String(payrollclass);
  if (c === '1') return FORM_TYPE.OFFICER;
  if (c === '6') return FORM_TYPE.TRAINING;
  return FORM_TYPE.RATING;
}

// ─────────────────────────────────────────────────────────────
// FORM NUMBER COLUMN MAP
// Maps payrollclass to ef_systeminfos column name.
// ─────────────────────────────────────────────────────────────

const FORM_NO_COLUMN = Object.freeze({
  '1': 'OfficersFormNo',
  '6': 'TrainingFormNo',
});

/**
 * Get the ef_systeminfos column for form number tracking.
 * @param {string|number} payrollclass
 * @returns {string}
 */
function resolveFormNoColumn(payrollclass) {
  return FORM_NO_COLUMN[String(payrollclass)] || 'RatingsFormNo';
}

// ─────────────────────────────────────────────────────────────
// VALID ENUM SETS (for input validation in repositories)
// ─────────────────────────────────────────────────────────────

const VALID_LOAN_TYPES = Object.freeze([
  'FGSHLS', 'CAR', 'WELFARE', 'NNNCS', 'NNMFBL', 'PPCFS', 'OTHER',
]);

const VALID_ALLOW_TYPES = Object.freeze([
  'AIRCREW', 'PILOT', 'SHIFT_DUTY', 'HAZARD',
  'RENT_SUBSIDY', 'SBC', 'SPECIAL_FORCES', 'CALL_DUTY', 'OTHER',
]);

const VALID_DOC_TYPES = Object.freeze([
  'PASSPORT', 'NOK_PASSPORT', 'ALT_NOK_PASSPORT',
]);

// ─────────────────────────────────────────────────────────────
// FO BULK APPROVE — status filter (matches old SP UpdatePersonByShipFO)
// FO bulk filters WHERE Status = 'Filled' in ef_personalinfos.
// This preserves exact old SP behaviour — do not change.
// ─────────────────────────────────────────────────────────────

const FO_BULK_FILTER_STATUS = LEGACY_STATUS.SUBMITTED; // 'Filled'

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  FORM_STATUS,
  LEGACY_STATUS,
  EMOL_ROLE,
  FORM_TYPE,
  VALID_LOAN_TYPES,
  VALID_ALLOW_TYPES,
  VALID_DOC_TYPES,
  FO_BULK_FILTER_STATUS,
  toLegacyStatus,
  toFormStatus,
  resolveFormType,
  resolveFormNoColumn,
};