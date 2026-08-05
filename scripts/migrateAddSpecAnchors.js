'use strict';

// Migration + seed — anchor assertion for the LiveSpecs detector.
//
// THE PROBLEM. fetchText only throws on a non-2xx or a timeout, so a 200 that
// serves a soft-404, an auth interstitial or a JS shell with no rendered content
// flows straight down the success path. Its normalized text is empty or generic,
// it hashes to a constant, and the entry reports "unchanged" every week —
// confidently, forever. Worse on a FIRST run: sha256('') is stored as the
// legitimate baseline and every later run agrees with it.
//
// THE ANCHOR. Each watch row stores a string that must be present in the page for
// the fetch to count as a read. Miss it and the run marks that entry FAILED — not
// unchanged, not changed, and not the existing `error`, which means "could not
// reach the page" and is a different fact.
//
// THREE COLUMNS:
//   expected_content      the anchor. NULL = not anchored yet (see below).
//   anchor_scope          'normalized' (default) or 'raw'. WHERE to look.
//   consecutive_failures  0 on any successful read. A wrong anchor silently
//                         un-watches a page, so "failed once" and "failed for six
//                         weeks" have to be distinguishable without reading
//                         history — that count is the only thing that would ever
//                         surface it.
//
// WHY SCOPE IS PER ENTRY. normalize() strips <script> blocks AND their contents,
// so an anchor living only in a JSON island vanishes from the normalized text on
// a page that is perfectly healthy — the shape of a JS-rendered page. Checking
// raw HTML has the opposite failure: it contains every nav label and meta tag, so
// a generic anchor survives on an error page that shares the site's chrome. Both
// are wrong for some page in this set, so which side to check is data.
//
// NULL IS NOT "PASS" AND NOT "UNWATCHED". An entry with no anchor is still
// fetched, hashed and compared exactly as before — nothing stops being watched —
// but the run reports it as unanchored and counts it, so a gap is visible rather
// than silent. Every row is in that state for the instant between this migration
// adding the column and it seeding the values; a watch row added later starts
// there too.
//
// --- ON THE ANCHORS THEMSELVES ---------------------------------------------
//
// The first pass of this file carried seven CANDIDATES chosen without being able
// to see the pages — this repo denies egress to every one of those hosts. They
// have now been through --verify against the live pages, and the results are
// folded in below. Three are seeded, one is waiting on a re-verify, three are
// deliberately left unanchored. Each row says which and why, because "no anchor
// because nobody got to it" and "no anchor because anchoring it is the wrong
// answer" are different states and only one of them is a to-do.
//
//   node scripts/migrateAddSpecAnchors.js --verify
//
// fetches every watch URL from a box that HAS egress (the Railway console) and
// prints, per entry: HTTP status, normalized length, and occurrence counts in the
// raw body and the normalized text. It also reports two DIAGNOSTIC variants — a
// case-insensitive count and a whitespace-flexible one — because the detector
// does an exact substring match and the two ways a plausible anchor silently
// misses are a capital letter and a tag boundary. `<strong>Post copy</strong>:`
// normalizes to `Post copy :`, with a space before the colon, so `Post copy:`
// is not a substring of a page that plainly contains it.
//
// Dry run by default: applies inside a transaction, prints the state, ROLLBACKs.
// --commit writes. Idempotent — the DDL is IF NOT EXISTS and the seed only fills
// a row whose anchor is still NULL, so re-running never overwrites a value you
// corrected by hand, and never re-anchors a row deliberately left NULL.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddSpecAnchors.js --verify   # fetch + report, no writes
//   node scripts/migrateAddSpecAnchors.js            # dry run
//   node scripts/migrateAddSpecAnchors.js --commit   # write

const { Pool } = require('pg');

const TAG = '[spec-anchors]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const STATEMENTS = [
  ['spec_watch_list.expected_content', 'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS expected_content TEXT'],
  ['spec_watch_list.anchor_scope', "ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS anchor_scope TEXT NOT NULL DEFAULT 'normalized'"],
  ['spec_watch_list.consecutive_failures', 'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0'],
];


// Keyed by a distinctive fragment of source_url rather than the whole string, so
// a query-string or trailing-slash difference between this file and the stored
// row cannot silently skip a seed.
//
// `decision` is the whole point of this table:
//
//   'seed'       verified present, low occurrence, content rather than chrome.
//                The seed writes it.
//   'verify'     the first candidate was wrong and the replacements have not been
//                measured yet. `options` are what --verify should measure. The
//                seed writes NOTHING and says so — the row stays unanchored, and
//                unanchored is a state the detector already handles.
//   'unanchored' a decision, not a gap. The seed writes nothing and prints the
//                reason, so the next person reads why rather than assuming the
//                row was missed.
const CANDIDATES = [
  {
    match: 'linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs',
    decision: 'seed',
    anchor: 'Introductory text',
    scope: 'normalized',
    evidence: 'verified against the live page: present 2x in normalized text',
    why:
      "LinkedIn's own label for the field whose limit we store, so it is content rather than chrome. " +
      'An auth wall or a 404 on this host still carries LinkedIn nav markup, which is why the anchor is a ' +
      'SPEC-TABLE label and not the page title.',
  },
  {
    match: 'business.x.com/en/help/campaign-setup/creative-ad-specifications',
    decision: 'verify',
    why:
      'The first candidate, "Creative ad specifications", was WRONG — and wrong in an instructive way. It ' +
      "came from the URL slug, not from the page: the page's heading is \"Creative ad specs\". A string that " +
      'looks like it must be on the page because it is in the address is exactly the kind of plausible-but-' +
      'absent anchor --verify exists to catch, and it would have failed this entry on its first real run.',
    options: [
      {
        anchor: 'post copy:',
        scope: 'normalized',
        why:
          'PREFERRED. The spec label attached to the limit we actually store — the direct analogue of ' +
          "LinkedIn's \"Introductory text\". It appears wherever a character limit is stated and cannot " +
          'appear on a 404 or an auth wall. A moderate occurrence count is FINE here and does not disqualify ' +
          'it: what disqualifies a phrase is being site chrome that survives an error page, and a spec label ' +
          'is the opposite of chrome. ' +
          'TWO WAYS THIS EXACT STRING CAN MISS A PAGE THAT PLAINLY CONTAINS IT, both of which --verify now ' +
          'reports: the match is CASE-SENSITIVE, so a rendered "Post copy:" is not this string; and ' +
          'normalize() turns every tag into a space, so `<strong>Post copy</strong>:` becomes "Post copy :" ' +
          'and the colon stops being adjacent. If the case-insensitive or whitespace-flexible count is ' +
          'non-zero while the exact count is 0, seed the form the page actually renders — and if only the ' +
          'colon is the problem, seed "Post copy" without it. Two words naming a spec field are still ' +
          'content, not chrome.',
      },
      {
        anchor: 'Creative ad specs',
        scope: 'normalized',
        why:
          "FALLBACK. The page's own heading, now that we know what it actually says. Weaker than a spec " +
          'label for the reason every page title is weaker: a breadcrumb or a related-links rail on a ' +
          'sibling help page can carry it, so it can survive on something that is not this page. Use it only ' +
          'if no form of "post copy" verifies.',
      },
    ],
  },
  {
    match: 'support.google.com/google-ads/answer/17090561',
    decision: 'seed',
    anchor: 'Responsive display ads',
    scope: 'normalized',
    evidence: 'verified against the live page: present 5x in normalized text',
    why:
      "The help article's subject. Five occurrences on a page this size is a phrase used in the body, not a " +
      "chrome string repeated in nav — and Google's help 404 renders a distinct shell that carries none of them.",
  },
  {
    match: 'facebook.com/business/ads-guide',
    decision: 'unanchored',
    why:
      'DELIBERATELY UNANCHORED. The candidate was a raw-body check for the canonical URL fragment, and it was ' +
      'rejected on the merits: it asserts that the DOCUMENT was served, not that the CONTENT rendered, so it ' +
      'would pass on exactly the broken page this feature exists to catch. An anchor that cannot fail is ' +
      'worse than no anchor, because it reports a guarantee it is not providing.\n' +
      '       The row is NOT removed here either. It carries 10 (asset, field) pairs in affected_fields, and ' +
      'affected_fields is the write gate — deleting the row leaves those fields gated by nothing, which is ' +
      'the same trade as the LinkedIn Carousel gap and not one to make as a side effect of an anchor ' +
      'migration. Whether this row belongs on the watch list at all is an open decision (Meta was retiered ' +
      'enforced -> recommended, and the list is for pages publishing enforced limits) and it is logged as ' +
      'such in CLAUDE.md.',
  },
  {
    match: 'litmus.com/blog/how-to-write-the-perfect-subject-line',
    decision: 'unanchored',
    why:
      'DELIBERATELY UNANCHORED, and NOT for want of a better phrase. A blog post does not change, it AGES — ' +
      'so hash-diffing it measures the wrong variable, and a working anchor would only make that wrong ' +
      'measurement fire reliably. Finding a good string here would be effort spent making a bad signal ' +
      'louder. Blocked on the platform-enforced vs observed-practice split (a source_kind on the watch row), ' +
      'which is agreed and unbuilt — not on finding a phrase.',
  },
  {
    match: 'litmus.com/blog/the-ultimate-guide-to-preview-text-support',
    decision: 'unanchored',
    why:
      'DELIBERATELY UNANCHORED, same reasoning as the subject-line post. Blocked on source_kind, not on ' +
      'finding a phrase.',
  },
  {
    match: '/admin/test-spec',
    decision: 'seed',
    anchor: 'Quillio Test Spec',
    scope: 'normalized',
    evidence: 'verified against the live page: present 1x in normalized text',
    why:
      'routes/admin.js serves this page with a fixed <title>Quillio Test Spec</title> shell around the ' +
      'editable <pre> body, so the anchor sits OUTSIDE the content an admin edits to trigger a detection — ' +
      'editing the page to test the detector can never break its own anchor. One occurrence, exactly as the ' +
      'source predicts.',
  },
];

function sslFor(url) {
  // A unix-socket connection is local by construction and never speaks SSL.
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// The SAME normalization the detector hashes over. Imported rather than copied so
// a change to one cannot silently diverge from the other — the verify report
// would otherwise measure something the detector never sees.
const { normalize } = require('../src/services/specDetector');

function candidateFor(url) {
  return CANDIDATES.find((c) => String(url || '').includes(c.match)) || null;
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) return n;
    n++;
    i = at + needle.length;
  }
}

// DIAGNOSTIC ONLY — the detector does a plain, case-sensitive `includes`. These
// two exist because the two ways a well-chosen anchor silently misses a page that
// plainly contains it are a capital letter and a tag boundary, and neither is
// visible in a bare "present: NO".
function occurrencesLoose(haystack, needle) {
  return occurrences(haystack.toLowerCase(), needle.toLowerCase());
}

// The same characters with optional whitespace between ANY adjacent pair — not
// merely between words. That distinction is the whole value of this check:
// `<strong>Post copy</strong>:` normalizes to "Post copy :", where the gap opens
// before ATTACHED PUNCTUATION, not between the two words. A word-level variant
// reports "absent in every variant" on a page that plainly renders the label,
// which is worse than not checking — it reads as proof the string isn't there.
function occurrencesFlexible(haystack, needle) {
  const chars = String(needle).replace(/\s+/g, '').split('');
  if (!chars.length) return 0;
  const re = new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'gi');
  return (haystack.match(re) || []).length;
}

// Fetch a page once for the verify report. Returns null and prints the reason on
// failure — an unreachable page is `error` to the detector, not `unanchored`, and
// says nothing either way about the anchor.
async function fetchForVerify(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Quillio-LiveSpecs/1.0 (spec-watch)' },
    });
    clearTimeout(timer);
    const raw = await res.text();
    console.log(`   HTTP ${res.status}  raw ${raw.length} chars`);
    if (!res.ok) console.log('   ^ NON-2xx: the detector would already call this `error`, anchor or not.');
    return raw;
  } catch (err) {
    console.log(`   FETCH FAILED: ${err.message}`);
    console.log('   ^ the detector would call this `error` — unreachable, not unanchored.\n');
    return null;
  }
}

// Measure ONE candidate string against one fetched page.
function measure(anchor, scope, raw, norm) {
  const hay = scope === 'raw' ? raw : norm;
  const exact = occurrences(hay, anchor);
  const loose = occurrencesLoose(hay, anchor);
  const flex = occurrencesFlexible(hay, anchor);
  const other = scope === 'raw' ? occurrences(norm, anchor) : occurrences(raw, anchor);

  console.log(`   ${JSON.stringify(anchor)}  scope=${scope}`);
  console.log(`      exact (what the detector does): ${exact > 0 ? `yes (${exact}x)` : 'NO'}`);
  console.log(`      => the detector would ${exact > 0 ? 'PASS' : 'FAIL'} on this string.`);
  if (exact === 0) {
    // The useful part of a failure: WHICH near-miss, so the fix is a known edit
    // rather than another guess.
    if (loose > 0) {
      console.log(`      !! present ${loose}x ignoring case — seed the capitalisation the page renders.`);
    }
    if (flex > 0) {
      console.log(`      !! present ${flex}x allowing whitespace anywhere inside it — a tag boundary is ` +
        'splitting it. normalize() turns every tag into a space, so seed the form it produces, or drop the ' +
        'punctuation that came adrift.');
    }
    if (other > 0) {
      console.log(`      !! present ${other}x in the OTHER scope (${scope === 'raw' ? 'normalized' : 'raw'}).`);
    }
    if (!loose && !flex && !other) console.log('      (absent in every variant — this string is not on the page)');
  }
  return exact > 0;
}

// --verify: fetch every watched URL and measure whatever this file proposes for
// it. Reads the DB, writes nothing, touches no transaction.
async function verify(pool) {
  // --verify is meant to be run BEFORE the DDL, so it must work on a table that
  // has none of the three columns yet. 42703 = undefined_column.
  let rows;
  try {
    ({ rows } = await pool.query(
      'SELECT id, display_name, source_url, expected_content, anchor_scope FROM spec_watch_list ORDER BY is_test, id'
    ));
  } catch (err) {
    if (err.code !== '42703') throw err;
    console.log(`${TAG} columns not added yet — measuring the candidates in this file.\n`);
    ({ rows } = await pool.query('SELECT id, display_name, source_url FROM spec_watch_list ORDER BY is_test, id'));
  }
  console.log(`${TAG} verifying ${rows.length} watch entr${rows.length === 1 ? 'y' : 'ies'} against the live pages.`);
  console.log(`${TAG} the detector matches EXACTLY and case-sensitively; the extra counts are diagnostic.\n`);

  for (const row of rows) {
    const cand = candidateFor(row.source_url);
    const stored = row.expected_content;
    console.log(`#${row.id} ${row.display_name || '(unnamed)'}`);
    console.log(`   ${row.source_url}`);

    // A row already anchored in the database is measured as-is. That is the
    // regression check: an anchor that verified in August and stops verifying in
    // November is the page changing shape, which is the thing worth knowing.
    if (stored) {
      const raw = await fetchForVerify(row.source_url);
      if (raw === null) continue;
      const norm = normalize(raw);
      console.log(`   normalized ${norm.length} chars   (stored anchor)`);
      measure(stored, row.anchor_scope === 'raw' ? 'raw' : 'normalized', raw, norm);
      console.log('');
      continue;
    }

    if (!cand) {
      console.log('   NO CANDIDATE — this URL is not in this file. Nothing is proposed for it.\n');
      continue;
    }
    if (cand.decision === 'unanchored') {
      // Not measured, on purpose. Fetching it would invite someone to seed the
      // first string that happens to be present, which is the decision being
      // declined.
      console.log('   DELIBERATELY UNANCHORED — not measured.');
      console.log(`   why: ${cand.why}\n`);
      continue;
    }

    const options = cand.decision === 'verify' ? cand.options : [{ anchor: cand.anchor, scope: cand.scope, why: cand.why }];
    const raw = await fetchForVerify(row.source_url);
    if (raw === null) continue;
    const norm = normalize(raw);
    console.log(`   normalized ${norm.length} chars`);
    if (norm.length < 200) {
      console.log(`   !! normalized text is only ${norm.length} chars — this page renders almost nothing ` +
        'server-side, which is exactly the failure the anchor exists to catch.');
    }
    if (cand.decision === 'verify') {
      console.log(`   ${options.length} candidates to choose between. why: ${cand.why}`);
    }
    for (const opt of options) {
      const passed = measure(opt.anchor, opt.scope === 'raw' ? 'raw' : 'normalized', raw, norm);
      console.log(`      why: ${opt.why}`);
      if (passed && cand.decision === 'verify') {
        console.log('      ^ to adopt: set decision to \'seed\' with this anchor, then re-run without --verify.');
      }
    }
    console.log('');
  }
  console.log(`${TAG} verify complete — nothing was written.`);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString) });

  if (VERIFY) {
    try {
      await verify(pool);
    } finally {
      await pool.end();
    }
    return;
  }

  const client = await pool.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);
  console.log(`${TAG} run with --verify FIRST — it fetches every page and measures the anchors.\n`);

  try {
    await client.query('BEGIN');
    for (const [label, sql] of STATEMENTS) {
      await client.query(sql);
      console.log(`  ok  ${label}`);
    }

    // Seed ONLY where no anchor is stored, so a value corrected by hand survives
    // a re-run — and only where the decision is 'seed'. A row left unanchored on
    // purpose must stay that way through every re-run of this script.
    const { rows } = await client.query(
      'SELECT id, display_name, source_url, expected_content FROM spec_watch_list ORDER BY is_test, id'
    );
    console.log(`\n${TAG} ${rows.length} watch entr${rows.length === 1 ? 'y' : 'ies'}:`);
    let seeded = 0;
    let pending = 0;
    let declined = 0;
    let unmatched = 0;
    const name = (row) => String(row.display_name || '').padEnd(24);
    for (const row of rows) {
      const cand = candidateFor(row.source_url);
      if (row.expected_content) {
        console.log(`  #${row.id} ${name(row)} already anchored ${JSON.stringify(row.expected_content)} — left alone`);
        continue;
      }
      if (!cand) {
        unmatched++;
        console.log(`  #${row.id} ${name(row)} NO CANDIDATE for ${row.source_url}`);
        console.log('       ^ this URL is not in this file at all — nobody has looked at it.');
        continue;
      }
      if (cand.decision === 'unanchored') {
        declined++;
        console.log(`  #${row.id} ${name(row)} UNANCHORED BY DECISION — not seeded`);
        console.log(`       ${cand.why}`);
        continue;
      }
      if (cand.decision === 'verify') {
        pending++;
        console.log(`  #${row.id} ${name(row)} AWAITING RE-VERIFY — not seeded`);
        console.log(`       ${cand.why}`);
        console.log(`       ${cand.options.length} candidates in this file; run --verify to measure them.`);
        continue;
      }
      await client.query('UPDATE spec_watch_list SET expected_content = $1, anchor_scope = $2 WHERE id = $3', [
        cand.anchor,
        cand.scope,
        row.id,
      ]);
      seeded++;
      console.log(`  #${row.id} ${name(row)} -> ${JSON.stringify(cand.anchor)} scope=${cand.scope}`);
      console.log(`       ${cand.evidence}`);
    }

    const unanchored = pending + declined + unmatched;
    console.log(`\n${TAG} ${seeded} anchored · ${pending} awaiting re-verify · ${declined} unanchored by ` +
      `decision · ${unmatched} with no candidate at all.`);
    console.log(`${TAG} the next detection run will report  unanchored: ${unanchored}  out of ${rows.length}.`);
    if (unanchored > 0) {
      console.log(
        '  An unanchored entry is NOT unwatched and NOT silently passing: the detector still\n' +
          '  fetches, hashes and compares it, and the run counts it under `unanchored` so the gap\n' +
          '  is visible in the summary rather than absent from it. The three categories above are\n' +
          '  deliberately separate — only `awaiting re-verify` and `no candidate at all` are to-dos.'
      );
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Re-run with --verify to confirm every stored anchor is actually present.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run only when invoked directly. Requiring this module (the smoke test does, to
// check the plan and to unit-test the near-miss diagnostics) must NOT connect to
// a database.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { CANDIDATES, occurrences, occurrencesLoose, occurrencesFlexible, candidateFor };
