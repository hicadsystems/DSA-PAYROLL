const express = require("express");
const pool = require("../../config/db"); // mysql2 pool
const verifyToken = require("../../middware/authentication");
const router = express.Router();

// py_title columns: Titlecode (PK), Description, user_created, user

// GET all titles
router.get("/", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT Titlecode, Description, user_created, user FROM py_title ORDER BY Titlecode",
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Validation — must be declared before /:Titlecode so "check" isn't
// swallowed by the param route
router.get("/check/:field/:value", verifyToken, async (req, res) => {
  const { field, value } = req.params;
  const { exclude } = req.query;

  // Only allow specific fields to prevent SQL injection
  const allowedFields = ["Titlecode"];
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: "Invalid field" });
  }

  try {
    let query = `SELECT ${field} FROM py_title WHERE ${field} = ?`;
    const params = [value];

    // If an exclude Titlecode is provided, exclude that record from the check
    if (exclude) {
      query += " AND Titlecode != ?";
      params.push(exclude);
    }

    const [existing] = await pool.query(query, params);

    res.json({ exists: existing.length > 0 });
  } catch (err) {
    console.error(`Error checking ${field}:`, err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET single title by code
router.get("/:Titlecode", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT Titlecode, Description, user_created, user FROM py_title WHERE Titlecode = ?",
      [req.params.Titlecode],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Title not found" });
    }
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE new title
router.post("/post", verifyToken, async (req, res) => {
  try {
    const { Titlecode, Description } = req.body;

    if (!Titlecode || !Titlecode.trim()) {
      return res.status(400).json({ error: "Title code is required" });
    }

    const currentUser = req.user_id || null;

    await pool.query(
      `INSERT INTO py_title (Titlecode, Description, user_created, user)
       VALUES (?, ?, ?, ?)`,
      [Titlecode.trim(), Description || null, currentUser, currentUser],
    );

    res.status(201).json({
      message: "New Title record created successfully",
      Titlecode: Titlecode.trim(),
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Title code already exists" });
    }
    res.status(500).json({ error: error.message });
  }
});

// UPDATE title
router.put("/:Titlecode", verifyToken, async (req, res) => {
  try {
    const { Description } = req.body;

    const [result] = await pool.query(
      "UPDATE py_title SET Description = ?, user = ? WHERE Titlecode = ?",
      [Description || null, req.user_id || null, req.params.Titlecode],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Title not found" });
    }

    res.json({ message: "Successfully updated a Title record" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE title
router.delete("/:Titlecode", verifyToken, async (req, res) => {
  try {
    const [result] = await pool.query(
      "DELETE FROM py_title WHERE Titlecode = ?",
      [req.params.Titlecode],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Title not found" });
    }

    res.json({ message: "Successfully deleted a Title record" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
