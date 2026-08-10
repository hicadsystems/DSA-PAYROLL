const httpProxy = require("http-proxy");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: path.resolve(__dirname, envFile) });

const TARGET_PORT = parseInt(process.env.PORT);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT);
const HTTP_PORT = parseInt(process.env.HTTP_PORT);
const LOCAL_IP = process.env.LOCAL_IP;
const DOMAIN = process.env.LOCAL_DOMAIN;
const BIND_ADDRESS = process.env.BIND_ADDRESS;

console.log("DSA Payroll — HTTPS Proxy");
console.log("=========================");
console.log(`BIND_ADDRESS : ${BIND_ADDRESS}`);
console.log(`HTTPS_PORT   : ${HTTPS_PORT}`);
console.log(`HTTP_PORT    : ${HTTP_PORT}`);
console.log(`TARGET_PORT  : ${TARGET_PORT}`);
console.log(`DOMAIN       : ${DOMAIN}`);
console.log(`LOCAL_IP     : ${LOCAL_IP}`);
console.log("");

// ── SSL options ────────────────────────────────────────────
let sslOptions;
try {
  sslOptions = {
    key: fs.readFileSync(path.join(__dirname, "key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
  };
} catch (e) {
  console.error("❌ SSL certs not found. Run setup.bat to generate them.");
  process.exit(1);
}

// ── Proxy server ───────────────────────────────────────────
const proxy = httpProxy.createProxyServer({
  target: `https://127.0.0.1:${TARGET_PORT}`,
  //ssl: sslOptions,
  secure: false,
});

proxy.on("error", (err, req, res) => {
  console.error("❌ Proxy error:", err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway", message: err.message }));
  }
});

// ── Helpers ────────────────────────────────────────────────

// Returns true if the request host is an IP address or localhost
// rather than the proper domain name
function shouldRedirectToDomain(host) {
  if (!host) return false;
  const h = host.replace(/:\d+$/, "").toLowerCase();
  if (h === "localhost") return true;
  if (h === "127.0.0.1") return true;
  if (h === LOCAL_IP) return true;
  // any other bare IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

// Build the canonical HTTPS domain URL
function domainUrl(req) {
  return HTTPS_PORT === 443
    ? `https://${DOMAIN}${req.url}`
    : `https://${DOMAIN}:${HTTPS_PORT}${req.url}`;
}

// ── HTTPS Server (port 443) ────────────────────────────────
const httpsServer = https.createServer(sslOptions, (req, res) => {
  const host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();

  // Redirect IP / localhost → domain
  if (shouldRedirectToDomain(req.headers.host)) {
    const location = domainUrl(req);
    console.log(`[redirect] ${req.headers.host}${req.url} → ${location}`);
    res.writeHead(301, { Location: location });
    res.end();
    return;
  }

  proxy.web(req, res);
});

httpsServer.on("error", (err) => {
  if (err.code === "EACCES") {
    console.error(`❌ Permission denied on port ${HTTPS_PORT}.`);
    console.error(
      `   Run: netsh http add urlacl url=https://+:${HTTPS_PORT}/ user="NT AUTHORITY\\NETWORK SERVICE"`,
    );
  } else if (err.code === "EADDRINUSE") {
    console.error(
      `❌ Port ${HTTPS_PORT} already in use. Change HTTPS_PORT in .env.local`,
    );
  } else {
    console.error("❌ HTTPS server error:", err.message);
  }
  process.exit(1);
});

httpsServer.listen(HTTPS_PORT, BIND_ADDRESS, () => {
  if (BIND_ADDRESS === "0.0.0.0") {
    console.log(
      `🔒 HTTPS proxy  → https://${DOMAIN}${HTTPS_PORT === 443 ? "" : ":" + HTTPS_PORT}`,
    );
    console.log(
      `   Also at      → https://${LOCAL_IP}${HTTPS_PORT === 443 ? "" : ":" + HTTPS_PORT}`,
    );
  } else {
    console.log(`🔒 HTTPS proxy  → https://localhost:${HTTPS_PORT}`);
  }
  console.log(`   Forwarding   → https://127.0.0.1:${TARGET_PORT}`);
  console.log(`   Redirecting  → IP/localhost → https://${DOMAIN}`);
});

// ── HTTP Server (port 80) → redirect to HTTPS domain ──────
const httpServer = http.createServer((req, res) => {
  const location = domainUrl(req);
  res.writeHead(301, { Location: location });
  res.end();
});

httpServer.on("error", (err) => {
  if (err.code === "EACCES") {
    console.warn(
      `⚠️  Permission denied on port ${HTTP_PORT} — HTTP redirect disabled.`,
    );
    console.warn(
      `   Run: netsh http add urlacl url=http://+:${HTTP_PORT}/ user="NT AUTHORITY\\NETWORK SERVICE"`,
    );
  } else if (err.code === "EADDRINUSE") {
    console.warn(
      `⚠️  Port ${HTTP_PORT} already in use — HTTP redirect disabled.`,
    );
  } else {
    console.warn("⚠️  HTTP server error:", err.message);
  }
});

httpServer.listen(HTTP_PORT, BIND_ADDRESS, () => {
  if (BIND_ADDRESS === "0.0.0.0") {
    console.log(
      `↪  HTTP redirect → http://${DOMAIN}${HTTP_PORT === 80 ? "" : ":" + HTTP_PORT} → https://${DOMAIN}`,
    );
  } else {
    console.log(
      `↪  HTTP redirect → http://localhost:${HTTP_PORT} → https://${DOMAIN}`,
    );
  }
});
