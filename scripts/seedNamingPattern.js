'use strict';

// File-naming convention (§3) — seed a tenant's naming pattern (no UI yet).
// Stores the §3 worked-example pattern (SVC: {campaign}_ Promo Copy) so a real
// brief's generated doc uses it, or clears it back to the default naming.
//
// Usage:
//   railway run node scripts/seedNamingPattern.js         [tenantId]
//   railway run node scripts/seedNamingPattern.js clear   [tenantId]
//
// tenantId defaults to the demo workspace (T0B8LPRDKHR). Requires DATABASE_URL
// (+ the templates.naming_pattern column — run npm run migrate-naming first).

const { saveNamingPattern, getNamingPattern } = require('../src/db');
const { SAMPLE_NAMING_PATTERN } = require('../src/destinations/docNaming');

const DEMO_TENANT_ID = 'T0B8LPRDKHR';

async function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  const clear = arg === 'clear';
  const tenantId = (clear ? process.argv[3] : process.argv[2]) || DEMO_TENANT_ID;

  if (!process.env.DATABASE_URL) {
    console.error('[seed-naming] DATABASE_URL is not set — nothing to seed.');
    process.exit(1);
  }

  if (clear) {
    await saveNamingPattern(tenantId, { version: 1, segments: [] }, 'Default');
    console.log(`[seed-naming] cleared naming pattern for tenant ${tenantId} (→ default naming)`);
    process.exit(0);
  }

  const ok = await saveNamingPattern(tenantId, SAMPLE_NAMING_PATTERN, 'Default');
  if (!ok) {
    console.error('[seed-naming] save failed (no DB?).');
    process.exit(1);
  }
  const stored = await getNamingPattern(tenantId);
  const preview = ((stored && stored.segments) || [])
    .map((s) => (s.type === 'dynamic' ? '{' + s.token + '}' : s.text))
    .join('');
  console.log(`[seed-naming] stored pattern for tenant ${tenantId}:  ${preview}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-naming] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
