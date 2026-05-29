/**
 * FILE: router/user-dashboard/emolument/documents/documents.service.js
 *
 * Business logic for document/photo management.
 *
 * Upload flow:
 *   1. Frontend sends file as base64 or multipart to POST /documents/upload
 *   2. Service uploads to Cloudinary via v2 SDK
 *   3. On success, upsert URL + cloudinary_id into ef_documents
 *   4. Return URL to frontend
 *
 * Delete flow:
 *   1. Fetch existing cloudinary_id from ef_documents
 *   2. Delete from Cloudinary
 *   3. Delete DB record
 *
 * Cloudinary config comes from environment:
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *
 * Upload folder structure on Cloudinary:
 *   emolument/{doc_type}/{serviceNumber}
 *   e.g. emolument/PASSPORT/N00001
 *
 * Personnel can only upload their own documents.
 * EMOL_ADMIN can upload for any service number.
 */

"use strict";

const cloudinary = require("cloudinary").v2;
const repo = require("./documents.repository");
const { VALID_DOC_TYPES } = require("../emolument.constants");

// ─────────────────────────────────────────────────────────────
// CLOUDINARY CONFIG
// Configured once at module load — throws early if missing.
// ─────────────────────────────────────────────────────────────

if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  console.warn("⚠️  Cloudinary env vars not set — document upload will fail.");
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function buildPublicId(serviceNo, docType) {
  // Cloudinary public_id — no extension, lowercase, underscores
  const safeService = serviceNo.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  const safeType = docType.toLowerCase();
  return `emolument/${safeType}/${safeService}`;
}

function validateDocType(docType) {
  if (!VALID_DOC_TYPES.includes(docType)) {
    return {
      valid: false,
      message: `doc_type must be one of: ${VALID_DOC_TYPES.join(", ")}.`,
    };
  }
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// GET DOCUMENTS — fetch all docs for own service number
// ─────────────────────────────────────────────────────────────

async function getMyDocuments(serviceNo) {
  const rows = await repo.getDocuments(serviceNo);

  // Structure as { PASSPORT: {...}, NOK_PASSPORT: {...}, ALT_NOK_PASSPORT: {...} }
  const out = {};
  VALID_DOC_TYPES.forEach((t) => {
    out[t] = null;
  });
  rows.forEach((r) => {
    out[r.doc_type] = r;
  });

  return { success: true, data: out };
}

// ─────────────────────────────────────────────────────────────
// UPLOAD — upload a document to Cloudinary and save URL to DB
//
// targetServiceNo: the personnel whose document this is
//   - must equal performedBy unless performer is EMOL_ADMIN
//
// fileData: base64 string or file path (depends on multer setup)
// docType:  one of VALID_DOC_TYPES
// ─────────────────────────────────────────────────────────────

async function uploadDocument(
  targetServiceNo,
  docType,
  fileData,
  performedBy,
  isAdmin,
  ip,
) {
  // Scope check — personnel can only upload their own documents
  if (!isAdmin && targetServiceNo !== performedBy) {
    return {
      success: false,
      code: 403,
      message: "You can only upload your own documents.",
    };
  }

  const typeCheck = validateDocType(docType);
  if (!typeCheck.valid) {
    return { success: false, code: 400, message: typeCheck.message };
  }

  if (!fileData) {
    return { success: false, code: 400, message: "No file data provided." };
  }

  // Fetch existing cloudinary_id so we can overwrite it on Cloudinary
  // (overwriting uses the same public_id — avoids orphaned files)
  const publicId = buildPublicId(targetServiceNo, docType);

  let uploadResult;
  try {
    uploadResult = await cloudinary.uploader.upload(fileData, {
      public_id: publicId,
      overwrite: true,
      resource_type: "image",
      folder: "", // public_id already contains path
      transformation: [
        { width: 600, height: 800, crop: "limit" },
        { quality: "auto", fetch_format: "auto" },
      ],
    });
  } catch (err) {
    console.error("❌ Cloudinary upload error:", err.message);
    return {
      success: false,
      code: 502,
      message: `Cloudinary upload failed: ${err.message}`,
    };
  }

  // Save to DB
  const saved = await repo.upsertDocument(
    targetServiceNo,
    docType,
    uploadResult.secure_url,
    uploadResult.public_id,
    performedBy,
  );

  if (!saved) {
    // Upload succeeded but DB write failed — log and return partial success
    console.error(
      `⚠️  Cloudinary upload succeeded but DB write failed for ${targetServiceNo}:${docType}`,
    );
    return {
      success: false,
      code: 500,
      message:
        "File uploaded to Cloudinary but database record could not be saved. Contact administrator.",
    };
  }

  await repo.insertAuditLog({
    tableName: "ef_documents",
    action: "INSERT",
    recordKey: `${targetServiceNo}:${docType}`,
    oldValues: null,
    newValues: {
      url: uploadResult.secure_url,
      cloudinary_id: uploadResult.public_id,
    },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Document uploaded successfully.`,
    data: {
      serviceNo: targetServiceNo,
      docType,
      url: uploadResult.secure_url,
      cloudinaryId: uploadResult.public_id,
      width: uploadResult.width,
      height: uploadResult.height,
      format: uploadResult.format,
      bytes: uploadResult.bytes,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// DELETE — delete from Cloudinary then remove DB record
// ─────────────────────────────────────────────────────────────

async function deleteDocument(
  targetServiceNo,
  docType,
  performedBy,
  isAdmin,
  ip,
) {
  if (!isAdmin && targetServiceNo !== performedBy) {
    return {
      success: false,
      code: 403,
      message: "You can only delete your own documents.",
    };
  }

  const typeCheck = validateDocType(docType);
  if (!typeCheck.valid) {
    return { success: false, code: 400, message: typeCheck.message };
  }

  const existing = await repo.getDocument(targetServiceNo, docType);
  if (!existing) {
    return { success: false, code: 404, message: "Document not found." };
  }

  // Delete from Cloudinary first
  try {
    await cloudinary.uploader.destroy(existing.cloudinary_id, {
      resource_type: "image",
    });
  } catch (err) {
    console.error("❌ Cloudinary delete error:", err.message);
    // Continue to DB cleanup even if Cloudinary delete fails —
    // the public_id can be manually cleaned up in Cloudinary console.
  }

  // Remove DB record
  const removed = await repo.deleteDocument(targetServiceNo, docType);

  await repo.insertAuditLog({
    tableName: "ef_documents",
    action: "DELETE",
    recordKey: `${targetServiceNo}:${docType}`,
    oldValues: { url: existing.url, cloudinary_id: existing.cloudinary_id },
    newValues: null,
    performedBy,
    ipAddress: ip,
  });

  return {
    success: removed,
    message: removed
      ? "Document deleted successfully."
      : "Document could not be deleted from database.",
    data: { serviceNo: targetServiceNo, docType },
  };
}

// ─────────────────────────────────────────────────────────────
// ADMIN — get all documents for a ship
// ─────────────────────────────────────────────────────────────

async function getShipDocuments(ship) {
  if (!ship)
    return { success: false, code: 400, message: "Ship name is required." };

  const rows = await repo.getDocumentsByShip(ship);

  // Group by service number
  const byPerson = {};
  for (const row of rows) {
    if (!byPerson[row.service_no]) {
      byPerson[row.service_no] = {
        serviceNo: row.service_no,
        surname: row.Surname,
        otherName: row.OtherName,
        rank: row.Rank,
        documents: {},
      };
    }
    byPerson[row.service_no].documents[row.doc_type] = {
      url: row.url,
      cloudinaryId: row.cloudinary_id,
      uploadedAt: row.uploaded_at,
    };
  }

  return {
    success: true,
    data: Object.values(byPerson),
  };
}

// ─────────────────────────────────────────────────────────────
// ADMIN — find personnel missing a specific document type
// ─────────────────────────────────────────────────────────────

async function getMissingDocuments(ship, docType) {
  if (!ship)
    return { success: false, code: 400, message: "Ship name is required." };

  const typeCheck = validateDocType(docType);
  if (!typeCheck.valid)
    return { success: false, code: 400, message: typeCheck.message };

  const rows = await repo.getMissingDocuments(ship, docType);
  return {
    success: true,
    data: {
      ship,
      docType,
      missing: rows,
      count: rows.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// SIGN URL — generate a short-lived signed Cloudinary URL
// Use for secure document viewing without exposing raw URLs.
// ─────────────────────────────────────────────────────────────

async function getSignedUrl(targetServiceNo, docType, performedBy, isAdmin) {
  if (!isAdmin && targetServiceNo !== performedBy) {
    return { success: false, code: 403, message: "Access denied." };
  }

  const typeCheck = validateDocType(docType);
  if (!typeCheck.valid)
    return { success: false, code: 400, message: typeCheck.message };

  const existing = await repo.getDocument(targetServiceNo, docType);
  if (!existing)
    return { success: false, code: 404, message: "Document not found." };

  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  try {
    const signedUrl = cloudinary.url(existing.cloudinary_id, {
      sign_url: true,
      expires_at: expiresAt,
      resource_type: "image",
      secure: true,
    });

    return {
      success: true,
      data: {
        url: signedUrl,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        docType,
      },
    };
  } catch (err) {
    console.error("❌ Cloudinary sign URL error:", err.message);
    return {
      success: false,
      code: 500,
      message: "Could not generate signed URL.",
    };
  }
}

module.exports = {
  getMyDocuments,
  uploadDocument,
  deleteDocument,
  getShipDocuments,
  getMissingDocuments,
  getSignedUrl,
};
