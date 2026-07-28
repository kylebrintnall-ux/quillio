'use strict';

// Web sign-in users (Phase 3 / Week 11). Backs "Sign in with Google": looks up
// or creates a user row keyed on their Google identity, and lets the session
// reload them by id. All operations degrade gracefully when DATABASE_URL is
// unset (no pg): finders return null, createUser returns null — so the keyless
// demo and the test suite run unchanged (auth then runs in demo mode).

const { getPool } = require('../db');

async function findUserByGoogleId(googleId) {
  const pool = getPool();
  if (!pool || !googleId) return null;
  const res = await pool.query('SELECT * FROM users WHERE google_id = $1 LIMIT 1', [googleId]);
  return (res.rows && res.rows[0]) || null;
}

// Reload a user by primary key — used by the auth middleware to hydrate
// req.user from the session's userId.
async function findUserById(id) {
  const pool = getPool();
  if (!pool || !id) return null;
  const res = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return (res.rows && res.rows[0]) || null;
}

// Create a user after a successful Google sign-in. Returns the saved row, or
// null if there's no DB. Best-effort: callers handle a null (demo mode).
async function createUser({ email, googleId, displayName, avatarUrl, tenantId, role = 'owner' } = {}) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/users] DATABASE_URL not set — skipping createUser');
    return null;
  }
  if (!email) {
    console.warn('[db/users] createUser called without an email — skipping');
    return null;
  }
  const res = await pool.query(
    `INSERT INTO users (email, google_id, display_name, avatar_url, tenant_id, role)
       VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [email, googleId || null, displayName || null, avatarUrl || null, tenantId || null, role]
  );
  return res.rows[0] || null;
}

module.exports = { findUserByGoogleId, findUserById, createUser };
