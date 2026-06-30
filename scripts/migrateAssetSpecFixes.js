'use strict';

// June 2026 asset-spec audit migration. Brings every already-seeded tenant's
// asset library up to the same end state as src/data/defaultAssets.js:
//
//   PART 1 — Email standardization: subject lines 50–75; preheaders 85–120;
//            every email has Subject Line 1, Subject Line 2 and a Preheader
//            (renames the lone "Subject Line", inserts the missing ones).
//   PART 2 — Sales Basho asset_direction rewritten (human 1:1 voice).
//   PART 3 — Paid social / display: char maxes aligned + "Graphic Headline"
//            field added ([Headline] in Figma). Organic social: full max +
//            visible-hook fields. Landing pages: SEO fields. Signage headline
//            shortened. spec_note set on the multi-size display assets.
//
// Design: data-driven + idempotent. Each asset's changes are expressed as
// renames → inserts → field char-spec updates → a canonical field order (which
// fixes sort_order regardless of how inserts landed). Matching is by
// asset_types.name, so EVERY tenant carrying that asset is updated. Re-running
// is a no-op (renames hit 0 rows once applied, inserts are existence-guarded,
// updates are idempotent). Wrapped in a transaction.
//
// Run on Railway with:  railway run node scripts/migrateAssetSpecFixes.js
// (or any env with DATABASE_URL set — e.g. a local Postgres for validation).

// Each entry: { name, direction?, spec_note?, renames?, inserts?, specs?, order? }
//   renames : [[oldName, newName], …]            rename a field in place
//   inserts : [[fieldName, min, max], …]         add a field if absent
//   specs   : { fieldName: [min, max], … }       set char_min/char_max
//   order   : [fieldName, …]                      final order → sets sort_order
const CHANGES = [
  // ── PAID SOCIAL — intro/primary maxes + Graphic Headline ([Headline] in Figma)
  {
    name: 'LinkedIn Single Image Ad',
    inserts: [['Graphic Headline', 0, 70]],
    specs: { 'Intro Text': [0, 600], 'Graphic Headline': [0, 70] },
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'CTA Button', 'LAN Description'],
  },
  {
    name: 'LinkedIn Carousel Ad',
    inserts: [['Graphic Headline', 0, 70]],
    specs: { 'Intro Text': [0, 600], 'Graphic Headline': [0, 70] },
    order: ['Intro Text', 'Graphic Headline', 'Card 1 Headline', 'Card 2 Headline', 'Card 3 Headline', 'Card 4 Headline', 'Card 5 Headline', 'CTA Button'],
  },
  {
    name: 'LinkedIn Single Image Ad — Variant A',
    inserts: [['Graphic Headline', 0, 70]],
    specs: { 'Intro Text': [0, 600], 'Graphic Headline': [0, 70] },
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'CTA Button'],
  },
  {
    name: 'LinkedIn Single Image Ad — Variant B',
    inserts: [['Graphic Headline', 0, 70]],
    specs: { 'Intro Text': [0, 600], 'Graphic Headline': [0, 70] },
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'CTA Button'],
  },
  {
    name: 'LinkedIn Single Image Ad — Variant C',
    inserts: [['Graphic Headline', 0, 70]],
    specs: { 'Intro Text': [0, 600], 'Graphic Headline': [0, 70] },
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'CTA Button'],
  },
  {
    name: 'LinkedIn Single Image Ad — Variant D',
    inserts: [['Graphic Headline', 0, 70]],
    specs: { 'Intro Text': [0, 600], 'Graphic Headline': [0, 70] },
    order: ['Intro Text', 'Headline', 'Graphic Headline', 'CTA Button'],
  },
  {
    name: 'Meta Single Image Ad',
    inserts: [['Graphic Headline', 0, 40]],
    specs: { 'Headline': [0, 40] },
    order: ['Primary Text', 'Headline', 'Graphic Headline', 'Description', 'CTA Button'],
  },
  {
    name: 'Meta Carousel Ad',
    inserts: [['Graphic Headline', 0, 40]],
    order: ['Primary Text', 'Graphic Headline', 'Card 1 Headline', 'Card 2 Headline', 'Card 3 Headline', 'Card 4 Headline', 'Card 5 Headline', 'Card Description', 'CTA Button'],
  },
  {
    name: 'Twitter/X Ad',
    inserts: [['Graphic Headline', 0, 40]],
    order: ['Ad Copy', 'Headline', 'Graphic Headline', 'CTA Button'],
  },

  // ── DISPLAY — Graphic Headline + multi-size spec_note
  {
    name: 'Display Banner — Standard',
    spec_note:
      'One copy set serves all standard banner sizes (300×250, 728×90, 160×600, 320×50, 300×600). Keep the headline short enough to read in the smallest format.',
    inserts: [['Graphic Headline', 0, 30]],
    order: ['Headline', 'Graphic Headline', 'Body Copy', 'CTA Button'],
  },
  {
    name: 'Google DV360 / Responsive Display',
    spec_note:
      'Responsive — the platform assembles combinations across sizes from one copy set. Every element must read on its own and in combination.',
    inserts: [['Graphic Headline', 0, 30]],
    order: ['Short Headline', 'Graphic Headline', 'Long Headline', 'Description', 'Business Name', 'CTA Button'],
  },

  // ── EMAIL — subject 50–75, preheader 85–120, Subject Line 1/2 everywhere
  {
    name: 'Demand Gen Nurture Email',
    specs: { 'Subject Line 1': [50, 75], 'Subject Line 2': [50, 75], 'Preheader': [85, 120] },
  },
  {
    name: 'Event Invitation Email',
    specs: { 'Subject Line 1': [50, 75], 'Subject Line 2': [50, 75], 'Preheader': [85, 120] },
  },
  {
    name: 'Event Reminder Email',
    renames: [['Subject Line', 'Subject Line 1']],
    inserts: [['Subject Line 2', 50, 75]],
    specs: { 'Subject Line 1': [50, 75], 'Preheader': [85, 120] },
    order: ['Subject Line 1', 'Subject Line 2', 'Preheader', 'Headline', 'Body Copy', 'CTA Text'],
  },
  {
    name: 'Event Follow-Up / Recap Email',
    renames: [['Subject Line', 'Subject Line 1']],
    inserts: [['Subject Line 2', 50, 75]],
    specs: { 'Subject Line 1': [50, 75], 'Preheader': [85, 120] },
    order: ['Subject Line 1', 'Subject Line 2', 'Preheader', 'Headline', 'Body Copy', 'CTA Text'],
  },
  {
    name: 'Sales Basho Email',
    direction:
      'Write as a human, not a brand. Open with Dear [First Name]. Short sentences and short paragraphs. One clear ask. No marketing speak. Feels like it came from a real person, not a campaign.',
    renames: [['Subject Line', 'Subject Line 1']],
    inserts: [['Subject Line 2', 50, 75], ['Preheader', 85, 120]],
    specs: { 'Subject Line 1': [50, 75], 'Body Copy': [0, 275] },
    order: ['Subject Line 1', 'Subject Line 2', 'Preheader', 'Opening Line', 'Body Copy', 'CTA / Ask'],
  },

  // ── LANDING PAGES — SEO fields
  {
    name: 'Event Landing Page',
    inserts: [['Meta Title', 50, 60], ['Meta Description', 150, 160], ['OG Title', 0, 60]],
    order: ['Hero Headline', 'Hero Subheadline', 'Hero CTA', 'About Section Headline', 'About Section Body', 'Benefit 1 Headline', 'Benefit 1 Body', 'Benefit 2 Headline', 'Benefit 2 Body', 'Benefit 3 Headline', 'Benefit 3 Body', 'Benefit 4 Headline', 'Benefit 4 Body', 'Stat 1', 'Stat 1 Label', 'Stat 2', 'Stat 2 Label', 'Stat 3', 'Stat 3 Label', 'Bottom CTA Headline', 'Bottom CTA Button', 'Meta Title', 'Meta Description', 'OG Title'],
  },
  {
    name: 'Campaign Landing Page',
    inserts: [['Meta Title', 50, 60], ['Meta Description', 150, 160], ['OG Title', 0, 60]],
    order: ['Hero Headline', 'Hero Subheadline', 'Hero CTA', 'Section 1 Headline', 'Section 1 Body', 'Benefit 1 Headline', 'Benefit 1 Body', 'Benefit 2 Headline', 'Benefit 2 Body', 'Benefit 3 Headline', 'Benefit 3 Body', 'Bottom CTA Headline', 'Bottom CTA Button', 'Meta Title', 'Meta Description', 'OG Title'],
  },

  // ── SIGNAGE — distance-readable headline
  {
    name: 'On-Site Signage — General',
    specs: { 'Headline': [0, 40] },
  },

  // ── ORGANIC SOCIAL — full max + visible hook
  {
    name: 'Organic Social — LinkedIn',
    inserts: [['Hook (first 150 chars, before See more)', 0, 150]],
    specs: { 'Post Copy': [0, 3000] },
    order: ['Post Copy', 'Hook (first 150 chars, before See more)', 'Headline (if link)'],
  },
  {
    name: 'Organic Social — Instagram',
    inserts: [['Hook (first 125 chars, before More)', 0, 125]],
    specs: { 'Caption': [0, 2200] },
    order: ['Caption', 'Hook (first 125 chars, before More)', 'Alt Text'],
  },
];

function sslFor(url) {
  // Local Postgres has no TLS; Railway/managed needs it. Detect localhost.
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-specs] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-specs] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  const stats = { types: 0, renamed: 0, inserted: 0, specSet: 0, reordered: 0, notes: 0, directions: 0 };

  try {
    await client.connect();
    await client.query('BEGIN');

    // 1. Ensure the spec_note column exists (idempotent).
    await client.query('ALTER TABLE asset_types ADD COLUMN IF NOT EXISTS spec_note TEXT');
    console.log('[migrate-specs] ensured column: asset_types.spec_note');

    // 2. Apply each asset's changes across every tenant carrying that asset.
    for (const change of CHANGES) {
      const typesRes = await client.query('SELECT id FROM asset_types WHERE name = $1', [change.name]);
      for (const { id: typeId } of typesRes.rows) {
        stats.types++;

        if (change.direction != null) {
          await client.query('UPDATE asset_types SET asset_direction = $2 WHERE id = $1', [typeId, change.direction]);
          stats.directions++;
        }
        if (change.spec_note != null) {
          await client.query('UPDATE asset_types SET spec_note = $2 WHERE id = $1', [typeId, change.spec_note]);
          stats.notes++;
        }

        // Renames (idempotent: 0 rows once the new name is in place).
        for (const [oldName, newName] of change.renames || []) {
          const r = await client.query(
            'UPDATE copy_fields SET field_name = $3 WHERE asset_type_id = $1 AND field_name = $2',
            [typeId, oldName, newName]
          );
          stats.renamed += r.rowCount;
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

        // Char-spec updates by final field name.
        for (const [field, [min, max]] of Object.entries(change.specs || {})) {
          const r = await client.query(
            'UPDATE copy_fields SET char_min = $3, char_max = $4 WHERE asset_type_id = $1 AND field_name = $2',
            [typeId, field, min, max]
          );
          stats.specSet += r.rowCount;
        }

        // Canonical field order → sort_order (idempotent).
        if (change.order) {
          for (let i = 0; i < change.order.length; i++) {
            const r = await client.query(
              'UPDATE copy_fields SET sort_order = $3 WHERE asset_type_id = $1 AND field_name = $2',
              [typeId, change.order[i], i + 1]
            );
            stats.reordered += r.rowCount;
          }
        }
      }
    }

    await client.query('COMMIT');
    console.log(
      `[migrate-specs] done — asset_types touched=${stats.types}, renamed=${stats.renamed}, inserted=${stats.inserted}, specsSet=${stats.specSet}, reordered=${stats.reordered}, specNotes=${stats.notes}, directions=${stats.directions}`
    );
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-specs] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
