/**
 * FILE: routes/user-dashboard/emolument/reports/reports.cache.js
 *
 * Single node-cache instance for emolument report data.
 * Shared across reports.service.js and reports.controller.js.
 *
 * TTLs:
 *   dashboard   — 60s.  Global aggregate counts. Fast to feel live,
 *                       cheap to recompute after any bulk operation.
 *   progress    — 120s. Per-ship breakdown. Changes less frequently
 *                       than dashboard counts; heavier query.
 *   ship        — 60s.  Per-ship detail. Keyed by ship name.
 *   command     — 60s.  Per-command detail. Keyed by command code.
 *
 * Cache-bust:
 *   invalidateAll()   — clears everything (post-bulk-approve, post-confirm)
 *   invalidate(key)   — clears one specific key
 *
 * Usage:
 *   const cache = require('./reports.cache');
 *   const hit = cache.get('dashboard');
 *   if (hit) return hit;
 *   const data = await expensiveQuery();
 *   cache.set('dashboard', data);
 *   return data;
 */

"use strict";

const NodeCache = require("node-cache");

// stdTTL: 0 = no default TTL — we set TTL explicitly on every .set() call
// checkperiod: 30s — expired keys are evicted every 30 seconds
// useClones: false — we never mutate cached objects so skip the clone overhead
const _cache = new NodeCache({ stdTTL: 0, checkperiod: 30, useClones: false });

const TTL = {
  DASHBOARD: 60,   // seconds
  PROGRESS:  120,
  SHIP:      60,
  COMMAND:   60,
};

const KEY = {
  DASHBOARD: "emol:dashboard",
  PROGRESS:  "emol:progress",
  ship:(name)    => `emol:ship:${name}`,
  command: (code) => `emol:command:${code}`,
};

function get(key) {
  const value = _cache.get(key);
  return value === undefined ? null : value;
}

function set(key, value, ttl) {
  _cache.set(key, value, ttl);
}

function invalidate(key) {
  _cache.del(key);
}

function invalidateAll() {
  _cache.flushAll();
}

// Returns { keys, stats } — useful for a /cache-status admin endpoint
function status() {
  return {
    keys:  _cache.keys(),
    stats: _cache.getStats(),
  };
}

module.exports = { get, set, invalidate, invalidateAll, status, KEY, TTL };