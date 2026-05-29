// ─────────────────────────────────────────────────────────────
// tickets.router.js
// Mount at:  app.use('/tickets', ticketsRouter)
// ─────────────────────────────────────────────────────────────

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");
const verifyToken = require("../../../../middware/authentication");
const {
  requireAnyEmolRole,
  requirePersonnel,
} = require("../../../../middware/emolumentAuth");
const svc = require("./tickets.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for all routes in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All routes require a valid token
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────
// USER ROUTES  (any authenticated personnel)
// ─────────────────────────────────────────────────────────────

// POST /tickets — submit a new ticket
router.post("/", requirePersonnel, async (req, res) => {
  try {
    const { subject, body } = req.body;
    const result = await svc.submitTicket({
      user_id: req.user_id,
      subject,
      body,
      ip: req.ip,
    });
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.status(201).json(result);
  } catch (err) {
    console.error("❌ POST /tickets:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /tickets/mine — logged-in user sees their own tickets
// Declared BEFORE /:id routes so 'mine' is not caught as a param.
router.get("/mine", requirePersonnel, async (req, res) => {
  try {
    const result = await svc.myTickets(req.user_id);
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /tickets/mine:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES  (elevated roles only)
// ─────────────────────────────────────────────────────────────

// GET /tickets/counts — badge counts for admin dashboard
// Declared BEFORE /:id routes so 'counts' is not caught as a param.
router.get("/counts", requireAnyEmolRole, async (req, res) => {
  try {
    const result = await svc.counts();
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /tickets/counts:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /tickets — all tickets, with optional ?status=&search=&page=&pageSize=
router.get("/", requireAnyEmolRole, async (req, res) => {
  try {
    const { status, search, page = 1, pageSize = 30 } = req.query;
    const result = await svc.listTickets({
      status,
      search,
      page: Number(page),
      pageSize: Number(pageSize),
    });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /tickets:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /tickets/:id/respond — admin sends a response
router.post("/:id/respond", requireAnyEmolRole, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid ticket ID." });
  }
  try {
    const { response } = req.body;
    const result = await svc.respond({
      id,
      response,
      admin_id: req.user_id,
      ip: req.ip,
    });
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message });
  } catch (err) {
    console.error("❌ POST /tickets/:id/respond:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PATCH /tickets/:id/close — admin closes a ticket
router.patch("/:id/close", requireAnyEmolRole, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid ticket ID." });
  }
  try {
    const result = await svc.closeTicket({
      id,
      admin_id: req.user_id,
      ip: req.ip,
    });
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message });
  } catch (err) {
    console.error("❌ PATCH /tickets/:id/close:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
