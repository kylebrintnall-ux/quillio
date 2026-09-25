'use strict';

// Admin gate (LiveSpecs admin, Step 1). Restricts a route to the single admin
// user (users.is_admin = true). Reads the current user exactly like requireAuth
// does — session.userId → findUserById → row — so it follows the same pattern.
//
// Deliberately responds 404 (NOT 403) for every failure: not logged in, no
// database, user not found, or is_admin not true. A 403 would confirm the route
// exists to a non-admin; a 404 reveals nothing. This middleware is additive and
// does NOT change requireAuth or any existing route's behavior.
//
// STILL TRUE, AND requireAdminPage BELOW IS NOT AN EXCEPTION TO IT. Do not
// "fix" either of these to 403.

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

// THE PAGE GATE. Identical to requireAdmin in every refusal but ONE: a visitor
// with no session at all is sent to sign in instead of meeting the bare 404.
//
// WHY THIS IS NOT A WEAKENING OF THE RULE ABOVE. The 404 exists so the route's
// existence is not confirmed, and the population that is actually worth hiding
// it from is a SIGNED-IN NON-ADMIN TENANT — a customer poking at URLs, who must
// not learn there is a back office. That case is untouched: a request carrying a
// session whose user is not an admin still gets the bare 404, from requireAdmin,
// below.
//
// What changes is the anonymous case, and the concealment there was worth close
// to nothing: `/admin` is in every scanner wordlist ever written, so a 404 buys
// no real secrecy against someone already guessing at paths. It was, meanwhile,
// costing the one person the console is FOR — a signed-out admin met a dead end
// with no affordance, indistinguishable from a typo. Found the hard way: the
// admin console was unreachable and read as a dead service.
//
// AND IT IS THE PAGE ROUTE ONLY. Every /admin/api/* endpoint keeps requireAdmin
// and its 404 unchanged, deliberately: those are fetch()ed by admin.html, a 302
// to Google's consent screen would be followed and land as HTML or a CORS
// failure, and api() would surface something incomprehensible instead of the
// clean error it gets today. A redirect is right for a browser navigation and
// wrong for an XHR, so only the navigation gets one.
//
// The no-database branch stays a 404 rather than a redirect: sign-in needs the
// same database, so redirecting there would bounce the visitor between two
// routes that cannot complete.
function requireAdminPage(req, res, next) {
  if (!getPool()) return notFound(res);

  const userId = req.session && req.session.userId;
  // `redirect=admin` is on oauth.js's ALLOWED_REDIRECTS whitelist — the sign-in
  // flow refuses any destination not on it, so this cannot become an open
  // redirect however the query string is fiddled with.
  if (!userId) return res.redirect('/oauth/google?redirect=admin');

  // Everything else — the user lookup, the is_admin test, the error path — is
  // requireAdmin's, unchanged and not duplicated here. One implementation of
  // "is this an admin", reached two ways.
  return requireAdmin(req, res, next);
}

module.exports = { requireAdmin, requireAdminPage };
