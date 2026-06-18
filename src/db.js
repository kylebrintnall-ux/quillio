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

// --- Tenant resolver (Phase 3) ---
// resolveTenant() always returns the same shape — { tenant, tokens, source } —
// whether it read from Postgres or synthesized from env vars. That lets callers
// consume a tenant the same way regardless of which path ran, so the pipeline
// can be migrated to per-tenant config without ever breaking the env-var demo.

// Look up a tenant by Slack workspace id. Returns the row, or null if there's
// no DB or no match.
async function getTenantByWorkspace(workspaceId) {
  const res = await query('SELECT * FROM tenants WHERE workspace_id = $1 LIMIT 1', [workspaceId]);
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

// Resolve a tenant to { tenant, tokens, source }. Reads from Postgres when the
// workspace exists there; otherwise falls back to a synthesized env-var tenant
// with the identical shape.
async function resolveTenant(workspaceId) {
  const tenant = await getTenantByWorkspace(workspaceId);
  if (!tenant) return envTenant(workspaceId);

  const tokens = {
    slack_bot: await getTenantToken(tenant.id, 'slack_bot'),
    slack_user: await getTenantToken(tenant.id, 'slack_user'),
    google: await getTenantToken(tenant.id, 'google'),
  };
  return { tenant, tokens, source: 'db' };
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

module.exports = {
  saveVoiceGuide,
  getTenantByWorkspace,
  getTenantToken,
  resolveTenant,
  createTenantIfMissing,
  saveTenantToken,
};
