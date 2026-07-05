'use strict';

// Phase 4 / Stage 1.1 — Figma integration schema. Adds the columns and table the
// Figma OAuth + template pipeline needs:
//   • tenant_tokens: figma_access_token, figma_refresh_token, figma_token_expires_at
//   • templates (new): the one-to-many template registry — a tenant may hold more
//     than one template though most use a single default (per PHASE4_ADDENDUM §2).
//     Columns: id, tenant_id (tenant ref), name, figma_file_key, is_default,
//     created_at.
//   • projects: template_id (FK → templates) and figma_project_file_key (the
//     project-specific Figma file created at brief time, Stage 2). Note the
//     projects table already carries a legacy, unused `figma_file_key` from the
//     Phase 3 schema — the new column is deliberately named differently.
//
// Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS, so it is
// safe to run repeatedly. Wrapped in a transaction. Matches the
// scripts/migrate*.js pattern (sslFor, DATABASE_URL required).
//
// Run on Railway with:  railway run node scripts/migrateAddFigmaSchema.js
// (or any env with DATABASE_URL set — e.g. a local Postgres for validation).

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Ordered so foreign-key references resolve: templates before the projects
// columns that reference it.
const STATEMENTS = [
  // tenant_tokens — Figma OAuth token storage (alongside the generic token cols).
  'ALTER TABLE tenant_tokens ADD COLUMN IF NOT EXISTS figma_access_token TEXT',
  'ALTER TABLE tenant_tokens ADD COLUMN IF NOT EXISTS figma_refresh_token TEXT',
  'ALTER TABLE tenant_tokens ADD COLUMN IF NOT EXISTS figma_token_expires_at TIMESTAMPTZ',

  // templates — one-to-many template registry. tenant_id references a tenant
  // (tenants.id), named consistently with the rest of the schema.
  `CREATE TABLE IF NOT EXISTS templates (
     id BIGSERIAL PRIMARY KEY,
     tenant_id TEXT REFERENCES tenants(id),
     name TEXT,
     figma_file_key TEXT,
     is_default BOOLEAN DEFAULT false,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,

  // projects — link a project to the template it was built from, and store the
  // project-specific Figma file key created at brief time (Stage 2).
  'ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES templates(id)',
  'ALTER TABLE projects ADD COLUMN IF NOT EXISTS figma_project_file_key TEXT',
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-figma] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-figma] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log(
      '[migrate-figma] done — tenant_tokens figma cols + templates table + projects.template_id/figma_project_file_key'
    );
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-figma] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
