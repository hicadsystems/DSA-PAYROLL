// ============================================================================
// lib/pdfGate.js
//
// One gate for every PDF Chromium renders in this app, so a rush of staff
// printing payslips (200 or 1,000 at once) can never open more Chromium tabs
// than the server can hold. On the cPanel host (2 GB, 100 processes,
// 30 entry processes) each open tab is a Chromium process with its own memory.
//
//   active   at most PDF_MAX_CONCURRENT renders at a time (default 2)
//   high     staff payslips. At most PDF_MAX_WAITING may wait (each waiting
//            request holds a connection = an entry process), for at most
//            PDF_MAX_WAIT_MS. Beyond that: BusyError → HTTP 503 + Retry-After,
//            and the browser retries by itself after that many seconds.
//   low      admin reports and batches. Wait their turn, never refused.
//            High priority goes first, so a 40k-payslip batch does not
//            block staff printing their own payslip.
// ============================================================================

"use strict";

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const MAX_ACTIVE = int(process.env.PDF_MAX_CONCURRENT, 2);
const MAX_WAITING = int(process.env.PDF_MAX_WAITING, 12);
const MAX_WAIT_MS = int(process.env.PDF_MAX_WAIT_MS, 20000);

class BusyError extends Error {
  constructor(retryAfter) {
    super("Many people are downloading payslips right now. Your download will start again shortly.");
    this.code = "PDF_BUSY";
    this.status = 503;
    this.retryAfter = retryAfter; // seconds
  }
}

let active = 0;
const high = [];
const low = [];
let avgMs = 1500; // running average render time, for the Retry-After estimate
let served = 0;
let refused = 0;

/** Seconds until a request at this place in line is likely to get a slot (with jitter). */
function estimate(position) {
  const base = (position * avgMs) / MAX_ACTIVE / 1000;
  const jitter = 0.75 + Math.random() * 0.5; // spread the retries out
  return Math.min(120, Math.max(2, Math.ceil(base * jitter)));
}

function makeRelease() {
  const t0 = Date.now();
  let released = false;
  return (ok = true) => {
    if (released) return;
    released = true;
    active -= 1;
    served += 1;
    if (ok) avgMs = avgMs * 0.8 + (Date.now() - t0) * 0.2;
    dispatch();
  };
}

function dispatch() {
  while (active < MAX_ACTIVE) {
    const w = high.shift() || low.shift();
    if (!w) return;
    if (w.done) continue;
    w.done = true;
    if (w.timer) clearTimeout(w.timer);
    active += 1;
    w.resolve(makeRelease());
  }
}

/**
 * Wait for a render slot. Resolves to release(ok) — call it exactly once.
 * options: { priority: "high" | "low" }
 */
function acquire({ priority = "low" } = {}) {
  if (active < MAX_ACTIVE && !high.length && !low.length) {
    active += 1;
    return Promise.resolve(makeRelease());
  }
  if (priority === "high" && high.length >= MAX_WAITING) {
    refused += 1;
    return Promise.reject(new BusyError(estimate(high.length + active + 1)));
  }
  return new Promise((resolve, reject) => {
    const w = { resolve, done: false, timer: null };
    if (priority === "high") {
      high.push(w);
      w.timer = setTimeout(() => {
        if (w.done) return;
        w.done = true;
        const i = high.indexOf(w);
        if (i >= 0) high.splice(i, 1);
        refused += 1;
        reject(new BusyError(estimate(high.length + active)));
      }, MAX_WAIT_MS);
    } else {
      low.push(w);
    }
  });
}

/** Run fn() inside a slot. */
async function run(fn, options = {}) {
  const release = await acquire(options);
  let ok = false;
  try {
    const out = await fn();
    ok = true;
    return out;
  } finally {
    release(ok);
  }
}

function stats() {
  return {
    maxActive: MAX_ACTIVE,
    maxWaiting: MAX_WAITING,
    maxWaitMs: MAX_WAIT_MS,
    active,
    waitingHigh: high.length,
    waitingLow: low.length,
    avgRenderMs: Math.round(avgMs),
    served,
    refused,
  };
}

module.exports = { run, acquire, stats, BusyError, MAX_ACTIVE };
