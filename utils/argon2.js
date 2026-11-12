"use strict";

/**
 * utils/argon2.js
 * -----------------------------------------------------------------------------
 * argon2id hashing without a native module.
 *
 * The `argon2` npm package ships a native binary that needs glibc 2.34+, which
 * the cPanel host doesn't have (ERR_DLOPEN_FAILED). hash-wasm runs argon2 in
 * WebAssembly, so it works on any Linux/Windows/Node 18+ with no compiler.
 *
 * Same API shape as the `argon2` package for what this app uses:
 *   hash(password)          -> "$argon2id$v=19$m=…,t=…,p=…$salt$hash"
 *   verify(encoded, password) -> boolean
 * Hashes are standard PHC strings, interchangeable with the native package.
 */

const crypto = require("crypto");
const { argon2id, argon2Verify } = require("hash-wasm");

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// OWASP argon2id baseline (19 MiB, 2 passes, 1 lane): safe on a small shared
// host. Tunable via env; existing hashes always verify with their own params.
const MEMORY_KIB = int(process.env.ARGON2_MEMORY_KIB, 19456);
const ITERATIONS = int(process.env.ARGON2_ITERATIONS, 2);
const PARALLELISM = int(process.env.ARGON2_PARALLELISM, 1);
const HASH_LENGTH = 32;
const SALT_LENGTH = 16;

async function hash(password) {
  return argon2id({
    password: String(password),
    salt: crypto.randomBytes(SALT_LENGTH),
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_KIB,
    hashLength: HASH_LENGTH,
    outputType: "encoded",
  });
}

async function verify(encoded, password) {
  if (typeof encoded !== "string" || !encoded.startsWith("$argon2")) return false;
  try {
    return await argon2Verify({ password: String(password), hash: encoded });
  } catch (_) {
    return false;
  }
}

module.exports = { hash, verify };
