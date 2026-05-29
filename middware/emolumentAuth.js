/**
 * EMOLUMENT SYSTEM — CONSOLIDATED AUTH MIDDLEWARE
 * FILE: middware/emolumentAuth.js
 *
 * Single source of truth for all emolument role-based access control.
 * Always used AFTER verifyToken — assumes req.user_id is populated.
 *
 * The pool uses AsyncLocalStorage for per-request DB isolation,
 * so pool.useDatabase() is safe under concurrent load.
 * DB context must already be set upstream (route level) before
 * these middlewares run — they do NOT call pool.useDatabase().
 *
 * ─── MIDDLEWARE MAP ─────────────────────────────────────────────
 *
 *  loadEmolRoles          → attach roles to req, no gate
 *  requirePersonnel       → gate: exists in ef_personalinfos
 *  requireEmolRole(role)  → gate: role + scope from req params/body/query
 *  requireFormRole(role)  → gate: role + scope resolved from :form_id
 *  requireShipAccess      → gate: DO or FO scoped to ship in params/body
 *  requireCommandAccess   → gate: CPO scoped to command in params/body
 *  requireAnyEmolRole     → gate: any elevated emolument role
 *
 * ─── USAGE EXAMPLES ─────────────────────────────────────────────
 *
 *  // Personnel fills their own form
 *  router.get('/form', verifyToken, requirePersonnel, handler);
 *
 *  // DO reviews — ship in req.params or req.body
 *  router.post('/ship/:ship/review', verifyToken, requireEmolRole('DO'), handler);
 *
 *  // FO approves a specific form — ship looked up from form_id
 *  router.post('/forms/:form_id/approve', verifyToken, requireFormRole('FO'), handler);
 *
 *  // CPO confirms — command in req.params or req.body
 *  router.post('/forms/:form_id/confirm', verifyToken, requireFormRole('CPO'), handler);
 *
 *  // Admin only
 *  router.get('/admin/reports', verifyToken, requireEmolRole('EMOL_ADMIN'), handler);
 *
 *  // Any ship officer or admin
 *  router.get('/dashboard', verifyToken, requireAnyEmolRole, handler);
 */

'use strict';

const pool = require('../config/db');

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: DB LOOKUPS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all active emolument roles for a user.
 * Returns array of { role, scope_type, scope_value }
 */
async function fetchEmolRoles(userId) {
  const [rows] = await pool.query(
    `SELECT role, scope_type, scope_value
     FROM ef_user_roles
     WHERE user_id = ? AND is_active = 1`,
    [userId],
  );
  return rows;
}

/**
 * Confirm user exists as active personnel in ef_personalinfos.
 */
async function isPersonnel(userId) {
  const [rows] = await pool.query(
    `SELECT serviceNumber FROM ef_personalinfos
     WHERE serviceNumber = ? LIMIT 1`,
    [userId],
  );
  return rows.length > 0;
}

/**
 * Resolve the ship and command for a given form_id from ef_emolument_forms.
 * Returns { ship, command } or null if form not found.
 */
async function resolveFormScope(formId) {
  const [rows] = await pool.query(
    `SELECT ship, command FROM ef_emolument_forms WHERE id = ? LIMIT 1`,
    [formId],
  );
  if (!rows.length) return null;
  return { ship: rows[0].ship, command: rows[0].command };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: SCOPE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve scope value for a given scope_type from the current request.
 * Checks req.params → req.body → req.query in order.
 *
 * @param {object} req
 * @param {'SHIP'|'COMMAND'|'GLOBAL'} scopeType
 * @returns {string|null}
 */
function resolveRequestScope(req, scopeType) {
  if (scopeType === 'SHIP') {
    return req.params?.ship   ||
           req.body?.ship     ||
           req.query?.ship    ||
           null;
  }
  if (scopeType === 'COMMAND') {
    return req.params?.command ||
           req.body?.command   ||
           req.query?.command  ||
           null;
  }
  return null; // GLOBAL — no value needed
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: ROLE CHECK (pure, no DB)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a roles array satisfies the required role + optional scope.
 *
 * @param {Array}  roles         — from fetchEmolRoles()
 * @param {string} requiredRole  — 'DO' | 'FO' | 'CPO' | 'EMOL_ADMIN'
 * @param {string|null} scopeValue — the ship name or command code to match
 * @returns {boolean}
 */
function hasRole(roles, requiredRole, scopeValue = null) {
  return roles.some((r) => {
    if (r.role !== requiredRole) return false;

    // GLOBAL scope always passes regardless of scopeValue
    if (r.scope_type === 'GLOBAL') return true;

    // Scoped role — scopeValue must be provided and must match
    if (!scopeValue) return false;
    return r.scope_value === scopeValue;
  });
}

/**
 * Check whether a user is an EMOL_ADMIN (shortcut).
 */
function isAdmin(roles) {
  return roles.some((r) => r.role === 'EMOL_ADMIN');
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: ATTACH ROLES TO REQ
// Shared logic used by multiple middlewares.
// ─────────────────────────────────────────────────────────────────────────────

async function attachRoles(req) {
  if (req.emolRoles) return; // already loaded this request
  req.emolRoles   = await fetchEmolRoles(req.user_id);
  req.isEmolAdmin = isAdmin(req.emolRoles);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE: loadEmolRoles
// Attaches emolRoles, isEmolAdmin, isPersonnel to req.
// No gate — use on routes that need role info but don't restrict access.
// ─────────────────────────────────────────────────────────────────────────────

const loadEmolRoles = async (req, res, next) => {
  if (!req.user_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    await attachRoles(req);
    req.isPersonnel = await isPersonnel(req.user_id);
    next();
  } catch (err) {
    console.error('❌ loadEmolRoles error:', err);
    res.status(500).json({ error: 'Server error loading emolument roles' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE: requirePersonnel
// Passes if user exists in ef_personalinfos.
// Baseline gate for all personnel-facing routes (own form, own status, etc).
// ─────────────────────────────────────────────────────────────────────────────

const requirePersonnel = async (req, res, next) => {
  if (!req.user_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const found = await isPersonnel(req.user_id);
    if (!found) {
      return res.status(403).json({
        error: 'Access denied. Personnel record not found.',
      });
    }

    await attachRoles(req);
    req.isPersonnel = true;
    next();
  } catch (err) {
    console.error('❌ requirePersonnel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE FACTORY: requireEmolRole(role)
// Gates access to users who hold the specified emolument role.
// Scope is resolved automatically from req.params / req.body / req.query.
// EMOL_ADMIN always bypasses.
//
// Use this when ship/command is explicit in the request:
//   POST /ship/:ship/review     → requireEmolRole('DO')
//   POST /command/:command/bulk → requireEmolRole('CPO')
//   GET  /admin/reports         → requireEmolRole('EMOL_ADMIN')
// ─────────────────────────────────────────────────────────────────────────────

const requireEmolRole = (requiredRole) => {
  return async (req, res, next) => {
    if (!req.user_id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      await attachRoles(req);

      // EMOL_ADMIN bypasses everything
      if (req.isEmolAdmin) {
        req.isPersonnel = true;
        return next();
      }

      // Determine scope value from request for the required role
      // We try both SHIP and COMMAND scope types since the role definition
      // tells us which applies — but we resolve both and let hasRole decide
      const shipVal    = resolveRequestScope(req, 'SHIP');
      const commandVal = resolveRequestScope(req, 'COMMAND');

      // hasRole checks each row's scope_type and matches accordingly
      const passes = req.emolRoles.some((r) => {
        if (r.role !== requiredRole) return false;
        if (r.scope_type === 'GLOBAL') return true;
        if (r.scope_type === 'SHIP')    return shipVal    && r.scope_value === shipVal;
        if (r.scope_type === 'COMMAND') return commandVal && r.scope_value === commandVal;
        return false;
      });

      if (!passes) {
        return res.status(403).json({
          error: `Access denied. Required emolument role: ${requiredRole}`,
        });
      }

      req.isPersonnel = await isPersonnel(req.user_id);
      next();
    } catch (err) {
      console.error(`❌ requireEmolRole(${requiredRole}) error:`, err);
      res.status(500).json({ error: 'Server error' });
    }
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE FACTORY: requireFormRole(role)
// Same as requireEmolRole but resolves scope from ef_emolument_forms
// using req.params.form_id when ship/command is not in the request itself.
//
// Use this on form-centric routes:
//   POST /forms/:form_id/review   → requireFormRole('DO')
//   POST /forms/:form_id/approve  → requireFormRole('FO')
//   POST /forms/:form_id/confirm  → requireFormRole('CPO')
//   POST /forms/:form_id/reject   → requireFormRole('DO') or any elevated
//
// Falls back to request params if form_id is not present (graceful degradation
// to requireEmolRole behaviour).
// ─────────────────────────────────────────────────────────────────────────────

const requireFormRole = (requiredRole) => {
  return async (req, res, next) => {
    if (!req.user_id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      await attachRoles(req);

      // EMOL_ADMIN bypasses everything
      if (req.isEmolAdmin) {
        req.isPersonnel = true;

        // Still resolve form scope and attach for downstream use
        const formId = req.params?.form_id || req.params?.id;
        if (formId) {
          req.formScope = await resolveFormScope(formId);
        }
        return next();
      }

      // Resolve scope from form
      const formId = req.params?.form_id || req.params?.id;
      if (!formId) {
        // No form_id — fall back to request-level scope (same as requireEmolRole)
        const shipVal    = resolveRequestScope(req, 'SHIP');
        const commandVal = resolveRequestScope(req, 'COMMAND');

        const passes = req.emolRoles.some((r) => {
          if (r.role !== requiredRole) return false;
          if (r.scope_type === 'GLOBAL') return true;
          if (r.scope_type === 'SHIP')    return shipVal    && r.scope_value === shipVal;
          if (r.scope_type === 'COMMAND') return commandVal && r.scope_value === commandVal;
          return false;
        });

        if (!passes) {
          return res.status(403).json({
            error: `Access denied. Required emolument role: ${requiredRole}`,
          });
        }

        req.isPersonnel = await isPersonnel(req.user_id);
        return next();
      }

      // Resolve ship and command from the form record
      const formScope = await resolveFormScope(formId);
      if (!formScope) {
        return res.status(404).json({ error: 'Form not found' });
      }

      req.formScope = formScope; // attach for downstream handlers

      const passes = req.emolRoles.some((r) => {
        if (r.role !== requiredRole) return false;
        if (r.scope_type === 'GLOBAL') return true;
        if (r.scope_type === 'SHIP')    return formScope.ship    && r.scope_value === formScope.ship;
        if (r.scope_type === 'COMMAND') return formScope.command && r.scope_value === formScope.command;
        return false;
      });

      if (!passes) {
        return res.status(403).json({
          error: `Access denied. Required emolument role: ${requiredRole}`,
        });
      }

      req.isPersonnel = await isPersonnel(req.user_id);
      next();
    } catch (err) {
      console.error(`❌ requireFormRole(${requiredRole}) error:`, err);
      res.status(500).json({ error: 'Server error' });
    }
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE: requireShipAccess
// Passes if user has DO or FO role scoped to the ship in req.params/body.
// Attaches req.user_ship and req.user_ship_role for downstream use.
// Use on ship-level list routes where you need to know if DO or FO.
// ─────────────────────────────────────────────────────────────────────────────

const requireShipAccess = async (req, res, next) => {
  if (!req.user_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const ship = req.params?.ship || req.body?.ship || req.query?.ship;
    if (!ship) {
      return res.status(400).json({ error: 'Ship name is required' });
    }

    await attachRoles(req);

    // EMOL_ADMIN bypasses
    if (req.isEmolAdmin) {
      req.user_ship      = ship;
      req.user_ship_role = 'EMOL_ADMIN';
      req.isPersonnel    = true;
      return next();
    }

    // Find the matching DO or FO role for this ship
    const matchingRole = req.emolRoles.find((r) =>
      ['DO', 'FO'].includes(r.role) &&
      (r.scope_type === 'GLOBAL' || (r.scope_type === 'SHIP' && r.scope_value === ship)),
    );

    if (!matchingRole) {
      return res.status(403).json({
        error: `Access denied. No DO or FO role for ship: ${ship}`,
      });
    }

    req.user_ship      = ship;
    req.user_ship_role = matchingRole.role; // 'DO' or 'FO'
    req.isPersonnel    = true;
    next();
  } catch (err) {
    console.error('❌ requireShipAccess error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE: requireCommandAccess
// Passes if user has CPO role scoped to the command in req.params/body.
// Attaches req.user_command for downstream use.
// ─────────────────────────────────────────────────────────────────────────────

const requireCommandAccess = async (req, res, next) => {
  if (!req.user_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const command = req.params?.command || req.body?.command || req.query?.command;
    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }

    await attachRoles(req);

    // EMOL_ADMIN bypasses
    if (req.isEmolAdmin) {
      req.user_command = command;
      req.isPersonnel  = true;
      return next();
    }

    const hasCPO = req.emolRoles.some((r) =>
      r.role === 'CPO' &&
      (r.scope_type === 'GLOBAL' || (r.scope_type === 'COMMAND' && r.scope_value === command)),
    );

    if (!hasCPO) {
      return res.status(403).json({
        error: `Access denied. No CPO role for command: ${command}`,
      });
    }

    req.user_command = command;
    req.isPersonnel  = true;
    next();
  } catch (err) {
    console.error('❌ requireCommandAccess error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE: requireAnyEmolRole
// Passes if user holds ANY active elevated emolument role.
// Use on shared dashboard/summary routes visible to DO, FO, CPO and admin.
// ─────────────────────────────────────────────────────────────────────────────

const requireAnyEmolRole = async (req, res, next) => {
  if (!req.user_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    await attachRoles(req);

    if (req.emolRoles.length === 0) {
      return res.status(403).json({
        error: 'Access denied. No elevated emolument role assigned.',
      });
    }

    req.isPersonnel = true;
    next();
  } catch (err) {
    console.error('❌ requireAnyEmolRole error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  loadEmolRoles,
  requirePersonnel,
  requireEmolRole,
  requireFormRole,
  requireShipAccess,
  requireCommandAccess,
  requireAnyEmolRole,

  // Expose internals for testing or route-level reuse
  fetchEmolRoles,
  resolveFormScope,
  hasRole,
  isAdmin,
};