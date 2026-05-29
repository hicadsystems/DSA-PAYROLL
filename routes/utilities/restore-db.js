const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { spawn } = require("child_process");
const dbConfig = require("../../config/db-config");
const mysql = require("mysql2/promise");
const router = express.Router();
const verifyToken = require("../../middware/authentication");
const pool = require("../../config/db");
const sessionContext = pool._getSessionContext();

const RESTORE_DIR = path.join(process.cwd(), "restores");
const HISTORY_FILE = path.join(RESTORE_DIR, "restore-history.json");

// Ensure restore directory exists
if (!fs.existsSync(RESTORE_DIR)) {
  fs.mkdirSync(RESTORE_DIR, { recursive: true });
}

// SSE sessions for progress tracking
const activeSessions = new Map();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, RESTORE_DIR);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, `${timestamp}_${sanitizedName}`);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [".sql", ".dump", ".bak", ".gz", ".zip"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedExtensions.includes(ext) || ext === "") {
      cb(null, true);
    } else {
      cb(
        new Error("Invalid file type. Please upload a valid backup file."),
        false,
      );
    }
  },
});

// Helper function to get mapping of db_name to classname
async function getDbToClassMap() {
  const masterDb = pool.getMasterDb();
  pool.useDatabase(masterDb);
  const [dbClasses] = await pool.query(
    "SELECT db_name, classname FROM py_payrollclass",
  );

  const dbToClassMap = {};
  dbClasses.forEach((row) => {
    dbToClassMap[row.db_name] = row.classname;
  });

  return dbToClassMap;
}

// Helper function to get friendly name
const getFriendlyName = async (dbName) => {
  const dbToClassMap = await getDbToClassMap();

  return dbToClassMap[dbName] || dbName;
};

// Helper functions for managing restore history
const loadHistory = async (dbName = null) => {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }
    const data = fs.readFileSync(HISTORY_FILE, "utf8");
    const allHistory = JSON.parse(data);

    const historyWithNames = await Promise.all(
      allHistory.map(async (entry) => ({
        ...entry,
        class_name: entry.class_name || (await getFriendlyName(entry.database)),
      })),
    );

    if (dbName) {
      return historyWithNames.filter((entry) => entry.database === dbName);
    }

    return historyWithNames;
  } catch (err) {
    console.error("Error loading history:", err);
    return [];
  }
};

const saveHistory = (history) => {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Error saving history:", err);
  }
};

const addToHistory = async (entry) => {
  const allHistory = await loadHistory();

  const newEntry = {
    ...entry,
    id: Date.now(),
    date: new Date().toISOString(),
    class_name: await getFriendlyName(entry.database),
  };

  allHistory.push(newEntry);
  saveHistory(allHistory);
  return allHistory;
};

// Broadcast progress to SSE clients
function broadcastProgress(sessionId, progress) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  session.progress = progress;
  const data = `data: ${JSON.stringify(progress)}\n\n`;

  session.clients.forEach((client) => {
    try {
      client.write(data);
    } catch (err) {
      console.error("Error writing to SSE client:", err.message);
    }
  });
}

function runCommandStreamed(command, args, env, onProgress, callback) {
  console.log("Spawning:", command, args.join(" "));

  const proc = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false, // safer & faster — no shell overhead
    timeout: 3600000,
  });

  let stderr = "";
  let bytesProcessed = 0;

  proc.stdout.on("data", (chunk) => {
    bytesProcessed += chunk.length;
    onProgress({ bytes: bytesProcessed });
  });

  proc.stderr.on("data", (chunk) => {
    const line = chunk.toString();
    stderr += line;
    bytesProcessed += chunk.length;
    onProgress({ bytes: bytesProcessed, message: line.trim() });
  });

  proc.on("close", (code) => {
    if (code !== 0) {
      return callback(
        new Error(`Process exited ${code}: ${stderr.slice(-500)}`),
      );
    }
    callback(null);
  });

  proc.on("error", (err) => callback(err));

  return proc;
}

async function createBackupBeforeRestore(database, config) {
  return new Promise((resolve) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(process.cwd(), "backups", "pre-restore");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const backupFile = path.join(
      backupDir,
      `${database}_pre-restore_${timestamp}.sql`,
    );
    const outStream = fs.createWriteStream(backupFile);

    const proc = spawn(
      "mysqldump",
      [
        "--skip-lock-tables",
        `-h${config.host}`,
        `-P${config.port}`,
        `-u${config.user}`,
        `-p${config.password}`,
        database,
      ],
      { shell: false },
    );

    proc.stdout.pipe(outStream);

    proc.on("close", (code) => {
      if (code !== 0) console.warn("Pre-restore backup exited with code", code);
      else console.log("Pre-restore backup created:", backupFile);
      resolve(backupFile);
    });

    proc.on("error", (err) => {
      console.warn("Pre-restore backup failed:", err.message);
      resolve(null);
    });
  });
}

// SSE Progress endpoint
router.get("/progress/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  const token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  let decoded;

  try {
    const jwt = require("jsonwebtoken");
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(403).json({ error: "Invalid token" });
  }

  // ── Set DB context with sessionId, same as verifyToken does ──
  // Without this, the manual jwt.verify above leaves pool on "default"
  // session slot, contaminating concurrent requests from the same user
  if (decoded?.current_class){
    try {
      const userSessionId = decoded.user_id.toString();
      pool.useDatabase(decoded.current_class, userSessionId);
      console.log(
        `🔄 SSE DB set to: ${decoded.current_class} for user: ${decoded.user_id}`,
      );
    } catch (dbErr) {
      console.error("❌ SSE DB context error:", dbErr);
    }
  }

  // Completely detach session from SSE — no-op all session methods
  // so the SSE connection never touches or corrupts session state
  if (req.session) {
    req.session.save = (cb) => cb && cb();
    req.session.touch = (cb) => cb && cb();
    req.session.reload = (cb) => cb && cb();
    req.session.destroy = (cb) => cb && cb(); // don't actually destroy
  }

  // Prevent session cookie from being set/renewed on SSE response
  res.removeHeader("Set-Cookie");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // =Prevent SSE from touching/renewing the session cookie
  // express-session was re-saving on every SSE keepalive, resetting
  // session state and eventually triggering re-auth checks on other tabs
  req.session.save = (cb) => cb && cb(); // no-op save for SSE requests

  if (!activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, {
      clients: [],
      progress: { stage: "waiting", percent: 0, message: "Waiting..." },
    });
  }

  const session = activeSessions.get(sessionId);
  res.write(`data: ${JSON.stringify(session.progress)}\n\n`);
  session.clients.push(res);

  // Keepalive comment ping every 20s to prevent proxy/nginx
  // from killing the connection and triggering a reconnect flood
  const keepalive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (e) {
      clearInterval(keepalive);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepalive);
    const index = session.clients.indexOf(res);
    if (index !== -1) {
      session.clients.splice(index, 1);
    }
  });
});

// Connection status
router.get("/status", verifyToken, async (req, res) => {
  let connection;
  try {
    const config = await dbConfig.getConfig();
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
    });
    await connection.ping();
    res.json({ status: "connected", engine: config.type || "mysql" });
  } catch (err) {
    console.error("DB connection failed:", err.message);
    res.json({ status: "disconnected", error: err.message });
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (closeErr) {
        console.error("Error closing connection:", closeErr.message);
      }
    }
  }
});

// Get database name
router.get("/database", verifyToken, async (req, res) => {
  const dbToClassMap = await getDbToClassMap();

  res.json({
    database: req.current_class,
    class_name: dbToClassMap[req.current_class] || "Unknown",
    primary_class: req.primary_class,
    user_info: {
      user_id: req.user_id,
      full_name: req.user_fullname,
      role: req.user_role,
    },
  });
});

// RESTORE endpoint
router.post("/restore", verifyToken, async (req, res) => {
  upload.single("file")(req, res, async (uploadErr) => {
    // ── Capture sessionId immediately while still in ALS context ──
    const userSessionId = req.user_id.toString();

    if (uploadErr) {
      return res.status(400).json({ success: false, error: uploadErr.message });
    }

    const { mode = "overwrite", engine = "mysql" } = req.body;
    const database = req.current_class;
    const file = req.file;

    if (!file || !database) {
      return res
        .status(400)
        .json({ success: false, error: "Missing file or database" });
    }

    const restoreFile = file.path;
    const originalFilename = file.originalname;
    const fileSize = fs.statSync(restoreFile).size;

    const sessionId = `restore_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    activeSessions.set(sessionId, {
      clients: [],
      progress: { stage: "uploading", percent: 5, message: "File uploaded..." },
    });

    res.json({ success: true, sessionId });

    // ── Real progress from bytes ───────────────────────────────────────────
    let lastPercent = 40;
    function onStreamProgress({ bytes, message }) {
      if (message) console.log("[restore stream]", message);
      if (fileSize > 0) {
        const rawPercent = Math.min(
          95,
          40 + Math.round((bytes / fileSize) * 55),
        );
        if (rawPercent > lastPercent) {
          lastPercent = rawPercent;
          broadcastProgress(sessionId, {
            stage: "restoring",
            percent: lastPercent,
            message: `Restoring... ${lastPercent}%`,
          });
        }
      }
    }

    // ── Declare preRestoreBackup here so finalizeRestore can always see it ─
    let preRestoreBackup = null;

    // ── Shared finalize ───────────────────────────────────────────────────
    async function finalizeRestore(err) {
      // ── Re-stamp tokens that existed before restore ──────────
      if (!err && savedTokens.length > 0) {
        try {
          // Force ALS context for the re-stamp by wrapping in sessionContext.run
          await new Promise((resolve, reject) => {
            sessionContext.run(userSessionId, async () => {
              try {
                pool.useDatabase(database, userSessionId);
                for (const row of savedTokens) {
                  await pool.query(
                    "UPDATE users SET token = ? = ? WHERE user_id = ?",
                    [row.token, row.refresh_token, row.user_id]
                  );
                }
                console.log(`✅ Re-stamped tokens for ${savedTokens.length} users after restore`);
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          });
        } catch (stampErr) {
          console.error("❌ Failed to re-stamp tokens after restore:", stampErr);
        }
      }

      await new Promise((resolve, reject) => {
      sessionContext.run(userSessionId, async () => {
        try {
          await addToHistory({
            filename: originalFilename,
            storedFilename: path.basename(restoreFile),
            database,
            engine,
            mode,
            status: err ? "Failed" : "Success",
            error: err ? err.message : null,
            preRestoreBackup: preRestoreBackup
              ? path.basename(preRestoreBackup)
              : null,
            userId: req.user_id,
            userName: req.user_fullname,
          }, userSessionId);resolve();
        } catch (e) {
            reject(e);
          }
        });
      });

      setTimeout(() => {
        try {
          if (fs.existsSync(restoreFile)) fs.unlinkSync(restoreFile);
        } catch (e) {
          console.warn("Cleanup error:", e.message);
        }
      }, 5000);

      const progressPayload = err
        ? {
            stage: "failed",
            percent: 100,
            message: "Restore failed: " + err.message,
          }
        : {
            stage: "complete",
            percent: 100,
            message: "Restore completed successfully!",
          };

      broadcastProgress(sessionId, progressPayload);

      // Close all SSE clients and delete session after restore ends
      // Leaving SSE connections open causes session interference / logout
      setTimeout(() => {
        const session = activeSessions.get(sessionId);
        if (session) {
          session.clients.forEach((client) => {
            try {
              client.end();
            } catch (e) {
              /* ignore */
            }
          });
          activeSessions.delete(sessionId);
          console.log(`[SSE] Session ${sessionId} cleaned up`);
        }
      }, 3000); // 3s delay so client receives the final message before connection closes
    }

    // ── Helper: pipe a readStream into a mysql proc with progress ─────────
    function pipeMysql(mysqlArgs, inputStream, trackBytes = false) {
      return new Promise((resolve, reject) => {
        const mysqlProc = spawn("mysql", mysqlArgs, { shell: false });

        if (trackBytes) {
          let bytesRead = 0;
          inputStream.on("data", (chunk) => {
            bytesRead += chunk.length;
            onStreamProgress({ bytes: bytesRead });
          });
        }

        inputStream.pipe(mysqlProc.stdin);

        let stderr = "";
        mysqlProc.stderr.on("data", (d) => {
          stderr += d;
          onStreamProgress({ bytes: 0, message: d.toString().trim() });
        });
        mysqlProc.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`mysql exited ${code}: ${stderr.slice(-300)}`)),
        );
        mysqlProc.on("error", reject);
        inputStream.on("error", reject);
      });
    }

    // Before the restore begins, save current tokens
    let savedTokens = [];

    try {
      broadcastProgress(sessionId, {
        stage: "preparing",
        percent: 10,
        message: "Preparing restore...",
      });

      const config = await dbConfig.getConfig();

      // ── Wrap everything in the correct ALS context ──
      await new Promise((resolve, reject) => {
        sessionContext.run(userSessionId, async () => {
          try {
            // ── Save current tokens before restore overwrites them ──
            pool.useDatabase(database, req.user_id.toString());
            const [tokenRows] = await pool.query("SELECT user_id, token FROM users");
            savedTokens = tokenRows;

            const os = require("os");
            const isWindows = os.platform().startsWith("win");
            const { Transform } = require("stream");
            const zlib = require("zlib");

            if (mode === "overwrite" && req.body.skipPreBackup !== "true") {
              broadcastProgress(sessionId, {
                stage: "backup",
                percent: 15,
                message: "Creating pre-restore backup...",
              });
              preRestoreBackup = await createBackupBeforeRestore(database, config);
            }

            broadcastProgress(sessionId, {
              stage: "preparing",
              percent: 20,
              message: "Building restore command...",
            });

            switch (engine.toLowerCase()) {
              case "mysql": {
                const mysqlArgs = [
                  `-h${config.host}`,
                  `-P${config.port}`,
                  `-u${config.user}`,
                  `-p${config.password}`,
                  ...(mode === "merge" ? ["--force"] : []),
                  database,
                ];

                // .gz — decompress then pipe
                if (originalFilename.endsWith(".gz")) {
                  broadcastProgress(sessionId, {
                    stage: "decompressing",
                    percent: 30,
                    message: "Decompressing...",
                  });
                  const readStream = fs.createReadStream(restoreFile);
                  const gunzip = zlib.createGunzip();
                  readStream.on("data", (chunk) =>
                    onStreamProgress({ bytes: chunk.length }),
                  );
                  await pipeMysql(mysqlArgs, readStream.pipe(gunzip), false);
                } else if (isWindows) {
                  // Windows — pipe file directly, no sed needed
                  broadcastProgress(sessionId, {
                    stage: "restoring",
                    percent: 40,
                    message: "Importing data...",
                  });
                  const readStream = fs.createReadStream(restoreFile);
                  await pipeMysql(mysqlArgs, readStream, true);
                } else {
                  // Linux — strip DEFINER via Transform stream
                  broadcastProgress(sessionId, {
                    stage: "restoring",
                    percent: 40,
                    message: "Importing data...",
                  });
                  const stripDefiner = new Transform({
                    transform(chunk, _enc, cb) {
                      cb(
                        null,
                        chunk
                          .toString()
                          .replace(/DEFINER\s*=\s*`[^`]*`@`[^`]*`/g, ""),
                      );
                    },
                  });
                  const readStream = fs.createReadStream(restoreFile);
                  readStream.on("data", (chunk) =>
                    onStreamProgress({ bytes: chunk.length }),
                  );
                  await pipeMysql(mysqlArgs, readStream.pipe(stripDefiner), false);
                }

                await finalizeRestore(null);
                break;
              }

              case "postgres": {
                broadcastProgress(sessionId, {
                  stage: "restoring",
                  percent: 40,
                  message: "Importing data...",
                });
                await new Promise((resolve, reject) => {
                  runCommandStreamed(
                    "psql",
                    [
                      `-h${config.host}`,
                      `-p${config.port}`,
                      `-U${config.user}`,
                      `-d${database}`,
                      "-f",
                      restoreFile,
                      ...(mode === "merge" ? ["--on-conflict-do-nothing"] : []),
                    ],
                    { PGPASSWORD: config.password },
                    onStreamProgress,
                    (err) => (err ? reject(err) : resolve()),
                  );
                });
                await finalizeRestore(null);
                break;
              }

              case "mongo": {
                broadcastProgress(sessionId, {
                  stage: "restoring",
                  percent: 40,
                  message: "Importing data...",
                });
                await new Promise((resolve, reject) => {
                  runCommandStreamed(
                    "mongorestore",
                    [
                      `--host=${config.host}:${config.port}`,
                      `--db=${database}`,
                      ...(mode === "overwrite" ? ["--drop"] : []),
                      restoreFile,
                    ],
                    {},
                    onStreamProgress,
                    (err) => (err ? reject(err) : resolve()),
                  );
                });
                await finalizeRestore(null);
                break;
              }

              default:
                broadcastProgress(sessionId, {
                  stage: "failed",
                  percent: 100,
                  message: `Unsupported engine: ${engine}`,
                });
                return;
              } resolve();
            } catch (e) {
            reject(e);
          }
        });
      });
    } catch (error) {
      console.error("Restore error:", error);
      await finalizeRestore(error);
    }
  });
});

// Get history
router.get("/history", verifyToken, async (req, res) => {
  const database = req.current_class;
  const dbToClassMap = await getDbToClassMap();

  res.json({
    history: await loadHistory(database),
    database,
    class_name: dbToClassMap[database] || database,
  });
});

// Get stats
router.get("/stats", verifyToken, async (req, res) => {
  const history = await loadHistory(req.current_class);
  res.json({
    successful: history.filter((h) => h.status === "Success").length,
    failed: history.filter((h) => h.status === "Failed").length,
    lastRestore: history.length > 0 ? history[history.length - 1].date : null,
    database: req.current_class,
  });
});

// Delete history entry
router.delete("/restore/:filename", verifyToken, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const allHistory = await loadHistory();
    const entryIndex = allHistory.findIndex(
      (entry) =>
        entry.filename === filename && entry.database === req.current_class,
    );

    if (entryIndex === -1) {
      return res.status(404).json({ success: false, error: "Entry not found" });
    }

    allHistory.splice(entryIndex, 1);
    saveHistory(allHistory);
    res.json({ success: true, message: "Restore Entry Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Error handler
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res
      .status(400)
      .json({ success: false, error: "File too large. Max 10GB." });
  }
  next(error);
});

module.exports = router;
