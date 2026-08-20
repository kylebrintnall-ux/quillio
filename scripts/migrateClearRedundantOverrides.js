'use strict';

// August 2026 — clear the override values nobody chose.
//
// ─── WHAT WENT WRONG ────────────────────────────────────────────────────────
// The Settings house-defaults form tracked dirtiness per ROW. Any one of a row's
// three controls firing made the whole row dirty, and a dirty row posted all
// three of its values. So a tenant who changed a field's limit also wrote
// char_min_override and spec_note_override — each equal to the value already in
// force, so nothing on screen looked any different.
//
// On a field whose seed gives no note, the note collateral was an EMPTY STRING,
// submitted by a collapsed textarea the tenant never opened. '' is not NULL, so
// spec_overridden (a three-column IS NOT NULL OR) began reporting true and the
// document began rendering "House default — yours, set in Settings." over a
// number nobody had set.
//
// ─── WHAT A STALE OVERRIDE COSTS ────────────────────────────────────────────
// This is the part that matters, and it is not "the tenant has their own value".
//
// Every spec correction writes the BASE column. `specReview.commitReview` and
// every hand-written migration match by asset name with no tenant predicate; the
// reads resolve COALESCE(override, base). A field carrying an override is
// therefore detached from every correction that will ever be made to it —
// permanently, and with nothing anywhere that surfaces the fact.
//
// So when a wrong number is found and fixed — Meta's carousel headline, the
// LinkedIn carousel intro text, both corrected this month against the pages they
// are cited to — the fix reaches every tenant EXCEPT the ones holding an
// override on that field. Those keep the wrong number forever, on a field they
// never intended to pin, and their document keeps rendering it beside a live
// citation link to the page that disagrees with it.
//
// That is the correct trade for a value a tenant chose. It is pure loss for one
// written as collateral, which is what every row below is.
//
// It is the same class as the frozen `affected_fields` snapshot: a value nobody
// meant to freeze, quietly authoritative, with nothing to surface it. It arrived
// through a form instead of a migration.
//
// ─── THE RULE: CLEAR AN OVERRIDE WHOSE EFFECT IS IDENTICAL TO THE BASE ──────
// Per COLUMN, not per row — a row can hold one real override and two redundant
// ones, which is exactly the shape the defect produces.
//
//   char_min_override = char_min                       -> NULL
//   char_max_override = char_max                       -> NULL
//   NULLIF(spec_note_override,'') IS NOT DISTINCT FROM
//   NULLIF(spec_note,'')                               -> NULL
//
// The note clause is one rule, not two. '' over a base of NULL and 'x' over a
// base of 'x' are both "the override says what the base already says". '' over a
// base that HAS a note is a real deletion and is NOT touched — folding that would
// silently restore a note the tenant removed on purpose, and the twelve Litmus
// email fields are where it would land.
//
// ─── THE JUDGEMENT CALL, STATED RATHER THAN BURIED ──────────────────────────
// An override equal to the base is ALMOST CERTAINLY collateral. It is not
// provably so: a tenant who opened the form and deliberately typed the number
// already there is indistinguishable in the data from the form having typed it
// for them. Nothing recorded which control the human touched.
//
// Clearing anyway, and the reason is the asymmetry of being wrong:
//
//   Wrong to clear  — a tenant who deliberately pinned Quillio's own number
//                     loses the pin. A future correction moves their number.
//                     They see it move, in Settings and in the next document,
//                     and they can type it again. The "Yours" chip disappearing
//                     is itself the notice.
//   Wrong to keep   — a field nobody pinned is pinned forever. No correction
//                     reaches it, nothing says so, and the tenant has no reason
//                     to look. There is no moment at which this becomes visible.
//
// One failure is recoverable by noticing. The other cannot be noticed at all.
// That decides it — the same way the tier gate is an allowlist and the sweep
// fails closed on authority.
//
// ─── SAFETY ─────────────────────────────────────────────────────────────────
// Only ever writes NULL, and only into a column whose stored value equals the
// base it sits on. An override that DIFFERS from its base is the tenant's and is
// never touched by any clause here. Idempotent: a second run finds nothing.
//
// Dry run by default inside a transaction that ROLLBACKs. --commit writes.
//
//   node scripts/migrateClearRedundantOverrides.js            # dry run
//   node scripts/migrateClearRedundantOverrides.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[clear-redundant-overrides]';
const COMMIT = process.argv.includes('--commit');

// Every column's redundancy test, in one place so the listing and the UPDATE
// cannot disagree about what "redundant" means.
const REDUNDANT = {
  char_min_override: 'cf.char_min_override IS NOT NULL AND cf.char_min_override = cf.char_min',
  char_max_override: 'cf.char_max_override IS NOT NULL AND cf.char_max_override = cf.char_max',
  spec_note_override:
    "cf.spec_note_override IS NOT NULL AND NULLIF(cf.spec_note_override, '') IS NOT DISTINCT FROM NULLIF(cf.spec_note, '')",
};

const HELD = `cf.char_min_override IS NOT NULL
           OR cf.char_max_override IS NOT NULL
           OR cf.spec_note_override IS NOT NULL`;

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function show(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v === '') return "''";
  const s = String(v);
  return s.length > 34 ? `${s.slice(0, 31)}…` : s;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — nothing to do.`);
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg": ${err.message}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'copy_fields'
          AND column_name IN ('char_min_override', 'char_max_override', 'spec_note_override')`
    );
    if (cols.rowCount < 3) {
      throw new Error('the override columns do not exist — run scripts/migrateAddHouseDefaultOverrides.js first');
    }

    // EVERY row holding any override, with a per-column verdict. A count alone
    // would not let anyone check the rule against a row they recognise, and the
    // whole judgement above rests on these being collateral.
    const rows = await client.query(
      `SELECT at.tenant_id, at.name AS asset, cf.field_name, cf.spec_type,
              cf.char_min, cf.char_min_override, cf.char_max, cf.char_max_override,
              cf.spec_note, cf.spec_note_override,
              (${REDUNDANT.char_min_override})  AS min_redundant,
              (${REDUNDANT.char_max_override})  AS max_redundant,
              (${REDUNDANT.spec_note_override}) AS note_redundant
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE ${HELD}
        ORDER BY at.tenant_id, at.name, cf.sort_order`
    );

    console.log(`\n${TAG} ${rows.rowCount} row(s) hold at least one override:\n`);
    for (const r of rows.rows) {
      console.log(`  ${r.tenant_id} / ${r.asset} / ${r.field_name}  [${r.spec_type || 'null'}]`);
      const line = (label, base, ov, redundant) => {
        const verdict = ov === null ? '' : redundant ? '   -> CLEAR (same as base)' : '   -> KEEP (the tenant\'s)';
        console.log(`      ${label.padEnd(10)} base ${show(base).padEnd(36)} override ${show(ov).padEnd(36)}${verdict}`);
      };
      line('char_min', r.char_min, r.char_min_override, r.min_redundant);
      line('char_max', r.char_max, r.char_max_override, r.max_redundant);
      line('spec_note', r.spec_note, r.spec_note_override, r.note_redundant);
    }

    if (rows.rowCount === 0) {
      console.log(`${TAG} nothing to do — no tenant holds an override.`);
    }

    // One UPDATE per column. A row where two of three are redundant is written
    // twice, which is right: the columns are independent decisions.
    let total = 0;
    for (const [col, test] of Object.entries(REDUNDANT)) {
      const res = await client.query(
        `UPDATE copy_fields cf SET ${col} = NULL WHERE ${test}`
      );
      total += res.rowCount;
      console.log(`${TAG} ${col}: cleared ${res.rowCount}`);
    }
    console.log(`${TAG} ${total} column value(s) cleared in total`);

    // Read the outcome back rather than trusting the rowCounts — no row may be
    // left holding a redundant override, and no row that held a REAL one may
    // have lost it.
    const left = await client.query(
      `SELECT COUNT(*)::int AS n FROM copy_fields cf
        WHERE (${REDUNDANT.char_min_override})
           OR (${REDUNDANT.char_max_override})
           OR (${REDUNDANT.spec_note_override})`
    );
    if (left.rows[0].n > 0) {
      throw new Error(`${left.rows[0].n} redundant override(s) still present after the write — refusing to commit`);
    }
    const after = await client.query(
      `SELECT COUNT(*)::int AS n FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE ${HELD}`
    );
    const realBefore = rows.rows.filter(
      (r) => (r.char_min_override !== null && !r.min_redundant)
        || (r.char_max_override !== null && !r.max_redundant)
        || (r.spec_note_override !== null && !r.note_redundant)
    ).length;
    console.log(`${TAG} rows still holding an override: ${after.rows[0].n} (expected ${realBefore})`);
    if (after.rows[0].n !== realBefore) {
      throw new Error('a row holding a REAL override was lost — refusing to commit');
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Those fields now track the base column again, so the next spec correction reaches them.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} FAILED (rolled back): ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`${TAG} ${err.message}`);
  process.exit(1);
});
