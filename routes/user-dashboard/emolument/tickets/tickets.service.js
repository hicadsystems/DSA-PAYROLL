// ─────────────────────────────────────────────────────────────
// tickets.service.js
// Business logic between routes and repo.
// ─────────────────────────────────────────────────────────────

"use strict";

const repo = require("./tickets.repository");

// ── Submit ticket (user) ─────────────────────────────────────
// user_id comes from req.user_id (set by verifyToken).
// Profile fields (name, ship, email, phone) are fetched from
// ef_personalinfos so the frontend cannot spoof them.
async function submitTicket({ user_id, subject, body, ip }) {
  if (!subject || !subject.trim()) {
    return { success: false, code: 400, message: "Subject is required." };
  }
  if (!body || !body.trim()) {
    return { success: false, code: 400, message: "Description is required." };
  }

  const profile = await repo.getPersonProfile(user_id);
  const full_name = profile
    ? [profile.Surname, profile.OtherName].filter(Boolean).join(" ")
    : user_id;

  const ticketData = {
    user_id,
    full_name,
    ship: profile?.ship || "",
    email: profile?.email || "",
    phone: profile?.gsm_number || "",
    subject: subject.trim(),
    body: body.trim(),
  };

  const id = await repo.createTicket(ticketData);

  await repo.insertAuditLog({
    tableName: "ef_tickets",
    action: "INSERT",
    recordKey: String(id),
    oldValues: null,
    newValues: { id, ...ticketData },
    performedBy: user_id,
    ipAddress: ip,
  });

  return { success: true, data: { id } };
}

// ── My tickets (user self-service) ───────────────────────────
async function myTickets(user_id) {
  const rows = await repo.getUserTickets(user_id);
  return { success: true, data: rows };
}

// ── All tickets (admin) ───────────────────────────────────────
async function listTickets({ status, search, page, pageSize } = {}) {
  const result = await repo.getAllTickets({ status, search, page, pageSize });
  return { success: true, data: result };
}

// ── Respond to ticket (admin) ─────────────────────────────────
async function respond({ id, response, admin_id, ip }) {
  if (!response || !response.trim()) {
    return { success: false, code: 400, message: "Response text is required." };
  }

  const existing = await repo.getTicketById(id);
  if (!existing) {
    return { success: false, code: 404, message: "Ticket not found." };
  }

  const affected = await repo.respondToTicket({
    id,
    response: response.trim(),
    responded_by: admin_id,
  });

  if (!affected) {
    return { success: false, code: 404, message: "Ticket not found." };
  }

  await repo.insertAuditLog({
    tableName: "ef_tickets",
    action: "RESPONDED",
    recordKey: String(id),
    oldValues: { status: existing.status, response: existing.response || null },
    newValues: {
      status: "responded",
      response: response.trim(),
      responded_by: admin_id,
    },
    performedBy: admin_id,
    ipAddress: ip,
  });

  return { success: true, message: "Response sent." };
}

// ── Close ticket (admin) ──────────────────────────────────────
async function closeTicket({ id, admin_id, ip }) {
  const existing = await repo.getTicketById(id);
  if (!existing) {
    return { success: false, code: 404, message: "Ticket not found." };
  }

  const affected = await repo.closeTicket(id);
  if (!affected) {
    return { success: false, code: 404, message: "Ticket not found." };
  }

  await repo.insertAuditLog({
    tableName: "ef_tickets",
    action: "CLOSED",
    recordKey: String(id),
    oldValues: { status: existing.status },
    newValues: { status: "closed", closed_by: admin_id },
    performedBy: admin_id,
    ipAddress: ip,
  });

  return { success: true, message: "Ticket closed." };
}

// ── Counts (admin dashboard badge) ───────────────────────────
async function counts() {
  const data = await repo.getTicketCounts();
  return { success: true, data };
}

module.exports = {
  submitTicket,
  myTickets,
  listTickets,
  respond,
  closeTicket,
  counts,
};
