"use strict";

/**
 * utils/legacyPassword.js
 * -----------------------------------------------------------------------------
 * Password format detection + verification for the migration from the old
 * ASP.NET (C#) PersonnelLogin system into DSA-PAYROLL.
 *
 * When personnel rows are migrated in, `hr_employees.password` may hold ANY of:
 *   - argon2   : "$argon2id$..."          -> already migrated (native verify)
 *   - identity : ASP.NET Core PBKDF2 blob  -> legacy, verify + rehash to argon2
 *   - md5      : 32 hex chars              -> legacy, verify + rehash to argon2
 *   - plaintext: anything else            -> untrusted, force first-time change
 *
 * Policy (see /auth/pre-login):
 *   - Any HASH form  -> verify against it. If a legacy hash verifies, rehash the
 *                       plaintext the user just typed into argon2 and persist it.
 *   - PLAINTEXT      -> do NOT log in on it. Force the first-time password flow.
 */

const crypto = require("crypto");
const argon2 = require("argon2");

/** @returns {'argon2'|'identity'|'md5'|'plaintext'|'unknown'} */
function detectFormat(stored) {
  if (typeof stored !== "string" || stored.length === 0) return "unknown";

  // argon2 encoded hash, e.g. "$argon2id$v=19$m=...,t=...,p=...$salt$hash"
  if (stored.startsWith("$argon2")) return "argon2";

  // ASP.NET Core Identity hashes are base64 blobs whose first decoded byte is
  // 0x00 (v2, PBKDF2-HMAC-SHA1) or 0x01 (v3, PBKDF2-HMAC-SHA256).
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(stored) && stored.length >= 44) {
    try {
      const marker = Buffer.from(stored, "base64").readUInt8(0);
      if (marker === 0x00 || marker === 0x01) return "identity";
    } catch (_) {
      /* fall through */
    }
  }

  // 32 hex chars = MD5 digest.
  if (/^[0-9a-fA-F]{32}$/.test(stored)) return "md5";

  // Anything else = plaintext (old system compared raw strings).
  return "plaintext";
}

/** True if the stored value is any recognised hash (i.e. NOT plaintext). */
function isHashed(stored) {
  const f = detectFormat(stored);
  return f === "argon2" || f === "identity" || f === "md5";
}

// --- individual verifiers ---------------------------------------------------

// Unsalted MD5, hex, case-insensitive (mirrors old C# VerifyMd5Hash).
function verifyMd5(password, storedHex) {
  const digest = crypto.createHash("md5").update(password, "utf8").digest("hex");
  const a = Buffer.from(digest.toLowerCase());
  const b = Buffer.from(String(storedHex).toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PRF = { 0: "sha1", 1: "sha256", 2: "sha512" };

// ASP.NET Core Identity PBKDF2 (v2 marker 0x00 / v3 marker 0x01).
function verifyIdentity(password, storedB64) {
  let buf;
  try {
    buf = Buffer.from(storedB64, "base64");
  } catch (_) {
    return false;
  }
  if (buf.length < 1) return false;
  const marker = buf.readUInt8(0);
  const pwd = Buffer.from(password, "utf8");

  if (marker === 0x00) {
    const salt = buf.subarray(1, 17);
    const subkey = buf.subarray(17);
    if (subkey.length === 0) return false;
    const test = crypto.pbkdf2Sync(pwd, salt, 1000, subkey.length, "sha1");
    return subkey.length === test.length && crypto.timingSafeEqual(subkey, test);
  }

  if (marker === 0x01) {
    const prf = PRF[buf.readUInt32BE(1)];
    const iter = buf.readUInt32BE(5);
    const saltLen = buf.readUInt32BE(9);
    if (!prf || saltLen <= 0 || 13 + saltLen >= buf.length) return false;
    const salt = buf.subarray(13, 13 + saltLen);
    const subkey = buf.subarray(13 + saltLen);
    const test = crypto.pbkdf2Sync(pwd, salt, iter, subkey.length, prf);
    return subkey.length === test.length && crypto.timingSafeEqual(subkey, test);
  }
  return false;
}

/** Hash a password with argon2id (default params match the rest of the app). */
async function hashPassword(password) {
  return argon2.hash(password);
}

/**
 * DEBUG: recompute what the stored technique WOULD produce for `password`,
 * reusing the salt/params embedded in `stored` so the output is directly
 * comparable to `stored`. Returns { computed, comparable, matches }.
 *
 *   - md5      : unsalted, fully reproducible -> compare strings directly.
 *   - identity : reuse marker/prf/iter/salt from stored -> rebuild same blob.
 *   - argon2   : salt lives inside stored; argon2.verify is the real check,
 *                so we return the verify result rather than a rebuilt string.
 */
async function recomputeLikeStored(password, stored) {
  const format = detectFormat(stored);

  if (format === "md5") {
    const computed = crypto
      .createHash("md5")
      .update(password, "utf8")
      .digest("hex");
    return {
      format,
      computed,
      comparable: true,
      matches: computed.toLowerCase() === String(stored).toLowerCase(),
    };
  }

  if (format === "identity") {
    const buf = Buffer.from(stored, "base64");
    const marker = buf.readUInt8(0);
    const pwd = Buffer.from(password, "utf8");
    let computed = null;
    if (marker === 0x00) {
      const salt = buf.subarray(1, 17);
      const subkeyLen = buf.length - 17;
      const subkey = crypto.pbkdf2Sync(pwd, salt, 1000, subkeyLen, "sha1");
      computed = Buffer.concat([Buffer.from([0x00]), salt, subkey]).toString(
        "base64",
      );
    } else if (marker === 0x01) {
      const prf = PRF[buf.readUInt32BE(1)];
      const iter = buf.readUInt32BE(5);
      const saltLen = buf.readUInt32BE(9);
      const salt = buf.subarray(13, 13 + saltLen);
      const subkeyLen = buf.length - 13 - saltLen;
      const subkey = crypto.pbkdf2Sync(pwd, salt, iter, subkeyLen, prf);
      computed = Buffer.concat([buf.subarray(0, 13 + saltLen), subkey]).toString(
        "base64",
      );
    }
    return {
      format,
      computed,
      comparable: true,
      matches: computed === stored,
    };
  }

  if (format === "argon2") {
    const matches = await argon2.verify(stored, password).catch(() => false);
    return {
      format,
      computed: "(argon2 salt is internal — verified via argon2.verify)",
      comparable: false,
      matches,
    };
  }

  // plaintext / unknown
  return {
    format,
    computed: password,
    comparable: true,
    matches: password === stored,
  };
}

/**
 * Verify `password` against a HASHED `stored` value (argon2/identity/md5).
 * Do NOT call this for plaintext rows — those must go through first-time change.
 *
 * @returns {Promise<{ok: boolean, format: string, needsRehash: boolean}>}
 *   needsRehash is true when a legacy hash verified and should be upgraded.
 */
async function verifyHashed(password, stored) {
  const format = detectFormat(stored);
  let ok = false;
  switch (format) {
    case "argon2":
      ok = await argon2.verify(stored, password).catch(() => false);
      break;
    case "identity":
      ok = verifyIdentity(password, stored);
      break;
    case "md5":
      ok = verifyMd5(password, stored);
      break;
    default:
      ok = false; // plaintext/unknown never authenticate here
  }
  return { ok, format, needsRehash: ok && format !== "argon2" };
}

module.exports = {
  detectFormat,
  isHashed,
  hashPassword,
  verifyHashed,
  recomputeLikeStored,
  // exported for tests
  _verifyMd5: verifyMd5,
  _verifyIdentity: verifyIdentity,
};
