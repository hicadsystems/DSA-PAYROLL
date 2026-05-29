/**
 * FILE: routes/user-dashboard/emolument/form/form.repository.js
 *
 * All SQL for the emolument form lifecycle.
 * ef_personalinfos holds core identity/service only.
 * Related data lives in normalized tables:
 *   ef_nok        → next of kin (rows, nok_order 1 & 2)
 *   ef_spouse     → spouse
 *   ef_children   → children (rows, birth_order 1-4)
 *   ef_loans      → loans (rows per loan_type)
 *   ef_allowances → allowances (rows per allow_type)
 *   ef_documents  → photo URLs (rows per doc_type)
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// SYSTEM STATE
// ─────────────────────────────────────────────────────────────

async function getSystemInfo() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT SiteStatus, opendate, closedate,
            OfficersFormNo, RatingsFormNo, TrainingFormNo
     FROM ef_systeminfos LIMIT 1`,
  );
  return rows[0] || null;
}

async function getProcessingYear(isTraining = false) {
  pool.useDatabase(DB());
  const where = isTraining ? `WHERE ship = 'All'` : "";
  const [rows] = await pool.query(
    `SELECT DISTINCT processingyear FROM ef_control ${where} LIMIT 1`,
  );
  return rows[0]?.processingyear || null;
}

async function getShipOpenStatus(shipName) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT openship FROM ef_ships WHERE shipName = ? LIMIT 1`,
    [shipName],
  );
  return rows[0]?.openship ?? 0;
}

// ─────────────────────────────────────────────────────────────
// FIRST-TIMER INIT — hr_employees lookup + ef_personalinfos create
//
// Called when getPersonCore() returns null — personnel authenticated
// via hr_employees but have never been in any ef_ table before.
// Condition: emolumentform != 'Yes' ensures we never re-init someone
// who has already been confirmed in a previous cycle.
// ─────────────────────────────────────────────────────────────

async function getFromHrEmployees(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       Empl_ID      AS serviceNumber,
       Surname,
       OtherName,
       Title,
       email,
       TELEPHONE    AS gsm_number,
       payrollclass,
       command,
       Location     AS ship,
       specialisation,
       bankcode,
       accountno    AS BankACNumber,
       DateEmpl,
       Birthdate,
       emolumentform
     FROM hr_employees
     WHERE Empl_ID = ?
       AND (emolumentform IS NULL OR emolumentform != 'Yes')
     LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function initPersonnelFromHr(emp) {
  pool.useDatabase(DB());

  // Resolve classes from payrollclass
  const payrollclass = String(emp.payrollclass);
  let classes;
  if (payrollclass === "1") classes = 1;
  else if (payrollclass === "6") classes = 3;
  else classes = 2;

  await pool.query(
    `INSERT INTO ef_personalinfos
       (serviceNumber, Surname, OtherName, Title, Rank, email,
        gsm_number, payrollclass, classes, command, ship,
        specialisation, Bankcode, BankACNumber,
        DateEmpl, Birthdate, AccountName, upload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      emp.serviceNumber,
      emp.Surname ?? null,
      emp.OtherName ?? null,
      emp.Title ?? null,
      emp.Title ?? null, // Rank mirrors Title in hr_employees
      emp.email ?? null,
      emp.gsm_number ?? null,
      emp.payrollclass,
      classes,
      emp.command ?? null,
      emp.ship ?? null,
      emp.specialisation ?? null,
      emp.bankcode ?? null,
      emp.BankACNumber ?? null,
      emp.DateEmpl ?? null,
      emp.Birthdate ?? null,
      emp.Surname && emp.OtherName
        ? `${emp.Surname} ${emp.OtherName}`
        : (emp.Surname ?? null),
    ],
  );
}

// ─────────────────────────────────────────────────────────────
// PERSON CORE (status + eligibility checks only)
// ─────────────────────────────────────────────────────────────

async function getPersonCore(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT serviceNumber, Status, emolumentform, ship,
            payrollclass, classes, exittype, formNumber
     FROM ef_personalinfos
     WHERE serviceNumber = ? LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// LOAD FORM — each piece separately, assembled in service layer
// ─────────────────────────────────────────────────────────────

async function loadPersonCore(serviceNo) {
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
       p.entitlement, p.town, p.accomm_type,
       p.AcommodationStatus, p.AddressofAcommodation,
       p.NSITFcode, p.NHFcode,
       p.qualification, p.division, p.NIN,
       p.formNumber, p.FormYear, p.Status, p.emolumentform,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date,
       p.hod_name, p.hod_rank, p.hod_svcno, p.hod_date,
       p.cdr_name, p.cdr_rank, p.cdr_svcno, p.cdr_date,
       p.fo_name, p.fo_rank, p.fo_svcno, p.fo_date,
       p.datecreated, p.dateModify, p.confirmedBy, p.dateconfirmed,
       cmd.commandName,
       br.branchName,
       lga.lgaName,
       st.Name AS stateName,
       CONCAT(p.Surname, ' ', p.OtherName) AS fullAccountName
     FROM ef_personalinfos p
     LEFT JOIN ef_commands   cmd ON cmd.code    = p.command
     LEFT JOIN ef_branches   br  ON br.code     = p.branch
     LEFT JOIN ef_localgovts lga ON lga.Id      = p.LocalGovt
     LEFT JOIN ef_states     st  ON st.StateId  = p.StateofOrigin
     WHERE p.serviceNumber = ?`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function loadNok(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT nok_order, full_name, relationship, phone1, phone2,
            email, address, national_id
     FROM ef_nok
     WHERE service_no = ?
     ORDER BY nok_order ASC`,
    [serviceNo],
  );
  return {
    primary: rows.find((r) => r.nok_order === 1) || null,
    alternate: rows.find((r) => r.nok_order === 2) || null,
  };
}

async function loadSpouse(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT full_name, phone1, phone2, email
     FROM ef_spouse WHERE service_no = ? LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function loadChildren(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT birth_order, child_name
     FROM ef_children WHERE service_no = ?
     ORDER BY birth_order ASC`,
    [serviceNo],
  );
  return rows;
}

async function loadLoans(serviceNo) {
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

async function loadAllowances(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT allow_type, is_active, specify
     FROM ef_allowances WHERE service_no = ?`,
    [serviceNo],
  );

  // For GBC => GCB (wrong data typing and storage)

  const [gbc] = await pool.query(
    `SELECT GBC, GBC_Number from ef_personalinfos WHERE serviceNumber = ? AND GBC IS NOT NULL LIMIT 1`,
    [serviceNo]
  );

  const out = {};
  rows.forEach((r) => {
    out[r.allow_type] = r;
  });
  out['GCB'] = gbc[0]?.GBC ? { allow_type: 'GCB', is_active: 1, specify: null , gcb_number: gbc[0].GBC_Number } : undefined;
  return out;
}

async function loadDocuments(serviceNo) {
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
// LOAD HISTORICAL FORM — fetch from snapshot (post-migration)
//
// After migration_drop_flat_columns.sql is run,
// ef_personalinfoshist is a slim index table only.
// Full historical form data lives in ef_emolument_forms.snapshot.
//
// This function:
//   1. Looks up the index row in ef_personalinfoshist (for metadata)
//   2. Fetches the full snapshot from ef_emolument_forms
//   3. Returns both merged — snapshot is the authoritative data source
//
// If no snapshot exists (form confirmed before this system was live),
// falls back to whatever is in ef_personalinfoshist index row.
// ─────────────────────────────────────────────────────────────

async function loadHistoricalForm(serviceNo, year) {
  pool.useDatabase(DB());

  // 1. Get index row from ef_personalinfoshist
  const [histRows] = await pool.query(
    `SELECT
       h.FormYear, h.serviceNumber, h.Surname, h.OtherName,
       h.Title, h.Rank, h.payrollclass, h.classes,
       h.ship, h.command, h.branch, h.Status,
       h.formNumber, h.emolumentform,
       h.confirmedBy, h.dateconfirmed,
       h.div_off_name, h.div_off_rank, h.div_off_svcno, h.div_off_date,
       h.hod_name,     h.hod_rank,     h.hod_svcno,     h.hod_date,
       h.fo_name,      h.fo_rank,      h.fo_svcno,       h.fo_date,
       h.NIN, h.upload,
       cmd.commandName, br.branchName
     FROM ef_personalinfoshist h
     LEFT JOIN ef_commands cmd ON cmd.code = h.command
     LEFT JOIN ef_branches br  ON br.code  = h.branch
     WHERE h.serviceNumber = ? AND h.FormYear = ?
     LIMIT 1`,
    [serviceNo, year],
  );

  const histRow = histRows[0] || null;

  // 2. Get full snapshot from ef_emolument_forms
  const [snapRows] = await pool.query(
    `SELECT snapshot, submitted_at, updated_at
     FROM ef_emolument_forms
     WHERE service_no = ?
       AND form_year  = ?
       AND status     = 'CPO_CONFIRMED'
     LIMIT 1`,
    [serviceNo, String(year)],
  );

  const snapRow = snapRows[0] || null;

  // No data at all — form never confirmed for this year
  if (!histRow && !snapRow) return null;

  // 3. Parse snapshot if available
  let snapshotData = null;
  if (snapRow?.snapshot) {
    try {
      snapshotData =
        typeof snapRow.snapshot === "string"
          ? JSON.parse(snapRow.snapshot)
          : snapRow.snapshot;
    } catch {
      // Snapshot malformed — log and continue with index row only
      console.warn(`⚠️  Malformed snapshot for ${serviceNo}/${year}`);
    }
  }

  // 4. Merge: snapshot is authoritative for form data,
  //    histRow provides index metadata as fallback
  return {
    // Index metadata (always from histRow where available)
    FormYear: histRow?.FormYear ?? year,
    serviceNumber: histRow?.serviceNumber ?? serviceNo,
    Surname: histRow?.Surname,
    OtherName: histRow?.OtherName,
    Title: histRow?.Title,
    Rank: histRow?.Rank,
    payrollclass: histRow?.payrollclass,
    classes: histRow?.classes,
    ship: histRow?.ship,
    command: histRow?.command,
    commandName: histRow?.commandName,
    branch: histRow?.branch,
    branchName: histRow?.branchName,
    Status: histRow?.Status,
    formNumber: histRow?.formNumber,
    emolumentform: histRow?.emolumentform,
    confirmedBy: histRow?.confirmedBy,
    dateconfirmed: histRow?.dateconfirmed,
    div_off_name: histRow?.div_off_name,
    div_off_rank: histRow?.div_off_rank,
    div_off_svcno: histRow?.div_off_svcno,
    div_off_date: histRow?.div_off_date,
    hod_name: histRow?.hod_name,
    hod_rank: histRow?.hod_rank,
    hod_svcno: histRow?.hod_svcno,
    hod_date: histRow?.hod_date,
    fo_name: histRow?.fo_name,
    fo_rank: histRow?.fo_rank,
    fo_svcno: histRow?.fo_svcno,
    fo_date: histRow?.fo_date,
    NIN: histRow?.NIN,

    // Full snapshot data — null if not available (pre-migration forms)
    snapshot: snapshotData,
    hasSnapshot: snapshotData !== null,
    submittedAt: snapRow?.submitted_at ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// SAVE — ef_personalinfos core columns only
// ─────────────────────────────────────────────────────────────

async function savePersonCore(serviceNo, f) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_personalinfos SET
       Surname                    = ?,
       OtherName                  = ?,
       Sex                        = ?,
       MaritalStatus              = ?,
       Birthdate                  = ?,
       religion                   = ?,
       gsm_number                 = ?,
       gsm_number2                = ?,
       email                      = ?,
       home_address               = ?,
       BankACNumber               = ?,
       Bankcode                   = ?,
       bankbranch                 = ?,
       pfacode                    = ?,
       specialisation             = ?,
       command                    = ?,
       branch                     = ?,
       DateEmpl                   = ?,
       seniorityDate              = ?,
       yearOfPromotion            = ?,
       expirationOfEngagementDate = ?,
       StateofOrigin              = ?,
       LocalGovt                  = ?,
       TaxCode                    = ?,
       entry_mode                 = ?,
       gradelevel                 = ?,
       gradetype                  = ?,
       taxed                      = ?,
       accomm_type                = ?,
       AcommodationStatus         = ?,
       AddressofAcommodation      = ?,
       GBC                        = ?,
       GBC_Number                 = ?,
       NSITFcode                  = ?,
       NHFcode                    = ?,
       qualification              = ?,
       division                   = ?,
       entitlement                = ?,
       advanceDate                = ?,
       runoutDate                 = ?,
       NIN                        = ?,
       AccountName                = ?,
       dateModify                 = NOW()
     WHERE serviceNumber = ?`,
    [
      f.Surname,
      f.OtherName,
      f.Sex,
      f.MaritalStatus,
      f.Birthdate,
      f.religion,
      f.gsm_number,
      f.gsm_number2,
      f.email,
      f.home_address,
      f.BankACNumber,
      f.Bankcode,
      f.bankbranch,
      f.pfacode,
      f.specialisation,
      f.command,
      f.branch,
      f.DateEmpl,
      f.seniorityDate,
      f.yearOfPromotion,
      f.expirationOfEngagementDate,
      f.StateofOrigin,
      f.LocalGovt,
      f.TaxCode,
      f.entry_mode,
      f.gradelevel,
      f.gradetype,
      f.taxed,
      f.accomm_type,
      f.AcommodationStatus,
      f.AddressofAcommodation,
      f.GBC,
      f.GBC_Number,
      f.NSITFcode,
      f.NHFcode,
      f.qualification,
      f.division,
      f.entitlement,
      f.advanceDate,
      f.runoutDate,
      f.NIN,
      f.AccountName || `${f.Surname} ${f.OtherName}`,
      serviceNo,
    ],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// SAVE — ef_nok
// ─────────────────────────────────────────────────────────────

async function saveNok(serviceNo, primary, alternate) {
  pool.useDatabase(DB());
  const upsertNok = (order, data) =>
    pool.query(
      `INSERT INTO ef_nok
       (service_no, nok_order, full_name, relationship, phone1, phone2,
        email, address, national_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       full_name    = VALUES(full_name),
       relationship = VALUES(relationship),
       phone1       = VALUES(phone1),
       phone2       = VALUES(phone2),
       email        = VALUES(email),
       address      = VALUES(address),
       national_id  = VALUES(national_id)`,
      [
        serviceNo,
        order,
        data.full_name ?? null,
        data.relationship ?? null,
        data.phone1 ?? null,
        data.phone2 ?? null,
        data.email ?? null,
        data.address ?? null,
        data.national_id ?? null,
      ],
    );

  if (primary) await upsertNok(1, primary);
  if (alternate) await upsertNok(2, alternate);
}

// ─────────────────────────────────────────────────────────────
// SAVE — ef_spouse
// ─────────────────────────────────────────────────────────────

async function saveSpouse(serviceNo, spouse) {
  if (!spouse) return;
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_spouse (service_no, full_name, phone1, phone2, email)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       full_name = VALUES(full_name),
       phone1    = VALUES(phone1),
       phone2    = VALUES(phone2),
       email     = VALUES(email)`,
    [
      serviceNo,
      spouse.full_name ?? null,
      spouse.phone1 ?? null,
      spouse.phone2 ?? null,
      spouse.email ?? null,
    ],
  );
}

// ─────────────────────────────────────────────────────────────
// SAVE — ef_children (delete + re-insert for clean ordering)
// ─────────────────────────────────────────────────────────────

async function saveChildren(serviceNo, children) {
  if (!Array.isArray(children)) return;
  pool.useDatabase(DB());
  await pool.query(`DELETE FROM ef_children WHERE service_no = ?`, [serviceNo]);
  const valid = children.slice(0, 4).filter((c) => c?.child_name?.trim());
  for (const [i, child] of valid.entries()) {
    await pool.query(
      `INSERT INTO ef_children (service_no, child_name, birth_order) VALUES (?, ?, ?)`,
      [serviceNo, child.child_name.trim(), child.birth_order ?? i + 1],
    );
  }
}

// ─────────────────────────────────────────────────────────────
// SAVE — ef_loans
// ─────────────────────────────────────────────────────────────

async function saveLoans(serviceNo, loans, validLoanTypes) {
  if (!loans || typeof loans !== "object") return;
  pool.useDatabase(DB());
  for (const [loanType, data] of Object.entries(loans)) {
    if (!validLoanTypes.includes(loanType)) continue;
    await pool.query(
      `INSERT INTO ef_loans
         (service_no, loan_type, amount, year_taken, tenor, balance, specify)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         amount     = VALUES(amount),
         year_taken = VALUES(year_taken),
         tenor      = VALUES(tenor),
         balance    = VALUES(balance),
         specify    = VALUES(specify)`,
      [
        serviceNo,
        loanType,
        data.amount ?? null,
        data.year_taken ?? null,
        data.tenor ?? null,
        data.balance ?? null,
        data.specify ?? null,
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────
// SAVE — ef_allowances
// ─────────────────────────────────────────────────────────────

async function saveAllowances(serviceNo, allowances, validAllowTypes) {
  if (!allowances || typeof allowances !== "object") return;
  pool.useDatabase(DB());
  for (const [allowType, data] of Object.entries(allowances)) {
    if (!validAllowTypes.includes(allowType)) continue;
    await pool.query(
      `INSERT INTO ef_allowances (service_no, allow_type, is_active, specify)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         is_active = VALUES(is_active),
         specify   = VALUES(specify)`,
      [serviceNo, allowType, data.is_active ? 1 : 0, data.specify ?? null],
    );
  }
}

// ─────────────────────────────────────────────────────────────
// SUBMIT — atomic multi-table write (transaction version)
//
// Accepts a smartConnection from pool.smartTransaction so all
// writes participate in a single transaction. If any write fails
// the entire transaction rolls back — no partial state.
//
// Steps inside transaction:
//   1. savePersonCore     → ef_personalinfos (all form fields)
//   2. saveNok            → ef_nok (primary + alternate)
//   3. saveSpouse         → ef_spouse
//   4. saveChildren       → ef_children (delete + re-insert)
//   5. saveLoans          → ef_loans
//   6. saveAllowances     → ef_allowances
//   7. markSubmitted      → ef_personalinfos.Status = 'Filled'
//
// Steps OUTSIDE transaction (called by service after commit):
//   - upsertEmolumentForm → ef_emolument_forms (safe to retry)
//   - incrementFormNumber → ef_systeminfos counter
//   - insertFormApproval  → ef_form_approvals
//   - insertAuditLog      → ef_audit_logs
// ─────────────────────────────────────────────────────────────

async function submitAllTables(
  conn,
  serviceNo,
  body,
  formNumber,
  formYear,
  legacyStatus,
  validLoanTypes,
  validAllowTypes,
) {
  const f = body.core || {};
  const primary = body.nok?.primary;
  const alternate = body.nok?.alternate;
  const spouse = body.spouse;
  const children = Array.isArray(body.children) ? body.children : [];
  const loans = body.loans || {};
  const allows = body.allowances || {};

  // 1. Save core personal info
  await conn.query(
    `UPDATE ef_personalinfos SET
       Surname                    = ?,
       OtherName                  = ?,
       Sex                        = ?,
       MaritalStatus              = ?,
       Birthdate                  = ?,
       religion                   = ?,
       gsm_number                 = ?,
       gsm_number2                = ?,
       email                      = ?,
       home_address               = ?,
       BankACNumber               = ?,
       Bankcode                   = ?,
       bankbranch                 = ?,
       pfacode                    = ?,
       specialisation             = ?,
       command                    = ?,
       branch                     = ?,
       DateEmpl                   = ?,
       seniorityDate              = ?,
       yearOfPromotion            = ?,
       expirationOfEngagementDate = ?,
       StateofOrigin              = ?,
       LocalGovt                  = ?,
       TaxCode                    = ?,
       entry_mode                 = ?,
       gradelevel                 = ?,
       gradetype                  = ?,
       taxed                      = ?,
       accomm_type                = ?,
       AcommodationStatus         = ?,
       AddressofAcommodation      = ?,
       GBC                        = ?,
       GBC_Number                 = ?,
       NSITFcode                  = ?,
       NHFcode                    = ?,
       qualification              = ?,
       division                   = ?,
       entitlement                = ?,
       advanceDate                = ?,
       runoutDate                 = ?,
       NIN                        = ?,
       AccountName                = ?,
       dateModify                 = NOW()
     WHERE serviceNumber = ?`,
    [
      f.Surname,
      f.OtherName,
      f.Sex,
      f.MaritalStatus,
      f.Birthdate,
      f.religion,
      f.gsm_number,
      f.gsm_number2,
      f.email,
      f.home_address,
      f.BankACNumber,
      f.Bankcode,
      f.bankbranch,
      f.pfacode,
      f.specialisation,
      f.command,
      f.branch,
      f.DateEmpl,
      f.seniorityDate,
      f.yearOfPromotion,
      f.expirationOfEngagementDate,
      f.StateofOrigin,
      f.LocalGovt,
      f.TaxCode,
      f.entry_mode,
      f.gradelevel,
      f.gradetype,
      f.taxed,
      f.accomm_type,
      f.AcommodationStatus,
      f.AddressofAcommodation,
      f.GBC,
      f.GBC_Number,
      f.NSITFcode,
      f.NHFcode,
      f.qualification,
      f.division,
      f.entitlement,
      f.advanceDate,
      f.runoutDate,
      f.NIN,
      f.AccountName || `${f.Surname} ${f.OtherName}`,
      serviceNo,
    ],
  );

  // 2. Save NOK
  const upsertNok = async (order, data) => {
    if (!data) return;
    await conn.query(
      `INSERT INTO ef_nok
         (service_no, nok_order, full_name, relationship, phone1, phone2,
          email, address, national_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         full_name    = VALUES(full_name),
         relationship = VALUES(relationship),
         phone1       = VALUES(phone1),
         phone2       = VALUES(phone2),
         email        = VALUES(email),
         address      = VALUES(address),
         national_id  = VALUES(national_id)`,
      [
        serviceNo,
        order,
        data.full_name ?? null,
        data.relationship ?? null,
        data.phone1 ?? null,
        data.phone2 ?? null,
        data.email ?? null,
        data.address ?? null,
        data.national_id ?? null,
      ],
    );
  };
  await upsertNok(1, primary);
  await upsertNok(2, alternate);

  // 3. Save spouse
  if (spouse) {
    await conn.query(
      `INSERT INTO ef_spouse (service_no, full_name, phone1, phone2, email)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         full_name = VALUES(full_name),
         phone1    = VALUES(phone1),
         phone2    = VALUES(phone2),
         email     = VALUES(email)`,
      [
        serviceNo,
        spouse.full_name ?? null,
        spouse.phone1 ?? null,
        spouse.phone2 ?? null,
        spouse.email ?? null,
      ],
    );
  }

  // 4. Save children — delete + re-insert for clean ordering
  await conn.query(`DELETE FROM ef_children WHERE service_no = ?`, [serviceNo]);
  const validChildren = children
    .slice(0, 4)
    .filter((c) => c?.child_name?.trim());
  for (const [i, child] of validChildren.entries()) {
    await conn.query(
      `INSERT INTO ef_children (service_no, child_name, birth_order) VALUES (?, ?, ?)`,
      [serviceNo, child.child_name.trim(), child.birth_order ?? i + 1],
    );
  }

  // 5. Save loans
  for (const [loanType, data] of Object.entries(loans)) {
    if (!validLoanTypes.includes(loanType)) continue;
    await conn.query(
      `INSERT INTO ef_loans
         (service_no, loan_type, amount, year_taken, tenor, balance, specify)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         amount     = VALUES(amount),
         year_taken = VALUES(year_taken),
         tenor      = VALUES(tenor),
         balance    = VALUES(balance),
         specify    = VALUES(specify)`,
      [
        serviceNo,
        loanType,
        data.amount ?? null,
        data.year_taken ?? null,
        data.tenor ?? null,
        data.balance ?? null,
        data.specify ?? null,
      ],
    );
  }

  // 6. Save allowances
  for (const [allowType, data] of Object.entries(allows)) {
    if (!validAllowTypes.includes(allowType)) continue;
    await conn.query(
      `INSERT INTO ef_allowances (service_no, allow_type, is_active, specify)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         is_active = VALUES(is_active),
         specify   = VALUES(specify)`,
      [serviceNo, allowType, data.is_active ? 1 : 0, data.specify ?? null],
    );
  }

  // 7. Mark as submitted — gate ensures this only fires once
  const [result] = await conn.query(
    `UPDATE ef_personalinfos
     SET Status      = ?,
         formNumber  = ?,
         FormYear    = ?,
         datecreated = NOW(),
         dateModify  = NOW()
     WHERE serviceNumber = ?
       AND (Status IS NULL OR Status = '')
       AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
    [legacyStatus, formNumber, formYear, serviceNo],
  );

  // Return affectedRows so service can detect if already submitted
  return result.affectedRows;
}

// ─────────────────────────────────────────────────────────────
// INIT DRAFT — create ef_emolument_forms row on first load
// Idempotent — ON DUPLICATE KEY does nothing if row exists.
// Gives the form a stable ID from the moment it is first opened,
// so DO/FO/CPO routes can always reference a form_id.
// ─────────────────────────────────────────────────────────────

async function initDraftForm(serviceNo, formYear, payrollClass, ship, command) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `INSERT INTO ef_emolument_forms
       (service_no, form_year, payroll_class, ship, command, status)
     VALUES (?, ?, ?, ?, ?, 'DRAFT')
     ON DUPLICATE KEY UPDATE
       updated_at = updated_at`, // no-op touch — preserves existing status
    [serviceNo, formYear, payrollClass, ship ?? null, command ?? null],
  );
  // Return inserted id or existing id
  if (result.insertId) return result.insertId;

  const [rows] = await pool.query(
    `SELECT id FROM ef_emolument_forms
     WHERE service_no = ? AND form_year = ? LIMIT 1`,
    [serviceNo, formYear],
  );
  return rows[0]?.id || null;
}

// ─────────────────────────────────────────────────────────────
// SUBMIT — set Status='Filled' + formNumber + formYear
// Uses legacy status string to match old SP behaviour.
// ─────────────────────────────────────────────────────────────

async function submitForm(serviceNo, formNumber, formYear, legacyStatus) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_personalinfos
     SET Status      = ?,
         formNumber  = ?,
         FormYear    = ?,
         datecreated = NOW(),
         dateModify  = NOW()
     WHERE serviceNumber = ?
       AND (Status IS NULL OR Status = '')
       AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
    [legacyStatus, formNumber, formYear, serviceNo],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// ef_emolument_forms — upsert form record (clean enum status)
// ─────────────────────────────────────────────────────────────

async function upsertEmolumentForm(
  serviceNo,
  formYear,
  formNumber,
  payrollClass,
  ship,
  command,
  formStatus,
  snapshot = null,
) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `INSERT INTO ef_emolument_forms
       (service_no, form_year, form_number, payroll_class, ship, command, status, snapshot, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       form_number  = VALUES(form_number),
       status       = VALUES(status),
       snapshot     = COALESCE(VALUES(snapshot), snapshot),
       submitted_at = IF(status = 'DRAFT', NOW(), submitted_at),
       updated_at   = NOW()`,
    [
      serviceNo,
      formYear,
      formNumber,
      payrollClass,
      ship ?? null,
      command ?? null,
      formStatus,
      snapshot ? JSON.stringify(snapshot) : null,
    ],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// FORM NUMBER
// ─────────────────────────────────────────────────────────────

async function getCurrentFormNumber(formNoColumn) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT \`${formNoColumn}\` AS formNo FROM ef_systeminfos LIMIT 1`,
  );
  return rows[0]?.formNo ?? 1;
}

async function incrementFormNumber(formNoColumn) {
  pool.useDatabase(DB());
  await pool.query(
    `UPDATE ef_systeminfos SET \`${formNoColumn}\` = \`${formNoColumn}\` + 1`,
  );
}

// ─────────────────────────────────────────────────────────────
// AUDIT / APPROVAL LOGS
// ─────────────────────────────────────────────────────────────

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

async function getEmolumentFormId(serviceNo, formYear) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id FROM ef_emolument_forms
     WHERE service_no = ? AND form_year = ? LIMIT 1`,
    [serviceNo, formYear],
  );
  return rows[0]?.id || null;
}

// ─────────────────────────────────────────────────────────────
// FORM OPTIONS
// ─────────────────────────────────────────────────────────────

// Gets Banks, Ships, Specializations and all other select options in the frontend
async function getFormOptions() {
  const connection = await pool.getConnection();
  
  try {
    await connection.query(`USE ??`, [DB()]);

    // Fetch all options in parallel for better performance
    const [
      banksResult,
      commandsResult,
      branchesResult,
      shipsResult,
      specializationsResult,
      statesResult,
      lgasResult,
      relationshipsResult,
      entryModesResult,
      rankResult
    ] = await Promise.all([
      // Banks
      connection.query('SELECT bankcode AS id, bankname AS name FROM ef_banks'),
      
      // Commands
      connection.query('SELECT code as id, commandName AS name FROM ef_commands'),
      
      // Branches
      connection.query('SELECT code AS id, branchName AS name FROM ef_branches'),
      
      // Ships (with command association)
      connection.query('SELECT Id AS id, shipName AS name, commandid FROM ef_ships'),
      
      // Specializations
      connection.query('SELECT Id AS id, specname AS name FROM ef_specialisationareas'),
      
      // States
      connection.query('SELECT StateId AS id, Name AS name FROM ef_states'),
      
      // Local Governments (with state association)
      connection.query('SELECT Id AS id, lgaName AS name, stateId FROM ef_localgovts'),
      
      // Relationships (for NOK)
      connection.query('SELECT Id AS id, description AS name FROM ef_relationships'),
      
      // Entry Modes (Type of Commissioning)
      connection.query('SELECT Id AS id, Name AS name FROM ef_entrymodes'),

      // Ranks
      connection.query('SELECT Id AS id, rankName AS name FROM ef_ranks')
    ]);

    return {
      banks: banksResult[0],
      commands: commandsResult[0],
      branches: branchesResult[0],
      ships: shipsResult[0],
      specializations: specializationsResult[0],
      states: statesResult[0],
      lgas: lgasResult[0],
      relationships: relationshipsResult[0],
      entryModes: entryModesResult[0],
      ranks: rankResult[0]
    };

  } catch (error) {
    console.error('Error fetching form options:', error);
    throw error;
  } finally {
    connection.release();
  }
}



module.exports = {
  getSystemInfo,
  getProcessingYear,
  getShipOpenStatus,
  getFromHrEmployees,
  initPersonnelFromHr,
  getPersonCore,
  loadPersonCore,
  loadNok,
  loadSpouse,
  loadChildren,
  loadLoans,
  loadAllowances,
  loadDocuments,
  loadHistoricalForm,
  savePersonCore,
  saveNok,
  saveSpouse,
  saveChildren,
  saveLoans,
  saveAllowances,
  submitForm,
  submitAllTables,
  initDraftForm,
  upsertEmolumentForm,
  getCurrentFormNumber,
  incrementFormNumber,
  insertAuditLog,
  insertFormApproval,
  getEmolumentFormId,
  getFormOptions
};