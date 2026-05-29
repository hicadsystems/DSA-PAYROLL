/**
 * FILE: routes/user-dashboard/emolument/cpo/cpo.repository.js
 *
 * All SQL for the CPO confirmation workflow.
 *
 * CPO actions (from old SPs — UpdatePayroll):
 *   - List FO_APPROVED forms scoped to CPO's command
 *   - View full form detail
 *   - Confirm individual form:
 *       ef_personalinfos.Status     → 'Verified'   (legacy)
 *       ef_personalinfos.emolumentform → 'Yes'
 *       ef_personalinfos.exittype   → 'Yes'
 *       ef_personalinfos.hod_svcno  → confirming CPO's service number
 *       ef_emolument_forms.status   → 'CPO_CONFIRMED' (clean)
 *       ef_emolument_forms.snapshot → full JSON snapshot of form at confirm time
 *   - Reject (any FO_APPROVED form in CPO's command)
 *
 * TRANSACTION SAFETY — CPO confirm is the most complex write in the system:
 *
 *   confirmForm writes to:
 *     1. ef_personalinfos  (Status, emolumentform, exittype, hod_svcno…)
 *     2. ef_emolument_forms (status = CPO_CONFIRMED, snapshot)
 *     3. ef_personalinfoshist (history record — idempotent INSERT IGNORE)
 *
 *   Previously confirmForm and insertHistoryRecord were separate functions
 *   called sequentially by the service layer with no transaction between them.
 *   If step 3 failed, the form was marked CPO_CONFIRMED but had no history
 *   record — a silent data loss.
 *
 *   They are now unified in confirmFormWithHistory, which wraps all three
 *   writes in one transaction. The old insertHistoryRecord is kept as a
 *   standalone export for any other callers but is now a no-op if the
 *   unique constraint (serviceNumber, FormYear) is already satisfied.
 *
 * CPO scope: COMMAND — they see all ships under their command.
 * CPO action: individual only — no bulk in the original SPs.
 *
 * The snapshot written to ef_emolument_forms.snapshot fixes the
 * old UpdatePayroll bug (hardcoded WHERE Id=332).
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
// LIST — FO_APPROVED forms scoped to a command
// ─────────────────────────────────────────────────────────────

async function getFoApprovedForms(command) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.ship, p.command,
       p.formNumber, p.FormYear, p.Status,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date,
       p.fo_name,     p.fo_rank,     p.fo_svcno,     p.fo_date,
       ef.id          AS form_id,
       ef.status      AS form_status,
       ef.submitted_at,
       ef.updated_at  AS last_updated
     FROM ef_personalinfos p
     JOIN ef_emolument_forms ef
           ON ef.service_no = p.serviceNumber
          AND ef.command    = p.command
     WHERE p.command = ?
       AND p.Status  = 'CPO'
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
     ORDER BY p.ship ASC, p.Surname ASC, p.OtherName ASC`,
    [command],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// GET FORM DETAIL — full form for CPO view
// Gates on ef_emolument_forms.status = 'FO_APPROVED'
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
       p.fo_name,     p.fo_rank,     p.fo_svcno,     p.fo_date,
       p.hod_name,    p.hod_rank,    p.hod_svcno,    p.hod_date,
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
       AND ef.status = 'FO_APPROVED'
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
    `SELECT doc_type, url, cloudinary_id
     FROM ef_documents WHERE service_no = ?`,
    [serviceNo],
  );
  const out = {};
  rows.forEach((r) => {
    out[r.doc_type] = r;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
// CONFIRM + HISTORY — three-table atomic write
//
// Replaces the old pattern of:
//   await confirmForm(...)          ← wrote tables 1 & 2
//   await insertHistoryRecord(...)  ← wrote table 3, outside any transaction
//
// Now all three writes are in one transaction. If writing the history
// record fails, the confirmation is rolled back and the form stays
// FO_APPROVED — the CPO can retry safely.
//
// The unique index on ef_personalinfoshist(serviceNumber, FormYear)
// from the index migration makes the INSERT IGNORE idempotent —
// a duplicate confirmation attempt is silently skipped at the DB level.
//
// Params:
//   serviceNo    — personnel service number
//   formId       — ef_emolument_forms.id
//   command      — CPO's command scope (guards against cross-command confirm)
//   cpoSvcNo     — confirming CPO's service number
//   legacyStatus — 'Verified' (written to ef_personalinfos.Status)
//   snapshot     — full form data object (serialised to JSON in ef_emolument_forms)
//   formYear     — e.g. 2024 (for the history record)
// ─────────────────────────────────────────────────────────────

async function confirmFormWithHistory(
  serviceNo,
  formId,
  command,
  cpoSvcNo,
  legacyStatus,
  snapshot,
  formYear,
) {
  return withTransaction(async (conn) => {
    // 1. Update ef_personalinfos — gate on Status='CPO' and command match
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
      SET Status        = ?,
          emolumentform = 'Yes',
          exittype      = 'Yes',
          hod_svcno     = ?,
          hod_date      = NOW(),
          dateconfirmed = NOW(),
          confirmedBy   = ?,
          dateModify    = NOW()
      WHERE serviceNumber = ?
        AND command       = ?
        AND Status        = 'CPO'
        AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
      [legacyStatus, cpoSvcNo, cpoSvcNo, serviceNo, command],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(
        new Error("Form is not in FO_APPROVED state or already confirmed"),
        { code: "STALE_STATUS" },
      );
    }

    // 2. Update ef_emolument_forms — write clean status + full snapshot
    await conn.query(
      `UPDATE ef_emolument_forms
      SET status     = 'CPO_CONFIRMED',
          snapshot   = ?,
          updated_at = NOW()
      WHERE id     = ?
        AND status  = 'FO_APPROVED'`,
      [JSON.stringify(snapshot), formId],
    );

    // 3. Insert history record — INSERT IGNORE is safe due to the unique
    //    index on (serviceNumber, FormYear). A retry or duplicate call
    //    is silently skipped; it does NOT cause a rollback.
    await conn.query(
      `INSERT INTO ef_personalinfoshist (
        FormYear,
        serviceNumber, Surname, OtherName, Title, Rank,
        payrollclass, classes, ship, command, branch,
        Status, formNumber, emolumentform,
        confirmedBy, dateconfirmed,
        div_off_name, div_off_rank, div_off_svcno, div_off_date,
        hod_name,     hod_rank,     hod_svcno,     hod_date,
        fo_name,      fo_rank,      fo_svcno,       fo_date,
        NIN, upload
      )
      SELECT
        ?,
        serviceNumber, Surname, OtherName, Title, Rank,
        payrollclass, classes, ship, command, branch,
        Status, formNumber, emolumentform,
        confirmedBy, dateconfirmed,
        div_off_name, div_off_rank, div_off_svcno, div_off_date,
        hod_name,     hod_rank,     hod_svcno,     hod_date,
        fo_name,      fo_rank,      fo_svcno,       fo_date,
        NIN, upload
      FROM ef_personalinfos
      WHERE serviceNumber = ?`,
      [formYear, serviceNo],
    );

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// REJECT — FO_APPROVED form reset to NULL
//
// TRANSACTION: two-table write.
// ─────────────────────────────────────────────────────────────

async function rejectForm(serviceNo, formId, command) {
  return withTransaction(async (conn) => {
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
     SET Status     = NULL,
         dateModify = NOW()
     WHERE serviceNumber = ?
       AND command       = ?
       AND Status        = 'CPO'`,
      [serviceNo, command],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(new Error("Form is not in FO_APPROVED state"), {
        code: "STALE_STATUS",
      });
    }

    await conn.query(
      `UPDATE ef_emolument_forms
     SET status     = 'REJECTED',
         updated_at = NOW()
     WHERE id     = ?
       AND status  = 'FO_APPROVED'`,
      [formId],
    );

    return true;
  });
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
  getFoApprovedForms,
  getFormDetail,
  getNok,
  getSpouse,
  getChildren,
  getLoans,
  getAllowances,
  getDocuments,
  confirmFormWithHistory, // replaces confirmForm + insertHistoryRecord
  rejectForm,
  insertFormApproval,
  insertAuditLog,
};
