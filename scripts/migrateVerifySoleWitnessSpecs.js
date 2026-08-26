'use strict';

// August 2026 — record a human verification of ten sole-witness spec values.
//
// Follows scripts/migrateBackfillSpecVerifiedAt.js, which is the precedent for
// "a person read the cited pages on date D; write that down": same forward-only
// guard, same dry-run-by-default shape, same refusal to invent anything. What
// differs is the SCOPE, and that difference is the point of this file — see
// below.
//
// ─── WHAT THIS STAMP ASSERTS, AND WHAT IT DOES NOT ─────────────────────────
// Written first because spec_verified_at is rendered to writers in every
// generated document ("Verified against LinkedIn's spec page on 2026-08-25."),
// and a date is a claim about an event. Anyone reading it is entitled to know
// exactly which event.
//
// IT ASSERTS: on 2026-08-25 a human opened the live published page each of these
// ten fields is cited to, read the value that page publishes, and confirmed it
// matched the value stored in copy_fields.
//
// IT DOES NOT ASSERT:
//
//   • anything about ANY OTHER FIELD on those pages. Five tiered fields share
//     these four URLs and were NOT read. They are named below and this file
//     does not touch them.
//   • that the page will still say this tomorrow. The date is a fixed historical
//     event, which is the only kind of date a document can carry — see
//     src/utils/specFreshness.js for why the detector's weekly last_checked_at
//     was the wrong value to render.
//   • anything the DETECTOR found. This is not a detector result. No hash was
//     compared, no flag was raised, and spec_watch_list is untouched. The
//     detector notices that a PAGE CHANGED; it never re-reads a number. This is
//     the other thing — a person re-reading the number — and the two are
//     deliberately different columns for that reason.
//
// ─── PAIR-SCOPED, NOT URL-SCOPED. DO NOT "SIMPLIFY" THIS BACK. ─────────────
// migrateBackfillSpecVerifiedAt.js scoped by URL (`cf.spec_source = ANY($2)`)
// because that audit read whole pages: every tiered field on all six URLs was
// checked, so the URL and the verified set were the same thing.
//
// THAT IS NOT TRUE HERE. Ten fields were read. The four pages they sit on carry
// FIFTEEN tiered fields between them. A URL-scoped UPDATE would stamp five
// fields nobody read, and it would do it silently — every one of them would then
// render "Verified against …'s spec page on 2026-08-25." in tenant documents,
// which would be false.
//
// THE FIVE, NAMED so that nobody has to re-derive them to check this claim:
//
//   business.x.com/en/help/campaign-setup/creative-ad-specifications
//       Twitter/X Ad / Headline                       70
//   help.pinterest.com/en/business/article/pinterest-product-specs
//       Pinterest Pin / Title                        100
//   support.google.com/google-ads/answer/17091270
//       Google Demand Gen Video Ad / Headline         30
//       Google Demand Gen Video Ad / Long Headline    90
//       Google Demand Gen Video Ad / Description      90
//
// The LinkedIn carousel page is the ONE case where URL scope would have been
// harmless — all six of its tiered fields are in the list. That coincidence is
// exactly what would make a URL-scoped rewrite look correct in testing and be
// wrong in production, so it is recorded rather than left to be discovered.
//
// If a future audit really does read a whole page, the right move is to list its
// pairs, not to swap the predicate.
//
// ─── WHY THESE TEN VALUES SPECIFICALLY: EVERY ONE IS A SOLE WITNESS ────────
// A sole witness is a stored limit that NO OTHER WATCHED ROW would report a move
// on. If it is wrong, nothing in this system contradicts it — the detector
// reports `unchanged` every week and is right to, because the page has not
// changed; only our reading of it was ever wrong.
//
//   255   LinkedIn Carousel Ad / Intro Text        stored by 2 fields, both on
//                                                  the carousel page
//   45    LinkedIn Carousel Ad / Card 1-5 Headline stored by 10 fields, all on
//                                                  the carousel page
//   800   Pinterest Pin / Description              stored by 1 field
//   10    Google Demand Gen Video Ad / CTA         stored by 1 field
//   280   Twitter/X Ad / Ad Copy and
//         Organic Social — Twitter/X / Post Copy   stored by 2 fields, both on
//                                                  the X page
//
// Contrast the values that are NOT sole witnesses — LinkedIn single-image's 70
// and 150 also appear on X's and Meta's pages. That is a coincidence rather than
// a second instrument (a different platform publishing the same integer says
// nothing about this one), but it at least means a reader has something to
// compare against. These ten have nothing.
//
// ─── THE CONCRETE CASE, AND IT IS ONE OF THESE TEN ─────────────────────────
// LinkedIn Carousel Ad / Intro Text was stored at 255 only after a correction.
// Before scripts/migrateFixLinkedInCarouselIntro.js it was 600 — a number that
// appears on NEITHER LinkedIn specs page. It entered as a bare assertion in
// scripts/migrateFixLinkedInIntroText.js ("the others MUST stay 600 / null", no
// source), and test/smoke.test.js then PINNED it:
//
//     assert.strictEqual(carousel.char_max, 600, 'LinkedIn Carousel Intro Text
//                                                 char_max stays 600');
//
// So for the life of that assertion, anyone who opened the carousel page, read
// "Introductory text: 255 characters" and corrected the value was met by a RED
// TEST, and the failure read *you broke the spec* rather than *the spec was
// wrong*. The test was the last line of defence for the defect.
//
// Nothing detected that. Nothing could: the page had not changed. A human
// reading the page is the only instrument that finds this class of error, which
// is what this column exists to record — and why a stamp on a sole-witness field
// is worth more than a stamp on a cross-checked one.
//
// ─── PROVENANCE OF THIS RUN: THE PAGE TEXT, QUOTED VERBATIM ────────────────
// The reading was performed by the OPERATOR on 2026-08-25 and the text below is
// what they read, pasted verbatim. The author of this file could not reach any
// of these hosts — the egress proxy answers 403 to CONNECT — so every line in
// this block came from the operator, not from a fetch made here.
//
// It is quoted rather than summarised for the reason CLAUDE.md's fetch rule
// gives: a value correction (or, here, a value CONFIRMATION) that cites a page
// without carrying its words leaves the next reader with nothing to check the
// claim against except the claim itself.
//
// ── LinkedIn ───────────────────────────────────────────────────────────────
// business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs
//
//     Ad name (optional): 255 characters
//     Card headline: 45 characters
//     Introductory text: 255 characters
//
// Covers seven of the ten pairs: Intro Text (255) and Card 1-5 Headline (45
// each). "Ad name (optional): 255" is a THIRD field that happens to share Intro
// Text's number and is stored by nothing here — it is quoted because it is
// adjacent in the source block, and it is a reminder that finding 255 on this
// page is not the same as finding INTRO TEXT's 255.
//
// ── Google Demand Gen ──────────────────────────────────────────────────────
// support.google.com/google-ads/answer/17091270
//
//     Text asset specifications
//     Type            Maximum length
//     Headline        30 characters
//     Long headline   90 characters
//     Description     90 characters
//     Call to action  10 characters
//     Final URL       Any
//
// Covers ONE pair: Call to Action (10). The other three rows of that table are
// the Google entries in THE FIVE above — they are visible in this quote and were
// still not read as a verification event, which is precisely the distinction
// pair scoping exists to keep. Seeing a number in a table somebody pasted is not
// the same act as a person checking that number against what is stored, and this
// file only claims the second one.
//
// ── Pinterest ──────────────────────────────────────────────────────────────
// help.pinterest.com/en/business/article/pinterest-product-specs
// From the STANDARD IMAGE ADS section:
//
//     Description
//     Enter up to 800 characters. Descriptions do not appear when viewing the
//     Pin in the home feed or search feed. Additionally, descriptions do not
//     appear for ads when viewed up close.
//
// RECORDED WITH THAT QUOTE, from the operator: that page publishes description
// limits for AT LEAST SIX FORMATS — standard image, carousel, collection, quiz
// results, idea, showcase. Several read 800, one reads 250 (idea ads, on-page
// text), and the quiz 800 governs a RESULTS SCREEN rather than a Pin. The quote
// above is from the STANDARD IMAGE ADS block, which governs this row's field.
// FINDING 800 ELSEWHERE ON THAT PAGE DOES NOT CONFIRM THE SAME THING.
//
// That is the in-section rule arriving in a verification instead of in an
// anchor, and it is worth naming as the same rule: a page with six formats on it
// can satisfy "the number is present" while saying nothing about the format the
// field belongs to. It is also the standing hazard for this row's watch entry —
// a future anchor drawn from the quiz or idea block would be clean, unique, and
// watching a table this field stores nothing from.
//
// ── X ──────────────────────────────────────────────────────────────────────
// business.x.com/en/help/campaign-setup/creative-ad-specifications
//
//     post copy: 280 characters. (Note: each link used reduces character count
//     by 23 characters, electing 257 characters for X copy.)
//
// RECORDED WITH THAT QUOTE, from the operator: 280 is the published limit and is
// CORRECT AS STORED. THE 257 IS NOT A SECOND LIMIT — a link consumes 23 of the
// 280 rather than changing it. It belongs in spec_note on the field, not in
// char_max, and it is NOT part of what this migration stamps.
//
// Written down because 257 is exactly the shape of number that gets "corrected"
// into a char_max by somebody who reads the parenthetical and not the sentence,
// and because this file's own EXPECTED check would then refuse both X pairs with
// a message about a stored value having moved — which would look like drift and
// would in fact be somebody having stored a conditional as a limit.
//
// ─── WHAT THE EXPECTED CHECK ADDS ON TOP OF THE QUOTES ─────────────────────
// The quotes are what a reader checks the claim against. The run additionally
// asserts, per pair, that the STORED value is still the value the operator says
// they matched — see EXPECTED below. If any stored number has moved since the
// reading, that pair is refused and nothing is written for it. That does not
// prove the page says 255; the quote above is what does that. It proves this
// file is stamping the number that was actually read, rather than whatever
// happens to be in the column at run time.
//
// ─── WHAT IT TOUCHES ───────────────────────────────────────────────────────
// copy_fields.spec_verified_at, on ten (asset, field) pairs, across every tenant
// that has them. NOT char_max, NOT char_min, NOT spec_note, NOT spec_source, NOT
// spec_type, NOT any override column, and NOTHING in spec_watch_list or
// spec_review_queue. One UPDATE.
//
// FORWARD ONLY (`spec_verified_at IS NULL OR < $1::date`), copied from the
// precedent. All ten pairs already carry a date — 2026-08-20 for the LinkedIn
// and X pairs, from the backfill; 2026-08-21 for Pinterest and Google Demand Gen
// Video, from their seed migrations — so this is a re-stamp forward, and a later
// audit's date survives a re-run of this file.
//
//   node scripts/migrateVerifySoleWitnessSpecs.js            # dry run (ROLLBACK)
//   node scripts/migrateVerifySoleWitnessSpecs.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[verify-sole-witness]';
const COMMIT = process.argv.includes('--commit');

// The date of the READING, not the date this runs. Hardcoded for the same reason
// the precedent hardcodes its own: NOW() would stamp whenever somebody happened
// to execute the file, which is a different event from the one being recorded.
const VERIFIED_ON = '2026-08-25';

// THE TEN PAIRS, with the value each verification matched.
//
// `expected` is not decoration. It is the guard that keeps this file honest: the
// run refuses any pair whose stored char_max is no longer that number, because
// stamping a field whose value has moved since the reading would date a
// verification of a number nobody verified.
//
// Asset and field names must be byte-exact — note the EM DASH (U+2014) in
// 'Organic Social — Twitter/X'. A typo here does not silently skip: the run
// refuses on any pair that resolves to zero rows.
const PAIRS = [
  { asset: 'LinkedIn Carousel Ad', field: 'Intro Text', expected: 255 },
  { asset: 'LinkedIn Carousel Ad', field: 'Card 1 Headline', expected: 45 },
  { asset: 'LinkedIn Carousel Ad', field: 'Card 2 Headline', expected: 45 },
  { asset: 'LinkedIn Carousel Ad', field: 'Card 3 Headline', expected: 45 },
  { asset: 'LinkedIn Carousel Ad', field: 'Card 4 Headline', expected: 45 },
  { asset: 'LinkedIn Carousel Ad', field: 'Card 5 Headline', expected: 45 },
  { asset: 'Pinterest Pin', field: 'Description', expected: 800 },
  { asset: 'Google Demand Gen Video Ad', field: 'Call to Action', expected: 10 },
  { asset: 'Twitter/X Ad', field: 'Ad Copy', expected: 280 },
  { asset: 'Organic Social — Twitter/X', field: 'Post Copy', expected: 280 },
];

// The five tiered fields on the same four pages that were NOT read. Held here as
// data, not prose, so the run can PROVE it did not touch them rather than assert
// it — see the untouched check below.
const NOT_READ = [
  { asset: 'Twitter/X Ad', field: 'Headline' },
  { asset: 'Pinterest Pin', field: 'Title' },
  { asset: 'Google Demand Gen Video Ad', field: 'Headline' },
  { asset: 'Google Demand Gen Video Ad', field: 'Long Headline' },
  { asset: 'Google Demand Gen Video Ad', field: 'Description' },
];

// A unix-socket connection is local by construction and never speaks SSL.
function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// ─── THE READS ──────────────────────────────────────────────────────────────
//
// UNNEST OF TWO PARALLEL ARRAYS, joined as a set — the same shape
// scripts/migrateFixXAnchor.js uses, and NOT a multidimensional ANY.
// `(at.name, cf.field_name) = ANY($1::text[][])` does not work: the elements of
// a text[][] are TEXT SCALARS, not sub-arrays, so the comparison is record = text
// and Postgres answers `operator does not exist: record = text`.
//
// AND IT CARRIES `at.is_active`, matching specReview.currentValues, the
// precedent's own UPDATE, and scripts/rederiveAffectedFields.js. A deactivated
// asset is invisible to every document — getTenantAssets filters on it — so a
// verification date on one would describe a field no writer can see.
const PREVIEW_SQL = `
  SELECT want.asset,
         want.field,
         at.tenant_id,
         cf.char_max,
         cf.spec_type,
         cf.spec_source,
         to_char(cf.spec_verified_at, 'YYYY-MM-DD') AS verified_at
    FROM unnest($1::text[], $2::text[]) AS want(asset, field)
    JOIN asset_types at ON at.name = want.asset AND at.is_active
    JOIN copy_fields cf ON cf.asset_type_id = at.id AND cf.field_name = want.field
   ORDER BY want.asset, want.field, at.tenant_id`;

// THE WRITE. Forward-only, and additionally guarded on the expected value: a
// pair whose char_max has moved since the reading is not stamped.
//
// The expected values ride along as a third parallel array so the guard is in
// the JOIN rather than in application code — one statement, one round trip, and
// no way for the list and the guard to drift apart.
const UPDATE_SQL = `
  UPDATE copy_fields cf
     SET spec_verified_at = $4::date
    FROM unnest($1::text[], $2::text[], $3::int[]) AS want(asset, field, expected),
         asset_types at
   WHERE at.id = cf.asset_type_id
     AND at.is_active
     AND at.name = want.asset
     AND cf.field_name = want.field
     AND cf.char_max = want.expected
     AND (cf.spec_verified_at IS NULL OR cf.spec_verified_at < $4::date)
   RETURNING at.tenant_id, at.name AS asset, cf.field_name AS field`;

// Proof that the five unread fields were not touched, read AFTER the update and
// inside the same transaction. Asserting it in prose is what a URL-scoped
// rewrite would keep saying while doing the opposite.
const UNTOUCHED_SQL = `
  SELECT want.asset, want.field, at.tenant_id,
         to_char(cf.spec_verified_at, 'YYYY-MM-DD') AS verified_at
    FROM unnest($1::text[], $2::text[]) AS want(asset, field)
    JOIN asset_types at ON at.name = want.asset AND at.is_active
    JOIN copy_fields cf ON cf.asset_type_id = at.id AND cf.field_name = want.field
   ORDER BY want.asset, want.field, at.tenant_id`;

// A NUL was used here originally and it made the whole FILE binary to git, grep
// and diff — a source file with a raw \x00 in it is not a text file. The
// separator only has to be a character no asset or field name contains; a
// newline is that, and it is printable.
function key(asset, field) {
  return asset + '\n' + field;
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
  console.log(`${TAG} recording a human reading performed on ${VERIFIED_ON}`);
  console.log(`${TAG} PAIR-scoped: ${PAIRS.length} pair(s). NOT url-scoped — see the header.`);

  // WHETHER A TRANSACTION IS ACTUALLY OPEN, tracked rather than assumed. An
  // unconditional ROLLBACK in the catch prints "FAILED (rolled back)" even when
  // the failure happened before BEGIN — Postgres answers ROLLBACK-with-no-
  // transaction with a WARNING, which `.catch(() => {})` swallows, and the
  // message then describes a transaction that was never opened.
  let inTxn = false;

  const assets = PAIRS.map((p) => p.asset);
  const fields = PAIRS.map((p) => p.field);
  const expected = PAIRS.map((p) => p.expected);

  try {
    // ─── READ-ONLY, BEFORE THE TRANSACTION: the per-pair preview ─────────────
    const pre = await client.query(PREVIEW_SQL, [assets, fields]);
    const rows = pre.rows;

    console.log(`\n${'─'.repeat(78)}\nPER-PAIR PREVIEW — every pair, including any the guard will skip\n${'─'.repeat(78)}`);
    console.log(`   ${'asset / field'.padEnd(46)} ${'tenant'.padEnd(13)} ${'value'.padEnd(7)} ${'now'.padEnd(11)} -> new`);

    const byPair = new Map();
    for (const r of rows) {
      const k = key(r.asset, r.field);
      if (!byPair.has(k)) byPair.set(k, []);
      byPair.get(k).push(r);
    }

    let willWrite = 0;
    let skipForward = 0;
    let skipValue = 0;
    const missing = [];

    for (const p of PAIRS) {
      const got = byPair.get(key(p.asset, p.field)) || [];
      const label = `${p.asset} / ${p.field}`;
      if (got.length === 0) {
        missing.push(p);
        console.log(`   ${label.padEnd(46)} ${'—'.padEnd(13)} ${'—'.padEnd(7)} NO ACTIVE ROW — refusing`);
        continue;
      }
      for (const r of got) {
        const cur = r.verified_at || '(never)';
        let verdict;
        if (Number(r.char_max) !== p.expected) {
          skipValue += 1;
          verdict = `SKIP — stored ${r.char_max}, expected ${p.expected}`;
        } else if (r.verified_at && r.verified_at >= VERIFIED_ON) {
          skipForward += 1;
          verdict = `skip — already ${cur}, not older than ${VERIFIED_ON}`;
        } else {
          willWrite += 1;
          verdict = VERIFIED_ON;
        }
        console.log(`   ${label.padEnd(46)} ${String(r.tenant_id).padEnd(13)} ${String(r.char_max).padEnd(7)} ${cur.padEnd(11)} -> ${verdict}`);
      }
    }

    console.log(`\n   ${willWrite} row(s) to stamp, ${skipForward} skipped by the forward-only guard,`
      + ` ${skipValue} skipped on a value mismatch.`);

    if (missing.length) {
      throw new Error(
        `${missing.length} pair(s) resolve to no ACTIVE copy_fields row: `
        + missing.map((p) => `"${p.asset} / ${p.field}"`).join(', ')
        + '. Check the names byte-for-byte (the em dash in "Organic Social — Twitter/X" is U+2014). '
        + 'Refusing: a verification list that silently skips a field is worse than one that stops.'
      );
    }
    if (skipValue > 0) {
      throw new Error(
        `${skipValue} row(s) hold a char_max other than the value that was read. Stamping them would `
        + 'date a verification of a number nobody verified. Investigate what moved before re-running; '
        + 'if the value legitimately changed, it needs re-reading, not re-stamping.'
      );
    }
    if (willWrite === 0) {
      console.log(`\n${TAG} nothing to do — every row already carries ${VERIFIED_ON} or later.`);
      console.log(`${TAG} That is a successful no-op, not a failure. Exiting without a transaction.`);
      return;
    }

    await client.query('BEGIN');
    inTxn = true;

    const upd = await client.query(UPDATE_SQL, [assets, fields, expected, VERIFIED_ON]);
    console.log(`\n${TAG} UPDATE stamped ${upd.rowCount} row(s)`
      + ` (expected ${willWrite}${upd.rowCount === willWrite ? '' : ' — MISMATCH, investigate'})`);
    if (upd.rowCount !== willWrite) {
      throw new Error(`the UPDATE touched ${upd.rowCount} row(s) but the preview predicted ${willWrite}. `
        + 'The preview and the write disagree, which means one of them is wrong. Nothing committed.');
    }

    const tenants = new Set(upd.rows.map((r) => String(r.tenant_id)));
    console.log(`${TAG} across ${tenants.size} tenant(s): ${[...tenants].join(', ')}`);

    // ─── PROOF THE FIVE UNREAD FIELDS WERE NOT TOUCHED ──────────────────────
    const un = await client.query(UNTOUCHED_SQL, [
      NOT_READ.map((p) => p.asset), NOT_READ.map((p) => p.field),
    ]);
    console.log(`\n${'─'.repeat(78)}\nNOT READ, AND NOT STAMPED — the five fields a URL-scoped run would have hit\n${'─'.repeat(78)}`);
    let leaked = 0;
    for (const r of un.rows) {
      const stamped = r.verified_at === VERIFIED_ON;
      if (stamped) leaked += 1;
      console.log(`   ${(r.asset + ' / ' + r.field).padEnd(46)} ${String(r.tenant_id).padEnd(13)}`
        + ` ${(r.verified_at || '(never)').padEnd(11)} ${stamped ? '<- LEAKED' : 'untouched'}`);
    }
    if (leaked > 0) {
      throw new Error(`${leaked} row(s) among the unread fields now carry ${VERIFIED_ON}. `
        + 'This run was supposed to be pair-scoped and something stamped a field nobody read. '
        + 'Nothing committed.');
    }
    console.log(`   all ${un.rowCount} row(s) untouched, as intended`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Documents built from now on will render "Verified against …'s spec page on`);
      console.log(`${TAG} ${VERIFIED_ON}." under these ten fields. On the LinkedIn carousel asset the`);
      console.log(`${TAG} provenance run-collapse prints it ONCE for the six fields, not six times.`);
    } else {
      await client.query('ROLLBACK');
      inTxn = false;
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    // ONLY ROLL BACK WHAT WAS ACTUALLY OPENED, and say which happened.
    if (inTxn) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`\n${TAG} FAILED (rolled back): ${err.message}`);
    } else {
      console.error(`\n${TAG} FAILED before any transaction was opened — nothing was written, `
        + `and nothing needed rolling back: ${err.message}`);
    }
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

module.exports = { PAIRS, NOT_READ, VERIFIED_ON, PREVIEW_SQL, UPDATE_SQL, UNTOUCHED_SQL };
