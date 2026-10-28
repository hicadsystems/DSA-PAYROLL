

const pool = require("../../../config/db");
const path = require("path");
const fs = require("fs");
const { UPLOADS_ROOT } = require("./email.utils");

// ══════════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════════
async function getUserStorage(userId, defaultQuota) {
  const [[user]] = await pool.query(
    `SELECT storage_used_bytes,
            COALESCE(storage_quota_bytes, ?) AS storage_quota_bytes
     FROM hr_employees WHERE Empl_ID = ?`,
    [defaultQuota, userId],
  );
  return user;
}

async function adjustStorageUsed(userId, deltaBytes) {
  return pool
    .query(
      `UPDATE hr_employees SET storage_used_bytes = GREATEST(0, storage_used_bytes + ?)
       WHERE Empl_ID = ?`,
      [deltaBytes, userId],
    )
    .catch(() => {});
}

async function getSenderEmail(userId) {
  const [[sender]] = await pool.query(
    "SELECT email FROM hr_employees WHERE Empl_ID = ? LIMIT 1",
    [userId],
  );
  return sender?.email || "";
}

async function getUserFullName(userId) {
  const [[user]] = await pool.query(
    "SELECT CONCAT(Title,'.',Surname, ' ', OtherName) AS full_name FROM hr_employees WHERE Empl_ID = ?",
    [userId],
  );
  return user ? user.full_name : "Recipient";
}

async function searchUsers(q, excludeUserId) {
  const [rows] = await pool.query(
    `SELECT Empl_ID AS user_id, CONCAT(Title,'.',Surname, ' ', OtherName) AS full_name, email FROM hr_employees
     WHERE (Title LIKE ? OR Empl_ID LIKE ? OR Surname LIKE ? OR OtherName LIKE ? OR email LIKE ?)
       AND Empl_ID != ?
     LIMIT 20`,
    [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, excludeUserId],
  );
  return rows;
}

// ══════════════════════════════════════════════════════════
// ATTACHMENTS
// ══════════════════════════════════════════════════════════
async function findAttachmentByHash(contentHash) {
  const [existing] = await pool.query(
    `SELECT id, stored_name FROM mail_attachments
     WHERE content_hash = ? AND mail_id IS NOT NULL AND is_duplicate = FALSE
     LIMIT 1`,
    [contentHash],
  );
  return existing;
}

async function insertDuplicateAttachment({
  tempToken,
  filename,
  storedName,
  mimeType,
  fileSize,
  uploadedBy,
  contentHash,
  originalAttachmentId,
}) {
  return pool.query(
    `INSERT INTO mail_attachments
       (mail_id, temp_token, filename, stored_name, mime_type, file_size,
        uploaded_by, content_hash, is_duplicate, original_attachment_id)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
    [
      tempToken,
      filename,
      storedName,
      mimeType,
      fileSize,
      uploadedBy,
      contentHash,
      originalAttachmentId,
    ],
  );
}

async function insertOriginalAttachment({
  tempToken,
  filename,
  relativePath,
  mimeType,
  fileSize,
  uploadedBy,
  contentHash,
}) {
  return pool.query(
    `INSERT INTO mail_attachments
       (mail_id, temp_token, filename, stored_name, mime_type, file_size,
        uploaded_by, content_hash, is_duplicate)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, FALSE)`,
    [tempToken, filename, relativePath, mimeType, fileSize, uploadedBy, contentHash],
  );
}

async function getAttachmentsByTokens(tokens, userId) {
  const [rows] = await pool.query(
    `SELECT id, stored_name, mime_type, file_size, filename, content_hash,
            is_duplicate, original_attachment_id, uploaded_by
     FROM mail_attachments
     WHERE temp_token IN (?) AND uploaded_by = ? AND mail_id IS NULL`,
    [tokens, userId],
  );
  return rows;
}

async function assignAttachmentsToMail(mailId, tokens, userId) {
  return pool.query(
    `UPDATE mail_attachments SET mail_id = ?
     WHERE temp_token IN (?) AND uploaded_by = ? AND mail_id IS NULL`,
    [mailId, tokens, userId],
  );
}

async function getAttachmentsForMail(mailId) {
  const [attachments] = await pool.query(
    "SELECT id, filename, stored_name, mime_type, file_size FROM mail_attachments WHERE mail_id = ?",
    [mailId],
  );
  return attachments;
}

async function getAttachmentById(id) {
  const [rows] = await pool.query(
    `SELECT a.*, m.from_user_id, m.to_user_id, m.batch_id
     FROM mail_attachments a
     JOIN user_mails m ON m.id = a.mail_id
     WHERE a.id = ?`,
    [id],
  );
  return rows[0];
}

async function getOriginalAttachmentStoredName(originalAttachmentId) {
  const [origRows] = await pool.query(
    "SELECT stored_name FROM mail_attachments WHERE id = ?",
    [originalAttachmentId],
  );
  return origRows.length > 0 ? origRows[0].stored_name : null;
}

async function isBatchRecipient(batchId, userId) {
  const [[batchRow]] = await pool.query(
    `SELECT id FROM user_mails WHERE batch_id = ? AND to_user_id = ? LIMIT 1`,
    [batchId, userId],
  );
  return !!batchRow;
}

async function recordAttachmentDownload(attachmentId, userId) {
  return pool.query(
    `INSERT IGNORE INTO mail_attachment_downloads (attachment_id, user_id)
     VALUES (?, ?)`,
    [attachmentId, userId],
  );
}

async function getMailBasicById(mailId) {
  const [[mail]] = await pool.query(
    "SELECT id, from_user_id, to_user_id, batch_id FROM user_mails WHERE id = ?",
    [mailId],
  );
  return mail;
}

async function getAttachmentStatusForBatch(batchId, userId) {
  const [rows] = await pool.query(
    `SELECT a.id, a.filename, a.mime_type, a.file_size,
            d.downloaded_at
     FROM mail_attachments a
     JOIN user_mails m ON m.id = a.mail_id
     LEFT JOIN mail_attachment_downloads d
       ON d.attachment_id = a.id AND d.user_id = ?
     WHERE m.batch_id = ?
     GROUP BY a.id`,
    [userId, batchId],
  );
  return rows;
}

async function getAttachmentStatusForMail(mailId, userId) {
  const [rows] = await pool.query(
    `SELECT a.id, a.filename, a.mime_type, a.file_size,
            d.downloaded_at
     FROM mail_attachments a
     LEFT JOIN mail_attachment_downloads d
       ON d.attachment_id = a.id AND d.user_id = ?
     WHERE a.mail_id = ?`,
    [userId, mailId],
  );
  return rows;
}

async function getAttachmentsForHardDelete(msgId) {
  const [atts] = await pool.query(
    `SELECT id, stored_name, file_size, uploaded_by, is_duplicate
     FROM mail_attachments WHERE mail_id = ?`,
    [msgId],
  );
  return atts;
}

async function countDuplicateRefs(attachmentId, excludeId) {
  const [[{ refs }]] = await pool.query(
    `SELECT COUNT(*) AS refs FROM mail_attachments
     WHERE original_attachment_id = ? AND id != ?`,
    [attachmentId, excludeId],
  );
  return refs;
}

async function countAllDuplicateRefs(attachmentId) {
  const [[{ refs }]] = await pool.query(
    `SELECT COUNT(*) AS refs FROM mail_attachments
     WHERE original_attachment_id = ?`,
    [attachmentId],
  );
  return refs;
}

async function deleteAttachmentRow(id) {
  return pool.query("DELETE FROM mail_attachments WHERE id = ?", [id]);
}

async function getOrphanedAttachments() {
  const [orphans] = await pool.query(
    `SELECT id, stored_name, file_size, uploaded_by, is_duplicate
     FROM mail_attachments
     WHERE mail_id IS NULL
       AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
  );
  return orphans;
}

async function getExpiredAttachments(retentionDays) {
  const [expired] = await pool.query(
    `SELECT a.id, a.stored_name, a.file_size, a.uploaded_by
     FROM mail_attachments a
     JOIN user_mails m ON m.id = a.mail_id
     WHERE m.read_at IS NOT NULL
       AND a.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
       AND a.is_duplicate = FALSE`,
    [retentionDays],
  );
  return expired;
}

// ── filesystem helper kept alongside repo since it mirrors storage layer ──
function unlinkStoredFile(storedName) {
  fs.unlink(path.join(UPLOADS_ROOT, storedName), () => {});
}

// ══════════════════════════════════════════════════════════
// MESSAGES (user_mails)
// ══════════════════════════════════════════════════════════
async function insertMail({
  batchId,
  fromUserId,
  fromName,
  fromEmail,
  toUserId,
  toName,
  subject,
  body,
}) {
  const [result] = await pool.query(
    `INSERT INTO user_mails
       (batch_id, from_user_id, from_name, from_email, to_user_id, to_name, subject, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [batchId, fromUserId, fromName, fromEmail, toUserId, toName, subject, body],
  );
  return result.insertId;
}

async function insertNotification({
  fromUserId,
  fromName,
  toUserId,
  toName,
  subject,
  body,
}) {
  return pool.query(
    `INSERT INTO user_mails
       (from_user_id, from_name, to_user_id, to_name, subject, body, is_notification)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fromUserId, fromName, toUserId, toName, subject, body, true],
  );
}

async function getInboxSince(userId, since) {
  const [rows] = await pool.query(
    `SELECT id, from_user_id, from_name, from_email, subject, body, is_read,
            sent_at, delivered_at, read_at,
            EXISTS(
              SELECT 1 FROM mail_attachments a
              JOIN user_mails m2 ON m2.id = a.mail_id
              WHERE m2.id = user_mails.id
                 OR (user_mails.batch_id IS NOT NULL AND m2.batch_id = user_mails.batch_id)
            ) AS has_attachments
     FROM user_mails
     WHERE to_user_id = ? AND sent_at > ? AND deleted_by_receiver = FALSE
     ORDER BY sent_at DESC`,
    [userId, since],
  );
  return rows;
}

async function getInboxPaginated(userId, limit, offset) {
  const [rows] = await pool.query(
    `SELECT id, from_user_id, from_name, from_email, subject, body, is_read,
            sent_at, delivered_at, read_at,
            EXISTS(
              SELECT 1 FROM mail_attachments a
              JOIN user_mails m2 ON m2.id = a.mail_id
              WHERE m2.id = user_mails.id
                 OR (user_mails.batch_id IS NOT NULL AND m2.batch_id = user_mails.batch_id)
            ) AS has_attachments
     FROM user_mails
     WHERE to_user_id = ? AND deleted_by_receiver = FALSE
     ORDER BY sent_at DESC
     LIMIT ? OFFSET ?`,
    [userId, limit, offset],
  );
  return rows;
}

async function markDelivered(ids) {
  return pool.query(
    "UPDATE user_mails SET delivered_at = NOW() WHERE id IN (?) AND delivered_at IS NULL",
    [ids],
  );
}

async function getUnreadCount(userId) {
  const [[{ unread }]] = await pool.query(
    `SELECT COUNT(*) as unread FROM user_mails
     WHERE to_user_id = ? AND is_read = 0 AND deleted_by_receiver = FALSE`,
    [userId],
  );
  return unread;
}

async function getSentGrouped(userId, limit, offset) {
  const [rows] = await pool.query(
    `SELECT
       g.id,
       g.to_user_id,
       g.to_name,
       g.recipient_count,
       g.subject,
       g.body,
       g.sent_at,
       g.delivered_at,
       g.read_at,
       g.read_count,
       g.delivered_count,
       g.batch_id,
       (SELECT COUNT(*) > 0 FROM mail_attachments WHERE mail_id = g.id) AS has_attachments
     FROM (
       SELECT
         MIN(id)                                                      AS id,
         MIN(to_user_id)                                              AS to_user_id,
         GROUP_CONCAT(to_name ORDER BY id SEPARATOR ', ')             AS to_name,
         COUNT(*)                                                     AS recipient_count,
         MIN(subject)                                                 AS subject,
         MIN(body)                                                    AS body,
         MIN(sent_at)                                                 AS sent_at,
         MIN(delivered_at)                                            AS delivered_at,
         MIN(read_at)                                                 AS read_at,
         SUM(read_at IS NOT NULL)                                     AS read_count,
         SUM(delivered_at IS NOT NULL)                                AS delivered_count,
         MIN(batch_id)                                                AS batch_id
       FROM user_mails
       WHERE from_user_id = ?
         AND deleted_by_sender = FALSE
         AND is_notification = FALSE
       GROUP BY COALESCE(batch_id, id)
       ORDER BY MIN(sent_at) DESC
       LIMIT ? OFFSET ?
     ) g
     ORDER BY g.sent_at DESC`,
    [userId, limit, offset],
  );
  return rows;
}

async function getSentItem(id, userId) {
  const [rows] = await pool.query(
    `SELECT m.*,
      (SELECT GROUP_CONCAT(to_name ORDER BY id SEPARATOR ', ')
       FROM user_mails WHERE batch_id = m.batch_id AND from_user_id = ?)
      AS all_recipients,
      (SELECT COUNT(*) FROM user_mails
       WHERE batch_id = m.batch_id AND from_user_id = ?)
      AS recipient_count
     FROM user_mails m
     WHERE m.id = ? AND m.from_user_id = ?`,
    [userId, userId, id, userId],
  );
  return rows;
}

async function getInboxMessage(id, userId) {
  const [rows] = await pool.query(
    "SELECT * FROM user_mails WHERE id = ? AND to_user_id = ?",
    [id, userId],
  );
  return rows;
}

async function markMessageReadFirstTime(id) {
  return pool.query(
    "UPDATE user_mails SET is_read = 1, read_at = NOW() WHERE id = ?",
    [id],
  );
}

async function markMessageRead(id) {
  return pool.query("UPDATE user_mails SET is_read = 1 WHERE id = ?", [id]);
}

async function getTickBase(id, userId) {
  const [rows] = await pool.query(
    `SELECT m.sent_at, m.delivered_at, m.read_at, m.batch_id
     FROM user_mails m WHERE m.id = ? AND m.from_user_id = ?`,
    [id, userId],
  );
  return rows;
}

async function getBatchTickRows(batchId, userId) {
  const [batchRows] = await pool.query(
    `SELECT m.id, m.to_name, m.to_email, m.sent_at, m.delivered_at, m.read_at
     FROM user_mails m
     WHERE m.batch_id = ? AND m.from_user_id = ?
     ORDER BY m.id ASC`,
    [batchId, userId],
  );
  return batchRows;
}

async function getMailForDelete(id) {
  const [msgs] = await pool.query(
    `SELECT from_user_id, to_user_id, from_name,
            deleted_by_sender, deleted_by_receiver,
            subject, is_notification, batch_id
     FROM user_mails WHERE id = ?`,
    [id],
  );
  return msgs;
}

async function markDeletedByReceiver(id) {
  return pool.query(
    "UPDATE user_mails SET deleted_by_receiver = TRUE WHERE id = ?",
    [id],
  );
}

async function markDeletedBySender(id) {
  return pool.query(
    "UPDATE user_mails SET deleted_by_sender = TRUE WHERE id = ?",
    [id],
  );
}

async function getBatchSiblings(batchId, fromUserId) {
  const [siblings] = await pool.query(
    `SELECT id, to_user_id, deleted_by_receiver FROM user_mails
     WHERE batch_id = ? AND from_user_id = ?`,
    [batchId, fromUserId],
  );
  return siblings;
}

async function deleteMailRow(id) {
  return pool.query("DELETE FROM user_mails WHERE id = ?", [id]);
}

module.exports = {
  // users
  getUserStorage,
  adjustStorageUsed,
  getSenderEmail,
  getUserFullName,
  searchUsers,
  // attachments
  findAttachmentByHash,
  insertDuplicateAttachment,
  insertOriginalAttachment,
  getAttachmentsByTokens,
  assignAttachmentsToMail,
  getAttachmentsForMail,
  getAttachmentById,
  getOriginalAttachmentStoredName,
  isBatchRecipient,
  recordAttachmentDownload,
  getMailBasicById,
  getAttachmentStatusForBatch,
  getAttachmentStatusForMail,
  getAttachmentsForHardDelete,
  countDuplicateRefs,
  countAllDuplicateRefs,
  deleteAttachmentRow,
  getOrphanedAttachments,
  getExpiredAttachments,
  unlinkStoredFile,
  // mail
  insertMail,
  insertNotification,
  getInboxSince,
  getInboxPaginated,
  markDelivered,
  getUnreadCount,
  getSentGrouped,
  getSentItem,
  getInboxMessage,
  markMessageReadFirstTime,
  markMessageRead,
  getTickBase,
  getBatchTickRows,
  getMailForDelete,
  markDeletedByReceiver,
  markDeletedBySender,
  getBatchSiblings,
  deleteMailRow,
};
