'use strict';

// July 2026 spec tune: shorten organic social post copy to realistic working
// lengths and raise the on-graphic headline to current best practice. Matches
// src/data/defaultAssets.js.
//
//   • Organic Social — LinkedIn: Post Copy 3000 → 500 (platform hard cap is
//     ~3000, but a post that long never performs — 500 is the working ceiling).
//   • Organic Social — Instagram: Caption 2200 → 165 (keep it tight; detail
//     lives beyond the fold, hook lives up top).
//   • Graphic Headline 40/30 → 70 across all creative assets (Meta single /
//     carousel, Twitter/X, all three organic, plus Display Banner and DV360
//     responsive). 70 matches X's media-headline max and reads on a full
//     creative; the writer still trims for the smallest format when needed.
//
// Design: data-driven + idempotent. Char-spec UPDATEs by field name, matched by
// asset_types.name → every tenant carrying that asset is updated. Re-running is a
// no-op. Wrapped in a transaction.
//
// Run on Railway with:  railway run node scripts/migrateOrganicAndGraphicHeadlineSpecs.js
// (or any env with DATABASE_URL set — e.g. a local Postgres for validation).

// Each entry: { name, specs: { fieldName: [min, max], … } }
const CHANGES = [
  { name: 'Meta Single Image Ad', specs: { 'Graphic Headline': [0, 70] } },
  { name: 'Meta Carousel Ad', specs: { 'Graphic Headline': [0, 70] } },
  { name: 'Twitter/X Ad', specs: { 'Graphic Headline': [0, 70] } },
  { name: 'Display Banner — Standard', specs: { 'Graphic Headline': [0, 70] } },
  { name: 'Google DV360 / Responsive Display', specs: { 'Graphic Headline': [0, 70] } },
  { name: 'Organic Social — LinkedIn', specs: { 'Post Copy': [0, 500], 'Graphic Headline': [0, 70] } },
  { name: 'Organic Social — Instagram', specs: { 'Caption': [0, 165], 'Graphic Headline': [0, 70] } },
  { name: 'Organic Social — Twitter/X', specs: { 'Graphic Headline': [0, 70] } },
];

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-organic-gh] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-organic-gh] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  const stats = { types: 0, specSet: 0 };

  try {
    await client.connect();
    await client.query('BEGIN');

    for (const change of CHANGES) {
      const typesRes = await client.query('SELECT id FROM asset_types WHERE name = $1', [change.name]);
      for (const { id: typeId } of typesRes.rows) {
        stats.types++;
        for (const [field, [min, max]] of Object.entries(change.specs)) {
          const r = await client.query(
            'UPDATE copy_fields SET char_min = $3, char_max = $4 WHERE asset_type_id = $1 AND field_name = $2',
            [typeId, field, min, max]
          );
          stats.specSet += r.rowCount;
        }
      }
    }

    await client.query('COMMIT');
    console.log(`[migrate-organic-gh] done — asset_types touched=${stats.types}, specsSet=${stats.specSet}`);
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-organic-gh] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
