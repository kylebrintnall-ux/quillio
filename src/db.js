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

module.exports = { saveVoiceGuide };
