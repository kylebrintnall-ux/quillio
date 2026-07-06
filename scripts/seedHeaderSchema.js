'use strict';

// Doc-header-template work, step 2 — seed a tenant's copy-doc header schema
// (no UI/extraction yet). Stores one of the bundled seed schemas onto the
// tenant's default template row via db.saveHeaderSchema.
//
// Usage:
//   railway run node scripts/seedHeaderSchema.js <table|text> [tenantId]
//   railway run node scripts/seedHeaderSchema.js clear       [tenantId]
//
// `table` → the bordered two-column metadata table header.
// `text`  → the heading-plus-text header (heading, label lines, field row, rule).
// `clear` → remove the stored schema (tenant falls back to the default header).
// tenantId defaults to the demo workspace (T0B8LPRDKHR).
//
// After seeding, a normal brief for that tenant renders the copy doc with this
// header. Requires DATABASE_URL (and the templates.doc_header_schema column —
// run scripts/migrateAddHeaderSchema.js first).

const { saveHeaderSchema, getHeaderSchema } = require('../src/db');
const { seedSchema } = require('../src/destinations/docHeaderSchema');

const DEMO_TENANT_ID = 'T0B8LPRDKHR';

async function main() {
  const which = (process.argv[2] || '').toLowerCase();
  const tenantId = process.argv[3] || DEMO_TENANT_ID;

  if (!process.env.DATABASE_URL) {
    console.error('[seed-header] DATABASE_URL is not set — nothing to seed.');
    process.exit(1);
  }

  if (which === 'clear') {
    await saveHeaderSchema(tenantId, null, 'Default');
    console.log(`[seed-header] cleared header schema for tenant ${tenantId} (→ default header)`);
    process.exit(0);
  }

  const schema = seedSchema(which);
  if (!schema) {
    console.error(`[seed-header] unknown schema "${process.argv[2]}". Use: table | text | clear`);
    process.exit(1);
  }

  const ok = await saveHeaderSchema(tenantId, schema, 'Default');
  if (!ok) {
    console.error('[seed-header] save failed (no DB?).');
    process.exit(1);
  }

  // Read it back to confirm the round-trip.
  const stored = await getHeaderSchema(tenantId);
  const blockTypes = ((stored && stored.blocks) || []).map((b) => b.type).join(', ');
  console.log(`[seed-header] stored "${which}" header for tenant ${tenantId} — blocks: [${blockTypes}]`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-header] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
