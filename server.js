const path = require("path");
const dotenv = require("dotenv");
const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: path.resolve(__dirname, envFile) });

const { notificationMiddleware } = require("./middware/notifications");
const seamlessWrapper = require("./services/helpers/historicalReportWrapper");
const express = require("express");
const app = express();
const session = require("express-session");
const serveIndex = require("serve-index");
const pool = require("./config/db");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const fs = require("fs");
const https = require("https");
const http = require("http");

const PORT = parseInt(process.env.PORT)
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT)
const HTTP_PORT = parseInt(process.env.HTTP_PORT)
const LOCAL_IP = process.env.LOCAL_IP
const LOCAL_DOMAIN = process.env.LOCAL_DOMAIN
const SERVER_MODE = process.env.SERVER_MODE
const BIND_ADDRESS = process.env.BIND_ADDRESS

console.log("Running in", process.env.NODE_ENV);
console.log(
  `SERVER_MODE=${SERVER_MODE}  BIND=${BIND_ADDRESS}  PORT=${PORT}  HTTPS=${HTTPS_PORT}  HTTP=${HTTP_PORT}`,
);

// ── Security headers ───────────────────────────────────────
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
      frameSrc: ["'self'", "blob:", "data:", "https://res.cloudinary.com"],
    },
  }),
);

app.use(morgan("dev"));

// ── CORS ───────────────────────────────────────────────────
const corsOrigins = [
  "http://localhost:5500",
  "https://localhost:5500",
  `http://localhost:${PORT}`,
  `https://localhost:${PORT}`,
  `https://localhost:${HTTPS_PORT}`,
  `http://localhost:${HTTP_PORT}`,
  "http://127.0.0.1:5500",
  "https://127.0.0.1:5500",
  `http://127.0.0.1:${PORT}`,
  `https://127.0.0.1:${PORT}`,
  `https://127.0.0.1:${HTTPS_PORT}`,
  LOCAL_DOMAIN ? `https://${LOCAL_DOMAIN}` : null,
  LOCAL_DOMAIN ? `https://${LOCAL_DOMAIN}:${HTTPS_PORT}` : null,
  LOCAL_DOMAIN ? `http://${LOCAL_DOMAIN}` : null,
  LOCAL_DOMAIN ? `http://${LOCAL_DOMAIN}:${HTTP_PORT}` : null,
  LOCAL_IP ? `https://${LOCAL_IP}` : null,
  LOCAL_IP ? `https://${LOCAL_IP}:${HTTPS_PORT}` : null,
  LOCAL_IP ? `http://${LOCAL_IP}` : null,
  LOCAL_IP ? `http://${LOCAL_IP}:${HTTP_PORT}` : null,
  "https://hicad.ng",
].filter(Boolean);

app.use(
  cors({
    origin: corsOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

// trust proxy when behind load balancer (set in env when needed)
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

// built-in body parsers (remove body-parser dependency)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// session config (use env values in production)
app.use(
  session({
    secret: process.env.JWT_SECRET || "super-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.COOKIE_SAMESITE || "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  }),
);

app.use(notificationMiddleware);

// ── Static files ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use("/public", serveIndex(path.join(__dirname, "public"), { icons: true }));

// ── Health check ───────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// ── Credentials header ─────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});

// ── Error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack || err);
  res.status(500).json({ error: "Internal Server Error" });
});

// ── SSL options ────────────────────────────────────────────
function getSSLOptions() {
  try {
    return {
      key: fs.readFileSync(path.join(__dirname, "key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
    };
  } catch {
    console.warn("⚠️  SSL certs not found — HTTPS unavailable");
    return null;
  }
}

// ── Start server ───────────────────────────────────────────
async function startServer() {
  await seamlessWrapper.initialize();
  require("./routes")(app);

  const ssl = getSSLOptions();

  switch (SERVER_MODE) {
    // ── network: bind to all interfaces (proper LAN router) ──
    case "network": {
      if (!ssl) {
        console.error("❌ network mode requires SSL certs");
        process.exit(1);
      }
      https.createServer(ssl, app).listen(PORT, "0.0.0.0", () => {
        console.log(`🔒 HTTPS server → https://${LOCAL_IP}:${PORT}`);
        console.log(`🌐 LAN domain   → https://${LOCAL_DOMAIN}:${PORT}`);
      });
      break;
    }

    // ── localhost: plain HTTP, no SSL, local only ─────────────
    case "localhost": {
      http.createServer(app).listen(PORT, "127.0.0.1", () => {
        console.log(`🚀 HTTP server  → http://localhost:${PORT}`);
      });
      break;
    }

    // ── auto: HTTPS if certs exist, fallback to HTTP ──────────
    case "auto":
    default: {
      if (ssl) {
        const server = https.createServer(ssl, app);

        server.listen(PORT, BIND_ADDRESS, () => {
          if (BIND_ADDRESS === "0.0.0.0") {
            console.log(`🔒 HTTPS server → https://${LOCAL_IP}:${PORT}`);
            console.log(`🌐 LAN domain   → https://${LOCAL_DOMAIN}:${PORT}`);
          } else {
            console.log(`🔒 HTTPS server → https://localhost:${PORT}`);
          }
        });

        server.on("error", (err) => {
          if (["EADDRNOTAVAIL", "EADDRINUSE", "EACCES"].includes(err.code)) {
            console.warn(
              `⚠️  HTTPS on ${BIND_ADDRESS}:${PORT} failed (${err.code}) — falling back to HTTP localhost`,
            );
            http.createServer(app).listen(PORT, "127.0.0.1", () => {
              console.log(`🚀 Fallback HTTP → http://localhost:${PORT}`);
            });
          } else {
            console.error("❌ Server error:", err);
            process.exit(1);
          }
        });
      } else {
        // No certs — plain HTTP fallback
        console.warn("⚠️  No SSL certs found — starting plain HTTP");
        http.createServer(app).listen(PORT, "127.0.0.1", () => {
          console.log(`🚀 HTTP server  → http://localhost:${PORT}`);
        });
      }
      break;
    }
  }
}

startServer().catch((err) => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});