'use strict';

// LiveSpec health check — READ-ONLY. Every failure mode found by hand on
// 2026-08-18, turned into something that runs.
//
// All four were real, all four were silent, and all four were found with one-off
// probes rather than by anything in the system:
//
//   1. PER-REQUEST VARIANCE. Google's zwieback id — a hidden 19-20 digit token —
//      made every fetch hash differently. The entry reported `unconfirmed` for
//      five weeks and never surfaced a thing. The digit strip fixes that one;
//      nothing detected it, and nothing would detect the next one.
//   2. THE WRONG PAGE. Meta's row watched the ads-guide INDEX: 2,208 chars of
//      nav, marketing copy and a signup form, containing zero character limits.
//      It reported `unchanged` every week with total confidence. A page that
//      cannot contain what it watches will never flag.
//   3. NO ANCHOR. Meta had none, so nothing verified content had rendered.
//   4. CONTENT SHUFFLE. Meta's per-format pages permute their call-to-action
//      list on every request. Same items, different order.
//
// Plus six checks that came out of the same week and that nothing else in the
// system can perform:
//
//   A. COVERAGE GAP — a page we CITE that no watch row watches. This is the only
//      check that would have caught the LinkedIn Carousel gap, where six
//      enforced fields cited a page nobody watched for a month. Every other tool
//      asks whether the rows we have are healthy; none asks whether the rows we
//      need exist.
//   B. ORPHANED ROW — a watch row whose URL nothing cites. Meta's index row was
//      in this state between the value correction and the split. RED when its
//      affected_fields is non-empty, because those pairs are then gated by a page
//      nothing cites — approvable through the wrong page.
//   C. REDIRECT — fetchText follows redirects silently, so "the wrong page" can
//      arrive without anyone editing a row.
//   D. LIVE HASH COLLISION — two rows hashing identically means both fetched the
//      same thing: a host interstitial, a consent wall, a redirect collapsing
//      several rows onto one page.
//   E. PENDING CHANGE — today's hash against the stored one, so you can see what
//      the next detection run will do before it does it.
//   F. NEAR-EMPTY PAGE — a live length under 200 chars is a JS shell.
//
// NOT DUPLICATED HERE: scripts/auditWatchList.js already checks renamed assets,
// STORED empty-page hashes, STORED hash collisions, and that every pair in every
// entry resolves to a live row. This script does the LIVE equivalents where they
// differ (D, F) and leaves the rest alone — a second implementation of the same
// check is a thing that drifts.
//
// ─── READ-ONLY BY CONSTRUCTION ──────────────────────────────────────────────
// Every query is a SELECT. No UPDATE, no INSERT, no DELETE, no transaction, and
// runDetection is never imported — that writes. Safe to run at any time,
// including while a detection run is in flight. A test asserts all of this
// rather than trusting this paragraph.
//
// ─── WHAT IT MEASURES IS WHAT THE DETECTOR HASHES ───────────────────────────
// Text comes from the detector's own fetchText + hashableText, never a
// reimplementation. The ONE exception is the redirect probe in check C, which
// needs the Response object fetchText does not return; it is a plain fetch and
// is labelled diagnostic. Nothing scored comes from it.
//
//   node scripts/checkSpecHealth.js
//
// Exits 1 if anything needs a human — see THE THRESHOLD below. Manual for now;
// if it is ever wired to railway.cron.json, put it a few hours BEFORE the Monday
// detection run so a broken row is known before the run that would misreport it.

const { getPool } = require('../src/db');
const { getWatchList } = require('../src/db/specWatch');
const {
  fetchText,
  normalize,
  hashableText,
  hashText,
  isObservedPractice,
  UNCONFIRMED_STREAK_ALERT,
} = require('../src/services/specDetector');
// A CHECKER REACHING INTO THE RENDER LAYER, ON PURPOSE.
//
// SPEC_SOURCE_DETAIL is the codebase's ONLY registry of "this URL is a study,
// not a platform spec page" — its entries carry what each source measured and
// what it found, and it is maintained beside the rendering that depends on it.
// The coverage check needs exactly that distinction to tell a real GAP from a
// deliberate non-watch, and duplicating the list here would create a second one
// that drifts the first time a source is added there and not here.
//
// The alternative considered and rejected: two spec_watch_list rows marked
// source_kind = 'observed_practice', mirroring Litmus. It works, but it means
// creating rows whose only purpose is to say "do not look here" — and a row that
// exists to be ignored is a row somebody later mistakes for one that matters.
const { SPEC_SOURCE_DETAIL } = require('../src/destinations/googleDocs');

const TAG = '[spec-health]';

// Delay between the two measured fetches. Long enough that a per-request value
// differs, short enough to keep a 9-row run under a minute.
const REFETCH_MS = 3000;

// TWO THRESHOLDS, AND THEY DIFFER ON PURPOSE — DO NOT "HARMONISE" THEM.
//
// UNCONFIRMED_STREAK_ALERT (3) is IMPORTED from the detector rather than
// restated, so there is one definition of when a streak stops being noise.
//
// FAILURE_STREAK_RED is 2, and lower on purpose. The two counters answer
// different questions. `unconfirmed` means we READ the page, twice, and could not
// get a stable comparison — the confirm step absorbing noise is that mechanism
// working, so one is expected and two is two bad Mondays. `failures` means we
// could not read the page AT ALL, or read something that failed its anchor. That
// is a harder signal: one weekly miss is a blip, two consecutive means the URL or
// the anchor is wrong and no amount of waiting fixes it.
const FAILURE_STREAK_RED = 2;

// Below this the page is a shell, not a document. Deliberately NOT a general
// length floor: the real pages run 82 chars (the test page) to 20,838 (LinkedIn
// carousel), and Meta's index was a respectable 2,208 while being completely
// wrong. The numbers check is the instrument for THAT failure; this only catches
// the degenerate case.
const MIN_USEFUL_CHARS = 200;

// --- helpers ----------------------------------------------------------------

// Host + path, lowercased, trailing slashes and query dropped. A canonical
// http->https or trailing-slash redirect is noise; a PATH change means we are
// hashing a different page than the one we cite, which is the Meta-index defect
// arriving without anyone editing a row.
function normUrl(u) {
  try {
    const x = new URL(String(u));
    return `${x.host}${x.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(u || '').replace(/\/+$/, '').toLowerCase();
  }
}

function ageDays(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
}

function short(u) {
  return String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '');
}

// First differing character position, and both regions with context — the shape
// the one-off diff used when it found the zwieback token.
function diffRegion(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return {
    at: s,
    a: a.slice(Math.max(0, s - 40), a.length - e + 40),
    b: b.slice(Math.max(0, s - 40), b.length - e + 40),
    len: Math.max(a.length - e - s, b.length - e - s),
  };
}

// --- data -------------------------------------------------------------------

// The DISTINCT non-zero limits the pairs in this row's affected_fields carry.
//
// BASE columns, not COALESCE(override, base): a tenant's own house-default number
// is not on the platform's page, and its absence would be a false alarm. The
// question this check asks is whether the PAGE still states what we cite it for.
async function citedNumbers(pool, affected) {
  if (!Array.isArray(affected) || affected.length === 0) return [];
  const res = await pool.query(
    `SELECT DISTINCT n FROM (
       SELECT cf.char_max AS n
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.is_active AND cf.char_max > 0
          AND (at.name, cf.field_name) IN (
            SELECT p->>'asset', p->>'field' FROM jsonb_array_elements($1::jsonb) p)
       UNION ALL
       SELECT cf.char_min
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.is_active AND cf.char_min > 0
          AND (at.name, cf.field_name) IN (
            SELECT p->>'asset', p->>'field' FROM jsonb_array_elements($1::jsonb) p)
     ) q ORDER BY n`,
    [JSON.stringify(affected)]
  );
  return res.rows.map((r) => Number(r.n));
}

// Every page we present as a source for a live tiered field.
async function citedUrls(pool) {
  const res = await pool.query(
    `SELECT DISTINCT cf.spec_source AS url
       FROM copy_fields cf
       JOIN asset_types at ON at.id = cf.asset_type_id
      WHERE at.is_active
        AND cf.spec_type IN ('enforced', 'recommended')
        AND cf.spec_source IS NOT NULL
        AND cf.spec_source <> 'quillio_default'
      ORDER BY 1`
  );
  return res.rows.map((r) => r.url);
}

// spec_review_queue is the ledger of CONFIRMED hash movement — recordChange
// inserts a row before advancing the hash, in one transaction. Zero rows means
// this entry has never moved since its baseline.
async function movementCounts(pool) {
  const res = await pool.query(
    'SELECT watch_id, COUNT(*)::int AS n, MAX(detected_at) AS last FROM spec_review_queue GROUP BY watch_id'
  );
  const m = new Map();
  for (const r of res.rows) m.set(String(r.watch_id), { n: r.n, last: r.last });
  return m;
}

// --- the per-row check ------------------------------------------------------

async function checkRow(pool, row, moved) {
  const out = { row, red: [], amber: [], lines: [], liveHash: null, skipped: false };
  const say = (k, v) => out.lines.push(`  ${k.padEnd(9)} ${v}`);

  if (isObservedPractice(row)) {
    out.skipped = true;
    return out;
  }

  // C — REDIRECT. Diagnostic only: a plain fetch, because fetchText returns text
  // and this needs the Response. Nothing scored below comes from it.
  let landed = null;
  try {
    const res = await fetch(row.source_url, {
      headers: { 'User-Agent': 'Quillio-LiveSpecs/1.0 (spec-watch)' },
    });
    landed = res.url || null;
  } catch {
    landed = null; // the measured fetch below reports the real failure
  }

  let rawA;
  let rawB;
  try {
    rawA = await fetchText(row.source_url);
    await new Promise((r) => setTimeout(r, REFETCH_MS));
    rawB = await fetchText(row.source_url);
  } catch (err) {
    const streak = Number(row.consecutive_failures) || 0;
    const msg = `fetch failed: ${err.message}`;
    if (streak >= FAILURE_STREAK_RED) out.red.push(`${msg} (and ${streak} consecutive failures already)`);
    else out.amber.push(`${msg} — could be transient, ${streak} consecutive so far`);
    say('fetch', `FAILED — ${err.message}`);
    return out;
  }

  const fullA = normalize(rawA);
  const fullB = normalize(rawB);
  const cutA = hashableText(row, rawA);
  const cutB = hashableText(row, rawB);

  // MARKER, first — a missing one makes everything below unmeasurable, exactly as
  // it makes the row `failed` in the detector.
  if (row.content_stop_marker) {
    if (cutA === null || cutB === null) {
      out.red.push(`stop marker not found: ${JSON.stringify(row.content_stop_marker)}`);
      say('marker', `${JSON.stringify(row.content_stop_marker)} ABSENT`);
      return out;
    }
    say('marker', `${JSON.stringify(row.content_stop_marker)} drops ${fullA.length - cutA.length}`);
  } else {
    say('marker', 'none');
  }

  const a = cutA === null ? fullA : cutA;
  const b = cutB === null ? fullB : cutB;
  out.liveHash = hashText(a);

  // 1 + 4 — VARIANCE.
  const fullVaries = fullA !== fullB;
  const cutVaries = a !== b;
  if (cutVaries) {
    const d = diffRegion(a, b);
    out.red.push(`hashed text VARIES between fetches (${d.len} chars at ~${d.at})`);
    say('variance', `HASHED VARIES — ${d.len} chars at ~${d.at}`);
    out.lines.push(`            A: ${JSON.stringify(d.a.replace(/\s+/g, ' '))}`);
    out.lines.push(`            B: ${JSON.stringify(d.b.replace(/\s+/g, ' '))}`);
  } else if (fullVaries) {
    // Worth seeing rather than inferring: the marker is doing its job.
    say('variance', 'full VARIES / hashed STABLE (marker works)');
  } else {
    say('variance', 'STABLE');
  }

  // F — NEAR-EMPTY.
  //
  // NEVER RED ON is_test. The test page is 82 characters BY DESIGN — a deliberate
  // minimal fixture an admin edits to exercise the detector — so the floor that
  // catches a real page turning into a JS shell is meaningless on it.
  //
  // This was the first red this check ever produced, and it was a false one. A
  // red nobody can act on is how a check teaches people to ignore it, which is
  // the Litmus lesson arriving from a new direction: getting that wrong on run
  // one is worse than not having the check.
  if (a.length < MIN_USEFUL_CHARS && !row.is_test) {
    out.red.push(`hashed text is ${a.length} chars — a shell, not a document`);
  }
  say('length', `${a.length} hashed / ${fullA.length} normalized` +
    (row.is_test && a.length < MIN_USEFUL_CHARS ? '  (small by design — test fixture)' : ''));

  // C — the comparison.
  if (landed && normUrl(landed) !== normUrl(row.source_url)) {
    out.red.push(`redirects to a different path: ${short(landed)}`);
    say('redirect', `-> ${short(landed)}  PATH CHANGED`);
  }

  // 3 — ANCHOR, counted in the HASHED region only.
  const anchor = typeof row.expected_content === 'string' ? row.expected_content.trim() : '';
  if (!anchor) {
    out.red.push('no anchor — nothing verifies the content rendered');
    say('anchor', 'NONE SET');
  } else {
    const hay = row.anchor_scope === 'raw' ? rawA : a;
    const exact = hay.split(anchor).length - 1;
    if (exact > 0) {
      say('anchor', `${JSON.stringify(anchor)} ${exact}x in hashed`);
    } else {
      const loose = hay.toLowerCase().split(anchor.toLowerCase()).length - 1;
      const flexChars = anchor.replace(/\s+/g, '').split('');
      const flexRe = new RegExp(flexChars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'gi');
      const flex = (hay.match(flexRe) || []).length;
      // ALSO IN THE DISCARDED TAIL? A trap for whoever meets this next: they will
      // find the string on the page, decide the check is broken, and "fix" it by
      // pointing at text we throw away.
      const tail = cutA === null ? 0 : fullA.slice(a.length).split(anchor).length - 1;
      out.red.push(
        `anchor ${JSON.stringify(anchor)} ABSENT from the hashed region` +
        (loose > 0 ? ` (present ${loose}x ignoring case — capitalisation changed?)` : '') +
        (loose === 0 && flex > 0 ? ` (present ${flex}x allowing whitespace — a tag boundary is splitting it)` : '') +
        (tail > 0 ? ` (present ${tail}x AFTER the marker, in text we discard — do NOT anchor there)` : '')
      );
      say('anchor', `${JSON.stringify(anchor)} ABSENT` +
        (loose > 0 ? `  (${loose}x ignoring case)` : '') +
        (tail > 0 ? `  (${tail}x in discarded tail)` : ''));
    }
  }

  // 2 — DOES THE PAGE CONTAIN THE NUMBERS WE CITE IT FOR?
  //
  // A FLOOR, NOT A CENSUS, and the output says so. "Contains 70" is weak — short
  // numbers appear incidentally in dates and pixel sizes. Containing NONE of them
  // is strong evidence of the Meta-index defect.
  if (row.is_test) {
    say('numbers', 'n/a (test row, no affected_fields)');
  } else {
    const nums = await citedNumbers(pool, row.affected_fields);
    if (nums.length === 0) {
      out.amber.push('no cited numbers to check — affected_fields is empty');
      say('numbers', 'none cited (empty gate)');
    } else {
      const hits = nums.filter((n) => a.includes(String(n)));
      if (hits.length === 0) {
        out.red.push(
          `the page contains NONE of the ${nums.length} numbers this row is cited for ` +
          `(${nums.join(', ')}) — this is the wrong page`
        );
      }
      say('numbers', nums.map((n) => `${n}${a.includes(String(n)) ? ' ok' : ' MISSING'}`).join(' · '));
    }
  }

  // E — PENDING CHANGE. Informational, never red: this is the system working.
  if (!row.current_hash) {
    say('hash', 'no baseline yet — next run will set one');
  } else if (row.current_hash === out.liveHash) {
    say('hash', 'matches stored');
  } else {
    out.amber.push('today\'s hash differs from stored — the next run will flag or refetch');
    say('hash', 'DIFFERS from stored — a change is pending detection');
  }

  // STALENESS.
  const unconf = Number(row.consecutive_unconfirmed) || 0;
  const fails = Number(row.consecutive_failures) || 0;
  if (unconf >= UNCONFIRMED_STREAK_ALERT) {
    out.red.push(`${unconf} consecutive unconfirmed runs — not being watched (${row.last_unconfirmed_reason || 'no reason recorded'})`);
  }
  if (fails >= FAILURE_STREAK_RED) {
    out.red.push(`${fails} consecutive failures — ${row.last_error || 'no error recorded'}`);
  }
  const d = ageDays(row.last_checked_at);
  say('checked', row.last_checked_at ? `${d}d ago` : 'never');
  say('streaks', `unconfirmed ${unconf} · failures ${fails}${row.last_error ? ` · ${row.last_error}` : ''}`);

  // MOVEMENT, WITH THE ROW'S AGE BESIDE IT.
  //
  // "never since baseline" reads as neutral and is not — it means opposite things
  // depending on how long the row has existed. A row created today has had no
  // opportunity to move, so the absence says nothing. A row watching the same page
  // for months without moving is a real observation about the page. Without the
  // age the reader cannot tell an absence of evidence from evidence of absence,
  // and both render as the same four words.
  const mv = moved.get(String(row.id));
  const rowAge = ageDays(row.created_at);
  const ageText = rowAge === null ? 'age unknown'
    : rowAge === 0 ? 'row created today'
      : `row created ${rowAge}d ago`;
  say('moved', mv
    ? `${mv.n}x, last ${ageDays(mv.last)}d ago  (${ageText})`
    : `never since baseline (${ageText})`);

  return out;
}

// --- main -------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(`${TAG} DATABASE_URL not set — cannot assess. That is not healthy.`);
    process.exit(1);
  }
  const pool = getPool();
  if (!pool) {
    console.error(`${TAG} no database pool — cannot assess.`);
    process.exit(1);
  }

  const rows = await getWatchList();
  const moved = await movementCounts(pool);
  const cited = await citedUrls(pool);
  const citedNorm = new Set(cited.map(normUrl));
  const watchedNorm = new Set(rows.map((r) => normUrl(r.source_url)));

  const results = [];
  for (const row of rows) {
    // One row failing must never stop the others.
    try {
      results.push(await checkRow(pool, row, moved));
    } catch (err) {
      results.push({ row, red: [`health check itself threw: ${err.message}`], amber: [], lines: [], skipped: false });
    }
  }

  // D — LIVE HASH COLLISION.
  const byHash = new Map();
  for (const r of results) {
    if (!r.liveHash) continue;
    if (!byHash.has(r.liveHash)) byHash.set(r.liveHash, []);
    byHash.get(r.liveHash).push(r);
  }
  for (const [, group] of byHash) {
    if (group.length < 2) continue;
    const names = group.map((g) => g.row.display_name || g.row.source_url).join(', ');
    for (const g of group) g.red.push(`live hash identical to another row (${names}) — both fetched the same thing`);
  }

  // B — ORPHANED ROW.
  for (const r of results) {
    if (r.skipped || r.row.is_test) continue;
    if (citedNorm.has(normUrl(r.row.source_url))) continue;
    const pairs = Array.isArray(r.row.affected_fields) ? r.row.affected_fields.length : 0;
    if (pairs > 0) {
      r.red.push(`nothing cites this URL, yet its gate holds ${pairs} pair(s) — approvable through a page we do not cite`);
    } else {
      r.amber.push('nothing cites this URL and its gate is empty — the row does nothing');
    }
  }

  // A — COVERAGE GAP, split from the deliberate non-watches.
  //
  // A research citation is NOT a gap. CLAUDE.md: "if the page states a limit the
  // platform enforces, watch it. If the page reports what someone measured, cite
  // it and leave it alone." A study does not change, it AGES, so hash-diffing one
  // measures the wrong variable and every layout tweak the publisher ships fills
  // the queue with noise — the Litmus finding, which cost six dismissed flags.
  //
  // They are REPORTED IN THEIR OWN SECTION rather than skipped, so a reader can
  // see that two cited URLs have no watch row and that this is intentional,
  // without having to already know why.
  const uncovered = [];
  const research = [];
  for (const url of cited) {
    if (watchedNorm.has(normUrl(url))) continue;
    if (SPEC_SOURCE_DETAIL[url]) {
      research.push({ url, detail: SPEC_SOURCE_DETAIL[url] });
      continue;
    }
    // DISTINCT (asset, field) PAIRS, NOT ROWS. A plain COUNT(*) counts one row
    // per tenant, so on a two-tenant database every figure here doubled and the
    // line read "cited by 2 tiered fields" about a single field. affected_fields
    // is a pair list, so a pair count is also the number that compares to it.
    const n = await pool.query(
      `SELECT COUNT(DISTINCT (at.name, cf.field_name))::int AS n
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.is_active AND cf.spec_source = $1 AND cf.spec_type IN ('enforced','recommended')`,
      [url]
    );
    uncovered.push({ url, fields: n.rows[0].n });
  }

  // --- output ---------------------------------------------------------------

  const W = 52;
  for (const r of results) {
    console.log('─'.repeat(W));
    if (r.skipped) {
      console.log(`SKIP  ${r.row.display_name || short(r.row.source_url)}`);
      console.log('      observed_practice — not fetched, not hashed');
      continue;
    }
    const status = r.red.length ? 'RED ' : r.amber.length ? 'WARN' : 'OK  ';
    console.log(`${status}  ${r.row.display_name || '(no name)'}`);
    console.log(`      ${short(r.row.source_url)}`);
    for (const l of r.lines) console.log(l);
    for (const x of r.red) console.log(`  !! ${x}`);
    for (const x of r.amber) console.log(`  ~  ${x}`);
  }

  console.log('─'.repeat(W));
  const red = results.filter((r) => r.red.length);
  const warn = results.filter((r) => !r.red.length && r.amber.length);
  const ok = results.filter((r) => !r.red.length && !r.amber.length && !r.skipped);
  const skipped = results.filter((r) => r.skipped);

  // NAMES, NOT COUNTS. A count would not have shown Description leaving the gate.
  if (red.length || uncovered.length) {
    console.log('\nNEEDS ATTENTION');
    for (const r of red) {
      for (const x of r.red) console.log(`  ${r.row.display_name || short(r.row.source_url)} — ${x}`);
    }
    for (const u of uncovered) {
      console.log(`  ${short(u.url)} — cited by ${u.fields} tiered field(s) (distinct pairs), on no watch row`);
    }
  }
  if (warn.length) {
    console.log('\nWORTH A LOOK');
    for (const r of warn) {
      for (const x of r.amber) console.log(`  ${r.row.display_name || short(r.row.source_url)} — ${x}`);
    }
  }
  // NAMED, NOT SILENCED — and deliberately not folded into OK, because these are
  // not watched rows at all. They are cited pages we have decided never to watch.
  if (research.length) {
    console.log('\nDELIBERATELY UNWATCHED (research citation)');
    for (const r of research) {
      console.log(`  ${short(r.url)}`);
      console.log(`    ${r.detail.scope} — ${r.detail.finding}`);
    }
    console.log('    A study does not change, it ages. Hash-watching one measures');
    console.log('    the wrong variable and fills the queue with layout noise.');
  }
  if (ok.length) console.log(`\nOK  ${ok.map((r) => r.row.display_name).join(', ')}`);
  if (skipped.length) {
    console.log(`SKIPPED  ${skipped.map((r) => r.row.display_name).join(', ')} (observed_practice)`);
  }

  // THE TWO LIMITATIONS, PRINTED RATHER THAN BURIED. A reader who is not told
  // these will infer a guarantee this script does not provide — the same reason
  // the reference-stats block says its figures are REPORTED, not verified.
  console.log(`
${'─'.repeat(W)}
LIMITS OF THIS CHECK
  STABLE IS NOT PROOF OF STABILITY. It is the absence of ONE
  specific failure mode. Two fetches ${REFETCH_MS / 1000}s apart catch a
  per-request value; they cannot catch one that rotates
  hourly, per session or per CDN edge. THAT failure does not
  produce an unconfirmed row — it produces a CONFIRMED FLAG,
  which looks like a real spec change and would be reviewed
  as one. It is the failure this script cannot see.

  NUMBERS PRESENT IS A FLOOR, NOT A CENSUS. Containing none
  of its own numbers is strong evidence a row watches the
  wrong page. Containing them is weak evidence of anything —
  short numbers appear incidentally in dates and pixel sizes.`);

  const fail = red.length > 0 || uncovered.length > 0;
  console.log(`\n${TAG} ${fail ? 'ATTENTION NEEDED' : 'all watched rows healthy'}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`${TAG} ${err.message}`);
  process.exit(1);
});
