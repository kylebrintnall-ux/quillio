'use strict';

// Phase 3 schema migration. Creates every table from the roadmap schema against
// DATABASE_URL. All statements use IF NOT EXISTS, so it's safe to run repeatedly.
// Run on Railway with: railway run node scripts/migrateDb.js
//
// Tables are ordered so foreign-key references resolve (tenants first, then the
// tables that reference them; asset_types before copy_fields/project_assets/etc).

const TABLES = [
  [
    'tenants',
    `CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      workspace_name TEXT,
      plan TEXT DEFAULT 'free',
      installed_at TIMESTAMPTZ DEFAULT now(),
      onboarding_complete BOOLEAN DEFAULT false,
      default_folder_id TEXT,
      default_doc_platform TEXT,
      default_design_platform TEXT
    )`,
  ],
  [
    'tenant_tokens',
    `CREATE TABLE IF NOT EXISTS tenant_tokens (
      tenant_id TEXT REFERENCES tenants(id),
      service TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      figma_access_token TEXT,
      figma_refresh_token TEXT,
      figma_token_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (tenant_id, service)
    )`,
  ],
  [
    'asset_types',
    `CREATE TABLE IF NOT EXISTS asset_types (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      name TEXT NOT NULL,
      "group" TEXT,
      is_active BOOLEAN DEFAULT true,
      sort_order INTEGER DEFAULT 0,
      spec_note TEXT
    )`,
  ],
  [
    'copy_fields',
    `CREATE TABLE IF NOT EXISTS copy_fields (
      id BIGSERIAL PRIMARY KEY,
      asset_type_id BIGINT REFERENCES asset_types(id),
      field_name TEXT NOT NULL,
      char_min INTEGER DEFAULT 0,
      char_max INTEGER DEFAULT 0,
      field_type TEXT,
      sort_order INTEGER DEFAULT 0,
      group_label TEXT
    )`,
  ],
  [
    'prompt_templates',
    `CREATE TABLE IF NOT EXISTS prompt_templates (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      asset_type_id BIGINT REFERENCES asset_types(id),
      field_name TEXT,
      prompt_text TEXT
    )`,
  ],
  [
    'personas',
    `CREATE TABLE IF NOT EXISTS personas (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      name TEXT,
      role TEXT,
      industry TEXT,
      pain_points TEXT,
      voice_notes TEXT
    )`,
  ],
  [
    'voice_guide',
    `CREATE TABLE IF NOT EXISTS voice_guide (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
      brand_personality TEXT,
      tone_guidance TEXT,
      words_to_use TEXT,
      words_to_avoid TEXT,
      audience_language TEXT,
      tone_reference TEXT,
      raw_markdown TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
  ],
  [
    // Templates precede projects so the projects.template_id FK resolves. Phase 4:
    // the one-to-many template registry (a tenant may hold more than one, though
    // most use a single default). tenant_id references a tenant (tenants.id),
    // named consistently with the rest of the schema.
    'templates',
    `CREATE TABLE IF NOT EXISTS templates (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      name TEXT,
      figma_file_key TEXT,
      doc_header_schema JSONB,
      naming_pattern JSONB,
      is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
  ],
  [
    'projects',
    `CREATE TABLE IF NOT EXISTS projects (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      name TEXT,
      drive_folder_id TEXT,
      drive_folder_url TEXT,
      copy_doc_id TEXT,
      copy_doc_url TEXT,
      deck_id TEXT,
      deck_url TEXT,
      figma_file_key TEXT,
      figma_project_file_key TEXT,
      template_id BIGINT REFERENCES templates(id),
      notion_page_id TEXT,
      slack_channel_id TEXT,
      slack_thread_ts TEXT,
      status TEXT DEFAULT 'draft',
      version INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
  ],
  [
    // Copy-review state: per copy doc, the last review's flagged notes + copy
    // state, so a re-review can recognize the writer's changes.
    'doc_reviews',
    `CREATE TABLE IF NOT EXISTS doc_reviews (
      copy_doc_id TEXT PRIMARY KEY,
      state JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
  ],
  [
    'project_assets',
    `CREATE TABLE IF NOT EXISTS project_assets (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT REFERENCES projects(id),
      asset_type_id BIGINT REFERENCES asset_types(id),
      copy_doc_id TEXT,
      figma_frame_prefix TEXT,
      status TEXT DEFAULT 'pending',
      assigned_to TEXT,
      approved_at TIMESTAMPTZ,
      version INTEGER DEFAULT 1
    )`,
  ],
  [
    'workflow_roles',
    `CREATE TABLE IF NOT EXISTS workflow_roles (
      tenant_id TEXT REFERENCES tenants(id),
      role TEXT NOT NULL,
      slack_user_id TEXT,
      slack_channel_id TEXT,
      PRIMARY KEY (tenant_id, role)
    )`,
  ],
  [
    'design_mappings',
    `CREATE TABLE IF NOT EXISTS design_mappings (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      tool TEXT,
      asset_type_id BIGINT REFERENCES asset_types(id),
      frame_prefix TEXT,
      field_name TEXT,
      layer_name TEXT
    )`,
  ],
  [
    'deck_templates',
    `CREATE TABLE IF NOT EXISTS deck_templates (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      deck_type TEXT,
      slides_template_id TEXT,
      layout_map JSONB
    )`,
  ],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    for (const [name, ddl] of TABLES) {
      await client.query(ddl);
      console.log('[migrate] created table: ' + name);
    }
    console.log('[migrate] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
