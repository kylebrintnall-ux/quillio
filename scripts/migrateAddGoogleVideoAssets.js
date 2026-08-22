'use strict';

// August 2026 — add Google Performance Max and Google Demand Gen Video Ad, seed
// their copy fields into already-seeded tenants, and watch both spec pages.
//
// TWO ASSETS FROM TWO PAGES. The per-asset shape is
// scripts/migrateAddPinterestSpecs.js unchanged; what is new is a loop over an
// ASSETS table so both go through the same code rather than through two copies
// of it that could drift.
//
// ─── THE FETCHED PAGES ──────────────────────────────────────────────────────
// Both read 2026-08-21 through the detector's own fetchText + normalize from the
// Railway console. Verbatim, per CLAUDE.md's fetch rule, so every number below
// can be checked without leaving this file.
//
// PERFORMANCE MAX — https://support.google.com/google-ads/answer/17091269
//
//   "Headlines 30 characters max; include at least one with 15 characters or
//    less"
//   "Long headline 90 characters maximum; try to make sure headlines are at
//    least 30 characters long"
//   "Descriptions 90 characters maximum"
//   "Business name 25 characters maximum; exactly matches your domain name or
//    legally verified business name"
//   "Display URL path 15 characters maximum each"
//   "In text assets, the length limits are the same across all languages. Each
//    character in double-width languages like Korean, Japanese, or Chinese
//    counts as 2 towards the limit instead of one."
//
// DEMAND GEN VIDEO — https://support.google.com/google-ads/answer/17091270
//
//   "Type Maximum length Headline 30 characters Long headline 90 characters
//    Description 90 characters Call to action 10 characters Final URL Any"
//
// ─── WHY enforced ───────────────────────────────────────────────────────────
// Both pages use entry language: a table headed "Maximum length", and field text
// reading "characters max" and "characters maximum". That is what the field will
// accept, not advice about what reads well.
//
// The full argument is in scripts/migrateAddGoogleSearchAsset.js under "WHY
// enforced, AND WHY THE LinkedIn CAUTION DOES NOT APPLY" and is not restated
// here. What matters is that it is the same argument on the same publisher's
// pages, and that the LinkedIn open question turns on the opposite evidence — a
// heading reading "Text Recommendations" over numbers tiered as caps.
//
// ─── FIELD COUNTS: THE PAGE'S OWN MINIMUMS ──────────────────────────────────
// Performance Max states minimums of 3 headlines, 1 long headline and 2
// descriptions, and accepts up to 15 / 5 / 5. Seeded at the minimums, which is
// exactly what scripts/migrateAddGoogleSearchAsset.js did with Responsive
// Search's "minimum of 3 headlines, but you can enter up to 15" — see its
// "THREE HEADLINES, NOT FIFTEEN" section. One field per SHAPE, more by riffing;
// fifteen empty slots is a wall in front of a writer.
//
// ─── WHAT IS DELIBERATELY NOT SEEDED ────────────────────────────────────────
//
// IN-FEED VIDEO ADS, on page 17091270, are not seeded. The page states:
//
//   "Headlines 2 lines 40 characters per line"
//   "Descriptions 2 lines 35 characters per line"
//
// That is a PER-LINE limit across two lines, and copy_fields stores ONE number
// per field. Seeding 40 understates the field — a writer would be told they have
// 40 when they have two lines of it. Seeding 80 states a number the page does
// not publish, which is the invention this project has already paid for once.
// Both sentences are quoted here so the figures are findable if the field model
// ever grows a per-line concept; neither number is stored.
//
// YOUTUBE MASTHEAD, also on 17091270, is not seeded, and the evidence is a
// SINGLE WORD IN A TABLE HEADER. Its table reads "Recommended length" where the
// other two formats read "Maximum length" — so its numbers would be
// spec_type 'recommended', not enforced, and mixing the two tiers under one
// migration's "both enforced" claim would be false for a third of it.
//
// That is the same kind of wording evidence that left LinkedIn's nine an open
// question, arriving here in the opposite direction and being acted on rather
// than argued with: the page distinguishes the two itself, in its own headers,
// so nothing has to be inferred. Masthead is also reservation-only, bought
// through a sales rep, which is outside the self-serve work Quillio's users do —
// but the tier is the reason, and the sales channel is why nobody has missed it.
//
// THE CJK DOUBLE-COUNTING NOTE is quoted above and stored nowhere. "Each
// character in double-width languages ... counts as 2 towards the limit instead
// of one" is conditional on the language the copy is written in, and char_max is
// one number per field per tenant — the same reason Pinterest's 30-character CJK
// figure was not seeded. It is deliberately NOT in spec_note either: it applies
// to every field on the asset, and repeating it nine times would be noise on
// nine fields to carry one fact about the asset.
//
// THE PLACEMENT NOTE on 17091270 — headlines excluded from desktop and TV watch
// pages, and possibly not shown on mobile — is display behaviour, not a second
// limit. It does not give a writer two ceilings for one bracket the way Meta's
// per-placement pages do, so nothing here needs a placement model. It also
// describes IN-FEED video, which is not being seeded at all.
//
// ─── THE ANCHORS ARE CHOSEN AGAINST THE PAGE, NOT HARDCODED ─────────────────
// Each page carries an ORDERED candidate list and a declared SECTION. The run
// measures every candidate against the fetched text and takes the first that
// satisfies all three of:
//
//   1. present EXACTLY ONCE          — a repeat says nothing about WHICH part
//                                      of the page rendered
//   2. inside the declared SECTION   — the block that publishes the fields this
//                                      row is being created to watch
//   3. holds NONE of the limits      — those fields' own stored numbers
//
// Every candidate's evaluation is printed with the reason it was rejected, so
// the choice is auditable in the run output rather than only in this file.
//
// RULE 3 decides which status a real spec change reports. A missed anchor is
// `failed` — the page could not be READ. A moved number is `changed`. An anchor
// containing a watched limit converts the second into the first, so the event
// the row exists to catch arrives disguised as a broken page — the one failure
// mode that teaches a reviewer to dismiss the queue.
//
// RULE 2 IS THE ONE THIS FILE LEARNED THE HARD WAY, and it was added after the
// first version of this migration had already chosen an anchor that broke it.
// Both are satisfiable by a sentence describing a format this row does not
// watch, and a page carrying several formats has plenty of those. The first
// Demand Gen anchor measured CLEAN and UNIQUE and was
// "Headlines 2 lines 40 characters per line" — the IN-FEED VIDEO row, a format
// this migration deliberately does not seed. Two ways it is wrong, and the
// first is silent:
//   • Google drops the Demand Gen table and keeps in-feed → the row reports
//     `unchanged` forever while watching nothing it cares about
//   • Google drops in-feed and keeps Demand Gen → the row reports `failed` on a
//     page that is completely fine
// Same shape as the Meta image row's "Primary Text", which appeared on /image,
// /video and /collection alike and is what scripts/migrateFixMetaImageAnchor.js
// exists to replace. Clean and unique are properties of a STRING; in-section is
// the only one of the three that is a property of the PAGE'S STRUCTURE.
//
// THE RANKING, and the run names which of the three it took:
//   1. clean, in-section        — ideal
//   2. in-section, holds a limit — acceptable, and the run says WHICH limit and
//                                  prints the argument for why holding that one
//                                  is survivable
//   3. clean, OUT of section     — NOT ACCEPTABLE. Never chosen, however good it
//                                  looks. If nothing else exists the run refuses
//                                  and names the clean-but-outside candidate,
//                                  because taking it would be this exact defect
//                                  a second time
//
// 17091269 IS THE HARD ONE for rule 3: nearly every sentence beside its spec
// table carries 30, 90, 25 or 15. The digit-free clauses are what remain.
// 17091270 IS THE HARD ONE for rule 2: its section is a bare table of limits and
// almost nothing in it is digit-free, so its list runs clean-first and then down
// the in-section fallbacks in order of which limit is safest to hold.
//
// WHICH LIMIT IS SAFEST TO HOLD is not a guess about Google — it is a fact about
// this watch list. 30 and 90 are published on all three Google pages we watch,
// and NEITHER of the other two rows' anchors holds them: Responsive Search is
// anchored on "responsive search ads have character limits" and Performance Max
// on a digit-free clause of its Business name row. So a platform-wide move on 30
// or 90 still arrives as `changed` on two rows while this one reports `failed`.
// 10 is Demand Gen's CTA cap, stored by no other asset and published on no other
// watched page — holding it would convert the only signal there is into a broken
// -page report. Hence 10 ranks last.
//
// ─── WHAT MAKES THIS REFUSE ─────────────────────────────────────────────────
// Both pages are read BEFORE the database is opened, and it stops on any of:
//   • a quoted sentence missing from either page (a header that lies)
//   • a declared section whose span cannot be located on the page
//   • no candidate anchor present exactly once INSIDE that span (an anchor that
//     cannot fail, one that fails always, or one that proves the wrong thing, is
//     worse than none)
//   • either page varying between two fetches (it would need a stop marker)
//   • the derivation returning anything but the pairs it just seeded
// A run with no network is a refusal, not a fallback.
//
//   node scripts/migrateAddGoogleVideoAssets.js --verify   # fetch + measure, no DB
//   node scripts/migrateAddGoogleVideoAssets.js            # dry run (ROLLBACK)
//   node scripts/migrateAddGoogleVideoAssets.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[google-video-assets]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

// The date a human read the pages. Hardcoded rather than NOW(), for the reason
// scripts/migrateBackfillSpecVerifiedAt.js states.
const VERIFIED_ON = '2026-08-21';

const PMAX_URL = 'https://support.google.com/google-ads/answer/17091269';
const DGEN_URL = 'https://support.google.com/google-ads/answer/17091270';

// The sentinel every house_default field carries. Never a URL. Unused by these
// two assets — every field on both is cited — and named so the INSERT reads the
// same as the Pinterest migration's rather than special-casing.
const HOUSE_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

// Per-field notes. Named constants because the seed needs the identical strings
// and a smoke test compares the two byte for byte.
const PMAX_HEADLINE_NOTE = 'Include at least one headline of 15 characters or less.';
const PMAX_LONG_HEADLINE_NOTE = 'Aim for at least 30 characters.';
const PMAX_BUSINESS_NAME_NOTE = 'Must exactly match your domain name or legally verified business name.';

// [field_name, char_min, char_max, group_label|null, spec_type, spec_note|null]
//
// char_min is 0 throughout: neither page publishes a floor. "try to make sure
// headlines are at least 30 characters long" is ADVICE about what reads well,
// not an entry requirement — it goes in spec_note, where the Pinterest 40 went,
// rather than into char_min where it would collapse the spread of the copy
// without being anybody's rule (measured in scripts/floorAB.js).
const ASSETS = [
  {
    url: PMAX_URL,
    name: 'Google Performance Max',
    group: 'Paid Search',
    display: 'Google – Performance Max',
    direction: 'The system assembles the ad. Every asset has to stand alone and beside any other.',
    // ORDERED. The first that exists in a tenant decides where this sits; if none
    // does, it appends. Responsive Search is the natural neighbour and Responsive
    // Display is the one that certainly exists in every tenant today.
    siblings: ['Google Responsive Search Ad', 'Google Responsive Display Ad'],
    quotes: [
      'Headlines 30 characters max; include at least one with 15 characters or less',
      'Long headline 90 characters maximum; try to make sure headlines are at least 30 characters long',
      'Descriptions 90 characters maximum',
      'Business name 25 characters maximum; exactly matches your domain name or legally verified business name',
      'Display URL path 15 characters maximum each',
      'In text assets, the length limits are the same across all languages. Each character in double-width languages like Korean, Japanese, or Chinese counts as 2 towards the limit instead of one.',
    ],
    fields: [
      ['Headline 1', 0, 30, null, 'enforced', PMAX_HEADLINE_NOTE],
      ['Headline 2', 0, 30, null, 'enforced', null],
      ['Headline 3', 0, 30, null, 'enforced', null],
      ['Long Headline', 0, 90, null, 'enforced', PMAX_LONG_HEADLINE_NOTE],
      ['Description 1', 0, 90, null, 'enforced', null],
      ['Description 2', 0, 90, null, 'enforced', null],
      ['Business Name', 0, 25, null, 'enforced', PMAX_BUSINESS_NAME_NOTE],
      ['Display Path 1', 0, 15, null, 'enforced', null],
      ['Display Path 2', 0, 15, null, 'enforced', null],
    ],
    // THE SECTION whose disappearance this row has to notice. Both markers are
    // substrings of sentences quoted above, so the quote check proves they are on
    // the page before the span is ever computed — the span cannot be built out of
    // text nobody read.
    section: {
      name: 'the Performance Max text asset table',
      from: 'Headlines 30 characters max',
      to: 'Display URL path 15 characters maximum each',
    },
    // ORDERED BY PREFERENCE, and every one of these is digit-free — which on this
    // page is the scarce property, not an easy one. 30, 90, 25 and 15 are beside
    // almost every sentence in the spec table.
    anchors: [
      {
        text: 'exactly matches your domain name or legally verified business name',
        why: 'the Business name row\'s own qualifier — INSIDE the table, and the only clause '
          + 'in that row without its 25 attached',
      },
      {
        text: 'In text assets, the length limits are the same across all languages',
        why: 'the sentence introducing the CJK rule. Spec content rather than chrome, but it '
          + 'is a note ABOUT the table rather than a row of it, so whether it falls inside the '
          + 'span is a fact about the page layout and is measured rather than assumed',
      },
      {
        text: 'try to make sure headlines are at least 30 characters long',
        why: 'FALLBACK ONLY — in the Long headline row, so in-section, but it holds 30. '
          + 'Accepted last because a change to the headline cap would then report `failed` '
          + 'instead of `changed` (survivable: Responsive Search also stores 30 and its anchor '
          + 'does not hold it)',
      },
    ],
  },
  {
    url: DGEN_URL,
    name: 'Google Demand Gen Video Ad',
    group: 'Paid Social',
    display: 'Google – Demand Gen video',
    direction: 'Watched, not read. Say the one thing before the thumb moves.',
    siblings: ['Pinterest Pin', 'Twitter/X Ad'],
    quotes: [
      'Type Maximum length Headline 30 characters Long headline 90 characters Description 90 characters Call to action 10 characters Final URL Any',
    ],
    fields: [
      ['Headline', 0, 30, null, 'enforced', null],
      ['Long Headline', 0, 90, null, 'enforced', null],
      ['Description', 0, 90, null, 'enforced', null],
      ['Call to Action', 0, 10, null, 'enforced', null],
    ],
    // Both markers are substrings of the single table quoted above. The section
    // IS that table — it is the whole of what this row watches, and every field
    // seeded here is one of its rows.
    section: {
      name: 'the Demand Gen text asset table',
      from: 'Type Maximum length Headline 30 characters',
      to: 'Call to action 10 characters Final URL Any',
    },
    // ORDERED. The first four are IN-SECTION and ranked clean-first, then by which
    // stored limit is safest to hold (see the header). The last three are RECORDED
    // REJECTIONS — kept in the list, not deleted, so every run prints the string
    // that was wrongly chosen the first time along with the reason it is refused.
    // A rejection nobody can see gets re-proposed.
    anchors: [
      {
        text: 'Final URL Any',
        why: 'the table\'s last cell. Digit-free, so every watched limit still moves the hash '
          + 'and reports `changed`. The risk is that the in-feed table publishes a Final URL '
          + 'row too, which would make it 2x — measured, not assumed',
      },
      {
        text: 'Long headline 90 characters Description 90 characters',
        why: 'FALLBACK — in-section, holds 90 only. 90 is published on all three watched Google '
          + 'pages and NEITHER of the other two anchors holds it, so a platform-wide move still '
          + 'reports `changed` on Responsive Search and Performance Max while this row goes '
          + '`failed`',
      },
      {
        text: 'Headline 30 characters Long headline 90 characters',
        why: 'FALLBACK — in-section, holds 30 AND 90. Same cross-check argument, ranked below '
          + 'the 90-only candidate purely because it converts two limits into `failed` rather '
          + 'than one',
      },
      {
        text: 'Call to action 10 characters',
        why: 'LAST RESORT — in-section, holds 10, and 10 is stored by no other asset in the '
          + 'library and published on no other watched page. Holding it converts the only '
          + 'signal that exists for the CTA cap into a broken-page report',
      },
      {
        text: 'Headlines 2 lines 40 characters per line',
        why: 'RECORDED REJECTION — the IN-FEED headline row, and the anchor this migration '
          + 'chose before the section rule existed. Clean and unique, and out of section: it '
          + 'proves the in-feed table rendered, which is a format nothing here seeds',
      },
      {
        text: 'Descriptions 2 lines 35 characters per line',
        why: 'RECORDED REJECTION — the in-feed description row, same reason',
      },
      {
        text: 'Recommended length',
        why: 'RECORDED REJECTION — the Masthead table header. Digit-free and the word that '
          + 'distinguishes Masthead from the two Maximum-length formats, which makes it a good '
          + 'string and the wrong section',
      },
    ],
  },
];

// Every stored limit on an asset, as strings. An anchor must hold none of them —
// see the header for why that decides `changed` versus `failed`.
function storedLimits(asset) {
  return [...new Set(asset.fields.flatMap((f) => [f[1], f[2]]).filter((n) => n > 0).map(String))];
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// THE SECTION SPAN — [start, end) of the block that publishes the fields this
// row watches. Located by two markers that are themselves substrings of quoted
// sentences, so the quote check has already proved both are on the page.
//
// Passed in explicitly per asset rather than inferred. Inferring it would mean
// guessing which table a sentence belongs to from the sentence, and the whole
// point of this rule is that the guess is what went wrong.
function sectionSpan(text, section) {
  if (!section) return null;
  const start = text.indexOf(section.from);
  if (start < 0) return null;
  const end = text.indexOf(section.to, start);
  if (end < 0) return null;
  return { start, end: end + section.to.length };
}

function rejectionReason(c, span, chosen) {
  if (c.count === 0) return 'ABSENT — an anchor that never matches reports `failed` every week';
  if (!c.unique) return `${c.count}x — not unique, so it says nothing about WHICH section rendered`;
  if (!span) return 'NO SECTION SPAN — the markers are not on this page, so nothing is in-section';
  if (!c.inSection) {
    return c.clean
      ? 'OUT OF SECTION — clean and unique, and REFUSED anyway: it proves a page rendered, not '
        + 'that the watched table did'
      : 'OUT OF SECTION';
  }
  if (chosen && chosen.clean && !c.clean) {
    return `in-section, holds ${c.holds.join(', ')} — a clean in-section candidate ranked above it`;
  }
  return 'in-section and eligible — a candidate ranked above it';
}

// THE ANCHOR CHOICE, as a pure function so a test drives the same code the
// migration does. Returns the winner plus every candidate's evaluation and the
// reason each loser lost, because a choice nobody can audit is an assertion.
//
// NO SECTION MEANS NOTHING IS ELIGIBLE. Fail closed: an asset that forgets to
// declare one gets a refusal, not a free pass back to clean-and-unique. That is
// the same allowlist reasoning as TENANT_EDITABLE_TIERS — the invisible failure
// is the one to design against, and an anchor silently chosen under the old
// two-way rule is invisible for as long as the row keeps reporting healthy.
function chooseAnchor(text, candidates, limits, section) {
  const span = sectionSpan(text, section);
  const seen = candidates.map((c) => {
    const n = count(text, c.text);
    const at = text.indexOf(c.text);
    const holds = limits.filter((v) => c.text.includes(v));
    const unique = n === 1;
    const inSection = !!span && at >= 0 && at >= span.start && at + c.text.length <= span.end;
    return {
      ...c, count: n, at, holds, unique, inSection,
      clean: unique && holds.length === 0,
      eligible: unique && inSection,
    };
  });
  const chosen = seen.find((c) => c.eligible && c.clean) || seen.find((c) => c.eligible) || null;
  for (const c of seen) c.reason = c === chosen ? null : rejectionReason(c, span, chosen);
  const tier = !chosen ? null
    : chosen.clean ? '1 — clean and in-section' : `2 — in-section, HOLDS ${chosen.holds.join(', ')}`;
  return { chosen, seen, span, tier };
}

// --- the pages --------------------------------------------------------------
// Returns { ok, why, anchors }. Called by --verify and by the write path, so an
// anchor is never seeded without the page being read in the same run.
async function readPages() {
  const { fetchText, normalize, hashableText } = require('../src/services/specDetector');
  const anchors = {};

  for (const asset of ASSETS) {
    console.log(`\n${'='.repeat(74)}\n${asset.display}  ${asset.url}\n${'='.repeat(74)}`);

    let a;
    let b;
    try {
      const rawA = await fetchText(asset.url);
      await new Promise((r) => setTimeout(r, 2500));
      const rawB = await fetchText(asset.url);
      // content_stop_marker is null for these rows, so hashableText is
      // normalize(). Called through the helper anyway, so this measures the path
      // the run loop takes rather than a shortcut around it.
      a = hashableText({ content_stop_marker: null }, rawA);
      b = hashableText({ content_stop_marker: null }, rawB);
    } catch (err) {
      return { ok: false, why: `${asset.name}: fetch failed: ${err.message}. A run with no network is a refusal, not a fallback.` };
    }

    console.log(`   hashed ${a.length} chars`);
    const stable = a === b;
    console.log(`   across two fetches: ${stable ? 'STABLE — no stop marker needed' : 'VARIES — needs a marker'}`);
    if (!stable) {
      return { ok: false, why: `${asset.name}: the page varies between fetches; it needs a content_stop_marker before it can be watched` };
    }

    let missing = 0;
    for (const q of asset.quotes) {
      const n = count(a, q);
      if (n === 0) missing += 1;
      console.log(`   ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 58))}${q.length > 58 ? '…' : ''}`);
    }
    if (missing > 0) {
      return { ok: false, why: `${asset.name}: ${missing} quoted sentence(s) are not on the page — this file's header would be making a claim the page does not support` };
    }

    const limits = storedLimits(asset);
    console.log(`\n   stored limits on this asset: ${limits.join(', ')}`);
    for (const n of limits) console.log(`   value ${n}: ${count(a, n)}x in the hashed text`);

    const { chosen, seen, span, tier } = chooseAnchor(a, asset.anchors, limits, asset.section);

    console.log(`\n   SECTION  ${asset.section.name}`);
    if (!span) {
      console.log(`      NOT LOCATED — from ${JSON.stringify(asset.section.from.slice(0, 40))}`);
      console.log(`                     to ${JSON.stringify(asset.section.to.slice(0, 40))}`);
      return {
        ok: false,
        why: `${asset.name}: ${asset.section.name} could not be located on the page. Both markers `
          + 'are substrings of sentences quoted in this file, so if the quote check passed and this '
          + 'did not, the two markers are no longer adjacent — the page has been restructured and '
          + 'the section has to be re-read before anything can be anchored to it.',
      };
    }
    console.log(`      chars ${span.start}–${span.end} of ${a.length} (${span.end - span.start} chars)`);

    console.log('\n   ANCHOR CANDIDATES, in preference order:');
    for (const c of seen) {
      const mark = c === chosen ? '=>' : '  ';
      const where = c.count === 0 ? '—' : c.inSection ? 'in-section' : 'OUT';
      const limitCol = c.holds.length ? `holds ${c.holds.join('/')}` : 'clean';
      console.log(`   ${mark} ${String(c.count)}x  ${where.padEnd(10)} ${limitCol.padEnd(14)}` +
        ` ${JSON.stringify(c.text.slice(0, 44))}${c.text.length > 44 ? '…' : ''}`);
      if (c.reason) console.log(`         rejected: ${c.reason}`);
    }

    if (!chosen) {
      // NAME THE CLEAN-BUT-OUTSIDE CANDIDATE. It is the one a reader will be
      // tempted to reach for, and the refusal is worth nothing if it does not say
      // which string it is refusing and why.
      const cleanOut = seen.filter((c) => c.unique && c.clean && !c.inSection);
      return {
        ok: false,
        why: `${asset.name}: no candidate anchor is present exactly once INSIDE ${asset.section.name}. `
          + (cleanOut.length
            ? `${cleanOut.length} candidate(s) are clean and unique but sit OUTSIDE it — `
              + `${JSON.stringify(cleanOut[0].text)} is exactly the shape this rule exists to refuse. `
              + 'Taking it would give this row an anchor that reports healthy every week while the '
              + 'table it watches was gone. Add a candidate drawn from the section text; do not '
              + 'relax the rule.'
            : 'Every candidate is absent, repeated, or outside the section. Add one drawn from the '
              + 'section text and measure it.'),
      };
    }

    console.log(`\n   CHOSEN  ${JSON.stringify(chosen.text)}`);
    console.log(`           option ${tier}`);
    console.log(`           ${chosen.count}x, in-section, ` +
      `${chosen.clean ? 'holds no stored limit' : `HOLDS ${chosen.holds.join(', ')}`}`);
    console.log(`           ${chosen.why}`);
    if (!chosen.clean) {
      console.log('\n   !! NO CLEAN IN-SECTION ANCHOR ON THIS PAGE. Every candidate inside');
      console.log(`   !! ${asset.section.name} holds a stored limit, and the one taken`);
      console.log(`   !! holds ${chosen.holds.join(', ')}. A change to that value will report`);
      console.log('   !! `failed` — page unreadable — rather than `changed`. The candidate\'s own');
      console.log('   !! `why` above states which other watch rows still catch that move.');
      console.log('   !! Read the candidate list before running --commit.');
    }
    anchors[asset.url] = { ...chosen, tier, sectionName: asset.section.name };
  }

  return { ok: true, anchors };
}

// --- the assets -------------------------------------------------------------
// One asset, one tenant. Returns 'inserted' | 'exists'.
async function insertForTenant(client, tenantId, asset) {
  const has = await client.query(
    'SELECT id FROM asset_types WHERE tenant_id = $1 AND quillio_normalize_name(name) = quillio_normalize_name($2)',
    [tenantId, asset.name]
  );
  if (has.rowCount > 0) return 'exists';

  // SORT ORDER IS ANCHORED ON THE TENANT'S OWN SIBLING ROW, not on a number from
  // the seed: a tenant seeded before the prune has different sort_order values
  // for the same assets, so a literal position would land somewhere arbitrary in
  // their library. The list is ordered, and the first sibling that exists wins —
  // the natural neighbour may itself be a migration that has not run here yet.
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
    const [name, min, max, groupLabel, tier, note] = asset.fields[i];
    const enforced = tier === 'enforced';
    await client.query(
      `INSERT INTO copy_fields
              (asset_type_id, field_name, char_min, char_max, field_type, sort_order,
               spec_source, spec_version, group_label, spec_note, spec_type, spec_verified_at)
       VALUES ($1, $2, $3, $4, 'text', $5, $6, $7, $8, $9, $10, $11)`,
      [
        assetTypeId, name, min, max, i + 1,
        enforced ? asset.url : HOUSE_SOURCE,
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
  console.log(`${TAG}   ${tenantId}  ${asset.name} at sort_order ${at}, ${asset.fields.length} field(s)`);
  return 'inserted';
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (VERIFY) {
    const r = await readPages();
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

  // BOTH PAGES ARE READ BEFORE THE DATABASE IS OPENED. A refusal here costs two
  // fetches; a refusal after the writes costs a rollback and reads as a failure
  // of the migration rather than of the evidence for it.
  const pages = await readPages();
  if (!pages.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${pages.why}`);
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
    console.log(`\n${TAG} ${tenants.rowCount} tenant(s) with an asset library`);

    for (const asset of ASSETS) {
      console.log(`\n${'─'.repeat(74)}\n${asset.name}\n${'─'.repeat(74)}`);
      let inserted = 0;
      let existed = 0;
      // COLLECTED IN THE SAME LOOP THAT SEEDS THEM. A pasted snapshot is the
      // failure spec_watch_list.affected_fields already has on the board: it was
      // computed once by migrateAddSpecTables and is recomputed by nothing, so a
      // field added to a watched asset afterwards sits outside the write gate
      // with nothing naming it. Derived HERE it cannot drift from what this
      // migration wrote, because it IS what this migration wrote.
      const seededPairs = [];
      for (const row of tenants.rows) {
        const what = await insertForTenant(client, row.tenant_id, asset);
        if (what === 'inserted') {
          inserted += 1;
          for (const [name, , , , tier] of asset.fields) {
            if (tier === 'enforced') seededPairs.push({ asset: asset.name, field: name });
          }
        } else {
          existed += 1;
          console.log(`${TAG}   ${row.tenant_id}  already has ${asset.name} — skipped`);
        }
      }
      console.log(`${TAG} ${inserted} tenant(s) gained it, ${existed} already had it`);

      // Read the outcome back rather than trusting rowCounts.
      const check = await client.query(
        `SELECT cf.field_name, cf.char_min, cf.char_max, cf.spec_type, cf.spec_note,
                cf.spec_verified_at::date AS verified, COUNT(*)::int AS tenants
           FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
          WHERE at.name = $1
          GROUP BY 1,2,3,4,5,6 ORDER BY MIN(cf.sort_order)`,
        [asset.name]
      );
      for (const r of check.rows) {
        console.log(`    ${String(r.field_name).padEnd(15)} ${String(r.char_min + '-' + r.char_max).padEnd(6)}` +
          ` ${String(r.spec_type).padEnd(9)} verified ${r.verified || '—'}  x${r.tenants}` +
          `${r.spec_note ? `\n        note: ${JSON.stringify(r.spec_note)}` : ''}`);
      }

      const pairs = [...new Map(seededPairs.map((p) => [`${p.asset}||${p.field}`, p])).values()]
        .sort((x, y) => x.field.localeCompare(y.field));
      console.log(`\n${TAG} affected_fields, derived from what this run seeded — ${pairs.length} pair(s)`);

      const expected = asset.fields.filter((f) => f[4] === 'enforced').length;
      if (inserted > 0 && pairs.length !== expected) {
        throw new Error(
          `${asset.name}: expected ${expected} pair(s), derived ${pairs.length}. An empty or wrong `
          + 'affected_fields is a gate that permits nothing or too much, and creating either silently '
          + 'is worse than not creating the row.'
        );
      }

      const existingWatch = await client.query('SELECT id, display_name FROM spec_watch_list WHERE source_url = $1', [asset.url]);
      if (existingWatch.rowCount > 0) {
        console.log(`${TAG} a watch row for ${asset.url} already exists (#${existingWatch.rows[0].id}) — leaving it alone.`);
      } else if (pairs.length === 0) {
        throw new Error(
          `${asset.name}: no pairs to gate — every tenant already had the asset, so this run seeded `
          + 'nothing and a watch row created now would carry an empty affected_fields. Nothing written.'
        );
      } else {
        // THE ANCHOR WAS CHOSEN AGAINST THE FETCHED PAGE, not written here. See
        // readPages: the candidate list on each ASSETS entry is ordered by
        // preference and the winner is the first one that is present EXACTLY
        // ONCE, sits INSIDE the asset's declared section, and holds NONE of that
        // asset's stored limits. Its `why` is printed and stored alongside.
        //
        // WHICH OF THE THREE OPTIONS WAS TAKEN IS PRINTED, and it matters at
        // review time rather than only here. Option 1 (clean, in-section) is the
        // ideal. Option 2 (in-section, holds a limit) is accepted and announced
        // loudly, because it converts a move on that limit from `changed` into
        // `failed` — the candidate's `why` names the other watch rows that still
        // catch it. Option 3 (clean, OUT of section) is never taken: readPages
        // refuses the whole run instead, because an anchor asserting the wrong
        // format rendered reports healthy forever once the watched one is gone.
        //
        // content_stop_marker and source_kind are NOT NAMED in this INSERT, and
        // both land where this row wants them: content_stop_marker is nullable
        // with no default (NULL — both pages hashed MATCH across two fetches
        // three seconds apart), and source_kind defaults to 'platform_enforced'.
        // Omitting them also means this migration does not require
        // migrateAddContentStopMarker or migrateAddSourceKind to have run.
        const anchor = pages.anchors[asset.url];
        const w = await client.query(
          `INSERT INTO spec_watch_list
                  (source_url, display_name, affected_fields, is_test, expected_content, anchor_scope)
           VALUES ($1, $2, $3::jsonb, false, $4, 'normalized') RETURNING id`,
          [asset.url, asset.display, JSON.stringify(pairs), anchor.text]
        );
        console.log(`${TAG} inserted watch row #${w.rows[0].id} — ${asset.display}`);
        console.log(`${TAG}   anchor ${JSON.stringify(anchor.text)} (${anchor.count}x, ` +
          `${anchor.clean ? 'holds no stored limit' : `HOLDS ${anchor.holds.join(', ')}`})`);
        console.log(`${TAG}   option ${anchor.tier}, inside ${anchor.sectionName}`);
        console.log(`${TAG}   current_hash is NULL, so the next run takes the BASELINE branch.`);
      }
    }

    const all = await client.query(
      `SELECT display_name, COALESCE(jsonb_array_length(affected_fields), 0) AS pairs,
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
      console.log(`${TAG} Next: node scripts/runDetection.js — expect both new rows to report 'baseline'.`);
      console.log(`${TAG} Then: node scripts/checkSpecHealth.js — two watch rows were added.`);
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

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

// The maps below are required by smoke tests. Guarded so requiring this file runs
// nothing, the same way scripts/migrateFixMetaSpecs.js is.
//
// SOURCE_URLS and ENFORCE are keyed per asset the way every earlier link in the
// chain is. ASSET/GROUP/FIELDS/URL are singular on the one-asset migrations; this
// one carries two, so the general seed-agreement test reads ASSETS instead —
// see its CREATORS handling.
const SOURCE_URLS = Object.fromEntries(ASSETS.map((a) => [a.name, a.url]));
const ENFORCE = ASSETS.flatMap((a) =>
  a.fields.filter((f) => f[4] === 'enforced').map((f) => [a.name, f[0]]));

module.exports = {
  ASSETS, SOURCE_URLS, ENFORCE, VERIFIED_ON, chooseAnchor, sectionSpan, storedLimits,
  PMAX_HEADLINE_NOTE, PMAX_LONG_HEADLINE_NOTE, PMAX_BUSINESS_NAME_NOTE,
};
