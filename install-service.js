/**
 * DSA Payroll - Windows Service Installer (WinSW)
 * Run as Administrator: node install-service.js
 *
 * WinSW wraps Node.js processes as true Windows Services.
 * No PM2, no Node version dependency, runs before login.
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = __dirname;
const NODE_EXE = process.execPath;
const WINSW = fs.existsSync(path.join(ROOT, "bin", "winsw.exe"))
  ? path.join(ROOT, "bin", "winsw.exe")
  : path.join(ROOT, "winsw.exe");

function run(cmd, silent = false) {
  try {
    execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: silent ? "pipe" : "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

const logsDir = path.join(ROOT, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
  console.log("[INFO] Created logs/ directory");
}

console.log("DSA Payroll -- Windows Service Installer (WinSW)");
console.log("================================================");

function ensureWinSW() {
  if (fs.existsSync(WINSW)) {
    console.log(`[WinSW] Found at: ${WINSW} OK`);
    return true;
  }

  const winswRoot = path.join(ROOT, "winsw.exe");
  console.log("[WinSW] Not found in bin/ or project root. Trying download...");

  const mirrors = [
    "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe",
    "https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-x64.exe",
  ];

  for (const url of mirrors) {
    console.log(`[WinSW] Trying: ${url}`);
    run(
      `powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${winswRoot}' -UseBasicParsing"`,
      true,
    );
    if (fs.existsSync(winswRoot) && fs.statSync(winswRoot).size > 100000) {
      console.log("[WinSW] Downloaded OK");
      return true;
    }
    try {
      fs.unlinkSync(winswRoot);
    } catch {}
  }

  console.error("[WinSW] winsw.exe not found and download failed.");
  console.error("[WinSW] This file should be bundled in bin/winsw.exe.");
  console.error("[WinSW] Contact the system administrator.");
  return false;
}

function createServiceConfig({ id, name, description, script }) {
  const xmlPath = path.join(ROOT, `${id}.xml`);

  const xml = `<service>
  <id>${id}</id>
  <name>${name}</name>
  <description>${description}</description>

  <executable>${NODE_EXE}</executable>
  <arguments>"${script}"</arguments>
  <workingdirectory>${ROOT}</workingdirectory>

  <!-- Restart on failure -->
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="20 sec"/>
  <resetfailure>1 hour</resetfailure>

  <!-- Logging -->
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <logpath>${path.join(ROOT, "logs")}</logpath>

  <!-- Environment -->
  <env name="NODE_ENV" value="production"/>
  <env name="ENV_FILE" value=".env.local"/>
  <env name="FORCE_LOCAL" value="true"/>

  <!-- Startup -->
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>

  <!-- Stop signal -->
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <stoptimeout>10 sec</stoptimeout>
</service>`;

  fs.writeFileSync(xmlPath, xml, "utf8");
  return xmlPath;
}

async function installService({ id, name, description, script }) {
  console.log(`\n[${id}] Installing service...`);

  const xmlPath = createServiceConfig({ id, name, description, script });
  const winswCopy = path.join(ROOT, `${id}.exe`);

  // Pre-stop via sc.exe first (works even if winswCopy doesn't exist yet)
  run(`cmd /c sc stop "${id}"`, true);
  run(`cmd /c sc delete "${id}"`, true);
  // Give Windows time to release handles
  await new Promise((r) => setTimeout(r, 2000));

  // Stop and uninstall existing service first to release file lock
  if (fs.existsSync(winswCopy)) {
    run(`"${winswCopy}" stop`, true);
    run(`"${winswCopy}" uninstall`, true);
    // Wait for service to fully release the file lock
    const start = Date.now();
    while (fs.existsSync(winswCopy)) {
      try {
        fs.unlinkSync(winswCopy);
        break;
      } catch {
        /* still locked */
      }
      if (Date.now() - start > 10000) {
        console.error(`[${id}] Timeout waiting for file release.`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Also stop via sc.exe in case winsw copy is already gone but service still registered
  run(`cmd /c sc stop "${id}"`, true);
  run(`cmd /c sc delete "${id}"`, true);

  // WinSW requires a copy named after the service
  fs.copyFileSync(WINSW, winswCopy);

  // Install
  const ok = run(`"${winswCopy}" install`);
  if (!ok) {
    console.error(`[${id}] Failed to install service.`);
    return false;
  }

  // Start
  run(`"${winswCopy}" start`);
  console.log(`[${id}] Service installed and started OK`);
  return true;
}

// ── Main ───────────────────────────────────────────────────
(async () => {
  if (!ensureWinSW()) process.exit(1);

  // ── Ensure MySQL is running first ─────────────────────────
  console.log("\n[MySQL] Detecting MySQL service...");

  let mysqlServiceName = null;
  try {
    const out = execSync("sc query type= all state= all", { encoding: "utf8" });
    const match = out.match(/SERVICE_NAME:\s*(MySQL\S*)/i);
    if (match) mysqlServiceName = match[1].trim();
  } catch {}

  if (!mysqlServiceName) {
    console.error("[MySQL] No MySQL service found. Aborting.");
    process.exit(1);
  }

  console.log(`[MySQL] Found service: ${mysqlServiceName}`);

  try {
    execSync(`sc start ${mysqlServiceName}`, { stdio: "pipe" });
    console.log(`[MySQL] Started ${mysqlServiceName}`);
  } catch {
    // already running or failed — will confirm below
  }

  let mysqlRunning = false;
  for (let i = 0; i < 10; i++) {
    try {
      const out = execSync(`sc query ${mysqlServiceName}`, {
        encoding: "utf8",
      });
      if (out.includes("RUNNING")) {
        mysqlRunning = true;
        break;
      }
    } catch {}
    console.log(`[MySQL] Waiting... (${i + 1}/10)`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!mysqlRunning) {
    console.error(`[MySQL] ${mysqlServiceName} failed to start. Aborting.`);
    process.exit(1);
  }
  console.log(`[MySQL] ${mysqlServiceName} is running OK\n`);

  // ── Core app ─────────────────────────────────────────────
  const appOk = await installService({
    id: "DsaPayroll-App",
    name: "DSA Payroll App",
    description: "DSA Payroll Express server (port 7070)",
    script: path.join(ROOT, "server.js"),
  });

  // ── HTTPS proxy ──────────────────────────────────────────
  const proxyOk = await installService({
    id: "DsaPayroll-Proxy",
    name: "DSA Payroll Proxy",
    description: "DSA Payroll HTTPS proxy (port 443)",
    script: path.join(ROOT, "proxy.js"),
  });

  // ── File watcher ─────────────────────────────────────────
  const watcherOk = await installService({
    id: "DsaPayroll-Watcher",
    name: "DSA Payroll Watcher",
    description:
      "DSA Payroll file watcher -- auto-restarts app on code changes",
    script: path.join(ROOT, "watcher.js"),
  });

  // ── mDNS Responder ───────────────────────────────────────
  const mdnsOk = await installService({
    id: "DsaPayroll-mDNS",
    name: "DSA Payroll mDNS",
    description:
      "Advertises .local domain on the LAN -- no client config needed",
    script: path.join(ROOT, "mdns.js"),
  });

  // ── Summary ───────────────────────────────────────────────
  console.log("\n================================================");
  if (appOk && proxyOk) {
    console.log("All services installed and running.");
    console.log("They will autostart on every boot.");
    console.log("");
    console.log("Manage via services.msc or:");
    console.log("  DsaPayroll-App.exe     status/start/stop/restart");
    console.log("  DsaPayroll-Proxy.exe   status/start/stop/restart");
    console.log("  DsaPayroll-Watcher.exe status/start/stop/restart");
    console.log("  DsaPayroll-mDNS.exe    status/start/stop/restart");
    console.log("  services.msc           (Windows Service Manager GUI)");
    console.log("");
    console.log("LAN Access (no client setup needed):");
    console.log("  https://[your-domain].local");
    console.log("");
    console.log("Logs:");
    console.log("  logs/DsaPayroll-App-out.log");
    console.log("  logs/DsaPayroll-Proxy-out.log");
    console.log("  logs/DsaPayroll-mDNS-out.log");
    console.log("");
    console.log("Remove: node uninstall-service.js");
  } else {
    console.log("One or more services failed. Run as Administrator and retry.");
  }
  console.log("================================================");
})();
