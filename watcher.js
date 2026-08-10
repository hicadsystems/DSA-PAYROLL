/**
 * DSA Payroll - File Watcher
 * Watches project files and restarts DsaPayroll-App service on changes.
 * Run as: node watcher.js
 * Or add as a third WinSW service via install-service.js
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const WINSW = path.join(ROOT, "DsaPayroll-App.exe");
const DELAY = 2000;

// Only these extensions should trigger a restart
// Frontend files (html, css, png, etc.) are served statically — no restart needed
const RESTART_EXT = new Set([".js", ".json", ".env", ".cjs", ".mjs"]);

// These specific files should never trigger a restart even if .js
const IGNORE_FILES = new Set([
  "watcher.js",
  "install-service.js",
  "uninstall-service.js",
  "install-runner.js",
]);

// These directories should never trigger a restart
const IGNORE_DIRS = new Set([
  "node_modules",
  "logs",
  "preferences",
  "notifications",
  "certs",
  "cloud_backups",
  "cache",
  ".vs",
  ".vscode",
  "backups",
  "restores",
  "uploads",
  "storage",
  "query",
  "data",
  "temp",
  ".git",
  "actions-runner",
  "_work",
  "bin",
  "public", // static files — never need a restart
]);

const IGNORE_PREFIXES = ["DsaPayroll-", "winsw", "actions-runner"];

const lastModified = new Map();
let restartTimer = null;
let restarting = false;

function shouldIgnore(filePath) {
  const basename = path.basename(filePath);

  // Ignore specific files
  if (IGNORE_FILES.has(basename)) return true;

  // Ignore by directory
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) return true;
    for (const prefix of IGNORE_PREFIXES) {
      if (part.startsWith(prefix)) return true;
    }
  }

  // Only allow restart-worthy extensions
  const ext = path.extname(filePath).toLowerCase();
  if (!RESTART_EXT.has(ext)) return true;

  return false;
}

function restartService() {
  if (restarting) return;
  restarting = true;

  console.log(
    `[${new Date().toISOString()}] File change detected — restarting DsaPayroll-App...`,
  );

  try {
    execSync(`"${WINSW}" restart`, { cwd: ROOT, encoding: "utf8" });
    console.log(`[${new Date().toISOString()}] DsaPayroll-App restarted ✔`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Restart failed:`, e.message);
  }

  restarting = false;
}

function onFileChange(eventType, filename) {
  if (!filename) return;
  const fullPath = path.join(ROOT, filename);
  if (shouldIgnore(fullPath)) return;

  // Verify mtime actually changed
  try {
    const stat = fs.statSync(fullPath);
    const prev = lastModified.get(fullPath);
    const curr = stat.mtimeMs;
    if (prev === curr) return;
    lastModified.set(fullPath, curr);
  } catch {
    return;
  }

  console.log(`[${new Date().toISOString()}] Changed: ${filename}`);

  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(restartService, DELAY);
}

console.log("DSA Payroll — File Watcher");
console.log("===========================");
console.log(`Watching: ${ROOT}`);
console.log(`Restart delay: ${DELAY}ms`);
console.log("Restarting on: .js .json .env changes (backend only)");
console.log(
  "Ignoring: public/, node_modules/, logs/, .git, and all frontend files",
);
console.log("");

fs.watch(ROOT, { recursive: true }, onFileChange);

console.log("Watching for file changes... (Ctrl+C to stop)");
