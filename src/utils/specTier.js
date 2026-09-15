'use strict';

// THE TIER SENTENCE — the one composer of "Platform limit (LinkedIn). Stay
// within this count.", "Recommended by Meta (Facebook Feed).", and the two
// house-default forms.
//
// ─── WHY IT LIVES IN utils/ AND NOT IN THE RENDER LAYER ─────────────────────
// It was in destinations/googleDocs.js, which requires googleapis. That was fine
// for as long as the generated document was the only surface that said what tier
// a number carries. It is not any more:
//
//   the DOCUMENT          destinations/googleDocs.js fieldHint
//   Settings → library    public/settings.html, a HAND-WRITTEN client-side copy
//                         labelled "Mirrors googleDocs specTypeLine"
//   Spec Check            services/specLookup.js — the third
//
// utils/specSource.js states the rule this follows, and states it about exactly
// this hazard: "the settings route needs it, and reaching it through
// destinations/googleDocs would pull googleapis into a page render and hardcode
// one destination into a router." specFreshness.js is here for the same reason.
// CLAUDE.md's rule for the review overlay's duplicated wording — "a third
// document type is the moment to extract them" — is the trigger that moved it.
//
// ─── WHAT MOVED, AND WHAT DID NOT ───────────────────────────────────────────
// MOVED, byte for byte: SPEC_SOURCE_DETAIL, sourceDetail, the two house-default
// sentences, NOT_A_HARD_LIMIT, and specTypeLine. googleDocs.js re-exports every
// one of them, so every existing caller, script and test is unchanged — the same
// pattern specSourceName already set when it moved to utils/specSource.js.
//
// STAYED in googleDocs.js, because each is about writing into a Google Doc
// rather than about what a tier says: READER_ONLY_LINES and the strip that
// applies it (a prompt concern), NOTE_SOURCE_LINKS (Docs range-link offsets),
// and provenanceKey (run-collapse across ADJACENT paragraphs).
//
// public/settings.html's client-side copy is deliberately NOT folded in here.
// Doing so changes what the Settings panel renders, which is not this feature's
// to change — it is a separate ticket, and until it lands the mirror there is
// still a mirror.
//
// ─── THE OFFSETS ARE PART OF THE CONTRACT ───────────────────────────────────
// specTypeLine returns { text, attributionLen, nameStart, nameLen } and every
// one of those is load-bearing for a caller that is NOT rendering a document:
// nameStart/nameLen say which substring is the platform name, which is what lets
// a web surface wrap it in an <a> without string-searching the sentence it was
// just handed. A caller that re-finds the name by indexOf has reintroduced the
// drift this module exists to remove.

const { specPlacementName } = require('./specSource');

//
// THE FIRST VERSION OF THIS COMMENT SAID "a platform spec page needs no
// qualifier: 'Recommended by Meta' is unambiguous because Meta is describing its
// own product." THAT IS FALSE, and it is the belief the placement investigation
// disproved. Meta's ads guide serves different numbers per PLACEMENT from the
// same format URL — Primary Text is 150 on Facebook Feed and 44 on Instagram
// Reels — so "Recommended by Meta" names a platform and hides which of its
// placements the number belongs to. A platform describing its own product is
// exactly where the ambiguity was.
//
// A research finding needs a qualifier too, for a different reason. Constant
// Contact's number comes from small-business campaigns, and a writer deciding
// whether to apply it to a B2B nurture email needs to know that before they trust
// it. Stating the population is the difference between a citation and an appeal to
// authority.
//
// So there are TWO kinds of qualifier and they share one rendering slot: a
// research POPULATION, enumerated below because only a human who read the study
// can state it, and a platform PLACEMENT, derived from the URL by
// utils/specSource.specPlacementName because the URL already says it. See
// sourceDetail beneath this table.
//
// `scope` goes in parentheses after the name; `finding` replaces the generic
// "Not a hard limit — adjust for your brand and goal." A source with no entry here
// renders exactly as it did before, so every platform line is unchanged.
const SPEC_SOURCE_DETAIL = {
  'https://www.constantcontact.com/blog/best-length-email-newsletter/': {
    // 2.1 million CUSTOMERS, not emails — the distinction matters, because a
    // per-customer figure says nothing about how many campaigns are behind it.
    scope: '2.1M customers, small-business campaigns',
    finding: 'Longer bodies click less.',
  },
  'https://www.gong.io/blog/do-execs-really-reply-to-cold-email-here-s-what-the-data-says': {
    // NO sample size, deliberately. The page states the finding without one, and
    // the figures in circulation (25M / 28M / 85M) attach to different Gong
    // studies — quoting any of them here would be citing a number this page does
    // not contain.
    //
    // The scope says REPLY rate and says it is not a click rate, because the other
    // research citation in this library IS a click rate. A writer who carries
    // Constant Contact's reasoning across to a cold email, or Gong's across to a
    // nurture email, has applied the right number to the wrong job — which is
    // exactly what naming the measured outcome prevents.
    scope: 'cold outreach reply rates, not marketing clicks',
    finding: 'Drops sharply past 100 words.',
  },
};

// The qualifier for one source, from whichever of the two kinds applies.
//
// An explicit entry WINS OUTRIGHT rather than merging with a derived placement.
// The two cannot co-occur today — every entry above is a study and no study URL
// carries a placement segment — and if one ever did, a hand-written population
// is a statement somebody made about what was measured, which is not a thing to
// silently append a routing slug to.
//
// Returns undefined when neither applies, which is every source in the library
// except the nine Meta fields: specTypeLine renders no parenthetical at all and
// the sentence is byte-identical to what it has always been.
function sourceDetail(specSource) {
  const explicit = SPEC_SOURCE_DETAIL[specSource];
  if (explicit) return explicit;
  const placement = specPlacementName(specSource);
  return placement ? { scope: placement } : undefined;
}


// THE HOUSE-DEFAULT SENTENCES. This is where a tenant finds out the number is
// theirs — deliberately here and not in an onboarding step. Onboarding is where
// people are lost, and a wall of spec fields in front of someone who has not yet
// seen the product work assumes they already have house numbers written down.
// They meet this at the moment they disagree with a number, which is when a
// setting actually gets adopted.
//
// Two forms, because the invitation is wrong once accepted: a tenant who has
// already set their own number does not need to be told to go and set it.
//
// EXPORTED, AND STRIPPED BACK OUT BEFORE DRAFTING (see parseDoc). Both sentences
// address the READER of the doc, not the writer of the copy — unlike the
// enforced/recommended lines, which are genuine constraints. Left in, they would
// reach Gemini as this field's `Field guidance:` on 144 seeded fields.
const HOUSE_DEFAULT_LINE = 'House default — set your own in Settings.';
const HOUSE_DEFAULT_LINE_SET = 'House default — yours, set in Settings.';

// ONE RULE, APPLIED TWICE. The test is the one already stated above: does this
// sentence address the READER OF THE DOC or the WRITER OF THE COPY? The Settings
// pointer fails it, and so does this — "not a hard limit, adjust" is advice to a
// human deciding whether to respect a number, and read as writing guidance it
// contradicts the ceiling stated in the same prompt bullet:
//
//   - "Headline" — character limit 40 — stay within this limit; guidance:
//     Recommended by Meta. Not a hard limit — adjust for your brand and goal.
//
// The character limit is the one constraint CLAUDE.md says always wins, and this
// arrives on 10 fields telling the model it does not.
const NOT_A_HARD_LIMIT = 'Not a hard limit — adjust for your brand and goal.';


// Compose the spec_type tier sentence as { text, nameStart, nameLen } — or null
// when there is no tier line. nameStart/nameLen locate the platform-name sub-range
// WITHIN text (so Phase B can hyperlink just the name); nameStart is -1 when there
// is no recognized source (the no-source form names nothing). The "(name)" /
// "by name" clause only appears once a real spec_source resolves to a platform
// name (see specSourceName); until then enforced/recommended render without naming
// a source — so nothing bogus (e.g. 'quillio_default') is shown.
//
// house_default returns a line; NULL still returns none. That distinction is new
// and it is the point: NULL is what every TENANT-AUTHORED field carries
// (createAssetType never writes spec_type), and a custom field has no house
// default to go and set. scripts/migrateBackfillSeededSpecType.js exists to stop
// a long-lived tenant's bundled fields sitting on the wrong side of it.
//
// `attributionLen` IS WHERE THE PER-FIELD CLAIM ENDS. Every tier line is an
// attribution — "Recommended by Meta (Facebook Feed)." — followed by a tail that
// is the same sentence on every field of that tier in the library. The
// attribution names the source and carries the hyperlink, so it is a claim about
// THIS field; the tail is boilerplate. Reported as a length so a caller can keep
// the first and drop the second without re-parsing the sentence it just built,
// and so nameStart/nameLen stay valid across the truncation (both sit inside the
// attribution). See fieldHint's `suppressDetail`.
function specTypeLine(specType, sourceName, detail, overridden) {
  if (specType === 'enforced') {
    if (sourceName) {
      const prefix = 'Platform limit (';
      const attribution = `${prefix}${sourceName}).`;
      return {
        text: `${attribution} Stay within this count.`,
        attributionLen: attribution.length,
        nameStart: prefix.length,
        nameLen: sourceName.length,
      };
    }
    const bare = 'Platform limit.';
    return {
      text: `${bare} Stay within this count.`, attributionLen: bare.length, nameStart: -1, nameLen: 0,
    };
  }
  if (specType === 'recommended') {
    if (sourceName) {
      const prefix = 'Recommended by ';
      // A research source names its population and its finding; a platform source
      // has neither and falls through to the wording it has always produced.
      const scope = detail && detail.scope ? ` (${detail.scope})` : '';
      const tail = detail && detail.finding
        ? ` ${detail.finding}`
        : ' Not a hard limit — adjust for your brand and goal.';
      const attribution = `${prefix}${sourceName}${scope}.`;
      return {
        text: `${attribution}${tail}`,
        attributionLen: attribution.length,
        nameStart: prefix.length,
        nameLen: sourceName.length,
      };
    }
    const bare = 'Recommended.';
    return {
      text: `${bare} Not a hard limit — adjust for your brand and goal.`,
      attributionLen: bare.length,
      nameStart: -1,
      nameLen: 0,
    };
  }
  if (specType === 'house_default') {
    // No source is named and nothing is hyperlinked — the authority is the
    // tenant, so nameStart stays -1 and fieldHint adds no link for this line.
    // ONE SENTENCE, so the attribution IS the whole line. A house default is
    // never part of a run anyway — it names no source, so it breaks one.
    const line = overridden ? HOUSE_DEFAULT_LINE_SET : HOUSE_DEFAULT_LINE;
    return { text: line, attributionLen: line.length, nameStart: -1, nameLen: 0 };
  }
  return null; // no tier (a tenant-authored field) → no tier line
}

module.exports = {
  specTypeLine,
  sourceDetail,
  SPEC_SOURCE_DETAIL,
  HOUSE_DEFAULT_LINE,
  HOUSE_DEFAULT_LINE_SET,
  NOT_A_HARD_LIMIT,
};
