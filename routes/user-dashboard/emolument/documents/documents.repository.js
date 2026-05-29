/**
 * FILE: router/user-dashboard/emolument/documents/documents.repository.js
 *
 * All SQL for document/photo management.
 *
 * ef_documents stores Cloudinary URLs per personnel per doc_type:
 *   PASSPORT          → personnel's own passport photo
 *   NOK_PASSPORT      → primary next-of-kin passport photo
 *   ALT_NOK_PASSPORT  → alternate next-of-kin passport photo
 *
 * Cloudinary is the storage layer — we store the URL and public_id only.
 * Delete/replace operations go through Cloudinary first, then update DB.
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// GET — all documents for a service number
// ─────────────────────────────────────────────────────────────

async function getDocuments(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT doc_type, url, cloudinary_id, uploaded_at, uploaded_by
     FROM ef_documents
     WHERE service_no = ?
     ORDER BY doc_type ASC`,
    [serviceNo],
  );
  return rows;
}

async function getDocument(serviceNo, docType) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT doc_type, url, cloudinary_id, uploaded_at, uploaded_by
     FROM ef_documents
     WHERE service_no = ? AND doc_type = ?
     LIMIT 1`,
    [serviceNo, docType],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// UPSERT — save or replace a document record
// ─────────────────────────────────────────────────────────────

async function upsertDocument(
  serviceNo,
  docType,
  url,
  cloudinaryId,
  uploadedBy,
) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `INSERT INTO ef_documents
       (service_no, doc_type, url, cloudinary_id, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       url           = VALUES(url),
       cloudinary_id = VALUES(cloudinary_id),
       uploaded_by   = VALUES(uploaded_by),
       uploaded_at   = NOW()`,
    [serviceNo, docType, url, cloudinaryId, uploadedBy],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// DELETE — remove document record from DB
// Called after Cloudinary deletion is confirmed.
// ─────────────────────────────────────────────────────────────

async function deleteDocument(serviceNo, docType) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `DELETE FROM ef_documents
     WHERE service_no = ? AND doc_type = ?`,
    [serviceNo, docType],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// GET CLOUDINARY ID — needed before deletion on Cloudinary
// ─────────────────────────────────────────────────────────────

async function getCloudinaryId(serviceNo, docType) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT cloudinary_id FROM ef_documents
     WHERE service_no = ? AND doc_type = ?
     LIMIT 1`,
    [serviceNo, docType],
  );
  return rows[0]?.cloudinary_id || null;
}

// ─────────────────────────────────────────────────────────────
// BATCH — get documents for multiple service numbers
// Used by admin/reporting views
// ─────────────────────────────────────────────────────────────

async function getDocumentsByShip(ship) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT d.service_no, d.doc_type, d.url, d.cloudinary_id, d.uploaded_at,
            p.Surname, p.OtherName, p.Rank
     FROM ef_documents d
     JOIN ef_personalinfos p ON p.serviceNumber = d.service_no
     WHERE p.ship = ?
     ORDER BY p.Surname ASC, d.doc_type ASC`,
    [ship],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// MISSING DOCUMENTS — find personnel missing specific doc types
// ─────────────────────────────────────────────────────────────

async function getMissingDocuments(ship, docType) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT p.serviceNumber, p.Surname, p.OtherName, p.Rank, p.payrollclass
     FROM ef_personalinfos p
     WHERE p.ship = ?
       AND p.serviceNumber NOT IN (
         SELECT d.service_no FROM ef_documents d
         WHERE d.doc_type = ?
       )
     ORDER BY p.Surname ASC`,
    [ship, docType],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// AUDIT
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

module.exports = {
  getDocuments,
  getDocument,
  upsertDocument,
  deleteDocument,
  getCloudinaryId,
  getDocumentsByShip,
  getMissingDocuments,
  insertAuditLog,
};