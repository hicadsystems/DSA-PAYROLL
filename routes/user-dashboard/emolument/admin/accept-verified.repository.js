/**
 * FILE: routes/user-dashboard/emolument/admin/accept-verified.repository.js
 *
 * SQL for the "Accept Verified Forms" admin section.
 *
 * No schema migration required.
 * Acceptance and sync state are tracked entirely through
 * ef_form_approvals using two action values:
 *
 *   ADMIN_ACCEPTED  → admin reviewed and accepted the confirmed form
 *   SYNCED          → form was pushed to hr_employees by payroll sync
 *
 * These sit alongside the existing workflow actions
 * (SUBMITTED, DO_REVIEWED, FO_APPROVED, CPO_CONFIRMED, REJECTED)
 * and are visible in the full approval trail.
 *
 * "Pending" = CPO_CONFIRMED + NO SYNCED row in ef_form_approvals.
 * "Accepted" = CPO_CONFIRMED + ADMIN_ACCEPTED row present.
 * "Synced"   = CPO_CONFIRMED + SYNCED row present (Status='Updated').
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// LIST PENDING VERIFIED
//
// Returns CPO_CONFIRMED forms not yet SYNCED.
// Optional ?accepted= filter:
//   'yes' → only those with an ADMIN_ACCEPTED approval row
//   'no'  → only those without one (default view)
//   (omit) → all not-yet-synced regardless of acceptance state
// ─────────────────────────────────────────────────────────────

async function getPendingVerified(filters = {}, limit = 50, offset = 0) {
  pool.useDatabase(DB());

  const conditions = [
    "p.Status        = 'Verified'",
    "p.emolumentform = 'Yes'",
    // Exclude any form that already has a SYNCED approval row
    `NOT EXISTS (
       SELECT 1 FROM ef_form_approvals fa
       WHERE fa.form_id = f.id AND fa.action = 'SYNCED'
     )`,
  ];
  const params = [];

  if (filters.payrollclass) {
    conditions.push("p.payrollclass = ?");
    params.push(filters.payrollclass);
  }
  if (filters.ship) {
    conditions.push("p.ship = ?");
    params.push(filters.ship);
  }
  if (filters.command) {
    conditions.push("p.command = ?");
    params.push(filters.command);
  }

  // accepted filter — presence of ADMIN_ACCEPTED row
  if (filters.accepted === "yes") {
    conditions.push(
      `EXISTS (
         SELECT 1 FROM ef_form_approvals fa2
         WHERE fa2.form_id = f.id AND fa2.action = 'ADMIN_ACCEPTED'
       )`,
    );
  } else if (filters.accepted === "no") {
    conditions.push(
      `NOT EXISTS (
         SELECT 1 FROM ef_form_approvals fa2
         WHERE fa2.form_id = f.id AND fa2.action = 'ADMIN_ACCEPTED'
       )`,
    );
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const safeLimit = Math.min(Number(limit) || 50, 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const [rows] = await pool.query(
    `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.ship, p.command,
       p.email, p.gsm_number, p.Status, p.emolumentform,
       p.formNumber, p.FormYear,
       f.id           AS formId,
       f.status       AS formStatus,
       f.form_number  AS formNumber,
       f.form_year    AS formYear,
       f.submitted_at,
       -- Derived acceptance state from approval trail
       (SELECT fa2.performed_at FROM ef_form_approvals fa2
        WHERE fa2.form_id = f.id AND fa2.action = 'ADMIN_ACCEPTED'
        ORDER BY fa2.performed_at DESC LIMIT 1)  AS accepted_at,
       (SELECT fa2.performed_by FROM ef_form_approvals fa2
        WHERE fa2.form_id = f.id AND fa2.action = 'ADMIN_ACCEPTED'
        ORDER BY fa2.performed_at DESC LIMIT 1)  AS accepted_by
     FROM ef_personalinfos p
     INNER JOIN ef_emolument_forms f
       ON f.service_no = p.serviceNumber
      AND f.status     = 'CPO_CONFIRMED'
     ${where}
     ORDER BY p.ship ASC, p.Surname ASC
     LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset],
  );

  // Count query reuses the same WHERE but without the JOIN subqueries
  // so we rebuild it without the correlated subselects in SELECT.
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM ef_personalinfos p
     INNER JOIN ef_emolument_forms f
       ON f.service_no = p.serviceNumber
      AND f.status     = 'CPO_CONFIRMED'
     ${where}`,
    params,
  );

  return { rows, total };
}

// ─────────────────────────────────────────────────────────────
// GET CONFIRMED FORM DETAIL
// Returns form row + snapshot for a single personnel.
// ─────────────────────────────────────────────────────────────

async function getConfirmedFormDetail(serviceNo) {
  pool.useDatabase(DB());

  const [rows] = await pool.query(
    `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.ship, p.command,
       p.email, p.gsm_number, p.Status, p.emolumentform,
       f.id          AS formId,
       f.status      AS formStatus,
       f.form_number AS formNumber,
       f.form_year   AS formYear,
       f.snapshot,
       f.submitted_at, f.updated_at,
       (SELECT fa.performed_at FROM ef_form_approvals fa
        WHERE fa.form_id = f.id AND fa.action = 'ADMIN_ACCEPTED'
        ORDER BY fa.performed_at DESC LIMIT 1)  AS accepted_at,
       (SELECT fa.performed_by FROM ef_form_approvals fa
        WHERE fa.form_id = f.id AND fa.action = 'ADMIN_ACCEPTED'
        ORDER BY fa.performed_at DESC LIMIT 1)  AS accepted_by,
       (SELECT fa.performed_at FROM ef_form_approvals fa
        WHERE fa.form_id = f.id AND fa.action = 'SYNCED'
        ORDER BY fa.performed_at DESC LIMIT 1)  AS synced_at
     FROM ef_personalinfos p
     INNER JOIN ef_emolument_forms f
       ON f.service_no = p.serviceNumber
      AND f.status     = 'CPO_CONFIRMED'
     WHERE p.serviceNumber = ?
     LIMIT 1`,
    [serviceNo],
  );

  if (!rows.length) return null;

  const row = rows[0];
  if (row.snapshot && typeof row.snapshot === "string") {
    try {
      row.snapshot = JSON.parse(row.snapshot);
    } catch {
      row.snapshot = null;
    }
  }

  return row;
}

// ─────────────────────────────────────────────────────────────
// MARK ACCEPTED
//
// For each service number, inserts an ADMIN_ACCEPTED row into
// ef_form_approvals — but only if one doesn't already exist
// for that form (idempotent).
//
// Returns count of forms actually accepted (new rows inserted).
// ─────────────────────────────────────────────────────────────

async function markAccepted(serviceNumbers, acceptedBy) {
  if (!serviceNumbers.length) return 0;
  pool.useDatabase(DB());

  // Resolve form IDs for these service numbers (CPO_CONFIRMED only)
  const placeholders = serviceNumbers.map(() => "?").join(",");
  const [formRows] = await pool.query(
    `SELECT id AS formId, service_no AS serviceNo
     FROM ef_emolument_forms
     WHERE service_no IN (${placeholders})
       AND status = 'CPO_CONFIRMED'`,
    serviceNumbers,
  );

  if (!formRows.length) return 0;

  // Filter out any that already have an ADMIN_ACCEPTED row
  const formIds = formRows.map((r) => r.formId);
  const fphs = formIds.map(() => "?").join(",");
  const [alreadyAccepted] = await pool.query(
    `SELECT DISTINCT form_id FROM ef_form_approvals
     WHERE form_id IN (${fphs}) AND action = 'ADMIN_ACCEPTED'`,
    formIds,
  );
  const alreadySet = new Set(alreadyAccepted.map((r) => r.form_id));

  const toInsert = formRows.filter((r) => !alreadySet.has(r.formId));
  if (!toInsert.length) return 0;

  const now = new Date();
  const values = toInsert.map((r) => [
    r.formId,
    "ADMIN_ACCEPTED",
    "CPO_CONFIRMED", // from_status
    "CPO_CONFIRMED", // to_status — acceptance is not a status transition
    acceptedBy,
    "EMOL_ADMIN",
    null, // remarks
    now,
  ]);

  await pool.query(
    `INSERT INTO ef_form_approvals
       (form_id, action, from_status, to_status, performed_by, performer_role, remarks, performed_at)
     VALUES ?`,
    [values],
  );

  return toInsert.length;
}

// ─────────────────────────────────────────────────────────────
// FORCE REJECT CONFIRMED FORM
//
// Admin rejects a CPO_CONFIRMED form before payroll sync.
// Guard: rejects only if NO SYNCED row exists in ef_form_approvals
// (i.e. hasn't been pushed to hr_employees yet).
// ─────────────────────────────────────────────────────────────

async function forceRejectConfirmedForm(serviceNo, formId, ship) {
  pool.useDatabase(DB());
  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    // Guard: refuse if a SYNCED approval row already exists
    const [syncedRows] = await conn.query(
      `SELECT id FROM ef_form_approvals
       WHERE form_id = ? AND action = 'SYNCED'
       LIMIT 1`,
      [formId],
    );
    if (syncedRows.length) {
      await conn.rollback();
      return false; // already synced — cannot reject
    }

    // 1. Reset ef_personalinfos
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status        = NULL,
           emolumentform = NULL,
           dateModify    = NOW()
       WHERE serviceNumber = ?
         AND ship          = ?
         AND Status        = 'Verified'`,
      [serviceNo, ship],
    );

    if (r1.affectedRows === 0) {
      await conn.rollback();
      return false; // ship mismatch or status already changed
    }

    // 2. Reset ef_emolument_forms
    await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'REJECTED',
           updated_at = NOW()
       WHERE id     = ?
         AND status = 'CPO_CONFIRMED'`,
      [formId],
    );

    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  getPendingVerified,
  getConfirmedFormDetail,
  markAccepted,
  forceRejectConfirmedForm,
};
