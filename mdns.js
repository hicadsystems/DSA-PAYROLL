/**
 * DSA Payroll - mDNS Responder
 * Advertises dsapayroll.local on the LAN automatically.
 * Works on WiFi AND Ethernet — no client config needed.
 *
 * Run standalone : node mdns.js
 * Run as service : added automatically via install-service.js
 */

const os = require("os");
const dgram = require("dgram");
const path = require("path");
const dotenv = require("dotenv");

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: path.resolve(__dirname, envFile) });

const DOMAIN =
  (process.env.LOCAL_DOMAIN || "dsapayroll.local").replace(/\.$/, "") + ".";
const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;

// ── Get all LAN IPs (IPv4 only, skip loopback) ────────────
function getLanIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

// ── Build a DNS A-record response packet ──────────────────
function buildResponse(name, ip, id = 0) {
  // Encode DNS name: dsapayroll.local. → \x0adsapayroll\x05local\x00
  const encodeName = (n) => {
    const buf = [];
    for (const label of n.replace(/\.$/, "").split(".")) {
      buf.push(label.length, ...Buffer.from(label));
    }
    buf.push(0);
    return Buffer.from(buf);
  };

  const nameBuf = encodeName(name);
  const ipParts = ip.split(".").map(Number);

  // DNS header (12 bytes)
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0); // Transaction ID
  header.writeUInt16BE(0x8400, 2); // Flags: Response, Authoritative
  header.writeUInt16BE(0, 4); // Questions: 0
  header.writeUInt16BE(1, 6); // Answer RRs: 1
  header.writeUInt16BE(0, 8); // Authority RRs: 0
  header.writeUInt16BE(0, 10); // Additional RRs: 0

  // DNS Answer record
  const rdata = Buffer.from(ipParts); // 4 bytes for IP
  const answer = Buffer.alloc(nameBuf.length + 10 + rdata.length);
  let offset = 0;
  nameBuf.copy(answer, offset);
  offset += nameBuf.length;
  answer.writeUInt16BE(0x0001, offset);
  offset += 2; // Type: A
  answer.writeUInt16BE(0x8001, offset);
  offset += 2; // Class: IN + cache-flush
  answer.writeUInt32BE(120, offset);
  offset += 4; // TTL: 120 seconds
  answer.writeUInt16BE(4, offset);
  offset += 2; // RDLENGTH: 4
  rdata.copy(answer, offset);

  return Buffer.concat([header, answer]);
}

// ── Parse incoming DNS question ───────────────────────────
function parseQuestion(msg) {
  try {
    const qdCount = msg.readUInt16BE(4);
    if (qdCount === 0) return null;

    let offset = 12;
    const labels = [];
    while (offset < msg.length) {
      const len = msg[offset++];
      if (len === 0) break;
      if ((len & 0xc0) === 0xc0) {
        offset++;
        break;
      } // pointer
      labels.push(msg.slice(offset, offset + len).toString());
      offset += len;
    }
    const qtype = msg.readUInt16BE(offset);
    const id = msg.readUInt16BE(0);
    return { name: labels.join(".") + ".", qtype, id };
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────
console.log("DSA Payroll — mDNS Responder");
console.log("=============================");
console.log(`Domain  : ${DOMAIN}`);

const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

socket.on("error", (err) => {
  console.error("❌ mDNS socket error:", err.message);
  if (err.code === "EACCES") {
    console.error("   Port 5353 requires elevated privileges.");
    console.error("   Run this service as Administrator.");
  }
  process.exit(1);
});

socket.on("message", (msg, rinfo) => {
  const q = parseQuestion(msg);
  if (!q) return;

  // Only respond to A-record (1) or ANY (255) queries for our domain
  if (q.qtype !== 1 && q.qtype !== 255) return;
  if (q.name.toLowerCase() !== DOMAIN.toLowerCase()) return;

  const ips = getLanIPs();
  if (ips.length === 0) {
    console.warn("⚠️  No LAN IPs found — skipping response");
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Query from ${rinfo.address} for ${q.name} → responding with ${ips.join(", ")}`,
  );

  // Send one response per IP (covers WiFi + Ethernet simultaneously)
  for (const ip of ips) {
    const response = buildResponse(DOMAIN, ip, q.id);
    socket.send(response, 0, response.length, MDNS_PORT, MDNS_ADDR, (err) => {
      if (err) console.error(`❌ Send error (${ip}):`, err.message);
    });
  }
});

socket.bind(MDNS_PORT, () => {
  socket.addMembership(MDNS_ADDR);
  socket.setMulticastTTL(255);
  socket.setMulticastLoopback(true);

  const ips = getLanIPs();
  console.log(`LAN IPs : ${ips.join(", ") || "none found"}`);
  console.log(`Listening on ${MDNS_ADDR}:${MDNS_PORT}`);
  console.log("");
  console.log("Clients can now reach the server at:");
  console.log(`  https://${DOMAIN.replace(/\.$/, "")}`);
  console.log("");
  console.log("No config needed on any client machine.");
  console.log("Works on WiFi and Ethernet automatically.");
});

// ── Announce presence on startup (unsolicited response) ───
socket.on("listening", () => {
  const ips = getLanIPs();
  for (const ip of ips) {
    const announcement = buildResponse(DOMAIN, ip);
    setTimeout(() => {
      socket.send(announcement, 0, announcement.length, MDNS_PORT, MDNS_ADDR);
    }, 1000); // slight delay to let socket fully initialize
  }
});

process.on("SIGINT", () => {
  socket.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  socket.close();
  process.exit(0);
});
