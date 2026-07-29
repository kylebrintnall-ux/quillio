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

// --- Per-user service tokens (user_tokens) ---
//
// Credentials that belong to a PERSON, not to a workspace. The tenant-level
// equivalents in db.js (getTenantToken / saveTenantToken) upsert on
// (tenant_id, service), so a second person on the same tenant silently replaced
// the first person's Google token and every subsequent Drive write ran as them.
// These are keyed on (user_id, service) instead.
//
// NOTE on the column name: like tenant_tokens, a Google *refresh* token lives in
// `access_token`. That misnomer is inherited deliberately so the forward
// migration is a straight column copy and both accessors read the same shape.

async function getUserToken(userId, service) {
  const pool = getPool();
  if (!pool || !userId || !service) return null;
  const res = await pool.query(
    'SELECT access_token FROM user_tokens WHERE user_id = $1 AND service = $2 LIMIT 1',
    [userId, service]
  );
  return (res.rows && res.rows[0] && res.rows[0].access_token) || null;
}

// Upsert one of a user's service tokens. Returns true if the write ran, false if
// there's no DB / no user. Tokens are never logged.
async function saveUserToken(userId, service, accessToken) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/users] DATABASE_URL not set — skipping saveUserToken');
    return false;
  }
  if (!userId || !service) return false;
  await pool.query(
    `INSERT INTO user_tokens (user_id, service, access_token, updated_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, service) DO UPDATE
       SET access_token = EXCLUDED.access_token, updated_at = now()`,
    [userId, service, accessToken]
  );
  return true;
}

// --- Slack identity → user (user_slack_links) ---
//
// Replaces the single tenants.slack_team_id / tenants.slack_user_id pair, which
// held exactly ONE linked Slack identity per tenant — so the second person to
// connect Slack overwrote the first, whose /quillio then failed the unlinked
// check. Here the identity is the unique key and it points at a USER; the tenant
// is derived from that user's users.tenant_id.

// The user behind a Slack (team, user) pair, or null. Returns the full users row
// so callers get tenant_id in the same round trip.
async function getUserBySlackIdentity(slackTeamId, slackUserId) {
  const pool = getPool();
  if (!pool || !slackTeamId || !slackUserId) return null;
  const res = await pool.query(
    `SELECT u.* FROM user_slack_links l
       JOIN users u ON u.id = l.user_id
      WHERE l.slack_team_id = $1 AND l.slack_user_id = $2
      LIMIT 1`,
    [slackTeamId, slackUserId]
  );
  return (res.rows && res.rows[0]) || null;
}

// A user's Slack links (they may belong to more than one workspace). Used by
// Settings to report connection status.
async function getSlackLinksForUser(userId) {
  const pool = getPool();
  if (!pool || !userId) return [];
  const res = await pool.query(
    'SELECT slack_team_id, slack_user_id FROM user_slack_links WHERE user_id = $1 ORDER BY id',
    [userId]
  );
  return res.rows || [];
}

// Claim a Slack identity for a user. Returns one of:
//   { ok: true,  conflict: false } — claimed, or already this user's (idempotent)
//   { ok: false, conflict: true  } — the pair already belongs to ANOTHER user
//   { ok: false, conflict: false } — no DB / missing args; nothing was attempted
//
// The conditional ON CONFLICT is what makes the three cases distinguishable
// without catching a 23505: the DO UPDATE only fires when the existing row is
// already this same user, so re-connecting is a no-op success while another
// user's claim matches zero rows. Callers MUST surface a conflict — silently
// swallowing it is what let someone see "Slack connected" while their commands
// kept resolving to a different tenant.
async function linkSlackIdentityToUser(userId, slackTeamId, slackUserId) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/users] DATABASE_URL not set — skipping linkSlackIdentityToUser');
    return { ok: false, conflict: false };
  }
  if (!userId || !slackTeamId || !slackUserId) return { ok: false, conflict: false };
  const res = await pool.query(
    `INSERT INTO user_slack_links (user_id, slack_team_id, slack_user_id)
          VALUES ($1, $2, $3)
     ON CONFLICT (slack_team_id, slack_user_id) DO UPDATE
            SET user_id = EXCLUDED.user_id, updated_at = now()
          WHERE user_slack_links.user_id = EXCLUDED.user_id
      RETURNING user_id`,
    [userId, slackTeamId, slackUserId]
  );
  if (res.rowCount === 1) return { ok: true, conflict: false };
  return { ok: false, conflict: true };
}

module.exports = {
  findUserByGoogleId,
  findUserById,
  createUser,
  getUserToken,
  saveUserToken,
  getUserBySlackIdentity,
  getSlackLinksForUser,
  linkSlackIdentityToUser,
};
