// ============================================================================
// Monthly Allowance Upload (DSA)
// ----------------------------------------------------------------------------
// Takes the monthly DSA workbook ("Payroll Tables & Data Template Expected
// From DSA") and loads it straight into py_payded as a one-month payment:
//
//   * payind = 'T', nomth = 1, amtp = the monthly figure on the sheet (no x12)
//   * every sheet maps to a payment type per payroll class
//     (py_allowance_sheetmap). A sheet that has never been seen before gets
//     the next free PT3XX code and a py_elementtype row named after the sheet.
//   * each row is matched to Personnel by service number, or — when that is
//     missing/wrong ("CIV", "AWO", typos, split -A/-B numbers) — by account
//     number + name. Staff who are genuinely not in hr_employees are created.
//   * for the payment types on this month's file, entries for staff who are
//     NOT on the sheet are removed (optional, on by default) so nobody keeps
//     being paid from an old month.
//   * py_payhistory (previous month) is read only to show what changed.
//
// Everything is done in one transaction across the class databases, and every
// row that is replaced/removed is backed up so the latest upload can be undone.
// ============================================================================

const XLSX = require("xlsx");
const crypto = require("crypto");
const pool = require("../../config/db");

const PAY_INDICATOR = "T";
const TENOR = 1;
const CHUNK = 400;
const PREVIEW_TTL_MS = 60 * 60 * 1000; // previews live for 1 hour
const PROCESSING_STAGE = 666; // same threshold that hides Data Input

// Known sheets -> payment type, per payroll class (1 = MILITARY, 2 = CIVILIAN).
// Seeded into py_allowance_sheetmap the first time the menu is used.
// NRA is skipped: Non Regular Allowance is not loaded through py_payded.
const DEFAULT_SHEET_MAP = [
  ["NRA", "1", null, 1],
  ["NRA", "2", null, 1],
  ["Running Cost", "1", "PT312", 0],
  ["Running Cost", "2", "PT312", 0],
  ["Responsibility Allce", "1", "PT317", 0],
  ["RCA Orogun Armed Guards", "1", "PT319", 0],
  ["RCA Orogun Armed Guards", "2", "PT319", 0],
  ["Former CDSA", "1", "PT320", 0],
  ["MEOO", "1", "PT314", 0],
  ["MEOO", "2", "PT314", 0],
  ["RESEARCH & ADMIN", "2", "PT302", 0],
  ["CONTRACT", "2", "PT322", 0],
  ["NYSC ALLOWANCE", "2", "PT321", 0],
  ["Corpers & IT", "2", "PT302", 0],
  ["DSS OROGUN SAL", "2", "PT323", 0],
  ["DSS Annex Salaries", "2", "PT324", 0],
];

const DEFAULT_OPTIONS = {
  removeStale: true,
  includeConflicts: false,
  includeMismatches: false,
};

const previews = new Map();
let schemaReady = false;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const q = (id) => "`" + String(id).replace(/`/g, "``") + "`";
const T = (db, table) => `${q(db)}.${q(table)}`;

const chunk = (arr, size = CHUNK) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const sheetKey = (name) =>
  String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();

const normHeader = (h) =>
  h === null || h === undefined
    ? ""
    : String(h)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function cleanStr(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return String(v);
  const s = String(v).replace(/\s+/g, " ").trim();
  if (!s || s.startsWith("=")) return null;
  return s;
}

function toAmount(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? round2(v) : null;
  const n = Number(String(v).replace(/[,\s₦]/g, ""));
  return Number.isFinite(n) ? round2(n) : null;
}

const pad = (n, len = 2) => String(n).padStart(len, "0");

function serialToYMD(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function fullYear(y) {
  const n = Number(y);
  if (String(y).length > 2) return n;
  const pivot = new Date().getFullYear() % 100;
  return n > pivot ? 1900 + n : 2000 + n;
}

// Dates on the DSA sheets come as Excel dates or text such as "4 Dec 72",
// "02 Feb 80", "24 Jul 2000", "15/06/1985", "2026-01-01". Returns YYYYMMDD.
function toYMD(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v > 0 && v < 100000 ? serialToYMD(v) : null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})[\s\-\/.]+([A-Za-z]{3,9})[\s\-\/.,]+(\d{2,4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return `${fullYear(m[3])}${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}${pad(m[1])}`;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${fullYear(m[3])}${pad(m[2])}${pad(m[1])}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}${pad(m[2])}${pad(m[3])}`;
  return null;
}

function bankCode(v) {
  const s = cleanStr(v);
  if (!s) return null;
  return /^\d+$/.test(s) ? s.padStart(3, "0") : s;
}

function accountNo(v) {
  const s = cleanStr(v);
  if (!s) return null;
  return /^\d+$/.test(s) && s.length < 10 ? s.padStart(10, "0") : s;
}

const cut = (v, len) =>
  v === null || v === undefined ? null : String(v).slice(0, len);

function formatLocal(d) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function serializeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? formatLocal(v) : v;
  }
  return JSON.stringify(out);
}

function mode(values) {
  const counts = new Map();
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// name matching (used to catch one service number used for two people)
// ---------------------------------------------------------------------------
const nameTokens = (s) =>
  String(s || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokensMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    if (a.slice(0, 4) === b.slice(0, 4)) return true;
    if (editDistanceAtMostOne(a, b)) return true;
  }
  return false;
}

// Split a name into words (3+ letters) and initials (letters of 1–2 letter
// tokens): "Yandaki AM" -> words [yandaki], initials [a, m].
function nameUnits(s) {
  const toks = nameTokens(s);
  return {
    words: toks.filter((t) => t.length >= 3),
    initials: toks
      .filter((t) => t.length <= 2)
      .join("")
      .split(""),
  };
}

// Every word in A is a word or an initial in B, and every initial in A is the
// first letter of something in B.
function coveredBy(A, B) {
  const firsts = [...B.words.map((w) => w[0]), ...B.initials];
  return (
    A.words.every(
      (w) =>
        B.words.some((o) => tokensMatch(w, o)) || B.initials.includes(w[0]),
    ) && A.initials.every((i) => firsts.includes(i))
  );
}

// Two names are treated as the same person when:
//  * they share any real word (3+ letters, small spelling differences allowed)
//    e.g. "Umar M" / "UMAR MOHAMMED"; or
//  * one is the other abbreviated or reordered, every part accounted for
//    e.g. "Yandaki AM" / "Aminu Y Mustapha", "Gideon K" / "Kelvin G".
// A name with no real word in it ("HT") never proves a mismatch.
function namesMatch(a, b) {
  const A = nameUnits(a);
  const B = nameUnits(b);
  if (A.words.length === 0 || B.words.length === 0) return true;
  if (A.words.some((x) => B.words.some((y) => tokensMatch(x, y)))) return true;
  const size = (u) => u.words.length + u.initials.length;
  return size(A) >= 2 && size(B) >= 2 && coveredBy(A, B) && coveredBy(B, A);
}

// ---------------------------------------------------------------------------
// schema (created on first use; see config/sql/migrations too)
// ---------------------------------------------------------------------------
async function ensureSchema(conn, masterDb) {
  if (schemaReady) return;

  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${T(masterDb, "py_allowance_sheetmap")} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sheet_key VARCHAR(100) NOT NULL,
      sheet_name VARCHAR(100) NOT NULL,
      payrollclass VARCHAR(5) NOT NULL,
      paytype VARCHAR(6) NULL,
      skip_sheet TINYINT(1) NOT NULL DEFAULT 0,
      createdby VARCHAR(100) NULL,
      datecreated DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_allowance_sheet_class (sheet_key, payrollclass)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${T(masterDb, "py_allowance_upload")} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      batch_name VARCHAR(50) NOT NULL,
      file_name VARCHAR(255) NULL,
      period_label VARCHAR(30) NULL,
      uploaded_by VARCHAR(100) NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(12) NOT NULL DEFAULT 'committed',
      summary_json LONGTEXT NULL,
      undone_by VARCHAR(100) NULL,
      undone_at DATETIME NULL,
      UNIQUE KEY uq_allowance_batch (batch_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${T(masterDb, "py_allowance_upload_bak")} (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      batch_name VARCHAR(50) NOT NULL,
      db_name VARCHAR(64) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      row_key VARCHAR(100) NULL,
      row_json LONGTEXT NOT NULL,
      KEY idx_allowance_bak_batch (batch_name, kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const [[{ n }]] = await conn.query(
    `SELECT COUNT(*) AS n FROM ${T(masterDb, "py_allowance_sheetmap")}`,
  );
  if (Number(n) === 0) {
    const values = DEFAULT_SHEET_MAP.map(([name, cls, code, skip]) => [
      sheetKey(name),
      name,
      cls,
      code,
      skip,
      // "Added by" is the person who first uploads a file with this sheet;
      // it is filled in by commit()
      null,
    ]);
    await conn.query(
      `INSERT IGNORE INTO ${T(masterDb, "py_allowance_sheetmap")}
         (sheet_key, sheet_name, payrollclass, paytype, skip_sheet, createdby)
       VALUES ?`,
      [values],
    );
  }

  schemaReady = true;
}

// ---------------------------------------------------------------------------
// workbook parsing
// ---------------------------------------------------------------------------
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheets = [];

  for (const name of wb.SheetNames) {
    if (/instruction/i.test(name)) continue;

    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });

    const sheet = { name, key: sheetKey(name), rows: [], issues: [] };
    sheets.push(sheet);

    let h = -1;
    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      if ((grid[i] || []).some((c) => normHeader(c) === "svcno")) {
        h = i;
        break;
      }
    }
    if (h < 0) {
      sheet.error = 'No "Svc. No." header row found in the first 15 rows';
      continue;
    }

    const headers = (grid[h] || []).map(normHeader);
    const col = (...names) => {
      for (const n of names) {
        const i = headers.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const idx = {
      svc: col("svcno"),
      rank: col("rank"),
      surname: col("surname"),
      other: col("othername", "othernames"),
      dob: col("dateofbirth"),
      sex: col("sex"),
      bankCode: col("bankcode"),
      acct: col("accountnumber", "accountno"),
      joined: col("datejoined"),
      seniority: col("senioritydate"),
      grade: col("salarygrade"),
      step: col("step"),
      group: col("salarygroup"),
      emol: col("emolform", "emolumentform"),
      appt: col("appointment"),
      // MEOO carries its components plus a Total; every other sheet has Amount
      amount: col("total", "amount", "amountpayable"),
    };
    if (idx.amount < 0) {
      sheet.error = 'No "Amount" (or "Total") column found';
      continue;
    }

    const get = (row, i) => (i >= 0 ? row[i] : null);
    const noSvcRows = [];
    let noSvcAmount = 0;
    let runningTotal = 0;

    for (let r = h + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      if (
        !row.some(
          (c) => c !== null && c !== undefined && String(c).trim() !== "",
        )
      )
        continue;

      const excelRow = r + 1;
      const svc = cleanStr(get(row, idx.svc));
      const amount = toAmount(get(row, idx.amount));
      const surname = cleanStr(get(row, idx.surname));
      const other = cleanStr(get(row, idx.other));
      const displayName = [surname, other].filter(Boolean).join(" ");
      const account = accountNo(get(row, idx.acct));

      if (!svc && !displayName && !account) {
        // a sheet total such as MEOO's =SUM(N5:N8): ignore quietly
        if (
          amount &&
          runningTotal > 0 &&
          Math.abs(amount - runningTotal) < 0.01
        )
          continue;
        if (amount) {
          noSvcRows.push(excelRow);
          noSvcAmount += amount;
        }
        continue;
      }
      if (amount === null || amount <= 0) {
        sheet.issues.push({
          sheet: name,
          row: excelRow,
          svc,
          name: displayName,
          type: "no_amount",
          message: "No amount on this row",
        });
        continue;
      }

      runningTotal = round2(runningTotal + amount);
      sheet.rows.push({
        sheet: name,
        sheetKey: sheet.key,
        row: excelRow,
        svc,
        // a usable service number has digits ("CIV", "AWO" are not)
        svcValid: !!svc && /\d/.test(svc) && svc.length <= 20,
        rank: cleanStr(get(row, idx.rank)),
        surname,
        other,
        name: displayName,
        dob: toYMD(get(row, idx.dob)),
        sex: cleanStr(get(row, idx.sex)),
        bankCode: bankCode(get(row, idx.bankCode)),
        account,
        joined: toYMD(get(row, idx.joined)),
        seniority: toYMD(get(row, idx.seniority)),
        grade: cleanStr(get(row, idx.grade)),
        step: cleanStr(get(row, idx.step)),
        group: cleanStr(get(row, idx.group)),
        emol: cleanStr(get(row, idx.emol)),
        appointment: cleanStr(get(row, idx.appt)),
        amount,
      });
    }

    if (noSvcRows.length) {
      sheet.issues.push({
        sheet: name,
        row: noSvcRows[0],
        svc: null,
        name: null,
        type: "no_svc",
        message: `${noSvcRows.length} row(s) have an amount but no service number (rows ${noSvcRows[0]}–${noSvcRows[noSvcRows.length - 1]}, total ${round2(noSvcAmount).toLocaleString()})`,
      });
    }
  }

  return sheets;
}

// ---------------------------------------------------------------------------
// reference data
// ---------------------------------------------------------------------------
async function loadClasses(conn, masterDb) {
  const [rows] = await conn.query(
    `SELECT classcode, MAX(classname) AS classname, MAX(db_name) AS db_name
       FROM ${T(masterDb, "py_payrollclass")}
      WHERE (status = 'active' OR status IS NULL) AND db_name IS NOT NULL AND db_name <> ''
      GROUP BY classcode
      ORDER BY classcode`,
  );
  const available = new Set(pool.getAvailableDatabases());
  const classes = {};
  for (const r of rows) {
    if (available.size && !available.has(r.db_name)) continue;
    classes[String(r.classcode)] = {
      code: String(r.classcode),
      name: r.classname,
      db: r.db_name,
    };
  }
  return classes;
}

async function loadSheetMap(conn, masterDb) {
  const [rows] = await conn.query(
    `SELECT sheet_key, sheet_name, payrollclass, paytype, skip_sheet
       FROM ${T(masterDb, "py_allowance_sheetmap")}`,
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.sheet_key))
      map.set(r.sheet_key, { skip: false, byClass: {} });
    const entry = map.get(r.sheet_key);
    if (Number(r.skip_sheet) === 1) entry.skip = true;
    if (r.paytype) entry.byClass[String(r.payrollclass)] = r.paytype;
  }
  return map;
}

async function loadPeriod(conn, db) {
  const [rows] = await conn.query(
    `SELECT ord, sun, mth, pmth FROM ${T(db, "py_stdrate")} WHERE type = 'BT05' LIMIT 1`,
  );
  const now = new Date();
  const r = rows[0] || {};
  const year = Number(r.ord) || now.getFullYear();
  const month = Number(r.mth) || now.getMonth() + 1;
  const prevMonth = Number(r.pmth) || (month === 1 ? 12 : month - 1);
  const prevYear = prevMonth >= month ? year - 1 : year;
  return { year, month, prevYear, prevMonth, stage: Number(r.sun) || 0 };
}

// service numbers are compared without case or spaces
const normId = (v) => (v ? String(v).replace(/\s+/g, "").toUpperCase() : null);

// account numbers are compared on digits only, padded to NUBAN length
function normAcct(v) {
  if (v === null || v === undefined) return null;
  const d = String(v).replace(/\D/g, "");
  if (d.length < 6) return null;
  return d.length < 10 ? d.padStart(10, "0") : d;
}

const hrName = (e) => [e.Surname, e.OtherName].filter(Boolean).join(" ");

// All personnel, indexed by service number and by account number.
async function loadEmployees(conn, masterDb) {
  const [rows] = await conn.query(
    `SELECT Empl_ID, Surname, OtherName, Title, Factory, Jobtitle, gradelevel,
            gradetype, payrollclass, Status, DateLeft, exittype, Bankcode, BankACNumber
       FROM ${T(masterDb, "hr_employees")}`,
  );
  const byId = new Map();
  const byAcct = new Map();
  for (const r of rows) {
    byId.set(normId(r.Empl_ID), r);
    const a = normAcct(r.BankACNumber);
    if (a) {
      if (!byAcct.has(a)) byAcct.set(a, []);
      byAcct.get(a).push(r);
    }
  }
  return { byId, byAcct };
}

// Work out who a sheet row is really for.
//  1. service number on the sheet, when the name or the account agrees with it
//  2. otherwise the account number, when exactly one person on it has that name
//     (this catches "CIV"/"AWO" in the Svc. No. column, typos such as
//      DSA/CVI/0175, and numbers Personnel has split into -A / -B)
//  3. otherwise: the service number record with a name mismatch (held back),
//     a new person (valid service number not in Personnel), or unresolved.
function resolvePerson(r, staff) {
  const acct = normAcct(r.account);
  const byId = r.svc ? staff.byId.get(normId(r.svc)) : null;
  // when the Svc. No. column is junk the columns are often shifted, so let the
  // rank column take part in the name check as well
  const rowName = r.svcValid
    ? r.name
    : [r.rank, r.name].filter(Boolean).join(" ");

  if (byId) {
    const nameOk = namesMatch(rowName, hrName(byId));
    const acctOk = !!acct && normAcct(byId.BankACNumber) === acct;
    if (nameOk || acctOk) {
      return { emp: byId, how: "svc", accountDiffers: !!acct && !acctOk };
    }
  }

  const onAcct = acct ? staff.byAcct.get(acct) || [] : [];
  const named = onAcct.filter((e) => namesMatch(rowName, hrName(e)));
  if (named.length === 1) return { emp: named[0], how: "account" };
  if (named.length > 1) {
    // same person registered twice on one account (e.g. DSA/0007 and DSA/TT/RTD/0001)
    const sameClass = r.svc
      ? named.find((e) => normId(e.Empl_ID) === normId(r.svc))
      : null;
    if (sameClass) return { emp: sameClass, how: "svc" };
    return { ambiguous: named };
  }

  if (byId) return { emp: byId, how: "svc", mismatch: true };
  return { emp: null, accountOwners: onAcct };
}

// ---------------------------------------------------------------------------
// ANALYSE: everything that needs the database, done once per upload
// ---------------------------------------------------------------------------
async function analyse(buffer, fileName) {
  const masterDb = pool.getMasterDb();
  const conn = await pool.getConnection();
  try {
    await ensureSchema(conn, masterDb);

    const classes = await loadClasses(conn, masterDb);
    if (Object.keys(classes).length === 0) {
      throw new Error("No active payroll classes found in py_payrollclass");
    }
    const sheetMap = await loadSheetMap(conn, masterDb);
    const sheets = parseWorkbook(buffer);
    if (sheets.length === 0) throw new Error("The workbook has no sheets");

    const issues = [];
    const sheetSummaries = [];

    // service numbers on sheets we are going to load
    const loadSheets = [];
    for (const s of sheets) {
      const entry = sheetMap.get(s.key);
      if (s.error) {
        sheetSummaries.push({ name: s.name, status: "error", reason: s.error });
        continue;
      }
      if (entry && entry.skip) {
        sheetSummaries.push({
          name: s.name,
          status: "skipped",
          reason: "Marked as not loaded through this menu",
          rows: s.rows.length,
        });
        continue;
      }
      loadSheets.push(s);
      issues.push(...s.issues);
    }

    const staff = await loadEmployees(conn, masterDb);

    // identify every row against Personnel before anything else
    for (const s of loadSheets) {
      for (const r of s.rows) {
        const who = resolvePerson(r, staff);
        r.emp = who.emp || null;
        r.how = who.how || null;
        r.mismatch = !!who.mismatch;
        r.accountDiffers = !!who.accountDiffers;
        r.ambiguous = who.ambiguous || null;
        r.accountOwners = who.accountOwners || [];
        // key that groups rows for the same person
        r.personKey = r.emp
          ? normId(r.emp.Empl_ID)
          : r.svcValid
            ? normId(r.svc)
            : null;
      }
    }

    // element tables and periods per class
    const elements = {};
    const periods = {};
    let maxPt3 = 0;
    for (const cls of Object.values(classes)) {
      const [rows] = await conn.query(
        `SELECT PaymentType, elmDesc FROM ${T(cls.db, "py_elementtype")}`,
      );
      elements[cls.code] = new Map(
        rows.map((r) => [String(r.PaymentType).toUpperCase(), r.elmDesc]),
      );
      for (const r of rows) {
        const m = String(r.PaymentType)
          .toUpperCase()
          .match(/^PT3(\d{2})$/);
        if (m) maxPt3 = Math.max(maxPt3, 300 + Number(m[1]));
      }
      periods[cls.code] = await loadPeriod(conn, cls.db);
    }

    const classByName = (group) => {
      if (!group) return null;
      const g = group.toUpperCase();
      const list = Object.values(classes);
      const exact = list.find((c) => String(c.name || "").toUpperCase() === g);
      if (exact) return exact.code;
      const pre = list.find(
        (c) =>
          g.length >= 3 &&
          String(c.name || "")
            .toUpperCase()
            .startsWith(g.slice(0, 3)),
      );
      return pre ? pre.code : null;
    };

    // ---- resolve class + payment type for every row ----
    const resolved = [];
    const pendingElements = new Map(); // `${key}|${cls}` -> {sheet, cls}

    for (const s of loadSheets) {
      const entry = sheetMap.get(s.key) || { skip: false, byClass: {} };
      const known = s.rows
        .filter((r) => r.emp && !r.mismatch)
        .map((r) => String(r.emp.payrollclass || ""));
      const sheetClass =
        mode(known.filter((c) => classes[c])) ||
        (Object.keys(entry.byClass).length === 1
          ? Object.keys(entry.byClass)[0]
          : null);

      const summary = {
        name: s.name,
        status: "loaded",
        rows: 0,
        amount: 0,
        byClass: {},
      };
      sheetSummaries.push(summary);

      for (const r of s.rows) {
        if (r.ambiguous) {
          issues.push({
            sheet: s.name,
            row: r.row,
            svc: r.svc,
            name: r.name,
            type: "ambiguous",
            message: `Service number not usable and account ${r.account} belongs to more than one person: ${r.ambiguous
              .map((e) => `${e.Empl_ID} ${hrName(e)}`)
              .join("; ")}`,
          });
          continue;
        }
        if (!r.emp && !r.svcValid) {
          issues.push({
            sheet: s.name,
            row: r.row,
            svc: r.svc,
            name: r.name,
            type: "invalid_svc",
            message: r.svc
              ? `"${r.svc}" is not a valid service number and the account number does not match anyone in Personnel`
              : "No service number and the account number does not match anyone in Personnel",
          });
          continue;
        }
        const emp = r.emp;
        let cls =
          emp && classes[String(emp.payrollclass)]
            ? String(emp.payrollclass)
            : null;
        if (!cls) cls = classByName(r.group);
        if (!cls && /^RTD$/i.test(r.group || "")) cls = sheetClass;
        if (!cls) cls = sheetClass;
        if (!cls || !classes[cls]) {
          issues.push({
            sheet: s.name,
            row: r.row,
            svc: r.svc,
            name: r.name,
            type: "no_class",
            message:
              "Cannot tell whether this person is Military or Civilian (not in personnel records and no Salary Group)",
          });
          continue;
        }

        const code = entry.byClass[cls] || null;
        if (!code) pendingElements.set(`${s.key}|${cls}`, { sheet: s, cls });

        resolved.push({ ...r, cls, code });
        summary.rows++;
        summary.amount = round2(summary.amount + r.amount);
        if (!summary.byClass[cls])
          summary.byClass[cls] = {
            cls,
            code,
            rows: 0,
            amount: 0,
            isNew: !code,
          };
        summary.byClass[cls].rows++;
        summary.byClass[cls].amount = round2(
          summary.byClass[cls].amount + r.amount,
        );
      }
    }

    // ---- allocate payment types for new sheet/class pairs ----
    const newElements = [];
    let next = maxPt3 + 1;
    const allocatedForSheet = new Map();
    for (const { sheet, cls } of pendingElements.values()) {
      const entry = sheetMap.get(sheet.key) || { byClass: {} };
      const desc = sheet.name
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase()
        .slice(0, 35);
      const sameSheetCode =
        allocatedForSheet.get(sheet.key) ||
        Object.values(entry.byClass)[0] ||
        null;

      let code = null;
      let create = true;
      if (sameSheetCode) {
        const existingDesc = elements[cls].get(sameSheetCode);
        if (existingDesc === undefined) {
          code = sameSheetCode; // same code as the other class, create it here
        } else if (sheetKey(existingDesc) === sheetKey(desc)) {
          code = sameSheetCode; // already exists here with the same name
          create = false;
        }
      }
      if (!code) {
        while (
          next <= 399 &&
          Object.values(elements).some((m) => m.has(`PT${next}`))
        )
          next++;
        if (next > 399)
          throw new Error(
            "No free PT3XX payment type codes left (PT300–PT399 are all used)",
          );
        code = `PT${next}`;
        next++;
      }
      allocatedForSheet.set(sheet.key, code);
      if (create) elements[cls].set(code, desc);
      newElements.push({
        code,
        cls,
        className: classes[cls].name,
        db: classes[cls].db,
        desc,
        sheetKey: sheet.key,
        sheetName: sheet.name,
        create,
      });
    }
    const newElementCode = new Map(
      newElements.map((e) => [`${e.sheetKey}|${e.cls}`, e.code]),
    );
    for (const r of resolved) {
      if (!r.code) r.code = newElementCode.get(`${r.sheetKey}|${r.cls}`);
    }
    for (const s of sheetSummaries) {
      for (const bc of Object.values(s.byClass || {})) {
        if (!bc.code)
          bc.code = newElementCode.get(`${sheetKey(s.name)}|${bc.cls}`);
      }
    }

    // mapped codes must exist in that class's py_elementtype
    const missing = new Set();
    for (const r of resolved) {
      if (!elements[r.cls].has(String(r.code).toUpperCase()))
        missing.add(`${r.sheet}|${r.cls}|${r.code}`);
    }
    for (const m of missing) {
      const [sheet, cls, code] = m.split("|");
      issues.push({
        sheet,
        row: null,
        svc: null,
        name: null,
        type: "missing_element",
        message: `${sheet} is mapped to ${code} for ${classes[cls].name}, but ${code} is not in that class's payment types. Rows not loaded.`,
      });
    }
    const usable = resolved.filter(
      (r) => !missing.has(`${r.sheet}|${r.cls}|${r.code}`),
    );

    // ---- group rows by the person they resolved to ----
    const bySvc = new Map();
    for (const r of usable) {
      const k = r.personKey;
      if (!bySvc.has(k)) bySvc.set(k, []);
      bySvc.get(k).push(r);
    }

    // ---- one (new) service number, different people inside the file ----
    // Rows matched to Personnel were already checked by name/account, so this
    // only applies to people who are not in Personnel yet.
    const conflicts = new Map();
    for (const [k, rows] of bySvc) {
      if (rows[0].emp) continue;
      const named = rows.filter((r) => r.name);
      for (let i = 0; i < named.length && !conflicts.has(k); i++) {
        for (let j = i + 1; j < named.length; j++) {
          if (!namesMatch(named[i].name, named[j].name)) {
            const people = [
              ...new Map(
                named.map((r) => [
                  r.name.toLowerCase(),
                  `${r.name} (${r.sheet} row ${r.row})`,
                ]),
              ).values(),
            ];
            conflicts.set(k, `Used for different people: ${people.join("; ")}`);
            break;
          }
        }
      }
    }

    // ---- name differs from personnel record ----
    const mismatches = new Map();
    for (const [k, rows] of bySvc) {
      const bad = rows.find((r) => r.mismatch);
      if (bad) {
        mismatches.set(
          k,
          `Sheet says "${bad.name}"${bad.account ? `, account ${bad.account}` : ""} (${bad.sheet} row ${bad.row}); ` +
            `${bad.emp.Empl_ID} in Personnel is "${hrName(bad.emp)}", account ${bad.emp.BankACNumber || "—"}`,
        );
      }
    }

    // ---- staff not in hr_employees ----
    const newIds = [...bySvc.keys()].filter((k) => !bySvc.get(k)[0].emp);
    const newEmployees = [];
    if (newIds.length) {
      const [banks] = await conn.query(
        `SELECT bankcode, branchcode, bankname, cbn_code
           FROM ${T(masterDb, "py_bank")}
          WHERE cbn_code IS NOT NULL AND cbn_code <> ''
          ORDER BY (branchcode = '01') DESC, bankcode`,
      );
      const bankByCbn = new Map();
      for (const b of banks) {
        const k = String(b.cbn_code).trim().padStart(3, "0");
        if (!bankByCbn.has(k)) bankByCbn.set(k, b);
      }

      const [titleLevels] = await conn.query(
        `SELECT payrollclass, Title, gradelevel, COUNT(*) AS c
           FROM ${T(masterDb, "hr_employees")}
          WHERE Title IS NOT NULL AND gradelevel IS NOT NULL AND gradelevel <> ''
          GROUP BY payrollclass, Title, gradelevel`,
      );
      const levelByTitle = new Map();
      for (const r of titleLevels) {
        const k = `${r.payrollclass}|${String(r.Title).trim().toUpperCase()}`;
        const cur = levelByTitle.get(k);
        if (!cur || Number(r.c) > cur.c)
          levelByTitle.set(k, { v: r.gradelevel, c: Number(r.c) });
      }

      const [jobTypes] = await conn.query(
        `SELECT payrollclass, Jobtitle, gradetype, COUNT(*) AS c
           FROM ${T(masterDb, "hr_employees")}
          WHERE Jobtitle IS NOT NULL AND gradetype IS NOT NULL AND gradetype <> ''
          GROUP BY payrollclass, Jobtitle, gradetype`,
      );
      const typeByFamily = new Map();
      for (const r of jobTypes) {
        const fam = String(r.Jobtitle)
          .toUpperCase()
          .replace(/[^A-Z]/g, "");
        if (!fam) continue;
        const k = `${r.payrollclass}|${fam}`;
        const cur = typeByFamily.get(k);
        if (!cur || Number(r.c) > cur.c)
          typeByFamily.set(k, { v: r.gradetype, c: Number(r.c) });
      }

      const [factories] = await conn.query(
        `SELECT payrollclass, Factory, COUNT(*) AS c
           FROM ${T(masterDb, "hr_employees")}
          WHERE Factory IS NOT NULL AND Factory <> ''
          GROUP BY payrollclass, Factory`,
      );
      const factoryByClass = new Map();
      for (const r of factories) {
        const cur = factoryByClass.get(String(r.payrollclass));
        if (!cur || Number(r.c) > cur.c)
          factoryByClass.set(String(r.payrollclass), {
            v: r.Factory,
            c: Number(r.c),
          });
      }

      // people already on the same sheet + class: their Factory / gradetype
      const peers = new Map();
      for (const r of usable) {
        if (!r.emp || r.mismatch) continue;
        const k = `${r.sheetKey}|${r.cls}`;
        if (!peers.has(k)) peers.set(k, []);
        peers.get(k).push(r.emp);
      }

      const [hrCols] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.columns
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'hr_employees'`,
        [masterDb],
      );
      const hrColumns = new Set(hrCols.map((c) => c.COLUMN_NAME));

      for (const k of newIds) {
        const rows = bySvc.get(k);
        // the row with the most personal details wins
        const best = [...rows].sort((a, b) => {
          const score = (r) =>
            [
              r.surname,
              r.other,
              r.dob,
              r.sex,
              r.bankCode,
              r.account,
              r.joined,
              r.rank,
              r.grade,
            ].filter(Boolean).length;
          return score(b) - score(a);
        })[0];
        const cls = best.cls;
        const warnings = [];

        if (!best.surname) {
          issues.push({
            sheet: best.sheet,
            row: best.row,
            svc: best.svc,
            name: best.name,
            type: "new_no_name",
            message:
              "New staff member has no surname on the sheet, so cannot be created",
          });
          continue;
        }

        const bank = best.bankCode ? bankByCbn.get(best.bankCode) : null;
        if (best.bankCode && !bank)
          warnings.push(`Bank code ${best.bankCode} not found in Bank Details`);
        if (!best.account) warnings.push("No account number on the sheet");
        const owners = rows.flatMap((r) => r.accountOwners || []);
        if (owners.length) {
          warnings.push(
            `Account ${best.account} is already on ${[...new Set(owners.map((e) => `${e.Empl_ID} ${hrName(e)}`))].join("; ")}`,
          );
        }

        const peerList = peers.get(`${best.sheetKey}|${cls}`) || [];
        let gradelevel = null;
        const gradeNo = best.grade && best.grade.match(/(\d+)/);
        if (gradeNo && best.step && /^\d+$/.test(best.step)) {
          gradelevel = `${pad(gradeNo[1])}${pad(best.step)}`;
        } else if (best.rank) {
          gradelevel =
            (levelByTitle.get(`${cls}|${best.rank.toUpperCase()}`) || {}).v ||
            null;
        }
        if (!gradelevel) gradelevel = mode(peerList.map((p) => p.gradelevel));
        if (!gradelevel)
          warnings.push(
            "Grade level could not be worked out — set it in Personnel",
          );

        const family = best.grade
          ? best.grade.toUpperCase().replace(/[^A-Z]/g, "")
          : "";
        let gradetype =
          (family && (typeByFamily.get(`${cls}|${family}`) || {}).v) || null;
        if (!gradetype) gradetype = mode(peerList.map((p) => p.gradetype));
        if (!gradetype && /^MIL/i.test(best.group || ""))
          gradetype = "MILITARY";

        const factory =
          mode(peerList.map((p) => p.Factory)) ||
          (factoryByClass.get(cls) || {}).v ||
          null;
        const retired =
          /^rtd$/i.test(best.rank || "") || /^rtd$/i.test(best.group || "");
        const sex = best.sex ? best.sex.charAt(0).toUpperCase() : null;

        const record = {
          Empl_ID: cut(best.svc, 20),
          Surname: cut(best.surname, 20),
          OtherName: cut(best.other, 40),
          Title: cut(best.rank, 15),
          Sex: sex === "M" || sex === "F" ? sex : null,
          Jobtitle: cut(best.appointment || best.grade, 50),
          Factory: cut(factory, 10),
          Birthdate: best.dob,
          DateEmpl: best.joined,
          datepmted: best.seniority || best.joined,
          Bankcode: bank ? cut(bank.bankcode, 15) : null,
          bankbranch: bank ? cut(bank.branchcode, 30) : null,
          BankACNumber: cut(best.account, 20),
          Status: retired ? "R" : "V",
          gradelevel: cut(gradelevel, 10),
          gradetype: cut(gradetype, 10),
          payrollclass: cls,
          emolumentform: cut((best.emol || "yes").toLowerCase(), 3),
        };
        for (const key of Object.keys(record))
          if (!hrColumns.has(key)) delete record[key];

        newEmployees.push({
          key: k,
          emp: record.Empl_ID,
          name: best.name,
          cls,
          className: classes[cls].name,
          sheet: best.sheet,
          row: best.row,
          bank: bank ? `${bank.bankname || bank.bankcode}` : best.bankCode,
          account: best.account,
          gradelevel: record.gradelevel || null,
          warnings,
          record,
        });
      }
    }
    const creatable = new Set(newEmployees.map((e) => e.key));

    // ---- aggregate to one py_payded row per class/employee/type ----
    const items = new Map();
    for (const r of usable) {
      if (!r.emp && !creatable.has(r.personKey)) continue; // new person we cannot create
      const emp = r.emp ? String(r.emp.Empl_ID).trim() : r.svc;
      const empKey = emp.toUpperCase();
      // a row whose name and account disagree with Personnel stays separate so
      // it never holds back the real person's own row for the same type
      const key = `${r.cls}|${empKey}|${r.code}${r.mismatch ? "|MISMATCH" : ""}`;
      if (!items.has(key)) {
        items.set(key, {
          key,
          cls: r.cls,
          emp,
          empKey,
          personKey: r.personKey,
          name: r.emp ? hrName(r.emp) : r.name,
          code: r.code,
          amount: 0,
          sources: [],
          notes: [],
          isNew: !r.emp,
          exited: !!(r.emp && (r.emp.DateLeft || r.emp.exittype)),
          mismatch: false,
        });
      }
      const it = items.get(key);
      it.amount = round2(it.amount + r.amount);
      it.sources.push(`${r.sheet} row ${r.row}`);
      if (r.mismatch) it.mismatch = true;
      if (r.how === "account" && normId(r.svc) !== normId(emp)) {
        it.notes.push(
          `Found by account no. — sheet had "${r.svc || "blank"}" (${r.sheet} row ${r.row})`,
        );
      }
      if (r.accountDiffers) {
        it.notes.push(
          `Account on sheet (${r.account}) differs from Personnel (${r.emp.BankACNumber || "none"}) — paid to Personnel account`,
        );
      }
    }
    for (const it of items.values()) {
      if (conflicts.has(it.personKey)) {
        it.flag = "conflict";
        it.flagDetail = conflicts.get(it.personKey);
      } else if (it.mismatch) {
        it.flag = "mismatch";
        it.flagDetail = mismatches.get(it.personKey);
      }
    }

    // ---- what is in py_payded now, and what was paid last month ----
    const current = {};
    const history = {};
    for (const cls of Object.values(classes)) {
      const codes = [
        ...new Set(
          [...items.values()]
            .filter((i) => i.cls === cls.code)
            .map((i) => i.code),
        ),
      ];
      current[cls.code] = [];
      history[cls.code] = new Map();
      if (!codes.length) continue;

      const [rows] = await conn.query(
        `SELECT Empl_ID, type, amtp, payind, nomth, batchName
           FROM ${T(cls.db, "py_payded")}
          WHERE type IN (?)`,
        [codes],
      );
      current[cls.code] = rows.map((r) => ({
        emp: String(r.Empl_ID || "").trim(),
        type: String(r.type).toUpperCase(),
        amtp: Number(r.amtp) || 0,
        payind: r.payind,
        nomth: r.nomth,
        batchName: r.batchName,
      }));

      const p = periods[cls.code];
      const m = Math.min(12, Math.max(1, p.prevMonth));
      const [hist] = await conn.query(
        `SELECT his_empno, his_type, ${q(`amtthismth${m}`)} AS amt
           FROM ${T(cls.db, "py_payhistory")}
          WHERE his_year = ? AND his_type IN (?) AND ${q(`amtthismth${m}`)} <> 0`,
        [p.prevYear, codes],
      );
      for (const h of hist) {
        history[cls.code].set(
          `${String(h.his_empno).trim().toUpperCase()}|${String(h.his_type).toUpperCase()}`,
          Number(h.amt) || 0,
        );
      }
    }

    const fileTotal = round2(
      sheets
        .filter((s) => !sheetMap.get(s.key)?.skip)
        .reduce((sum, s) => sum + s.rows.reduce((a, r) => a + r.amount, 0), 0),
    );

    return {
      fileName,
      createdAt: Date.now(),
      classes,
      periods,
      sheets: sheetSummaries,
      issues,
      newElements,
      newEmployees,
      items: [...items.values()],
      current,
      history: Object.fromEntries(
        Object.entries(history).map(([k, v]) => [k, Object.fromEntries(v)]),
      ),
      fileTotal,
      knownSheets: [...sheetMap.entries()]
        .filter(([, v]) => !v.skip)
        .map(([k]) => k),
      fileSheetKeys: sheets.map((s) => s.key),
    };
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// FINALISE: apply the user's options to an analysis (no database access)
// ---------------------------------------------------------------------------
function finalise(analysis, rawOptions = {}) {
  const options = { ...DEFAULT_OPTIONS };
  for (const k of Object.keys(DEFAULT_OPTIONS)) {
    if (rawOptions[k] !== undefined)
      options[k] = rawOptions[k] === true || rawOptions[k] === "true";
  }

  const load = [];
  const excluded = [];
  for (const it of analysis.items) {
    const blocked =
      (it.flag === "conflict" && !options.includeConflicts) ||
      (it.flag === "mismatch" && !options.includeMismatches);
    (blocked ? excluded : load).push(it);
  }

  const loadKeys = new Set(load.map((i) => `${i.cls}|${i.empKey}|${i.code}`));
  const loadEmpKeys = new Set(load.map((i) => i.empKey));
  const employeesToCreate = analysis.newEmployees.filter((e) =>
    loadEmpKeys.has(e.key),
  );
  const usedCodes = new Set(load.map((i) => `${i.cls}|${i.code}`));
  const elementsToCreate = analysis.newElements.filter((e) =>
    usedCodes.has(`${e.cls}|${e.code}`),
  );

  const perClass = {};
  const blockers = [];
  const removals = [];
  let replaced = 0;
  const records = [];

  for (const cls of Object.values(analysis.classes)) {
    const clsItems = analysis.items.filter((i) => i.cls === cls.code);
    if (!clsItems.length) continue;
    const codes = new Set(clsItems.map((i) => i.code));
    const period = analysis.periods[cls.code];
    const hist = analysis.history[cls.code] || {};
    const loadedHere = load.filter((i) => i.cls === cls.code);

    if (period.stage >= PROCESSING_STAGE) {
      blockers.push(
        `${cls.name}: payroll for ${period.month}/${period.year} is being processed (stage ${period.stage}). Load before processing starts.`,
      );
    }

    let clsReplaced = 0;
    for (const row of analysis.current[cls.code] || []) {
      const k = `${cls.code}|${row.emp.toUpperCase()}|${row.type}`;
      if (loadKeys.has(k)) {
        clsReplaced++;
      } else if (options.removeStale && codes.has(row.type)) {
        removals.push({ cls: cls.code, className: cls.name, ...row });
      }
    }
    replaced += clsReplaced;

    const changes = { new: 0, changed: 0, same: 0, dropped: 0 };
    for (const it of loadedHere) {
      const prev = hist[`${it.empKey}|${it.code}`];
      let change = "new";
      if (prev !== undefined)
        change = Math.abs(prev - it.amount) < 0.005 ? "same" : "changed";
      changes[change]++;
      records.push({
        cls: cls.code,
        className: cls.name,
        emp: it.emp,
        name: it.name,
        code: it.code,
        amount: it.amount,
        prev: prev === undefined ? null : prev,
        change,
        newEmployee: it.isNew,
        exited: it.exited,
        flag: it.flag || null,
        sources: it.sources,
        notes: it.notes,
      });
    }
    const loadedEmpCodes = new Set(
      loadedHere.map((i) => `${i.empKey}|${i.code}`),
    );
    for (const k of Object.keys(hist)) {
      const code = k.split("|").pop();
      if (codes.has(code) && !loadedEmpCodes.has(k)) changes.dropped++;
    }

    perClass[cls.code] = {
      code: cls.code,
      name: cls.name,
      db: cls.db,
      period,
      codes: [...codes].sort(),
      rows: loadedHere.length,
      amount: round2(loadedHere.reduce((a, i) => a + i.amount, 0)),
      replaced: clsReplaced,
      removed: removals.filter((r) => r.cls === cls.code).length,
      changes,
    };
  }

  const missingSheets = analysis.knownSheets.filter(
    (k) => !analysis.fileSheetKeys.includes(k),
  );

  return {
    options,
    fileName: analysis.fileName,
    classes: Object.values(perClass),
    sheets: analysis.sheets,
    missingSheets,
    newElements: elementsToCreate.map(
      ({ code, cls, className, desc, sheetName, create }) => ({
        code,
        cls,
        className,
        desc,
        sheetName,
        create,
      }),
    ),
    newEmployees: employeesToCreate.map(
      ({
        emp,
        name,
        cls,
        className,
        sheet,
        row,
        bank,
        account,
        gradelevel,
        warnings,
      }) => ({
        emp,
        name,
        cls,
        className,
        sheet,
        row,
        bank,
        account,
        gradelevel,
        warnings,
      }),
    ),
    records,
    removals,
    excluded: excluded.map((i) => ({
      cls: i.cls,
      className: analysis.classes[i.cls].name,
      emp: i.emp,
      name: i.name,
      code: i.code,
      amount: i.amount,
      reason:
        i.flag === "conflict"
          ? "New service number used for more than one person"
          : "Name and account both differ from Personnel",
      detail: i.flagDetail,
    })),
    issues: analysis.issues,
    totals: {
      rows: load.length,
      amount: round2(load.reduce((a, i) => a + i.amount, 0)),
      replaced,
      removed: removals.length,
      excluded: excluded.length,
      newEmployees: employeesToCreate.length,
      newElements: elementsToCreate.filter((e) => e.create).length,
      fileTotal: analysis.fileTotal,
      matchedByAccount: load.filter((i) =>
        i.notes.some((n) => n.startsWith("Found by account")),
      ).length,
    },
    blockers,
    canCommit: blockers.length === 0 && load.length > 0,
    _load: load,
    _employees: employeesToCreate,
    _elements: elementsToCreate,
  };
}

const publicPlan = (plan) => {
  const { _load, _employees, _elements, ...rest } = plan;
  return rest;
};

// ---------------------------------------------------------------------------
// preview cache
// ---------------------------------------------------------------------------
function sweepPreviews() {
  const now = Date.now();
  for (const [id, p] of previews)
    if (now - p.analysis.createdAt > PREVIEW_TTL_MS) previews.delete(id);
}

async function createPreview(buffer, fileName, userId, options) {
  sweepPreviews();
  const analysis = await analyse(buffer, fileName);
  const id = crypto.randomUUID();
  previews.set(id, { analysis, userId: String(userId) });
  return { previewId: id, plan: publicPlan(finalise(analysis, options)) };
}

function getPreview(id, userId) {
  sweepPreviews();
  const p = previews.get(id);
  if (!p)
    throw Object.assign(
      new Error("This preview has expired. Please upload the file again."),
      { status: 410 },
    );
  if (p.userId !== String(userId))
    throw Object.assign(new Error("Preview belongs to another user"), {
      status: 403,
    });
  return p;
}

function replan(id, userId, options) {
  const p = getPreview(id, userId);
  return publicPlan(finalise(p.analysis, options));
}

// ---------------------------------------------------------------------------
// COMMIT
// ---------------------------------------------------------------------------
function makeBatchName(periods) {
  const p = Object.values(periods)[0] || {};
  const stamp = Date.now().toString(36).toUpperCase();
  return `MAU-${p.year || new Date().getFullYear()}${pad(p.month || new Date().getMonth() + 1)}-${stamp}`;
}

async function backupRows(conn, masterDb, batchName, db, kind, rows, keyFn) {
  for (const part of chunk(rows, 200)) {
    await conn.query(
      `INSERT INTO ${T(masterDb, "py_allowance_upload_bak")} (batch_name, db_name, kind, row_key, row_json) VALUES ?`,
      [
        part.map((r) => [
          batchName,
          db,
          kind,
          keyFn ? cut(keyFn(r), 100) : null,
          serializeRow(r),
        ]),
      ],
    );
  }
}

async function commit(previewId, userId, userName, options) {
  const { analysis } = getPreview(previewId, userId);
  const plan = finalise(analysis, options);
  if (plan.blockers.length)
    throw Object.assign(new Error(plan.blockers.join(" ")), { status: 409 });
  if (!plan._load.length)
    throw Object.assign(new Error("Nothing to load"), { status: 400 });

  const masterDb = pool.getMasterDb();
  const createdBy = cut(userName || "SYSTEM", 20);
  const batchName = makeBatchName(analysis.periods);
  const result = {
    batchName,
    elementsCreated: [],
    employeesCreated: 0,
    employeesSkipped: [],
    perClass: {},
  };

  const conn = await pool.getConnection();
  try {
    await ensureSchema(conn, masterDb);

    // fresh stage check: payroll may have started since the preview
    for (const c of plan.classes) {
      const p = await loadPeriod(conn, c.db);
      if (p.stage >= PROCESSING_STAGE) {
        throw Object.assign(
          new Error(
            `${c.name}: payroll processing has started (stage ${p.stage}). Nothing was loaded.`,
          ),
          { status: 409 },
        );
      }
    }

    await conn.beginTransaction();

    // 1. new payment types + sheet map
    for (const e of plan._elements) {
      if (e.create) {
        const [exists] = await conn.query(
          `SELECT PaymentType, elmDesc FROM ${T(e.db, "py_elementtype")} WHERE PaymentType = ? FOR UPDATE`,
          [e.code],
        );
        if (exists.length) {
          if (sheetKey(exists[0].elmDesc) !== sheetKey(e.desc)) {
            throw Object.assign(
              new Error(
                `${e.code} was created by someone else since this preview. Upload the file again.`,
              ),
              { status: 409 },
            );
          }
        } else {
          const element = {
            PaymentType: e.code,
            elmDesc: e.desc,
            Ledger: null,
            perc: "I",
            std: null,
            maxi: null,
            bpay: "No",
            yearend: "No",
            Status: "Active",
            dependence: null,
            payfreq: "M",
            pmonth: null,
            freetax: 0,
            createdby: createdBy,
            datecreated: formatLocal(new Date()),
            ipis: null,
          };
          await conn.query(`INSERT INTO ${T(e.db, "py_elementtype")} SET ?`, [
            element,
          ]);
          await backupRows(
            conn,
            masterDb,
            batchName,
            e.db,
            "element_new",
            [element],
            (r) => r.PaymentType,
          );
          result.elementsCreated.push({
            code: e.code,
            desc: e.desc,
            className: e.className,
          });
        }
      }
      const [mapRows] = await conn.query(
        `SELECT id FROM ${T(masterDb, "py_allowance_sheetmap")} WHERE sheet_key = ? AND payrollclass = ?`,
        [e.sheetKey, e.cls],
      );
      if (!mapRows.length) {
        await conn.query(
          `INSERT INTO ${T(masterDb, "py_allowance_sheetmap")} (sheet_key, sheet_name, payrollclass, paytype, skip_sheet, createdby)
           VALUES (?, ?, ?, ?, 0, ?)`,
          [
            e.sheetKey,
            e.sheetName,
            e.cls,
            e.code,
            cut(userName || "SYSTEM", 100),
          ],
        );
        await backupRows(
          conn,
          masterDb,
          batchName,
          masterDb,
          "sheetmap_new",
          [{ sheet_key: e.sheetKey, payrollclass: e.cls }],
          (r) => `${r.sheet_key}|${r.payrollclass}`,
        );
      }
    }

    // 2. new staff -> hr_employees
    for (const e of plan._employees) {
      const [exists] = await conn.query(
        `SELECT Empl_ID FROM ${T(masterDb, "hr_employees")} WHERE Empl_ID = ?`,
        [e.record.Empl_ID],
      );
      if (exists.length) {
        result.employeesSkipped.push(e.record.Empl_ID);
        continue;
      }
      const record = { ...e.record, createdby: createdBy };
      await conn.query(`INSERT INTO ${T(masterDb, "hr_employees")} SET ?`, [
        record,
      ]);
      await backupRows(
        conn,
        masterDb,
        batchName,
        masterDb,
        "employee_new",
        [{ Empl_ID: record.Empl_ID }],
        (r) => r.Empl_ID,
      );
      result.employeesCreated++;
    }

    // 3. py_payded per class: back up, clear, insert
    for (const c of plan.classes) {
      const loadRows = plan._load.filter((i) => i.cls === c.code);
      const codes = c.codes;
      if (!codes.length) continue;

      const [existing] = await conn.query(
        `SELECT * FROM ${T(c.db, "py_payded")} WHERE type IN (?) FOR UPDATE`,
        [codes],
      );
      const loadKeys = new Set(loadRows.map((i) => `${i.empKey}|${i.code}`));
      const keyOf = (r) =>
        `${String(r.Empl_ID || "")
          .trim()
          .toUpperCase()}|${String(r.type).toUpperCase()}`;
      const toDelete = plan.options.removeStale
        ? existing
        : existing.filter((r) => loadKeys.has(keyOf(r)));

      await backupRows(
        conn,
        masterDb,
        batchName,
        c.db,
        "payded_old",
        toDelete,
        keyOf,
      );

      if (plan.options.removeStale) {
        await conn.query(
          `DELETE FROM ${T(c.db, "py_payded")} WHERE type IN (?)`,
          [codes],
        );
      } else {
        for (const part of chunk(toDelete)) {
          await conn.query(
            `DELETE FROM ${T(c.db, "py_payded")} WHERE (Empl_ID, type) IN (?)`,
            [part.map((r) => [r.Empl_ID, r.type])],
          );
        }
      }

      // one py_payded row per person + type (a held-back row the user chose to
      // load can share a person/type with a normal row)
      const merged = new Map();
      for (const i of loadRows) {
        const k = `${i.empKey}|${i.code}`;
        if (merged.has(k))
          merged.get(k).amount = round2(merged.get(k).amount + i.amount);
        else merged.set(k, { emp: i.emp, code: i.code, amount: i.amount });
      }

      const now = formatLocal(new Date());
      for (const part of chunk([...merged.values()])) {
        await conn.query(
          `INSERT INTO ${T(c.db, "py_payded")}
             (Empl_ID, type, mak1, amtp, mak2, amt, amttd, payind, nomth, createdby, datecreated, batchName)
           VALUES ?`,
          [
            part.map((i) => [
              i.emp,
              i.code,
              "",
              i.amount,
              "",
              0,
              0,
              PAY_INDICATOR,
              TENOR,
              createdBy,
              now,
              batchName,
            ]),
          ],
        );
      }

      result.perClass[c.code] = {
        name: c.name,
        inserted: merged.size,
        amount: c.amount,
        removed:
          toDelete.length -
          existing.filter((r) => loadKeys.has(keyOf(r))).length,
        replaced: existing.filter((r) => loadKeys.has(keyOf(r))).length,
      };
    }

    // 4. sheet mapping "Added by": the uploader of the first file that had the
    //    sheet (covers the default mappings, which start with no owner)
    if (userName) {
      const uploader = cut(userName, 100);
      const loadedPairs = [];
      const skippedKeys = [];
      for (const s of analysis.sheets) {
        if (s.status === "loaded") {
          for (const b of Object.values(s.byClass || {}))
            loadedPairs.push([sheetKey(s.name), b.cls]);
        } else if (s.status === "skipped") {
          skippedKeys.push(sheetKey(s.name));
        }
      }
      const unowned = `(createdby IS NULL OR createdby = '' OR createdby = 'SYSTEM')`;
      if (loadedPairs.length) {
        await conn.query(
          `UPDATE ${T(masterDb, "py_allowance_sheetmap")} SET createdby = ?
            WHERE ${unowned} AND (sheet_key, payrollclass) IN (?)`,
          [uploader, loadedPairs],
        );
      }
      if (skippedKeys.length) {
        await conn.query(
          `UPDATE ${T(masterDb, "py_allowance_sheetmap")} SET createdby = ?
            WHERE ${unowned} AND sheet_key IN (?)`,
          [uploader, skippedKeys],
        );
      }
    }

    // 5. upload log
    const first = plan.classes[0] || {};
    const summary = {
      fileName: plan.fileName,
      options: plan.options,
      totals: plan.totals,
      classes: plan.classes.map(
        ({ code, name, db, codes, rows, amount, period }) => ({
          code,
          name,
          db,
          codes,
          rows,
          amount,
          period,
        }),
      ),
      result,
    };
    await conn.query(
      `INSERT INTO ${T(masterDb, "py_allowance_upload")} (batch_name, file_name, period_label, uploaded_by, status, summary_json)
       VALUES (?, ?, ?, ?, 'committed', ?)`,
      [
        batchName,
        cut(plan.fileName, 255),
        first.period ? `${pad(first.period.month)}/${first.period.year}` : null,
        cut(userName, 100),
        JSON.stringify(summary),
      ],
    );

    await conn.commit();
    previews.delete(previewId);
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      /* not in a transaction */
    }
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// HISTORY + UNDO
// ---------------------------------------------------------------------------
async function history(limit = 20) {
  const masterDb = pool.getMasterDb();
  const conn = await pool.getConnection();
  try {
    await ensureSchema(conn, masterDb);
    const [rows] = await conn.query(
      `SELECT id, batch_name, file_name, period_label, uploaded_by, uploaded_at, status,
              undone_by, undone_at, summary_json
         FROM ${T(masterDb, "py_allowance_upload")}
        ORDER BY id DESC
        LIMIT ?`,
      [Number(limit) || 20],
    );
    const latestCommitted = rows.find((r) => r.status === "committed");
    return rows.map((r) => {
      let totals = null;
      try {
        totals = JSON.parse(r.summary_json || "{}").totals || null;
      } catch (_) {
        totals = null;
      }
      return {
        batchName: r.batch_name,
        fileName: r.file_name,
        period: r.period_label,
        uploadedBy: r.uploaded_by,
        uploadedAt: r.uploaded_at,
        status: r.status,
        undoneBy: r.undone_by,
        undoneAt: r.undone_at,
        totals,
        canUndo:
          !!latestCommitted && latestCommitted.batch_name === r.batch_name,
      };
    });
  } finally {
    conn.release();
  }
}

async function undo(batchName, userName) {
  const masterDb = pool.getMasterDb();
  const conn = await pool.getConnection();
  try {
    await ensureSchema(conn, masterDb);
    const [[latest]] = await conn.query(
      `SELECT batch_name, summary_json FROM ${T(masterDb, "py_allowance_upload")}
        WHERE status = 'committed' ORDER BY id DESC LIMIT 1`,
    );
    if (!latest || latest.batch_name !== batchName) {
      throw Object.assign(
        new Error("Only the most recent upload can be undone"),
        { status: 409 },
      );
    }
    const summary = JSON.parse(latest.summary_json || "{}");
    const classes = summary.classes || [];

    for (const c of classes) {
      const p = await loadPeriod(conn, c.db);
      if (p.stage >= PROCESSING_STAGE) {
        throw Object.assign(
          new Error(
            `${c.name}: payroll processing has started (stage ${p.stage}). Undo is not allowed now.`,
          ),
          { status: 409 },
        );
      }
    }

    await conn.beginTransaction();

    const [bak] = await conn.query(
      `SELECT db_name, kind, row_key, row_json FROM ${T(masterDb, "py_allowance_upload_bak")}
        WHERE batch_name = ? ORDER BY id`,
      [batchName],
    );

    let removed = 0;
    let restored = 0;
    for (const c of classes) {
      const [del] = await conn.query(
        `DELETE FROM ${T(c.db, "py_payded")} WHERE batchName = ?`,
        [batchName],
      );
      removed += del.affectedRows || 0;
    }
    for (const b of bak.filter((x) => x.kind === "payded_old")) {
      await conn.query(`INSERT INTO ${T(b.db_name, "py_payded")} SET ?`, [
        JSON.parse(b.row_json),
      ]);
      restored++;
    }

    // staff created by this upload: remove only if nothing else uses them now
    let employeesRemoved = 0;
    for (const b of bak.filter((x) => x.kind === "employee_new")) {
      const id = JSON.parse(b.row_json).Empl_ID;
      let used = false;
      for (const c of classes) {
        const [[{ n }]] = await conn.query(
          `SELECT COUNT(*) AS n FROM ${T(c.db, "py_payded")} WHERE Empl_ID = ?`,
          [id],
        );
        if (Number(n) > 0) used = true;
      }
      if (!used) {
        const [d] = await conn.query(
          `DELETE FROM ${T(masterDb, "hr_employees")} WHERE Empl_ID = ?`,
          [id],
        );
        employeesRemoved += d.affectedRows || 0;
      }
    }

    // payment types created by this upload: remove if unused
    const elementsRemoved = [];
    for (const b of bak.filter((x) => x.kind === "element_new")) {
      const code = JSON.parse(b.row_json).PaymentType;
      const [[{ n }]] = await conn.query(
        `SELECT COUNT(*) AS n FROM ${T(b.db_name, "py_payded")} WHERE type = ?`,
        [code],
      );
      const [[{ h }]] = await conn.query(
        `SELECT COUNT(*) AS h FROM ${T(b.db_name, "py_payhistory")} WHERE his_type = ?`,
        [code],
      );
      if (Number(n) === 0 && Number(h) === 0) {
        await conn.query(
          `DELETE FROM ${T(b.db_name, "py_elementtype")} WHERE PaymentType = ?`,
          [code],
        );
        elementsRemoved.push(code);
      }
    }
    for (const b of bak.filter((x) => x.kind === "sheetmap_new")) {
      const m = JSON.parse(b.row_json);
      const [[row]] = await conn.query(
        `SELECT paytype FROM ${T(masterDb, "py_allowance_sheetmap")} WHERE sheet_key = ? AND payrollclass = ?`,
        [m.sheet_key, m.payrollclass],
      );
      if (row && elementsRemoved.includes(row.paytype)) {
        await conn.query(
          `DELETE FROM ${T(masterDb, "py_allowance_sheetmap")} WHERE sheet_key = ? AND payrollclass = ?`,
          [m.sheet_key, m.payrollclass],
        );
      }
    }

    await conn.query(
      `UPDATE ${T(masterDb, "py_allowance_upload")} SET status = 'undone', undone_by = ?, undone_at = NOW() WHERE batch_name = ?`,
      [cut(userName, 100), batchName],
    );

    await conn.commit();
    return { batchName, removed, restored, employeesRemoved, elementsRemoved };
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      /* not in a transaction */
    }
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// sheet map maintenance
// ---------------------------------------------------------------------------
async function listSheetMap() {
  const masterDb = pool.getMasterDb();
  const conn = await pool.getConnection();
  try {
    await ensureSchema(conn, masterDb);
    const classes = await loadClasses(conn, masterDb);
    const [rows] = await conn.query(
      `SELECT id, sheet_key, sheet_name, payrollclass, paytype, skip_sheet, createdby, datecreated
         FROM ${T(masterDb, "py_allowance_sheetmap")}
        ORDER BY sheet_name, payrollclass`,
    );
    return rows.map((r) => ({
      id: r.id,
      sheetName: r.sheet_name,
      cls: r.payrollclass,
      className: classes[r.payrollclass]
        ? classes[r.payrollclass].name
        : r.payrollclass,
      paytype: r.paytype,
      skip: Number(r.skip_sheet) === 1,
      createdBy: r.createdby,
      createdAt: r.datecreated,
    }));
  } finally {
    conn.release();
  }
}

async function updateSheetMap(id, { paytype, skip }) {
  const masterDb = pool.getMasterDb();
  const conn = await pool.getConnection();
  try {
    await ensureSchema(conn, masterDb);
    const [[row]] = await conn.query(
      `SELECT * FROM ${T(masterDb, "py_allowance_sheetmap")} WHERE id = ?`,
      [id],
    );
    if (!row)
      throw Object.assign(new Error("Mapping not found"), { status: 404 });

    const code =
      paytype === undefined
        ? row.paytype
        : paytype
          ? String(paytype).trim().toUpperCase()
          : null;
    if (code) {
      const classes = await loadClasses(conn, masterDb);
      const cls = classes[row.payrollclass];
      if (!cls)
        throw Object.assign(new Error("Payroll class not active"), {
          status: 400,
        });
      const [found] = await conn.query(
        `SELECT PaymentType FROM ${T(cls.db, "py_elementtype")} WHERE PaymentType = ?`,
        [code],
      );
      if (!found.length)
        throw Object.assign(
          new Error(`${code} is not a payment type in ${cls.name}`),
          { status: 400 },
        );
    }
    const skipVal = skip === undefined ? row.skip_sheet : skip ? 1 : 0;
    await conn.query(
      `UPDATE ${T(masterDb, "py_allowance_sheetmap")} SET paytype = ?, skip_sheet = ? WHERE id = ?`,
      [code, skipVal, id],
    );
    // a sheet is skipped as a whole, so keep every class row in step
    if (skip !== undefined) {
      await conn.query(
        `UPDATE ${T(masterDb, "py_allowance_sheetmap")} SET skip_sheet = ? WHERE sheet_key = ?`,
        [skipVal, row.sheet_key],
      );
    }
    return { id, paytype: code, skip: !!skipVal };
  } finally {
    conn.release();
  }
}

module.exports = {
  createPreview,
  replan,
  commit,
  history,
  undo,
  listSheetMap,
  updateSheetMap,
  // exported for reuse / unit tests
  _internals: { parseWorkbook, namesMatch, toYMD, finalise, DEFAULT_SHEET_MAP },
};
