/**
 * FILE: routes/user-dashboard/emolument/admin/form-view.routes.js
 *
 * Admin-only form view endpoints.
 * Mounted at /admin by the emolument index router.
 *
 * These are separate from /form/* (which is personnel-self-service)
 * and /admin/forms/:svcno/* (inline in admin.routes.js).
 *
 * This file exposes the routes required by the "List" tab
 * View button in the personnel section: clicking View on any
 * personnel row opens a modal with their current form or
 * historical snapshot.
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  GET  /admin/form-view/:svcno/years         → available form years
 *  GET  /admin/form-view/:svcno/current       → current period form + approval trail
 *  GET  /admin/form-view/:svcno/history/:year → historical snapshot + approval trail
 *
 * All three endpoints already have full implementations in
 * admin.service.js (getPersonnelFormYears, getPersonnelCurrentForm,
 * getPersonnelFormHistory) and are also wired directly in
 * admin.routes.js as /admin/forms/:svcno/*.
 *
 * This file provides the /admin/form-view/:svcno/* alias path
 * used by the personnel list modal to avoid collision with the
 * form-action routes (/admin/forms/:form_id/reject) which use
 * a numeric :form_id, not a service number.
 *
 * ─────────────────────────────────────────────────────────────
 * NOTE: if you mount admin.routes.js and this file both under /admin,
 * ensure this file is required before admin.routes.js so the literal
 * segment 'form-view' is matched before the /:svcno catch-all.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../../../../config/db');
const config  = require('../../../../config');

const verifyToken         = require('../../../../middware/authentication');
const { requireEmolRole } = require('../../../../middware/emolumentAuth');
const adminService        = require('./admin.service');

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

router.use((req, res, next) => { pool.useDatabase(DB()); next(); });
router.use(verifyToken, requireEmolRole('EMOL_ADMIN'));

// ─────────────────────────────────────────────────────────────
// GET /admin/form-view/:svcno/years
// Returns list of form years available for this personnel.
// Used to populate the "Select Year" dropdown in the history modal.
// ─────────────────────────────────────────────────────────────

router.get('/form-view/:svcno/years', async (req, res) => {
  try {
    const result = await adminService.getPersonnelFormYears(req.params.svcno);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error('❌ GET /admin/form-view/:svcno/years:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/form-view/:svcno/current
// Current-period form data + full approval trail.
// ─────────────────────────────────────────────────────────────

router.get('/form-view/:svcno/current', async (req, res) => {
  try {
    const result = await adminService.getPersonnelCurrentForm(req.params.svcno);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error('❌ GET /admin/form-view/:svcno/current:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/form-view/:svcno/history/:year
// Historical snapshot + approval trail for a specific year.
// ─────────────────────────────────────────────────────────────

router.get('/form-view/:svcno/history/:year', async (req, res) => {
  const { svcno, year } = req.params;
  if (!/^\d{4}$/.test(year))
    return res.status(400).json({ error: 'year must be a 4-digit value.' });
  try {
    const result = await adminService.getPersonnelFormHistory(svcno, year);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error('❌ GET /admin/form-view/:svcno/history/:year:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;