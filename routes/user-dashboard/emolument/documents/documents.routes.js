/**
 * FILE: router/user-dashboard/emolument/documents/documents.routes.js
 *
 * Routes for document/photo management.
 *
 * Uses multer for multipart file handling.
 * Files are streamed directly to Cloudinary — not stored on disk.
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  Personnel (own documents only):
 *  GET    /documents/my                        → get own documents
 *  POST   /documents/upload/:doc_type          → upload own document
 *  DELETE /documents/:doc_type                 → delete own document
 *  GET    /documents/view/:doc_type            → get signed URL for own doc
 *
 *  Officers (ship-scoped):
 *  GET    /documents/ship/:ship                → all docs for a ship
 *  GET    /documents/ship/:ship/missing/:type  → who is missing a doc type
 *
 *  Admin (any service number):
 *  POST   /documents/admin/:svcno/upload/:doc_type → upload for any personnel
 *  DELETE /documents/admin/:svcno/:doc_type        → delete for any personnel
 *  GET    /documents/admin/:svcno/view/:doc_type   → signed URL for any person
 *
 * File upload shape (multipart/form-data):
 *   field name: 'document'
 *   accepted:   image/jpeg, image/png, image/webp
 *   max size:   5MB
 */

"use strict";

const express = require("express");
const router = express.Router();
const multer = require("multer");
const pool = require("../../../../config/db");
const config = require("../../../../config");
const verifyToken = require("../../../../middware/authentication");
const {
  requirePersonnel,
  requireEmolRole,
  requireShipAccess,
} = require("../../../../middware/emolumentAuth");
const documentsService = require("./documents.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for all routes in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All routes require authentication
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────
// MULTER — memory storage, stream to Cloudinary as base64
// ─────────────────────────────────────────────────────────────

const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE_MB = 5;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ACCEPTED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Accepted: ${ACCEPTED_MIME.join(", ")}`));
    }
  },
});

// Convert multer buffer → base64 data URI for Cloudinary upload
function toBase64DataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

// Multer error handler — catches size + type errors
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(413)
        .json({ error: `File too large. Maximum size is ${MAX_SIZE_MB}MB.` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
}

// ─────────────────────────────────────────────────────────────
// PERSONNEL ROUTES — own documents only
// ─────────────────────────────────────────────────────────────

// GET /documents/my
router.get("/my", requirePersonnel, async (req, res) => {
  try {
    const result = await documentsService.getMyDocuments(req.user_id);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /documents/my:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /documents/upload/:doc_type
// Field: 'document' (multipart file)
router.post(
  "/upload/:doc_type",
  requirePersonnel,
  upload.single("document"),
  handleMulterError,
  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'No file uploaded. Use field name "document".' });
    }
    const { doc_type } = req.params;
    const fileData = toBase64DataUri(req.file);

    try {
      const result = await documentsService.uploadDocument(
        req.user_id, // target = self
        doc_type,
        fileData,
        req.user_id,
        false, // isAdmin = false
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res
        .status(201)
        .json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /documents/upload/:doc_type:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// DELETE /documents/:doc_type
router.delete("/:doc_type", requirePersonnel, async (req, res) => {
  const { doc_type } = req.params;
  try {
    const result = await documentsService.deleteDocument(
      req.user_id,
      doc_type,
      req.user_id,
      false,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message });
  } catch (err) {
    console.error("❌ DELETE /documents/:doc_type:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /documents/view/:doc_type
// Returns a signed Cloudinary URL valid for 1 hour
router.get("/view/:doc_type", requirePersonnel, async (req, res) => {
  const { doc_type } = req.params;
  try {
    const result = await documentsService.getSignedUrl(
      req.user_id,
      doc_type,
      req.user_id,
      false,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /documents/view/:doc_type:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// OFFICER ROUTES — ship-scoped
// ─────────────────────────────────────────────────────────────

// GET /documents/ship/:ship
// All docs for a ship. DO/FO for their ship, EMOL_ADMIN all.
router.get("/ship/:ship", requireShipAccess, async (req, res) => {
  const { ship } = req.params;
  try {
    const result = await documentsService.getShipDocuments(ship);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /documents/ship/:ship:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /documents/ship/:ship/missing/:doc_type
// Find personnel missing a specific document type on a ship.
router.get(
  "/ship/:ship/missing/:doc_type",
  requireShipAccess,
  async (req, res) => {
    const { ship, doc_type } = req.params;
    try {
      const result = await documentsService.getMissingDocuments(ship, doc_type);
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json(result.data);
    } catch (err) {
      console.error("❌ GET /documents/ship/:ship/missing/:doc_type:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES — any service number
// All require EMOL_ADMIN role.
// ─────────────────────────────────────────────────────────────

// POST /documents/admin/:svcno/upload/:doc_type
router.post(
  "/admin/:svcno/upload/:doc_type",
  requireEmolRole("EMOL_ADMIN"),
  upload.single("document"),
  handleMulterError,
  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'No file uploaded. Use field name "document".' });
    }
    const { svcno, doc_type } = req.params;
    const fileData = toBase64DataUri(req.file);

    try {
      const result = await documentsService.uploadDocument(
        svcno,
        doc_type,
        fileData,
        req.user_id,
        true, // isAdmin = true
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res
        .status(201)
        .json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /documents/admin/:svcno/upload/:doc_type:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// DELETE /documents/admin/:svcno/:doc_type
router.delete(
  "/admin/:svcno/:doc_type",
  requireEmolRole("EMOL_ADMIN"),
  async (req, res) => {
    const { svcno, doc_type } = req.params;
    try {
      const result = await documentsService.deleteDocument(
        svcno,
        doc_type,
        req.user_id,
        true,
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message });
    } catch (err) {
      console.error("❌ DELETE /documents/admin/:svcno/:doc_type:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// GET /documents/admin/:svcno/view/:doc_type
router.get(
  "/admin/:svcno/view/:doc_type",
  requireEmolRole("EMOL_ADMIN"),
  async (req, res) => {
    const { svcno, doc_type } = req.params;
    try {
      const result = await documentsService.getSignedUrl(
        svcno,
        doc_type,
        req.user_id,
        true,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json(result.data);
    } catch (err) {
      console.error("❌ GET /documents/admin/:svcno/view/:doc_type:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

module.exports = router;