'use strict';

// August 2026 — seed 'LinkedIn Conversation Ad' into already-seeded tenants, add
// its watch row, and derive that row's affected_fields in the same run.
//
//   node scripts/migrateAddLinkedInConversationAd.js            (dry run)
//   node scripts/migrateAddLinkedInConversationAd.js --commit   (writes)
//   node scripts/migrateAddLinkedInConversationAd.js --verify   (page only, no DB)
//
// Run in the Railway console as plain node — never `railway run`.
//
// ─── THE FETCHED PAGE ───────────────────────────────────────────────────────
// Read 2026-08-29 from the Railway console through the detector's own fetchText
// + hashableText. Verbatim, per CLAUDE.md's fetch rule, so the claims below can
// be checked without leaving the file:
//
//   "Ad Name (optional): 255 characters maximum"
//   "Message Text: 8,000 characters maximum"
//   "Custom Footer: 20,000 characters maximum"
//   "Call-to-Action: 25 characters maximum"
//   "URL characters: 2,000 characters maximum for destination field URL"
//
//   raw 168,426 chars · normalized 21,276 chars
//   STABLE across two fetches — identical hash
//   7c99989e0630da5741f26e2716cf3fac84646b969d3e5c85dcfaf770830d90a8
//
// ─── NO CONTENT STOP MARKER ─────────────────────────────────────────────────
// The full normalized text is stable — no per-request token, no shuffled list —
// so the hashed region is the whole normalized text and content_stop_marker
// stays NULL. Meta's per-format pages need a marker because their call-to-action
// list permutes on every request; nothing on this page does.
//
// ─── THE ONE INFERENCE, STATED PLAINLY BECAUSE IT IS NOT A QUOTATION ────────
// THIS IS THE MOST IMPORTANT PARAGRAPH IN THIS FILE.
//
// LinkedIn's page names "Message Text" ONCE and "Call-to-Action" ONCE, both in
// the singular. It has NO vocabulary for a follow-up message and states NO
// cardinality for buttons. Of the eleven fields seeded below, exactly THREE rest
// on a sentence the page contains:
//
//     Ad Name       255    "Ad Name (optional): 255 characters maximum"
//     Message Text  8000   "Message Text: 8,000 characters maximum"
//     (and the 25 itself)  "Call-to-Action: 25 characters maximum"
//
// The other EIGHT — that each Option Response also gets 8,000, and that each
// Option and each CTA also gets 25 — are QUILLIO READING LinkedIn's singular
// statements as applying to every instance of a repeating field. That is a
// reasonable read of the page. IT IS NOT A SENTENCE THE PAGE CONTAINS, and
// nobody should later cite this file as though it were.
//
// WHERE IT WOULD BE SETTLED: the specs page defers to a Help Center article for
// full technical specifications —
//     https://www.linkedin.com/help/lms/answer/a426057
// That is where a branching vocabulary (how many options, whether a response
// carries the message limit) would be published if it is published anywhere.
// NOBODY HAS READ IT. Reading it is the next thing to do if any of these eight
// numbers is ever doubted, and it is cheaper than an experiment in Campaign
// Manager.
//
// ─── WHY enforced, AND WHY THE LinkedIn OPEN QUESTION DOES NOT APPLY ────────
// CLAUDE.md carries an open question about LinkedIn's other nine enforced fields,
// opened because both sponsored-CONTENT pages put their numbers under a heading
// reading "Text Recommendations" — recommendation language over a tier claiming a
// cap. This page does not do that. It states "characters maximum" in its own
// prose, five times, which is ceiling language — the same construction as
// Google's "support up to" and X's "up to a maximum of".
//
// So the tier is not what is uncertain here. THE CARDINALITY IS. Those are
// different doubts and they must not be merged: a future reader deciding whether
// to retier these should look at the "maximum" language, and a future reader
// deciding whether Option 4 exists should read the Help Center article.
//
// ─── TWO SOURCED FIELDS DELIBERATELY NOT SEEDED ─────────────────────────────
// Custom Footer (20,000) and the destination URL (2,000) are both on the page and
// both quoted above. Neither is seeded. This writer does not use them, and an
// unused field is a blank slot that reads as an undrafted document — the same
// reason Google Responsive Search seeds three headlines and not fifteen.
//
// THE OMISSION IS A CHOICE, NOT AN OVERSIGHT. Re-adding either is a decision with
// its own approval, not a fix. Both numbers are recorded here so that decision
// starts from the fetched text rather than from a fresh read.
//
// ─── THE WATCH ROW ──────────────────────────────────────────────────────────
// An asset seeded AFTER scripts/migrateAddSpecTables.js ran does NOT get a watch
// row automatically — that migration derived its rows once, from the DISTINCT
// enforced spec_source at the time. So this file creates the row by hand, and
// derives affected_fields in the same transaction. A watch row with an empty
// affected_fields is a gate that permits nothing; a watch row with no
// affected_fields at all is a page that flags to nobody.
//
// ─── THE ANCHOR, AND WHY IT HOLDS NO NUMBER ─────────────────────────────────
//   "Message Text:"   measured 2x in the normalized text, colon attached
//                     ("Message Text :" counts 0, so normalize keeps it adjacent)
//
// TWO OCCURRENCES IS NOT A DEFECT. specDetector.checkAnchor is
// `hay.includes(anchor)` — it never counts. Seeded rows already run at 2x
// (LinkedIn single-image "Introductory text"), 5x (Google display) and 9x (X
// "post copy:"). The uniqueness requirement lives in chooseAnchor, which is a
// candidate-ranking aid, not the runtime.
//
// NO DIGIT IN THE ANCHOR, and this is the load-bearing half. bumpFailure does not
// touch current_hash and does not insert into spec_review_queue. So an anchor
// holding a spec limit converts a REAL LIMIT CHANGE into status `failed` rather
// than `changed`: the baseline freezes, nothing reaches the review queue, and the
// only trace is a failure streak nobody is watching. A limit move must arrive as
// a flag. This satisfies POLICY.DIGIT_FREE in scripts/lib/anchorChoice.js.
//
// The page is AEM and renders each text block twice — once escaped inside a JSON
// blob, once as rendered cmp-text — which is why a digit-free label measures 2x
// and why every fragment that IS unique carries markup and a number. That is the
// trade this anchor refuses.

const TAG = '[linkedin-conversation-ad]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const URL = 'https://business.linkedin.com/advertise/ads/sponsored-messaging/conversation-ads/specs';
const ASSET = 'LinkedIn Conversation Ad';
const GROUP = 'Paid Social';
const DISPLAY = 'LinkedIn – conversation ads';
const ANCHOR = 'Message Text:';
const ANCHOR_SCOPE = 'normalized';

// Where the asset lands in a tenant's library: beside the other LinkedIn paid
// formats rather than at a number from the seed. See insertForTenant.
const SIBLING = 'LinkedIn Carousel Ad';

// The date a human read the page, which is what spec_verified_at means.
const VERIFIED_ON = '2026-08-29';

// Asserted against the live page on every run. If one of these is absent, this
// file's header is making a claim the page does not support and the run refuses.
const QUOTES = [
  'Ad Name (optional): 255 characters maximum',
  'Message Text: 8,000 characters maximum',
  'Custom Footer: 20,000 characters maximum',
  'Call-to-Action: 25 characters maximum',
  'URL characters: 2,000 characters maximum for destination field URL',
];

// [name, char_min, char_max, group_label, spec_type]
// BYTE-IDENTICAL in name and band to the RAW entry in src/data/defaultAssets.js;
// a smoke test asserts the two agree in both directions.
const FIELDS = [
  ['Ad Name', 0, 255, null, 'enforced'],
  ['Message Text', 0, 8000, null, 'enforced'],
  ['Option 1', 0, 25, null, 'enforced'],
  ['Option 2', 0, 25, null, 'enforced'],
  ['Option 3', 0, 25, null, 'enforced'],
  ['Option 1 Response', 0, 8000, null, 'enforced'],
  ['Option 2 Response', 0, 8000, null, 'enforced'],
  ['Option 3 Response', 0, 8000, null, 'enforced'],
  ['CTA 1', 0, 25, null, 'enforced'],
  ['CTA 2', 0, 25, null, 'enforced'],
  ['Final CTA', 0, 25, null, 'enforced'],
];

// THE STORED LIMITS AND HOW THIS PAGE WRITES THEM — one pair per distinct value
// seeded above. They are DIFFERENT STRINGS and each needs the counter that suits
// it; the block in readPage that consumes this explains why in full.
//
// The stored half is checked against FIELDS in checkSeedAgreement rather than
// trusted, so a band change cannot leave this table describing a value nothing
// seeds. The published half is a PAGE FACT and cannot be derived from anything
// in this repo — it was read from the hashed text and is asserted against the
// live page on every run.
const STORED_VS_PUBLISHED = [
  ['255', '255'],
  ['8000', '8,000'],
  ['25', '25'],
];

// BYTE-IDENTICAL to DIRECTIONS['LinkedIn Conversation Ad'] in
// src/data/defaultAssets.js, checked below rather than assumed.
// Non-ASCII, deliberate: U+2014 EM DASH, and U+2019 in "reader’s".
const DIRECTION =
  'Written for the inbox, not the feed. It should read like a message from one person to another '
  + '— short, one idea, ending in a question the buttons answer. Options are the reader’s '
  + 'voice; CTAs are yours. Riff for more options rather than seeding empty slots.';

// The one field note. BYTE-IDENTICAL to LINKEDIN_CONVERSATION_AD_NAME_NOTE in
// src/data/defaultAssets.js.
//
// LOAD-BEARING. Ad Name is Campaign Manager organisation and is never delivered
// to a reader; in this writer's own working document the ad's opening hook was
// sitting in it. "Ad Name [255]" reads like a headline slot with a generous
// limit, and nothing else in the document says otherwise.
const AD_NAME_NOTE =
  'Internal label for Campaign Manager only — the reader never sees this field.';
const NOTES = { 'Ad Name': AD_NAME_NOTE };

const HOUSE_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

// Every field on this asset is enforced and cited, so the gate should hold all
// eleven. Asserted rather than assumed — an affected_fields that is empty or
// unexpectedly wide is a gate that permits nothing or too much.
const EXPECTED_PAIRS = FIELDS.filter((f) => f[4] === 'enforced').length; // 11

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  if (!needle) return 0;
  return String(hay).split(needle).length - 1;
}

// Value checks match WHOLE NUMBERS; count() stays a substring test for quotes and
// the anchor. See scripts/lib/wholeNumber.js — a substring count of "25" on a
// specs page also counts the 25 inside "255" and "1250".
const { countWholeNumber } = require('./lib/wholeNumber');

// ─── THE REFUSAL ────────────────────────────────────────────────────────────
// Runs before DATABASE_URL is touched. Checks the property this file's
// correctness rests on: the seed and this script hold the same strings, so a
// newly seeded tenant and a migrated tenant render the same asset.
function checkSeedAgreement() {
  const problems = [];
  let seed;
  try {
    ({ DEFAULT_ASSETS: seed } = require('../src/data/defaultAssets'));
  } catch (err) {
    return [`could not load the seed to compare against: ${err.message}`];
  }
  const asset = seed.find((a) => a.name === ASSET);
  if (!asset) {
    return [`${ASSET}: no such asset in DEFAULT_ASSETS. Renamed, or the name here is wrong.`];
  }
  if (asset.group !== GROUP) {
    problems.push(`${ASSET}: group here is ${JSON.stringify(GROUP)}, seed has ${JSON.stringify(asset.group)}.`);
  }
  const dir = String(asset.asset_direction || '');
  if (dir !== DIRECTION) {
    problems.push(
      `${ASSET}: this file and the seed hold DIFFERENT directions, so a newly seeded tenant and a `
      + 'migrated tenant would render different lines for the same asset.\n'
      + `        seed (${dir.length}): ${JSON.stringify(dir)}\n`
      + `        here (${DIRECTION.length}): ${JSON.stringify(DIRECTION)}`
    );
  }
  if (asset.fields.length !== FIELDS.length) {
    problems.push(`${ASSET}: seed has ${asset.fields.length} field(s), this file has ${FIELDS.length}.`);
  }
  for (const [name, min, max, , tier] of FIELDS) {
    const f = asset.fields.find((x) => x.field_name === name);
    if (!f) { problems.push(`${ASSET} / ${name}: not in the seed.`); continue; }
    if (f.char_min !== min || f.char_max !== max) {
      problems.push(`${ASSET} / ${name}: seed band ${f.char_min}-${f.char_max}, here ${min}-${max}.`);
    }
    if (f.spec_type !== tier) {
      problems.push(`${ASSET} / ${name}: seed tier ${f.spec_type}, here ${tier}.`);
    }
    const wantNote = NOTES[name] || null;
    if ((f.spec_note || null) !== wantNote) {
      problems.push(`${ASSET} / ${name}: seed note ${JSON.stringify(f.spec_note)}, here ${JSON.stringify(wantNote)}.`);
    }
  }

  // STORED_VS_PUBLISHED must name exactly the distinct non-zero limits FIELDS
  // seeds — no more, no fewer. Derived here rather than retyped, so changing a
  // band forces the pair table to be revisited instead of silently describing a
  // value the asset no longer carries, or missing one it now does.
  const seeded = [...new Set(FIELDS.flatMap((f) => [f[1], f[2]]).filter((n) => n > 0).map(String))].sort();
  const paired = [...new Set(STORED_VS_PUBLISHED.map(([stored]) => stored))].sort();
  if (seeded.join(',') !== paired.join(',')) {
    problems.push(
      'STORED_VS_PUBLISHED does not cover the seeded limits.\n'
      + `        seeded: ${seeded.join(', ')}\n`
      + `        paired: ${paired.join(', ')}`
    );
  }
  for (const [stored, published] of STORED_VS_PUBLISHED) {
    if (!/^\d+$/.test(stored)) {
      problems.push(`STORED_VS_PUBLISHED: the stored half ${JSON.stringify(stored)} is not digits-only, `
        + 'so countWholeNumber would throw on it. The stored half is an integer; the published half is '
        + 'where a separator belongs.');
    }
  }
  return problems;
}

// --- the page ---------------------------------------------------------------
// Returns { ok, why } and prints what it measured. Called by --verify AND by
// every write path, so a value is never written without the page being read in
// the same run.
async function readPage() {
  const { fetchText, hashableText } = require('../src/services/specDetector');
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
    return {
      ok: false,
      why: `${missing} quoted sentence(s) are not on the page — this file's header would be making a claim the page does not support`,
    };
  }

  const exact = count(a, ANCHOR);
  console.log(`   anchor ${JSON.stringify(ANCHOR)}: ${exact}x  => the detector would ${exact > 0 ? 'PASS' : 'FAIL'}`);
  if (exact === 0) {
    return { ok: false, why: 'the anchor is absent. Do not substitute another string without measuring that one too.' };
  }
  // THE COLON IS CHECKED, NOT ASSUMED. normalize() turns every tag into a space,
  // so a page marked up as `<b>Message Text</b>:` normalizes to "Message Text :"
  // and the stored anchor would fail on a page that plainly renders the label.
  // Measured 2026-08-29: the colon is inside the bold, so the exact match holds.
  // If LinkedIn ever moves it outside, drop the colon and seed "Message Text" —
  // two words naming a spec field are still content, not chrome.
  const spaced = count(a, 'Message Text :');
  console.log(`   spaced variant "Message Text :": ${spaced}x  (expect 0 — a non-zero here means the colon moved outside the bold)`);

  // ─── A STORED INTEGER AND A PUBLISHED NUMBER ARE DIFFERENT STRINGS ──────
  // MEASURED IN THE RAILWAY CONSOLE 2026-08-29, and the measurement is why this
  // block asks twice rather than once.
  //
  // This page writes its four-digit limits with a thousands separator —
  // "Message Text: 8,000 characters maximum" — and normalize() keeps the comma.
  // countWholeNumber tokenises the text with /\d+/g, so "8,000" yields the runs
  // "8" and "000": there is no 8000 run, and A BARE 8000 OCCURS NOWHERE IN THE
  // HASHED TEXT. The separators also manufacture runs LinkedIn never published —
  // "8", "20", "2" and "000" are all tokens now.
  //
  // So neither counter alone can answer the question:
  //     countWholeNumber(text, '8000')  -> 0, SILENTLY.  the stored form
  //     count(text, '8,000')            -> 1.            the published form
  // The first version of this loop passed '8,000' into countWholeNumber, whose
  // header says outright that it takes a digits-only value, and it threw. That
  // was the helper working: it refuses rather than answering 0, because "a value
  // check that quietly counts nothing is the failure this whole module is
  // about". The throw is the only reason any of this surfaced.
  //
  // 8000 IS THE FIRST STORED LIMIT IN THE LIBRARY ABOVE 800. Every other value
  // in the seed is three digits or fewer and no publisher writes those with a
  // separator, which is why nine other callers of wholeNumber.js have never met
  // one. Nothing is wrong with the helper. The caller was handing it the wrong
  // half of a pair it did not know was a pair.
  //
  // NO try/catch AND NO PRE-FILTER, deliberately. Either would let this block
  // report success while checking nothing, and would skip precisely the
  // four-digit values most likely to be written differently from how they are
  // stored. The throw is not suppressed here — it is UNREACHABLE, because every
  // value reaching countWholeNumber is now a stored integer, digits-only by
  // construction and asserted so in checkSeedAgreement.
  //
  // WHAT I LEFT, AND IT IS A REAL RESIDUAL: an advisory print still sits where a
  // throw would abort a run it has no authority over. Removing that means
  // restructuring readPage so diagnostics cannot be fatal, which is a change to
  // the shape this file shares with four sibling migrations — not this fix's to
  // make. If a future value reintroduces a throw here, it will again take down a
  // run whose real gates have already passed.
  //
  // STILL ADVISORY, AND STILL A FLOOR RATHER THAN A CENSUS. A short number turns
  // up in dates and pixel sizes, so a hit proves little on its own. It prints and
  // gates nothing; the five quoted sentences and the anchor above are the gates,
  // and both are strictly stronger than this. It is here to catch one thing: a
  // row watching a page that carries no form of any number it is cited for.
  //
  // READ THE TWO COLUMNS DIFFERENTLY — the substring one OVER-COUNTS BY DESIGN.
  // `count` is a plain substring, so 25 scores a hit inside "255" and this asset
  // carries both: on the quoted sentences alone the published column reads 25 -> 2x
  // where the digit-run column reads 1x. That gap is the exact defect
  // wholeNumber.js was written to remove, kept here on purpose because the two
  // counters sit side by side and the exact one is the check — the substring
  // column exists ONLY to catch a number the digit-run column cannot see because
  // a separator split it. Where they disagree, believe the digit run; where the
  // digit run is 0 and the substring is not, read the verdict.
  for (const [stored, published] of STORED_VS_PUBLISHED) {
    const asStored = countWholeNumber(a, stored);        // digit-run, exact
    const asPublished = count(a, published);             // substring, as printed
    const verdict = asStored > 0 && asPublished > 0 ? 'both forms'
      : asStored > 0 ? 'stored form only'
        : asPublished > 0 ? `PUBLISHED FORM ONLY — this page writes it ${JSON.stringify(published)}`
          : 'NEITHER FORM — this page carries no version of this number';
    console.log(
      `   stored ${String(stored).padStart(5)}  digit-run ${String(asStored).padStart(2)}x` +
      `   published ${JSON.stringify(published).padEnd(8)} substring ${String(asPublished).padStart(2)}x` +
      `   -> ${verdict}`
    );
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
  // for the same assets, so "insert at 3" would land somewhere arbitrary in their
  // library. Finding their LinkedIn Carousel row and taking its position + 1 puts
  // the conversation ad beside its siblings in every tenant, whatever their
  // numbering. The shift keeps sort_order contiguous, which is the property the
  // seed's own test asserts.
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
       VALUES ($1, $2, $3, true, $4, $5, NULL) RETURNING id`,
    [tenantId, ASSET, GROUP, at, DIRECTION]
  );
  const assetTypeId = ins.rows[0].id;

  for (let i = 0; i < FIELDS.length; i++) {
    const [name, min, max, groupLabel, tier] = FIELDS[i];
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
        NOTES[name] || null,
        tier,
        // ONLY THE CITED FIELDS CARRY A DATE. A house default has no page to have
        // been read against, so a verification date on one would assert an event
        // that cannot have happened.
        enforced ? VERIFIED_ON : null,
      ]
    );
  }
  return 'inserted';
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  // THE SEED COMPARISON RUNS FIRST AND NEEDS NEITHER NETWORK NOR DATABASE.
  const disagreements = checkSeedAgreement();
  if (disagreements.length > 0) {
    console.error(`\n${TAG} REFUSING — this file and src/data/defaultAssets.js disagree:\n`);
    for (const p of disagreements) console.error(`   • ${p}`);
    console.error('\n   Fix whichever is wrong. A migrated tenant and a newly seeded tenant must');
    console.error('   hold the same asset, and nothing else in the system checks that they do.');
    process.exit(1);
  }
  console.log(`${TAG} seed agreement: OK — ${FIELDS.length} field(s), direction and note all match the seed.`);

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

    // ─── THE OLD STATE, PRINTED BEFORE ANYTHING IS WRITTEN ──────────────────
    const before = await client.query(
      `SELECT display_name, source_url,
              COALESCE(jsonb_array_length(affected_fields), 0) AS pairs,
              expected_content IS NOT NULL AS anchored,
              current_hash IS NOT NULL AS baselined
         FROM spec_watch_list ORDER BY is_test, display_name NULLS LAST, id`
    );
    console.log(`\n${TAG} watch list BEFORE — ${before.rowCount} row(s):`);
    for (const r of before.rows) {
      console.log(`    ${String(r.display_name || '(no name)').padEnd(30)} ${String(r.pairs).padStart(2)} pair(s)  ` +
        `${r.anchored ? 'anchored  ' : 'UNANCHORED'}  ${r.baselined ? 'baselined' : 'not baselined'}`);
    }
    const existingAsset = await client.query(
      'SELECT tenant_id, sort_order FROM asset_types WHERE name = $1 ORDER BY tenant_id', [ASSET]
    );
    console.log(`\n${TAG} tenants already holding "${ASSET}" BEFORE: ${existingAsset.rowCount}`);
    for (const r of existingAsset.rows) console.log(`    ${r.tenant_id} at sort_order ${r.sort_order}`);

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
              cf.spec_note IS NOT NULL AS has_note,
              cf.spec_verified_at::date AS verified, COUNT(*)::int AS tenants
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = $1
        GROUP BY 1,2,3,4,5,6,7 ORDER BY MIN(cf.sort_order)`,
      [ASSET]
    );
    console.log(`\n${TAG} the asset as stored (${check.rowCount} distinct field row(s)):`);
    for (const r of check.rows) {
      console.log(`    ${String(r.field_name).padEnd(18)} ${String(r.char_min + '-' + r.char_max).padEnd(7)}` +
        ` ${String(r.spec_type).padEnd(9)} ${r.has_note ? 'note' : '    '}  verified ${r.verified || '—'}  x${r.tenants} tenant(s)`);
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
        'Every field on this asset is enforced and cited, so all eleven belong in the gate; anything ' +
        'else here means the library is not the shape this migration was written against.'
      );
    }

    const existingWatch = await client.query('SELECT id, display_name FROM spec_watch_list WHERE source_url = $1', [URL]);
    if (existingWatch.rowCount > 0) {
      console.log(`\n${TAG} a watch row for this URL already exists (#${existingWatch.rows[0].id}` +
        ` ${existingWatch.rows[0].display_name}) — leaving it alone.`);
      console.log(`${TAG}   ITS affected_fields WAS NOT RE-DERIVED. Re-deriving an existing row is its own`);
      console.log(`${TAG}   decision with its own dry-run numbers — scripts/rederiveAffectedFields.js --only=<id>.`);
    } else {
      const w = await client.query(
        `INSERT INTO spec_watch_list
                (source_url, display_name, affected_fields, is_test, expected_content, anchor_scope)
         VALUES ($1, $2, $3::jsonb, false, $4, $5) RETURNING id`,
        [URL, DISPLAY, JSON.stringify(pairs), ANCHOR, ANCHOR_SCOPE]
      );
      console.log(`\n${TAG} inserted watch row #${w.rows[0].id} — ${DISPLAY}`);
      console.log(`${TAG}   anchor ${JSON.stringify(ANCHOR)} (${ANCHOR_SCOPE}), no stop marker`);
      console.log(`${TAG}   affected_fields: ${pairs.length} pair(s), derived above`);
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
    console.log(`\n${TAG} watch list AFTER — ${all.rowCount} row(s):`);
    for (const r of all.rows) {
      console.log(`    ${String(r.display_name || '(no name)').padEnd(30)} ${String(r.pairs).padStart(2)} pair(s)  ` +
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
// file runs nothing, the same way scripts/migrateAddGoogleSearchAsset.js is.
const SOURCE_URLS = { [ASSET]: URL };
const ENFORCE = FIELDS.filter((f) => f[4] === 'enforced').map((f) => [ASSET, f[0]]);

module.exports = {
  SOURCE_URLS, ENFORCE, ASSET, GROUP, URL, ANCHOR, ANCHOR_SCOPE, DISPLAY,
  FIELDS, QUOTES, VERIFIED_ON, DIRECTION, NOTES, checkSeedAgreement,
};

if (require.main === module) main();
