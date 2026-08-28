'use strict';

// August 2026 — remove the double-width sentence from Google Performance Max's
// asset_direction, so the library is uniformly without it.
//
// ─── (a) THE RULE IS REAL AND PUBLISHED. IT IS NOT LEAVING BECAUSE IT IS WRONG ─
// Read this before anything else in the file, because every other paragraph
// depends on it being clear.
//
// Google states the double-width counting rule on BOTH pages, in its own words,
// differently on each. Both are quoted verbatim in
// scripts/migrateAddGoogleCjkDirection.js, which fetched them:
//
//   Performance Max   support.google.com/google-ads/answer/17091269
//     "In text assets, the length limits are the same across all languages. Each
//      character in double-width languages like Korean, Japanese, or Chinese
//      counts as 2 towards the limit instead of one."
//
//   Responsive Search support.google.com/google-ads/answer/7684791
//     "… Every character in a double width language like Korean, Japanese, or
//      Chinese counts as 2 characters."
//
// THE RULE IS TRUE. A Korean headline on a 30-character Google field really does
// get fifteen characters of room. Nothing about this change disputes that, and
// nothing in it is a correction.
//
// ─── (b) IT IS LEAVING ON SCOPE ──────────────────────────────────────────
// Quillio's writers work in US English. The rule applies to a market this
// product has no users in, so on every document anyone has ever generated it is
// a true sentence with nothing to do — sitting in the one line a writer reads
// before their first field.
//
// THE CONDITION UNDER WHICH IT COMES BACK, stated so it is a decision with a
// trigger rather than a deletion: if a customer writes for a Korean, Japanese or
// Chinese market, it goes back. The wording is preserved —
// scripts/migrateAddGoogleCjkDirection.js is NOT deleted, its quotes and its
// per-page citations stay, and restoring the rule is re-running that file or
// writing a new one from its evidence.
//
// ─── (c) DO NOT RE-ADD IT BY NOTICING THAT GOOGLE PUBLISHES IT ───────────
// THIS IS THE PARAGRAPH THAT MATTERS. It is how the sentence got here in the
// first place: somebody read Google's page, saw a real published rule that the
// library did not state, and added it. That reasoning was sound and produced
// something nobody needed.
//
// The evidence has not changed and will not change. Finding the rule on Google's
// page is not new information and is not a reason to put it back — the reason it
// left is about WHO READS THE DOCUMENT, and no amount of page-reading speaks to
// that. The only thing that reopens this is a customer writing CJK copy.
//
// ─── (d) A CORRECTION TO THE RECORD ON e361ff8 ───────────────────────────
// The commit message on e361ff8 and the header of
// scripts/migrateSetAssetDirections.js both say the CJK sentence came off "both
// Google assets". THAT IS FALSE. Measured from the two migrations' own target
// lists:
//
//   scripts/migrateAddGoogleCjkDirection.js targets
//       Google Performance Max, Google Responsive Search Ad
//   scripts/migrateSetAssetDirections.js targets
//       Google Responsive Search Ad, Google Responsive Display Ad,
//       Display Banner — Standard
//
//   removed by e361ff8    Google Responsive Search Ad
//   still carrying it     GOOGLE PERFORMANCE MAX
//   never had it          Google Responsive Display Ad, Display Banner — Standard
//
// So it came off ONE asset. e361ff8 IS NOT AMENDED — it is pushed, and rewriting
// a pushed commit to fix a sentence in its message is worse than leaving the
// correction where the next reader will stand. This file is that place, and this
// migration is what makes the "both" true after the fact.
//
// ─── (e) RESULTING LENGTH ────────────────────────────────────────────────
//   Google Performance Max   210 -> 81 chars   (129 removed: the 128-character
//                                               sentence plus its separator)
//
// ─── THE SEED NEEDS NO EDIT, AND THAT IS WORTH KNOWING ───────────────────
// src/data/defaultAssets.js has NEVER carried this sentence.
// scripts/migrateAddGoogleCjkDirection.js appends to database rows only — its
// single write is `UPDATE asset_types SET asset_direction = $3` — and it never
// edited the seed. Confirmed with `git log -S` over that file: the string has
// never appeared in it.
//
// So a NEWLY SEEDED tenant already gets the 81-character line, and only a
// MIGRATED tenant carries the longer one. The seed and this file's target were
// already byte-identical before this change; the only seed edit is a comment
// recording the decision where the next editor stands.
//
// ─── SET, NOT STRIP ──────────────────────────────────────────────────────
// Copied from scripts/migrateSetAssetDirections.js. The direction is SET to the
// literal rather than having a substring removed.
//
// The difference matters here more than usual. A strip keyed on the sentence
// would leave a row that has DRIFTED — a tenant edit, a wording that differs by
// a character, a trailing space — partially edited and quietly wrong, and would
// silently do nothing at all on a row whose copy of the sentence is not
// byte-exact. SET corrects every one of those to the same known value.
//
// Idempotence is EQUALITY: a row already holding the literal is a SKIP, anything
// else is OVERWRITTEN, including a hand edit. SO EVERY OVERWRITE PRINTS THE OLD
// STRING AND THE NEW ONE IN FULL. A migration that discards text without showing
// what it discarded is how an unauthorised edit vanishes with no trace, and the
// dry run is the only place it can be seen before it happens. READ THEM.
//
// ─── SCOPE: ONE ASSET, ONE COLUMN ────────────────────────────────────────
// Google Performance Max only. Google Responsive Search Ad keeps the direction
// e361ff8 gave it and is not read here. Google Responsive Display Ad and Google
// Demand Gen Video Ad are untouched — neither ever carried the sentence.
//
// No copy_fields row. No spec_note at either level. No spec_source, no
// spec_verified_at, no watch row, no affected_fields. One asset_direction on one
// asset, and nothing else.
//
//   node scripts/migrateSetGoogleCjkOff.js            # dry run (ROLLBACK)
//   node scripts/migrateSetGoogleCjkOff.js --commit   # write
//
// No --verify: this writes house text and reads no page. Run in the Railway
// console as plain node — never `railway run`.

const TAG = '[google-cjk-off]';
const COMMIT = process.argv.includes('--commit');

const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

const ASSET = 'Google Performance Max';

// THE TARGET. What this asset held before scripts/migrateAddGoogleCjkDirection.js
// ran — checked against that file's own `expected` value below rather than
// trusted as a transcription, because it is the one string this migration writes
// and getting it subtly wrong would be invisible in a diff.
const WANT = 'The system assembles the ad. Every asset has to stand alone and beside any other.';

// ─── THE REFUSAL ────────────────────────────────────────────────────────────
// Runs before DATABASE_URL. Three checks, and the middle one is the point of
// this gate: the target is verified against the migration that added the
// sentence, so the value being restored is the value that was there.
function checkSeedAgreement() {
  const problems = [];

  // 1. AGAINST THE CJK MIGRATION'S OWN RECORD. That file stores, per asset, the
  //    direction it expected to find and extend. That is the authority for what
  //    Performance Max held before it ran.
  let cjk = null;
  try {
    cjk = require('./migrateAddGoogleCjkDirection');
  } catch (err) {
    problems.push(
      `could not load scripts/migrateAddGoogleCjkDirection.js (${err.message}). That file is the `
      + 'record of what this asset held before the sentence was added, and it is deliberately not '
      + 'deleted — see (b) in the header. Without it this migration has no authority for its target.'
    );
  }
  if (cjk) {
    const entry = (cjk.ASSETS || []).find((a) => a.name === ASSET);
    if (!entry) {
      problems.push(
        `${ASSET} is not in migrateAddGoogleCjkDirection's ASSETS. Either the sentence was never `
        + 'added to this asset, or that file has changed — in both cases this migration has nothing '
        + 'to restore and should not run.'
      );
    } else if (entry.expected !== WANT) {
      problems.push(
        `${ASSET}: this file's target does not match the direction migrateAddGoogleCjkDirection `
        + 'expected to find. Restoring it would put back a string that was never there.\n'
        + `        that file's expected (${entry.expected.length}): ${JSON.stringify(entry.expected)}\n`
        + `        this file's WANT      (${WANT.length}): ${JSON.stringify(WANT)}`
      );
    }
    // AND THE SENTENCE MUST NOT SURVIVE IN THE TARGET. Cheap, and it is the whole
    // purpose of the change.
    if (cjk.SENTENCE && WANT.includes(cjk.SENTENCE)) {
      problems.push(`${ASSET}: the target still contains the double-width sentence.`);
    }
  }

  // 2. AGAINST THE SEED, so a newly seeded tenant and a migrated one agree.
  const seed = DEFAULT_ASSETS.find((a) => a.name === ASSET);
  if (!seed) {
    problems.push(`${ASSET}: no such asset in DEFAULT_ASSETS. Renamed, or the name here is wrong.`);
  } else if (String(seed.asset_direction || '') !== WANT) {
    problems.push(
      `${ASSET}: this file and the seed hold DIFFERENT directions, so a newly seeded tenant and a `
      + 'migrated tenant would render different lines for the same asset.\n'
      + `        seed (${String(seed.asset_direction || '').length}): ${JSON.stringify(seed.asset_direction || '')}\n`
      + `        here (${WANT.length}): ${JSON.stringify(WANT)}`
    );
  }

  // 3. NO NON-ASCII AT ALL. This target is plain ASCII, so unlike the strings in
  //    migrateSetAssetDirections.js there is no lookalike to assert by name — the
  //    check is that nothing non-ASCII has crept in.
  const odd = [...WANT].filter((c) => c.charCodeAt(0) > 126)
    .map((c) => `U+${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (odd.length) problems.push(`${ASSET}: unexpected non-ASCII in the target — ${odd.join(' ')}`);

  return problems.length ? { ok: false, problems } : { ok: true, problems: [] };
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  // THE GATE RUNS FIRST, before DATABASE_URL is even read.
  const agree = checkSeedAgreement();
  if (!agree.ok) {
    console.error(`\n${TAG} REFUSING: the target could not be confirmed.`);
    for (const p of agree.problems) console.error(`      • ${p}`);
    process.exit(1);
  }
  console.log(`${TAG} target confirmed for ${ASSET}`);
  console.log(`${TAG}   matches migrateAddGoogleCjkDirection's expected value`);
  console.log(`${TAG}   matches the seed`);
  console.log(`${TAG}   ${WANT.length} chars: ${JSON.stringify(WANT)}`);

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
  console.log(`\n${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  // So a failure BEFORE the transaction opens does not print a rollback that
  // never happened.
  let inTxn = false;
  try {
    await client.query('BEGIN');
    inTxn = true;

    let overwritten = 0;
    let unchanged = 0;

    console.log(`\n${'─'.repeat(74)}\n${ASSET}\n${'─'.repeat(74)}`);

    // READ FIRST, ROW BY ROW. Cross-tenant by name. Read rather than
    // blind-updated because the OLD text has to be printed before it is gone.
    const rows = await client.query(
      `SELECT at.id, at.tenant_id, at.asset_direction
         FROM asset_types at
        WHERE at.name = $1
        ORDER BY at.tenant_id`,
      [ASSET]
    );
    if (rows.rowCount === 0) {
      console.log(`${TAG}   no tenant has this asset — nothing to set`);
    }

    for (const row of rows.rows) {
      const dir = String(row.asset_direction == null ? '' : row.asset_direction);

      // IDEMPOTENCE IS EQUALITY. A row whose copy of the sentence differs by a
      // character is not "already done" — SET is what makes that a correction
      // rather than a silent no-op.
      if (dir === WANT) {
        unchanged += 1;
        console.log(`${TAG}   ${row.tenant_id}  already the literal — skipped (${dir.length} chars)`);
        continue;
      }

      overwritten += 1;
      console.log(`${TAG}   ${row.tenant_id}  OVERWRITING ${dir.length} -> ${WANT.length} chars`);
      console.log(`${TAG}       OLD  ${JSON.stringify(dir)}`);
      console.log(`${TAG}       NEW  ${JSON.stringify(WANT)}`);

      // BY ROW ID: the write cannot reach a row the read did not see.
      await client.query(
        'UPDATE asset_types SET asset_direction = $2 WHERE id = $1',
        [row.id, WANT]
      );
    }

    // Read the outcome back rather than trusting rowCounts.
    const after = await client.query(
      `SELECT length(at.asset_direction) AS len,
              at.asset_direction = $2 AS is_literal,
              COUNT(*)::int AS tenants
         FROM asset_types at
        WHERE at.name = $1
        GROUP BY 1,2`,
      [ASSET, WANT]
    );
    for (const r of after.rows) {
      console.log(`${TAG}   after: ${r.len} chars · is the literal ${r.is_literal} · x${r.tenants}`);
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log(`${TAG} ${overwritten} direction(s) overwritten · ${unchanged} already the literal`);
    console.log(`${'═'.repeat(74)}`);
    if (overwritten > 0) {
      console.log(`${TAG} READ THE OLD STRINGS ABOVE BEFORE COMMITTING. Removing the double-width`);
      console.log(`${TAG} sentence is the point; anything ELSE those rows held is gone too, and a`);
      console.log(`${TAG} hand edit would look exactly like the sentence in this output.`);
    }
    console.log(`\n${TAG} The rule is not gone because it is wrong — Google publishes it on both`);
    console.log(`${TAG} pages. It is out of scope for US-English writers, and the wording is kept`);
    console.log(`${TAG} in scripts/migrateAddGoogleCjkDirection.js for the day it is needed.`);
    console.log(`${TAG} No other asset read or written. No copy_fields, no spec_note, no watch row.`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      inTxn = false;
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    if (inTxn) await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} FAILED${inTxn ? ' (rolled back)' : ' (before any transaction opened)'}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

// Required by smoke tests. Guarded above so requiring this file runs nothing.
module.exports = { ASSET, WANT, checkSeedAgreement };
