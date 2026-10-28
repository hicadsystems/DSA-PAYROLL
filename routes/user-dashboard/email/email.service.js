const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const repo = require("./email.repository");
const {
  DEFAULT_QUOTA,
  RETENTION_DAYS,
  UPLOADS_ROOT,
  hashFile,
  fmtBytes,
} = require("./email.utils");
const SocketService = require("../../../config/sockets");

// Hard-delete a message row + its physical attachment files.
// Dedup references (is_duplicate=TRUE) share a physical file — only originals are unlinked.
async function hardDeleteMessage(msgId) {
  const atts = await repo.getAttachmentsForHardDelete(msgId);

  for (const att of atts) {
    if (!att.is_duplicate) {
      // Only delete the physical file if no other duplicate rows reference it
      const refs = await repo.countDuplicateRefs(att.id, att.id);
      if (refs === 0) {
        repo.unlinkStoredFile(att.stored_name);
      }
      await repo.adjustStorageUsed(att.uploaded_by, -att.file_size);
    }
  }

  await repo.deleteMailRow(msgId);
}

// ══════════════════════════════════════════════════════════
// UPLOAD
// ══════════════════════════════════════════════════════════
async function handleUpload({ file, userId }) {
  const filePath = file.path;

  const user = await repo.getUserStorage(userId, DEFAULT_QUOTA);
  if (!user) {
    fs.unlink(filePath, () => {});
    const err = new Error("User not found");
    err.status = 403;
    throw err;
  }

  const usedBytes = Number(user.storage_used_bytes) || 0;
  const quotaBytes = Number(user.storage_quota_bytes) || DEFAULT_QUOTA;

  if (usedBytes + file.size > quotaBytes) {
    fs.unlink(filePath, () => {});
    const err = new Error("Storage quota exceeded");
    err.status = 400;
    err.payload = {
      error: "Storage quota exceeded",
      used: usedBytes,
      quota: quotaBytes,
      available: Math.max(0, quotaBytes - usedBytes),
      message: `You have used ${fmtBytes(usedBytes)} of your ${fmtBytes(quotaBytes)} quota.`,
    };
    throw err;
  }

  const contentHash = await hashFile(filePath);
  const existing = await repo.findAttachmentByHash(contentHash);
  const tempToken = uuidv4();

  if (existing.length > 0) {
    fs.unlink(filePath, () => {});

    await repo.insertDuplicateAttachment({
      tempToken,
      filename: file.originalname.slice(0, 255),
      storedName: existing[0].stored_name,
      mimeType: file.mimetype,
      fileSize: file.size,
      uploadedBy: userId,
      contentHash,
      originalAttachmentId: existing[0].id,
    });

    return {
      temp_token: tempToken,
      filename: file.originalname,
      file_size: file.size,
      mime_type: file.mimetype,
    };
  }

  const relativePath = path
    .relative(UPLOADS_ROOT, filePath)
    .replace(/\\/g, "/");

  await repo.insertOriginalAttachment({
    tempToken,
    filename: file.originalname.slice(0, 255),
    relativePath,
    mimeType: file.mimetype,
    fileSize: file.size,
    uploadedBy: userId,
    contentHash,
  });

  await repo.adjustStorageUsed(userId, file.size);

  return {
    temp_token: tempToken,
    filename: file.originalname,
    file_size: file.size,
    mime_type: file.mimetype,
  };
}

// ══════════════════════════════════════════════════════════
// SEND MESSAGE
// (This is the function meant to be reused elsewhere as the
//  generic "send mail" entry point.)
// ══════════════════════════════════════════════════════════
async function sendMessage({
  userId,
  userFullname,
  to_user_id,
  to_name,
  to_email,
  subject,
  body,
  attachment_tokens,
  recipients,
}) {
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

  if (recipientList.length === 0) {
    const err = new Error("At least one recipient is required");
    err.status = 400;
    throw err;
  }

  const { MAX_RECIPIENTS, MAX_ATTACHMENTS } = require("./email.utils");

  if (recipientList.length > MAX_RECIPIENTS) {
    const err = new Error(`Maximum ${MAX_RECIPIENTS} recipients allowed`);
    err.status = 400;
    throw err;
  }

  if (!subject || !body) {
    const err = new Error("Subject and body are required");
    err.status = 400;
    throw err;
  }

  const tokens = Array.isArray(attachment_tokens) ? attachment_tokens : [];
  if (tokens.length > MAX_ATTACHMENTS) {
    const err = new Error(`Maximum ${MAX_ATTACHMENTS} attachments allowed`);
    err.status = 400;
    throw err;
  }

  const fromEmail = (await repo.getSenderEmail(userId)) || "";

  // ── Resolve attachment rows from temp tokens ──────────
  let attachmentRows = [];
  if (tokens.length > 0) {
    attachmentRows = await repo.getAttachmentsByTokens(tokens, userId);
  }

  const mailIds = [];
  // Assign a shared batch_id for multi-recipient sends so rows can be grouped
  const batchId = recipientList.length > 1 ? uuidv4() : null;

  const sentAt = new Date().toISOString();

  for (let i = 0; i < recipientList.length; i++) {
    const recipient = recipientList[i];

    const mailId = await repo.insertMail({
      batchId,
      fromUserId: userId,
      fromName: userFullname,
      fromEmail,
      toUserId: recipient.user_id,
      toName: recipient.full_name,
      subject,
      body,
    });
    mailIds.push(mailId);

    // Attach files to first recipient's mail only.
    // All recipients in the batch share these via the attachment-status endpoint
    // which resolves by batch_id — no duplicate rows needed.
    if (attachmentRows.length > 0 && i === 0) {
      await repo.assignAttachmentsToMail(mailId, tokens, userId);
    }
  }

  const count = mailIds.length;
  console.log(
    `📨 ${userFullname} sent to ${count} recipient(s) — ` +
      `${attachmentRows.length} attachment(s) stored once, referenced ${count} time(s)`,
  );

  // ── Real-time notify each recipient ──────────────────────
  for (let i = 0; i < recipientList.length; i++) {
    const r = recipientList[i];

    SocketService.emitToUser(r.user_id, "mail:new", {
      id: mailIds[i],
      from_name: userFullname,
      subject,
      preview: body.slice(0, 80),
      sent_at: sentAt,
      has_attachments: tokens.length > 0,
      recipient_count: count,
    });

    try {
      const unread = await repo.getUnreadCount(r.user_id);
      SocketService.emitToUser(r.user_id, "mail:badge", { unread });
    } catch (e) {
      console.error(`Failed to get unread count for ${r.user_id}:`, e.message);
    }
  }

  return {
    message:
      count === 1
        ? "✅ Message sent"
        : `✅ Message sent to ${count} recipients`,
    recipient_count: count,
  };
}

// ══════════════════════════════════════════════════════════
// INBOX
// ══════════════════════════════════════════════════════════
async function getInbox({ userId, since, page = 1, limit = 20 }) {
  let rows;
  if (since) {
    rows = await repo.getInboxSince(userId, since);
  } else {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    rows = await repo.getInboxPaginated(userId, parseInt(limit), offset);
  }

  const undelivered = rows.filter((r) => !r.delivered_at).map((r) => r.id);
  if (undelivered.length > 0) {
    await repo.markDelivered(undelivered);
    const now = new Date().toISOString();
    rows.forEach((r) => {
      if (!r.delivered_at) r.delivered_at = now;
    });
  }

  const unread = await repo.getUnreadCount(userId);

  return {
    messages: rows,
    unread,
    server_time: new Date().toISOString(),
    server_tz_offset: 0,
  };
}

// ══════════════════════════════════════════════════════════
// SENT
// ══════════════════════════════════════════════════════════
async function getSent({ userId, page = 1, limit = 20 }) {
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const rows = await repo.getSentGrouped(userId, parseInt(limit), offset);
  return { messages: rows, server_tz_offset: 0 };
}

async function getSentItem({ id, userId }) {
  const rows = await repo.getSentItem(id, userId);
  if (rows.length === 0) {
    const err = new Error("Message not found");
    err.status = 404;
    throw err;
  }
  const msg = rows[0];
  if (msg.batch_id && msg.all_recipients) {
    msg.to_name = msg.all_recipients;
  }
  msg.attachments = await repo.getAttachmentsForMail(msg.id);
  return msg;
}

// ══════════════════════════════════════════════════════════
// SINGLE MESSAGE (inbox open)
// ══════════════════════════════════════════════════════════
async function getInboxMessage({ id, userId }) {
  const rows = await repo.getInboxMessage(id, userId);
  if (rows.length === 0) {
    const err = new Error("Message not found");
    err.status = 404;
    throw err;
  }

  const msg = rows[0];

  if (!msg.read_at) {
    await repo.markMessageReadFirstTime(id);
    msg.read_at = new Date().toISOString();
  } else {
    await repo.markMessageRead(id);
  }

  msg.attachments = await repo.getAttachmentsForMail(msg.id);
  return msg;
}

// ══════════════════════════════════════════════════════════
// TICK (delivery/read status)
// ══════════════════════════════════════════════════════════
async function getTick({ id, userId }) {
  const rows = await repo.getTickBase(id, userId);
  if (rows.length === 0) {
    const err = new Error("Message not found");
    err.status = 404;
    throw err;
  }

  const base = rows[0];

  if (base.batch_id) {
    const batchRows = await repo.getBatchTickRows(base.batch_id, userId);

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

    return {
      tick,
      sent_at: base.sent_at,
      delivered_at: firstDelivered,
      read_at: firstRead,
      read_count: batchRows.filter((r) => r.read_at).length,
      delivered_count: batchRows.filter((r) => r.delivered_at).length,
      recipient_count: batchRows.length,
      recipients: batchRows.map((r) => ({
        name: r.to_name,
        email: r.to_email || "",
        sent_at: r.sent_at,
        delivered_at: r.delivered_at || null,
        read_at: r.read_at || null,
      })),
    };
  }

  const { sent_at, delivered_at, read_at } = base;
  const tick = read_at ? "read" : delivered_at ? "delivered" : "sent";
  return {
    tick,
    sent_at,
    delivered_at,
    read_at,
    recipient_count: 1,
    recipients: null,
  };
}

// ══════════════════════════════════════════════════════════
// ATTACHMENT DOWNLOAD
// ══════════════════════════════════════════════════════════
async function getAttachmentForDownload({ attachmentId, userId }) {
  const att = await repo.getAttachmentById(attachmentId);
  if (!att) {
    const err = new Error("Attachment not found");
    err.status = 404;
    throw err;
  }

  const isDirectAccess =
    att.from_user_id === userId || att.to_user_id === userId;

  // For batch sends the attachment lives on recipient 1's mail.
  // Recipients 2+ are in the same batch but have a different mail row —
  // verify access by checking if the user is a recipient of any mail in the batch.
  let isBatch = false;
  if (!isDirectAccess && att.batch_id) {
    isBatch = await repo.isBatchRecipient(att.batch_id, userId);
  }

  if (!isDirectAccess && !isBatch) {
    const err = new Error("Access denied");
    err.status = 403;
    throw err;
  }

  let storedName = att.stored_name;
  if (att.is_duplicate && att.original_attachment_id) {
    const origStoredName = await repo.getOriginalAttachmentStoredName(
      att.original_attachment_id,
    );
    if (origStoredName) storedName = origStoredName;
  }

  const filePath = path.join(UPLOADS_ROOT, storedName);
  if (!fs.existsSync(filePath)) {
    const err = new Error("File not found on disk");
    err.status = 404;
    throw err;
  }

  await repo.recordAttachmentDownload(att.id, userId);

  return { att, filePath };
}

// ══════════════════════════════════════════════════════════
// ATTACHMENT STATUS
// ══════════════════════════════════════════════════════════
async function getAttachmentStatus({ mailId, userId }) {
  const mail = await repo.getMailBasicById(mailId);
  if (!mail) {
    const err = new Error("Not found");
    err.status = 404;
    err.emptyPayload = { attachments: [] };
    throw err;
  }
  if (mail.from_user_id !== userId && mail.to_user_id !== userId) {
    const err = new Error("Access denied");
    err.status = 403;
    throw err;
  }

  let rows;
  if (mail.batch_id) {
    rows = await repo.getAttachmentStatusForBatch(mail.batch_id, userId);
  } else {
    rows = await repo.getAttachmentStatusForMail(mailId, userId);
  }
  return { attachments: rows };
}

// ══════════════════════════════════════════════════════════
// STORAGE INFO
// ══════════════════════════════════════════════════════════
async function getStorageInfo({ userId }) {
  const user = await repo.getUserStorage(userId, DEFAULT_QUOTA);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  const used = Number(user.storage_used_bytes) || 0;
  const quota = Number(user.storage_quota_bytes) || DEFAULT_QUOTA;
  const available = Math.max(0, quota - used);
  const pct = quota > 0 ? Math.round((used / quota) * 100) : 0;

  return {
    used_bytes: used,
    quota_bytes: quota,
    available_bytes: available,
    percent_used: pct,
    used_formatted: fmtBytes(used),
    quota_formatted: fmtBytes(quota),
  };
}

// ══════════════════════════════════════════════════════════
// DELETE MESSAGE
// ══════════════════════════════════════════════════════════
async function deleteMessage({ id, userId, userFullname, mode = "me" }) {
  const msgs = await repo.getMailForDelete(id);
  if (!msgs.length) {
    const err = new Error("Message not found");
    err.status = 404;
    throw err;
  }

  const msg = msgs[0];
  const isSender = msg.from_user_id === userId;
  const isReceiver = msg.to_user_id === userId;

  if (!isSender && !isReceiver) {
    const err = new Error("Not authorized");
    err.status = 403;
    throw err;
  }

  if (isReceiver && !isSender) {
    if (msg.is_notification || msg.subject === "Message Deleted") {
      await hardDeleteMessage(id);
    } else if (msg.deleted_by_sender) {
      await hardDeleteMessage(id);
    } else {
      await repo.markDeletedByReceiver(id);
    }
    return { message: "✅ Message deleted from your inbox" };
  }

  if (isSender) {
    if (mode === "me") {
      if (msg.deleted_by_receiver) {
        await hardDeleteMessage(id);
      } else {
        await repo.markDeletedBySender(id);
      }
      return { message: "✅ Message deleted from your sent folder" };
    }

    if (mode === "all") {
      // For batch messages, delete all sibling copies
      if (msg.batch_id) {
        const siblings = await repo.getBatchSiblings(msg.batch_id, userId);
        for (const sibling of siblings) {
          const receiverHadDeleted = sibling.deleted_by_receiver;
          await hardDeleteMessage(sibling.id);
          if (!receiverHadDeleted) {
            const toFullName = await repo.getUserFullName(sibling.to_user_id);
            await repo.insertNotification({
              fromUserId: userId,
              fromName: userFullname,
              toUserId: sibling.to_user_id,
              toName: toFullName,
              subject: "Message Deleted",
              body: `${userFullname} deleted a message from your conversation`,
            });
          }
        }
      } else {
        const receiverHadDeleted = msg.deleted_by_receiver;
        await hardDeleteMessage(id);
        if (!receiverHadDeleted) {
          const toFullName = await repo.getUserFullName(msg.to_user_id);
          await repo.insertNotification({
            fromUserId: userId,
            fromName: userFullname,
            toUserId: msg.to_user_id,
            toName: toFullName,
            subject: "Message Deleted",
            body: `${userFullname} deleted a message from your conversation`,
          });
        }
      }
      return { message: "✅ Message deleted for all" };
    }
  }
}

// ══════════════════════════════════════════════════════════
// USER SEARCH
// ══════════════════════════════════════════════════════════
async function searchUsers({ q, userId }) {
  if (!q || q.trim().length < 2) {
    const err = new Error("Search query must be at least 2 characters");
    err.status = 400;
    throw err;
  }
  const rows = await repo.searchUsers(q, userId);
  return { users: rows };
}

// ══════════════════════════════════════════════════════════
// CLEANUP JOB
// ══════════════════════════════════════════════════════════
async function cleanupOrphanedAttachments() {
  console.log("🧹 Running attachment cleanup...");
  let orphanCount = 0;
  let expiredCount = 0;

  try {
    const orphans = await repo.getOrphanedAttachments();

    for (const row of orphans) {
      if (!row.is_duplicate) {
        repo.unlinkStoredFile(row.stored_name);
        await repo.adjustStorageUsed(row.uploaded_by, -row.file_size);
      }
      await repo.deleteAttachmentRow(row.id);
      orphanCount++;
    }

    const expired = await repo.getExpiredAttachments(RETENTION_DAYS);

    for (const att of expired) {
      const refs = await repo.countAllDuplicateRefs(att.id);

      if (refs === 0) {
        repo.unlinkStoredFile(att.stored_name);
      }

      await repo.deleteAttachmentRow(att.id);
      await repo.adjustStorageUsed(att.uploaded_by, -att.file_size);

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

module.exports = {
  hardDeleteMessage,
  handleUpload,
  sendMessage,
  getInbox,
  getSent,
  getSentItem,
  getInboxMessage,
  getTick,
  getAttachmentForDownload,
  getAttachmentStatus,
  getStorageInfo,
  deleteMessage,
  searchUsers,
  cleanupOrphanedAttachments,
};
