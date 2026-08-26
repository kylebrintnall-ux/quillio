'use strict';

// August 2026 — replace the anchor on the X watch row with one scoped to the
// section its fields actually come from.
//
// ─── THE PROBLEM ────────────────────────────────────────────────────────────
// The row anchors on "post copy:", which occurs NINE TIMES in the normalized
// text of the creative-ad-specifications page. That page is ~40,562 normalized
// characters and documents at least seven ad formats — Promoted Ads, Image Ads,
// Video Ads, Vertical Video, Carousels, Conversation Cards, Amplify, Takeovers —
// and nearly every one restates its own post copy limit.
//
// So the anchor proves A PAGE RENDERED. It says nothing about WHICH FORMAT
// SECTION rendered. If X restructured the page and dropped the Promoted Ads
// block — the section this row's fields come from — eight other occurrences of
// "post copy:" would keep the anchor matching and the row would report healthy
// forever, watching a page that no longer publishes the numbers it stores.
//
// This is the same defect scripts/migrateFixMetaImageAnchor.js fixed ("Primary
// Text" was on /image, /video AND /collection), and the same rule CLAUDE.md
// records: AN ANCHOR MUST COME FROM THE SECTION THAT PUBLISHES THE WATCHED
// FIELDS. Clean and unique are properties of a STRING; in-section is the only
// one of the three that is a property of the page's STRUCTURE, which is what a
// watch row exists to have an opinion about.
//
// scripts/migrateAddSpecAnchors.js seeded "post copy:" with the argument that
// "nine occurrences is NOT a mark against it: what disqualifies a phrase is
// being site chrome that survives an error page, and a spec label is the
// opposite of chrome." That argument is correct about CHROME and answers the
// wrong question. A spec label repeated once per format is not chrome, and it
// still cannot tell you which format's table you are looking at.
//
// ─── THE PAGE TEXT, AND WHERE IT CAME FROM ──────────────────────────────────
// READ THIS BEFORE TRUSTING THE QUOTE BELOW. Per CLAUDE.md's fetch rule the
// text a migration quotes must be text somebody actually read. This session
// could not reach business.x.com — the egress proxy answers 403 to CONNECT — so
// the sentence below was SUPPLIED BY THE OPERATOR from their own reading of the
// page, and is NOT a fetch performed by the author of this file.
//
// That is a weaker provenance than migrateFixMetaImageAnchor.js's, where both
// pages were read through scripts/probeSpecPage.js in the same session. What
// closes the gap is that --verify FETCHES THE PAGE AND ASSERTS EVERY QUOTE
// BEFORE ANYTHING IS WRITTEN, and the write path calls the same function: if
// the sentence is not on the page, or the section markers are not adjacent, this
// refuses and writes nothing. The quote is a claim this file checks rather than
// a claim it makes.
//
// The Promoted Ads block, verbatim as supplied:
//
//   "of your posts beyond your followers to your desired target audience. post
//    copy: 280 characters. (Note: each link used reduces character count by 23
//    characters, electing 257 characters for X copy.)"
//
// This is the FIRST occurrence of 280 on the page and it belongs to Promoted Ads
// specifically — Image Ads and Video Ads restate the same number later in their
// own blocks, which is precisely why "post copy:" cannot discriminate.
//
// ─── THE SECTION IS DECLARED, NEVER INFERRED ────────────────────────────────
// Passed as an explicit from/to marker pair, per the chooseAnchor pattern in
// scripts/migrateAddGoogleVideoAssets.js. Both markers are substrings of the
// sentence quoted above, so the span is built out of text that has been read
// rather than out of page text nobody looked at — inferring which table a
// sentence belongs to FROM the sentence is the guess that produced the Google
// in-feed-video near-miss.
//
// A MISSING OR UNLOCATABLE SECTION MAKES NOTHING ELIGIBLE. Fail closed, the same
// axis as TENANT_EDITABLE_TIERS: if the markers are no longer adjacent the page
// has been restructured, and a restructured page is exactly when falling back to
// "clean and unique" would re-create the defect being fixed.
//
// ─── ANCHOR SELECTION, RANKED ───────────────────────────────────────────────
//   1. clean and in-section          — no stored limit in the text. Ideal.
//   2. in-section, holds a limit     — acceptable ONLY with the cost stated.
//   3. clean but OUT of section      — REFUSED. That is the defect being fixed.
//
// Every candidate is printed with its verdict and the reason it lost, including
// the refused out-of-section one — a rejection recorded only in a commit message
// gets re-proposed by the next person who notices how clean the string is.
//
// ─── OPTION 2 IS ESPECIALLY BAD FOR THIS ROW, AND HERE IS THE ARITHMETIC ────
// An anchor holding limit X converts a MOVE on X from `changed` into `failed` —
// the spec edit arrives dressed as a broken page, which is the one failure mode
// that teaches a reviewer to dismiss the queue. Whether that is survivable is
// decided BY THE OTHER ROWS, not by this one.
//
//   280   Stored by exactly two fields, both citing this page: Twitter/X Ad /
//         Ad Copy and Organic Social — Twitter/X / Post Copy. Published by no
//         other watched page. THIS ROW IS THE SOLE WITNESS.
//
//   70    Stored by 22 seeded fields, but 20 of them carry the quillio_default
//         sentinel — a house default, cited to nobody and watched by nothing.
//         The two that are cited to a watched page are LinkedIn Single Image Ad
//         / Headline and / LAN Description, on LinkedIn's single-image specs
//         page, whose anchor is "Introductory text" and holds no digits.
//
//         SO THE ANSWER IS NOT THE SIMPLE ONE. The VALUE 70 is watched
//         elsewhere; X's 70 is not. If X moves its Headline limit off 70,
//         LinkedIn's row reports nothing — it is watching LinkedIn's page, and
//         two platforms publishing the same integer is a coincidence rather than
//         a second instrument. For a move in X's 70 this row is the sole witness
//         too.
//
// The header of the Google video migration says this argument HAS TO BE REDONE
// rather than inherited, because it depends on which pages are watched and what
// their anchors are RIGHT NOW. That is why the run recomputes it against the
// live database instead of trusting these paragraphs — see the SOLE WITNESS
// section of the output.
//
// CONSEQUENCE: option 2 is unacceptable for BOTH stored limits on this row. If
// no clean in-section candidate verifies, this run says so prominently and
// refuses, rather than seeding an anchor that would convert the only signal that
// exists into a broken-page report.
//
// ─── WHAT IT DOES NOT TOUCH ─────────────────────────────────────────────────
// expected_content, and nothing else. NOT current_hash, NOT affected_fields, NOT
// content_stop_marker, NOT source_kind. The hashed content is unaffected by an
// anchor swap, so the row must not re-baseline: a cleared hash takes the next
// run down the baseline branch, where it writes a hash and CANNOT flag, and a
// real spec change landing that week would be silently absorbed.
//
// The next detection run must report `unchanged`, NOT `baseline`.
//
// ─── NO STOP MARKER, AND THAT IS MEASURED NOT ASSUMED ───────────────────────
// The page carries a per-request script nonce. normalize() strips <script> and
// its contents, so the hashed text is stable across requests — the run fetches
// twice, three seconds apart, and REFUSES if the two do not match. Do not add a
// content_stop_marker on the strength of having seen a nonce in the raw HTML.
//
// ─── ORDERING ───────────────────────────────────────────────────────────────
// Same deviation from the Pinterest shape as migrateFixMetaImageAnchor.js, for
// the same reason: the stored limits and the affected pairs live ON THE ROW, and
// the anchor choice depends on them, so the database is opened and read BEFORE
// the page is fetched. Nothing is written until every check has passed, and no
// transaction is opened until then. A read-only SELECT is not what the
// "refuse before you open the database" rule protects against — a write is — but
// the deviation is real and is named here rather than left to be noticed.
//
// ─── WHAT MAKES THIS REFUSE ─────────────────────────────────────────────────
//   • the target row is not found, or more than one row matches
//   • the page cannot be fetched (a run with no network is a refusal)
//   • the two fetches disagree (then it needs a stop marker, not an anchor)
//   • any quoted sentence is absent — the header would be claiming something
//     the page does not support
//   • the section markers are not locatable, or not in order
//   • no in-section candidate is unique
//   • the only eligible candidate HOLDS a stored limit (see the arithmetic above)
//   • affected_fields is empty, or its pairs resolve to no copy_fields rows
//
//   node scripts/migrateFixXAnchor.js --verify   # fetch + measure, no write
//   node scripts/migrateFixXAnchor.js            # dry run (ROLLBACK)
//   node scripts/migrateFixXAnchor.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[x-anchor]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const URL = 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications';

const OLD_ANCHOR = 'post copy:';

// Every sentence this file quotes, asserted against the fetched page before
// anything is written. The section markers below are substrings of these.
const QUOTES = [
  'of your posts beyond your followers to your desired target audience. post copy: 280 characters.',
  'each link used reduces character count by 23 characters, electing 257 characters for X copy.',
];

// THE SECTION, declared. Both markers are substrings of QUOTES above.
const SECTION = {
  name: 'Promoted Ads — the block this row\'s Post Copy field comes from',
  from: 'of your posts beyond your followers to your desired target audience',
  to: 'electing 257 characters for X copy.',
};

// CANDIDATES IN PREFERENCE ORDER. The last one is here to be REFUSED and is
// labelled as such — it is the recorded fallback from migrateAddSpecAnchors.js,
// it is clean and unique, and it is out of section, which makes it the exact
// string a future reader will be tempted by.
const CANDIDATES = [
  {
    text: 'of your posts beyond your followers to your desired target audience',
    why: 'Promoted Ads\' own description of what the format DOES. In-section by construction '
      + '(it is the section\'s opening marker), carries no digit at all, and describes the one '
      + 'thing that distinguishes Promoted Ads from every other format on the page — reaching '
      + 'beyond your followers. A restructure that drops the Promoted Ads block drops this.',
  },
  {
    text: 'each link used reduces character count by 23 characters',
    why: 'The link-cost note, which sits inside the same parenthetical as the 280. Holds 23 and '
      + '(via the fuller sentence) 257, NEITHER of which this row stores — the stored limits are '
      + '70 and 280 — so a move on either stored limit still reports `changed`. Ranked second '
      + 'only because 23 is itself a number X could revise, which would report `failed` for an '
      + 'event that is not a broken page.',
  },
  {
    text: 'post copy: 280 characters',
    why: 'OPTION 2 — in-section and unique, and it HOLDS 280. Listed so the run can show it being '
      + 'rejected rather than silently skipped. 280 is stored by two fields and published by no '
      + 'other watched page, so this row is its sole witness: anchoring on it would convert the '
      + 'only signal that exists for a 280 move into a broken-page report. Never take this one.',
  },
  {
    text: 'Creative ad specs',
    why: 'REFUSED BY DESIGN — clean, unique, and OUT OF SECTION. The page heading, recorded as a '
      + 'fallback by migrateAddSpecAnchors.js. It proves the page rendered, which is precisely '
      + 'the property that is not enough and precisely the defect this migration exists to fix. '
      + 'Kept in the list so every run prints it being refused and says why.',
  },
];

// THE ANCHOR MECHANICS ARE SHARED. scripts/lib/anchorChoice.js carries the
// ranking, the section test, the rejection reasons, the stored-limit query and
// the sole-witness arithmetic — the parts that were a copy in each of the four
// anchor migrations. QUOTES, SECTION and CANDIDATES stay here, because they are
// this page's evidence and belong beside the page they were read from.
const {
  POLICY, count, occurrences, sectionSpan, chooseAnchor,
  LIMITS_SQL, resolveStoredLimits, soleWitnessData, printSoleWitness, soleWitnessHeader,
} = require('./lib/anchorChoice');

// THIS ROW KEEPS THE OLDER RANKING RULE, and it is the only file that does.
// `clean` means "holds no value THIS ROW STORES" rather than "digit-free", so a
// digit-bearing in-section candidate can still be selected as option 2 with its
// cost printed. The three later anchor migrations use POLICY.DIGIT_FREE, which
// is strictly stronger. Bound here rather than defaulted in the module — see
// scripts/lib/anchorChoice.js, "THE ONE DIFFERENCE THAT IS KEPT", for why moving
// this row across is its own change with its own before/after and not a side
// effect of extracting the code.
const ANCHOR_OPTS = { policy: POLICY.NO_STORED_LIMIT };

function chooseAnchorHere(text, candidates, limits, section) {
  return chooseAnchor(text, candidates, limits, section, ANCHOR_OPTS);
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// --- the page ---------------------------------------------------------------
// Returns { ok, why, anchor }. Called by --verify and by the write path, so the
// anchor is never swapped without the page being read in the same run.
async function readPage(limits) {
  const { fetchText, normalize, hashableText } = require('../src/services/specDetector');

  console.log(`\n${'='.repeat(74)}\nX — creative ad specifications\n${URL}\n${'='.repeat(74)}`);

  let a;
  let b;
  try {
    const rawA = await fetchText(URL);
    await new Promise((r) => setTimeout(r, 3000));
    const rawB = await fetchText(URL);
    // content_stop_marker is null on this row, so hashableText is normalize().
    // Called through the helper anyway, so this measures the path the detector
    // takes rather than a shortcut around it.
    a = hashableText({ content_stop_marker: null }, rawA);
    b = hashableText({ content_stop_marker: null }, rawB);
  } catch (err) {
    return { ok: false, why: `fetch failed: ${err.message}. A run with no network is a refusal, not a fallback.` };
  }

  console.log(`   hashed ${a.length} chars`);
  const stable = a === b;
  console.log(`   across two fetches, 3s apart: ${stable ? 'STABLE' : 'VARIES'}`);
  console.log('   the page carries a per-request script nonce; normalize() strips <script> and its');
  console.log('   contents, which is why this is stable and why NO stop marker is added.');
  if (!stable) {
    return {
      ok: false,
      why: 'the two fetches disagree. Something outside <script> varies per request, so this row '
        + 'needs a content_stop_marker before any anchor can be trusted — that is a different '
        + 'migration, and swapping the anchor first would hide the problem.',
    };
  }

  // THE QUOTES, asserted. The header's provenance is an operator's reading rather
  // than a fetch by this file's author, so this check is what the header rests on.
  console.log('\n   QUOTED SENTENCES (this file\'s header would be making an unsupported claim without these):');
  let missing = 0;
  for (const q of QUOTES) {
    const n = count(a, q);
    if (n === 0) missing += 1;
    console.log(`   ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 62))}${q.length > 62 ? '…' : ''}`);
  }
  if (missing > 0) {
    return {
      ok: false,
      why: `${missing} quoted sentence(s) are not on the page. The header's text was supplied from `
        + 'an operator\'s reading rather than fetched by this file, and this is the check that was '
        + 'supposed to catch exactly that being stale. Re-read the page before changing anything.',
    };
  }

  // THE DEFECT, SHOWN RATHER THAN ASSERTED.
  const hits = occurrences(a, OLD_ANCHOR);
  console.log(`\n   THE OLD ANCHOR ${JSON.stringify(OLD_ANCHOR)} — ${hits.length}x`);
  console.log(`   ${hits.map((h) => `${h.pct}%`).join('  ')}`);
  console.log('   Spread across the document, once per format block. An anchor that matches in nine');
  console.log('   places proves A PAGE rendered and says nothing about WHICH format section did —');
  console.log('   so dropping the Promoted Ads block leaves eight matches and a healthy-looking row.');
  if (hits.length <= 1) {
    console.log('\n   NOTE: the old anchor is NOT repeating on this fetch. The premise of this change');
    console.log('   is not reproducing — the page may have been restructured. The new anchor is still');
    console.log('   the better one, but re-read the header before trusting the reasoning behind it.');
  }

  console.log(`\n   STORED LIMITS ON THIS ROW: ${limits.join(', ')}`);
  for (const n of limits) console.log(`   value ${n}: ${count(a, n)}x in the hashed text`);

  const { chosen, seen, span, tier } = chooseAnchorHere(a, CANDIDATES, limits, SECTION);

  console.log(`\n   SECTION  ${SECTION.name}`);
  if (!span) {
    console.log(`      NOT LOCATED — from ${JSON.stringify(SECTION.from.slice(0, 46))}`);
    console.log(`                     to ${JSON.stringify(SECTION.to.slice(0, 46))}`);
    return {
      ok: false,
      why: 'the Promoted Ads section could not be located. Both markers are substrings of sentences '
        + 'quoted in this file, so if the quote check passed and this did not, the two markers are no '
        + 'longer adjacent — the page has been restructured and the section must be re-read before '
        + 'anything is anchored to it.',
    };
  }
  console.log(`      chars ${span.start}–${span.end} of ${a.length} (${span.end - span.start} chars,`
    + ` ${Math.round((span.start / a.length) * 1000) / 10}% into the document)`);

  console.log('\n   ANCHOR CANDIDATES, in preference order:');
  for (const c of seen) {
    const mark = c === chosen ? '=>' : '  ';
    const where = c.count === 0 ? '—' : c.inSection ? 'in-section' : 'OUT';
    const limitCol = c.holds.length ? `holds ${c.holds.join('/')}` : 'clean';
    console.log(`   ${mark} ${String(c.count)}x  ${where.padEnd(10)} ${limitCol.padEnd(14)}`
      + ` ${JSON.stringify(c.text.slice(0, 44))}${c.text.length > 44 ? '…' : ''}`);
    if (c.reason) console.log(`         rejected: ${c.reason}`);
  }

  if (!chosen) {
    const cleanOutside = seen.find((c) => c.clean && !c.inSection);
    if (cleanOutside) {
      console.log(`\n   NAMING THE REFUSED CANDIDATE: ${JSON.stringify(cleanOutside.text)}`);
      console.log('   It is clean and unique and it is OUT OF SECTION, which is the defect this');
      console.log('   migration exists to fix. It is refused rather than taken.');
    }
    return { ok: false, why: 'no in-section candidate is unique — nothing is eligible, and a clean out-of-section string is not a substitute' };
  }

  console.log(`\n   CHOSEN — tier ${tier}`);
  console.log(`      ${JSON.stringify(chosen.text)}`);
  console.log(`      ${chosen.why}`);

  // OPTION 2 IS REFUSED ON THIS ROW. See the arithmetic in the header: both
  // stored limits are sole-witnessed here, so an anchor holding either converts
  // the only signal that exists into a broken-page report.
  if (!chosen.clean) {
    return {
      ok: false,
      why: `the only eligible candidate HOLDS ${chosen.holds.join(', ')}, and this row is the sole `
        + 'witness to both of its stored limits — anchoring on one would convert a real spec move '
        + 'from `changed` into `failed`. Refusing. Find a clean in-section string, or decide '
        + 'deliberately that a noisy signal beats none and say so in this file before overriding.',
    };
  }

  return { ok: true, anchor: chosen.text, tier };
}

// SOLE WITNESS. The arithmetic and the per-source lines come from
// scripts/lib/anchorChoice.js; the commentary below is THIS row's and stays
// here, because it is an argument about this platform rather than about anchors.
async function soleWitness(client, rowId, limits) {
  soleWitnessHeader();
  const data = await soleWitnessData(client, rowId, limits);
  for (const entry of data) {
    printSoleWitness(entry, rowId);
    if (!entry.sole) {
      console.log('         Read that carefully: another platform publishing the same integer is a');
      console.log('         coincidence, not a second instrument. It only counts if it watches the');
      console.log('         page THIS row\'s fields are cited to.');
    }
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — the stored limits and affected pairs are read off the row, so this needs a database even to --verify.`);
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
  console.log(`${TAG} mode: ${VERIFY ? 'VERIFY (no write)' : COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  // WHETHER A TRANSACTION IS ACTUALLY OPEN, tracked rather than assumed.
  //
  // Everything up to and including the page fetch runs OUTSIDE a transaction —
  // the reads that pick the anchor, and the --verify path in full. The catch
  // used to issue an unconditional ROLLBACK and print "FAILED (rolled back)"
  // regardless, so a --verify failure reported a rollback that never happened:
  // Postgres answers ROLLBACK-with-no-transaction with a WARNING, which the
  // `.catch(() => {})` swallowed, and the message then described a transaction
  // that was never opened.
  //
  // It is cosmetic in effect and not in what it TELLS YOU. "Rolled back" on a
  // read-only path sends a reader looking for a write that does not exist, and
  // the first thing anyone does with a failing migration is ask what it touched.
  //
  // scripts/migrateFixMetaImageAnchor.js — the file this one copies its shape
  // from — carried the identical defect and was fixed in the same commit, so the
  // two do not diverge. Any future migration built on either should carry the
  // flag rather than the unconditional ROLLBACK.
  let inTxn = false;

  try {
    // READ-ONLY, and BEFORE any transaction. See the ordering note in the header.
    const found = await client.query(
      `SELECT id, display_name, source_url, expected_content, anchor_scope, content_stop_marker,
              source_kind, affected_fields,
              current_hash IS NOT NULL AS baselined
         FROM spec_watch_list WHERE source_url = $1`,
      [URL]
    );
    console.log(`\n${TAG} rows matching ${URL}: ${found.rowCount}`);
    for (const r of found.rows) {
      console.log(`    #${r.id}  ${r.display_name}`);
      console.log(`        expected_content    ${JSON.stringify(r.expected_content)}`);
      console.log(`        anchor_scope        ${r.anchor_scope}`);
      console.log(`        content_stop_marker ${JSON.stringify(r.content_stop_marker)}`);
      console.log(`        source_kind         ${r.source_kind}`);
      console.log(`        ${r.baselined ? 'baselined' : 'not baselined'}`);
    }
    if (found.rowCount !== 1) {
      throw new Error(
        `expected exactly 1 row on that URL, found ${found.rowCount}. `
        + (found.rowCount === 0
          ? 'Check scripts/migrateAddSpecTables.js and scripts/migrateAddSpecAnchors.js — this row should already exist and already carry an anchor.'
          : 'Two rows on one URL is a state no migration creates; resolve it before changing an anchor.')
      );
    }
    const row = found.rows[0];

    // THE PAIRS, READ OFF THE ROW. Never hardcoded: affected_fields is the write
    // gate, and a list typed into this file could describe a gate that has since
    // been re-derived.
    const pairs = Array.isArray(row.affected_fields) ? row.affected_fields : [];
    console.log(`\n${TAG} affected_fields on the row — ${pairs.length} pair(s):`);
    for (const p of pairs) console.log(`    ${p.asset} || ${p.field}`);
    if (pairs.length === 0) {
      throw new Error('affected_fields is empty. This row gates nothing, and an anchor swap is not the problem to solve first.');
    }

    // THE STORED LIMITS, CONFIRMED AGAINST copy_fields IN THE SAME RUN. The
    // anchor choice depends on which values are in play, so they are read rather
    // than believed — the header says 70 and 280 and this is what checks it.
    const { rows: limRows, limits } = await resolveStoredLimits(client, pairs);
    console.log(`\n${TAG} those pairs resolve to ${limRows.length} distinct copy_fields shape(s):`);
    for (const r of limRows) {
      console.log(`    ${(r.asset + ' / ' + r.field).padEnd(44)} ${r.char_min}-${r.char_max}  ${r.spec_type}`);
    }
    if (limRows.length === 0) {
      throw new Error(
        'the row\'s affected_fields resolve to no ACTIVE copy_fields rows. Either the gate is stale — '
        + 'a re-derivation problem (scripts/rederiveAffectedFields.js), not an anchor problem — or every '
        + 'asset behind it has been retired, in which case the row gates nothing and the anchor is the '
        + 'least of it.'
      );
    }
    console.log(`\n${TAG} stored limits in play: ${limits.join(', ')}`);

    await soleWitness(client, row.id, limits);

    const page = await readPage(limits);
    if (!page.ok) {
      console.error(`\n${TAG} REFUSING TO WRITE: ${page.why}`);
      process.exitCode = 1;
      return;
    }

    if (VERIFY) {
      console.log(`\n${TAG} VERIFY PASSED — nothing written.`);
      console.log(`${TAG} would set expected_content to ${JSON.stringify(page.anchor)}`);
      return;
    }

    if (row.expected_content === page.anchor) {
      console.log(`\n${TAG} the row already carries this anchor — nothing to do.`);
      return;
    }

    await client.query('BEGIN');
    inTxn = true;

    // expected_content AND NOTHING ELSE. current_hash in particular is untouched:
    // the hashed content does not change when an anchor does, so the row must not
    // re-baseline. Guarded on the id AND the anchor just read, so a concurrent
    // change between the SELECT and here refuses rather than overwriting.
    const upd = await client.query(
      `UPDATE spec_watch_list SET expected_content = $1
        WHERE id = $2 AND expected_content IS NOT DISTINCT FROM $3
        RETURNING id`,
      [page.anchor, row.id, row.expected_content]
    );
    if (upd.rowCount !== 1) {
      throw new Error(`UPDATE matched ${upd.rowCount} row(s) — the anchor changed between the read and the write. Nothing written.`);
    }

    const after = await client.query(
      `SELECT expected_content, anchor_scope, content_stop_marker, source_kind,
              current_hash IS NOT NULL AS baselined,
              COALESCE(jsonb_array_length(affected_fields), 0) AS pairs
         FROM spec_watch_list WHERE id = $1`,
      [row.id]
    );
    const a = after.rows[0];
    console.log(`\n${TAG} row #${row.id} — ${row.display_name}`);
    console.log(`    before  ${JSON.stringify(row.expected_content)}`);
    console.log(`    after   ${JSON.stringify(a.expected_content)}`);
    console.log(`\n${TAG} unchanged, as intended:`);
    console.log(`    anchor_scope         ${a.anchor_scope}`);
    console.log(`    content_stop_marker  ${JSON.stringify(a.content_stop_marker)}`);
    console.log(`    source_kind          ${a.source_kind}`);
    console.log(`    affected_fields      ${a.pairs} pair(s)`);
    console.log(`    ${a.baselined ? 'still baselined — the next run compares, it does not re-baseline' : 'not baselined'}`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Next: node scripts/runDetection.js — expect this row to report 'unchanged',`);
      console.log(`${TAG} NOT 'baseline'. A baseline here would mean current_hash was cleared.`);
      console.log(`${TAG} Then: node scripts/checkSpecHealth.js — an anchor was repointed.`);
    } else {
      await client.query('ROLLBACK');
      inTxn = false;
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    // ONLY ROLL BACK WHAT WAS ACTUALLY OPENED, and say which happened. A failure
    // before BEGIN wrote nothing because there was nothing to write, and saying
    // "rolled back" there is a claim about the database that is not true.
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

// UNIT TESTS ONLY. chooseAnchor and sectionSpan are the properties this change
// rests on, exported so a test drives the same code the migration does rather
// than reimplementing the ranking beside it.
module.exports = {
  ANCHOR_OPTS,
  chooseAnchor: chooseAnchorHere, sectionSpan, occurrences, resolveStoredLimits, LIMITS_SQL,
  CANDIDATES, SECTION, QUOTES, OLD_ANCHOR, URL,
};
