// ============================================================================
// middware/asyncExport.js
//
// Keeps long PDF/Excel exports alive behind Cloudflare (≈125 s edge timeout).
//
// How it works
//   1. The browser shim (public/script/async-export.js) adds
//      `X-Async-Export: 1` to every same-origin fetch.
//   2. For export-looking requests (see isExportRequest), this middleware
//      replays the request to the app itself over loopback, where there is
//      no edge timeout, and writes the response to temp/async-exports/.
//   3. If the export finishes within ASYNC_EXPORT_INLINE_MS it is returned
//      on the original request, unchanged — same status, same headers.
//      If not, the client gets `202 { jobId }` + `X-Export-Job` and the shim
//      polls /async-jobs/:id, then fetches /async-jobs/:id/result.
//
// Controllers and report sections need no changes. Requests without the
// header (curl, scripts, old tabs) behave exactly as before.
// ============================================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const ENABLED = process.env.ASYNC_EXPORT_ENABLED !== "false";
// How long to hold the original request before switching to a job (ms).
// Keep well under Cloudflare's ~125 s proxy read timeout.
const INLINE_MS = parseInt(process.env.ASYNC_EXPORT_INLINE_MS) || 30000;
// Max exports rendering at the same time (Chromium is the heavy part).
const MAX_CONCURRENT = parseInt(process.env.ASYNC_EXPORT_MAX_CONCURRENT) || 3;
// Hard ceiling for one export.
const JOB_TIMEOUT_MS =
  parseInt(process.env.ASYNC_EXPORT_JOB_TIMEOUT_MS) || 30 * 60 * 1000;
// How long a finished result is kept for download.
const RESULT_TTL_MS =
  parseInt(process.env.ASYNC_EXPORT_TTL_MS) || 30 * 60 * 1000;

const EXPORT_DIR = path.join(__dirname, "..", "temp", "async-exports");
const INTERNAL_HEADER = "x-async-export-internal";
const INTERNAL_SECRET = crypto.randomBytes(32).toString("hex");
const JOBS_PREFIX = "/async-jobs";

// Path segments that mark a report/export endpoint
const EXPORT_WORDS = [
  "export",
  "pdf",
  "excel",
  "xlsx",
  "print",
  "generate",
  "payslip",
  "download",
  "backup",
];
const EXPORT_FORMATS = new Set(["pdf", "excel", "xlsx"]);

// Only these response headers are carried over to the stored result.
// (etag, CSP, set-cookie, vary, length, encoding… are deliberately dropped)
function pickResultHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const key = k.toLowerCase();
    if (key === "content-type" || key === "content-disposition") out[key] = v;
    else if (key.startsWith("x-") && key !== "x-powered-by") out[key] = v;
  }
  return out;
}

const jobs = new Map(); // id -> job
let warnedNoPort = false;
const queue = []; // pending starters
let running = 0;

// ── Setup ───────────────────────────────────────────────────────────────────

function prepareDir() {
  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    // Results from a previous process can never be claimed — clear them.
    for (const f of fs.readdirSync(EXPORT_DIR)) {
      try {
        fs.unlinkSync(path.join(EXPORT_DIR, f));
      } catch (_) {}
    }
  } catch (err) {
    console.error("❌ asyncExport: cannot prepare", EXPORT_DIR, err.message);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ownerKey(req) {
  return crypto
    .createHash("sha256")
    .update(req.get("authorization") || "")
    .digest("hex");
}

function hasJsonBody(req) {
  return Boolean(
    req.body &&
      typeof req.body === "object" &&
      (req.is("application/json") || req.is("application/*+json")),
  );
}

function hasOtherBody(req) {
  const len = parseInt(req.get("content-length") || "0");
  const chunked = !!req.get("transfer-encoding");
  return (len > 0 || chunked) && !hasJsonBody(req);
}

function isExportRequest(req) {
  const p = (req.path || "").toLowerCase();
  if (p.startsWith(JOBS_PREFIX)) return false;

  const segments = p.split("/").filter(Boolean);
  if (segments.some((s) => EXPORT_WORDS.some((w) => s.includes(w)))) {
    return true;
  }

  const qFormat = String(req.query?.format || "").toLowerCase();
  if (EXPORT_FORMATS.has(qFormat)) return true;

  const bFormat = String(req.body?.format || "").toLowerCase();
  if (EXPORT_FORMATS.has(bFormat)) return true;

  return false;
}

function loopbackHost(req) {
  const addr = req.socket.localAddress || "127.0.0.1";
  if (addr.startsWith("::ffff:")) return addr.slice(7);
  if (addr === "::" || addr === "0.0.0.0") return "127.0.0.1";
  return addr;
}

function publicStatus(job) {
  return {
    jobId: job.id,
    status: job.status, // queued | running | done | failed
    queuePosition:
      job.status === "queued" ? queue.findIndex((q) => q.job === job) + 1 : 0,
    elapsedMs: (job.finishedAt || Date.now()) - job.createdAt,
    error: job.status === "failed" ? job.error : undefined,
  };
}

function removeJob(job) {
  jobs.delete(job.id);
  if (job.file) {
    fs.unlink(job.file, () => {});
  }
}

// ── Queue ───────────────────────────────────────────────────────────────────

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const { job, start } = queue.shift();
    running++;
    job.status = "running";
    job.startedAt = Date.now();
    start()
      .catch((err) => finish(job, "failed", err.message))
      .finally(() => {
        running--;
        pump();
      });
  }
}

function finish(job, status, error) {
  if (job.status === "done" || job.status === "failed") return;
  job.status = status;
  job.error = error || null;
  job.finishedAt = Date.now();
  if (status === "failed") {
    console.error(`❌ asyncExport job ${job.id} failed: ${error}`);
    if (job.file) fs.unlink(job.file, () => {});
  } else {
    console.log(
      `✅ asyncExport job ${job.id} done in ${job.finishedAt - job.createdAt} ms (${job.method} ${job.url})`,
    );
  }
  job.resolveDone();
}

// ── Replay the request over loopback and capture the response ──────────────

function replay(job, req) {
  return new Promise((resolve) => {
    const isTls = !!req.socket.encrypted;
    const mod = isTls ? https : http;

    const headers = { ...req.headers };
    delete headers["x-async-export"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    delete headers["accept-encoding"];
    delete headers.connection;
    delete headers.expect;
    headers[INTERNAL_HEADER] = INTERNAL_SECRET;

    const clientIp = req.ip || req.socket.remoteAddress || "";
    headers["x-forwarded-for"] = headers["x-forwarded-for"]
      ? `${headers["x-forwarded-for"]}, ${clientIp}`
      : clientIp;

    let body = null;
    if (hasJsonBody(req)) {
      body = Buffer.from(JSON.stringify(req.body));
      headers["content-length"] = String(body.length);
    }

    const internal = mod.request(
      {
        host: loopbackHost(req),
        port: req.socket.localPort,
        method: req.method,
        path: req.originalUrl,
        headers,
        rejectUnauthorized: false, // self-signed cert on the LAN path
        timeout: JOB_TIMEOUT_MS,
      },
      (resp) => {
        job.statusCode = resp.statusCode;
        job.headers = pickResultHeaders(resp.headers);

        const out = fs.createWriteStream(job.file);
        resp.pipe(out);

        resp.on("aborted", () => {
          out.destroy();
          finish(job, "failed", "Export was interrupted");
          resolve();
        });
        out.on("error", (err) => {
          finish(job, "failed", `Could not store export: ${err.message}`);
          resolve();
        });
        out.on("close", () => {
          if (job.status === "failed") return resolve();
          try {
            job.size = fs.statSync(job.file).size;
          } catch (_) {
            job.size = 0;
          }
          finish(job, "done");
          resolve();
        });
      },
    );

    internal.on("timeout", () =>
      internal.destroy(new Error("Export took too long and was stopped")),
    );
    internal.on("error", (err) => {
      finish(job, "failed", err.message);
      resolve();
    });

    if (body) internal.write(body);
    internal.end();
  });
}

// ── Send a finished result ──────────────────────────────────────────────────

// Reads the whole result into memory and sends it with an exact
// Content-Length. The file is kept until RESULT_TTL_MS so the browser can
// retry the download if the connection drops mid-transfer.
function sendResult(job, res) {
  if (res.headersSent) return;

  fs.readFile(job.file, (err, buf) => {
    if (err) {
      console.error(`❌ asyncExport read ${job.id}:`, err.message);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: "Could not read the generated report. Please try again." });
      }
      return;
    }

    res.status(job.statusCode || 200);
    for (const [k, v] of Object.entries(job.headers || {})) {
      try {
        res.setHeader(k, v);
      } catch (_) {}
    }
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);

    job.downloads = (job.downloads || 0) + 1;
    job.lastDownloadAt = Date.now();
  });
}

// ── Middleware ──────────────────────────────────────────────────────────────

async function asyncExportMiddleware(req, res, next) {
  try {
    if (!ENABLED) return next();

    // Our own loopback replay → run the real handler.
    const internal = req.get(INTERNAL_HEADER);
    if (internal) {
      if (internal === INTERNAL_SECRET) return next();
      delete req.headers[INTERNAL_HEADER]; // spoofed — ignore it
    }

    if (req.get("x-async-export") !== "1") return next();
    if (req.method !== "GET" && req.method !== "POST") return next();

    // The replay calls back into this app on the port the request arrived on.
    // Under cPanel / Passenger the app listens on a Unix socket (no TCP port),
    // so a loopback call would land on the web server on port 80 instead
    // (404). Without a port to replay to, serve the request directly.
    if (!req.socket || !req.socket.localPort) {
      if (!warnedNoPort) {
        warnedNoPort = true;
        console.warn(
          "⚠️  [asyncExport] App is not on a TCP port (Passenger/Unix socket) — exports are served directly, without background jobs.",
        );
      }
      return next();
    }
    if (hasOtherBody(req)) return next(); // multipart / form / raw uploads
    if (!isExportRequest(req)) return next();

    const id = crypto.randomBytes(24).toString("hex");
    const job = {
      id,
      owner: ownerKey(req),
      method: req.method,
      url: req.originalUrl,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      file: path.join(EXPORT_DIR, `${id}.bin`),
      statusCode: null,
      headers: null,
      size: 0,
      error: null,
    };
    job.done = new Promise((r) => (job.resolveDone = r));
    jobs.set(id, job);

    queue.push({ job, start: () => replay(job, req) });
    pump();

    let timer;
    await Promise.race([
      job.done,
      new Promise((r) => (timer = setTimeout(r, INLINE_MS))),
    ]);
    clearTimeout(timer);

    if (job.status === "done") return sendResult(job, res);

    if (job.status === "failed") {
      removeJob(job);
      return res.status(502).json({ error: job.error || "Export failed" });
    }

    res.setHeader("X-Export-Job", id);
    res.setHeader("Cache-Control", "no-store");
    return res.status(202).json(publicStatus(job));
  } catch (err) {
    next(err);
  }
}

// ── Job endpoints ───────────────────────────────────────────────────────────

function findOwnedJob(req, res) {
  const job = jobs.get(req.params.id);
  if (!job || job.owner !== ownerKey(req)) {
    res.status(404).json({ error: "Export not found or expired" });
    return null;
  }
  return job;
}

function statusHandler(req, res) {
  const job = findOwnedJob(req, res);
  if (!job) return;
  res.setHeader("Cache-Control", "no-store");
  res.json(publicStatus(job));
}

// The result is served as neutral binary (no application/pdf, no
// Content-Disposition) so download managers / extensions don't hijack it,
// and in byte ranges so the browser pulls it in small chunks it can retry.
// The original status / type / filename travel in X-Export-* headers and
// the browser shim rebuilds the real Response from them.
function resultHandler(req, res) {
  const job = findOwnedJob(req, res);
  if (!job) return;
  if (job.status === "failed") {
    removeJob(job);
    return res.status(502).json({ error: job.error || "Export failed" });
  }
  if (job.status !== "done") {
    return res.status(409).json(publicStatus(job));
  }

  fs.readFile(job.file, (err, buf) => {
    if (err) {
      console.error(`❌ asyncExport read ${job.id}:`, err.message);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: "Could not read the generated report. Please try again." });
      }
      return;
    }

    const total = buf.length;
    const meta = job.headers || {};
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Export-Status", String(job.statusCode || 200));
    res.setHeader("X-Export-Size", String(total));
    if (meta["content-type"]) {
      res.setHeader("X-Export-Content-Type", meta["content-type"]);
    }
    if (meta["content-disposition"]) {
      res.setHeader("X-Export-Content-Disposition", meta["content-disposition"]);
    }

    const m = /^bytes=(\d+)-(\d*)$/.exec(req.get("range") || "");
    if (!m) {
      res.setHeader("Content-Length", String(total));
      return res.status(200).end(buf);
    }

    const start = parseInt(m[1], 10);
    const end = Math.min(m[2] ? parseInt(m[2], 10) : total - 1, total - 1);
    if (start >= total || start > end) {
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.status(416).end();
    }

    const slice = buf.subarray(start, end + 1);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", String(slice.length));
    res.status(206).end(slice);

    if (end === total - 1) {
      job.downloads = (job.downloads || 0) + 1;
      job.lastDownloadAt = Date.now();
    }
  });
}

// ── Housekeeping ────────────────────────────────────────────────────────────

function sweep() {
  const now = Date.now();
  for (const job of jobs.values()) {
    const finishedTooLongAgo =
      job.finishedAt && now - job.finishedAt > RESULT_TTL_MS;
    const stuck = !job.finishedAt && now - job.createdAt > JOB_TIMEOUT_MS * 2;
    if (finishedTooLongAgo || stuck) removeJob(job);
  }
}

// Snapshot for the ops app / health endpoints
function getStats() {
  const list = [...jobs.values()];
  return {
    enabled: ENABLED,
    running,
    queued: queue.length,
    maxConcurrent: MAX_CONCURRENT,
    inlineMs: INLINE_MS,
    jobs: list.map((j) => ({
      jobId: j.id.slice(0, 8),
      status: j.status,
      method: j.method,
      url: j.url,
      createdAt: j.createdAt,
      elapsedMs: (j.finishedAt || Date.now()) - j.createdAt,
      size: j.size,
      error: j.error,
    })),
  };
}

// ── Mount ───────────────────────────────────────────────────────────────────

function mount(app) {
  prepareDir();
  app.get(`${JOBS_PREFIX}/:id`, statusHandler);
  app.get(`${JOBS_PREFIX}/:id/result`, resultHandler);
  app.use(asyncExportMiddleware);
  setInterval(sweep, 5 * 60 * 1000).unref();
  console.log(
    `📦 Async exports ${ENABLED ? "ON" : "OFF"} — inline ${INLINE_MS} ms, max ${MAX_CONCURRENT} concurrent`,
  );
}

module.exports = { mount, getStats, isExportRequest };
