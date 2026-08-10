/**
 * DSA Payroll - Windows Service Uninstaller (WinSW)
 * Run as Administrator: node uninstall-service.js
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = __dirname;

function run(cmd) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function removeService(id) {
  const winswExe = path.join(ROOT, `${id}.exe`);
  const xmlFile  = path.join(ROOT, `${id}.xml`);

  if (!fs.existsSync(winswExe)) {
    console.log(`[${id}] Not found — skipping.`);
    return;
  }

  console.log(`\n[${id}] Stopping...`);
  run(`"${winswExe}" stop`);

  console.log(`[${id}] Uninstalling...`);
  run(`"${winswExe}" uninstall`);

  // Cleanup files
  try { fs.unlinkSync(winswExe); } catch {}
  try { fs.unlinkSync(xmlFile);  } catch {}

  console.log(`[${id}] Removed ✔`);
}

console.log("DSA Payroll -- Service Uninstaller (WinSW)");
console.log("==========================================");

removeService("DsaPayroll-Proxy");
removeService("DsaPayroll-App");
removeService("DsaPayroll-Watcher");
removeService("DsaPayroll-mDNS");

console.log("\n==========================================");
console.log("All services removed.");
console.log("Run node install-service.js to re-register.");
console.log("==========================================");
