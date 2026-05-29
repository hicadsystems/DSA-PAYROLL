// ─────────────────────────────────────────────────────────────
// tickets.repo.js
// All raw DB queries for ef_tickets.
// ─────────────────────────────────────────────────────────────

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

async function createTicket({
  user_id,
  full_name,
  ship,
  email,
  phone,
  subject,
  body,
}) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `INSERT INTO ef_tickets
       (user_id, full_name, ship, email, phone, subject, body, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    [user_id, full_name, ship || "", email || "", phone || "", subject, body],
  );
  return result.insertId;
}

// All tickets — admin view, newest first
async function getAllTickets({ status, search, page = 1, pageSize = 30 } = {}) {
  pool.useDatabase(DB());

  const conditions = [];
  const params = [];

  if (status && status !== "all") {
    conditions.push("t.status = ?");
    params.push(status);
  }

  if (search) {
    conditions.push(
      "(t.full_name LIKE ? OR t.user_id LIKE ? OR t.ship LIKE ?)",
    );
    const like = "%" + search + "%";
    params.push(like, like, like);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const offset = (page - 1) * pageSize;

  const [[{ total }], [rows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total FROM ef_tickets t ${where}`, params),
    pool.query(
      `SELECT
         t.id, t.user_id, t.full_name, t.ship, t.email, t.phone,
         t.subject, t.body, t.status,
         t.response, t.responded_by, t.responded_at,
         t.created_at
       FROM ef_tickets t
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    ),
  ]);

  return {
    rows,
    pagination: {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

// Tickets for a single user — user self-service view
async function getUserTickets(user_id) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       id, subject, body, status,
       response, responded_by, responded_at, created_at
     FROM ef_tickets
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 50`,
    [user_id],
  );
  return rows;
}

// Fetch a single ticket by id — used by service before mutating,
// so audit old_values can be captured accurately.
async function getTicketById(id) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id, user_id, full_name, ship, subject, status,
            response, responded_by, responded_at, created_at
     FROM ef_tickets
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

// Admin responds to a ticket
async function respondToTicket({ id, response, responded_by }) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_tickets
     SET response     = ?,
         responded_by = ?,
         responded_at = NOW(),
         status       = 'responded'
     WHERE id = ?`,
    [response, responded_by, id],
  );
  return result.affectedRows;
}

// Admin closes a ticket
async function closeTicket(id) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_tickets SET status = 'closed' WHERE id = ?`,
    [id],
  );
  return result.affectedRows;
}

// Summary counts — for dashboard badge
async function getTicketCounts() {
  pool.useDatabase(DB());
  const [[row]] = await pool.query(
    `SELECT
       COUNT(*)                                                AS total,
       SUM(CASE WHEN status = 'open'      THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) AS responded,
       SUM(CASE WHEN status = 'closed'    THEN 1 ELSE 0 END) AS closed
     FROM ef_tickets`,
  );
  return row;
}

// Fetch the fields we need from ef_personalinfos for ticket submission.
// Returns null if the service number isn't found.
async function getPersonProfile(user_id) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT Surname, OtherName, ship, email, gsm_number
     FROM ef_personalinfos
     WHERE serviceNumber = ?
     LIMIT 1`,
    [user_id],
  );
  return rows[0] || null;
}

// Audit log — identical shape to every other module in this codebase
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
  createTicket,
  getAllTickets,
  getUserTickets,
  getTicketById,
  respondToTicket,
  closeTicket,
  getTicketCounts,
  getPersonProfile,
  insertAuditLog,
};
