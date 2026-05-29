/**
 * FILE: routes/user-dashboard/emolument/admin/accept-verified.routes.js
 *
 * "Accept Verified Forms" — admin review of CPO_CONFIRMED forms
 * before they are pushed to payroll via the sync step.
 *
 * CPO_CONFIRMED = ef_personalinfos.Status = 'Verified'
 *                  ef_emolument_forms.status = 'CPO_CONFIRMED'
 *                  emolumentform = 'Yes'
 *
 * These forms have been confirmed by the CPO but not yet synced
 * to hr_employees (Status is still 'Verified', not yet 'Updated').
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  GET  /admin/verified                  → list all CPO_CONFIRMED
 *                                          not yet synced, grouped by class
 *                                          Query: ?payrollclass=1&ship=&command=
 *                                                 &page=1&pageSize=50
 *
 *  GET  /admin/verified/:svcno           → full form detail + approval trail
 *                                          for a single CPO_CONFIRMED personnel
 *
 *  POST /admin/verified/accept           → mark one or more forms as accepted
 *                                          (sets a local accepted_at timestamp
 *                                           — does NOT sync to hr_employees yet,
 *                                           that is done via /admin/payroll/sync)
 *                                          Body: { serviceNumbers: ['X123', ...] }
 *
 *  DELETE /admin/verified/:svcno/reject  → admin can still reject a CPO_CONFIRMED
 *                                          form if something is wrong before sync.
 *                                          Body: { ship, remarks }
 *                                          (wraps existing adminService.rejectForm
 *                                           via the form_id resolved from svcno)
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");

const verifyToken = require("../../../../middware/authentication");
const { requireEmolRole } = require("../../../../middware/emolumentAuth");
const repo = require("./accept-verified.repository");
const adminRepo = require("./admin.repository");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});
router.use(verifyToken, requireEmolRole("EMOL_ADMIN"));

// ─────────────────────────────────────────────────────────────
// GET /admin/verified
// Paginated list of CPO_CONFIRMED / Verified personnel
// who have not yet been synced to hr_employees.
// ─────────────────────────────────────────────────────────────

router.get("/verified", async (req, res) => {
  const filters = {
    payrollclass: req.query.payrollclass || undefined,
    ship: req.query.ship || undefined,
    command: req.query.command || undefined,
  };
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 50, 200);

  try {
    const { rows, total } = await repo.getPendingVerified(
      filters,
      pageSize,
      (page - 1) * pageSize,
    );
    return res.json({
      rows,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error("❌ GET /admin/verified:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/verified/:svcno
// Full form detail + approval trail for a single confirmed person.
// ─────────────────────────────────────────────────────────────

router.get("/verified/:svcno", async (req, res) => {
  const { svcno } = req.params;

  try {
    const form = await repo.getConfirmedFormDetail(svcno);
    if (!form)
      return res
        .status(404)
        .json({ error: `No CPO_CONFIRMED form found for ${svcno}.` });

    const approvals = await adminRepo.getFormApprovals(form.formId);

    return res.json({ ...form, approvals });
  } catch (err) {
    console.error("❌ GET /admin/verified/:svcno:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /admin/verified/accept
// Body: { serviceNumbers: ['X123', 'X456'] }
//
// Marks forms as admin-accepted (ef_personalinfos.accepted_at).
// This is a pre-sync acknowledgement step — the actual payroll
// push happens separately via POST /admin/payroll/sync.
//
// NOTE: accepted_at column must exist in ef_personalinfos.
// Migration: ALTER TABLE ef_personalinfos ADD COLUMN accepted_at DATETIME NULL;
// ─────────────────────────────────────────────────────────────

router.post("/verified/accept", async (req, res) => {
  const { serviceNumbers } = req.body;

  if (!Array.isArray(serviceNumbers) || serviceNumbers.length === 0)
    return res
      .status(400)
      .json({ error: "serviceNumbers must be a non-empty array." });

  try {
    const accepted = await repo.markAccepted(serviceNumbers, req.user_id);

    await adminRepo.insertAuditLog({
      tableName: "ef_form_approvals",
      action: "INSERT",
      recordKey: `ADMIN_ACCEPT:${serviceNumbers.length} records`,
      oldValues: null,
      newValues: {
        action: "ADMIN_ACCEPTED",
        accepted_by: req.user_id,
        count: accepted,
      },
      performedBy: req.user_id,
      ipAddress: req.ip,
    });

    return res.json({
      message: `${accepted} form(s) marked as accepted. Run payroll sync to push to hr_employees.`,
      data: { accepted, requested: serviceNumbers.length },
    });
  } catch (err) {
    console.error("❌ POST /admin/verified/accept:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /admin/verified/:svcno/reject
// Admin can reject a CPO_CONFIRMED form before payroll sync
// if a data issue is found post-confirmation.
// Body: { ship, remarks }
// ─────────────────────────────────────────────────────────────

router.delete("/verified/:svcno/reject", async (req, res) => {
  const { svcno } = req.params;
  const { ship, remarks } = req.body;

  if (!ship) return res.status(400).json({ error: "ship is required." });
  if (!remarks?.trim())
    return res.status(400).json({ error: "remarks is required." });

  try {
    // Resolve form_id for this personnel's confirmed form
    const formRow = await repo.getConfirmedFormDetail(svcno);
    if (!formRow)
      return res
        .status(404)
        .json({ error: `No CPO_CONFIRMED form found for ${svcno}.` });

    // Hard reject: clear ef_personalinfos + set ef_emolument_forms = REJECTED
    const reset = await repo.forceRejectConfirmedForm(
      svcno,
      formRow.formId,
      ship,
    );
    if (!reset)
      return res
        .status(409)
        .json({
          error:
            "Form could not be rejected (already synced or ship mismatch).",
        });

    await adminRepo.insertFormApproval({
      formId: formRow.formId,
      action: "REJECTED",
      fromStatus: "CPO_CONFIRMED",
      toStatus: "REJECTED",
      performedBy: req.user_id,
      performerRole: "EMOL_ADMIN",
      remarks: remarks.trim(),
    });

    await adminRepo.insertAuditLog({
      tableName: "ef_personalinfos",
      action: "UPDATE",
      recordKey: svcno,
      oldValues: { Status: "Verified", emolumentform: "Yes" },
      newValues: {
        Status: null,
        emolumentform: null,
        rejectedBy: req.user_id,
        remarks: remarks.trim(),
      },
      performedBy: req.user_id,
      ipAddress: req.ip,
    });

    return res.json({
      message: `Form for ${svcno} rejected. Personnel will need to re-fill and resubmit.`,
      data: {
        serviceNumber: svcno,
        formId: formRow.formId,
        newStatus: "REJECTED",
      },
    });
  } catch (err) {
    console.error("❌ DELETE /admin/verified/:svcno/reject:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
