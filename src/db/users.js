'use strict';

// Web sign-in users (Phase 3 / Week 11). Backs "Sign in with Google": looks up
// or creates a user row keyed on their Google identity, and lets the session
// reload them by id. All operations degrade gracefully when DATABASE_URL is
// unset (no pg): finders return null, createUser returns null — so the keyless
// demo and the test suite run unchanged (auth then runs in demo mode).

const { getPool, isUndefinedTable, warnMissingSchema } = require('../db');

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

// Returns the token, or null — including when user_tokens doesn't exist yet
// (code shipped ahead of the migration), in which case the caller falls back to
// the tenant-level token exactly as it did before the per-user split.
async function getUserToken(userId, service) {
  const pool = getPool();
  if (!pool || !userId || !service) return null;
  try {
    const res = await pool.query(
      'SELECT access_token FROM user_tokens WHERE user_id = $1 AND service = $2 LIMIT 1',
      [userId, service]
    );
    return (res.rows && res.rows[0] && res.rows[0].access_token) || null;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('user_tokens');
      return null;
    }
    throw err;
  }
}

// Upsert one of a user's service tokens. Returns true if the write ran, false if
// there's no DB / no user / the table doesn't exist yet. Tokens are never logged.
//
// Returning false rather than throwing on a missing table matters: this is
// called from the Google sign-in callback, and a throw there aborts the whole
// callback and sends the user to /app?error=google_failed — i.e. a
// deploy-before-migration would break sign-in entirely.
async function saveUserToken(userId, service, accessToken) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/users] DATABASE_URL not set — skipping saveUserToken');
    return false;
  }
  if (!userId || !service) return false;
  try {
    await pool.query(
      `INSERT INTO user_tokens (user_id, service, access_token, updated_at)
         VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, service) DO UPDATE
         SET access_token = EXCLUDED.access_token, updated_at = now()`,
      [userId, service, accessToken]
    );
    return true;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('user_tokens');
      return false;
    }
    throw err;
  }
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
// Returns the user, or null — including when user_slack_links doesn't exist yet
// (code shipped ahead of the migration). Returning null is what lets
// resolveTenant fall through to the DEPRECATED tenants.slack_* read, so every
// existing Slack user keeps working during a deploy-before-migration window.
async function getUserBySlackIdentity(slackTeamId, slackUserId) {
  const pool = getPool();
  if (!pool || !slackTeamId || !slackUserId) return null;
  try {
    const res = await pool.query(
      `SELECT u.* FROM user_slack_links l
         JOIN users u ON u.id = l.user_id
        WHERE l.slack_team_id = $1 AND l.slack_user_id = $2
        LIMIT 1`,
      [slackTeamId, slackUserId]
    );
    return (res.rows && res.rows[0]) || null;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('user_slack_links');
      return null;
    }
    throw err;
  }
}

// A user's Slack links (they may belong to more than one workspace). Used by
// Settings to report connection status. Degrades to [] when the table doesn't
// exist yet, so Settings falls back to the tenant-row link instead of 500ing.
async function getSlackLinksForUser(userId) {
  const pool = getPool();
  if (!pool || !userId) return [];
  try {
    const res = await pool.query(
      'SELECT slack_team_id, slack_user_id FROM user_slack_links WHERE user_id = $1 ORDER BY id',
      [userId]
    );
    return res.rows || [];
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('user_slack_links');
      return [];
    }
    throw err;
  }
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
  try {
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
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    warnMissingSchema('user_slack_links');
    return legacyLinkSlackIdentity(userId, slackTeamId, slackUserId);
  }
}

// Pre-migration fallback for linkSlackIdentityToUser: write the OLD one-link-
// per-tenant pair on the user's tenant row, which resolveTenant still reads.
// Slack connect therefore keeps working when the code ships before the
// migration — with the old one-person-per-tenant limitation, but nothing breaks.
//
// The conflict is STILL surfaced here: the legacy write is guarded by the
// partial unique index uq_tenants_slack_link, whose 23505 maps to the same
// { conflict: true } the caller already handles. That's the whole point of the
// fix — a taken Slack identity must never be reported as connected.
async function legacyLinkSlackIdentity(userId, slackTeamId, slackUserId) {
  const user = await findUserById(userId);
  if (!user || !user.tenant_id) return { ok: false, conflict: false };
  const { linkSlackUserToTenant } = require('../db'); // lazy — avoids a require cycle
  try {
    const ok = await linkSlackUserToTenant(user.tenant_id, slackTeamId, slackUserId);
    return { ok: !!ok, conflict: false, legacy: true };
  } catch (err) {
    if (err && err.code === '23505') return { ok: false, conflict: true, legacy: true };
    throw err;
  }
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
