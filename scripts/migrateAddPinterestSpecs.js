'use strict';

// August 2026 — add Pinterest as a watched spec source and seed its two copy
// fields into already-seeded tenants.
//
// ─── THE FETCHED PAGE ───────────────────────────────────────────────────────
// https://help.pinterest.com/en/business/article/pinterest-product-specs — read
// through the detector's own fetchText + normalize from the Railway console,
// 2026-08-21. Verbatim, per CLAUDE.md's fetch rule, so every number below can be
// checked without leaving this file:
//
//   "Character counts Title Enter up to 100 characters. Depending on the device,
//    the first 40 characters may show in people’s feeds."
//
//   "For Chinese, Japanese, Korean, Arabic and other double byte languages, only
//    the first 30 characters will show in people's feeds."
//
//   "Description Enter up to 800 characters."
//
// THIS PAGE MIXES BOTH APOSTROPHE FORMS, and the quotes above reproduce that
// exactly:
//
//   the 100 / 40 sentence   U+2019  (curly)   "in people’s feeds"
//   the CJK sentence        U+0027  (straight) "in people's feeds"
//
// READ OFF THE PAGE, NOT ASSUMED ABOUT IT. This file first claimed every
// apostrophe here was U+2019, which was a statement about Pinterest's typography
// made without checking — and --verify caught it: the CJK sentence reported
// ABSENT 0x and the migration refused to write, which is the refusal working
// rather than a defect in it. scripts/probeSpecPage.js against this URL confirms
// both forms.
//
// A blanket assertion in EITHER direction is the mistake. The smoke test now
// pins each sentence to the form the page publishes for that sentence.
//
// And the header prose and the QUOTES array below must remain the SAME BYTES —
// a header-scoped test asserts it, because the prose is what a reader checks the
// claim against and the array is what the migration refuses on. Those were
// briefly different strings once already.
//
// ─── WHY 800 AND NOT THE 500 THAT IS EVERYWHERE ELSE ────────────────────────
// https://business.pinterest.com/creative-best-practices/ states 500. It is not
// cited by this migration, no field points at it, and it is deliberately NOT
// added as a watch row. The reason is a difference in KIND, not a preference
// between two sources:
//
//   the best-practices page   states 500 ONCE, unscoped, inside a marketing
//                             summary. It does not say which field, and it does
//                             not say whether the number is a cap or advice.
//   the help centre page      states 800 as a FIELD-ENTRY cap — "Enter up to
//                             800 characters" — and repeats it identically
//                             across all seven format sections.
//
// A number stated once without a field attached is not a spec for a field. A
// number stated as an entry instruction, seven times, in the same words, is.
//
// THIRD-PARTY SOURCES REPORTING 500 ARE CONSISTENT WITH COPYING THE
// BEST-PRACTICES PAGE, and their agreement is therefore not independent
// evidence. That is the shape this project has already been wrong about: the
// July Meta correction reasoned from consistency between sources rather than
// from reading the page, and produced every wrong Meta number in the library.
// Counting how many places repeat a figure measures circulation, not publication.
//
// ─── WHY enforced ───────────────────────────────────────────────────────────
// Pinterest's own wording is "Enter up to", which describes what the field will
// accept — the same construction as Google's "support up to", and tiered the
// same way for the same stated reason (see scripts/migrateAddGoogleSearchAsset.js,
// "WHY enforced, AND WHY THE LinkedIn CAUTION DOES NOT APPLY"). It is entry
// language, not the "Text Recommendations" heading that left LinkedIn's nine an
// open question.
//
// ─── THE 40 IS NOT A LIMIT AND THE 30 IS NOT SEEDABLE ───────────────────────
// "the first 40 characters may show in people’s feeds" is a DISPLAY TRUNCATION,
// not a cap. Putting it in char_max would tell a writer they may not exceed a
// number Pinterest accepts happily, and would silently shorten every title. It
// goes in spec_note, which is the writing-guidance channel — the same split the
// Litmus email numbers use.
//
// THE 30-CHARACTER CJK FIGURE IS DELIBERATELY NOT SEEDED. It is conditional on
// the language the pin is written in, and copy_fields has nowhere to put a
// conditional limit: char_max is one number per field per tenant. Recording it
// as an unconditional 30 would be false for every English pin, and dropping it
// into spec_note beside the 40 would state two truncation points without saying
// which applies. It is quoted in this header so it is findable if the field
// model ever grows a condition, and stored nowhere.
//
// ─── THE ANCHOR ─────────────────────────────────────────────────────────────
// See the comment on the watch-row INSERT below.
//
// ─── WHAT MAKES THIS REFUSE ─────────────────────────────────────────────────
// It fetches the page BEFORE it writes anything and stops on any of:
//   • a quoted sentence missing from the page (the header would be lying)
//   • the anchor absent (an anchor that cannot fail is worse than none)
//   • the page varying between two fetches (it would need a stop marker)
//   • the derivation returning anything but the pairs it just seeded
// A run with no network is a refusal, not a fallback.
//
//   node scripts/migrateAddPinterestSpecs.js --verify   # fetch + measure, no DB
//   node scripts/migrateAddPinterestSpecs.js            # dry run (ROLLBACK)
//   node scripts/migrateAddPinterestSpecs.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[pinterest-specs]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const URL = 'https://help.pinterest.com/en/business/article/pinterest-product-specs';
const ASSET = 'Pinterest Pin';
// PAID SOCIAL, NOT ORGANIC — the page scopes these fields to AD formats, in its
// own words: "Descriptions do not appear when viewing the ad in the home feed."
// A page that describes what happens when you view THE AD is not documenting an
// organic pin. It also puts Pinterest beside Meta and LinkedIn, which is where a
// copywriter working from a creative brief looks for it.
const GROUP = 'Paid Social';
const DISPLAY = 'Pinterest – product specs';
const ANCHOR = 'size (9:16 ratio) Aspect ratio Aspect ratio is 9:16, but there are no';
const ANCHOR_SCOPE = 'normalized';

// NO SIBLING TO SIT BESIDE. Google Responsive Search anchored its sort_order on
// the tenant's own Google Display row; Pinterest is the first asset from this
// platform, so there is no "beside" to be beside and it appends. That is the
// same code path the Google migration falls back to, made explicit here rather
// than reached by accident.
const SIBLING = null;

// The date a human read the page. Hardcoded rather than NOW(), for the reason
// scripts/migrateBackfillSpecVerifiedAt.js states: NOW() stamps whenever
// somebody happened to execute the file, which is a different event from the one
// being recorded.
const VERIFIED_ON = '2026-08-21';

// Asserted against the fetched page before anything is written. A quote nobody
// re-checked is the same unverified claim as an uncited number, and the header
// above is where a future reader goes instead of the page.
//
// THE APOSTROPHE FORM IS PER SENTENCE, because this page uses both — U+2019 in
// the 100/40 sentence, U+0027 in the CJK one. Getting either wrong reports
// ABSENT and looks exactly like a false claim rather than a typographic
// mismatch; that cost a round on the Google page, and scripts/probeSpecPage.js
// reports the two cases differently because of it.
const QUOTES = [
  'Character counts Title Enter up to 100 characters. Depending on the device, the first 40 characters may show in people’s feeds.',
  // DOUBLE-QUOTED because the page renders a STRAIGHT apostrophe here and a
  // single-quoted literal would terminate on it. The quoting style is forced
  // by the page, not chosen.
  "For Chinese, Japanese, Korean, Arabic and other double byte languages, only the first 30 characters will show in people's feeds.",
  'Description Enter up to 800 characters.',
];

// [field_name, char_min, char_max, group_label|null, spec_type, spec_note|null]
//
// char_min is 0 on both: Pinterest publishes no floor, and a floor this project
// invented would collapse the spread of the copy without being anybody's rule —
// measured on the Subhead in scripts/floorAB.js, where stating a band cut the
// range by two thirds and cost the best line in the run.
const FIELDS = [
  ['Title', 0, 100, null, 'enforced',
    // THE 40 LIVES HERE, NOT IN char_max. A display truncation is writing
    // guidance; a cap is a rule. Keeping them in separate channels is the same
    // split that keeps a research finding in spec_note and its attribution in
    // spec_type.
    'Only the first 40 characters typically show in feeds.'],
  ['Description', 0, 800, null, 'enforced', null],
];

const DIRECTION = 'Written for someone saving it for later. Useful over clever; the title does the finding.';

// The sentinel every house_default field carries. Never a URL. Unused by this
// asset — both its fields are cited — and named so the INSERT below reads the
// same as the Google migration's rather than special-casing.
const HOUSE_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

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
  if (!stable) {
    return { ok: false, why: 'the page varies between fetches; it needs a content_stop_marker before it can be watched' };
  }

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
  for (const n of ['100', '800']) {
    console.log(`   stored value ${n}: ${count(a, n)}x in the hashed text`);
  }
  // AND THE ONE WE REFUSED. 500 should be absent from the help centre page; if it
  // turns up here, the two Pinterest pages disagree less than this header claims
  // and the 800 needs re-reading before it ships.
  const five = count(a, '500');
  console.log(`   REJECTED value 500: ${five}x` +
    (five > 0 ? '   <- UNEXPECTED. Re-read the page before writing 800.' : '   (as expected — 500 is the best-practices page)'));

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

  // SORT ORDER IS ANCHORED ON THE TENANT'S OWN SIBLING ROW where one exists, not
  // on a number from the seed: a tenant seeded before the prune has different
  // sort_order values for the same assets, so a literal position would land
  // somewhere arbitrary in their library. SIBLING is null here — Pinterest is the
  // first asset from this platform — so this always takes the append branch.
  let at;
  const sib = SIBLING
    ? await client.query('SELECT sort_order FROM asset_types WHERE tenant_id = $1 AND name = $2', [tenantId, SIBLING])
    : { rowCount: 0 };
  if (sib.rowCount > 0) {
    at = Number(sib.rows[0].sort_order) + 1;
    await client.query(
      'UPDATE asset_types SET sort_order = sort_order + 1 WHERE tenant_id = $1 AND sort_order >= $2',
      [tenantId, at]
    );
  } else {
    const max = await client.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM asset_types WHERE tenant_id = $1',
      [tenantId]
    );
    at = Number(max.rows[0].n);
  }

  const ins = await client.query(
    `INSERT INTO asset_types (tenant_id, name, "group", is_active, sort_order, asset_direction, spec_note)
       VALUES ($1, $2, $3, true, $4, $5, NULL) RETURNING id`,
    [tenantId, ASSET, GROUP, at, DIRECTION]
  );
  const assetTypeId = ins.rows[0].id;

  for (let i = 0; i < FIELDS.length; i++) {
    const [name, min, max, groupLabel, tier, note] = FIELDS[i];
    const enforced = tier === 'enforced';
    await client.query(
      `INSERT INTO copy_fields
              (asset_type_id, field_name, char_min, char_max, field_type, sort_order,
               spec_source, spec_version, group_label, spec_note, spec_type, spec_verified_at)
       VALUES ($1, $2, $3, $4, 'text', $5, $6, $7, $8, $9, $10, $11)`,
      [
        assetTypeId, name, min, max, i + 1,
        enforced ? URL : HOUSE_SOURCE,
        SPEC_VERSION,
        groupLabel,
        note,
        tier,
        // ONLY THE CITED FIELDS CARRY A DATE. A house default has no page to have
        // been read against, so a verification date on one would assert an event
        // that cannot have happened.
        enforced ? VERIFIED_ON : null,
      ]
    );
  }
  console.log(`${TAG}   ${tenantId}  ${ASSET} at sort_order ${at}, ${FIELDS.length} field(s):`);
  for (const [name, min, max, , tier, note] of FIELDS) {
    console.log(`${TAG}       ${String(name).padEnd(13)} ${String(min + '-' + max).padEnd(7)} ${String(tier).padEnd(9)}` +
      ` verified ${tier === 'enforced' ? VERIFIED_ON : '—'}` +
      `${note ? `  note: ${JSON.stringify(note)}` : ''}`);
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
    // COLLECTED IN THE SAME LOOP THAT SEEDS THEM. See the derivation note below.
    const seededPairs = [];
    for (const row of tenants.rows) {
      const what = await insertForTenant(client, row.tenant_id);
      if (what === 'inserted') {
        inserted += 1;
        for (const [name, , , , tier] of FIELDS) {
          if (tier === 'enforced') seededPairs.push({ asset: ASSET, field: name });
        }
      } else {
        existed += 1;
        console.log(`${TAG}   ${row.tenant_id}  already has ${ASSET} — skipped`);
      }
    }
    console.log(`${TAG} ${inserted} tenant(s) gained the asset, ${existed} already had it`);

    // Read the outcome back rather than trusting rowCounts.
    const check = await client.query(
      `SELECT cf.field_name, cf.char_min, cf.char_max, cf.spec_type, cf.spec_source, cf.spec_note,
              cf.spec_verified_at::date AS verified, COUNT(*)::int AS tenants
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = $1
        GROUP BY 1,2,3,4,5,6,7 ORDER BY MIN(cf.sort_order)`,
      [ASSET]
    );
    console.log(`\n${TAG} the asset as stored (${check.rowCount} distinct field row(s)):`);
    for (const r of check.rows) {
      console.log(`    ${String(r.field_name).padEnd(13)} ${String(r.char_min + '-' + r.char_max).padEnd(7)}` +
        ` ${String(r.spec_type).padEnd(9)} verified ${r.verified || '—'}  x${r.tenants} tenant(s)`);
      console.log(`        ${r.spec_source}`);
      if (r.spec_note) console.log(`        note: ${JSON.stringify(r.spec_note)}`);
    }

    // AFFECTED_FIELDS COMES OFF THE SAME LOOP THAT SEEDED THE ROWS, deduped by
    // name — not from a hand-written list and not from a second query.
    //
    // A pasted snapshot is the failure this project already has on the board:
    // spec_watch_list.affected_fields was computed once by migrateAddSpecTables
    // and is recomputed by nothing, so a field added to a watched asset
    // afterwards sits outside the write gate with nothing naming it. Deriving it
    // HERE cannot drift from what this migration wrote, because it is the same
    // array — and a re-derivation query would reintroduce the gap between "what
    // I seeded" and "what a SELECT happens to return" that the snapshot has.
    const pairs = [...new Map(seededPairs.map((p) => [`${p.asset}||${p.field}`, p])).values()]
      .sort((x, y) => x.field.localeCompare(y.field));
    console.log(`\n${TAG} affected_fields, derived from what this run seeded — ${pairs.length} pair(s):`);
    for (const p of pairs) console.log(`    ${p.asset} || ${p.field}`);

    const expected = FIELDS.filter((f) => f[4] === 'enforced').length;
    if (inserted > 0 && pairs.length !== expected) {
      throw new Error(
        `expected ${expected} (asset, field) pair(s), derived ${pairs.length}. An empty or wrong ` +
        'affected_fields is a gate that permits nothing or too much, and creating either silently ' +
        'is worse than not creating the row.'
      );
    }

    const existingWatch = await client.query('SELECT id, display_name FROM spec_watch_list WHERE source_url = $1', [URL]);
    if (existingWatch.rowCount > 0) {
      console.log(`\n${TAG} a watch row for this URL already exists (#${existingWatch.rows[0].id}` +
        ` ${existingWatch.rows[0].display_name}) — leaving it alone.`);
    } else if (pairs.length === 0) {
      throw new Error(
        'no pairs to gate — every tenant already had the asset, so this run seeded nothing and a watch ' +
        'row created now would carry an empty affected_fields. Nothing written.'
      );
    } else {
      // THE ANCHOR, and why this string.
      //
      // It is deliberately OUTSIDE the "Character counts Title Enter up to 100
      // characters" block, which repeats SEVEN TIMES on this page — once per
      // format section. An anchor that occurs seven times is not wrong, but it
      // tells you nothing about WHICH section rendered, and a page that lost six
      // of the seven would still pass it.
      //
      // AND ITS DIGITS ARE ASPECT RATIOS, NOT THE LIMITS THIS ROW WATCHES. That
      // is the property that matters. A missed anchor reports `failed` — the page
      // could not be READ — while a moved number reports `changed`. An anchor
      // containing 100 or 800 would convert the exact event this row exists to
      // catch into a broken-page report, which is the one failure mode that
      // teaches a reviewer to dismiss the queue. 9:16 can move without either
      // stored limit moving, and either stored limit can move without it.
      //
      // content_stop_marker and source_kind are NOT NAMED in this INSERT, and
      // both land on exactly the values this row wants: content_stop_marker is
      // nullable with no default (NULL — the page hashed MATCH across two fetches
      // three seconds apart, so there is nothing to truncate), and source_kind
      // defaults to 'platform_enforced'. Omitting them also means this migration
      // does not require migrateAddContentStopMarker or migrateAddSourceKind to
      // have run, which is the same choice migrateAddLinkedInCarouselWatch made.
      const w = await client.query(
        `INSERT INTO spec_watch_list
                (source_url, display_name, affected_fields, is_test, expected_content, anchor_scope)
         VALUES ($1, $2, $3::jsonb, false, $4, $5) RETURNING id`,
        [URL, DISPLAY, JSON.stringify(pairs), ANCHOR, ANCHOR_SCOPE]
      );
      console.log(`\n${TAG} inserted watch row #${w.rows[0].id} — ${DISPLAY}`);
      console.log(`${TAG}   anchor ${JSON.stringify(ANCHOR)} (${ANCHOR_SCOPE})`);
      console.log(`${TAG}   no stop marker (page hashed MATCH across two fetches)`);
      console.log(`${TAG}   source_kind defaults to 'platform_enforced'`);
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

// The maps below are required by a smoke test. Guarded so requiring this file
// runs nothing, the same way scripts/migrateFixMetaSpecs.js is.
const SOURCE_URLS = { [ASSET]: URL };
const ENFORCE = FIELDS.filter((f) => f[4] === 'enforced').map((f) => [ASSET, f[0]]);

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

module.exports = { SOURCE_URLS, ENFORCE, ASSET, GROUP, URL, ANCHOR, FIELDS, QUOTES, VERIFIED_ON };
