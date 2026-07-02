'use strict';

// July 2026 migration: introduce the "Graphic Copy" field group on paid social,
// display, and organic social asset types, matching src/data/defaultAssets.js.
// The on-graphic copy (Graphic Headline, Subhead, and CTA on paid/display) is
// tagged with group_label='Graphic Copy' so the Doc renders it under one
// indented sub-heading and the Phase 4 Figma step can map it as a unit.
//
// Alongside the grouping this also:
//   • adds copy_fields.group_label (idempotent ALTER),
//   • merges the Display Banner's redundant plain "Headline" into Graphic
//     Headline (deletes the plain "Headline" — a static banner is all on-graphic),
//   • adds a Graphic Headline (0–40) to the three organic social assets, whose
//     post has a graphic with a headline + subhead (no CTA),
//   • re-applies the canonical field order (sort_order) so grouped fields sit
//     contiguously below the headline.
//
// Design: data-driven + idempotent, same engine as the earlier spec migrations.
// Matching is by asset_types.name → every tenant carrying that asset is updated.
// Re-running is a no-op. Wrapped in a transaction.
//
// Run on Railway with:  railway run node scripts/migrateAddGraphicCopyGroup.js
// (or any env with DATABASE_URL set — e.g. a local Postgres for validation).

// Each entry: { name, deletes?, inserts?, group, order }
//   deletes : [fieldName, …]              remove a field (merge/cleanup)
//   inserts : [[fieldName, min, max], …]  add a field if absent
//   group   : [fieldName, …]              fields tagged group_label='Graphic Copy'
//                                         (all others on the asset → NULL)
//   order   : [fieldName, …]              final field order → sets sort_order
const GROUP = 'Graphic Copy';
const CHANGES = [
  { name: 'LinkedIn Single Image Ad',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'Subhead', 'CTA Button', 'LAN Description'] },
  { name: 'LinkedIn Carousel Ad',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Intro Text', 'Graphic Headline', 'Subhead', 'CTA Button', 'Card 1 Headline', 'Card 2 Headline', 'Card 3 Headline', 'Card 4 Headline', 'Card 5 Headline'] },
  { name: 'LinkedIn Single Image Ad — Variant A',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'Subhead', 'CTA Button'] },
  { name: 'LinkedIn Single Image Ad — Variant B',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'Subhead', 'CTA Button'] },
  { name: 'LinkedIn Single Image Ad — Variant C',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'Subhead', 'CTA Button'] },
  { name: 'LinkedIn Single Image Ad — Variant D',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'Subhead', 'CTA Button'] },
  { name: 'Meta Single Image Ad',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Primary Text', 'Headline', 'Description', 'Graphic Headline', 'Subhead', 'CTA Button'] },
  { name: 'Meta Carousel Ad',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Primary Text', 'Graphic Headline', 'Subhead', 'CTA Button', 'Card 1 Headline', 'Card 2 Headline', 'Card 3 Headline', 'Card 4 Headline', 'Card 5 Headline', 'Card Description'] },
  { name: 'Twitter/X Ad',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Ad Copy', 'Headline', 'Graphic Headline', 'Subhead', 'CTA Button'] },
  { name: 'Display Banner — Standard',
    deletes: ['Headline'],
    group: ['Graphic Headline', 'Subhead', 'Body Copy', 'CTA Button'],
    order: ['Graphic Headline', 'Subhead', 'Body Copy', 'CTA Button'] },
  { name: 'Google DV360 / Responsive Display',
    group: ['Graphic Headline', 'Subhead', 'CTA Button'],
    order: ['Short Headline', 'Long Headline', 'Description', 'Business Name', 'Graphic Headline', 'Subhead', 'CTA Button'] },
  { name: 'Organic Social — LinkedIn',
    inserts: [['Graphic Headline', 0, 40]],
    group: ['Graphic Headline', 'Subhead'],
    order: ['Post Copy', 'Hook (first 150 chars, before See more)', 'Graphic Headline', 'Subhead', 'Headline (if link)'] },
  { name: 'Organic Social — Instagram',
    inserts: [['Graphic Headline', 0, 40]],
    group: ['Graphic Headline', 'Subhead'],
    order: ['Caption', 'Hook (first 125 chars, before More)', 'Graphic Headline', 'Subhead', 'Alt Text'] },
  { name: 'Organic Social — Twitter/X',
    inserts: [['Graphic Headline', 0, 40]],
    group: ['Graphic Headline', 'Subhead'],
    order: ['Post Copy', 'Graphic Headline', 'Subhead'] },
];

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-graphic-copy] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-graphic-copy] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  const stats = { types: 0, deleted: 0, inserted: 0, grouped: 0, cleared: 0, reordered: 0 };

  try {
    await client.connect();
    await client.query('BEGIN');

    // 1. Ensure the group_label column exists (idempotent).
    await client.query('ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS group_label TEXT');
    console.log('[migrate-graphic-copy] ensured column: copy_fields.group_label');

    // 2. Apply each asset's changes across every tenant carrying that asset.
    for (const change of CHANGES) {
      const typesRes = await client.query('SELECT id FROM asset_types WHERE name = $1', [change.name]);
      for (const { id: typeId } of typesRes.rows) {
        stats.types++;

        // Deletes (e.g. the Display Banner's redundant plain "Headline").
        for (const fieldName of change.deletes || []) {
          const r = await client.query(
            'DELETE FROM copy_fields WHERE asset_type_id = $1 AND field_name = $2',
            [typeId, fieldName]
          );
          stats.deleted += r.rowCount;
        }

        // Inserts (existence-guarded). New fields inherit the asset's spec
        // provenance, falling back to the default library's values.
        if ((change.inserts || []).length) {
          const provRes = await client.query(
            'SELECT spec_source, spec_version FROM copy_fields WHERE asset_type_id = $1 ORDER BY sort_order LIMIT 1',
            [typeId]
          );
          const specSource = (provRes.rows[0] && provRes.rows[0].spec_source) || 'quillio_default';
          const specVersion = (provRes.rows[0] && provRes.rows[0].spec_version) || '1.0';
          for (const [field, min, max] of change.inserts) {
            const exists = await client.query(
              'SELECT 1 FROM copy_fields WHERE asset_type_id = $1 AND field_name = $2 LIMIT 1',
              [typeId, field]
            );
            if (exists.rows.length === 0) {
              await client.query(
                `INSERT INTO copy_fields
                   (asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_source, spec_version)
                 VALUES ($1, $2, $3, $4, 'text', 0, $5, $6)`,
                [typeId, field, min, max, specSource, specVersion]
              );
              stats.inserted++;
            }
          }
        }

        // Group labels: clear the asset's fields, then tag the group members.
        const cleared = await client.query(
          'UPDATE copy_fields SET group_label = NULL WHERE asset_type_id = $1 AND group_label IS NOT NULL AND field_name <> ALL($2::text[])',
          [typeId, change.group]
        );
        stats.cleared += cleared.rowCount;
        const grouped = await client.query(
          'UPDATE copy_fields SET group_label = $3 WHERE asset_type_id = $1 AND field_name = ANY($2::text[])',
          [typeId, change.group, GROUP]
        );
        stats.grouped += grouped.rowCount;

        // Canonical field order → sort_order (idempotent).
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
      `[migrate-graphic-copy] done — asset_types touched=${stats.types}, deleted=${stats.deleted}, inserted=${stats.inserted}, grouped=${stats.grouped}, cleared=${stats.cleared}, reordered=${stats.reordered}`
    );
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-graphic-copy] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
