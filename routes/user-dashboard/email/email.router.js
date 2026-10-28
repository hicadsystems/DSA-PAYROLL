
const express = require("express");
const router = express.Router();
const verifyToken = require("../../../middware/authentication");
const multer = require("multer");
const emailService = require("./email.service");
const { upload } = require("./email.utils");

// ══════════════════════════════════════════════════════════
// POST /api/messages/upload
// ══════════════════════════════════════════════════════════
router.post("/upload", verifyToken, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });

  try {
    const result = await emailService.handleUpload({
      file: req.file,
      userId: req.user_id,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.payload) return res.status(err.status || 400).json(err.payload);
    if (err.status) return res.status(err.status).json({ error: err.message });
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
// ══════════════════════════════════════════════════════════
router.post("/", verifyToken, async (req, res) => {
  try {
    const result = await emailService.sendMessage({
      userId: req.user_id,
      userFullname: req.user_fullname,
      ...req.body,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
    const result = await emailService.getInbox({
      userId: req.user_id,
      since,
      page,
      limit,
    });
    res.json(result);
  } catch (err) {
    console.error("❌ Inbox error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/sent
// ══════════════════════════════════════════════════════════
router.get("/sent", verifyToken, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  try {
    const result = await emailService.getSent({ userId: req.user_id, page, limit });
    res.json(result);
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
    const msg = await emailService.getSentItem({
      id: req.params.id,
      userId: req.user_id,
    });
    res.json(msg);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("❌ Get sent message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/:id — Open inbox message + stamp read_at
// ══════════════════════════════════════════════════════════
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const msg = await emailService.getInboxMessage({
      id: req.params.id,
      userId: req.user_id,
    });
    res.json(msg);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("❌ Get message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/tick/:id
// ══════════════════════════════════════════════════════════
router.get("/tick/:id", verifyToken, async (req, res) => {
  try {
    const result = await emailService.getTick({
      id: req.params.id,
      userId: req.user_id,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("❌ Tick error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/attachment/:id
// ══════════════════════════════════════════════════════════
router.get("/attachment/:id", verifyToken, async (req, res) => {
  try {
    const { att, filePath } = await emailService.getAttachmentForDownload({
      attachmentId: req.params.id,
      userId: req.user_id,
    });

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(att.filename)}"`,
    );
    res.setHeader("Content-Type", att.mime_type);
    res.sendFile(filePath);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("❌ Attachment download error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/attachment-status/:mailId
// ══════════════════════════════════════════════════════════
router.get("/attachment-status/:mailId", verifyToken, async (req, res) => {
  try {
    const result = await emailService.getAttachmentStatus({
      mailId: req.params.mailId,
      userId: req.user_id,
    });
    res.json(result);
  } catch (err) {
    if (err.emptyPayload) return res.status(err.status).json(err.emptyPayload);
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("❌ Attachment status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/storage/me
// ══════════════════════════════════════════════════════════
router.get("/storage/me", verifyToken, async (req, res) => {
  try {
    const result = await emailService.getStorageInfo({ userId: req.user_id });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
    const result = await emailService.deleteMessage({
      id: req.params.id,
      userId: req.user_id,
      userFullname: req.user_fullname,
      mode,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("❌ Delete message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/users/search?q=
// ══════════════════════════════════════════════════════════
router.get("/users/search", verifyToken, async (req, res) => {
  try {
    const result = await emailService.searchUsers({
      q: req.query.q,
      userId: req.user_id,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("❌ User search error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
module.exports.cleanupOrphanedAttachments = emailService.cleanupOrphanedAttachments;