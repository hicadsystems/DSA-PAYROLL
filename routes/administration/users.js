/**
 * FILE: routes/administration/users.js
 *
 * Scope: Payroll users only.
 *
 * Removed from here (now in routes/auth/unified-login.js):
 *   POST /pre-login
 *   POST /pre-login/verify-identity
 *   POST /pre-login/reset-password
 *
 * Kept here:
 *   POST   /login               — full payroll login (with class)
 *   POST   /logout
 *   POST   /refresh
 *   POST   /verify-identity     — payroll forgot password step 1 (needs class)
 *   POST   /reset-password      — payroll forgot password step 2 (needs class)
 *   GET    /                    — list users
 *   GET    /:id                 — get user
 *   POST   /                    — create user
 *   PUT    /:user_id            — update user
 *   DELETE /:user_id            — delete user
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../config/db");
const config = require("../../config");
const jwt = require("jsonwebtoken");
const verifyToken = require("../../middware/authentication");

const jwtSign = ({ data, secret, time }) =>
  jwt.sign(data, secret, { expiresIn: time });

const jwtVerify = ({ token, secret }) =>
  jwt.verify(token, secret, (err, decoded) => {
    if (err) {
      return err.name === "TokenExpiredError"
        ? { message: "Token has expired", decoded: "" }
        : { message: "Invalid token", decoded: "" };
    }
    return { decoded, message: "" };
  });

// ─────────────────────────────────────────────────────────────
// HELPER — payroll class mapping (unchanged from original)
// ─────────────────────────────────────────────────────────────
async function loadPayrollMapping() {
  let databasesToSearch = [];
  let dbToClass = {};
  let classToDb = {};

  try {
    const officersDb = process.env.DB_OFFICERS || config.databases.officers;
    pool.useDatabase(officersDb);

    const [rows] = await pool.query(
      "SELECT db_name, classname FROM py_payrollclass WHERE status = 'active'",
    );

    rows.forEach((row) => {
      dbToClass[row.db_name] = row.classname;
      classToDb[row.classname] = row.db_name;
    });

    const others = rows.map((r) => r.db_name).filter((db) => db !== officersDb);
    databasesToSearch = [officersDb, ...others];
  } catch (err) {
    console.warn(
      "⚠️ py_payrollclass load failed, using env fallback:",
      err.message,
    );
    databasesToSearch = [
      process.env.DB_OFFICERS,
      process.env.DB_WOFFICERS,
      process.env.DB_RATINGS,
      process.env.DB_RATINGS_A,
      process.env.DB_RATINGS_B,
      process.env.DB_JUNIOR_TRAINEE,
    ].filter(Boolean);
  }

  return { databasesToSearch, dbToClass, classToDb };
}

function resolveToDbName(primaryClass, dbToClass, classToDb) {
  if (dbToClass[primaryClass]) return primaryClass;
  if (classToDb[primaryClass]) return classToDb[primaryClass];
  return null;
}

// ─────────────────────────────────────────────────────────────
// POST /login — full payroll login with class selection
//
// Password is NOT re-checked here. The user already authenticated
// via POST /api/auth/pre-login against hr_employees. By the time
// they reach this endpoint they hold a valid JWT. We only verify
// their class assignment and issue a class-scoped token.
// ─────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { user_id, payroll_class } = req.body;

  // Verify the pre-login token they already hold
  const bearerHeader = req.headers["authorization"];
  const preToken = bearerHeader?.startsWith("Bearer ")
    ? bearerHeader.split(" ")[1]
    : null;

  if (!preToken) {
    return res.status(401).json({ error: "Pre-login token required" });
  }

  let decoded;
  try {
    decoded = jwt.verify(preToken, config.jwt.secret);
  } catch (err) {
    return res
      .status(401)
      .json({ error: "Invalid or expired token. Please log in again." });
  }

  // Confirm token user matches submitted user_id
  if (decoded.user_id !== (user_id || "").trim()) {
    return res.status(403).json({ error: "Token mismatch" });
  }

  console.log("Class selection attempt:", { user_id, payroll_class });

  try {
    const { databasesToSearch, dbToClass, classToDb } =
      await loadPayrollMapping();

    let requestedDb = null;
    if (dbToClass[payroll_class]) requestedDb = payroll_class;
    else if (classToDb[payroll_class]) requestedDb = classToDb[payroll_class];

    if (!requestedDb) {
      console.log(`❌ Cannot resolve payroll_class: '${payroll_class}'`);
      return res.status(400).json({ error: "Invalid payroll class selected" });
    }

    const requestedClassName = dbToClass[requestedDb];
    console.log(
      `✅ Resolved '${payroll_class}' → db:'${requestedDb}' class:'${requestedClassName}'`,
    );

    // Find the user in the payroll users table for this class
    let authenticatedUser = null,
      authenticatedDatabase = null;

    for (const dbName of databasesToSearch) {
      if (!dbName) continue;
      try {
        pool.useDatabase(dbName);
        const [rows] = await pool.query(
          "SELECT * FROM users WHERE user_id = ?",
          [decoded.user_id],
        );
        if (!rows.length) continue;

        const user = rows[0];

        // Check account status and expiry
        if (user.status !== "active") continue;

        if (user.expiry_date) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          if (new Date(user.expiry_date) < today) continue;
        }

        // Check class matches
        const userPrimaryDb = resolveToDbName(
          user.primary_class,
          dbToClass,
          classToDb,
        );
        if (userPrimaryDb !== requestedDb) continue;

        authenticatedUser = user;
        authenticatedDatabase = dbName;
        break;
      } catch (err) {
        console.log(`❌ DB error (${dbName}):`, err.message);
      }
    }

    if (!authenticatedUser) {
      pool.useDatabase(config.databases.officers);

      // Give specific error where possible
      for (const dbName of databasesToSearch) {
        if (!dbName) continue;
        try {
          pool.useDatabase(dbName);
          const [rows] = await pool.query(
            "SELECT * FROM users WHERE user_id = ?",
            [decoded.user_id],
          );
          if (!rows.length) continue;
          const user = rows[0];

          if (user.status !== "active")
            return res
              .status(403)
              .json({ error: "Payroll account is inactive or suspended." });

          if (user.expiry_date) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (new Date(user.expiry_date) < today)
              return res
                .status(403)
                .json({
                  error:
                    "Payroll account has expired. Please contact administrator.",
                });
          }

          const userPrimaryDb = resolveToDbName(
            user.primary_class,
            dbToClass,
            classToDb,
          );
          if (userPrimaryDb !== requestedDb)
            return res
              .status(403)
              .json({
                error:
                  "Unauthorized payroll class. You can only login to your assigned class.",
              });
        } catch {}
      }

      return res
        .status(403)
        .json({ error: "Payroll access not found for this account." });
    }

    const tokenPayload = {
      user_id: authenticatedUser.user_id,
      full_name: decoded.full_name,
      email: decoded.email,
      role: authenticatedUser.user_role,
      primary_class: authenticatedUser.primary_class,
      current_class: requestedDb,
      created_in: authenticatedDatabase,
    };

    const token = jwtSign({
      data: tokenPayload,
      secret: config.jwt.secret,
      time: "8h",
    });

    pool.useDatabase(authenticatedDatabase);
    await pool.query("UPDATE users SET token = ? WHERE user_id = ?", [
      token,
      decoded.user_id,
    ]);

    pool.useDatabase(requestedDb);
    console.log(
      `✅ Class login successful for ${decoded.user_id} → db:${requestedDb}`,
    );

    res.json({
      message: "✅ Login successful",
      token,
      user: {
        user_id: authenticatedUser.user_id,
        full_name: decoded.full_name,
        email: decoded.email,
        role: authenticatedUser.user_role,
        status: authenticatedUser.status,
        primary_class: authenticatedUser.primary_class,
        current_class: requestedClassName,
      },
    });
  } catch (err) {
    pool.useDatabase(config.databases.officers);
    console.error("❌ Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /logout
// ─────────────────────────────────────────────────────────────
router.post("/logout", verifyToken, async (req, res) => {
  try {
    const bearerHeader = req.headers["authorization"];
    let token = null;
    if (bearerHeader && bearerHeader.startsWith("Bearer "))
      token = bearerHeader.split(" ")[1];
    if (!token && req.query.token) token = req.query.token;
    if (!token) return res.status(403).json({ message: "No token provided" });

    pool.useDatabase(config.databases.officers);
    await pool.query("UPDATE users SET token = NULL WHERE user_id = ?", [
      req.user_id,
    ]);
    return res.status(204).send();
  } catch (err) {
    console.error("❌ Logout error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /refresh
// ─────────────────────────────────────────────────────────────
router.post("/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token)
      return res.status(400).json({ message: "Please Log In" });

    const { message, decoded } = jwtVerify({
      token: refresh_token,
      secret: config.jwt.refreshSecret,
    });
    if (message || !decoded) return res.status(400).json({ message });

    const { classToDb } = await loadPayrollMapping();
    const dbName = classToDb[decoded.created_in] || decoded.created_in;

    pool.useDatabase(dbName);
    const [userRows] = await pool.query(
      "SELECT * FROM users WHERE user_id = ?",
      [decoded.user_id],
    );
    if (!userRows.length)
      return res.status(404).json({ message: "User not found" });

    const user = userRows[0];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (
      (user.expiry_date && new Date(user.expiry_date) < today) ||
      user.status !== "active"
    )
      return res.status(401).json({ message: "Please Log In." });

    const token = jwtSign({
      data: {
        user_id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        role: user.user_role,
        primary_class: user.primary_class,
        current_class: decoded.current_class,
        created_in: decoded.created_in,
      },
      secret: config.jwt.secret,
      time: "8h",
    });

    console.log(`🔄 Token refreshed for ${user.user_id}`);
    res.status(200).json({ message: "Token Refreshed", token });
  } catch (err) {
    console.error("❌ Refresh error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// USER CRUD
// ─────────────────────────────────────────────────────────────

router.get("/", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM users ORDER BY full_name ASC",
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /api/users/employee/:id for fullname autofill on user creation (payroll only)
router.get('/employee/:id', verifyToken, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT Empl_ID, Title, Surname, OtherName, email, gsm_number FROM hr_employees WHERE Empl_ID = ? LIMIT 1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
  res.json({ employee: rows[0] });
});

router.post("/", verifyToken, async (req, res) => {
  const {
    user_id,
    fullName,
    payroll_class,
    email,
    role,
    status,
    phone,
    expiryDate,
  } = req.body;
  try {
    if (!user_id || !fullName || !email || !role || !payroll_class)
      return res
        .status(400)
        .json({
          error:
            "User ID, Payroll Class, full name, email, and role are required",
        });

    const validStatuses = ["active", "inactive", "suspended"];
    const userStatus = status || "active";
    if (!validStatuses.includes(userStatus))
      return res
        .status(400)
        .json({
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });

    if (expiryDate) {
      const expiry = new Date(expiryDate);
      if (isNaN(expiry.getTime()))
        return res.status(400).json({ error: "Invalid expiry date format" });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (expiry < today)
        return res
          .status(400)
          .json({ error: "Expiry date cannot be in the past" });
    }

    // NOTE: no password column — authentication is handled via hr_employees.password
    await pool.query(
      `INSERT INTO users (user_id, full_name, primary_class, email, user_role, status, phone_number, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        fullName,
        payroll_class,
        email,
        role,
        userStatus,
        phone,
        expiryDate || null,
      ],
    );
    res.status(201).json({ message: "✅ User created", user_id });
  } catch (err) {
    console.error("❌ Error creating user:", err);
    if (err.code === "ER_DUP_ENTRY") {
      if (err.message.includes("PRIMARY") || err.message.includes("user_id"))
        return res
          .status(409)
          .json({ error: `User ID "${user_id}" already exists.` });
      if (err.message.includes("email"))
        return res
          .status(409)
          .json({ error: `Email "${email}" is already registered.` });
      return res
        .status(409)
        .json({ error: "A user with this ID or email already exists." });
    }
    res.status(500).json({ error: err.message || "Database error" });
  }
});

router.put("/:user_id", verifyToken, async (req, res) => {
  const {
    payroll_class,
    full_name,
    email,
    user_role,
    status,
    phone_number,
    expiry_date,
  } = req.body;
  // NOTE: password intentionally excluded — use /api/auth/change-password instead
  try {
    if (typeof status !== "undefined") {
      const validStatuses = ["active", "inactive", "suspended"];
      if (!validStatuses.includes(status))
        return res
          .status(400)
          .json({
            error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
          });
    }
    if (
      typeof expiry_date !== "undefined" &&
      expiry_date !== null &&
      expiry_date !== ""
    ) {
      const expiry = new Date(expiry_date);
      if (isNaN(expiry.getTime()))
        return res.status(400).json({ error: "Invalid expiry date format" });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (expiry < today)
        return res
          .status(400)
          .json({ error: "Expiry date cannot be in the past" });
    }

    const sets = [],
      params = [];
    if (typeof full_name !== "undefined") {
      sets.push("full_name = ?");
      params.push(full_name);
    }
    if (typeof email !== "undefined") {
      sets.push("email = ?");
      params.push(email);
    }
    if (typeof user_role !== "undefined") {
      sets.push("user_role = ?");
      params.push(user_role);
    }
    if (typeof status !== "undefined") {
      sets.push("status = ?");
      params.push(status);
    }
    if (typeof phone_number !== "undefined") {
      sets.push("phone_number = ?");
      params.push(phone_number);
    }
    if (typeof expiry_date !== "undefined") {
      sets.push("expiry_date = ?");
      params.push(expiry_date === "" ? null : expiry_date);
    }
    if (typeof payroll_class !== "undefined") {
      sets.push("primary_class = ?");
      params.push(payroll_class);
    }

    if (!sets.length)
      return res.status(400).json({ error: "No updatable fields provided" });

    params.push(req.params.user_id);
    const [result] = await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE user_id = ?`,
      params,
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "User not found" });

    const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [
      req.params.user_id,
    ]);
    res.json({ message: "User updated", user: rows[0] });
  } catch (err) {
    console.error("❌ Error updating user:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/:user_id", verifyToken, async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM users WHERE user_id = ?", [
      req.params.user_id,
    ]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "User not found" });
    res.json({ message: "✅ User deleted", user_id: req.params.user_id });
  } catch (err) {
    console.error("❌ Error deleting user:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ─────────────────────────────────────────────────────────────
// PAYROLL FORGOT PASSWORD
// These stay here because they require payroll class verification.
// Personnel (non-payroll) forgot password is handled in
// /api/auth/forgot-password (unified-login.js).
// ─────────────────────────────────────────────────────────────

async function findUserCandidates(user_id, databasesToSearch) {
  const candidates = [];
  for (const dbName of databasesToSearch) {
    if (!dbName) continue;
    try {
      pool.useDatabase(dbName);
      const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [
        user_id,
      ]);
      if (rows.length) {
        candidates.push({ user: rows[0], database: dbName });
        console.log(`✅ Found ${user_id} in ${dbName}`);
      }
    } catch (err) {
      console.log(`❌ Error searching ${dbName}:`, err.message);
    }
  }
  return candidates;
}

function checkIdentityMatch(
  user,
  full_name,
  primary_class,
  dbToClass,
  classToDb,
) {
  const nameOk =
    user.full_name?.toLowerCase().trim() === full_name.toLowerCase().trim();
  const userDbName =
    resolveToDbName(user.primary_class, dbToClass, classToDb) ??
    user.primary_class;
  const inputDbName =
    resolveToDbName(primary_class, dbToClass, classToDb) ?? primary_class;
  const classOk = userDbName === inputDbName;
  return { nameOk, classOk, ok: nameOk && classOk };
}

function identityErrorMsg(
  candidates,
  full_name,
  primary_class,
  dbToClass,
  classToDb,
) {
  const wrong = new Set();
  for (const { user } of candidates) {
    const { nameOk, classOk } = checkIdentityMatch(
      user,
      full_name,
      primary_class,
      dbToClass,
      classToDb,
    );
    if (!nameOk) wrong.add("Full Name");
    if (!classOk) wrong.add("Payroll Class");
  }
  const list = [...wrong];
  return (
    "Identity verification failed. " +
    (list.length
      ? `Incorrect: ${list.join(", ")}. Please check and try again.`
      : "Please check your information and try again.")
  );
}

router.post("/verify-identity", async (req, res) => {
  const { user_id, full_name, primary_class } = req.body;
  try {
    if (!user_id || !full_name || !primary_class)
      return res
        .status(400)
        .json({
          error:
            "User ID, Full Name, and Payroll Class are required for verification",
        });

    const { databasesToSearch, dbToClass, classToDb } =
      await loadPayrollMapping();
    const candidates = await findUserCandidates(user_id, databasesToSearch);

    if (!candidates.length)
      return res
        .status(404)
        .json({ error: "User not found. Please check your User ID." });

    let verifiedUser = null,
      verifiedDatabase = null;
    for (const { user, database } of candidates) {
      if (
        checkIdentityMatch(user, full_name, primary_class, dbToClass, classToDb)
          .ok
      ) {
        verifiedUser = user;
        verifiedDatabase = database;
        break;
      }
    }

    if (!verifiedUser)
      return res
        .status(401)
        .json({
          error: identityErrorMsg(
            candidates,
            full_name,
            primary_class,
            dbToClass,
            classToDb,
          ),
        });

    if (verifiedUser.status !== "active")
      return res
        .status(403)
        .json({
          error: "Account is not active. Please contact administrator.",
        });

    res.json({
      message: "Identity verified successfully",
      user: {
        user_id: verifiedUser.user_id,
        full_name: verifiedUser.full_name,
        primary_class: verifiedUser.primary_class,
      },
    });
  } catch (err) {
    console.error("❌ Identity verification error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  const { user_id, full_name, new_password, primary_class } = req.body;
  try {
    if (!user_id || !full_name || !primary_class || !new_password)
      return res.status(400).json({ error: "All fields are required" });
    if (new_password.length < 6)
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters long" });

    const { databasesToSearch, dbToClass, classToDb } =
      await loadPayrollMapping();
    const candidates = await findUserCandidates(user_id, databasesToSearch);

    if (!candidates.length)
      return res.status(404).json({ error: "User not found" });

    let verifiedUser = null,
      verifiedDatabase = null;
    for (const { user, database } of candidates) {
      if (
        checkIdentityMatch(user, full_name, primary_class, dbToClass, classToDb)
          .ok
      ) {
        verifiedUser = user;
        verifiedDatabase = database;
        break;
      }
    }

    if (!verifiedUser)
      return res
        .status(401)
        .json({
          error: identityErrorMsg(
            candidates,
            full_name,
            primary_class,
            dbToClass,
            classToDb,
          ),
        });

    pool.useDatabase(verifiedDatabase);
    // Password no longer stored in users table — nothing to update here.
    // hr_employees is the single password source, updated via /api/auth/forgot/reset-password.
    // This endpoint only handles payroll class verification for identity confirmation.
    // Redirect the actual reset to the unified auth endpoint.
    return res.status(400).json({
      error: "Use POST /api/auth/forgot/reset-password to reset your password.",
    });
  } catch (err) {
    console.error("❌ Password reset error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;