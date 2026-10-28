const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
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

const UPLOADS_ROOT = path.join(__dirname, "../../uploads/mail");

// ── Upload directory (dated folders) ─────────────────────
function getUploadDir() {
  const now = new Date();
  const dir = path.join(
    UPLOADS_ROOT,
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

module.exports = {
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS,
  MAX_RECIPIENTS,
  DEFAULT_QUOTA,
  RETENTION_DAYS,
  ALLOWED_MIME_TYPES,
  UPLOADS_ROOT,
  getUploadDir,
  upload,
  hashFile,
  fmtBytes,
};
