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

module.exports = {
  getPool,
  saveVoiceGuide,
  getVoiceGuide,
  getTenantByWorkspace,
  getTenantToken,
  resolveTenant,
  createTenantIfMissing,
  saveTenantToken,
  saveFigmaTokens,
  getFigmaTokens,
  getHeaderSchema,
  saveHeaderSchema,
  getNamingPattern,
  saveNamingPattern,
  setTenantDefaultFolder,
};
