'use strict';

// August 2026 — set asset_direction to a rewritten house line on three assets,
// and null the asset-level spec_note they were carrying.
//
// ─── WHY: A COLUMN THAT IS WRITTEN, SELECTED, AND DROPPED TWICE ───────────
// asset_types.spec_note is written by the seed (db/assets.js:69) and by
// migrations, SELECTed by getTenantAssets and getTenantLibrary, and then dropped
// before it reaches any surface:
//
//   THE DOCUMENT PATH. core/pipeline.js rowToSpecGroup builds the spec group as
//   { assetType, channel, toneNotes, asset_direction, fields } and nothing else.
//   `a.spec_note` appears ZERO times in that file, so it never reaches
//   googleDocs.js and never reaches a drafting prompt.
//
//   THE SETTINGS PATH. getTenantLibrary returns spec_note on the asset,
//   routes/settings.js spreads `...a` so it is in the JSON the browser receives,
//   and public/settings.html libRenderAsset renders a.name, a.group,
//   a.is_active, a.editable / a.houseEditable, a.asset_direction and a.fields —
//   AND NOT a.spec_note. It arrives at the client and is dropped there.
//
// (e) A COMMENT IN THE SEED ASSERTED THE OPPOSITE. It read "ASSET-LEVEL NOTES
// RENDER IN SETTINGS, NOT IN THE DOC ... That is the right surface for it",
// which is a claim about a render that has never existed on either path. It has
// been corrected in the same change as this file.
//
// ─── THE TEXT IS REWRITTEN, NOT MOVED, AND THAT IS THE WHOLE DESIGN ──────
// An earlier version of this change appended each spec_note to its direction
// line verbatim. That produced 481 characters of italic above Google Responsive
// Search Ad's first field — 75 direction + 128 CJK sentence + 276 note — and was
// rejected on reading it. Length above the first field is the constraint.
//
// So these are NEW STRINGS. There is nothing to concatenate from and no source
// to preserve byte-for-byte, which is why this file holds plain literals rather
// than importing note text from the seed. The seed holds the same literals; the
// gate below compares them.
//
// ─── (a) THESE ARE HOUSE GUIDANCE, NOT CITED SPEC TEXT ───────────────────
// The most important line in this header for whoever edits these next.
//
// No spec_source. No spec_verified_at. No page is quoted and no --verify exists,
// because there is nothing to verify against: these sentences are Quillio's, not
// a platform's. THEY CAN BE EDITED FREELY — reworded, shortened, rewritten —
// with no fetch, no evidence gate and no citation to keep in step.
//
// That is the opposite of a spec VALUE, where CLAUDE.md's rule is fetch the page
// and paste the text in the same change. The 15 and the three in the Google line
// are DESCRIBED here, not stored as limits: the stored limits live in
// copy_fields and are cited to support.google.com/google-ads/answer/7684791 by
// scripts/migrateAddGoogleSearchAsset.js. Editing this sentence changes what a
// writer reads; it changes no number anything enforces.
//
// ─── (b) THE RSA LINE CARRIES THE craft.md QUANTITY ANSWER ───────────────
// "Google takes up to 15 headlines but three is the minimum — riff for more,
// don't seed empty slots" is the resolution to the contradiction CLAUDE.md
// records: craft.md's `### Google Search` section ends "write all 15 headlines
// to give the algorithm room", and this asset carries THREE Headline fields and
// TWO Description fields.
//
// The answer existed in spec_note and reached nobody. This is what delivers it —
// to the writer in the document, and to the drafting prompt, which is where the
// contradiction actually lives.
//
// IT DOES NOT EDIT craft.md. §7 still says fifteen. The asset now carries its own
// answer beside it, and reconciling the two is a separate decision.
//
// ─── (c) OPEN ITEM: THE CJK SENTENCE LOSES ITS HOME HERE ─────────────────
// scripts/migrateAddGoogleCjkDirection.js appended this to Google Responsive
// Search Ad's direction:
//
//   "In double-width languages such as Korean, Japanese or Chinese every
//    character counts as two, so these limits give half the room."
//
// 128 characters. THIS MIGRATION REMOVES IT, because the direction is SET to the
// literal below rather than appended to, and above every field it was the bulk
// of the length problem.
//
// THE FACT IS NOT DISCARDED. It is owed a field-level home — copy_fields.spec_note
// on the seven cited RSA fields, which rowToSpecGroup DOES carry and fieldHint
// DOES render — and that is a later change, not this one. UNTIL IT LANDS, THE
// DOUBLE-WIDTH RULE IS IN NO CHANNEL AT ALL. Recorded as an open item rather
// than as a completed move, because a reader who finds the CJK migration in the
// log and this file removing its sentence is entitled to know which it is.
//
// Google Responsive Display Ad's direction also received that sentence and is
// also overwritten here. Same open item, second asset.
//
// ─── (d) A ZERO ON migrateAssetSpecFixes IS NOT A FAILURE ────────────────
// scripts/migrateAssetSpecFixes.js has a CHANGES entry at :94 targeting the
// asset name 'Google DV360 / Responsive Display', and writes spec_note at :209
// by `SELECT id FROM asset_types WHERE name = $1`. That asset was RENAMED to
// 'Google Responsive Display Ad' by scripts/migrateSpecIntegrityFixes.js — the
// rename is recorded at scripts/auditWatchList.js:18-20, and the old name
// survives in five other files.
//
// So that entry matches zero rows on any re-run, and has since the rename. NOT
// FIXED HERE: repointing a name inside a migration that has already run is its
// own change with its own argument. Recorded so a future zero is read as
// expected rather than as a fault.
//
// ─── IDEMPOTENCE IS EQUALITY, NOT "ENDS WITH" ────────────────────────────
// The consequence of SET rather than append, and it is a real difference from
// the version of this change that concatenated.
//
// A row already holding the literal is a SKIP. A row holding ANYTHING ELSE is
// OVERWRITTEN — including a row carrying the CJK sentence, a row carrying the
// old verbatim note, and a row a tenant has edited. Nothing is preserved.
//
// SO EVERY OVERWRITE PRINTS THE OLD STRING AND THE NEW ONE, in full. A migration
// that discards text without showing what it discarded is how an edit nobody
// authorised disappears with no trace, and the dry run is the only place that
// can be seen before it happens. READ THEM.
//
// ─── SEED === MIGRATION, CHECKED RATHER THAN ASSERTED ────────────────────
// checkSeedAgreement() runs before DATABASE_URL is read. For each asset it
// requires that this file's literal EQUALS the seed's asset_direction exactly,
// and that the seed's spec_note is null. A mismatch is a refusal, not a comment.
//
// It also asserts the CHARACTERS, because three of the four non-ASCII ones here
// have ASCII lookalikes that would survive review: U+2014 EM DASH (not a
// hyphen), U+2019 RIGHT SINGLE QUOTATION MARK (not a straight apostrophe), and
// U+00D7 MULTIPLICATION SIGN (not the letter x). A typo there is invisible in a
// diff and permanent in a document.
//
// ─── THE COLUMN IS NULLED, NOT DROPPED ───────────────────────────────────
// Nulled for these three assets in the SAME transaction, because the text is
// gone and leaving a stale copy behind means two sources with no rule about
// which wins. The COLUMN stays: dropping it is a separate irreversible migration
// and db/assets.js still SELECTs it in two places.
//
//   node scripts/migrateSetAssetDirections.js            # dry run (ROLLBACK)
//   node scripts/migrateSetAssetDirections.js --commit   # write
//
// No --verify: this writes house text and reads no page. Run in the Railway
// console as plain node — never `railway run`.

const TAG = '[set-asset-directions]';
const COMMIT = process.argv.includes('--commit');

const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

// THE THREE FINAL STRINGS. Plain literals, byte-identical to DIRECTIONS in
// src/data/defaultAssets.js, and checked against it below rather than assumed.
//
// Non-ASCII, deliberate in every case: U+2014 EM DASH in the Google Responsive
// Search and Display Banner lines, U+2019 RIGHT SINGLE QUOTATION MARK in
// "don't", U+00D7 MULTIPLICATION SIGN in the five banner sizes.
const DIRECTIONS = {
  'Google Responsive Search Ad':
    'They are already looking. Match the intent, name the thing, skip the setup. Google takes up to 15 headlines but three is the minimum — riff for more, don’t seed empty slots.',
  'Google Responsive Display Ad':
    'System assembles combinations. Every element must work alone and together. One copy set spans every size.',
  'Display Banner — Standard':
    'Fewest possible words. Headline does all the work. CTA is a verb. One copy set serves 300×250, 728×90, 160×600, 320×50 and 300×600 — the headline has to read in the smallest.',
};

// Fixed order so the report reads the same every run.
const ASSETS = [
  'Google Responsive Search Ad',
  'Google Responsive Display Ad',
  'Display Banner — Standard',
];

// The characters that have ASCII lookalikes, per asset. Asserted by name so a
// failure says WHICH character is wrong rather than "strings differ".
const REQUIRED_CHARS = {
  'Google Responsive Search Ad': [['U+2014 EM DASH', '—'], ['U+2019 APOSTROPHE', '’']],
  'Google Responsive Display Ad': [],
  'Display Banner — Standard': [['U+2014 EM DASH', '—'], ['U+00D7 MULTIPLICATION SIGN', '×']],
};

// ─── THE REFUSAL ────────────────────────────────────────────────────────────
// Runs before DATABASE_URL. Checks the property this file's correctness rests
// on: a tenant seeded from defaultAssets.js today and a tenant migrated by this
// script hold the same string.
function checkSeedAgreement() {
  const problems = [];
  for (const name of ASSETS) {
    const mine = DIRECTIONS[name];
    if (!mine) {
      problems.push(`${name}: no entry in this file's DIRECTIONS.`);
      continue;
    }
    const seed = DEFAULT_ASSETS.find((a) => a.name === name);
    if (!seed) {
      problems.push(`${name}: no such asset in DEFAULT_ASSETS. Renamed, or the name here is wrong.`);
      continue;
    }
    const dir = String(seed.asset_direction || '');
    if (dir !== mine) {
      problems.push(
        `${name}: this file and the seed hold DIFFERENT directions, so a newly seeded tenant and a `
        + 'migrated tenant would render different lines for the same asset.\n'
        + `        seed (${dir.length}): ${JSON.stringify(dir)}\n`
        + `        here (${mine.length}): ${JSON.stringify(mine)}`
      );
    }
    if (seed.spec_note != null) {
      problems.push(
        `${name}: the seed still carries a spec_note (${JSON.stringify(seed.spec_note)}). The seed half `
        + 'of this change has not landed, so a new tenant would get text this file is deleting.'
      );
    }
    // THE LOOKALIKE CHECK. A hyphen for an em dash, a straight apostrophe, or the
    // letter x for a multiplication sign all read correctly and are all wrong.
    for (const [label, ch] of REQUIRED_CHARS[name] || []) {
      if (!mine.includes(ch)) problems.push(`${name}: expected ${label} and it is not in the string.`);
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, problems: [] };
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  // THE SEED CHECK RUNS FIRST, before DATABASE_URL is even read. A file whose
  // text disagrees with the seed has nothing safe to say to a database.
  const agree = checkSeedAgreement();
  if (!agree.ok) {
    console.error(`\n${TAG} REFUSING: seed and migration would produce different rows.`);
    for (const p of agree.problems) console.error(`      • ${p}`);
    process.exit(1);
  }
  console.log(`${TAG} seed agreement: OK for all ${ASSETS.length} asset(s)`);
  for (const name of ASSETS) {
    console.log(`${TAG}   ${String(DIRECTIONS[name].length).padStart(3)} chars  ${name}`);
  }

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
    let cleared = 0;

    for (const name of ASSETS) {
      const want = DIRECTIONS[name];
      console.log(`\n${'─'.repeat(74)}\n${name}\n${'─'.repeat(74)}`);

      // READ FIRST, ROW BY ROW. Cross-tenant by name, the same match
      // services/specReview.js uses. Read rather than blind-updated because the
      // OLD text has to be printed before it is destroyed.
      const rows = await client.query(
        `SELECT at.id, at.tenant_id, at.asset_direction, at.spec_note
           FROM asset_types at
          WHERE at.name = $1
          ORDER BY at.tenant_id`,
        [name]
      );
      if (rows.rowCount === 0) {
        console.log(`${TAG}   no tenant has this asset — nothing to set`);
        continue;
      }

      for (const row of rows.rows) {
        const dir = String(row.asset_direction == null ? '' : row.asset_direction);

        // IDEMPOTENCE IS EQUALITY. Not "ends with" — this SETS, so a row carrying
        // the CJK sentence or a tenant edit is a row to overwrite, not to skip.
        if (dir === want) {
          unchanged += 1;
          console.log(`${TAG}   ${row.tenant_id}  already the literal — skipped (${dir.length} chars)`);
          continue;
        }

        // THE OLD STRING IS PRINTED IN FULL BEFORE IT IS REPLACED. This is the
        // only place a discarded edit can be seen, and the dry run is the only
        // time it can be seen BEFORE it is discarded.
        overwritten += 1;
        console.log(`${TAG}   ${row.tenant_id}  OVERWRITING ${dir.length} -> ${want.length} chars`);
        console.log(`${TAG}       OLD  ${JSON.stringify(dir)}`);
        console.log(`${TAG}       NEW  ${JSON.stringify(want)}`);

        // BY ROW ID, not by name. The read above resolved which rows, so the
        // write cannot reach one the read did not see.
        await client.query(
          'UPDATE asset_types SET asset_direction = $2 WHERE id = $1',
          [row.id, want]
        );
      }

      // NULL THE COLUMN, same transaction. Only where it is not already null, so
      // the count reports rows actually changed rather than rows matched.
      const clr = await client.query(
        `UPDATE asset_types
            SET spec_note = NULL
          WHERE name = $1
            AND spec_note IS NOT NULL`,
        [name]
      );
      cleared += clr.rowCount;
      console.log(`${TAG}   spec_note cleared on ${clr.rowCount} row(s)`);

      // Read the outcome back rather than trusting rowCounts.
      const after = await client.query(
        `SELECT length(at.asset_direction) AS len,
                at.asset_direction = $2 AS is_literal,
                at.spec_note IS NULL AS note_null,
                COUNT(*)::int AS tenants
           FROM asset_types at
          WHERE at.name = $1
          GROUP BY 1,2,3`,
        [name, want]
      );
      for (const r of after.rows) {
        console.log(`${TAG}   after: ${r.len} chars · is the literal ${r.is_literal}`
          + ` · spec_note null ${r.note_null} · x${r.tenants}`);
      }
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log(`${TAG} ${overwritten} direction(s) overwritten · ${unchanged} already the literal `
      + `· ${cleared} spec_note(s) cleared`);
    console.log(`${'═'.repeat(74)}`);
    if (overwritten > 0) {
      console.log(`${TAG} READ THE OLD STRINGS ABOVE BEFORE COMMITTING. Anything they held that is`);
      console.log(`${TAG} not in the new literal is gone — including the CJK double-width sentence,`);
      console.log(`${TAG} which is an open item owed a field-level home (see the header).`);
    }
    console.log(`\n${TAG} No copy_fields row touched, no spec_source moved, no watch row read.`);
    console.log(`${TAG} affected_fields is unaffected — rederiveAffectedFields is NOT part of this.`);
    console.log(`${TAG} The spec_note COLUMN still exists; only its contents were cleared.`);

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
module.exports = { ASSETS, DIRECTIONS, REQUIRED_CHARS, checkSeedAgreement };
