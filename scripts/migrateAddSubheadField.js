'use strict';

// July 2026 migration: add a `Subhead` copy field to paid social, display, and
// organic social asset types, matching src/data/defaultAssets.js. Subhead is a
// secondary supporting line beneath the headline — it exists so the Phase 4
// Figma population step can write it into a `[Subhead]` text layer by name.
//
//   • Paid social + organic social: Subhead 40–90 characters.
//   • Display (small / responsive canvas): Subhead 20–40 characters.
//   • Placed immediately after the asset's primary headline/copy field; the
//     canonical field order below fixes sort_order so it renders directly below
//     the headline in the Doc.
//
// Design: data-driven + idempotent, same engine as migrateAssetSpecFixes.js.
// Each asset's Subhead is inserted only if absent, then the full field order is
// re-applied (sort_order). Matching is by asset_types.name, so EVERY tenant
// carrying that asset is updated. Re-running is a no-op. Wrapped in a transaction.
//
// Run on Railway with:  railway run node scripts/migrateAddSubheadField.js
// (or any env with DATABASE_URL set — e.g. a local Postgres for validation).

// Each entry: { name, min, max, order }
//   min/max : Subhead character bounds for this asset
//   order   : final field order (also the field list) → sets sort_order
const CHANGES = [
  { name: 'LinkedIn Single Image Ad', min: 40, max: 90,
    order: ['Intro Text', 'Headline', 'Subhead', 'Graphic Headline', 'CTA Button', 'LAN Description'] },
  { name: 'LinkedIn Carousel Ad', min: 40, max: 90,
    order: ['Intro Text', 'Subhead', 'Graphic Headline', 'Card 1 Headline', 'Card 2 Headline', 'Card 3 Headline', 'Card 4 Headline', 'Card 5 Headline', 'CTA Button'] },
  { name: 'LinkedIn Single Image Ad — Variant A', min: 40, max: 90,
    order: ['Intro Text', 'Headline', 'Subhead', 'Graphic Headline', 'CTA Button'] },
  { name: 'LinkedIn Single Image Ad — Variant B', min: 40, max: 90,
    order: ['Intro Text', 'Headline', 'Subhead', 'Graphic Headline', 'CTA Button'] },
  { name: 'LinkedIn Single Image Ad — Variant C', min: 40, max: 90,
    order: ['Intro Text', 'Headline', 'Subhead', 'Graphic Headline', 'CTA Button'] },
  { name: 'LinkedIn Single Image Ad — Variant D', min: 40, max: 90,
    order: ['Intro Text', 'Headline', 'Subhead', 'Graphic Headline', 'CTA Button'] },
  { name: 'Meta Single Image Ad', min: 40, max: 90,
    order: ['Primary Text', 'Headline', 'Subhead', 'Graphic Headline', 'Description', 'CTA Button'] },
  { name: 'Meta Carousel Ad', min: 40, max: 90,
    order: ['Primary Text', 'Subhead', 'Graphic Headline', 'Card 1 Headline', 'Card 2 Headline', 'Card 3 Headline', 'Card 4 Headline', 'Card 5 Headline', 'Card Description', 'CTA Button'] },
  { name: 'Twitter/X Ad', min: 40, max: 90,
    order: ['Ad Copy', 'Headline', 'Subhead', 'Graphic Headline', 'CTA Button'] },
  { name: 'Display Banner — Standard', min: 20, max: 40,
    order: ['Headline', 'Subhead', 'Graphic Headline', 'Body Copy', 'CTA Button'] },
  { name: 'Google DV360 / Responsive Display', min: 20, max: 40,
    order: ['Short Headline', 'Subhead', 'Graphic Headline', 'Long Headline', 'Description', 'Business Name', 'CTA Button'] },
  { name: 'Organic Social — LinkedIn', min: 40, max: 90,
    order: ['Post Copy', 'Hook (first 150 chars, before See more)', 'Subhead', 'Headline (if link)'] },
  { name: 'Organic Social — Instagram', min: 40, max: 90,
    order: ['Caption', 'Hook (first 125 chars, before More)', 'Subhead', 'Alt Text'] },
  { name: 'Organic Social — Twitter/X', min: 40, max: 90,
    order: ['Post Copy', 'Subhead'] },
];

function sslFor(url) {
  // Local Postgres has no TLS; Railway/managed needs it. Detect localhost.
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-subhead] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-subhead] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  const stats = { types: 0, inserted: 0, reordered: 0 };

  try {
    await client.connect();
    await client.query('BEGIN');

    for (const change of CHANGES) {
      const typesRes = await client.query('SELECT id FROM asset_types WHERE name = $1', [change.name]);
      for (const { id: typeId } of typesRes.rows) {
        stats.types++;

        // Insert Subhead if absent. It inherits the asset's spec provenance,
        // falling back to the default library's values.
        const exists = await client.query(
          'SELECT 1 FROM copy_fields WHERE asset_type_id = $1 AND field_name = $2 LIMIT 1',
          [typeId, 'Subhead']
        );
        if (exists.rows.length === 0) {
          const provRes = await client.query(
            'SELECT spec_source, spec_version FROM copy_fields WHERE asset_type_id = $1 ORDER BY sort_order LIMIT 1',
            [typeId]
          );
          const specSource = (provRes.rows[0] && provRes.rows[0].spec_source) || 'quillio_default';
          const specVersion = (provRes.rows[0] && provRes.rows[0].spec_version) || '1.0';
          await client.query(
            `INSERT INTO copy_fields
               (asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_source, spec_version)
             VALUES ($1, 'Subhead', $2, $3, 'text', 0, $4, $5)`,
            [typeId, change.min, change.max, specSource, specVersion]
          );
          stats.inserted++;
        }

        // Canonical field order → sort_order (idempotent). This drops Subhead
        // into its slot directly below the headline.
        for (let i = 0; i < change.order.length; i++) {
          const r = await client.query(
            'UPDATE copy_fields SET sort_order = $3 WHERE asset_type_id = $1 AND field_name = $2',
            [typeId, change.order[i], i + 1]
          );
          stats.reordered += r.rowCount;
        }
      }
    }

    await client.query('COMMIT');
    console.log(
      `[migrate-subhead] done — asset_types touched=${stats.types}, subheadsInserted=${stats.inserted}, reordered=${stats.reordered}`
    );
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-subhead] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
