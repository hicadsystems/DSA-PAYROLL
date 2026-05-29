/**
 * FILE: routes/user-dashboard/emolument/fo/fo.repository.js
 *
 * All SQL for the First Officer (FO) approval workflow.
 *
 * FO actions (from old SPs):
 *   - List DO_REVIEWED forms on their ship
 *   - View full form detail
 *   - Approve individual form  → UpdatePersonByIdByShipFO
 *   - Bulk approve by ship+class → UpdatePersonByShipFO
 *   - Reject form → reset to NULL
 *
 * CRITICAL — bulk approve uses Status = 'Filled' filter (not 'FO').
 * This matches the exact old SP behaviour (UpdatePersonByShipFO):
 *   WHERE status='Filled' AND ship=@ship AND classes=@classes
 *
 * TRANSACTION SAFETY:
 *   approveSingle, approveBulk, and rejectForm each write to two tables.
 *   All are wrapped in explicit transactions. approveBulk additionally
 *   bulk-inserts audit rows in one statement (not N individual inserts).
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
// LIST — DO_REVIEWED forms on a ship
// ─────────────────────────────────────────────────────────────

async function getDoReviewedForms(ship) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.formNumber, p.FormYear,
       p.Status, p.datecreated,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date,
       ef.id          AS form_id,
       ef.status      AS form_status,
       ef.submitted_at
     FROM ef_personalinfos p
     LEFT JOIN ef_emolument_forms ef
            ON ef.service_no = p.serviceNumber
           AND ef.ship       = p.ship
     WHERE p.ship   = ?
       AND p.Status = 'FO'
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
     ORDER BY p.Surname ASC, p.OtherName ASC`,
    [ship],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// GET FORM DETAIL — gates on ef_emolument_forms.status = 'DO_REVIEWED'
// ─────────────────────────────────────────────────────────────

async function getFormDetail(formId) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Title, p.Rank,
       p.Sex, p.MaritalStatus, p.Birthdate, p.religion,
       p.gsm_number, p.gsm_number2, p.email, p.home_address,
       p.BankACNumber, p.Bankcode, p.bankbranch, p.AccountName,
       p.pfacode, p.payrollclass, p.classes,
       p.specialisation, p.command, p.branch, p.ship,
       p.DateEmpl, p.seniorityDate, p.yearOfPromotion,
       p.expirationOfEngagementDate, p.runoutDate, p.advanceDate,
       p.StateofOrigin, p.LocalGovt, p.TaxCode,
       p.entry_mode, p.gradelevel, p.gradetype, p.taxed,
       p.entitlement, p.accomm_type,
       p.AcommodationStatus, p.AddressofAcommodation,
       p.GBC, p.GBC_Number, p.NSITFcode, p.NHFcode,
       p.qualification, p.division, p.NIN,
       p.formNumber, p.FormYear, p.Status,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date,
       p.fo_name, p.fo_rank, p.fo_svcno, p.fo_date,
       cmd.commandName,
       br.branchName,
       lga.lgaName,
       st.Name   AS stateName,
       ef.id     AS form_id,
       ef.status AS form_status,
       ef.submitted_at
     FROM ef_emolument_forms ef
     JOIN ef_personalinfos p
            ON p.serviceNumber = ef.service_no
     LEFT JOIN ef_commands   cmd ON cmd.code   = p.command
     LEFT JOIN ef_branches   br  ON br.code    = p.branch
     LEFT JOIN ef_localgovts lga ON lga.Id     = p.LocalGovt
     LEFT JOIN ef_states     st  ON st.StateId = p.StateofOrigin
     WHERE ef.id     = ?
       AND ef.status = 'DO_REVIEWED'
     LIMIT 1`,
    [formId],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// CHILD DATA FETCHERS — run in parallel via Promise.all()
// ─────────────────────────────────────────────────────────────

async function getNok(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT nok_order, full_name, relationship, phone1, phone2,
            email, address, national_id
     FROM ef_nok WHERE service_no = ? ORDER BY nok_order ASC`,
    [serviceNo],
  );
  return {
    primary: rows.find((r) => r.nok_order === 1) || null,
    alternate: rows.find((r) => r.nok_order === 2) || null,
  };
}

async function getSpouse(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT full_name, phone1, phone2, email
     FROM ef_spouse WHERE service_no = ? LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function getChildren(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT birth_order, child_name
     FROM ef_children WHERE service_no = ? ORDER BY birth_order ASC`,
    [serviceNo],
  );
  return rows;
}

async function getLoans(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT loan_type, amount, year_taken, tenor, balance, specify
     FROM ef_loans WHERE service_no = ?`,
    [serviceNo],
  );
  const out = {};
  rows.forEach((r) => {
    out[r.loan_type] = r;
  });
  return out;
}

async function getAllowances(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT allow_type, is_active, specify
     FROM ef_allowances WHERE service_no = ?`,
    [serviceNo],
  );
  const out = {};
  rows.forEach((r) => {
    out[r.allow_type] = r;
  });
  return out;
}

async function getDocuments(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT doc_type, url FROM ef_documents WHERE service_no = ?`,
    [serviceNo],
  );
  const out = {};
  rows.forEach((r) => {
    out[r.doc_type] = r;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
// INDIVIDUAL APPROVE — UpdatePersonByIdByShipFO equivalent
//
// TRANSACTION: ef_personalinfos update gates on Status='FO'.
// If that row isn't found (stale — already approved or rejected
// by another session), we throw STALE_STATUS and the whole
// transaction rolls back cleanly. The caller gets a clear error
// to surface to the FO ("This form has already been actioned").
// ─────────────────────────────────────────────────────────────

async function approveSingle(
  serviceNo,
  formId,
  ship,
  foName,
  foRank,
  foSvcNo,
  foDate,
  legacyStatus,
) {
  return withTransaction(async (conn) => {
    // 1. Update ef_personalinfos — gate on Status='FO' AND ship match
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status     = ?,
           fo_name    = ?,
           fo_rank    = ?,
           fo_svcno   = ?,
           fo_date    = ?,
           dateModify = NOW()
       WHERE serviceNumber = ?
         AND ship          = ?
         AND Status        = 'FO'`,
      [legacyStatus, foName, foRank, foSvcNo, foDate, serviceNo, ship],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(new Error("Form is not in DO_REVIEWED state"), {
        code: "STALE_STATUS",
      });
    }

    // 2. Update ef_emolument_forms — gate on DO_REVIEWED
    await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'FO_APPROVED',
           updated_at = NOW()
       WHERE id     = ?
         AND status  = 'DO_REVIEWED'`,
      [formId],
    );

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// BULK APPROVE — UpdatePersonByShipFO equivalent
//
// CRITICAL: filters WHERE Status = 'Filled' AND classes = @classes
// This matches the EXACT old SP behaviour — do not change to 'FO'.
//
// TRANSACTION: both table updates are inside one transaction.
// The pre-fetch of affected service numbers is done INSIDE the
// transaction so the set cannot change between fetch and update
// (another session approving the same records concurrently).
//
// Returns list of affected serviceNumbers for audit logging.
// ─────────────────────────────────────────────────────────────

async function approveBulk(
  ship,
  classes,
  foName,
  foRank,
  foSvcNo,
  foDate,
  legacyStatus,
) {
  return withTransaction(async (conn) => {
    // 1. Fetch affected personnel inside the transaction
    //    FOR UPDATE locks the rows so no concurrent bulk approve
    //    can grab the same set between our SELECT and UPDATE.
    const [affected] = await conn.query(
      `SELECT serviceNumber FROM ef_personalinfos
       WHERE ship    = ?
         AND classes = ?
         AND Status  = 'Filled'
         AND (emolumentform IS NULL OR emolumentform != 'Yes')
       FOR UPDATE`,
      [ship, classes],
    );

    if (affected.length === 0) return { count: 0, serviceNumbers: [] };

    // 2. Bulk update ef_personalinfos
    const [result] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status     = ?,
           fo_name    = ?,
           fo_rank    = ?,
           fo_svcno   = ?,
           fo_date    = ?,
           dateModify = NOW()
       WHERE ship    = ?
         AND classes = ?
         AND Status  = 'Filled'
         AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
      [legacyStatus, foName, foRank, foSvcNo, foDate, ship, classes],
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

// ─────────────────────────────────────────────────────────────
// GET BULK FORM IDS — for approval trail after bulk action
// ─────────────────────────────────────────────────────────────

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
// REJECT — reset form to NULL (personnel must re-fill)
// FO can only reject DO_REVIEWED forms (Status = 'FO')
//
// TRANSACTION: same two-table pattern as approveSingle.
// ─────────────────────────────────────────────────────────────

async function rejectForm(serviceNo, formId, ship) {
  return withTransaction(async (conn) => {
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status     = NULL,
           dateModify = NOW()
       WHERE serviceNumber = ?
         AND ship          = ?
         AND Status        = 'FO'`,
      [serviceNo, ship],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(new Error("Form is not in DO_REVIEWED state"), {
        code: "STALE_STATUS",
      });
    }

    await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'REJECTED',
           updated_at = NOW()
       WHERE id     = ?
         AND status  = 'DO_REVIEWED'`,
      [formId],
    );

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// APPROVAL TRAIL + AUDIT
// Bulk version accepts an array of formIds — one INSERT for N rows.
// Use bulkInsertFormApprovals after approveBulk instead of looping.
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
  getDoReviewedForms,
  getFormDetail,
  getNok,
  getSpouse,
  getChildren,
  getLoans,
  getAllowances,
  getDocuments,
  approveSingle,
  approveBulk,
  getFormIdsByServiceNos,
  rejectForm,
  insertFormApproval,
  bulkInsertFormApprovals,
  insertAuditLog,
};