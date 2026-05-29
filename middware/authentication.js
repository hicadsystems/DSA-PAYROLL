const jwt = require("jsonwebtoken");
const config = require("../config");
const pool = require("../config/db");

const SECRET = config.jwt.secret;
if (!SECRET) {
  throw new Error("JWT_SECRET is not set in environment variables");
}

const verifyToken = async (req, res, next) => {
  // ── 1. Extract token ──────────────────────────────────────
  const bearerHeader = req.headers["authorization"];
  let token = null;

  if (bearerHeader && bearerHeader.startsWith("Bearer ")) {
    token = bearerHeader.split(" ")[1];
  }
  if (!token && req.query.token) {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }

  // ── 2. Verify JWT signature + expiry ─────────────────────
  let decoded;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token has expired" });
    }
    return res.status(401).json({ message: "Please Log In" });
  }

  // ── 3. Check token matches DB (stored token validation) ───
  try {
    // Skip DB token check for:
    // 1. Pre-login tokens (no current_class)
    // 2. Class-switched tokens (current_class !== created_in — new token was never stored in DB)
    const isPreLogin = !decoded.current_class;
    const isClassSwitch = decoded.current_class !== decoded.created_in;

    if (!isPreLogin && !isClassSwitch) {
      pool.useDatabase(decoded.created_in || config.databases.officers);

      const [rows] = await pool.query(
        "SELECT token FROM users WHERE user_id = ?",
        [decoded.user_id],
      );

      if (!rows || rows.length === 0) {
        return res.status(401).json({ message: "Please Log In" });
      }

      const storedToken = rows[0].token;
      if (storedToken && storedToken !== token) {
        return res.status(401).json({ message: "Please Log In" });
      }
    }
  } catch (dbErr) {
    console.error("❌ Token DB check error:", dbErr);
    return res.status(500).json({ message: "Server error" });
  }

  // ── 4. Attach user info to request ───────────────────────
  req.user_id = decoded.user_id;
  req.user_fullname = decoded.full_name;
  req.email = decoded.email;
  req.user_role = decoded.role;
  req.primary_class = decoded.primary_class;
  req.current_class = decoded.current_class;

  // ── 5. Set DB context (only when current_class is present) ─
  // Pre-login tokens have no current_class — skip DB switching for them.
  if (!decoded.current_class) {
    pool.useDatabase(config.databases.officers);
    return next();
  }

  try {
    const databaseName = decoded.current_class;
    const sessionId = decoded.user_id.toString();
    req.current_database = databaseName;
    req.session_id = sessionId;

    const sessionContext = pool._getSessionContext
      ? pool._getSessionContext()
      : null;

    if (sessionContext) {
      return sessionContext.run(sessionId, () => {
        try {
          pool.useDatabase(databaseName, sessionId);
          console.log(
            `🔄 DB set to: ${databaseName} for user: ${decoded.user_id}`,
          );
          next();
        } catch (dbError) {
          console.error("❌ Database context error:", dbError);
          return res.status(500).json({ message: "Database context error" });
        }
      });
    } else {
      pool.useDatabase(databaseName, sessionId);
      console.log(`🔄 DB set to: ${databaseName} for user: ${decoded.user_id}`);
      return next();
    }
  } catch (dbError) {
    console.error("❌ Database context error:", dbError);
    return res.status(500).json({ message: "Database context error" });
  }
};

module.exports = verifyToken;
