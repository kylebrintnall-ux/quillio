'use strict';

// Migration — per-tenant OVERRIDE columns for house_default field specs.
//
// WHY OVERRIDES AND NOT AN IN-PLACE EDIT. A tenant may now set their own number
// on a house_default field of a SEEDED asset. If that edit wrote char_max
// directly, the next seed-alignment migration would erase it without noticing:
// they match by asset NAME across every tenant with no tenant predicate and no
// value guard —
//
//   scripts/migrateAssetSpecFixes.js:251
//     UPDATE copy_fields SET char_min = $3, char_max = $4
//      WHERE asset_type_id = $1 AND field_name = $2
//
// and the same shape is in migrateOrganicAndGraphicHeadlineSpecs. The three that
// carry `IS DISTINCT FROM` guards (migrateEmailBodyWordCounts,
// migrateEmailClassesAndCitedBands, migrateCiteColdEmailBand) are no help: that
// is an IDEMPOTENCY guard, so it skips rows already holding the target value and
// rewrites precisely the rows whose value differs — which is every row a tenant
// edited. services/specReview.js commitReview is the same story with a live
// trigger: its UPDATE is deliberately tenant-less, and the two Litmus watch rows'
// affected_fields (derived from spec_note text) cover 15 house_default fields.
//
// So the tenant's value lives in a SEPARATE column and the base column keeps
// holding the seed's. Every past and future writer stays correct WITHOUT KNOWING
// THIS FEATURE EXISTS — which is the whole point. The alternative considered was
// a `spec_overridden_at` stamp plus `AND cf.spec_overridden_at IS NULL` in every
// future value migration; that puts the protection in a WHERE clause somebody
// has to remember to write, which is the same class of silent failure as
// affected_fields going stale.
//
// READ SEMANTICS (db/assets.js): the EFFECTIVE value is
// COALESCE(<col>_override, <col>). NULL override = "no override", so a tenant who
// has never touched a field tracks the seed forever, and clearing an override
// puts them back on it. Note the two values that are NOT null:
//   char_min_override = 0   is a real override meaning "no minimum"
//   spec_note_override = '' is a real override meaning "I deleted the note"
// Both are why these are nullable columns rather than sentinel values.
//
// SCOPE. The columns exist on every copy_fields row, but only house_default (and
// NULL-tier, which renders identically) fields are ever writable through them —
// updateAssetType decides that from the STORED spec_type inside its row lock.
// Nothing here enforces the tier; a column that only sometimes exists would be
// worse, and the gate belongs where the write happens.
//
// Purely additive: three nullable columns, no backfill, no data touched. Safe to
// run before or after the code deploy — db/assets.js catches 42703 and degrades
// to the pre-migration behaviour (no overrides, seeded assets fully read-only),
// per CLAUDE.md's "either deploy order is safe".
//
// Idempotent (IF NOT EXISTS). Dry run by default; --commit writes.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddHouseDefaultOverrides.js            # dry run
//   node scripts/migrateAddHouseDefaultOverrides.js --commit   # write

const { Pool } = require('pg');

const TAG = '[house-overrides]';
const COMMIT = process.argv.includes('--commit');

// INTEGER, not NOT NULL DEFAULT anything: NULL is the load-bearing value here.
// It means "no override", and it is what COALESCE falls through.
const STATEMENTS = [
  ['copy_fields.char_min_override', 'ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS char_min_override INTEGER'],
  ['copy_fields.char_max_override', 'ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS char_max_override INTEGER'],
  ['copy_fields.spec_note_override', 'ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS spec_note_override TEXT'],
];

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString) });
  const client = await pool.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');
    for (const [label, sql] of STATEMENTS) {
      await client.query(sql);
      console.log(`  ok  ${label}`);
    }

    // Report, so a re-run says something true rather than nothing. On a first run
    // every count is 0 by construction — the columns were just created.
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(char_min_override)::int  AS min_overrides,
              COUNT(char_max_override)::int  AS max_overrides,
              COUNT(spec_note_override)::int AS note_overrides
         FROM copy_fields`
    );
    const r = rows[0];
    console.log(
      `\n${TAG} ${r.total} copy_fields rows — overrides set: ` +
        `char_min ${r.min_overrides}, char_max ${r.max_overrides}, spec_note ${r.note_overrides}`
    );
    console.log(
      `${TAG} base columns are untouched and stay the SEED's value; ` +
        'a seed-alignment migration keeps writing them and cannot reach a tenant override.'
    );

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} ROLLED BACK — nothing was written.`);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run only when invoked directly. Requiring this module (the smoke test does)
// must NOT connect to a database.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { STATEMENTS };
