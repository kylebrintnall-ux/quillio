'use strict';

// Admin gate (LiveSpecs admin, Step 1). Restricts a route to the single admin
// user (users.is_admin = true). Reads the current user exactly like requireAuth
// does — session.userId → findUserById → row — so it follows the same pattern.
//
// Deliberately responds 404 (NOT 403) for every failure: not logged in, no
// database, user not found, or is_admin not true. A 403 would confirm the route
// exists to a non-admin; a 404 reveals nothing. This middleware is additive and
// does NOT change requireAuth or any existing route's behavior.

const { getPool } = require('../db');
const { findUserById } = require('../db/users');

// Bare 404 — same shape a missing route would produce, no hint that /admin exists.
function notFound(res) {
  return res.status(404).send('Not Found');
}

function requireAdmin(req, res, next) {
  // No database (incl. the keyless demo): there is no real admin identity to
  // verify, so the gate is closed.
  if (!getPool()) return notFound(res);

  const userId = req.session && req.session.userId;
  if (!userId) return notFound(res);

  findUserById(userId)
    .then((user) => {
      if (!user || user.is_admin !== true) return notFound(res);
      req.user = user;
      return next();
    })
    .catch((err) => {
      console.error('[admin] user lookup failed:', err.message);
      return notFound(res);
    });
}

module.exports = { requireAdmin };
