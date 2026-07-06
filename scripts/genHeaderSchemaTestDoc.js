'use strict';

// Doc-header-template work, step 2 — generate real Google Docs that exercise the
// full createDocument() header path, so we can eyeball that BOTH a table header
// and a non-table header render correctly, and that the no-schema fallback still
// produces today's exact doc.
//
// It calls the REAL googleDocs.createDocument() with a fixed dummy body (a short
// summary / writer direction / one asset) and varies only the header:
//   • default  — no headerSchema  → today's header (title + HR)  [fallback proof]
//   • table    — SEED_TABLE_HEADER → the bordered metadata table (two-phase)
//   • text     — SEED_TEXT_HEADER  → heading + label lines + field row + rule
// The seed schemas are passed in-memory (no DB writes), so running this never
// mutates any tenant's stored schema.
//
// Usage:
//   railway run node scripts/genHeaderSchemaTestDoc.js            (all three)
//   railway run node scripts/genHeaderSchemaTestDoc.js table      (one variant)
//   railway run node scripts/genHeaderSchemaTestDoc.js stored <tenantId>
//       → render from the tenant's STORED schema (verifies the DB read path)
//
// Docs land in the configured DRIVE_FOLDER_ID.

const config = require('../src/config');
const { getClients } = require('../src/google');
const { getHeaderSchema } = require('../src/db');
const googleDocs = require('../src/destinations/googleDocs');
const { SEED_TABLE_HEADER, SEED_TEXT_HEADER } = require('../src/destinations/docHeaderSchema');

// A small, fixed body so the doc looks realistic below the header.
const DUMMY = {
  campaignTitle: 'Sample Campaign',
  summary: 'A short campaign summary goes here.',
  writerPrompt: 'Data-driven and punchy. Speak directly to support and CX leaders.',
  assetSpecs: [
    {
      assetType: 'Paid Social — LinkedIn',
      asset_direction: 'Confident, specific, no fluff.',
      channel: '',
      toneNotes: '',
      fields: [
        { fieldName: 'Headline', charMin: 0, charMax: 70, groupLabel: null },
        { fieldName: 'Body', charMin: 0, charMax: 150, groupLabel: null },
      ],
    },
  ],
};

async function genOne(clients, label, headerSchema) {
  const doc = await googleDocs.createDocument({
    brief: `Header test — ${label}`,
    campaignTitle: `${DUMMY.campaignTitle} (${label})`,
    summary: DUMMY.summary,
    writerPrompt: DUMMY.writerPrompt,
    assetSpecs: DUMMY.assetSpecs,
    folderId: config.DRIVE_FOLDER_ID,
    referenceLinks: [],
    referenceInsights: [],
    headerSchema,
    clients,
  });
  console.log(`\n[${label}] ${doc.url}`);
  return doc;
}

async function main() {
  const mode = (process.argv[2] || 'all').toLowerCase();
  const clients = await getClients();

  if (mode === 'stored') {
    const tenantId = process.argv[3];
    if (!tenantId) {
      console.error('[gen2] usage: genHeaderSchemaTestDoc.js stored <tenantId>');
      process.exit(1);
    }
    const schema = await getHeaderSchema(tenantId);
    console.log(`[gen2] stored schema for ${tenantId}: ${schema ? 'found' : 'none (→ default header)'}`);
    await genOne(clients, `stored:${tenantId}`, schema);
    console.log('\n[gen2] done.');
    process.exit(0);
  }

  const variants = {
    default: null,
    table: SEED_TABLE_HEADER,
    text: SEED_TEXT_HEADER,
  };

  const chosen = mode === 'all' ? Object.keys(variants) : [mode];
  for (const name of chosen) {
    if (!(name in variants)) {
      console.error(`[gen2] unknown variant "${name}". Use: all | default | table | text | stored`);
      process.exit(1);
    }
    await genOne(clients, name, variants[name]);
  }

  console.log('\n[gen2] done — open the URL(s) above.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[gen2] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
