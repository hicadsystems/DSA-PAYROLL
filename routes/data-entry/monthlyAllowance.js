// Monthly Allowance Upload (DSA) — Data Input menu
// Mounted at /allowance (see routes/index.js)
const express = require("express");
const multer = require("multer");
const path = require("path");
const verifyToken = require("../../middware/authentication");
const service = require("../../services/data-entry/monthlyAllowance");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls"].includes(ext)) return cb(null, true);
    cb(new Error("Only .xlsx and .xls files are allowed"));
  },
});

const readOptions = (src = {}) => ({
  removeStale: src.removeStale,
  includeConflicts: src.includeConflicts,
  includeMismatches: src.includeMismatches,
});

const fail = (res, error, fallback) => {
  console.error(`❌ Monthly allowance: ${fallback}:`, error);
  return res.status(error.status || 500).json({
    success: false,
    error: error.status ? error.message : fallback,
    details: error.message,
  });
};

// 1. Upload + analyse the workbook (nothing is written to py_payded)
router.post("/preview", verifyToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
    const data = await service.createPreview(
      req.file.buffer,
      req.file.originalname,
      req.user_id,
      readOptions(req.body),
    );
    res.json({ success: true, ...data });
  } catch (error) {
    fail(res, error, "Could not read the workbook");
  }
});

// 2. Re-plan the same upload with different options
router.post("/preview/:id/plan", verifyToken, async (req, res) => {
  try {
    const plan = service.replan(req.params.id, req.user_id, readOptions(req.body));
    res.json({ success: true, previewId: req.params.id, plan });
  } catch (error) {
    fail(res, error, "Could not refresh the preview");
  }
});

// 3. Load into py_payded (T, tenor 1), create new staff / payment types
router.post("/commit", verifyToken, async (req, res) => {
  try {
    const { previewId } = req.body || {};
    if (!previewId) return res.status(400).json({ success: false, error: "previewId is required" });
    const result = await service.commit(
      previewId,
      req.user_id,
      req.user_fullname || "SYSTEM",
      readOptions(req.body),
    );
    res.json({ success: true, result });
  } catch (error) {
    fail(res, error, "Upload failed — nothing was changed");
  }
});

// Upload history
router.get("/history", verifyToken, async (req, res) => {
  try {
    res.json({ success: true, data: await service.history(req.query.limit) });
  } catch (error) {
    fail(res, error, "Could not load upload history");
  }
});

// Undo the most recent upload
router.post("/undo", verifyToken, async (req, res) => {
  try {
    const { batchName } = req.body || {};
    if (!batchName) return res.status(400).json({ success: false, error: "batchName is required" });
    const result = await service.undo(batchName, req.user_fullname || "SYSTEM");
    res.json({ success: true, result });
  } catch (error) {
    fail(res, error, "Undo failed — nothing was changed");
  }
});

// Sheet -> payment type mapping
router.get("/sheet-map", verifyToken, async (req, res) => {
  try {
    res.json({ success: true, data: await service.listSheetMap() });
  } catch (error) {
    fail(res, error, "Could not load sheet mapping");
  }
});

router.put("/sheet-map/:id", verifyToken, async (req, res) => {
  try {
    const { paytype, skip } = req.body || {};
    const data = await service.updateSheetMap(Number(req.params.id), { paytype, skip });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, "Could not update sheet mapping");
  }
});

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const msg = error.code === "LIMIT_FILE_SIZE" ? "File is larger than 15MB" : error.message;
    return res.status(400).json({ success: false, error: msg });
  }
  if (error) return res.status(400).json({ success: false, error: error.message });
  next();
});

module.exports = router;
