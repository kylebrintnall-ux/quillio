'use strict';

// August 2026 — seed 'Google Responsive Search Ad' into already-seeded tenants,
// and put its spec page on the watch list.
//
// The twenty-sixth asset, and the first NEW one since the prune took the library
// from 30 to 25. src/data/defaultAssets.js carries the same asset for tenants
// seeded from now on; this is the other half.
//
// ─── THE FETCHED PAGE ───────────────────────────────────────────────────────
// https://support.google.com/google-ads/answer/7684791 — "About responsive
// search ads". Read through the detector's own fetchText + normalize from the
// Railway console (scripts/probeGoogleSearchSpec.js), 2026-08-21. Verbatim, per
// CLAUDE.md's fetch rule, so every number below can be checked without leaving
// this file:
//
//   "To help your ads show in their entirety when possible, responsive search
//    ads have character limits. The headline fields for responsive search ads
//    support up to 30 characters. The description fields support up to 90
//    characters each, and the path fields support up to 15 each. Every character
//    in a double width language like Korean, Japanese, or Chinese counts as 2
//    characters."
//
//   "You’ll need to enter a minimum of 3 headlines, but you can enter up to 15.
//    Enter your descriptions. You’ll need to enter a minimum of 2 descriptions"
//
//   normalized 18,144 chars, STABLE across two fetches. No 12+ digit run.
//   30 appears 3x, 90 2x, 15 5x — each read in context, not counted.
//
// THE APOSTROPHES ARE U+2019. The page renders curly; a transcription with
// straight quotes reports ABSENT and looks exactly like a false claim. That cost
// one round, and scripts/probeGoogleSearchSpec.js now reports the two cases
// differently for the next reader.
//
// ─── WHY enforced, AND WHY THE LinkedIn CAUTION DOES NOT APPLY ──────────────
// CLAUDE.md carries an OPEN QUESTION about LinkedIn's nine enforced fields.
// Nothing in it transfers here, and reading it as though it does would be the
// wrong lesson from the right document.
//
// What opened LinkedIn's question is a HEADING: both LinkedIn spec pages put
// their numbers under "Text Recommendations" — recommendation language sitting
// over a tier that claims a cap, which is the same evidence that retiered Meta's
// ten in July. Google's page has no such tension. It says the words "character
// limits" in its own prose, and "support up to N characters" is a ceiling.
//
// Different evidence, different tier. What WOULD reopen it is what would settle
// LinkedIn: paste 200 characters into a 30-character headline in the ads
// interface and watch whether it is refused, warned, or accepted.
//
// ─── ONE PAGE, NOT ONE VIEW OF IT ───────────────────────────────────────────
// Checked, because this is exactly where Meta's ads guide was wrong twice: a
// format page serving one PLACEMENT's numbers by default while naming no
// placement. "placement" appears 1x in the normalized text here, "device" 1x,
// "mobile" 1x — prose, not a repeated selector menu. Meta's /image carried
// "placement" 4x as a live control. And of the 14 answer ids this page links, 5
// were opened including 9921843 ("ad format requirements", the one its own
// sentence points at); three mention responsive search ads and NONE publishes a
// character limit. 7684791 is the authority.
//
// ─── THE PATH COUNT IS NOT ON THE PAGE, AND THAT IS WRITTEN DOWN ────────────
// "the path fields support up to 15 each" publishes the LIMIT and states no
// COUNT. Two Display Path fields is the shape of Google's interface, not a
// figure anybody can trace to this text.
//
// It is seeded anyway and recorded here rather than quietly shipped. The
// alternative to recording it is a number sitting in a library whose entire
// claim is that its numbers are sourced, indistinguishable from the ones that
// are — which is the defect scripts/migrateSpecIntegrityFixes.js shipped when it
// corrected Meta by comparing against LinkedIn. A gap that is written down is a
// gap. A gap that is not is a false claim.
//
// The 15 IS cited, and it is the number that constrains the writing. The 2
// decides only how many boxes exist.
//
// ─── THREE HEADLINES, NOT FIFTEEN ───────────────────────────────────────────
// 3 and 2 are the page's OWN MINIMUMS, quoted above — not a sample somebody
// chose. Google accepts up to 15 headlines; seeding 15 empty fields puts a
// writer in front of a wall before the product has written anything, and Riffs
// is the feature that covers the gap. One field per SHAPE, more by riffing.
//
// ─── THE WATCH ROW ──────────────────────────────────────────────────────────
// Anchor: "responsive search ads have character limits" — measured 1x exact in
// the hashed text. It is the sentence that INTRODUCES the spec block, so it
// cannot appear on a 404, an auth wall or a consent interstitial: none of them
// has a spec block to introduce. It is CONTENT, not chrome.
//
// No content_stop_marker: 18,144 chars both fetches, nothing per-request.
//
// affected_fields is DERIVED at run time from copy_fields.spec_source, never
// pasted — 7 pairs, the three graphic-copy fields being house_default with the
// quillio_default sentinel and correctly outside the gate.
//
// ─── WHAT MAKES THIS REFUSE ─────────────────────────────────────────────────
// It fetches the page BEFORE it writes anything and stops on any of:
//   • a quoted sentence missing from the page (the header would be lying)
//   • the anchor absent (an anchor that cannot fail is worse than none)
//   • the page varying between two fetches (it would need a stop marker)
//   • the derivation returning anything but 7 pairs
//   • a tenant already holding an asset of this name
// A run with no network is a refusal, not a fallback. The point of the fetch
// rule is that the page is read at the moment the value is written.
//
//   node scripts/migrateAddGoogleSearchAsset.js --verify   # fetch + measure, no DB
//   node scripts/migrateAddGoogleSearchAsset.js            # dry run (ROLLBACK)
//   node scripts/migrateAddGoogleSearchAsset.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[google-search-asset]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const URL = 'https://support.google.com/google-ads/answer/7684791';
const ASSET = 'Google Responsive Search Ad';
const GROUP = 'Paid Search';
const DISPLAY = 'Google – responsive search';
const ANCHOR = 'responsive search ads have character limits';
const ANCHOR_SCOPE = 'normalized';

// The asset this one sits beside. Used only to place sort_order — see
// insertAsset() for why it is anchored on the tenant's own row rather than on a
// number from the seed.
const SIBLING = 'Google Responsive Display Ad';

// The date a human read the page. Hardcoded rather than NOW(), for the reason
// scripts/migrateBackfillSpecVerifiedAt.js states at length: NOW() stamps
// whenever somebody happened to execute the file, which is a different event
// from the one being recorded.
const VERIFIED_ON = '2026-08-21';

// Asserted against the fetched page before anything is written. A quote nobody
// re-checked is the same unverified claim as an uncited number, and the header
// above is where a future reader goes instead of the page.
const QUOTES = [
  'responsive search ads have character limits',
  'The headline fields for responsive search ads support up to 30 characters',
  'The description fields support up to 90 characters each, and the path fields support up to 15 each',
  // ADDED with scripts/migrateAddGoogleCjkDirection.js. This clause was in the
  // header from the 2026-08-21 dump and in no gate, so nothing asserted it was
  // still on the page. It is the citation for that migration's Responsive Search
  // sentence, and a citation nothing checks is the shape this file exists to
  // avoid. NOT re-dumped — the span is lifted from the header quote above it.
  //
  // UNHYPHENATED "double width language" and "counts as 2 characters" — this
  // page's wording. Performance Max says "double-width languages" and "counts as
  // 2 towards the limit instead of one". The two must never be merged into one
  // span; a hybrid that reads correctly and matches nothing is how the X
  // media-headline quote was wrong.
  'Every character in a double width language like Korean, Japanese, or Chinese counts as 2 characters',
  'You’ll need to enter a minimum of 3 headlines, but you can enter up to 15',
  'You’ll need to enter a minimum of 2 descriptions',
];

// KEPT BYTE-IDENTICAL to the RAW entry in src/data/defaultAssets.js. A smoke test
// asserts the two agree in both directions — a tenant seeded today and a tenant
// migrated today must hold the same rows, or the two populations render
// different specs for the same field.
//
// [field_name, char_min, char_max, group_label|null, spec_type]
const FIELDS = [
  ['Headline 1', 0, 30, null, 'enforced'],
  ['Headline 2', 0, 30, null, 'enforced'],
  ['Headline 3', 0, 30, null, 'enforced'],
  ['Description 1', 0, 90, null, 'enforced'],
  ['Description 2', 0, 90, null, 'enforced'],
  ['Display Path 1', 0, 15, null, 'enforced'],
  ['Display Path 2', 0, 15, null, 'enforced'],
  ['Graphic Headline', 0, 70, 'Graphic Copy', 'house_default'],
  ['Subhead', 20, 40, 'Graphic Copy', 'house_default'],
  ['CTA Button', 0, 30, 'Graphic Copy', 'house_default'],
];

const DIRECTION = 'They are already looking. Match the intent, name the thing, skip the setup.';

const ASSET_NOTE =
  'Google assembles each ad from the headlines and descriptions supplied, so every headline must read on its own and beside any other. Three headlines and two descriptions are Google’s stated minimum; it accepts up to 15 headlines — riff for more rather than seeding empty slots.';

// The sentinel every house_default field carries. Never a URL.
const HOUSE_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

const EXPECTED_PAIRS = FIELDS.filter((f) => f[4] === 'enforced').length; // 7

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// Value checks match WHOLE NUMBERS; count() stays a substring test for quotes
// and the anchor. See scripts/lib/wholeNumber.js — a substring count of "30" on
// a Google specs page also counts the 30 inside "300" and "1030".
const { countWholeNumber } = require('./lib/wholeNumber');

// --- the page ---------------------------------------------------------------
// Returns { ok, why } and prints what it measured. Called by --verify and by
// every write path, so a value is never written without the page being read in
// the same run.
async function readPage() {
  const { fetchText, normalize, hashableText } = require('../src/services/specDetector');
  console.log(`\n${'='.repeat(74)}\n${DISPLAY}  ${URL}\n${'='.repeat(74)}`);

  let a;
  let b;
  try {
    const rawA = await fetchText(URL);
    await new Promise((r) => setTimeout(r, 2500));
    const rawB = await fetchText(URL);
    // content_stop_marker is null for this row, so hashableText is normalize().
    // Called through the helper anyway, so this measures the real path.
    a = hashableText({ content_stop_marker: null }, rawA);
    b = hashableText({ content_stop_marker: null }, rawB);
  } catch (err) {
    return { ok: false, why: `fetch failed: ${err.message}. A run with no network is a refusal, not a fallback.` };
  }

  console.log(`   hashed ${a.length} chars`);
  const stable = a === b;
  console.log(`   across two fetches: ${stable ? 'STABLE — no stop marker needed' : 'VARIES — needs a marker'}`);
  if (!stable) return { ok: false, why: 'the page varies between fetches; it needs a content_stop_marker before it can be watched' };

  let missing = 0;
  for (const q of QUOTES) {
    const n = count(a, q);
    if (n === 0) missing += 1;
    console.log(`   ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 62))}${q.length > 62 ? '…' : ''}`);
  }
  if (missing > 0) {
    return { ok: false, why: `${missing} quoted sentence(s) are not on the page — this file's header would be making a claim the page does not support` };
  }

  const exact = count(a, ANCHOR);
  console.log(`   anchor ${JSON.stringify(ANCHOR)}: ${exact}x  => the detector would ${exact > 0 ? 'PASS' : 'FAIL'}`);
  if (exact === 0) {
    return { ok: false, why: 'the anchor is absent. Do not substitute another string without measuring that one too.' };
  }

  // The stored numbers, as a floor rather than a census — a short number turns up
  // in dates and pixel sizes, so this is weak evidence on its own and is here to
  // catch the strong case: a row watching a page that carries none of them.
  for (const n of ['30', '90', '15']) {
    console.log(`   stored value ${n}: ${countWholeNumber(a, n)}x in the hashed text`);
  }
  return { ok: true };
}

// --- the asset --------------------------------------------------------------
// One tenant. Returns 'inserted' | 'exists'.
async function insertForTenant(client, tenantId) {
  const has = await client.query(
    'SELECT id FROM asset_types WHERE tenant_id = $1 AND quillio_normalize_name(name) = quillio_normalize_name($2)',
    [tenantId, ASSET]
  );
  if (has.rowCount > 0) return 'exists';

  // SORT ORDER IS ANCHORED ON THE TENANT'S OWN SIBLING ROW, not on a number from
  // the seed. A tenant seeded before the prune has different sort_order values
  // for the same assets, so "insert at 8" would land somewhere arbitrary in their
  // library. Finding their Google Display row and taking its position + 1 puts
  // the search ad beside its sibling in every tenant, whatever their numbering.
  //
  // The shift keeps sort_order contiguous, which is the property the seed's own
  // test asserts. `ORDER BY sort_order, id` would have made a duplicate
  // sort_order work too, and that was rejected: it buys one saved UPDATE at the
  // cost of an invariant a future reader would have to rediscover from the
  // ordering clause.
  const sib = await client.query(
    'SELECT sort_order FROM asset_types WHERE tenant_id = $1 AND name = $2',
    [tenantId, SIBLING]
  );
  let at;
  if (sib.rowCount > 0) {
    at = Number(sib.rows[0].sort_order) + 1;
    await client.query(
      'UPDATE asset_types SET sort_order = sort_order + 1 WHERE tenant_id = $1 AND sort_order >= $2',
      [tenantId, at]
    );
  } else {
    // No sibling — a tenant who renamed or retired it. Appending is the honest
    // answer: there is no "beside" to be beside.
    const max = await client.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM asset_types WHERE tenant_id = $1',
      [tenantId]
    );
    at = Number(max.rows[0].n);
    console.log(`${TAG}   tenant ${tenantId} has no "${SIBLING}" — appending at ${at} instead of inserting beside it`);
  }

  const ins = await client.query(
    `INSERT INTO asset_types (tenant_id, name, "group", is_active, sort_order, asset_direction, spec_note)
       VALUES ($1, $2, $3, true, $4, $5, $6) RETURNING id`,
    [tenantId, ASSET, GROUP, at, DIRECTION, ASSET_NOTE]
  );
  const assetTypeId = ins.rows[0].id;

  for (let i = 0; i < FIELDS.length; i++) {
    const [name, min, max, groupLabel, tier] = FIELDS[i];
    const enforced = tier === 'enforced';
    await client.query(
      `INSERT INTO copy_fields
              (asset_type_id, field_name, char_min, char_max, field_type, sort_order,
               spec_source, spec_version, group_label, spec_note, spec_type, spec_verified_at)
       VALUES ($1, $2, $3, $4, 'text', $5, $6, $7, $8, NULL, $9, $10)`,
      [
        assetTypeId, name, min, max, i + 1,
        enforced ? URL : HOUSE_SOURCE,
        SPEC_VERSION,
        groupLabel,
        tier,
        // ONLY THE CITED FIELDS CARRY A DATE. A house default has no page to have
        // been read against, so a verification date on one would assert an event
        // that cannot have happened — the same reasoning that refused to backfill
        // spec_verified_at from the seed date.
        enforced ? VERIFIED_ON : null,
      ]
    );
  }
  return 'inserted';
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (VERIFY) {
    const r = await readPage();
    console.log(`\n${TAG} ${r.ok ? 'VERIFY PASSED — nothing written.' : `VERIFY FAILED: ${r.why}`}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

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

  // THE PAGE IS READ BEFORE THE DATABASE IS OPENED. A refusal here costs one
  // fetch; a refusal after the writes costs a rollback and reads as a failure of
  // the migration rather than of the evidence for it.
  const page = await readPage();
  if (!page.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${page.why}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`\n${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'spec_watch_list' AND column_name = 'expected_content'`
    );
    if (cols.rowCount === 0) {
      throw new Error('spec_watch_list.expected_content does not exist — run scripts/migrateAddSpecAnchors.js --commit first');
    }

    const tenants = await client.query('SELECT DISTINCT tenant_id FROM asset_types ORDER BY tenant_id');
    console.log(`\n${TAG} ${tenants.rowCount} tenant(s) with an asset library:`);
    let inserted = 0;
    let existed = 0;
    for (const row of tenants.rows) {
      const what = await insertForTenant(client, row.tenant_id);
      if (what === 'inserted') inserted += 1; else existed += 1;
      console.log(`    ${row.tenant_id}  ${what === 'inserted' ? `${ASSET} + ${FIELDS.length} field(s)` : 'already has it — skipped'}`);
    }
    console.log(`${TAG} ${inserted} tenant(s) gained the asset, ${existed} already had it`);

    // Read the outcome back rather than trusting rowCounts.
    const check = await client.query(
      `SELECT cf.field_name, cf.char_min, cf.char_max, cf.spec_type, cf.spec_source,
              cf.spec_verified_at::date AS verified, COUNT(*)::int AS tenants
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = $1
        GROUP BY 1,2,3,4,5,6 ORDER BY MIN(cf.sort_order)`,
      [ASSET]
    );
    console.log(`\n${TAG} the asset as stored (${check.rowCount} distinct field row(s)):`);
    for (const r of check.rows) {
      console.log(`    ${String(r.field_name).padEnd(17)} ${String(r.char_min + '-' + r.char_max).padEnd(6)}` +
        ` ${String(r.spec_type).padEnd(14)} verified ${r.verified || '—'}  x${r.tenants} tenant(s)`);
    }

    // DERIVED, NOT PASTED — and the count is asserted, because an affected_fields
    // that is empty or unexpectedly wide is a gate that permits nothing or too
    // much, and creating either silently is worse than not creating the row.
    const pairs = (await client.query(
      `SELECT DISTINCT at.name AS asset, cf.field_name AS field
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE cf.spec_source = $1 AND at.is_active ORDER BY 1,2`,
      [URL]
    )).rows.map((r) => ({ asset: r.asset, field: r.field }));
    console.log(`\n${TAG} derived ${pairs.length} pair(s) from copy_fields.spec_source:`);
    for (const p of pairs) console.log(`    ${p.asset} || ${p.field}`);
    if (pairs.length !== EXPECTED_PAIRS) {
      throw new Error(
        `expected ${EXPECTED_PAIRS} (asset, field) pair(s) citing ${URL}, derived ${pairs.length}. ` +
        'The three graphic-copy fields are house_default on the quillio_default sentinel and are correctly ' +
        'outside the gate; anything else here means the library is not the shape this migration was written against.'
      );
    }

    const existingWatch = await client.query('SELECT id, display_name FROM spec_watch_list WHERE source_url = $1', [URL]);
    if (existingWatch.rowCount > 0) {
      console.log(`\n${TAG} a watch row for this URL already exists (#${existingWatch.rows[0].id}` +
        ` ${existingWatch.rows[0].display_name}) — leaving it alone.`);
    } else {
      const w = await client.query(
        `INSERT INTO spec_watch_list
                (source_url, display_name, affected_fields, is_test, expected_content, anchor_scope)
         VALUES ($1, $2, $3::jsonb, false, $4, $5) RETURNING id`,
        [URL, DISPLAY, JSON.stringify(pairs), ANCHOR, ANCHOR_SCOPE]
      );
      console.log(`\n${TAG} inserted watch row #${w.rows[0].id} — ${DISPLAY}`);
      console.log(`${TAG}   anchor ${JSON.stringify(ANCHOR)} (${ANCHOR_SCOPE}), no stop marker`);
      console.log(`${TAG}   current_hash is NULL, so the next detection run takes the BASELINE`);
      console.log(`${TAG}   branch: it writes the hash and cannot raise a flag.`);
    }

    const all = await client.query(
      `SELECT display_name, source_url, source_kind,
              COALESCE(jsonb_array_length(affected_fields), 0) AS pairs,
              expected_content IS NOT NULL AS anchored,
              current_hash IS NOT NULL AS baselined
         FROM spec_watch_list ORDER BY is_test, display_name NULLS LAST, id`
    );
    console.log(`\n${TAG} watch list is now ${all.rowCount} row(s):`);
    for (const r of all.rows) {
      console.log(`    ${String(r.display_name || '(no name)').padEnd(28)} ${String(r.pairs).padStart(2)} pair(s)  ` +
        `${r.anchored ? 'anchored  ' : 'UNANCHORED'}  ${r.baselined ? 'baselined' : 'not baselined'}`);
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Next: node scripts/runDetection.js — expect the new row to report 'baseline'.`);
      console.log(`${TAG} Then: node scripts/checkSpecHealth.js — a watch row was added.`);
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

// The maps below are required by a smoke test that replays the whole migration
// chain and asserts the seed matches its end state. Guarded so requiring this
// file runs nothing, the same way scripts/migrateFixMetaSpecs.js is.
const SOURCE_URLS = { [ASSET]: URL };
const ENFORCE = FIELDS.filter((f) => f[4] === 'enforced').map((f) => [ASSET, f[0]]);

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

module.exports = { SOURCE_URLS, ENFORCE, ASSET, GROUP, URL, ANCHOR, FIELDS, QUOTES, VERIFIED_ON };
