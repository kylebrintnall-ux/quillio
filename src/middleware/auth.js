'use strict';

// Auth middleware (Phase 3 / Week 11). Gates the web app behind "Sign in with
// Google". Two intentional behaviors:
//
//  - DEMO MODE (no DATABASE_URL): there's no user system to enforce, so we
//    attach a demo user (the default tenant) and call next(). This keeps the
//    keyless /app demo — and the test suite — working unchanged.
//  - AUTHENTICATED MODE (DB configured): require a signed-in session. API
//    requests without one get a 401 JSON; page requests redirect to /onboarding.
//
// Never logs tokens or session contents.

const { getPool } = require('../db');
const { findUserById } = require('../db/users');

const DEMO_WORKSPACE_ID = 'T0B8LPRDKHR';

function requireAuth(req, res, next) {
  // Demo mode — no database, so no auth to enforce.
  if (!getPool()) {
    req.user = { id: null, email: null, tenant_id: DEMO_WORKSPACE_ID, role: 'owner', demo: true };
    return next();
  }

  const userId = req.session && req.session.userId;
  if (!userId) return denyUnauthenticated(req, res);

  // Hydrate req.user from the session. A lookup failure is treated as
  // unauthenticated rather than a 500.
  findUserById(userId)
    .then((user) => {
      if (!user) return denyUnauthenticated(req, res);
      req.user = user;
      return next();
    })
    .catch((err) => {
      console.error('[auth] user lookup failed:', err.message);
      return denyUnauthenticated(req, res);
    });
}

// API callers expect JSON; page navigations get sent to onboarding to sign in.
function denyUnauthenticated(req, res) {
  if (String(req.path || req.originalUrl || '').startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Sign in required' });
  }
  return res.redirect('/onboarding');
}

module.exports = { requireAuth };
