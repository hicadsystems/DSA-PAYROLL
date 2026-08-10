/**
 * DSA Payroll - GitHub Actions Runner Installer
 * Reassembles chunked runner zip and installs as Windows Service
 * Run as Administrator: node install-runner.js
 */

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = __dirname;
const BIN = path.join(ROOT, "bin");
const RUNNER_DIR = path.join(ROOT, "actions-runner");
const CHUNKS_DIR = path.join(BIN, "runner");
const RUNNER_ZIP = path.join(ROOT, "actions-runner.zip");
const CONFIG_CMD = path.join(RUNNER_DIR, "config.cmd");

// Load env
require("dotenv").config({ path: path.join(ROOT, ".env.local") });

const GITHUB_PAT = process.env.GITHUB_PAT;
const GITHUB_RUNNER_TOKEN = process.env.GITHUB_RUNNER_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || "hicadsystems/DSA-PAYROLL";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

function run(cmd, opts = {}) {
  try {
    execSync(cmd, {
      cwd: opts.cwd || ROOT,
      stdio: opts.silent ? "pipe" : "inherit",
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

function runOut(cmd, cwd = ROOT) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ── Reassemble chunks into zip ─────────────────────────────
function reassembleChunks() {
  if (fs.existsSync(RUNNER_ZIP)) {
    console.log("[Runner] Zip already exists — skipping reassembly.");
    return true;
  }

  if (!fs.existsSync(CHUNKS_DIR)) {
    console.error("[Runner] No chunks found at bin/runner/");
    console.error("         Run chunk-runner.ps1 on your dev machine first.");
    return false;
  }

  const chunks = fs
    .readdirSync(CHUNKS_DIR)
    .filter((f) => f.startsWith("runner.part"))
    .sort((a, b) => {
      const numA = parseInt(a.replace("runner.part", ""));
      const numB = parseInt(b.replace("runner.part", ""));
      return numA - numB;
    });

  if (chunks.length === 0) {
    console.error("[Runner] No chunk files found in bin/runner/");
    return false;
  }

  console.log(
    `[Runner] Reassembling ${chunks.length} chunks into runner zip...`,
  );

  const out = fs.openSync(RUNNER_ZIP, "w");
  for (const chunk of chunks) {
    const chunkPath = path.join(CHUNKS_DIR, chunk);
    const data = fs.readFileSync(chunkPath);
    fs.writeSync(out, data);
    process.stdout.write(
      `  + ${chunk} (${(data.length / 1024 / 1024).toFixed(1)}MB)\n`,
    );
  }
  fs.closeSync(out);

  const sizeMB = (fs.statSync(RUNNER_ZIP).size / 1024 / 1024).toFixed(1);
  console.log(`[Runner] Reassembled: actions-runner.zip (${sizeMB}MB) ✔`);
  return true;
}

// ── Extract runner zip ─────────────────────────────────────
function extractRunner() {
  if (fs.existsSync(CONFIG_CMD)) {
    console.log("[Runner] Already extracted — skipping.");
    return true;
  }

  console.log("[Runner] Extracting runner zip...");
  if (!fs.existsSync(RUNNER_DIR)) fs.mkdirSync(RUNNER_DIR, { recursive: true });

  const ok = run(
    `powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${RUNNER_ZIP}', '${RUNNER_DIR}')"`,
    { silent: false },
  );

  if (!ok || !fs.existsSync(CONFIG_CMD)) {
    console.error("[Runner] Extraction failed.");
    return false;
  }

  console.log("[Runner] Extracted ✔");
  return true;
}

// ── Get fresh registration token from GitHub API ───────────
function getRegistrationToken() {
  if (!GITHUB_PAT) {
    console.error("[Runner] GITHUB_PAT not set in .env.local");
    console.error("         Add: GITHUB_PAT=your_personal_access_token");
    return null;
  }

  console.log("[Runner] Fetching registration token from GitHub API...");

  // Use PowerShell instead of curl (curl not available on all Windows installs)
  const result = runOut(
    `powershell -NoProfile -Command "` +
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ` +
      `$h = @{ Authorization = 'token ${GITHUB_PAT}'; Accept = 'application/vnd.github+json' }; ` +
      `(Invoke-RestMethod -Uri 'https://api.github.com/repos/${GITHUB_REPO}/actions/runners/registration-token' -Method POST -Headers $h) | ConvertTo-Json"`,
  );

  if (!result) {
    console.error(
      "[Runner] Failed to reach GitHub API. Check internet and GITHUB_PAT.",
    );
    return null;
  }

  try {
    const json = JSON.parse(result);
    if (!json.token) {
      console.error("[Runner] No token in response:", result);
      return null;
    }
    console.log("[Runner] Got registration token ✔");
    return json.token;
  } catch {
    console.error("[Runner] Invalid response from GitHub API:", result);
    return null;
  }
}

// ── Configure and install runner as Windows Service ────────
function configureRunner(token) {
  console.log("[Runner] Configuring runner...");

  // Remove existing config if re-running
  spawnSync("cmd.exe", ["/c", CONFIG_CMD, "remove", "--token", token], {
    cwd: RUNNER_DIR,
    stdio: "pipe",
    shell: false,
  });

  // --runasservice installs directly as Windows Service during config
  const result = spawnSync(
    "cmd.exe",
    [
      "/c",
      CONFIG_CMD,
      "--url",
      GITHUB_URL,
      "--token",
      token,
      "--name",
      `${require("os").hostname()}-runner`,
      "--labels",
      process.env.RUNNER_LABEL,
      "--work",
      "_work",
      "--unattended",
      "--replace",
      "--runasservice",
    ],
    { cwd: RUNNER_DIR, stdio: "inherit", shell: false },
  );

  if (result.error) {
    console.error("[Runner] Spawn error:", result.error);
    return false;
  }

  if (result.status !== 0) {
    console.error(
      "[Runner] Configuration failed with exit code:",
      result.status,
    );
    return false;
  }

  console.log("[Runner] Configured and installed as Windows Service ✔");
  return true;
}

// ── Cleanup zip after install ──────────────────────────────
function cleanup() {
  try {
    fs.unlinkSync(RUNNER_ZIP);
  } catch {}
  console.log("[Runner] Cleaned up zip file.");
}

// ── Main ───────────────────────────────────────────────────
console.log("DSA Payroll — GitHub Actions Runner Installer");
console.log("=============================================");

if (!reassembleChunks()) process.exit(1);
if (!extractRunner()) process.exit(1);

// Use pre-generated token if available, otherwise fetch from API
let token = null;
if (GITHUB_RUNNER_TOKEN) {
  console.log("[Runner] Using GITHUB_RUNNER_TOKEN from .env.local ✔");
  token = GITHUB_RUNNER_TOKEN.trim();
} else {
  token = getRegistrationToken();
  if (!token) process.exit(1);
}

if (!configureRunner(token)) process.exit(1);

cleanup();

console.log("\n=============================================");
console.log("GitHub Actions Runner installed as Windows Service.");
console.log("It will auto-start on every boot.");
console.log("");
console.log("Check status on GitHub:");
console.log(`  ${GITHUB_URL}/settings/actions/runners`);
console.log("");
console.log("Local service commands:");
console.log("  cd actions-runner && svc.cmd status");
console.log("  cd actions-runner && svc.cmd stop");
console.log("  cd actions-runner && svc.cmd start");
console.log("=============================================");
