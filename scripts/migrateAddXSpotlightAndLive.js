'use strict';

// August 2026 — seed Twitter/X Spotlight Takeover and Twitter/X Live into
// already-seeded tenants.
//
// Structural precedent: scripts/migrateAddXConversationButtonAd.js, exactly.
// Same shape — --verify / dry-run-by-default / --commit, inTxn, one transaction,
// per-tenant existence check through quillio_normalize_name, sort_order anchored
// on a SIBLING ROW rather than a literal, no watch row created or touched, a
// per-field EVIDENCE map, and the rederive command printed on a successful
// commit with the row's real id looked up in the same transaction.
//
// (The task named scripts/migrateAddTwitterConversationButtonAd.js. No such file
// exists; the precedent is migrateAddXConversationButtonAd.js and that is what
// this copies. Recorded so the discrepancy is not read as a second pattern.)
//
// ─── IT SHIPPED REFUSING, AND HAS SINCE BEEN FILLED ───────────────────────
// QUOTES was empty when this file was written and requireHeaderEvidence() turned
// that absence into a refusal before the network and before DATABASE_URL was
// read. Nothing in this repo carried page text for Spotlight Takeover or X Live
// — `grep -rin "spotlight\|takeover\|trend name\|x live\|event page"` over
// scripts/, src/ and test/ returned nothing with a limit attached — and the
// authoring session had no egress to business.x.com (403 to CONNECT, measured).
//
// The three limits were an instruction, and an instruction is not a reading.
// Inventing three plausible sentences to unlock the file is precisely what
// scripts/migrateSpecIntegrityFixes.js did to Meta: careful, internally
// consistent, peer-reviewable and wrong.
//
// IT IS FILLED NOW, from a reading taken ON THE DEVICE on 2026-08-28 and supplied
// by the operator. The refusal has moved from "no evidence" to "no network":
// requireHeaderEvidence passes, and --verify from a session without egress fails
// at the fetch instead — a smaller gap, and one only a console with egress can
// close.
//
// ─── PROVENANCE OF THE THREE NUMBERS ──────────────────────────────────────
// SOLE WITNESS — Event Page Description, 280.
//   ONE occurrence on the page, human-verified 2026-08-28. Nothing else on this
//   page states it for this format, so this row is the only instrument there is
//   for that value: if the sentence moves, no second occurrence corroborates it
//   and no other watched page reports it. Treat a change here as unconfirmable
//   from within the system — it needs a human reading, not a second hash.
//
//   (Note the collision this does NOT create: Twitter/X Ad / Ad Copy and
//   Twitter/X Poll Ad / Post Copy also store 280, from their own sentences in
//   their own format blocks. Three fields, three sentences, one number. The
//   per-field EVIDENCE map below is what keeps them apart.)
//
// TREND NAME 20 AND TREND DESCRIPTION 30 — THE NUMBER IS CORROBORATED, THE
// SENTENCE IS NOT. The distinction matters and the first draft of this section
// blurred it.
//
//   The exact sentences in QUOTES[0] and QUOTES[1] occur ONCE each, the same as
//   the sole-witness one above. As spans they are single-occurrence and a
//   rewording of either would report ABSENT.
//
//   What appears twice is the VALUE — 20 and 30 each turn up elsewhere on the
//   page, in different wording. So if X rephrases the Takeovers block, the
//   number is still findable somewhere on the page and a human can check it
//   against a second statement. That is worth something and it is not what the
//   quote check measures.
//
//   Practically: a failed --verify on [0] or [1] is NOT evidence the limit
//   changed. It is evidence THAT SENTENCE changed. Go and read the other
//   occurrence before concluding anything about the number.
//
// ─── THE PAGE MARKS TREND DESCRIPTION OPTIONAL BUT HIGHLY RECOMMENDED ─────
// Recorded because it is a fact about the FORMAT that this schema cannot hold.
// copy_fields has no optional-field mechanism — a field is a row, and every row
// renders and is drafted unconditionally — so "optional but highly recommended"
// cannot be expressed as anything but a normal field.
//
// The consequence, so nobody reads it as a defect later: a writer who leaves
// Trend Description blank produces a document that reports as an INCOMPLETE
// draft, because parseDoc reads the blank paragraph after a bold label as an
// undrafted field. That is the same trade LinkedIn Carousel makes with five card
// headlines and the Poll Ad makes with four options. Seeding the field is still
// right — "highly recommended" is nearly always written, and a writer with
// nowhere to put it has no recourse.
//
// THIS IS A KNOWN ACCEPTED TRADE ON KYLE'S PARKED LIST, NOT AN UNDISCOVERED
// DEFECT. A writer who leaves Trend Description blank gets a document that
// reports as an incomplete draft. That has been looked at, priced and parked;
// anybody meeting it here should treat it as a decision already taken rather
// than as something to fix in passing.
//
// It is NOT in spec_note. Nothing has been measured about whether telling the
// drafter a field is optional changes what it produces, and this repo's record
// on unmeasured note wordings is that they act in unpredictable directions.
//
// ─── THE PAGE, AND WHY THIS IS AN ADD-FORMATS CHANGE ──────────────────────
// https://business.x.com/en/help/campaign-setup/creative-ad-specifications
//
// ALREADY WATCHED, anchored on the Promoted Ads sentence chosen by
// scripts/migrateFixXAnchor.js:
//   "of your posts beyond your followers to your desired target audience"
// This migration does NOT touch that row. An anchor is chosen against a fetched
// page with a declared section behind it, and re-choosing one as a side effect
// of seeding an asset is how a row ends up watching something nobody meant.
//
// NO NEW PAGE COST: the fields cite a URL already fetched and hashed weekly.
// What this run DOES cost is three pairs outside the write gate — the whole of
// the rederive half below.
//
// ─── WATCH COVERAGE: ONE THING UNVERIFIED, ONE THING DEFINITE ─────────────
// Stated at exactly the strength the evidence supports, in both directions,
// because overstating it either way is the failure this section exists to avoid.
//
// UNVERIFIED — whether these three numbers are genuinely hash-watched.
//   scripts/probeSpecPage.js derives NO stop marker for this URL. If the watch
//   row also holds no content_stop_marker, the whole normalized page is hashed
//   and a change to any of these three numbers WOULD flag.
//
//   But the row's own stored content_stop_marker has NOT been read. And the
//   probe's DERIVED marker has diverged from a STORED marker before, so the
//   probe's answer is not a substitute for the column. Until somebody reads
//   spec_watch_list.content_stop_marker for this row, "these fields are
//   hash-watched" is a plausible expectation and not a fact. Do not write it
//   down as one, and do not assume the opposite either.
//
// DEFINITE — the anchor asserts nothing about these sections.
//   scripts/migrateFixXAnchor.js:5-16 records that this page is ~40,562
//   normalized characters documenting at least seven formats, and that the row
//   is deliberately anchored INTO THE PROMOTED ADS BLOCK — the section its
//   existing fields come from — so that a restructure dropping that block
//   reports `failed` rather than staying green on another format's text.
//
//   Takeovers and X Live are DIFFERENT SECTIONS of that same page. The anchor
//   asserts the Promoted Ads block rendered. If X drops the Takeovers block and
//   keeps Promoted Ads, the anchor still matches.
//
//   That is an anchor question, not a hash question, and the two do not
//   substitute for each other: the hash may still notice the text disappearing
//   (see UNVERIFIED above), while the anchor — whose job is to prove the right
//   page rendered — would report healthy throughout.
//
// NOT FIXED HERE, deliberately. Closing the anchor half means either a second
// anchor per row (no column for it) or a second watch row for one URL (double
// fetch, double flag). Both are design changes owed their own commit and their
// own argument.
//
// ─── THE NAMES CARRY "Twitter/X" FOR A MEASURED REASON ────────────────────
// The task named these "Spotlight Takeover" and "X Live". Both bare names
// MIS-ROUTE. Measured by calling the real mediumKeywordsForAsset, not read off
// the source:
//
//     "Spotlight Takeover"            -> null
//     "X Live"                        -> null
//     "Twitter/X Spotlight Takeover"  -> ["paid social"]
//     "Twitter/X Live"                -> ["paid social"]
//
// A null return means the "unknown medium" fallback fires and EVERY craft.md
// medium section is injected — eight sections instead of one. That is the safe
// direction of the two failures (over-inclusion costs tokens; a mis-route
// replaces an asset's guidance with somebody else's and is silent), but it is
// still wrong, and it is wrong for a reason this repo has already priced:
// scripts/migrateAddXPollAd.js records that the platform regex matches
// 'twitter' and NOT a standalone 'x', and that widening it to \b(...|x)\b
// mis-routes "Poster — 24 x 36" and "Product X Launch Email".
//
// So the names take the prefix every other X asset in the library carries. If
// Kyle wants the bare names, that is his call — but it needs a new branch in
// mediumKeywordsForAsset plus an entry in the pinned routing table, not a
// rename here.
//
// ─── SORT ORDER CONTINUES THE X SEQUENCE ──────────────────────────────────
// The seed's X paid assets run Twitter/X Ad (5), Twitter/X Poll Ad (6), with
// Twitter/X Conversation Button Ad inserted after the Poll Ad by its own
// migration. These two continue that run, anchored on the tenant's OWN sibling
// rows rather than on a literal: a tenant seeded before the prune has different
// sort_order values for the same assets, so a number from the seed would land
// somewhere arbitrary in their library.
//
// ORDERED WITHIN THIS RUN TOO. Spotlight Takeover is inserted first and lists
// the Conversation Button ahead of the Poll Ad, so the two land in the order
// they appear here rather than in reverse.
//
//   node scripts/migrateAddXSpotlightAndLive.js --verify   # evidence + fetch + quotes
//   node scripts/migrateAddXSpotlightAndLive.js            # dry run (ROLLBACK)
//   node scripts/migrateAddXSpotlightAndLive.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[x-spotlight-live]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

// The date a human read the page. NOT WRITTEN UNTIL QUOTES IS FILLED —
// requireHeaderEvidence refuses first — so this date and the reading it names
// cannot come apart. The operator read the page on the device on this date and
// supplied the three sentences below.
const VERIFIED_ON = '2026-08-28';

const URL = 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications';

// The sentinel every house_default field carries. Never a URL. Unused today —
// every field is cited — and named so the INSERT reads the same as the
// migrations this copies rather than special-casing.
const HOUSE_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

// ─── THE PAGE TEXT, AS READ ────────────────────────────────────────────────
// Read on the device 2026-08-28 and supplied verbatim. Three sentences, one per
// cited field, each carrying that field's number and nothing else's.
//
// THE THREE ARE NOT PHRASED ALIKE, AND THE DIFFERENCES ARE THE PAGE'S, NOT A
// TRANSCRIPTION SLIP. Two put "Max" BEFORE the number; the third puts "max."
// AFTER it and ends with a full stop. Anyone tidying these into one house style
// breaks all three matches at once — normalize() collapses whitespace and
// decodes nothing, so every other character has to survive exactly.
//
//   [0] "Trend name: Max 20 characters"          — "Max" first, no trailing stop
//   [1] "Trend description: Max 30 characters"   — "Max" first, no trailing stop
//   [2] "Event page description: 280 characters max."  — "max." last, WITH the stop
//
// All three are ASCII: no curly apostrophe, no entity, no dash.
//
// THE PAGE'S CAPITALISATION IS LOWER-CASE ("Trend name", "Trend description",
// "Event page description") and the stored FIELD names are title-case. That is
// deliberate and it is why EVIDENCE exists: the field name is Quillio's, the
// quote is X's, and the map is what ties one to the other rather than a string
// comparison that would need them to agree.
const QUOTES = [
  'Trend name: Max 20 characters',
  'Trend description: Max 30 characters',
  'Event page description: 280 characters max.',
];

// WHICH QUOTE STATES WHICH FIELD'S LIMIT. "<Asset> || <Field>" -> index into
// QUOTES.
//
// Per-field rather than per-asset, following
// scripts/migrateAddXConversationButtonAd.js. Every cited field must be a key;
// an unmapped one is a refusal rather than a fall back to the any-quote sweep,
// because falling back is how a sentence from another format's block comes to
// stand as evidence for this one.
//
// WHAT THIS GATE ASSERTS, stated exactly so the header does not claim more than
// the code does: that every cited field names a quote, that the index is in
// range, and that the named quote contains that field's number as a WHOLE
// number. It does NOT assert the span came from that field's section — nothing
// offline can. --verify is what reads the live page.
const EVIDENCE = {
  // Keyed exactly as citedFields() builds the key: `${asset.name}||${field}`,
  // with NO spaces around the separator. The task wrote it as "<Asset> || <Field>";
  // that is the shape, and the literal separator in code is '||'. A key with
  // spaces would match nothing and the run would refuse — the safe direction,
  // but it would refuse for the wrong reason.
  'Twitter/X Spotlight Takeover||Trend Name': 0,
  'Twitter/X Spotlight Takeover||Trend Description': 1,
  'Twitter/X Live||Event Page Description': 2,
};

// [field_name, char_min, char_max, group_label|null, spec_type, spec_note|null, unit]
//
// char_min is 0 throughout: X publishes no floor for any of these, and a floor
// this project invented would collapse the spread of the copy without being
// anybody's rule — measured on the Subhead in scripts/floorAB.js, where stating
// a band cut the range by two thirds and cost the best line in the run.
//
// NO spec_note ON ANY FIELD. Nothing about these three has been read, so there
// is no consequence to state; a note written from the same instruction the
// numbers came from would be a second unsourced claim wearing writing guidance.
const ASSETS = [
  {
    url: URL,
    name: 'Twitter/X Spotlight Takeover',
    group: 'Paid Social',
    direction:
      'Top of the Explore tab, before anyone has chosen to look. The name has to read like '
      + 'something people are already saying, not something a brand is announcing.',
    // ORDERED. The first that exists in a tenant decides where this sits; if
    // none does, it appends.
    siblings: ['Twitter/X Conversation Button Ad', 'Twitter/X Poll Ad', 'Twitter/X Ad'],
    fields: [
      ['Trend Name', 0, 20, null, 'enforced', null],
      // RENAMED from 'Description'. The page calls it a trend description, and
      // the citation has to land on the words that are quoted — a field named
      // 'Description' cited to a sentence saying "Trend description" makes the
      // reader do the matching. It also tells it apart from every other
      // 'Description' in the library at a glance.
      ['Trend Description', 0, 30, null, 'enforced', null],
    ],
  },
  {
    url: URL,
    name: 'Twitter/X Live',
    group: 'Paid Social',
    direction: 'This is running now, or about to. Say what\'s on and give a reason to stop '
      + 'scrolling for it rather than catch the replay.',
    // Spotlight Takeover is listed FIRST so this lands after it — the two are
    // inserted in the order they appear in this array.
    siblings: ['Twitter/X Spotlight Takeover', 'Twitter/X Conversation Button Ad',
      'Twitter/X Poll Ad', 'Twitter/X Ad'],
    fields: [
      ['Event Page Description', 0, 280, null, 'enforced', null],
    ],
  },
];

// The unit a field's numbers are counted in. Seventh tuple element, 'text' when
// absent. No field here is word-counted; the helper is kept so the tuple shape
// matches the precedent and a future word field needs no change to the INSERT.
function fieldUnit(row) {
  return row[6] === 'words' ? 'words' : 'text';
}

// Every stored limit across an asset, as strings.
function storedLimits(asset) {
  return [...new Set(asset.fields.flatMap((f) => [f[1], f[2]]).filter((n) => n > 0).map(String))];
}

// Every cited (enforced) field across every asset, with the limit it claims and
// the key it is mapped by.
function citedFields() {
  return ASSETS.flatMap((a) =>
    a.fields.filter((f) => f[4] === 'enforced')
      .map((f) => ({ key: `${a.name}||${f[0]}`, asset: a.name, field: f[0], max: String(f[2]) })));
}

// The ONE transformation applied to a quote before matching, and it is the same
// one normalize() ends with. Not a general cleaner: no case folding, no
// punctuation folding, no entity decoding. Anything beyond whitespace collapse
// would make a quote match text the page does not contain.
function asNormalized(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// ─── THE REFUSAL ────────────────────────────────────────────────────────────
// Called before the network and before the database, by --verify and by the
// write path alike.
function requireHeaderEvidence() {
  if (!Array.isArray(QUOTES) || QUOTES.length === 0) {
    return {
      ok: false,
      why: 'QUOTES is empty — no reading of this page stands behind this run. Seeding three enforced '
        + `fields would stamp spec_verified_at = ${VERIFIED_ON} on each, which asserts a human read `
        + 'these values on the cited page. It was empty when this file was first written, for exactly '
        + 'that reason; if it is empty again somebody has removed the evidence.\n'
        + '       Run: node scripts/probeSpecPage.js ' + URL + ' --cited=20,30,280\n'
        + '       then restore the Spotlight Takeover and X Live sentences byte for byte, keeping\n'
        + '       each page\'s own phrasing — two read "Max <n> characters", one reads\n'
        + '       "<n> characters max." — and re-point EVIDENCE at them.',
    };
  }

  if (!VERIFIED_ON) {
    return {
      ok: false,
      why: 'VERIFIED_ON is null. QUOTES is filled but nobody recorded WHEN the page was read, and '
        + 'spec_verified_at is the column the document renders as "Verified against X\'s spec page on '
        + 'DATE." A date is not derivable from the quotes.',
    };
  }

  // 1. EVERY STORED LIMIT MUST APPEAR IN SOME QUOTE, AS A WHOLE NUMBER.
  //
  // WHOLE NUMBERS, via scripts/lib/wholeNumber.js: a substring test would let
  // "20" be satisfied by a "200" or a "1280" elsewhere in the quote, and "30" by
  // a "300". That is the defect that made a Pinterest --verify report 100
  // sixteen times against a page carrying none — and this page publishes image
  // widths in the hundreds and thousands, so it is live here rather than
  // theoretical.
  const { countWholeNumber } = require('./lib/wholeNumber');
  for (const asset of ASSETS) {
    for (const v of storedLimits(asset)) {
      const seen = QUOTES.some((q) => countWholeNumber(asNormalized(q), v) > 0);
      if (!seen) {
        return {
          ok: false,
          why: `${asset.name}: the stored limit ${v} appears in no quoted sentence. Either the quotes are `
            + 'from the wrong format block, or a field carries a number this file has no evidence for. '
            + 'Both are refusals: the header would be citing a page for a value it does not state.',
        };
      }
    }
  }

  // 2. AND EACH CITED FIELD'S LIMIT MUST APPEAR IN THE QUOTE THAT FIELD NAMES.
  //
  // The check above is a floor. On a page documenting seven formats that each
  // restate their own limits, "the number is somewhere in the quotes" is close
  // to free; naming which sentence carries it is not.
  for (const { key, max } of citedFields()) {
    if (!Object.prototype.hasOwnProperty.call(EVIDENCE, key)) {
      return {
        ok: false,
        why: `${key} is cited to ${URL} but names no quote in EVIDENCE. Every cited field says which `
          + 'sentence states its limit. An unmapped field is a refusal rather than a fall back to the '
          + 'any-quote sweep, because falling back is how another format block\'s sentence comes to '
          + 'stand as evidence for this one.',
      };
    }
    const idx = EVIDENCE[key];
    if (!Number.isInteger(idx) || idx < 0 || idx >= QUOTES.length) {
      return {
        ok: false,
        why: `EVIDENCE[${JSON.stringify(key)}] is ${JSON.stringify(idx)}, which is not an index into `
          + `QUOTES (0..${QUOTES.length - 1}).`,
      };
    }
    if (countWholeNumber(asNormalized(QUOTES[idx]), max) === 0) {
      return {
        ok: false,
        why: `${key} stores ${max}, but the quote it names — QUOTES[${idx}] — does not contain that `
          + 'number. Either the field is mapped to the wrong sentence, or the sentence does not say '
          + 'what this field claims it says.',
      };
    }
  }

  return { ok: true };
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// --- the page ---------------------------------------------------------------
// Returns { ok, why }. Called by --verify AND by the write path, so no value is
// written without the page being read in the same run.
async function readPage() {
  const evidence = requireHeaderEvidence();
  if (!evidence.ok) return evidence;

  const { fetchText, hashableText } = require('../src/services/specDetector');
  console.log(`\n${'='.repeat(74)}\nX — creative ad specifications\n${URL}\n${'='.repeat(74)}`);

  let a;
  let b;
  try {
    const rawA = await fetchText(URL);
    await new Promise((r) => setTimeout(r, 2500));
    const rawB = await fetchText(URL);
    // PASSED AS NULL, WHICH IS AN ASSUMPTION AND NOT A READING. See "WATCH
    // COVERAGE" in the header: the row's stored content_stop_marker has not been
    // read, so this probes the WHOLE normalized page. If the row does hold a
    // marker, the detector hashes LESS than this measures, and a quote reported
    // PRESENT here could sit outside the hashed region — present on the page,
    // invisible to the weekly diff. Reading that column is what closes it.
    //
    // Called through hashableText rather than normalize() directly so this takes
    // the same path the detector's run loop takes.
    a = hashableText({ content_stop_marker: null }, rawA);
    b = hashableText({ content_stop_marker: null }, rawB);
  } catch (err) {
    return { ok: false, why: `fetch failed: ${err.message}. A run with no network is a refusal, not a fallback.` };
  }

  console.log(`   hashed ${a.length} chars`);
  console.log(`   across two fetches: ${a === b ? 'STABLE' : 'VARIES'}`);

  let missing = 0;
  for (let i = 0; i < QUOTES.length; i++) {
    const q = asNormalized(QUOTES[i]);
    const n = count(a, q);
    if (n === 0) missing += 1;
    const fields = Object.entries(EVIDENCE).filter(([, v]) => v === i).map(([k]) => k);
    console.log(`   [${i}] ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 52))}${q.length > 52 ? '…' : ''}`);
    if (fields.length) console.log(`            evidence for: ${fields.join(', ')}`);
    if (n > 0) {
      const at = a.indexOf(q);
      console.log(`            at char ${at} of ${a.length} (${Math.round((at / a.length) * 1000) / 10}%)`);
    }
  }
  if (missing > 0) {
    return {
      ok: false,
      why: `${missing} quoted sentence(s) are not on the page. BEFORE CONCLUDING X CHANGED IT, check the `
        + 'transcription — that is what it was every time this check has fired in this repo. THREE ways '
        + 'to get it wrong here. (1) CHARACTER level: normalize() strips tags and DECODES NOTHING, so an '
        + '&nbsp; or an &amp; reaches the hashed text as literal characters, and an em dash flattened to '
        + 'a hyphen fails identically. (2) SENTENCE level: a quote assembled from more than one screenful '
        + 'can merge two of the page\'s sentences into a plausible hybrid that reads correctly and matches '
        + 'nothing — that is exactly how the X media-headline quote was wrong, on this same page. '
        + '(3) SECTION level: this page documents at least seven formats and most restate their own '
        + 'limits, so a span lifted from the wrong block may still be PRESENT while being evidence for '
        + 'nothing. A quote differing in punctuation, entities or sentence boundaries is ours to fix; one '
        + 'differing in a NUMBER is X\'s, and that is a real finding.',
    };
  }

  console.log('\n   stored limits, as a floor rather than a census:');
  const { countWholeNumber } = require('./lib/wholeNumber');
  for (const asset of ASSETS) {
    for (const v of storedLimits(asset)) {
      console.log(`   ${asset.name}  value ${String(v).padStart(4)}: ${countWholeNumber(a, v)}x in the hashed text`);
    }
  }
  console.log('   (a count above 1 is EXPECTED on this page — seven format blocks restate their');
  console.log('    own limits. It is not noise and it is not a pass: read WHICH block each span');
  console.log('    came from, which is what the per-field EVIDENCE map records.)');

  return { ok: true };
}

// --- the asset --------------------------------------------------------------
// One tenant, one asset. Returns 'inserted' | 'exists'.
async function insertForTenant(client, tenantId, asset) {
  const has = await client.query(
    'SELECT id FROM asset_types WHERE tenant_id = $1 AND quillio_normalize_name(name) = quillio_normalize_name($2)',
    [tenantId, asset.name]
  );
  if (has.rowCount > 0) return 'exists';

  // SORT ORDER IS ANCHORED ON THE TENANT'S OWN SIBLING ROW, not on a number from
  // the seed: a tenant seeded before the prune has different sort_order values
  // for the same assets, so a literal position would land somewhere arbitrary in
  // their library. The list is ordered, and the first sibling that exists wins.
  let at = null;
  for (const sibling of asset.siblings) {
    const sib = await client.query(
      'SELECT sort_order FROM asset_types WHERE tenant_id = $1 AND name = $2',
      [tenantId, sibling]
    );
    if (sib.rowCount > 0) {
      at = Number(sib.rows[0].sort_order) + 1;
      await client.query(
        'UPDATE asset_types SET sort_order = sort_order + 1 WHERE tenant_id = $1 AND sort_order >= $2',
        [tenantId, at]
      );
      break;
    }
  }
  if (at === null) {
    const max = await client.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM asset_types WHERE tenant_id = $1',
      [tenantId]
    );
    at = Number(max.rows[0].n);
    console.log(`${TAG}   ${tenantId}  none of [${asset.siblings.join(', ')}] present — appending at ${at}`);
  }

  const ins = await client.query(
    `INSERT INTO asset_types (tenant_id, name, "group", is_active, sort_order, asset_direction, spec_note)
       VALUES ($1, $2, $3, true, $4, $5, NULL) RETURNING id`,
    [tenantId, asset.name, asset.group, at, asset.direction]
  );
  const assetTypeId = ins.rows[0].id;

  for (let i = 0; i < asset.fields.length; i++) {
    const row = asset.fields[i];
    const [name, min, max, groupLabel, tier, note] = row;
    const enforced = tier === 'enforced';
    await client.query(
      `INSERT INTO copy_fields
              (asset_type_id, field_name, char_min, char_max, field_type, sort_order,
               spec_source, spec_version, group_label, spec_note, spec_type, spec_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        assetTypeId, name, min, max, fieldUnit(row), i + 1,
        enforced ? asset.url : HOUSE_SOURCE,
        SPEC_VERSION,
        groupLabel,
        note,
        tier,
        // ONLY THE CITED FIELDS CARRY A DATE. A house default has no page to
        // have been read against, so a verification date on one would assert an
        // event that cannot have happened.
        enforced ? VERIFIED_ON : null,
      ]
    );
  }
  console.log(`${TAG}   ${tenantId}  ${asset.name} at sort_order ${at}, ${asset.fields.length} field(s)`);
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

  // THE EVIDENCE CHECK RUNS BEFORE DATABASE_URL IS EVEN READ. A file with no
  // quotes has nothing to say to a database, and refusing here means the message
  // is about the evidence rather than about a missing connection string.
  const evidence = requireHeaderEvidence();
  if (!evidence.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${evidence.why}`);
    process.exit(1);
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

  // THE PAGE IS READ BEFORE THE DATABASE IS OPENED. A refusal here costs two
  // fetches; a refusal after the writes costs a rollback and reads as a failure
  // of the migration rather than of the evidence for it.
  const page = await readPage();
  if (!page.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${page.why}`);
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

    // THE WATCH ROW MUST EXIST. Fail closed: seeding enforced fields that cite
    // an unwatched page creates a coverage gap silently. Looked up BY URL rather
    // than by a hardcoded id — an id is production state, and a literal one here
    // would be a number this file cannot check.
    const watch = await client.query(
      'SELECT id, display_name, expected_content, current_hash IS NOT NULL AS baselined '
      + 'FROM spec_watch_list WHERE source_url = $1',
      [URL]
    );
    if (watch.rowCount === 0) {
      throw new Error(
        `no watch row for ${URL}. These 3 fields cite it, so seeding them now would create a coverage `
        + 'gap with nothing watching the page. Nothing written.'
      );
    }
    const watchRow = watch.rows[0];
    console.log(`\n${TAG} watch row #${watchRow.id} — ${watchRow.display_name}`);
    console.log(`${TAG}   anchor ${JSON.stringify(watchRow.expected_content)}`);
    console.log(`${TAG}   ${watchRow.baselined ? 'baselined' : 'NOT baselined'} — this run does not touch it.`);
    console.log(`${TAG}   NOTE: that anchor sits in the PROMOTED ADS block. It asserts that block`);
    console.log(`${TAG}   rendered, not the Spotlight or Live blocks these fields come from.`);

    const tenants = await client.query('SELECT DISTINCT tenant_id FROM asset_types ORDER BY tenant_id');
    console.log(`\n${TAG} ${tenants.rowCount} tenant(s) with an asset library`);

    const seededPairs = [];
    let insertedTotal = 0;
    let existedTotal = 0;
    for (const asset of ASSETS) {
      console.log(`\n${'─'.repeat(74)}\n${asset.name}\n${'─'.repeat(74)}`);
      let inserted = 0;
      let existed = 0;
      // COLLECTED IN THE SAME LOOP THAT SEEDS THEM. A pasted snapshot is the
      // failure affected_fields already has on the board.
      for (const row of tenants.rows) {
        const what = await insertForTenant(client, row.tenant_id, asset);
        if (what === 'inserted') {
          inserted += 1;
          for (const f of asset.fields) {
            if (f[4] === 'enforced') seededPairs.push({ asset: asset.name, field: f[0] });
          }
        } else {
          existed += 1;
          console.log(`${TAG}   ${row.tenant_id}  already has ${asset.name} — skipped`);
        }
      }
      insertedTotal += inserted;
      existedTotal += existed;
      console.log(`${TAG} ${inserted} tenant(s) gained it, ${existed} already had it`);

      // Read the outcome back rather than trusting rowCounts.
      const check = await client.query(
        `SELECT cf.field_name, cf.char_min, cf.char_max, cf.field_type, cf.spec_type, cf.spec_note,
                cf.spec_verified_at::date AS verified, COUNT(*)::int AS tenants
           FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
          WHERE at.name = $1
          GROUP BY 1,2,3,4,5,6,7 ORDER BY MIN(cf.sort_order)`,
        [asset.name]
      );
      for (const r of check.rows) {
        const band = `${r.char_min}-${r.char_max}${r.field_type === 'words' ? 'w' : ''}`;
        console.log(`    ${String(r.field_name).padEnd(24)} ${band.padEnd(8)}`
          + ` ${String(r.spec_type).padEnd(9)} verified ${r.verified || '—'}  x${r.tenants}`
          + `${r.spec_note ? `\n        note: ${JSON.stringify(r.spec_note)}` : ''}`);
      }
    }

    const pairs = [...new Map(seededPairs.map((p) => [`${p.asset}||${p.field}`, p])).values()]
      .sort((x, y) => x.asset.localeCompare(y.asset) || x.field.localeCompare(y.field));

    console.log(`\n${TAG} TOTAL: ${insertedTotal} asset insert(s), ${existedTotal} already present`);

    // --- the gate ------------------------------------------------------------
    console.log(`\n${'═'.repeat(74)}`);
    console.log(`${TAG} THE WRITE GATE IS NOW STALE — ${pairs.length} pair(s) seeded, none of them in it.`);
    console.log(`${'═'.repeat(74)}`);
    for (const p of pairs) console.log(`    ${p.asset} / ${p.field}`);
    console.log(`\n${TAG} spec_watch_list #${watchRow.id}.affected_fields still holds only what`);
    console.log(`${TAG} earlier migrations derived. A flag on this page will not offer the pairs`);
    console.log(`${TAG} above, and guardEdits will refuse them if posted. Nothing errors and no`);
    console.log(`${TAG} health check reports it — the URL is watched, so it looks covered.`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`\n${TAG} RUN THIS NEXT — it is the other half of this migration:`);
      console.log(`\n    node scripts/rederiveAffectedFields.js --only=${watchRow.id}`);
      console.log(`    node scripts/rederiveAffectedFields.js --only=${watchRow.id} --commit`);
      console.log(`\n${TAG} (dry run first. It re-derives from cf.spec_source = source_url AND`);
      console.log(`${TAG}  at.is_active, so it should report ${pairs.length} pair(s) gained and 0 lost.)`);
      console.log(`\n${TAG} Then: node scripts/auditWatchList.js and node scripts/checkSpecHealth.js`);
      console.log(`${TAG} No detection run is needed: no watch row was added, current_hash untouched.`);
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
const SOURCE_URLS = Object.fromEntries(ASSETS.map((a) => [a.name, a.url]));
const ENFORCE = ASSETS.flatMap((a) =>
  a.fields.filter((f) => f[4] === 'enforced').map((f) => [a.name, f[0]]));

module.exports = {
  ASSETS, SOURCE_URLS, ENFORCE, VERIFIED_ON, URL, QUOTES, EVIDENCE,
  asNormalized, fieldUnit, storedLimits, citedFields, requireHeaderEvidence,
};
