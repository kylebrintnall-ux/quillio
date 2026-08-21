'use strict';

// READ-ONLY probe — everything that has to be measured before a Google Responsive
// Search Ad asset can be seeded. Writes nothing, to any table, ever.
//
// It exists because the seed needs four things this repo cannot supply: the
// anchor's real count in the text the detector hashes, the page's stability, the
// number of PATH fields (the one count in the spec that no quoted sentence
// states), and the database's own account of what happened to the Google watch
// row. Each of those is a measurement, and CLAUDE.md's rule is that a spec value
// ships with the page text behind it or it does not ship.
//
//   node scripts/probeGoogleSearchSpec.js           # both halves
//   node scripts/probeGoogleSearchSpec.js --page    # fetch + measure only (no DB)
//   node scripts/probeGoogleSearchSpec.js --db      # database only (no network)
//
// Run in the Railway console as plain node — never `railway run`.
//
// ─── WHAT THE PAGE HALF ANSWERS ─────────────────────────────────────────────
// 1. Is the quoted text ACTUALLY THERE. The header of the migration this probe
//    precedes will carry a verbatim quote, and a quote nobody re-checked against
//    the fetched text is the same unverified claim as an uncited number. This
//    asserts the quote rather than trusting the transcription.
// 2. The anchor's exact count, plus the two diagnostics that catch the two ways
//    a plausible anchor silently misses — a capital letter, and a tag boundary.
//    This project has had two anchors that looked obviously right and were
//    absent (X's came from the URL slug; Meta's was wrong on capitalisation).
// 3. Stability across two fetches — whether content_stop_marker is needed.
// 4. HOW MANY PATH FIELDS. "the path fields support up to 15 each" gives the
//    LIMIT and not the COUNT, so seeding two path fields is currently an
//    unsourced number sitting in a migration whose whole point is that its
//    numbers are sourced. Every occurrence of "path" is printed in context so a
//    human can read what the page says and decide.
//
// ─── WHAT THE DB HALF ANSWERS ───────────────────────────────────────────────
// The Google watch row used to point at answer/7684791 (the SEARCH article) and
// now points at answer/17090561 (the DISPLAY article). That looks like somebody
// swapped one page for the other on a single row, which would mean the four
// Display fields were once cited to the wrong article — and if their numbers
// came from that article they are wrong today.
//
// The source answers it: scripts/migrateFixGoogleSpecSource.js. This half reads
// the database's own trace so the account can be checked rather than believed.
//
// NOTE FOR WHOEVER READS THE OUTPUT: spec_change_log will NOT show the repoint.
// It records field_attr 'char_max' | 'spec_note' — VALUE changes committed
// through LiveSpecs — and that migration changed only spec_source. The trace
// that does exist is the review queue's denormalised source_url on the flags the
// migration dismissed, which is the same trace checkSpecHealth reports as
// "URL CHANGED since a flag".

const TAG = '[probe-google-search]';
const ONLY_PAGE = process.argv.includes('--page');
const ONLY_DB = process.argv.includes('--db');
const DO_PAGE = !ONLY_DB;
const DO_DB = !ONLY_PAGE;

const URL = 'https://support.google.com/google-ads/answer/7684791';

// The candidate. It is the sentence that INTRODUCES the spec block, so it cannot
// be on an error page, an auth wall or a consent interstitial — none of those
// carry a spec block to introduce. Lowercase and mid-sentence on the page:
// "To help your ads show in their entirety when possible, responsive search ads
// have character limits."
const ANCHOR = 'responsive search ads have character limits';

// Quoted from the page by hand. Asserted here rather than trusted — a
// transcription is a claim about the page like any other.
//
// THE APOSTROPHES ARE U+2019, NOT U+0027, and that is the page's character
// rather than a typographic preference. The first run of this probe reported the
// two "You’ll" quotes ABSENT, which reads identically to a quote whose CLAIM is
// wrong — and it was neither: the transcription had straight apostrophes and the
// page renders curly ones. See foldPunct below for how that case is now reported.
const QUOTES = [
  'responsive search ads have character limits',
  'The headline fields for responsive search ads support up to 30 characters',
  'The description fields support up to 90 characters each, and the path fields support up to 15 each',
  'You’ll need to enter a minimum of 3 headlines, but you can enter up to 15',
  'You’ll need to enter a minimum of 2 descriptions',
];

// The three values the asset would store. Counted AND printed in context: a bare
// count is the "numbers present is a floor, not a census" check, and a short
// number appears incidentally in dates and pixel sizes. Reading the sentence is
// what makes it evidence.
const STORED = ['30', '90', '15'];

// The Display asset's four numbers, checked against the SEARCH page on purpose —
// see the DB half's header. If Display's values were lifted from this article
// they will all be here; 25 in particular is the tell, because it belongs to no
// sentence quoted above.
const DISPLAY_VALUES = ['30', '90', '25'];

const DISPLAY_URL = 'https://support.google.com/google-ads/answer/17090561';
const DISPLAY_ASSET = 'Google Responsive Display Ad';
const DISPLAY_ASSET_OLD = 'Google DV360 / Responsive Display';

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function rule(title) {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`);
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// Every occurrence with `pad` characters either side, so the reader sees the
// SENTENCE rather than a tally. Capped so a common substring cannot flood the
// console.
function contexts(text, needle, { pad = 90, max = 6 } = {}) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1 || out.length >= max) break;
    out.push(text.slice(Math.max(0, at - pad), at + needle.length + pad).trim());
    from = at + needle.length;
  }
  return { shown: out, total: count(text, needle) };
}

// Curly punctuation folded to its ASCII form, and NOTHING ELSE folded.
//
// A quote that misses because the page renders U+2019 where the transcription
// typed U+0027 looks EXACTLY like a quote that misses because the claim is
// wrong — both print ABSENT — and the two are as far apart as a defect can be
// from a typo. This makes them distinguishable: the comparison is run twice, and
// a hit that needed the fold is reported as a PUNCTUATION difference by name.
//
// DELIBERATELY NARROW. Only the six quote characters fold. Dashes do NOT: an en
// dash where a hyphen was typed can be the difference between a range and a
// compound, and folding it would hide a real mismatch inside a number. The rule
// this file lives under is that a quote is a claim about the page, so the fold
// has to be small enough that nothing it hides could change the claim.
const PUNCT_FOLD = [
  [/[‘’ʼ′`]/g, "'"],
  [/[“”″]/g, '"'],
];

function foldPunct(s) {
  let out = String(s);
  for (const [re, to] of PUNCT_FOLD) out = out.replace(re, to);
  return out;
}

// The loosest diagnostic: whitespace permitted ANYWHERE inside the anchor. A tag
// boundary opens a gap before ATTACHED PUNCTUATION rather than between words, so
// a word-level check reports "absent" on a page that plainly renders the phrase.
function flexibleCount(hay, needle) {
  const pattern = needle
    .split('')
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  const m = hay.match(new RegExp(pattern, 'gi'));
  return m ? m.length : 0;
}

async function probePage() {
  const { fetchText, normalize, hashableText } = require('../src/services/specDetector');
  rule(`PAGE  ${URL}`);

  let a;
  let b;
  try {
    const rawA = await fetchText(URL);
    await new Promise((r) => setTimeout(r, 2500));
    const rawB = await fetchText(URL);
    // No stop marker proposed for this row, so hashableText is normalize().
    // Called through the helper anyway, so this measures the real path.
    a = { full: normalize(rawA), cut: hashableText({ content_stop_marker: null }, rawA) };
    b = { cut: hashableText({ content_stop_marker: null }, rawB) };
  } catch (err) {
    console.log(`   FETCH FAILED: ${err.message}`);
    console.log('   ^ the detector would call this `error` — unreachable, not unanchored.');
    console.log('   Nothing below can be measured. Do not seed on the strength of a failed probe.');
    return;
  }

  console.log(`   normalized ${a.full.length} chars   hashed ${a.cut.length} chars`);
  console.log(`   across two fetches: ${a.cut === b.cut
    ? 'STABLE  <- no marker needed, leave content_stop_marker NULL'
    : 'VARIES  <- STOP. This page needs a marker or a token rule; do not seed it as-is.'}`);

  rule('THE QUOTES — asserted, not trusted');
  const foldedPage = foldPunct(a.cut);
  let missing = 0;
  let punctOnly = 0;
  for (const q of QUOTES) {
    const n = count(a.cut, q);
    const folded = count(foldedPage, foldPunct(q));
    if (n > 0) {
      console.log(`   PRESENT      ${n}x  ${JSON.stringify(q)}`);
      continue;
    }
    if (folded > 0) {
      // The case that cost a round: a character, not a fact.
      punctOnly += 1;
      console.log(`   PUNCTUATION  ${folded}x  ${JSON.stringify(q)}`);
      console.log('        ^ the SENTENCE is on the page; only a quote character differs.');
      console.log('          Retype it with the page\'s own characters (it renders U+2019 ’,');
      console.log('          not U+0027 \'). This is NOT the claim being wrong.');
      continue;
    }
    missing += 1;
    console.log(`   ABSENT       0x  ${JSON.stringify(q)}`);
    const loose = flexibleCount(a.cut, q);
    console.log(`        ^ ${loose}x ignoring case and internal whitespace, and 0x after folding`);
    console.log('          curly punctuation. The page does not say this. Do NOT ship it.');
  }
  console.log(`\n   ${missing === 0 && punctOnly === 0
    ? 'All five PRESENT verbatim. The migration header can carry them as written.'
    : missing === 0
      ? `${punctOnly} quote(s) differ only in punctuation — fix the characters and re-run.`
      : `${missing} quote(s) ABSENT — the header would claim something the page does not say.`}`);

  rule('THE ANCHOR');
  const exact = count(a.cut, ANCHOR);
  const loose = count(a.cut.toLowerCase(), ANCHOR.toLowerCase());
  const flex = flexibleCount(a.cut, ANCHOR);
  console.log(`   ${JSON.stringify(ANCHOR)}`);
  console.log(`   exact, case-sensitive (what the detector does): ${exact}x  => would ${exact > 0 ? 'PASS' : 'FAIL'}`);
  console.log(`   ignoring case:                                  ${loose}x`);
  console.log(`   ignoring case and internal whitespace:          ${flex}x`);
  if (exact === 0 && (loose > 0 || flex > 0)) {
    console.log('   !! seed the capitalisation and spacing the page renders, and do NOT');
    console.log('      substitute a different string without measuring that one too.');
  }
  if (exact === 0 && loose === 0 && flex === 0) {
    console.log('   !! absent in every variant. Report this rather than picking another string.');
  }

  rule('THE STORED VALUES — a floor, not a census');
  for (const n of STORED) {
    const c = contexts(a.cut, n, { pad: 70, max: 4 });
    console.log(`\n   ${n}: ${c.total}x in the hashed text` + (c.total > c.shown.length ? ` (first ${c.shown.length} shown)` : ''));
    for (const s of c.shown) console.log(`      … ${s} …`);
  }

  rule('HOW MANY PATH FIELDS — the one count no quoted sentence states');
  console.log('   "the path fields support up to 15 each" gives the LIMIT and not the');
  console.log('   COUNT. Read these and decide; do not seed a number that is not here.');
  for (const term of ['path', 'Path']) {
    const c = contexts(a.cut, term, { pad: 100, max: 8 });
    console.log(`\n   ${JSON.stringify(term)}: ${c.total}x` + (c.total > c.shown.length ? ` (first ${c.shown.length} shown)` : ''));
    for (const s of c.shown) console.log(`      … ${s} …`);
  }

  rule('THE MINIMUMS — the source for 3 headlines and 2 descriptions');
  const mins = contexts(a.cut, 'minimum of', { pad: 110, max: 6 });
  console.log(`   "minimum of": ${mins.total}x`);
  for (const s of mins.shown) console.log(`      … ${s} …`);

  rule("DISPLAY'S NUMBERS ON THE SEARCH PAGE — the cross-check");
  console.log('   If the four Display fields were ever derived FROM this article, its');
  console.log('   numbers will all be here. 25 is the tell: it belongs to no sentence');
  console.log('   quoted above, so its ABSENCE is evidence Display was not copied off');
  console.log('   this page. Presence of 30 and 90 proves nothing either way — they are');
  console.log("   this page's own numbers and Display's, independently.");
  for (const n of DISPLAY_VALUES) {
    console.log(`      ${n}: ${count(a.cut, n)}x`);
  }
}

async function probeDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`\n${TAG} DATABASE_URL not set — skipping the database half.`);
    return;
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg": ${err.message}`);
    return;
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  try {
    rule('THE WATCH LIST as it stands');
    const rows = await client.query(
      `SELECT id, display_name, source_url, source_kind, is_test,
              expected_content IS NOT NULL AS anchored,
              current_hash IS NOT NULL AS baselined,
              COALESCE(jsonb_array_length(affected_fields), 0) AS pairs,
              created_at::date AS created
         FROM spec_watch_list ORDER BY is_test, id`
    );
    for (const r of rows.rows) {
      console.log(`   #${String(r.id).padEnd(3)} ${String(r.display_name || '(no name)').padEnd(26)}` +
        ` ${String(r.pairs).padStart(2)} pair(s)  ${r.anchored ? 'anchored  ' : 'UNANCHORED'}` +
        `  ${r.baselined ? 'baselined' : 'not baselined'}  ${r.source_kind || '-'}${r.is_test ? '  [test]' : ''}`);
      console.log(`        ${r.source_url}   (row created ${r.created})`);
    }

    rule('IS THE SEARCH PAGE WATCHED, OR CITED, BY ANYTHING TODAY');
    const already = await client.query(
      'SELECT id, display_name FROM spec_watch_list WHERE source_url = $1', [URL]
    );
    console.log(`   watch rows on ${URL}: ${already.rowCount}` +
      (already.rowCount ? ` (#${already.rows[0].id} ${already.rows[0].display_name})` : '  <- expected: 0'));
    const citing = await client.query(
      `SELECT at.name AS asset, cf.field_name AS field, COUNT(*)::int AS rows
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE cf.spec_source = $1 GROUP BY 1,2 ORDER BY 1,2`, [URL]
    );
    console.log(`   copy_fields citing it: ${citing.rowCount} pair(s)  <- expected: 0, the repoint moved them all`);
    for (const r of citing.rows) console.log(`      ${r.rows}x ${r.asset} / ${r.field}`);

    rule('THE REPOINT — the trace the review queue kept');
    console.log('   A flag records the URL its row was watching when it fired, so a queue');
    console.log('   URL that differs from the row\'s current one PROVES a repoint. This is');
    console.log('   what checkSpecHealth surfaces as "URL CHANGED since a flag".\n');
    // COLUMNS THE TABLE ACTUALLY HAS. The first version of this selected
    // q.reviewed_at, which does not exist — spec_review_queue carries
    // detected_at, created_at and status, and a review is recorded by moving
    // status to 'reviewed' | 'dismissed' with no timestamp of its own. The whole
    // section threw, so a probe whose stated job was "here is the evidence"
    // produced none, which is worse than never having claimed to look.
    const q = await client.query(
      `SELECT q.id, q.watch_id, q.status, q.source_url AS flag_url, w.source_url AS row_url,
              q.detected_at::date AS detected, q.created_at::date AS created
         FROM spec_review_queue q
         LEFT JOIN spec_watch_list w ON w.id = q.watch_id
        WHERE q.source_url IS DISTINCT FROM w.source_url
        ORDER BY q.id`
    );
    if (q.rowCount === 0) {
      console.log('   no flag carries a URL differing from its row — nothing to report.');
    }
    for (const r of q.rows) {
      console.log(`   flag #${r.id} on watch #${r.watch_id}  status ${r.status}` +
        `  detected ${r.detected || r.created || '(no date)'}`);
      console.log(`        fired against: ${r.flag_url}`);
      console.log(`        row now:       ${r.row_url}`);
    }

    rule('spec_change_log — expected to say NOTHING about the repoint');
    console.log('   It records char_max and spec_note changes committed through LiveSpecs.');
    console.log('   migrateFixGoogleSpecSource changed only spec_source, so a silent table');
    console.log('   here CONFIRMS the account rather than contradicting it.\n');
    const log = await client.query(
      `SELECT id, asset_type, field_name, field_attr, old_value, new_value,
              source_url, changed_at::date AS on_day
         FROM spec_change_log
        WHERE asset_type = ANY($1) OR source_url = ANY($2)
        ORDER BY id`,
      [[DISPLAY_ASSET, DISPLAY_ASSET_OLD], [URL, DISPLAY_URL]]
    );
    console.log(`   ${log.rowCount} row(s) touching either Google asset name or either URL:`);
    for (const r of log.rows) {
      console.log(`      #${r.id} ${r.on_day}  ${r.asset_type} / ${r.field_name} . ${r.field_attr}` +
        `  ${JSON.stringify(r.old_value)} -> ${JSON.stringify(r.new_value)}`);
      console.log(`           ${r.source_url}`);
    }

    rule("THE DISPLAY ASSET'S FOUR FIELDS — where they cite, and when a human last read it");
    const disp = await client.query(
      `SELECT at.name AS asset, cf.field_name AS field, cf.char_min, cf.char_max,
              cf.spec_type, cf.spec_source, cf.spec_verified_at::date AS verified,
              COUNT(*) OVER () AS total
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = ANY($1) AND cf.spec_type IN ('enforced','recommended')
        ORDER BY at.name, cf.sort_order`,
      [[DISPLAY_ASSET, DISPLAY_ASSET_OLD]]
    );
    for (const r of disp.rows) {
      console.log(`   ${r.asset} / ${String(r.field).padEnd(16)} ${r.char_min}-${r.char_max}` +
        `  ${String(r.spec_type).padEnd(11)} verified ${r.verified || 'NEVER'}`);
      console.log(`        ${r.spec_source}`);
    }
    if (disp.rowCount === 0) console.log('   none found under either asset name.');

    rule('WHAT A NEW WATCH ROW WOULD DERIVE TODAY');
    console.log(`   affected_fields is derived from copy_fields.spec_source at run time.`);
    console.log(`   Before the seed this is 0; after it, expect 7 pairs.`);
    const der = await client.query(
      `SELECT DISTINCT at.name AS asset, cf.field_name AS field
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE cf.spec_source = $1 AND at.is_active ORDER BY 1,2`, [URL]
    );
    console.log(`   ${der.rowCount} pair(s) today.`);
    for (const r of der.rows) console.log(`      ${r.asset} || ${r.field}`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  console.log(`${TAG} READ-ONLY. This script writes nothing.`);
  if (DO_PAGE) await probePage();
  if (DO_DB) await probeDb();
  console.log(`\n${TAG} done — nothing was written.`);
}

main().catch((err) => {
  console.error(`${TAG} ${err.message}`);
  process.exit(1);
});
