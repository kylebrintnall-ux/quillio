'use strict';

// Minimal Postgres persistence (Phase 3 infrastructure). Best-effort: when
// DATABASE_URL is unset (the current single-tenant demo) every call logs and
// no-ops so nothing breaks. `pg` is lazy-required so it isn't needed until a
// database is actually configured.

let pool = null;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  const { Pool } = require('pg'); // lazy — only when a DB is configured
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

// Run a query. Returns the pg result, or null when there's no database
// configured (so callers can treat "no DB" and "no rows" the same way).
async function query(text, params) {
  const p = getPool();
  if (!p) return null;
  return p.query(text, params);
}

// --- Schema-not-yet-migrated tolerance ---
//
// Railway auto-deploys on merge, so CODE CAN SHIP BEFORE A MIGRATION RUNS. Any
// read or write against a table/column added in the same change must therefore
// degrade instead of throwing, or the deploy takes the product down until
// someone opens the Railway console.
//
// These identify the two Postgres errors that mean "that schema isn't there
// yet" — 42P01 undefined_table, 42703 undefined_column. Callers use them to fall
// back to the pre-migration behavior. They deliberately match ONLY those codes:
// a genuine failure (permissions, connectivity, a constraint) still throws.
const UNDEFINED_TABLE = '42P01';
const UNDEFINED_COLUMN = '42703';

function isUndefinedTable(err) {
  return !!(err && err.code === UNDEFINED_TABLE);
}
function isUndefinedColumn(err) {
  return !!(err && err.code === UNDEFINED_COLUMN);
}

// Warn once per missing relation. A pre-migration deploy should be obvious in
// the logs without emitting a line on every single request.
const warnedMissingSchema = new Set();
function warnMissingSchema(what, migration) {
  if (warnedMissingSchema.has(what)) return;
  warnedMissingSchema.add(what);
  console.warn(
    `[db] ${what} does not exist yet — using the pre-migration fallback. ` +
      `Run: node ${migration || 'scripts/migrateAddUserCredentials.js'}`
  );
}

// Upsert a tenant's voice guide. Requires a voice_guide table with a unique
// tenant_id and a raw_markdown column. Returns true if persisted.
async function saveVoiceGuide(tenantId, rawMarkdown) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping voice_guide save');
    return false;
  }
  await p.query(
    `INSERT INTO voice_guide (tenant_id, raw_markdown)
       VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET raw_markdown = EXCLUDED.raw_markdown`,
    [tenantId, rawMarkdown]
  );
  return true;
}

// Read a tenant's saved voice guide markdown. Returns the string, or null if
// there's no DB / no saved guide yet.
async function getVoiceGuide(tenantId) {
  const p = getPool();
  if (!p || !tenantId) return null;
  const res = await p.query('SELECT raw_markdown FROM voice_guide WHERE tenant_id = $1 LIMIT 1', [tenantId]);
  return (res && res.rows && res.rows[0] && res.rows[0].raw_markdown) || null;
}

// --- Tenant resolver (Phase 3) ---
// resolveTenant() always returns the same shape — { tenant, tokens, source } —
// whether it read from Postgres or synthesized from env vars. That lets callers
// consume a tenant the same way regardless of which path ran, so the pipeline
// can be migrated to per-tenant config without ever breaking the env-var demo.

// Look up a tenant by its id OR its Slack workspace id. Callers pass
// req.user.tenant_id (the tenant's id). For Slack tenants id == workspace_id ==
// team id, so either match works; for per-user Google tenants the id is a UUID
// and workspace_id is NULL, so we MUST match on id or the tenant is never found
// (which silently falls back to the env/demo tenant). Returns the row, or null
// if there's no DB or no match.
async function getTenantByWorkspace(workspaceId) {
  const res = await query(
    'SELECT * FROM tenants WHERE id = $1 OR workspace_id = $1 LIMIT 1',
    [workspaceId]
  );
  return res && res.rows && res.rows[0] ? res.rows[0] : null;
}

// DEPRECATED — superseded by db/users.js getUserBySlackIdentity (user_slack_links).
// Look up a tenant by the single (team, user) pair stored on its own row. Only
// ONE Slack identity fits per tenant, so a second person connecting Slack
// overwrote the first. Still read by resolveTenant as a fallback for links that
// scripts/migrateBackfillUserCredentials.js hasn't moved yet; the columns are
// intentionally not dropped. Returns the row, or null if there's no DB / no match.
async function getTenantBySlackLink(teamId, slackUserId) {
  const res = await query(
    'SELECT * FROM tenants WHERE slack_team_id = $1 AND slack_user_id = $2 LIMIT 1',
    [teamId, slackUserId]
  );
  return res && res.rows && res.rows[0] ? res.rows[0] : null;
}

// Look up one of a tenant's service tokens (slack_bot | slack_user | google | …).
// Returns the access_token string, or null if there's no DB / no match.
async function getTenantToken(tenantId, service) {
  const res = await query(
    'SELECT access_token FROM tenant_tokens WHERE tenant_id = $1 AND service = $2 LIMIT 1',
    [tenantId, service]
  );
  return res && res.rows && res.rows[0] ? res.rows[0].access_token : null;
}

// The env-var fallback tenant — same shape as the DB path. Used when there's no
// database, or no row for this workspace yet.
function envTenant(workspaceId) {
  return {
    user: null,
    tenant: {
      id: workspaceId || null,
      workspace_id: workspaceId || null,
      workspace_name: 'Quillio Inc.',
      plan: 'demo',
      onboarding_complete: true,
      default_folder_id: process.env.DRIVE_FOLDER_ID || null,
    },
    tokens: {
      slack_bot: process.env.SLACK_BOT_TOKEN || null,
      slack_user: process.env.SLACK_USER_TOKEN || null,
      google: process.env.GOOGLE_REFRESH_TOKEN || null,
    },
    source: 'env',
  };
}

// Resolve a tenant to { tenant, tokens, source, user }. Reads from Postgres when
// the workspace exists there; otherwise falls back to a synthesized env-var
// tenant with the identical shape.
//
// `user` is the ACTING user (a users row) when one is known, else null. It is
// what makes per-user credentials work: tokens are resolved for that user first
// and callers thread their id into Drive/Docs writes and project authorship.
//
// slackUserId is OPTIONAL and changes the resolution path:
//   - Omitted (web callers: routes/app.js, routes/settings.js) → workspace
//     lookup, env fallback if none. The acting user is whoever holds the
//     session, so web callers pass it explicitly as `actingUserId`.
//   - Provided (Slack callers) → the acting user is derived from the Slack
//     identity. With no DB we keep the env/demo fallback (don't refuse
//     offline). With a DB we go Slack identity → user → that user's tenant; if
//     the identity is unknown we return an "unlinked" sentinel
//     ({ tenant: null, tokens: null, source: 'db', unlinked: true }) rather than
//     silently falling back to the workspace/demo tenant — so /quillio refuses
//     users who haven't connected their own account.
async function resolveTenant(workspaceId, slackUserId, actingUserId) {
  // Web path (no Slack user). The acting user is supplied by the caller.
  if (!slackUserId) {
    const tenant = await getTenantByWorkspace(workspaceId);
    if (!tenant) return envTenant(workspaceId);
    let user = null;
    if (actingUserId) {
      try {
        const { findUserById } = require('./db/users'); // lazy — avoids a require cycle
        user = await findUserById(actingUserId);
      } catch (err) {
        console.warn('[db] acting user lookup failed — falling back to tenant tokens:', err.message);
      }
    }
    return {
      tenant,
      tokens: await resolveTenantTokens(tenant.id, user && user.id),
      source: 'db',
      user,
    };
  }

  // Slack path, no DB configured: keep the env/demo fallback (don't refuse).
  if (!getPool()) return envTenant(workspaceId);

  // Slack path with a DB. Preferred: the per-user link — Slack identity → user →
  // that user's tenant. Many people on one tenant can each hold their own link.
  const { getUserBySlackIdentity } = require('./db/users'); // lazy — avoids a require cycle
  const user = await getUserBySlackIdentity(workspaceId, slackUserId);
  if (user) {
    const tenant = await getTenantByWorkspace(user.tenant_id);
    if (tenant) {
      return { tenant, tokens: await resolveTenantTokens(tenant.id, user.id), source: 'db', user };
    }
    // A linked user whose tenant row is gone: refuse rather than fall through to
    // the env/demo tenant, which would build against a stranger's library.
    console.warn(
      `[db] slack link → user ${user.id}, whose tenant_id has no tenants row — treating as unlinked`
    );
    return { tenant: null, tokens: null, source: 'db', unlinked: true, user: null };
  }

  // DEPRECATED fallback: the legacy one-link-per-tenant columns
  // (tenants.slack_team_id / slack_user_id). Kept so a deploy that lands before
  // scripts/migrateBackfillUserCredentials.js has run doesn't refuse every
  // existing Slack user. The columns are not dropped; this path just goes quiet
  // once the backfill has moved the links onto user_slack_links.
  const linked = await getTenantBySlackLink(workspaceId, slackUserId);
  if (linked) {
    console.warn(
      '[db] resolved via the DEPRECATED tenants.slack_* link — ' +
        'run scripts/migrateBackfillUserCredentials.js to move it onto the user'
    );
    return { tenant: linked, tokens: await resolveTenantTokens(linked.id), source: 'db', user: null };
  }

  return { tenant: null, tokens: null, source: 'db', unlinked: true, user: null };
}

// Load the service tokens in the shape resolveTenant returns.
//
// Per-user credentials win over the tenant-level ones. `google` and `slack_user`
// belong to a person, so the acting user's own token is used when they have one
// and the tenant_tokens row is only a fallback for data that predates the
// per-user split. `slack_bot` is genuinely workspace-level (one bot install per
// Slack workspace) and stays tenant-scoped.
async function resolveTenantTokens(tenantId, userId) {
  let userGoogle = null;
  let userSlack = null;
  if (userId) {
    try {
      const { getUserToken } = require('./db/users'); // lazy — avoids a require cycle
      [userGoogle, userSlack] = await Promise.all([
        getUserToken(userId, 'google'),
        getUserToken(userId, 'slack_user'),
      ]);
    } catch (err) {
      console.warn('[db] user token lookup failed — falling back to tenant tokens:', err.message);
    }
  }
  return {
    slack_bot: await getTenantToken(tenantId, 'slack_bot'),
    slack_user: userSlack || (await getTenantToken(tenantId, 'slack_user')),
    google: userGoogle || (await getTenantToken(tenantId, 'google')),
  };
}

// --- Install-flow writes (Phase 3 Slack OAuth) ---

// Create a tenant row if one doesn't already exist. Matches the seed convention
// (id = workspace id). Returns true if the write ran, false if there's no DB.
async function createTenantIfMissing(workspaceId, workspaceName) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping createTenantIfMissing');
    return false;
  }
  await p.query(
    `INSERT INTO tenants (id, workspace_id, workspace_name, plan, onboarding_complete)
       VALUES ($1, $1, $2, 'demo', false)
     ON CONFLICT (id) DO NOTHING`,
    [workspaceId, workspaceName || null]
  );
  return true;
}

// Upsert one of a tenant's service tokens. Returns true if the write ran, false
// if there's no DB.
async function saveTenantToken(tenantId, service, accessToken) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping saveTenantToken');
    return false;
  }
  await p.query(
    `INSERT INTO tenant_tokens (tenant_id, service, access_token, updated_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, service) DO UPDATE
       SET access_token = EXCLUDED.access_token, updated_at = now()`,
    [tenantId, service, accessToken]
  );
  return true;
}

// DEPRECATED — superseded by db/users.js linkSlackIdentityToUser
// (user_slack_links). Records ONE Slack (team, user) pair on the tenant row, so
// two people on a tenant could never both be linked. No longer called from the
// install flow; kept (with its columns) only so existing rows keep resolving via
// the fallback in resolveTenant until the backfill migration runs.
// Returns true if the write ran, false if there's no DB / no tenant id.
async function linkSlackUserToTenant(tenantId, slackTeamId, slackUserId) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping linkSlackUserToTenant');
    return false;
  }
  if (!tenantId) return false;
  await p.query('UPDATE tenants SET slack_team_id = $2, slack_user_id = $3 WHERE id = $1', [
    tenantId,
    slackTeamId || null,
    slackUserId || null,
  ]);
  return true;
}

// Store a tenant's Figma OAuth tokens (Phase 4). Uses the dedicated figma_*
// columns added in Stage 1.1, on the tenant_tokens row keyed by service='figma'.
// `expiresAt` is a JS Date (absolute expiry) — Figma returns expires_in in
// seconds and the caller converts. Upsert so re-connecting refreshes in place.
// Returns true if the write ran, false if there's no DB. Tokens are never logged.
async function saveFigmaTokens(tenantId, { accessToken, refreshToken, expiresAt } = {}) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping saveFigmaTokens');
    return false;
  }
  await p.query(
    `INSERT INTO tenant_tokens
       (tenant_id, service, figma_access_token, figma_refresh_token, figma_token_expires_at, updated_at)
       VALUES ($1, 'figma', $2, $3, $4, now())
     ON CONFLICT (tenant_id, service) DO UPDATE
       SET figma_access_token = EXCLUDED.figma_access_token,
           figma_refresh_token = EXCLUDED.figma_refresh_token,
           figma_token_expires_at = EXCLUDED.figma_token_expires_at,
           updated_at = now()`,
    [tenantId, accessToken || null, refreshToken || null, expiresAt || null]
  );
  return true;
}

// Read a tenant's stored Figma OAuth tokens (Phase 4). Returns
// { accessToken, refreshToken, expiresAt: Date|null } from the service='figma'
// row, or null if there's no DB, no tenant, or no row yet. Never logs tokens.
async function getFigmaTokens(tenantId) {
  const p = getPool();
  if (!p || !tenantId) return null;
  const res = await p.query(
    `SELECT figma_access_token, figma_refresh_token, figma_token_expires_at
       FROM tenant_tokens WHERE tenant_id = $1 AND service = 'figma' LIMIT 1`,
    [tenantId]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    accessToken: r.figma_access_token || null,
    refreshToken: r.figma_refresh_token || null,
    expiresAt: r.figma_token_expires_at ? new Date(r.figma_token_expires_at) : null,
  };
}

// --- Doc-header template (doc-header-template work, step 2) ---
// A tenant's copy-doc header layout is stored as a block-based JSON schema
// (see destinations/docHeaderSchema.js) on the tenant's `templates` row. The
// templates table is one-to-many (a tenant may hold several later), but for now
// there's one schema per tenant — read/write the tenant's default (or only) row.

// Read a tenant's stored doc-header schema. Returns the parsed JSON object, or
// null if there's no DB, no tenant, or no stored schema (→ default header).
async function getHeaderSchema(tenantId) {
  const p = getPool();
  if (!p || !tenantId) return null;
  const res = await p.query(
    `SELECT doc_header_schema FROM templates
       WHERE tenant_id = $1 AND doc_header_schema IS NOT NULL
       ORDER BY is_default DESC, id ASC
       LIMIT 1`,
    [tenantId]
  );
  const r = res.rows[0];
  return (r && r.doc_header_schema) || null; // jsonb → already a JS object
}

// Store a tenant's doc-header schema onto its default template row (creating that
// row if the tenant has none yet). One schema per tenant for now. Returns true if
// the write ran, false if there's no DB. `schema` is a plain JS object.
async function saveHeaderSchema(tenantId, schema, name) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping saveHeaderSchema');
    return false;
  }
  if (!tenantId) return false;
  const json = JSON.stringify(schema);
  const existing = await p.query(
    `SELECT id FROM templates WHERE tenant_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1`,
    [tenantId]
  );
  if (existing.rows[0]) {
    await p.query('UPDATE templates SET doc_header_schema = $2::jsonb WHERE id = $1', [
      existing.rows[0].id,
      json,
    ]);
  } else {
    await p.query(
      `INSERT INTO templates (tenant_id, name, is_default, doc_header_schema)
         VALUES ($1, $2, true, $3::jsonb)`,
      [tenantId, name || 'Default', json]
    );
  }
  return true;
}

// --- File-naming convention (§3) ---
// Stored per tenant on the templates row (naming_pattern JSONB), same one-schema-
// per-tenant model as the doc-header schema.

// Read a tenant's stored file-naming pattern, or null (→ default naming).
async function getNamingPattern(tenantId) {
  const p = getPool();
  if (!p || !tenantId) return null;
  const res = await p.query(
    `SELECT naming_pattern FROM templates
       WHERE tenant_id = $1 AND naming_pattern IS NOT NULL
       ORDER BY is_default DESC, id ASC
       LIMIT 1`,
    [tenantId]
  );
  const r = res.rows[0];
  return (r && r.naming_pattern) || null; // jsonb → already a JS object
}

// Store a tenant's file-naming pattern onto its default template row (creating
// that row if none). Returns true if the write ran, false if there's no DB.
async function saveNamingPattern(tenantId, pattern, name) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping saveNamingPattern');
    return false;
  }
  if (!tenantId) return false;
  const json = JSON.stringify(pattern);
  const existing = await p.query(
    `SELECT id FROM templates WHERE tenant_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1`,
    [tenantId]
  );
  if (existing.rows[0]) {
    await p.query('UPDATE templates SET naming_pattern = $2::jsonb WHERE id = $1', [existing.rows[0].id, json]);
  } else {
    await p.query(
      `INSERT INTO templates (tenant_id, name, is_default, naming_pattern)
         VALUES ($1, $2, true, $3::jsonb)`,
      [tenantId, name || 'Default', json]
    );
  }
  return true;
}

// --- Copy-review state (re-review intelligence) ---
// Per copy doc, remember what the last review flagged and the copy state at that
// time (per field), so a re-review can recognize the writer's changes. Stored as
// one JSONB blob keyed by the doc id: { fields: { "<key>": { copy, comment } } }.

// Read a doc's stored review state, or null (→ treated as a first review).
async function getReviewState(docId) {
  const p = getPool();
  if (!p || !docId) return null;
  const res = await p.query('SELECT state FROM doc_reviews WHERE copy_doc_id = $1 LIMIT 1', [docId]);
  const r = res.rows[0];
  return (r && r.state) || null; // jsonb → already a JS object
}

// Upsert a doc's review state. Best-effort: returns true if the write ran.
async function saveReviewState(docId, state) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping saveReviewState');
    return false;
  }
  if (!docId) return false;
  await p.query(
    `INSERT INTO doc_reviews (copy_doc_id, state, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (copy_doc_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [docId, JSON.stringify(state || {})]
  );
  return true;
}

// Set a tenant's default Drive folder id (onboarding). Returns true if the
// write ran, false if there's no DB.
async function setTenantDefaultFolder(tenantId, folderId) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping setTenantDefaultFolder');
    return false;
  }
  if (!tenantId) return false;
  await p.query('UPDATE tenants SET default_folder_id = $2 WHERE id = $1', [tenantId, folderId || null]);
  return true;
}

// Mark a tenant's onboarding as complete (the step-6 finish action). This is the
// ONLY place onboarding_complete is set true for a real tenant — sign-in routing
// reads it to send finished users to the app instead of back into onboarding.
// Returns true if the write ran, false if there's no DB / no tenant id.
async function setTenantOnboardingComplete(tenantId) {
  const p = getPool();
  if (!p) {
    console.warn('[db] DATABASE_URL not set — skipping setTenantOnboardingComplete');
    return false;
  }
  if (!tenantId) return false;
  await p.query('UPDATE tenants SET onboarding_complete = true WHERE id = $1', [tenantId]);
  return true;
}

module.exports = {
  getPool,
  isUndefinedTable,
  isUndefinedColumn,
  warnMissingSchema,
  saveVoiceGuide,
  getVoiceGuide,
  getTenantByWorkspace,
  getTenantBySlackLink,
  getTenantToken,
  resolveTenant,
  createTenantIfMissing,
  saveTenantToken,
  linkSlackUserToTenant,
  saveFigmaTokens,
  getFigmaTokens,
  getHeaderSchema,
  saveHeaderSchema,
  getNamingPattern,
  saveNamingPattern,
  getReviewState,
  saveReviewState,
  setTenantDefaultFolder,
  setTenantOnboardingComplete,
};
