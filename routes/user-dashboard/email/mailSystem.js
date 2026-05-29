const express = require("express");
const router = express.Router();
const pool = require("../../../config/db");
const verifyToken = require("../../../middware/authentication");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

// ══════════════════════════════════════════════════════════
// ATTACHMENT CONFIG
// ══════════════════════════════════════════════════════════
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per file
const MAX_ATTACHMENTS = 3;
const MAX_RECIPIENTS = 20; // max recipients per send
const DEFAULT_QUOTA = 500 * 1024 * 1024; // 500 MB per user
const RETENTION_DAYS = 90; // delete attachments after 90 days

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// ── Upload directory (dated folders) ─────────────────────
function getUploadDir() {
  const now = new Date();
  const dir = path.join(
    __dirname,
    "../../uploads/mail",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, getUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, uuidv4() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) =>
    ALLOWED_MIME_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error("File type not allowed")),
});

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

// Hard-delete a message row + its physical attachment files.
// Dedup references (is_duplicate=TRUE) share a physical file — only originals are unlinked.
async function hardDeleteMessage(msgId) {
  const [atts] = await pool.query(
    `SELECT id, stored_name, file_size, uploaded_by, is_duplicate
     FROM mail_attachments WHERE mail_id = ?`,
    [msgId],
  );

  for (const att of atts) {
    if (!att.is_duplicate) {
      // Only delete the physical file if no other duplicate rows reference it
      const [[{ refs }]] = await pool.query(
        `SELECT COUNT(*) AS refs FROM mail_attachments
         WHERE original_attachment_id = ? AND id != ?`,
        [att.id, att.id],
      );
      if (refs === 0) {
        fs.unlink(
          path.join(__dirname, "../../uploads/mail", att.stored_name),
          () => {},
        );
      }
      await pool
        .query(
          `UPDATE hr_employees SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?)
         WHERE Empl_ID = ?`,
          [att.file_size, att.uploaded_by],
        )
        .catch(() => {});
    }
  }

  await pool.query("DELETE FROM user_mails WHERE id = ?", [msgId]);
}

// ══════════════════════════════════════════════════════════
// POST /api/messages/upload
// ══════════════════════════════════════════════════════════
router.post("/upload", verifyToken, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });

  const filePath = req.file.path;

  try {
    const [[user]] = await pool.query(
      `SELECT storage_used_bytes,
              COALESCE(storage_quota_bytes, ?) AS storage_quota_bytes
       FROM hr_employees WHERE Empl_ID = ?`,
      [DEFAULT_QUOTA, req.user_id],
    );

    if (!user) {
      fs.unlink(filePath, () => {});
      return res.status(403).json({ error: "User not found" });
    }

    const usedBytes = Number(user.storage_used_bytes) || 0;
    const quotaBytes = Number(user.storage_quota_bytes) || DEFAULT_QUOTA;

    if (usedBytes + req.file.size > quotaBytes) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({
        error: "Storage quota exceeded",
        used: usedBytes,
        quota: quotaBytes,
        available: Math.max(0, quotaBytes - usedBytes),
        message: `You have used ${fmtBytes(usedBytes)} of your ${fmtBytes(quotaBytes)} quota.`,
      });
    }

    const contentHash = await hashFile(filePath);

    const [existing] = await pool.query(
      `SELECT id, stored_name FROM mail_attachments
       WHERE content_hash = ? AND mail_id IS NOT NULL AND is_duplicate = FALSE
       LIMIT 1`,
      [contentHash],
    );

    const tempToken = uuidv4();

    if (existing.length > 0) {
      fs.unlink(filePath, () => {});

      await pool.query(
        `INSERT INTO mail_attachments
           (mail_id, temp_token, filename, stored_name, mime_type, file_size,
            uploaded_by, content_hash, is_duplicate, original_attachment_id)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
        [
          tempToken,
          req.file.originalname.slice(0, 255),
          existing[0].stored_name,
          req.file.mimetype,
          req.file.size,
          req.user_id,
          contentHash,
          existing[0].id,
        ],
      );

      return res.status(201).json({
        temp_token: tempToken,
        filename: req.file.originalname,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
      });
    }

    const relativePath = path
      .relative(path.join(__dirname, "../../uploads/mail"), filePath)
      .replace(/\\/g, "/");

    await pool.query(
      `INSERT INTO mail_attachments
         (mail_id, temp_token, filename, stored_name, mime_type, file_size,
          uploaded_by, content_hash, is_duplicate)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, FALSE)`,
      [
        tempToken,
        req.file.originalname.slice(0, 255),
        relativePath,
        req.file.mimetype,
        req.file.size,
        req.user_id,
        contentHash,
      ],
    );

    await pool.query(
      `UPDATE hr_employees SET storage_used_bytes = storage_used_bytes + ? WHERE Empl_ID = ?`,
      [req.file.size, req.user_id],
    );

    res.status(201).json({
      temp_token: tempToken,
      filename: req.file.originalname,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
    });
  } catch (err) {
    fs.unlink(filePath, () => {});
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

router.use(function (err, req, res, next) {
  if (
    err instanceof multer.MulterError ||
    err.message === "File type not allowed"
  )
    return res.status(400).json({ error: err.message });
  next(err);
});

// ══════════════════════════════════════════════════════════
// POST /api/messages — Send a message (single OR multi-recipient)
//
// Accepts either:
//   { to_user_id, to_name, ... }            ← legacy single
//   { recipients: [{user_id, full_name, email}, ...], ... }  ← new multi
//
// ATTACHMENT DEDUP ACROSS RECIPIENTS:
//   The first recipient gets the "real" attachment row (mail_id set directly).
//   Every subsequent recipient gets a new row with is_duplicate=TRUE pointing
//   to that first row's id as original_attachment_id.
//   This means 1 image sent to 20 users is stored once on disk, with 1 original
//   row + 19 duplicate rows — all referencing the same physical file.
//   Quota is only charged once (to the sender, already done at upload time).
// ══════════════════════════════════════════════════════════
router.post("/", verifyToken, async (req, res) => {
  const {
    to_user_id,
    to_name,
    to_email,
    subject,
    body,
    attachment_tokens,
    recipients,
  } = req.body;

  // Normalise to a recipients array
  let recipientList = [];
  if (Array.isArray(recipients) && recipients.length > 0) {
    recipientList = recipients;
  } else if (to_user_id) {
    recipientList = [
      {
        user_id: to_user_id,
        full_name: to_name || "Unknown",
        email: to_email || "",
      },
    ];
  }

  if (recipientList.length === 0)
    return res
      .status(400)
      .json({ error: "At least one recipient is required" });

  if (recipientList.length > MAX_RECIPIENTS)
    return res
      .status(400)
      .json({ error: `Maximum ${MAX_RECIPIENTS} recipients allowed` });

  if (!subject || !body)
    return res.status(400).json({ error: "Subject and body are required" });

  const tokens = Array.isArray(attachment_tokens) ? attachment_tokens : [];
  if (tokens.length > MAX_ATTACHMENTS)
    return res
      .status(400)
      .json({ error: `Maximum ${MAX_ATTACHMENTS} attachments allowed` });

  try {
    const [[sender]] = await pool.query(
      "SELECT email FROM hr_employees WHERE Empl_ID = ? LIMIT 1",
      [req.user_id],
    );
    const fromEmail = sender?.email || req.email || "";

    // ── Resolve attachment rows from temp tokens ──────────
    let attachmentRows = [];
    if (tokens.length > 0) {
      const [rows] = await pool.query(
        `SELECT id, stored_name, mime_type, file_size, filename, content_hash,
                is_duplicate, original_attachment_id, uploaded_by
         FROM mail_attachments
         WHERE temp_token IN (?) AND uploaded_by = ? AND mail_id IS NULL`,
        [tokens, req.user_id],
      );
      attachmentRows = rows;
    }

    const mailIds = [];
    // Assign a shared batch_id for multi-recipient sends so rows can be grouped
    const batchId = recipientList.length > 1 ? uuidv4() : null;

    for (let i = 0; i < recipientList.length; i++) {
      const recipient = recipientList[i];

      const [result] = await pool.query(
        `INSERT INTO user_mails
           (batch_id, from_user_id, from_name, from_email, to_user_id, to_name, subject, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchId,
          req.user_id,
          req.user_fullname,
          fromEmail,
          recipient.user_id,
          recipient.full_name,
          subject,
          body,
        ],
      );
      const mailId = result.insertId;
      mailIds.push(mailId);

      // Attach files to first recipient's mail only.
      // All recipients in the batch share these via the attachment-status endpoint
      // which resolves by batch_id — no duplicate rows needed.
      if (attachmentRows.length > 0 && i === 0) {
        await pool.query(
          `UPDATE mail_attachments SET mail_id = ?
           WHERE temp_token IN (?) AND uploaded_by = ? AND mail_id IS NULL`,
          [mailId, tokens, req.user_id],
        );
      }
    }

    const count = mailIds.length;
    console.log(
      `📨 ${req.user_fullname} sent to ${count} recipient(s) — ` +
        `${attachmentRows.length} attachment(s) stored once, referenced ${count} time(s)`,
    );

    res.status(201).json({
      message:
        count === 1
          ? "✅ Message sent"
          : `✅ Message sent to ${count} recipients`,
      recipient_count: count,
    });
  } catch (err) {
    console.error("❌ Send message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/inbox
// ══════════════════════════════════════════════════════════
router.get("/inbox", verifyToken, async (req, res) => {
  const { since, page = 1, limit = 20 } = req.query;
  try {
    let rows;
    if (since) {
      [rows] = await pool.query(
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
        [req.user_id, since],
      );
    } else {
      const offset = (parseInt(page) - 1) * parseInt(limit);
      [rows] = await pool.query(
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
        [req.user_id, parseInt(limit), offset],
      );
    }

    const undelivered = rows.filter((r) => !r.delivered_at).map((r) => r.id);
    if (undelivered.length > 0) {
      await pool.query(
        "UPDATE user_mails SET delivered_at = NOW() WHERE id IN (?) AND delivered_at IS NULL",
        [undelivered],
      );
      const now = new Date().toISOString();
      rows.forEach((r) => {
        if (!r.delivered_at) r.delivered_at = now;
      });
    }

    const [[{ unread }]] = await pool.query(
      `SELECT COUNT(*) as unread FROM user_mails
       WHERE to_user_id = ? AND is_read = 0 AND deleted_by_receiver = FALSE`,
      [req.user_id],
    );

    res.json({
      messages: rows,
      unread,
      server_time: new Date().toISOString(),
      server_tz_offset: 0,
    });
  } catch (err) {
    console.error("❌ Inbox error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/sent
// Multi-recipient messages appear grouped: one row per unique
// (subject, body, sent_at batch) with recipient_count + recipient_names
// ══════════════════════════════════════════════════════════
router.get("/sent", verifyToken, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    // Group by batch_id when present, otherwise treat each row as its own group.
    // ONLY_FULL_GROUP_BY compliance: every non-aggregated column in the inner
    // SELECT must be wrapped in ANY_VALUE() or an aggregate. We use ANY_VALUE()
    // for columns that are functionally identical within a batch (subject, body,
    // from_user_id etc.) and MIN()/GROUP_CONCAT() where ordering matters.
    // has_attachments uses a scalar subquery on the already-resolved g.id so
    // no aggregate-in-subquery issues arise.
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
      [req.user_id, parseInt(limit), offset],
    );
    res.json({
      messages: rows,
      server_tz_offset: 0,
    });
  } catch (err) {
    console.error("❌ Sent error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/sent-item/:id
// ══════════════════════════════════════════════════════════
router.get("/sent-item/:id", verifyToken, async (req, res) => {
  try {
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
      [req.user_id, req.user_id, req.params.id, req.user_id],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Message not found" });
    const msg = rows[0];
    // If it was a batch, show all recipient names
    if (msg.batch_id && msg.all_recipients) {
      msg.to_name = msg.all_recipients;
    }
    const [attachments] = await pool.query(
      "SELECT id, filename, stored_name, mime_type, file_size FROM mail_attachments WHERE mail_id = ?",
      [msg.id],
    );
    msg.attachments = attachments;
    res.json(msg);
  } catch (err) {
    console.error("❌ Get sent message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/:id — Open inbox message + stamp read_at
// ══════════════════════════════════════════════════════════
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM user_mails WHERE id = ? AND to_user_id = ?",
      [req.params.id, req.user_id],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Message not found" });

    const msg = rows[0];

    if (!msg.read_at) {
      await pool.query(
        "UPDATE user_mails SET is_read = 1, read_at = NOW() WHERE id = ?",
        [req.params.id],
      );
      msg.read_at = new Date().toISOString();
    } else {
      await pool.query("UPDATE user_mails SET is_read = 1 WHERE id = ?", [
        req.params.id,
      ]);
    }

    const [attachments] = await pool.query(
      "SELECT id, filename, stored_name, mime_type, file_size FROM mail_attachments WHERE mail_id = ?",
      [msg.id],
    );
    msg.attachments = attachments;
    res.json(msg);
  } catch (err) {
    console.error("❌ Get message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/tick/:id
// For multi-recipient: reports aggregate status across all copies
// ══════════════════════════════════════════════════════════
router.get("/tick/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.sent_at, m.delivered_at, m.read_at, m.batch_id
       FROM user_mails m WHERE m.id = ? AND m.from_user_id = ?`,
      [req.params.id, req.user_id],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Message not found" });

    const base = rows[0];

    // Batch message — return per-recipient detail so the UI can group by status tier
    if (base.batch_id) {
      const [batchRows] = await pool.query(
        `SELECT m.id, m.to_name, m.to_email, m.sent_at, m.delivered_at, m.read_at
         FROM user_mails m
         WHERE m.batch_id = ? AND m.from_user_id = ?
         ORDER BY m.id ASC`,
        [base.batch_id, req.user_id],
      );

      const allDelivered = batchRows.every((r) => r.delivered_at);
      const allRead = batchRows.every((r) => r.read_at);
      const anyDelivered = batchRows.some((r) => r.delivered_at);
      const anyRead = batchRows.some((r) => r.read_at);

      const firstDelivered =
        batchRows
          .map((r) => r.delivered_at)
          .filter(Boolean)
          .sort()[0] || null;
      const firstRead =
        batchRows
          .map((r) => r.read_at)
          .filter(Boolean)
          .sort()[0] || null;

      const tick = allRead
        ? "read"
        : anyRead
          ? "partial_read"
          : allDelivered
            ? "delivered"
            : anyDelivered
              ? "partial_delivered"
              : "sent";

      return res.json({
        tick,
        sent_at: base.sent_at,
        delivered_at: firstDelivered,
        read_at: firstRead,
        read_count: batchRows.filter((r) => r.read_at).length,
        delivered_count: batchRows.filter((r) => r.delivered_at).length,
        recipient_count: batchRows.length,
        // Per-recipient rows for grouped popover
        recipients: batchRows.map((r) => ({
          name: r.to_name,
          email: r.to_email || "",
          sent_at: r.sent_at,
          delivered_at: r.delivered_at || null,
          read_at: r.read_at || null,
        })),
      });
    }

    const { sent_at, delivered_at, read_at } = base;
    const tick = read_at ? "read" : delivered_at ? "delivered" : "sent";
    res.json({
      tick,
      sent_at,
      delivered_at,
      read_at,
      recipient_count: 1,
      recipients: null,
    });
  } catch (err) {
    console.error("❌ Tick error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/attachment/:id
// ══════════════════════════════════════════════════════════
router.get("/attachment/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, m.from_user_id, m.to_user_id, m.batch_id
       FROM mail_attachments a
       JOIN user_mails m ON m.id = a.mail_id
       WHERE a.id = ?`,
      [req.params.id],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Attachment not found" });

    const att = rows[0];
    const isDirectAccess =
      att.from_user_id === req.user_id || att.to_user_id === req.user_id;

    // For batch sends the attachment lives on recipient 1's mail.
    // Recipients 2+ are in the same batch but have a different mail row —
    // verify access by checking if the user is a recipient of any mail in the batch.
    let isBatchRecipient = false;
    if (!isDirectAccess && att.batch_id) {
      const [[batchRow]] = await pool.query(
        `SELECT id FROM user_mails WHERE batch_id = ? AND to_user_id = ? LIMIT 1`,
        [att.batch_id, req.user_id],
      );
      isBatchRecipient = !!batchRow;
    }

    if (!isDirectAccess && !isBatchRecipient)
      return res.status(403).json({ error: "Access denied" });

    let storedName = att.stored_name;
    if (att.is_duplicate && att.original_attachment_id) {
      const [origRows] = await pool.query(
        "SELECT stored_name FROM mail_attachments WHERE id = ?",
        [att.original_attachment_id],
      );
      if (origRows.length > 0) storedName = origRows[0].stored_name;
    }

    const filePath = path.join(__dirname, "../../uploads/mail", storedName);
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: "File not found on disk" });

    await pool.query(
      `INSERT IGNORE INTO mail_attachment_downloads (attachment_id, user_id)
       VALUES (?, ?)`,
      [att.id, req.user_id],
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(att.filename)}"`,
    );
    res.setHeader("Content-Type", att.mime_type);
    res.sendFile(filePath);
  } catch (err) {
    console.error("❌ Attachment download error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/attachment-status/:mailId
// ══════════════════════════════════════════════════════════
router.get("/attachment-status/:mailId", verifyToken, async (req, res) => {
  try {
    // First verify the user has access to this mail
    const [[mail]] = await pool.query(
      "SELECT id, from_user_id, to_user_id, batch_id FROM user_mails WHERE id = ?",
      [req.params.mailId],
    );
    if (!mail) return res.status(404).json({ attachments: [] });
    if (mail.from_user_id !== req.user_id && mail.to_user_id !== req.user_id)
      return res.status(403).json({ error: "Access denied" });

    // Single query handles all cases:
    // - Single send: attachments sit directly on this mail_id
    // - Batch sender: attachments sit on the first recipient's mail in the batch
    // - Batch recipient 2+: their mail has no attachment rows — look up via batch
    // In all batch cases we find attachments by joining through the batch's mails.
    let rows;
    if (mail.batch_id) {
      // Batch send (sender or any recipient): find attachments on any mail in this batch
      [rows] = await pool.query(
        `SELECT a.id, a.filename, a.mime_type, a.file_size,
                d.downloaded_at
         FROM mail_attachments a
         JOIN user_mails m ON m.id = a.mail_id
         LEFT JOIN mail_attachment_downloads d
           ON d.attachment_id = a.id AND d.user_id = ?
         WHERE m.batch_id = ?
         GROUP BY a.id`,
        [req.user_id, mail.batch_id],
      );
    } else {
      // Single send
      [rows] = await pool.query(
        `SELECT a.id, a.filename, a.mime_type, a.file_size,
                d.downloaded_at
         FROM mail_attachments a
         LEFT JOIN mail_attachment_downloads d
           ON d.attachment_id = a.id AND d.user_id = ?
         WHERE a.mail_id = ?`,
        [req.user_id, req.params.mailId],
      );
    }
    res.json({ attachments: rows });
  } catch (err) {
    console.error("❌ Attachment status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/storage/me
// ══════════════════════════════════════════════════════════
router.get("/storage/me", verifyToken, async (req, res) => {
  try {
    const [[user]] = await pool.query(
      `SELECT storage_used_bytes,
              COALESCE(storage_quota_bytes, ?) AS storage_quota_bytes
       FROM hr_employees WHERE Empl_ID = ?`,
      [DEFAULT_QUOTA, req.user_id],
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    const used = Number(user.storage_used_bytes) || 0;
    const quota = Number(user.storage_quota_bytes) || DEFAULT_QUOTA;
    const available = Math.max(0, quota - used);
    const pct = quota > 0 ? Math.round((used / quota) * 100) : 0;

    res.json({
      used_bytes: used,
      quota_bytes: quota,
      available_bytes: available,
      percent_used: pct,
      used_formatted: fmtBytes(used),
      quota_formatted: fmtBytes(quota),
    });
  } catch (err) {
    console.error("❌ Storage info error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════════
// DELETE /api/messages/:id
// ══════════════════════════════════════════════════════════
router.delete("/:id", verifyToken, async (req, res) => {
  const mode = req.query.mode || "me";
  try {
    const [msgs] = await pool.query(
      `SELECT from_user_id, to_user_id, from_name,
              deleted_by_sender, deleted_by_receiver,
              subject, is_notification, batch_id
       FROM user_mails WHERE id = ?`,
      [req.params.id],
    );
    if (!msgs.length)
      return res.status(404).json({ error: "Message not found" });

    const msg = msgs[0];
    const isSender = msg.from_user_id === req.user_id;
    const isReceiver = msg.to_user_id === req.user_id;

    if (!isSender && !isReceiver)
      return res.status(403).json({ error: "Not authorized" });

    if (isReceiver && !isSender) {
      if (msg.is_notification || msg.subject === "Message Deleted") {
        await hardDeleteMessage(req.params.id);
      } else if (msg.deleted_by_sender) {
        await hardDeleteMessage(req.params.id);
      } else {
        await pool.query(
          "UPDATE user_mails SET deleted_by_receiver = TRUE WHERE id = ?",
          [req.params.id],
        );
      }
      return res.json({ message: "✅ Message deleted from your inbox" });
    }

    if (isSender) {
      if (mode === "me") {
        if (msg.deleted_by_receiver) {
          await hardDeleteMessage(req.params.id);
        } else {
          await pool.query(
            "UPDATE user_mails SET deleted_by_sender = TRUE WHERE id = ?",
            [req.params.id],
          );
        }
        return res.json({
          message: "✅ Message deleted from your sent folder",
        });
      }

      if (mode === "all") {
        // For batch messages, delete all sibling copies
        if (msg.batch_id) {
          const [siblings] = await pool.query(
            `SELECT id, to_user_id, deleted_by_receiver FROM user_mails
             WHERE batch_id = ? AND from_user_id = ?`,
            [msg.batch_id, req.user_id],
          );
          for (const sibling of siblings) {
            const receiverHadDeleted = sibling.deleted_by_receiver;
            await hardDeleteMessage(sibling.id);
            if (!receiverHadDeleted) {
              const [[toUser]] = await pool.query(
                "SELECT CONCAT(Title,'.',Surname, ' ', OtherName) AS full_name FROM hr_employees WHERE Empl_ID = ?",
                [sibling.to_user_id],
              );
              await pool.query(
                `INSERT INTO user_mails
                   (from_user_id, from_name, to_user_id, to_name, subject, body, is_notification)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  req.user_id,
                  req.user_fullname,
                  sibling.to_user_id,
                  toUser ? toUser.full_name : "Recipient",
                  "Message Deleted",
                  `${req.user_fullname} deleted a message from your conversation`,
                  true,
                ],
              );
            }
          }
        } else {
          const receiverHadDeleted = msg.deleted_by_receiver;
          await hardDeleteMessage(req.params.id);
          if (!receiverHadDeleted) {
            const [[toUser]] = await pool.query(
              "SELECT CONCAT(Title,'.',Surname, ' ', OtherName) AS full_name FROM hr_employees WHERE Empl_ID = ?",
              [msg.to_user_id],
            );
            await pool.query(
              `INSERT INTO user_mails
                 (from_user_id, from_name, to_user_id, to_name, subject, body, is_notification)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                req.user_id,
                req.user_fullname,
                msg.to_user_id,
                toUser ? toUser.full_name : "Recipient",
                "Message Deleted",
                `${req.user_fullname} deleted a message from your conversation`,
                true,
              ],
            );
          }
        }
        return res.json({ message: "✅ Message deleted for all" });
      }
    }
  } catch (err) {
    console.error("❌ Delete message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/users/search?q=
// ══════════════════════════════════════════════════════════
router.get("/users/search", verifyToken, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2)
    return res
      .status(400)
      .json({ error: "Search query must be at least 2 characters" });
  try {
    const [rows] = await pool.query(
      `SELECT Empl_ID AS user_id, CONCAT(Title,'.',Surname, ' ', OtherName) AS full_name, email FROM hr_employees
       WHERE (Title LIKE ? OR Empl_ID LIKE ? OR Surname LIKE ? OR OtherName LIKE ? OR email LIKE ?)
         AND Empl_ID != ?
       LIMIT 20`,
      [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, req.user_id],
    );
    res.json({ users: rows });
  } catch (err) {
    console.error("❌ User search error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// CLEANUP JOB
// ══════════════════════════════════════════════════════════
async function cleanupOrphanedAttachments() {
  console.log("🧹 Running attachment cleanup...");
  let orphanCount = 0;
  let expiredCount = 0;

  try {
    const [orphans] = await pool.query(
      `SELECT id, stored_name, file_size, uploaded_by, is_duplicate
       FROM mail_attachments
       WHERE mail_id IS NULL
         AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );

    for (const row of orphans) {
      if (!row.is_duplicate) {
        fs.unlink(
          path.join(__dirname, "../../uploads/mail", row.stored_name),
          () => {},
        );
        await pool
          .query(
            `UPDATE hr_employees SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?)
           WHERE Empl_ID = ?`,
            [row.file_size, row.uploaded_by],
          )
          .catch(() => {});
      }
      await pool.query("DELETE FROM mail_attachments WHERE id = ?", [row.id]);
      orphanCount++;
    }

    const [expired] = await pool.query(
      `SELECT a.id, a.stored_name, a.file_size, a.uploaded_by
       FROM mail_attachments a
       JOIN user_mails m ON m.id = a.mail_id
       WHERE m.read_at IS NOT NULL
         AND a.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
         AND a.is_duplicate = FALSE`,
      [RETENTION_DAYS],
    );

    for (const att of expired) {
      const [[{ refs }]] = await pool.query(
        `SELECT COUNT(*) AS refs FROM mail_attachments
         WHERE original_attachment_id = ?`,
        [att.id],
      );

      if (refs === 0) {
        fs.unlink(
          path.join(__dirname, "../../uploads/mail", att.stored_name),
          () => {},
        );
      }

      await pool.query("DELETE FROM mail_attachments WHERE id = ?", [att.id]);
      await pool
        .query(
          `UPDATE hr_employees SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?)
         WHERE Empl_ID = ?`,
          [att.file_size, att.uploaded_by],
        )
        .catch(() => {});

      expiredCount++;
    }

    const total = orphanCount + expiredCount;
    if (total > 0) {
      console.log(
        `🧹 Cleanup done — ${orphanCount} orphaned, ${expiredCount} expired (${total} total)`,
      );
    } else {
      console.log("🧹 Cleanup complete — nothing to remove");
    }
  } catch (err) {
    console.error("❌ Attachment cleanup error:", err);
  }
}

module.exports = router;
module.exports.cleanupOrphanedAttachments = cleanupOrphanedAttachments;
