'use strict';

// August 2026 migration: give Event Reminder Email a `Date / Location Line`
// field, matching src/data/defaultAssets.js and Event Invitation Email.
//
// WHY. Event Reminder Email shipped with a field list byte-identical to Event
// Follow-Up / Recap Email. The follow-up genuinely needs no date — the event is
// over — so the shared shape is the follow-up's, and the reminder inherited it.
// All three event emails were seeded in one commit, in one block, which is what
// that fingerprint means: an authoring pass in which the middle asset took its
// neighbour's field list.
//
// The consequence was measured with scripts/statsAB.js: with nowhere to put the
// time, and an asset_direction that asks for "urgency without panic", drafts
// invented arrival times — 8 of 30 in one arm, 4 of 30 with no reference
// material at all — and two drafts of the same email disagreed by 24 hours. A
// reminder email carrying a wrong time makes the reader miss the event. It is
// the only failure this system has produced that harms the READER rather than
// the client.
//
// THE NAME IS COPIED EXACTLY from Event Invitation Email. A reminder and an
// invitation must not disagree about what the field is called — the library is
// matched by name in several places, and a near-duplicate is what a name match
// gets wrong.
//
// THIS ADDS A PLACE TO PUT THE ANSWER. It does not, by itself, stop invention:
// the brief already reaches the drafter verbatim, so a stated time is in the
// prompt today, and what happens when the brief is SILENT is a separate question
// that scripts/eventTimeAB.js exists to answer. Do not read this migration as
// the fix for the invention — read it as the precondition for one.
//
// Design: idempotent, same engine as migrateAddSubheadField.js. The field is
// inserted only if absent, then the canonical field order is re-applied so it
// lands between Body Copy and CTA Text (Event Invitation's placement: content,
// then the date line, then the ask). Matching is by asset_types.name, so EVERY
// tenant carrying the asset is updated. Re-running is a no-op.
//
// DRY RUN BY DEFAULT — it reports what it would do and writes nothing. Pass
// --commit to write. Run in the Railway console as plain node, never
// `railway run`:
//
//   node scripts/migrateAddReminderDateLine.js            # report only
//   node scripts/migrateAddReminderDateLine.js --commit   # write

const ASSET = 'Event Reminder Email';
const FIELD = 'Date / Location Line';
const CHAR_MIN = 0;
const CHAR_MAX = 80;

// The canonical order after the insert. Also the field list, so a tenant who
// added their own fields keeps them (they simply are not reordered).
const ORDER = [
  'Subject Line 1',
  'Subject Line 2',
  'Preheader',
  'Headline',
  'Body Copy',
  FIELD,
  'CTA Text',
];

const COMMIT = process.argv.includes('--commit');

function sslFor(url) {
  // Local Postgres has no TLS; Railway/managed needs it. Detect localhost.
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-reminder-date] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-reminder-date] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  const stats = { types: 0, wouldInsert: 0, alreadyPresent: 0, reordered: 0 };

  try {
    await client.connect();
    await client.query('BEGIN');

    const typesRes = await client.query('SELECT id, tenant_id FROM asset_types WHERE name = $1', [ASSET]);
    if (typesRes.rows.length === 0) {
      console.log(`[migrate-reminder-date] no asset_types rows named ${JSON.stringify(ASSET)} — nothing to do.`);
    }

    for (const { id: typeId, tenant_id: tenantId } of typesRes.rows) {
      stats.types++;

      const exists = await client.query(
        'SELECT 1 FROM copy_fields WHERE asset_type_id = $1 AND field_name = $2 LIMIT 1',
        [typeId, FIELD]
      );

      if (exists.rows.length > 0) {
        stats.alreadyPresent++;
        console.log(`  tenant ${tenantId}: already has ${JSON.stringify(FIELD)} — skipping insert`);
      } else {
        stats.wouldInsert++;
        console.log(
          `  tenant ${tenantId}: ${COMMIT ? 'INSERT' : 'would insert'} ${JSON.stringify(FIELD)} [${CHAR_MIN}-${CHAR_MAX}]`
        );
        if (COMMIT) {
          // Inherit the asset's own spec provenance, falling back to the default
          // library's values — same rule as every other seeded field.
          const provRes = await client.query(
            'SELECT spec_source, spec_version FROM copy_fields WHERE asset_type_id = $1 ORDER BY sort_order LIMIT 1',
            [typeId]
          );
          const specSource = (provRes.rows[0] && provRes.rows[0].spec_source) || 'quillio_default';
          const specVersion = (provRes.rows[0] && provRes.rows[0].spec_version) || '1.0';
          await client.query(
            `INSERT INTO copy_fields
               (asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_source, spec_version)
             VALUES ($1, $2, $3, $4, 'text', 0, $5, $6)`,
            [typeId, FIELD, CHAR_MIN, CHAR_MAX, specSource, specVersion]
          );
        }
      }

      // Canonical order → sort_order. Idempotent, and it is what drops the new
      // field between Body Copy and CTA Text rather than at the end.
      if (COMMIT) {
        for (let i = 0; i < ORDER.length; i++) {
          const r = await client.query(
            'UPDATE copy_fields SET sort_order = $3 WHERE asset_type_id = $1 AND field_name = $2',
            [typeId, ORDER[i], i + 1]
          );
          stats.reordered += r.rowCount;
        }
      }
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(
        `[migrate-reminder-date] COMMITTED — asset_types touched=${stats.types}, `
        + `inserted=${stats.wouldInsert}, alreadyPresent=${stats.alreadyPresent}, reordered=${stats.reordered}`
      );
    } else {
      await client.query('ROLLBACK');
      console.log(
        `[migrate-reminder-date] DRY RUN — asset_types=${stats.types}, `
        + `wouldInsert=${stats.wouldInsert}, alreadyPresent=${stats.alreadyPresent}. `
        + 'Nothing was written. Re-run with --commit to apply.'
      );
    }
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-reminder-date] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
