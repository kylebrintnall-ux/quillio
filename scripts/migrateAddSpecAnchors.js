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
// These are CANDIDATES. They were chosen without being able to see the pages —
// this repo's environment denies egress to every one of these hosts — and a
// plausible anchor and a working one are indistinguishable by eye, which is the
// whole reason the feature exists. So:
//
//   node scripts/migrateAddSpecAnchors.js --verify
//
// fetches every watch URL from a box that HAS egress (the Railway console) and
// prints, per entry: HTTP status, normalized length, and whether the candidate is
// present in the raw body and in the normalized text, with occurrence counts.
// Read that before committing. A candidate that is absent, or that occurs 40
// times, is the wrong string.
//
// Dry run by default: applies inside a transaction, prints the state, ROLLBACKs.
// --commit writes. Idempotent — the DDL is IF NOT EXISTS and the seed only fills
// a row whose anchor is still NULL, so re-running never overwrites a value you
// corrected by hand.
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
// `why` is printed by --verify next to the measurement, so the reasoning and the
// evidence are read together. `confidence` is mine, stated plainly: `certain`
// only where I can see the page's source in this repo.
const CANDIDATES = [
  {
    match: 'linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs',
    anchor: 'Introductory text',
    scope: 'normalized',
    confidence: 'medium',
    why:
      "LinkedIn's own label for the field whose limit we store, so it is content rather than chrome. " +
      'An auth wall or a 404 on this host still carries LinkedIn nav markup, which is why the anchor is a ' +
      'SPEC-TABLE label and not the page title.',
  },
  {
    match: 'business.x.com/en/help/campaign-setup/creative-ad-specifications',
    anchor: 'Creative ad specifications',
    scope: 'normalized',
    confidence: 'medium',
    why:
      "The page's own heading. Weaker than a spec label — a breadcrumb on a sibling help page could carry " +
      'it — but X exposes fewer stable in-content strings and this at least cannot appear on a generic 404.',
  },
  {
    match: 'support.google.com/google-ads/answer/17090561',
    anchor: 'Responsive display ads',
    scope: 'normalized',
    confidence: 'medium',
    why:
      "The help article's subject. Google's help 404 renders a distinct 'page not found' shell, so this " +
      'should separate them — but Google help is heavily templated and the phrase may also sit in a related-links rail.',
  },
  {
    match: 'facebook.com/business/ads-guide',
    anchor: 'ads-guide',
    scope: 'raw',
    confidence: 'LOW — expect this one to fail verification',
    why:
      'THE HARD ONE, and the honest answer may be that this page cannot be watched this way. It is ' +
      'JS-rendered, so the server HTML likely carries no spec text at all and no anchor drawn from the ' +
      'visible page can work. This candidate is a raw-body check for the canonical/og URL fragment in the ' +
      'head, which asserts only "this is the ads-guide document" and not "the content rendered". If ' +
      "--verify shows the normalized text is near-empty, the anchor is not the fix for this row. Note also " +
      "that Meta was RETIERED enforced -> recommended, and CLAUDE.md's rule is that pages reporting advice " +
      'rather than enforced limits do not belong on the watch list — so removing this row may be more ' +
      'correct than anchoring it.',
  },
  {
    match: 'litmus.com/blog/how-to-write-the-perfect-subject-line',
    anchor: 'subject line',
    scope: 'normalized',
    confidence: 'low',
    why:
      "The article's own subject, but two words that a blog's related-posts rail and nav will also carry — " +
      'so it may well survive on a Litmus error page and never fire. If --verify shows a high occurrence ' +
      'count, that is the tell, and the replacement should be a phrase from the claim we actually cite ' +
      "(the spec_note says 'Mobile inboxes cut around 40').",
  },
  {
    match: 'litmus.com/blog/the-ultimate-guide-to-preview-text-support',
    anchor: 'preview text',
    scope: 'normalized',
    confidence: 'low-medium',
    why:
      "The article's subject, and more distinctive than 'subject line' because preview text is a narrower " +
      'topic — but the same related-posts risk applies.',
  },
  {
    match: '/admin/test-spec',
    anchor: 'Quillio Test Spec',
    scope: 'normalized',
    confidence: 'certain',
    why:
      'The only one I can verify from source. routes/admin.js serves this page with a fixed ' +
      '<title>Quillio Test Spec</title> shell around the editable <pre> body, so the anchor sits OUTSIDE ' +
      'the content an admin edits to trigger a detection — editing the page to test the detector can never ' +
      'break its own anchor. The title text survives normalize (it is not inside script/style).',
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

// --verify: fetch every watched URL and measure the candidate against it. Reads
// the DB, writes nothing, touches no transaction.
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
  console.log(`${TAG} verifying ${rows.length} watch entr${rows.length === 1 ? 'y' : 'ies'} against the live pages.\n`);

  for (const row of rows) {
    const cand = candidateFor(row.source_url);
    const stored = row.expected_content;
    const anchor = stored || (cand && cand.anchor) || null;
    const scope = stored ? row.anchor_scope : (cand && cand.scope) || 'normalized';

    console.log(`#${row.id} ${row.display_name || '(unnamed)'}`);
    console.log(`   ${row.source_url}`);
    if (!anchor) {
      console.log('   NO CANDIDATE — this entry has no anchor and none is proposed here.\n');
      continue;
    }
    console.log(`   anchor: ${JSON.stringify(anchor)}  scope=${scope}  ${stored ? '(stored)' : `(candidate, confidence: ${cand.confidence})`}`);

    let raw;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(row.source_url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Quillio-LiveSpecs/1.0 (spec-watch)' },
      });
      clearTimeout(timer);
      raw = await res.text();
      console.log(`   HTTP ${res.status}  raw ${raw.length} chars`);
      if (!res.ok) console.log('   ^ NON-2xx: the detector would already call this `error`, anchor or not.');
    } catch (err) {
      console.log(`   FETCH FAILED: ${err.message}`);
      console.log('   ^ the detector would call this `error` — unreachable, not unanchored.\n');
      continue;
    }

    const norm = normalize(raw);
    const inRaw = occurrences(raw, anchor);
    const inNorm = occurrences(norm, anchor);
    console.log(`   normalized ${norm.length} chars`);
    console.log(`   present in RAW:        ${inRaw > 0 ? `yes (${inRaw}x)` : 'NO'}`);
    console.log(`   present in NORMALIZED: ${inNorm > 0 ? `yes (${inNorm}x)` : 'NO'}`);

    const wouldPass = scope === 'raw' ? inRaw > 0 : inNorm > 0;
    console.log(`   => with scope=${scope}, the detector would ${wouldPass ? 'PASS' : 'FAIL'} this entry.`);
    if (norm.length < 200) {
      console.log(`   !! normalized text is only ${norm.length} chars — this page renders almost nothing ` +
        'server-side, which is exactly the failure the anchor exists to catch.');
    }
    if (!wouldPass && (scope === 'raw' ? inNorm > 0 : inRaw > 0)) {
      console.log(`   !! it IS present in the other scope — ${scope === 'raw' ? 'normalized' : 'raw'} may be the right one here.`);
    }
    if (cand && !stored) console.log(`   why: ${cand.why}`);
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
    // a re-run. This is the whole idempotency story for the data half.
    const { rows } = await client.query(
      'SELECT id, display_name, source_url, expected_content FROM spec_watch_list ORDER BY is_test, id'
    );
    console.log(`\n${TAG} ${rows.length} watch entr${rows.length === 1 ? 'y' : 'ies'}:`);
    let seeded = 0;
    let unmatched = 0;
    for (const row of rows) {
      const cand = candidateFor(row.source_url);
      if (row.expected_content) {
        console.log(`  #${row.id} ${String(row.display_name || '').padEnd(24)} already anchored ${JSON.stringify(row.expected_content)} — left alone`);
        continue;
      }
      if (!cand) {
        unmatched++;
        console.log(`  #${row.id} ${String(row.display_name || '').padEnd(24)} NO CANDIDATE for ${row.source_url}`);
        console.log('       ^ stays unanchored: still fetched, hashed and compared, and reported as unanchored.');
        continue;
      }
      await client.query('UPDATE spec_watch_list SET expected_content = $1, anchor_scope = $2 WHERE id = $3', [
        cand.anchor,
        cand.scope,
        row.id,
      ]);
      seeded++;
      console.log(`  #${row.id} ${String(row.display_name || '').padEnd(24)} -> ${JSON.stringify(cand.anchor)} scope=${cand.scope} (${cand.confidence})`);
    }

    console.log(`\n${TAG} ${seeded} anchored, ${unmatched} left without a candidate.`);
    if (unmatched > 0) {
      console.log(
        '  An unanchored entry is NOT unwatched and NOT silently passing: the detector still\n' +
          '  fetches, hashes and compares it, and the run counts it under `unanchored` so the gap\n' +
          '  is visible in the summary rather than absent from it.'
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
