'use strict';

// Google Docs destination adapter.
//
// Implements the destination contract consumed by the core workflow:
//   createDocument({ brief, summary, writerPrompt, assetSpecs, folderId, referenceLinks }) -> { id, url, title }
//   generateDraft(id) -> { title, fieldCount, url }
//
// Everything Google-Docs-specific (the Drive/Docs API calls, the batchUpdate
// formatting, the stateless doc re-parsing) lives behind this boundary so a
// future Notion/OneDrive adapter can be added without touching the workflow.

const config = require('../config');
const { getClients } = require('../google');
const { DocBuilder, NOTE_TEXT_STYLE, NOTE_TEXT_FIELDS } = require('./docBuilder');
const { findHeaderTable } = require('./docHeaderTable');
const { isValidHeaderSchema } = require('./docHeaderSchema');
const { isValidNamingPattern, applyNamingPattern } = require('./docNaming');
const { locateCells, readCells, buildCellWriteRequests } = require('./templateCells');
// The last four are the draft path's own ceiling ladder — reused as-is by
// enforceVariationCeiling below rather than reimplemented here.
//
// ABOVE THE BLOCK, NOT INSIDE IT. A comment between the braces is glued to the
// name beneath it by the structural import guard in test/smoke.test.js, which
// splits this list on commas — so `overLimit` read as one token with two
// comment lines on the front of it and the guard reported it as never imported.
const {
  generateAssetDrafts,
  generateFieldDraft,
  generateFieldVariations,
  cleanDraft,
  geminiErrorKind,
  worstGeminiKind,
  geminiFailureSentence,
  DOORWAYS,
  INTENSITIES,
  overLimit,
  trimCeiling,
  trimToCeiling,
  describeLength,
} = require('../services/gemini');
const { instanceTag, instanceCounter } = require('../utils/instanceKey');
const { specSourceName, specPlacementName } = require('../utils/specSource');
const { verifiedSentence } = require('../utils/specFreshness');
// Which repeated spec_notes may be shown once per run of adjacent fields. Read
// from the file where the notes themselves are written, so the decision sits
// beside the sentence it is about — see the comment on SHOW_ONCE_NOTES for the
// test that classifies a new one.
const { SHOW_ONCE_NOTES } = require('../data/defaultAssets');
// Same asset-name folding the pipeline uses to match a name to a library row, so
// instance-heading sibling detection groups names the same way.
const { normalize } = require('../utils/normalize');
// The stack parser, so an appended batch can number from the field's highest
// EXISTING option rather than restarting at 1. Same module copyReview reads the
// option number back with, so the two cannot disagree about what a numbered
// option line is.
const { parseNumberedStack } = require('../utils/variants');

// Allowed matrix names (Variations Matrix, Step 3), sourced from gemini so there's
// one taxonomy. Used to validate a scoped field's `variations` rows.
const ANGLE_NAMES = new Set(Object.keys(DOORWAYS));
const INTENSITY_NAMES = new Set(Object.keys(INTENSITIES));

// How many assets to draft concurrently (each asset is one batched Gemini call
// plus possible per-field fallbacks). Bounded to keep peak memory/CPU sane on an
// all-8-assets run while cutting wall-clock for typical 4-6 asset briefs.
// Tunable via DRAFT_CONCURRENCY.
const DRAFT_CONCURRENCY = Number(process.env.DRAFT_CONCURRENCY) || 5;

// Log a memory snapshot so we can see if a big run is approaching a ceiling.
function logMemory(label) {
  const m = process.memoryUsage();
  const mb = (b) => Math.round(b / 1024 / 1024);
  console.log(
    `[mem] ${label}: rss ${mb(m.rss)}MB, heapUsed ${mb(m.heapUsed)}MB, heapTotal ${mb(m.heapTotal)}MB`
  );
}

// Run `fn` over `items` with at most `limit` in flight; preserves input order.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function todayStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Articles / short prepositions that stay lowercase in Title Case unless they
// are the first word.
const SMALL_WORDS = new Set(['a', 'an', 'the', 'for', 'in', 'of', 'at', 'by']);

function toTitleCase(str) {
  return str
    .split(/\s+/)
    .map((word, i) => {
      if (!word) return word;
      if (i > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      // Capitalize the first letter; leave the rest as-is to preserve acronyms.
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// Cleanup pass for Gemini's campaign title: strip the junk models sometimes
// add (labels, surrounding quotes/markdown, an accidental leading date,
// trailing punctuation) and cap the length. Returns '' if nothing usable.
function cleanCampaignTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/^(?:campaign\s*title|title|campaign|name)\s*[:\-–—]\s*/i, ''); // leading label
  t = t.replace(/^\d{4}-\d{2}-\d{2}\s*[-–—:]*\s*/, ''); // accidental leading date
  // Shares cleanDraft with the field-copy path so the two can't drift: peels a
  // wrapper only when it's balanced and encloses the whole title, leaving a
  // title that merely OPENS with a quoted phrase intact.
  t = cleanDraft(t); // surrounding quotes/markdown
  t = t.replace(/[.,;:!]+$/, '').trim(); // trailing punctuation
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 8) t = words.slice(0, 8).join(' '); // keep it concise
  return t;
}

// Today's exact default doc name: Title Case campaign with a YYYY-MM-DD prefix.
function defaultTitle(brief, campaignTitle) {
  const base =
    cleanCampaignTitle(campaignTitle) ||
    String(brief).trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ') ||
    'Campaign';
  return `${todayStamp()} — ${toTitleCase(base)}`;
}

// Build the doc filename. With a stored per-tenant naming pattern, fill its
// dynamic spans from real project data and keep the static text verbatim; with
// no/invalid pattern, produce today's EXACT default name unchanged. `namingCtx`
// supplies optional writer/version (campaign/date/year are derived here).
function makeTitle(brief, campaignTitle, namingPattern, namingCtx) {
  if (isValidNamingPattern(namingPattern)) {
    const stamp = todayStamp();
    const campaign =
      cleanCampaignTitle(campaignTitle) ||
      String(brief).trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ') ||
      'Campaign';
    const name = applyNamingPattern(namingPattern, {
      campaign: toTitleCase(campaign),
      date: stamp,
      year: stamp.slice(0, 4),
      version: (namingCtx && namingCtx.version) || 'v1',
      writer: (namingCtx && namingCtx.writer) || '',
    }).trim();
    if (name) return name.slice(0, 200); // usable pattern result
    // empty result (e.g. all-blank tokens) → fall through to the default
  }
  return defaultTitle(brief, campaignTitle);
}

// Left indent (points) applied to fields nested under a group sub-heading.
const GROUP_INDENT_PT = 18;

// === Instance headings: one format, written and read in one place ===
//
// A doc can carry the same asset more than once. A lone instance renders its bare
// library name (byte-identical to every doc written before instances existed); a
// repeated one gets a 1-BASED ordinal, and its instance label when it has one:
//
//   1 instance   → 'Demand Gen Nurture Email'
//   3 instances  → 'Demand Gen Nurture Email 1'
//                  'Demand Gen Nurture Email 2 — Downtown residents'
//
// Writers count from 1; the key ordinal stays 0-based (utils/instanceKey), so the
// heading shows `instance + 1`.
//
// PARSING THIS BACK IS THE DELICATE PART. The label separator ' — ' is NOT a safe
// anchor on its own: 10 of the 25 bundled asset names already contain it ('Direct
// Mail — Box / Mailer', 'Organic Social — LinkedIn', …), so splitting on it would
// shred real names. What makes the format parseable is that the ORDINAL sits
// between the name and the label, so the anchor is ' <digits>' followed by either
// end-of-string or ' — '. No bundled name ends in ' <digits>' or contains
// ' <digits> — '; since the Google asset was renamed off 'DV360', no bundled name
// contains a digit at all. A smoke test re-checks that against the live library
// rather than trusting this comment.
//
// On top of that, acceptance requires a SIBLING: a suffix is only ever written
// when an asset appears 2+ times, so a decomposition is trusted only when another
// heading in the same doc decomposes to the same library name. A tenant asset
// legitimately named 'Concept 2' therefore still reads back as itself.
const INSTANCE_HEADING_RE = /^(.+?) (\d+)(?: — (.+))?$/;

// Spec group → the heading text to render. `total` is how many groups in this doc
// share this asset name; 1 (or less) means no suffix at all.
function assetHeadingText(assetType, instance, instanceLabel, total) {
  const name = String(assetType == null ? '' : assetType);
  if (!(Number(total) > 1)) return name;
  const ordinal = (Number(instance) || 0) + 1;
  const label = String(instanceLabel == null ? '' : instanceLabel).trim();
  return label ? `${name} ${ordinal} — ${label}` : `${name} ${ordinal}`;
}

// Heading text → { assetType, instance, instanceLabel } candidate, or null when the
// text carries no instance suffix. `instance` is 0-based (the heading's ordinal
// minus 1). A 0 or negative ordinal is not a suffix this writer produces, so it is
// rejected rather than folded to instance 0.
function decomposeAssetHeading(text) {
  const m = INSTANCE_HEADING_RE.exec(String(text == null ? '' : text));
  if (!m) return null;
  const ordinal = parseInt(m[2], 10);
  if (!Number.isFinite(ordinal) || ordinal < 1) return null;
  const label = m[3] ? m[3].trim() : null;
  return { assetType: m[1], instance: ordinal - 1, instanceLabel: label || null };
}

// Decide, for a whole document, which HEADING_3 texts are instance-suffixed.
// Takes every heading in document order and returns Map<headingText, decomposition>
// containing only headings whose decomposed library name is shared by 2+ headings —
// the sibling rule above. Headings absent from the map are literal asset names.
function instanceHeadingMap(headingTexts) {
  const byName = new Map(); // decomposed library name -> [{ text, parts }]
  for (const text of headingTexts) {
    const parts = decomposeAssetHeading(text);
    if (!parts) continue;
    const key = normalize(parts.assetType);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ text, parts });
  }
  const accepted = new Map();
  for (const entries of byName.values()) {
    if (entries.length < 2) continue; // a lone suffix is never something we wrote
    for (const { text, parts } of entries) accepted.set(text, parts);
  }
  return accepted;
}

// Every HEADING_3 text in a doc, in document order. Shared by the two readers so
// they classify headings identically.
function assetHeadingTexts(doc) {
  const out = [];
  for (const item of (doc && doc.body && doc.body.content) || []) {
    if (!item.paragraph) continue;
    if (item.paragraph.paragraphStyle?.namedStyleType !== 'HEADING_3') continue;
    out.push(paragraphText(item.paragraph).trim());
  }
  return out;
}

// Map a field's spec_source to a human-readable platform name for the tier line,
// or null when there's no real source yet. Phase A: production spec_source is
// uniformly 'quillio_default' (real per-field values arrive in a later
// re-anchoring pass), so that value — and anything unrecognized — returns null.
// The raw spec_source string is NEVER surfaced (we must never print
// 'quillio_default' or a bogus source name).
// MOVED to src/utils/specSource.js and re-exported here, so every existing
// caller and test is unchanged. It went because three things outside the render
// layer need it — the sweep's notification, checkSpecHealth, and the settings
// library's freshness line — and the settings route cannot reach into a
// destination without pulling googleapis into a page render.

// What a RESEARCH source actually measured, and what it found — for the sources
// that are studies rather than platform spec pages.
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

// Render-only citation links for hand-written spec_notes. Some notes end in a
// plain-text source credit like "(Litmus)"; this maps a note to the specific
// source page so fieldHint can hyperlink just the source WORD (same Phase-B
// range-link machinery as the tier-line platform name). This lives in the
// render layer only — it never touches spec_source, the seed, or the DB. Keyed
// on a DISTINCTIVE substring of the note (`match`) so the two Litmus notes each
// resolve to their own page; `name` is the exact word to hyperlink.
const NOTE_SOURCE_LINKS = [
  {
    match: 'Mobile inboxes cut around 40',
    name: 'Litmus',
    url: 'https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic',
  },
  {
    match: 'characters of preheader',
    name: 'Litmus',
    url: 'https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support',
  },
];

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
const READER_ONLY_LINES = [HOUSE_DEFAULT_LINE, HOUSE_DEFAULT_LINE_SET, NOT_A_HARD_LIMIT];

// THE PROVENANCE CLAUSE — "Verified against LinkedIn's spec page on 2026-08-20."
//
// A DOCUMENT CAN ONLY CARRY A STATIC DATE, and that constraint decides everything
// about this sentence. A .docx is a FILE: once it lands in someone's Drive
// nothing reaches inside it again. So whatever is written here is written once at
// creation and is still there in a year.
//
// THE FIRST VERSION GOT THIS WRONG and the fix is what this is. It rendered
// `spec_watch_list.last_checked_at` — a value that ADVANCES EVERY MONDAY the
// detector reads that page cleanly — frozen into an artifact that cannot change.
// One sample of a moving series, attributed to a document that outlives it. It
// failed in both directions: a doc built in March said "unchanged as of March"
// forever, understating a page the detector had confirmed every week since; and
// on any field whose page later changed and whose limit was corrected, the
// sentence asserted the source was unchanged when the correction existed BECAUSE
// it had changed. The second case did not need the sweep to appear — it arrives
// the moment any flag is approved.
//
// WHAT GOES IN A DOCUMENT IS A FACT ABOUT AN EVENT, NOT A READING OF A GAUGE.
// `copy_fields.spec_verified_at` records when a human last confirmed THIS number
// against its page. That is a fixed historical event: it was true when written
// and stays true forever, and a reader can see the date age and judge it. The
// moving number — how recently the detector saw the page unchanged — belongs on
// the spec library screen, which re-renders every time it is opened and is the
// only surface that can show it honestly.
//
// THE SENTENCE NAMES THE PLATFORM, AND THAT IS A CHECK ON US RATHER THAN A
// SERVICE TO THE READER. The hyperlink two sentences earlier already carries the
// source. "The source page" is a phrase that would survive being pointed at the
// wrong page; "LinkedIn's spec page" reads wrong the moment it sits under a Meta
// field. Specificity is what makes a careless claim visible.
//
// It is composed through specSourceName from the field's own spec_source — the
// SAME resolution the hyperlink uses — so there is one mapping rather than two
// that can disagree about who published a limit.
//
// STRIPPED BEFORE DRAFTING, by the same rule as the lines above: does this
// sentence address the READER OF THE DOC or the WRITER OF THE COPY? Provenance
// tells whoever opens the document who confirmed the number and when; it tells
// the model writing the copy nothing it can act on.
//
// A regex rather than a member of READER_ONLY_LINES, because both the platform
// and the date vary. `[^.]` cannot cross a sentence boundary, and the lookahead
// requires whitespace or end-of-string after the stop.
const VERIFIED_LINE = /\s*Verified against [^.]{1,60} on \d{4}-\d{2}-\d{2}\.(?=\s|$)/g;

// verifiedSentence — the provenance clause itself — IS COMPOSED IN
// src/utils/specFreshness.js, not here, and is re-exported below so this
// module's callers are unchanged. The settings library renders the IDENTICAL
// sentence beside the live watch state, and the whole point of that screen is to
// qualify the claim this document makes: two copies of the wording is how the
// qualification comes to describe a sentence the document no longer says.
//
// Its rules live with it — the ISO format, the four failure paths that all
// render nothing rather than something malformed, why "Verified" is the right
// word there and nowhere else, and the study-vs-spec-page wording edge.

// EVERY PROVENANCE WORDING THIS CODEBASE HAS EVER WRITTEN INTO A DOCUMENT.
//
// A document is a FILE. Nothing reaches inside it again, so a sentence shipped
// for one afternoon is still out there — and anything that READS a document back
// has to know every form, even the ones nothing writes any more. There are three:
//
//   "Source unchanged as of 2026-08-20."         1e37918, superseded by b018606
//   "Verified against Meta's spec page on …"     b018606, the current wording
//   "Limit corrected 2026-09-14."                written by the sweep, below
//
// The first was live on main for 75 minutes on 2026-08-20, and Railway
// auto-deploys main, so documents built in that window carry it. It is READ here
// and WRITTEN nowhere: verifiedSentence cannot produce it. Do not delete it as
// dead code — the documents are the reason it exists, and they outlive the
// composer that made them.
const CHECKED_LINE_SUPERSEDED = /\s*Source unchanged as of \d{4}-\d{2}-\d{2}\.(?=\s|$)/g;

// THE CORRECTION SENTENCE, written by the sweep in place of whichever provenance
// clause a field was carrying.
//
// Why it REPLACES rather than joins. The clause it displaces asserts that a
// human confirmed this number against its page on a date — and the sweep is
// moving the number precisely because that is no longer what the page says. A
// stale date would be untidy; a stale VERIFICATION is a false claim about the one
// field whose number just changed underneath the reader. Leaving it is worse than
// leaving nothing.
//
// Why it names no source. "Verified against Meta's spec page" earns its
// specificity because a human read that page; the sweep read a database row. A
// platform name here would claim the same authority for a different event.
const CORRECTED_PREFIX = 'Limit corrected ';
const CORRECTED_LINE = /\s*Limit corrected \d{4}-\d{2}-\d{2}\.(?=\s|$)/g;

// ISO only, and REFUSED rather than defaulted. A date this function invents is a
// date nobody can check; a throw happens before any request is built, so the
// document is untouched and the sweep logs it. (The same choice the overlapping-
// range guard makes, for the same reason.)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function correctedSentence(isoDate) {
  if (!ISO_DATE.test(String(isoDate || ''))) {
    throw new Error(
      `correctFieldBrackets needs correctedOn as YYYY-MM-DD; got ${JSON.stringify(isoDate)}. `
        + 'The document was NOT modified.'
    );
  }
  return `${CORRECTED_PREFIX}${isoDate}.`;
}

// The provenance clause as it sits at the END of a hint paragraph — an
// alternation over all three wordings, anchored the way LABEL_BRACKET_AT_END is
// and for the same reason: fieldHint APPENDS the clause last, so "the last
// sentence" is unambiguous, where a first-match search over a paragraph that also
// contains a tenant's note is not.
const PROVENANCE_AT_END = new RegExp(
  '(?:'
    + 'Verified against [^.]{1,60} on \\d{4}-\\d{2}-\\d{2}\\.'
    + '|Source unchanged as of \\d{4}-\\d{2}-\\d{2}\\.'
    + '|Limit corrected \\d{4}-\\d{2}-\\d{2}\\.'
    + ')[ \\t\\r\\n]*$'
);

// The recommended tier's ATTRIBUTION clause — "Recommended by Meta.",
// "Recommended by Constant Contact (2.1M customers, small-business campaigns)."
// Removed for the reason the reference-stats block withholds a source name: a
// source's NAME in a drafting prompt is an object the model can reason about and
// reach for, and this project has already measured what that costs. Provenance is
// the doc's job; guidance is the prompt's.
//
// The FINDING survives — "Longer bodies click less." is writing guidance and stays.
// The lookahead requires whitespace or end after the stop, so the period inside
// "2.1M" cannot end the match early.
//
// The trade, stated: a tenant note whose own sentence begins "Recommended by …"
// loses that sentence. The cost is one sentence of guidance, not a harmful line,
// and the alternative — anchoring to end-of-string — would eat the finding.
const RECOMMENDED_ATTRIBUTION = /\s*Recommended(?: by .{1,120}?)?\.(?=\s|$)/g;

// Remove the house-default sentence from a recovered italic line, leaving the
// tenant's own spec_note (which IS writing guidance and must survive).
//
// fieldHint space-joins note + tier, so the sentence is always a suffix — but
// this matches it anywhere and tidies the join, because a doc is a document:
// somebody will paste a note under it or reorder the line by hand, and a strip
// that only worked in one position would quietly start shipping the sentence to
// Gemini the first time that happened. Both wordings are matched, so a doc built
// before an override still strips after one.
function stripReaderOnlyLines(text) {
  let out = String(text == null ? '' : text);
  for (const line of READER_ONLY_LINES) out = out.split(line).join(' ');
  out = out.replace(RECOMMENDED_ATTRIBUTION, ' ');
  // All three provenance wordings, not just the one the composer writes today.
  // The strip's job is to keep reader-facing sentences out of a drafting prompt,
  // and the prompt is built from a DOCUMENT — which may have been written by any
  // version of this file. The superseded wording stopped being stripped the
  // moment VERIFIED_LINE replaced CHECKED_LINE, so every document from that
  // window has been shipping "Source unchanged as of 2026-08-20." into its own
  // Field guidance ever since. Small, and exactly the class of silent failure
  // this function exists to prevent.
  out = out.replace(VERIFIED_LINE, ' ');
  out = out.replace(CHECKED_LINE_SUPERSEDED, ' ');
  out = out.replace(CORRECTED_LINE, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

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

// What makes two adjacent fields' provenance the SAME provenance: the tier, the
// page it is cited to, and the date a human last confirmed it. null when the
// field names no source, which is what breaks a run.
//
// Composed from the three values the suppressed sentences are ABOUT, so the rule
// cannot drift from what it suppresses: change what the tail says and this key
// has to change with it.
function provenanceKey(field) {
  if (!field || !field.specType) return null;
  const source = String(field.specSource || '');
  if (!source || source === 'quillio_default') return null;
  const day = field.specVerifiedAt ? String(field.specVerifiedAt).slice(0, 10) : '';
  return `${field.specType}\u0000${source}\u0000${day}`;
}

// The italic grey guidance line under a field label, returned as { text, links }
// (or null when there's no line). `text` is the composed line — the hand-written
// spec_note (verbatim) then the spec_type tier sentence, space-joined. `links` is
// a list of { start, end, url } sub-ranges to hyperlink within `text` — currently
// just the platform name inside the tier line, pointing at the field's
// spec_source URL. `links` is empty when there's no recognized source (no-source
// form) or no tier line.
//
// The name offset is tracked structurally (specTypeLine reports nameStart, and we
// add the spec_note prefix + joining-space here) — never re-searched from the
// flat text. ONE paragraph, space-joined (not newline): b.fieldNote() emits a
// single paragraph and parseDoc treats any SECOND paragraph after a label as
// drafted copy (deleted on the first "Generate Draft"). The link is a sub-range
// within that one paragraph, so the notes-branch still consumes it whole.
// `suppressNote` drops the spec_note and keeps everything else. Additive and
// optional — every existing caller passes one argument and is unaffected.
//
// The DECISION is not made here, because it cannot be: whether a note has already
// been shown is a property of the fields BEFORE this one, and fieldHint sees one
// field at a time. The field loop in createDocument tracks that and passes the
// answer down. See SHOW_ONCE_NOTES in data/defaultAssets.js for which notes may
// be dropped and the test for classifying a new one.
//
// TWO INDEPENDENT SUPPRESSIONS, and they take different halves.
//
// `suppressNote` drops the tenant/seed NOTE, when an adjacent field already said
// it (SHOW_ONCE_NOTES). `suppressDetail` drops the BOILERPLATE half of the tier
// line and the verification sentence, when an adjacent field has identical
// provenance (provenanceKey above).
//
// WHAT NEVER GOES IS THE ATTRIBUTION. "Recommended by Meta (Facebook Feed)." is
// a claim about THIS field's limit and THIS field's source page, and it carries
// the citation hyperlink — a writer on Card 4 with nothing to click is worse off
// than one reading a sentence they have already read. Four fields whose limit had
// no stated provenance is what the provenance work was about removing, and
// collapsing a repetition must not put any field back there.
//
// This comment previously said "the tier line and the verification date stay on
// every field". That was true when only the note could be suppressed; it is the
// sentence this change made false, and it is corrected here rather than left to
// teach the next reader a rule that no longer holds.
function fieldHint(field, { suppressNote = false, suppressDetail = false } = {}) {
  const note = !suppressNote && field && field.specNote != null ? String(field.specNote).trim() : '';
  const tier = field
    ? specTypeLine(
      field.specType,
      specSourceName(field.specSource),
      sourceDetail(field.specSource),
      field.specOverridden === true
    )
    : null;
  // ON A REPEAT, THE ATTRIBUTION SURVIVES AND THE BOILERPLATE GOES. `Recommended
  // by Meta (Facebook Feed).` is a claim about THIS field and carries the
  // citation link; `Not a hard limit — adjust for your brand and goal.` is the
  // same sentence on all eleven recommended fields in the library, and the
  // verification sentence is dropped with it. Both are restored the moment any
  // part of the run key differs — see appendBody.
  const tierText = tier && (suppressDetail ? tier.text.slice(0, tier.attributionLen) : tier.text);
  const parts = [note, tierText].filter(Boolean);
  if (!parts.length) return null;
  // THE CLAUSE RIDES A TIER LINE THAT ACTUALLY NAMES A SOURCE — `nameStart >= 0`,
  // the same condition that decides whether the platform name gets hyperlinked
  // below, so the sentence and the link can never disagree about whether there is
  // a source to speak of.
  //
  // Not merely "there is a tier line". A house_default line reads "House default
  // — set your own in Settings." and names nobody, so "Verified against …'s spec
  // page" would have no referent in its own paragraph; the same goes for the
  // no-source forms of enforced and recommended. A tenant-authored field has no
  // tier line at all and is excluded by the same test.
  //
  // Redundant with verifiedSentence's own specSourceName guard, and kept anyway:
  // one decides whether a NAME exists, this decides whether the paragraph has
  // already introduced it. A test rendering a house_default field with a date
  // supplied produced exactly that dangling sentence before this was tightened.
  // Suppressed with the tail, and for the same reason: on a run every field
  // carries the same date, so repeating it says nothing. A field whose date
  // DIVERGES is not in the run — the key includes it — so it restores its own
  // full line with no exception written anywhere.
  const verified = !suppressDetail && tier && tier.nameStart >= 0
    ? verifiedSentence(field && field.specVerifiedAt, field && field.specSource)
    : '';
  if (verified) parts.push(verified);
  const text = parts.join(' ');
  const links = [];
  // Note-embedded citation (e.g. "(Litmus)"): the note is parts[0], so its
  // offsets map directly into `text` (base 0). Scan the NOTE ONLY, keyed on a
  // known match list — never the composed text or body copy, and never any
  // parenthesized word — then hyperlink just the source name. First match only.
  if (note) {
    for (const entry of NOTE_SOURCE_LINKS) {
      if (!note.includes(entry.match)) continue;
      const i = note.indexOf(entry.name);
      if (i < 0) continue;
      links.push({ start: i, end: i + entry.name.length, url: entry.url });
      break;
    }
  }
  if (tier && tier.nameStart >= 0) {
    const base = note ? note.length + 1 : 0; // spec_note prefix + the joining space
    const start = base + tier.nameStart;
    links.push({ start, end: start + tier.nameLen, url: String(field.specSource) });
  }
  return { text, links };
}

// Is this field's range counted in WORDS rather than characters? Accepts either the
// pipeline's `fieldType` or the raw `field_type` column, so a spec group and a
// database row both answer the same way.
function isWordField(field) {
  const t = field && (field.fieldType || field.field_type);
  return String(t || '') === 'words';
}
// The unit SUFFIX inside the bracket. This is not decoration — it is the only
// carrier of the unit through the document. There is no persisted doc state
// (CLAUDE.md): the draft, regenerate and review paths all reconstruct fields by
// re-parsing the Doc, so if the label did not say "words" the unit would be lost
// the moment the doc was written, and every downstream prompt would go back to
// telling the model to count characters.
const WORD_UNIT_SUFFIX = ' words';

// The bracket alone, without the field name in front of it.
//
// SPLIT OUT OF fieldLabel BECAUSE THE SWEEP REWRITES THIS SUBSTRING IN PLACE.
// services/specSweep.js corrects an enforced limit by replacing exactly the
// bracket inside an existing bold label — it never rewrites the label — so it
// needs to compose the replacement the same way the label was composed in the
// first place. Two copies of these three lines is precisely the drift CLAUDE.md
// records for the review overlay's wording: the day someone changes the dash to
// an en dash, or moves the unit suffix, every swept document stops matching the
// documents that were built. One composer, two callers.
//
// fieldLabel's output is byte-identical to what it was before the split.
function fieldBracket(field) {
  const min = Number(field.charMin) || 0;
  const max = Number(field.charMax) || 0;
  const unit = isWordField(field) ? WORD_UNIT_SUFFIX : '';
  if (min > 0 && max > 0) return `[${min}-${max}${unit}]`;
  if (max > 0) return `[${max}${unit}]`;
  return ''; // charMax === 0 → no bracket
}

function fieldLabel(field) {
  const bracket = fieldBracket(field);
  return bracket ? `${field.fieldName} ${bracket}` : field.fieldName;
}

// Strip the bits of markdown that render as literal characters in a Google Doc:
// **bold** / *italic* markers, leading # heading markers, and leading bullet
// symbols. Returns clean plain text. Applied at doc-write time only.
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1') // *italic* -> italic
    .replace(/^#{1,6}\s*/gm, '') // # heading markers
    .replace(/^\s*[-*•]\s+/gm, ' ') // leading bullet -> space
    .trim();
}

// Pull a Drive/Docs file or folder id out of a Google URL, or null.
function driveIdFromUrl(url) {
  if (!/(?:drive|docs)\.google\.com/.test(url)) return null;
  const m =
    url.match(/\/(?:d|folders)\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Resolve a reference URL to { url, label }. For Drive links, use the file's
// real name; otherwise (or on any failure) fall back to the raw URL.
async function resolveLinkLabel(drive, url) {
  const fileId = driveIdFromUrl(url);
  if (!fileId) return { url, label: url };
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'name',
      supportsAllDrives: true,
    });
    return { url, label: res.data.name || url };
  } catch {
    return { url, label: url };
  }
}

// Appends the doc BODY (everything below the top header) onto `b`:
// Campaign Summary, Writer Direction, optional Reference Insights / Reference
// Materials, a horizontal rule, then one section per asset. Identical whether
// the header above it is today's default (title + HR) or a stored header schema,
// so the drafting pipeline still parses these sections the same way in both.
function appendBody(b, { summary, writerPrompt, resolvedLinks, referenceInsights, assetSpecs }) {
  b.heading('Campaign Summary');
  b.italic(stripMarkdown(summary) || '(no summary)');

  b.heading('Writer Direction');
  const wdLines = (stripMarkdown(writerPrompt) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (wdLines.length === 0) {
    b.italic('(no direction)');
  } else {
    for (const line of wdLines) {
      // Pain Points renders as a label line + a disc bullet per pipe-separated
      // item. Every other field stays a plain prose line.
      const pp = line.match(/^pain points\s*:\s*(.*)$/i);
      if (pp) {
        b.italic('Pain Points:');
        const points = pp[1].split('|').map((p) => p.trim()).filter(Boolean);
        for (const p of points) b.bullet(p);
      } else {
        b.italic(line);
      }
    }
  }

  // Reference Insights — what was extracted per source. Omitted when empty.
  if (Array.isArray(referenceInsights) && referenceInsights.length > 0) {
    b.heading('Reference Insights');
    for (const ins of referenceInsights) {
      const source = String((ins && ins.source) || '').trim() || 'Unknown source';
      const type = String((ins && ins.type) || '').trim();
      b.italic(type ? `From: ${source} (${type})` : `From: ${source}`);

      const stats = Array.isArray(ins && ins.stats) ? ins.stats.filter(Boolean) : [];
      if (stats.length) {
        b.italic('Stats:');
        for (const s of stats) b.bullet(String(s).trim());
      }

      const keyMessages = Array.isArray(ins && ins.keyMessages) ? ins.keyMessages.filter(Boolean) : [];
      if (keyMessages.length) {
        b.italic('Key messages:');
        for (const m of keyMessages) b.bullet(String(m).trim());
      }

      b.blankLine();
    }
  }

  if (resolvedLinks.length > 0) {
    b.heading('Reference Materials');
    for (const { url, label } of resolvedLinks) {
      b.link(label, url);
    }
  }

  b.horizontalRule();

  // How many groups share each asset name — a name appearing once renders bare, so
  // every doc written before instances existed is byte-identical.
  const instanceTotals = new Map();
  for (const asset of assetSpecs) {
    const key = normalize(asset.assetType);
    instanceTotals.set(key, (instanceTotals.get(key) || 0) + 1);
  }

  for (const asset of assetSpecs) {
    b.assetHeading(
      assetHeadingText(
        asset.assetType,
        asset.instance,
        asset.instanceLabel,
        instanceTotals.get(normalize(asset.assetType))
      )
    );
    // Asset-level creative direction (from Postgres) — one italic line directly
    // under the heading. Falls back to the Sheet's channel · tone meta when no
    // direction is set; omitted entirely when both are empty.
    const direction = String(asset.asset_direction || '').trim();
    const meta = [asset.channel, asset.toneNotes].filter(Boolean).join(' · ');
    const headerLine = direction || meta;
    if (headerLine) b.italic(headerLine);
    // Fields render top-to-bottom. Consecutive fields sharing a group_label
    // (e.g. "Graphic Copy") emit that sub-heading once, then render indented so
    // the on-graphic copy reads as one nested unit.
    let openGroup = null;
    // A note listed in SHOW_ONCE_NOTES is emitted on the FIRST field of a run of
    // ADJACENT fields sharing it, and dropped on the rest. Meta Carousel's five
    // card headlines carry one identical sentence; before this they stacked
    // 202 characters of it five times above the fields where a writer is doing
    // the most work.
    //
    // ADJACENT, tracked as "the note the PREVIOUS field carried" rather than as a
    // set of everything seen in this asset. The same sentence reappearing seven
    // fields later is not repetition — the reader has scrolled past the first one
    // — so a gap has to restore it. A Set would hide it forever.
    //
    // Reset per ASSET by living inside this loop: two assets sharing a note each
    // show it once, which is right because they are separate sections a reader
    // may not read in order.
    let prevNote = null;
    let prevProvenance = null;
    for (const field of asset.fields) {
      const group = field.groupLabel || null;
      if (group !== openGroup) {
        if (group) b.groupLabel(group);
        openGroup = group;
      }
      const note = field.specNote != null ? String(field.specNote).trim() : '';
      const suppressNote = !!note && note === prevNote && SHOW_ONCE_NOTES.has(note);
      prevNote = note || null;
      // THE RUN KEY, and the third place this codebase applies the same rule:
      // a repetition collapses over ADJACENT members and a gap restores it.
      // Here the members are fields whose provenance is identical, so the
      // boilerplate half of the tier line and the verification sentence say
      // nothing the field above did not already say.
      //
      // THE DATE IS IN THE KEY AND IT IS THE PART THAT MATTERS. specReview's
      // commitReview stamps `spec_verified_at = NOW()` in ONE UPDATE PER FIELD,
      // so two fields on one asset diverge the moment a flag is approved for one
      // and not the other. A field whose date differs is not in the run, so it
      // restores its own full line — the rule handling its own hard case rather
      // than an exception being written for it.
      //
      // A house_default or tenant-authored field names no source, so its key is
      // null and it BREAKS the run, exactly as a different note breaks the
      // show-once note run. On both carousels that is what splits Card 1 from
      // Cards 2-5.
      const provenance = provenanceKey(field);
      const suppressDetail = !!provenance && provenance === prevProvenance;
      prevProvenance = provenance;
      const indent = group ? GROUP_INDENT_PT : 0;
      b.boldLabel(fieldLabel(field), { indent });
      const hint = fieldHint(field, { suppressNote, suppressDetail });
      // A HINT PARAGRAPH IS ALWAYS EMITTED WHEN THERE IS ONE TO EMIT, and
      // suppressDetail never empties it — it keeps the attribution. See the
      // note on parseDoc's italic branch for why "render nothing" is not an
      // option for a field a writer drafts into.
      if (hint) b.fieldNote(hint.text, { indent, links: hint.links });
      b.blankLine({ indent });
    }
  }
}

// Creates the formatted Google Doc in the target Drive folder.
// `assetSpecs` is the grouped asset library from Postgres (pipeline's
// tenantAssetsToSpecs). `folderId` overrides the default folder when present;
// `referenceLinks` adds a Reference Materials section. `headerSchema` (optional,
// resolved per-tenant in the pipeline) renders a custom top-of-doc metadata
// header via DocBuilder.renderHeader(); when absent/invalid the doc uses today's
// exact default header (title + HR) unchanged. Returns { id, url, title }.
async function createDocument({
  brief,
  campaignTitle,
  summary,
  writerPrompt,
  assetSpecs,
  folderId,
  referenceLinks = [],
  referenceInsights = [],
  headerSchema = null,
  namingPattern = null,
  namingContext = null,
  clients,
}) {
  logMemory(`createDocument start — ${assetSpecs.length} asset(s), ${referenceLinks.length} link(s)`);
  // Diagnostic (counts only, never content): a missing Reference Materials /
  // Reference Insights section traces back to one of these being 0 here.
  console.log(
    `[googleDocs] createDocument references → links=${(referenceLinks || []).length} insights=${(referenceInsights || []).length}`
  );
  const activeClients = clients || (await getClients());
  const { drive, docs } = activeClients;
  const title = makeTitle(brief, campaignTitle, namingPattern, namingContext);
  console.log(`[googleDocs] doc name: ${isValidNamingPattern(namingPattern) ? 'tenant pattern' : 'default'}`);

  // Same placement rule as the project folder: explicit folder wins; otherwise an
  // OAuth user's doc lands in their My Drive root (parents omitted), and only the
  // quota-less service account falls back to config.DRIVE_FOLDER_ID.
  const parentFolder = folderId || (activeClients.usingOAuth ? null : config.DRIVE_FOLDER_ID);
  const created = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      ...(parentFolder ? { parents: [parentFolder] } : {}),
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const docId = created.data.id;

  // Resolve reference link labels (Drive file names where possible) up front.
  const resolvedLinks = [];
  for (const url of referenceLinks) {
    resolvedLinks.push(await resolveLinkLabel(drive, url));
  }

  const bodyFields = { summary, writerPrompt, resolvedLinks, referenceInsights, assetSpecs };
  const useSchema = isValidHeaderSchema(headerSchema);
  console.log(`[googleDocs] doc header: ${useSchema ? 'tenant schema' : 'default (title + HR)'}`);

  // Build the header. With a stored schema, DocBuilder.renderHeader() lays out its
  // blocks; otherwise the default is today's exact header (title + HR) — byte-for-
  // byte unchanged for existing tenants (the critical safety property).
  const b = new DocBuilder();
  if (useSchema) {
    b.renderHeader(headerSchema);
  } else {
    b.title(title);
    b.horizontalRule();
  }

  if (b.hasHeaderTable()) {
    // Two-phase table header (a Docs table can't be built in one batchUpdate —
    // see docHeaderTable.js). Insert the table, re-read to locate/fill it, then
    // render the body BELOW it starting at the table's post-fill end index.
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.headerTableInsertRequests() },
    });

    let reread = (await docs.documents.get({ documentId: docId })).data;
    let tableEl = findHeaderTable(reread);
    if (!tableEl) throw new Error('header table not found after insert');
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.headerTableFillRequests(tableEl) },
    });

    reread = (await docs.documents.get({ documentId: docId })).data;
    tableEl = findHeaderTable(reread);
    const body = new DocBuilder(tableEl.endIndex);
    appendBody(body, bodyFields);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: body.buildRequests() },
    });
  } else {
    // No table anywhere — header + body fold into a single batchUpdate.
    appendBody(b, bodyFields);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.buildRequests() },
    });
  }

  // webViewLink is REQUESTED, not guaranteed. A files.create response that omits
  // it used to end here as `url: undefined`, which generateDoc records as
  // projects.copy_doc_url = null — an id pointing at a real document in Drive
  // that the row cannot link to. createFromTemplate has always defended against
  // this on the same API call; the copy doc had no reason to be the exception.
  // The link is derivable from the id, so there is nothing to lose by deriving it.
  const url = created.data.webViewLink || `https://docs.google.com/document/d/${docId}/edit`;
  return { id: docId, url, title };
}

// --- Draft generation (stateless: re-parses the doc) ---

function runStyle(paragraph) {
  const el = (paragraph.elements || []).find(
    (e) => e.textRun && e.textRun.content && e.textRun.content.trim()
  );
  const ts = el?.textRun?.textStyle || {};
  return { bold: !!ts.bold, italic: !!ts.italic };
}

function paragraphText(paragraph) {
  return (paragraph.elements || [])
    .map((e) => (e.textRun ? e.textRun.content : ''))
    .join('')
    .replace(/\n+$/, '');
}

// The same concatenation paragraphText produces, plus the ABSOLUTE document index
// of every character in it. Untrimmed, deliberately — trimming would shift every
// offset and the whole point of this is that an offset maps back to a real index.
//
// WHY A PER-CHARACTER MAP RATHER THAN ARITHMETIC ON THE PARAGRAPH START. A
// paragraph is a list of textRun elements and a label is not guaranteed to be one
// run: Docs splits a run wherever a style changes, and anything that has ever
// touched a label (a writer selecting part of it, a suggestion being accepted)
// leaves it in pieces. Walking the elements and taking each one's own startIndex
// is correct whether the label is one run or six; assuming contiguity from the
// paragraph's startIndex is correct only in the first case, and wrong silently in
// the second — it would delete the wrong characters.
//
// Returns null when any element lacks a startIndex, which is the honest answer
// for a paragraph nothing can safely edit.
function paragraphCharIndex(paragraph) {
  const map = [];
  let raw = '';
  for (const e of paragraph.elements || []) {
    const content = e.textRun ? e.textRun.content : null;
    if (content == null) continue;
    const base = Number(e.startIndex);
    if (!Number.isFinite(base)) return null;
    for (let i = 0; i < content.length; i += 1) {
      map.push(base + i);
      raw += content[i];
    }
  }
  return raw ? { raw, map } : null;
}

// The [ ... ] at the END of a label paragraph, as an absolute document range.
//
// Anchored to the end (allowing only trailing whitespace and the paragraph's own
// newline after it) because that is where fieldLabel puts it, and because a field
// NAME may legitimately contain brackets — "Headline (Offer 1) [50]" is a real
// seeded field and a first-match search would find nothing, but an unanchored
// last-match search over a name like "CTA [beta] [20]" has to take the last one.
// Anchoring is what makes "the bracket" unambiguous.
//
// The returned range EXCLUDES the trailing whitespace, so replacing it leaves the
// paragraph's newline and any spacing exactly as it was.
const LABEL_BRACKET_AT_END = /\[[^\]]*\][ \t\r\n]*$/;

// The span a trailing-anchored pattern matches, as an absolute document range.
//
// ONE implementation for two callers — the label's bracket and the hint line's
// provenance clause. They ask the identical question of two different paragraphs,
// and the part worth not writing twice is the contiguity guard: contiguity is not
// assumed by paragraphCharIndex, but it IS required for a single delete range. A
// span split across runs that are not adjacent in the document cannot be
// expressed as one range, and silently deleting from the first character to the
// last would take whatever sits between them with it.
//
// Returns null — "do not touch this paragraph" — for every failure: no character
// map, no match, an empty match, or a non-contiguous one. Never an index of 0,
// which would be a valid-looking range at the top of the document.
function trailingRange(paragraph, pattern) {
  const idx = paragraphCharIndex(paragraph);
  if (!idx) return null;
  const m = idx.raw.match(pattern);
  if (!m) return null;
  const start = m.index;
  // The range EXCLUDES trailing whitespace, so replacing it leaves the
  // paragraph's newline and any spacing exactly as it was.
  const text = m[0].replace(/[ \t\r\n]+$/, '');
  const end = start + text.length;
  if (!text || idx.map[start] == null || idx.map[end - 1] == null) return null;
  if (idx.map[end - 1] - idx.map[start] !== text.length - 1) return null;
  return { start: idx.map[start], end: idx.map[end - 1] + 1, text };
}

function labelBracketRange(paragraph) {
  return trailingRange(paragraph, LABEL_BRACKET_AT_END);
}

// The provenance clause at the end of a hint paragraph, or null when the field
// carries none — which is the common case and MUST stay distinguishable from a
// clause at index 0. A field that never had provenance gets no sentence written
// to it; see correctFieldBrackets.
function noteProvenanceRange(paragraph) {
  return trailingRange(paragraph, PROVENANCE_AT_END);
}

// Walks the document and reconstructs the campaign context needed to draft copy.
//
// REFERENCE INSIGHTS ARE RECOVERED FROM THE DOC, NOT FROM THE PROJECT ROW — the
// opposite of the decision taken for `brief_raw`, and the two cases genuinely
// differ rather than one being inconsistent with the other.
//
// The brief went on the project row because a Docs round-trip is lossy for the
// one value whose exactness is the product claim, and because parseDoc takes
// only the FIRST paragraph after a HEADING_2, so a multi-paragraph brief needed
// a parser change. Neither applies here. A stat is already a model extraction of
// at most ten words, already rendered as its own bullet, and a bullet list
// round-trips exactly.
//
// And the difference that decides it: a figure here is REPORTED, never verified,
// and cannot be — the raw reference content is used once for the enrich call and
// never persisted, so by draft time there is nothing to check against. Reading
// them back out of the doc means the only check available is the one that
// actually exists: the human looking at the page. A wrong number can be deleted
// from Reference Insights before Generate First Draft is pressed, and it will
// not reach the prompt. On the project row it would be unreachable.
//
// The cost, recorded rather than discovered later: a source that yielded no
// stats still renders its "From:" line, but a run where the enrich pass returned
// NO insights at all (references read, zero produced — pipeline.js already warns
// about it) leaves no section, so `enrichedFromReferences` reads false and the
// prompt keeps the wording it has today. That is the status quo, not a
// regression, and it is the only case where the flag understates.
function parseDoc(doc) {
  const summary = { value: '' };
  const writer = { value: '' };
  const assets = [];
  // Figures from the Reference Insights section: [{ text, source }]. Key
  // messages are deliberately NOT collected — see the note on the branch below.
  const referenceStats = [];
  let enrichedFromReferences = false;
  let inInsights = false;
  let insightSource = null;
  let insightStats = false; // inside a source's "Stats:" run, vs "Key messages:"
  let current = null;
  let currentField = null; // last field whose copy region we're scanning
  let notesSeen = false; // whether the current field's italic notes line was seen
  let expecting = null; // 'summary' | 'writerPrompt'
  const assetOrdinal = instanceCounter(); // per-heading-text instance ordinals
  // Which HEADING_3s are instance-suffixed (needs every heading, hence a pre-pass).
  const instanceHeadings = instanceHeadingMap(assetHeadingTexts(doc));

  for (const item of doc.body.content || []) {
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = p.paragraphStyle?.namedStyleType;
    const text = paragraphText(p).trim();
    const { bold, italic } = runStyle(p);

    if (named === 'HEADING_2' && text === 'Campaign Summary') {
      expecting = 'summary';
      continue;
    }
    if (named === 'HEADING_2' && text === 'Writer Direction') {
      expecting = 'writerPrompt';
      continue;
    }
    if (expecting === 'summary') {
      if (text) {
        summary.value = text;
        expecting = null;
      }
      continue;
    }
    if (expecting === 'writerPrompt') {
      if (text) {
        writer.value = text;
        expecting = null;
      }
      continue;
    }

    // Any OTHER HEADING_2 ends whatever section we were in and starts the next.
    // Reference Insights is the only one whose contents we read; Reference
    // Materials (the link list) and anything a writer adds by hand fall through
    // to `inInsights = false`, which is what keeps their paragraphs out of both
    // the stat list and the field scan below.
    if (named === 'HEADING_2') {
      inInsights = text === 'Reference Insights';
      if (inInsights) enrichedFromReferences = true;
      insightSource = null;
      insightStats = false;
      if (inInsights) continue;
    }

    if (named === 'HEADING_3') {
      inInsights = false;
      // `assetType` is always the LIBRARY name, never the rendered heading: an
      // instance-suffixed heading is decomposed back so downstream lookups
      // (asset_direction, craft slicing, the tenant library) keep matching on the
      // real name. `instance` is 0-based — from the heading's own ordinal when it
      // carries one, else counted positionally over repeated heading text (a
      // hand-pasted duplicate section, which has no suffix to read).
      const parts = instanceHeadings.get(text);
      current = parts
        ? { assetType: parts.assetType, instance: parts.instance, instanceLabel: parts.instanceLabel,
            channel: '', toneNotes: '', fields: [], gotMeta: false }
        : { assetType: text, instance: assetOrdinal(text), instanceLabel: null,
            channel: '', toneNotes: '', fields: [], gotMeta: false };
      assets.push(current);
      currentField = null; // a new asset ends the previous field's copy region
      notesSeen = false;
      continue;
    }

    // Inside Reference Insights. appendBody lays each source out as an italic
    // "From: <source> (<type>)" line, then optional "Stats:" and "Key messages:"
    // label lines each followed by their bullets. Matching the LABEL lines and
    // tracking which run we are in is what separates the two lists; a bullet
    // carries nothing that distinguishes it from the other kind.
    //
    // ONLY STATS ARE COLLECTED. Key messages are a source's positioning
    // compressed to headline length — for a competitor page, the competitor's
    // own copy — and the drafter has no way to tell one source's kind from
    // another's, because `type` records the file format and nothing records the
    // purpose. The enrich pass has already had the full source text and an
    // explicit instruction to pull competitive framing, and its considered
    // extract is the one "Competitive Framing:" line in the writer direction.
    // That is the controlled channel; this would be the uncontrolled one beside
    // it. They stay in the doc, where the human reading them is informed rather
    // than primed.
    if (inInsights) {
      if (!text) continue;
      const from = text.match(/^From:\s*(.*?)\s*(?:\(([^()]*)\))?$/);
      if (from) {
        insightSource = (from[1] || '').trim() || null;
        insightStats = false;
        continue;
      }
      if (/^stats:$/i.test(text)) {
        insightStats = true;
        continue;
      }
      if (/^key messages:$/i.test(text)) {
        insightStats = false;
        continue;
      }
      if (insightStats) referenceStats.push({ text, source: insightSource });
      continue;
    }

    // A group sub-heading (e.g. "Graphic Copy", rendered HEADING_4) is a layout
    // label, not a field — skip it. It ends the previous field's copy region so
    // the heading is never mistaken for drafted copy.
    if (named === 'HEADING_4') {
      currentField = null;
      notesSeen = false;
      continue;
    }

    // Riff batch header (Variations Matrix, Step 3) — a faint HEADING_6 divider
    // above an appended variation batch ("Riff 1", "Riff 2", …). The named-style
    // check fires BEFORE the bold-label and copy branches below, so the header is
    // structurally NEVER read as a field label or a copy option (the guard is the
    // paragraph style, not its text). It deliberately does NOT reset currentField:
    // the field's copy region spans it, so a destructive Regenerate's single
    // [insertIndex, deleteEnd] range still covers the whole stack, headers
    // included. Record the batch number so a re-riff computes max+1 — gap-safe
    // (if a middle batch was deleted, max+1 still can't collide with a survivor,
    // where counting headers would).
    if (named === 'HEADING_6') {
      const rm = text.match(/^Riff\s+(\d+)/i);
      if (currentField && rm) {
        currentField.maxRiffN = Math.max(currentField.maxRiffN || 0, Number(rm[1]));
      }
      continue;
    }

    if (current && !current.gotMeta && current.fields.length === 0 && italic && text) {
      const parts = text.split('·').map((s) => s.trim());
      current.channel = parts[0] || '';
      current.toneNotes = parts.slice(1).join(' · ');
      current.gotMeta = true;
      continue;
    }

    // A field label is a bold paragraph, optionally ending in a [min-max] /
    // [max] bracket (no bracket when charMax was 0). Recover charMin/charMax.
    if (current && bold && text) {
      const m = text.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
      const fieldName = m ? m[1].trim() : text;
      const bracket = m ? m[2] : '';
      const nums = bracket.match(/\d+/g);
      // The unit rides in the bracket ("[50-125 words]") because nothing about a
      // field is persisted — see WORD_UNIT_SUFFIX. Reading it back here is what
      // keeps the drafter and the reviewer counting the same thing the writer sees.
      const fieldType = /\bwords?\b/i.test(bracket) ? 'words' : 'text';
      let charMin = 0;
      let charMax = 0;
      if (nums) {
        const vals = nums.map(Number);
        charMax = Math.max(...vals);
        if (vals.length >= 2) charMin = Math.min(...vals);
      }
      // WHERE THE LABEL IS, WHICH parseDoc HAS NEVER RECORDED. Every existing
      // consumer needs only where the label ENDS (insertIndex) and where the
      // copy under it ends (deleteEnd) — the regeneration delete range spans
      // exactly that and must never reach a label. The sweep is the first caller
      // that edits INSIDE one, so it needs the label's own extent and the exact
      // range of its bracket. Additive: nothing below reads these.
      const bracketRange = labelBracketRange(p);
      currentField = {
        fieldName,
        charMin,
        charMax,
        fieldType,
        labelStart: item.startIndex,
        labelEnd: item.endIndex,
        // null when the label has no bracket (charMax was 0 at build time), or
        // when the paragraph cannot be safely edited — a caller must treat null
        // as "do not touch this label" rather than as an index of 0.
        bracketStart: bracketRange ? bracketRange.start : null,
        bracketEnd: bracketRange ? bracketRange.end : null,
        bracketText: bracketRange ? bracketRange.text : null,
        // The blank paragraph immediately after the label starts where this
        // label paragraph ends; that's our draft insertion point (moved past the
        // notes line below when one is present).
        insertIndex: item.endIndex,
        // End of the last non-empty paragraph of already-drafted copy under this
        // label (null = nothing drafted yet). Drives delete-before-insert on
        // regeneration; stays null for a first draft so that path is untouched.
        deleteEnd: null,
        notes: '',
        // WHERE THE HINT PARAGRAPH IS. `notes` has always kept the paragraph's
        // TEXT and thrown its position away, which was enough while nothing edited
        // inside it. Set by the notes branch below; null when the field has no
        // hint line at all.
        //
        // noteStart/noteEnd are the paragraph's own extent, the sibling of
        // labelStart/labelEnd. Nothing reads them today — the sweep edits the
        // provenance SUB-RANGE, never the whole paragraph, because the paragraph
        // carries the citation hyperlink and replacing it would drop the link.
        noteStart: null,
        noteEnd: null,
        // The provenance clause's own range, and the text found there. null on a
        // field that never carried one — which a caller must read as "write
        // nothing", not as an index of 0.
        provenanceStart: null,
        provenanceEnd: null,
        provenanceText: null,
        // Highest "Riff N" batch number seen under this field (0 = none). Drives
        // the next append batch's number (max+1). Set by the HEADING_6 branch.
        maxRiffN: 0,
      };
      current.fields.push(currentField);
      notesSeen = false;
      continue;
    }

    // Per-field writing guidance: the italic paragraph right after a label,
    // before any drafted copy (which is always inserted non-italic). It's
    // permanent guidance — never copy, never deleted. Copy goes BELOW it, so
    // advance the insertion point past the notes line.
    if (current && currentField && currentField.deleteEnd == null && !notesSeen && italic && text) {
      notesSeen = true;
      // STRIPPED, not stored raw. `notes` is prompt input and nothing else — it
      // becomes this field's `Field guidance:` (services/gemini.js
      // fieldGuidanceFor). The house-default sentence is the one part of the
      // italic line addressed to the TENANT rather than to the writer: "set your
      // own in Settings" is not a fact about how to write the copy, and on 144
      // seeded fields it would be the only guidance most of them carry.
      //
      // Stripped HERE, in the same module that composes it, so there is no
      // string shared across a module boundary and no import for gemini.js to
      // grow (it is already required by this file — the other direction would be
      // a cycle). The doc still shows the line; the drafter never sees it.
      currentField.notes = stripReaderOnlyLines(text);
      currentField.noteStart = item.startIndex;
      currentField.noteEnd = item.endIndex;
      // Computed from the paragraph, not from `notes` — `notes` is the STRIPPED
      // text and the clause is the first thing the strip removes, so an offset
      // into it would locate nothing.
      const prov = noteProvenanceRange(p);
      currentField.provenanceStart = prov ? prov.start : null;
      currentField.provenanceEnd = prov ? prov.end : null;
      currentField.provenanceText = prov ? prov.text : null;
      currentField.insertIndex = item.endIndex;
      continue;
    }

    // Any other non-empty paragraph under an active field is previously drafted
    // copy. Advance deleteEnd to this paragraph's end; trailing blank lines have
    // empty text and never reach here, so the template blank is preserved.
    if (current && currentField && text) {
      currentField.deleteEnd = item.endIndex;
      continue;
    }
  }

  // The two new keys are ADDITIVE. Every existing caller destructures
  // { summary, writerPrompt, assets } and is unaffected by their presence.
  return {
    summary: summary.value,
    writerPrompt: writer.value,
    assets,
    referenceStats,
    enrichedFromReferences,
  };
}

// Lookup key for matching a doc field back to its Sheet row.
//
// `instance` is the asset's 0-based instance ordinal, for a doc carrying the same
// asset more than once. It defaults to 0, which serializes to nothing at all —
// `ctxKey(a, f)` and `ctxKey(a, f, 0)` are byte-identical to each other and to
// the pre-instance key (see utils/instanceKey.js for why that matters).
function ctxKey(assetType, fieldName, instance) {
  return `${String(assetType).trim().toLowerCase()}${instanceTag(instance)}|${String(fieldName).trim().toLowerCase()}`;
}

// Normalize a scoped field's variation controls into one of two shapes:
//   { matrix: [{ doorway, intensity, count }] }  — Variations Matrix (Step 3):
//       explicit per-angle rows. Angle must be a known doorway; count capped 1–5;
//       intensity a known Safe/Bold/Wild (default Safe). Invalid rows are dropped.
//   { count, distance }                          — legacy Phase 2/3 controls.
// A valid matrix WINS (assignDoorways is bypassed downstream). This is the single
// place matrix input is validated, so the route can pass rows through loosely.
function normalizeVarControls(t) {
  const rows = Array.isArray(t.variations) ? t.variations : null;
  if (rows && rows.length) {
    const matrix = [];
    for (const r of rows) {
      const angle = r && ANGLE_NAMES.has(String(r.angle)) ? String(r.angle) : null;
      if (!angle) continue;
      const count = Math.max(1, Math.min(10, Number(r.count) || 1));
      const intensity = r && INTENSITY_NAMES.has(String(r.intensity)) ? String(r.intensity) : 'Safe';
      matrix.push({ doorway: angle, intensity, count });
    }
    if (matrix.length) return { matrix };
  }
  return {
    count: Math.max(1, Math.min(4, Number(t.count) || 1)),
    distance: t.distance === 'explore' || t.distance === 'wide' ? t.distance : 'close',
  };
}

// Assemble N variations into the single copy block inserted under a field label.
// Two independent markers: a NUMBER appears iff there's more than one option (a
// stack to resolve between); a (Doorway) LABEL appears iff a non-'close' distance
// was chosen (a meaningful door to name). So:
//   close  ×1  → `copy`                     (bare — identical to a Phase-1 draft)
//   wide   ×1  → `(Reframe) copy`           (labeled, no number — already resolved)
//   close  ×N  → `1. copy` / `2. copy`      (numbered, one obvious door, no labels)
//   wide   ×N  → `1. (Pain) copy` / `2. …`  (numbered + labeled stack)
// Inserted bold:false/italic:false by the caller, so markers parse as copy — not
// labels or notes. Long fields separate stacked options with a blank line.
//
// `startIndex` (append writes only): when given, the block is FORCE-numbered from
// that base — even a single option gets its number, so an appended batch always
// reads as a numbered group. Omitted → today's behavior exactly (numbered iff the
// batch has >1 option, base 1).
function buildVariantBlock(variations, { distance, charMax, fieldType, startIndex, labeled } = {}) {
  const list = (variations || []).filter((v) => v && String(v.copy || '').trim());
  if (list.length === 0) return '';
  const numbered = startIndex != null ? true : list.length > 1;
  const base = startIndex != null ? startIndex : 1;
  // `labeled` (Step 3) forces the (Doorway) tag on regardless of distance — the
  // append/matrix path always labels so every riffed option carries its angle.
  // When omitted, fall back to the legacy rule (label iff a non-'close' distance).
  const labelOn = labeled != null ? labeled : Boolean(distance && distance !== 'close');
  // Layout heuristic: short fields (headlines, CTAs) stack on one line each; long
  // ones get their own block. 120 is a CHARACTER threshold — a 125-WORD body field
  // would sail under it and be laid out as if it were a headline, so a word field is
  // always long. (No word field is short: the smallest band here is 25 words.)
  const longField = fieldType === 'words' || !(Number(charMax) > 0 && Number(charMax) <= 120);
  const lines = list.map((v, i) => {
    let prefix = '';
    if (numbered) prefix += `${base + i}. `;
    if (labelOn && v.doorway) prefix += `(${v.doorway}) `;
    return prefix + String(v.copy).trim();
  });
  return lines.join(numbered && longField ? '\n\n' : '\n');
}

// Character-ceiling enforcement for the insert/append path (riff, Explore,
// matrix) — runs on each variation's COPY, before buildVariantBlock adds its
// "N. " / "(Doorway) " prefix.
//
// THE PREFIX IS NOT MEASURED, DELIBERATELY. utils/variants.js already answers
// this for the review path: a numbered stack is explicitly UNRESOLVED — "the
// writer has yet to pick one" — and a solo remaining option's doorway tag is
// "strategy metadata, not copy," stripped by stripSoloLabel() before that
// path's own length check. Nothing here ever ships "3. (Proof) " to a
// platform; the writer deletes down to one option and drops the tag first. So
// each option is checked against the FULL charMax, not charMax minus the
// prefix — charging the prefix against the ceiling would ship copy shorter
// than the platform allows, for a prefix that never spends any of that budget.
//
// THE LADDER ITSELF IS REUSED, NOT REIMPLEMENTED: overLimit/trimCeiling do the
// measuring, generateFieldDraft (same function the draft path calls) performs
// the corrective rewrite — its own internal ladder re-measures and re-trims on
// the way back — and trimToCeiling is the outer unconditional backstop for the
// one case that call can't self-heal: the rewrite request itself throwing
// (timeout/rate-limit), which leaves `copy` as the original overflow. Same
// belt-and-braces shape generateFieldVariations already uses at its own
// fallback, for the same reason.
//
// Character fields only — trimCeiling returns null for a word field, so this
// returns `variations` untouched.
async function enforceVariationCeiling(variations, { charMax, fieldType, regen }) {
  const ceiling = trimCeiling(charMax, fieldType);
  if (!ceiling) return variations || [];

  const out = [];
  for (const v of variations || []) {
    if (!v || !v.copy) {
      out.push(v);
      continue;
    }
    let copy = v.copy;
    if (overLimit(copy, charMax, fieldType)) {
      try {
        copy = await generateFieldDraft({
          ...regen,
          direction: [
            regen.direction,
            `Your previous draft of this option was ${copy.length} characters — too long. Rewrite it as a ` +
              `COMPLETE, self-contained thought that fits within ${ceiling} characters, preserving the meaning and tone.`,
          ]
            .filter(Boolean)
            .join('. '),
          currentCopy: copy,
        });
      } catch (err) {
        console.warn(
          `[googleDocs] variation corrective rewrite failed for ${regen.fieldName} ` +
            `(${describeLength(copy, charMax, fieldType)}): ${err.message}`
        );
      }
      // Unconditional — fires whether the rewrite above succeeded, came back
      // still long, or threw and left `copy` as the original overflow.
      if (copy && copy.length > ceiling) copy = trimToCeiling(copy, ceiling);
    }
    out.push(copy ? { ...v, copy } : v);
  }
  return out;
}

// Document-order ordinals for every parsed field — the Nth field in the
// document, counted across assets in parse order.
//
// THIS IS THE IDENTITY THAT SURVIVES PHASE 1, and it is needed because
// insertIndex does not. insertIndex uniquely identifies a field within ONE
// parse, which is exactly what the delete ranges are built from; but the delete
// pass shifts every index below its first deletion, so it cannot carry across to
// the re-parse. Nothing else on a parsed field can either: fieldName is the
// label with its bracket stripped and repeats, and charMin/charMax/fieldType/
// notes repeat more easily still.
//
// Position survives, and only because of what Phase 1 removes. Every delete
// range runs from just after a label to the end of that field's last copy
// paragraph, so it takes COPY and nothing else — never a label, never a heading.
// The cleaned document therefore carries the same labels under the same headings
// in the same order, and the Nth field of the fresh parse is the Nth field of
// the original. If that ever stops being true — a delete that can remove a label
// — this mapping breaks silently, which is why the count is checked at the call
// site rather than assumed.
function fieldOrdinals(assets) {
  const ordinalOf = new Map(); // insertIndex -> ordinal
  const insertIndexAt = []; // ordinal -> insertIndex
  for (const asset of assets || []) {
    for (const f of asset.fields || []) {
      ordinalOf.set(f.insertIndex, insertIndexAt.length);
      insertIndexAt.push(f.insertIndex);
    }
  }
  return { ordinalOf, insertIndexAt, count: insertIndexAt.length };
}

// Throw rather than issue a delete batch whose ranges overlap.
//
// `deletions` arrives sorted bottom-to-top; this sorts a COPY ascending because
// overlap is a statement about the ranges, not about the order they are sent in,
// and checking neighbours in ascending order is what makes one pass sufficient.
// Ranges are half-open [start, end), so `next.start === prev.end` is two
// adjacent regions and fine; only `next.start < prev.end` is an overlap. Two
// identical ranges — the duplicate-delete defect — trip it, because the second's
// start is strictly inside the first.
//
// The message names both fields and both ranges: the whole point is that a
// person sees WHICH two fields collided, since the failure it replaces was a
// document quietly losing a label.
function assertDisjointDeletes(deletions) {
  const sorted = [...deletions].sort((a, b) => a.insertIndex - b.insertIndex);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.insertIndex < prev.deleteEnd) {
      const name = (d) => `${d.assetType || '?'} / ${d.fieldName || '?'}`;
      throw new Error(
        'Draft aborted before writing: two fields resolved to overlapping delete ranges — ' +
          `[${prev.insertIndex}, ${prev.deleteEnd}) for ${name(prev)} and ` +
          `[${cur.insertIndex}, ${cur.deleteEnd}) for ${name(cur)}. ` +
          'The document was NOT modified. Applying both would delete content the first ' +
          'delete had already moved, which cuts through whatever now sits at those indices.'
      );
    }
  }
}

// Reads the doc, drafts copy for every field via Gemini, and inserts it under
// each label. Returns { title, fieldCount, fieldsAttempted, failureReason, url }.
// `fieldCount` is what was WRITTEN and `fieldsAttempted` is what was tried, so a
// surface can tell "40 of 40" from "1 of 40"; `failureReason` is the one shared
// sentence naming why the rest are blank, or null when nothing failed.
// `brief` is the client's own words off the project row (pipeline.generateDraft).
// Null for a pre-migration project, a doc with no project row, or no tenant — and
// null is the whole degradation: gemini's briefBlock emits nothing and the prompt
// is what it was before. The doc is still the source for summary and writerPrompt;
// this is the ONE value that could not live there (see
// scripts/migrateAddProjectBriefRaw.js for why not).
async function generateDraft(id, direction, clients, voiceGuide, lookupDirection, scopedFields, append, brief) {
  const { docs } = clients || (await getClients());

  const doc = (await docs.documents.get({ documentId: id })).data;
  // `referenceStats` / `enrichedFromReferences` come off the same parse — the
  // doc IS the store for both (see parseDoc). A doc with no Reference Insights
  // section yields [] and false, and every prompt below is then byte-identical
  // to what it was.
  const { summary, writerPrompt, assets, referenceStats, enrichedFromReferences } = parseDoc(doc);
  console.log(
    `[googleDocs] draft references → enriched=${enrichedFromReferences} stats=${referenceStats.length}`
  );

  // SCOPED generation/regeneration: when `scopedFields` (a list of {assetType,
  // fieldName}) is present, draft ONLY those fields. Everything else — header,
  // other assets, and unselected fields — never enters the delete/insert lists,
  // so no deleteContentRange, insertText, or updateTextStyle touches them and
  // they stay BYTE-IDENTICAL. Absent/empty → whole-doc behavior, exactly as
  // before (backward-compatible). Matching is case-insensitive via ctxKey.
  // (Named scopedFields, not `targets`, to avoid colliding with `assetTargets`.)
  const scopeKeys =
    Array.isArray(scopedFields) && scopedFields.length > 0
      ? new Set(scopedFields.map((t) => ctxKey(t.assetType, t.fieldName, t.instance)))
      : null;

  // ADDITIVE (append) write — Variations Matrix Step 1. When `append` is set on a
  // SCOPED call, each selected field's new batch is inserted BELOW its current
  // copy (numbered from 1) and NOTHING is deleted. The no-delete guarantee is in
  // the data: append fields are pushed with deleteEnd:null, so they can't enter
  // the deletions filter below. Append is scoped-only (whole-doc append is not a
  // Step-1 concern); a stray append without scope degrades to normal behavior.
  const appendMode = !!(append && scopeKeys);
  if (append && !scopeKeys) {
    console.warn('[googleDocs] append requested without scopedFields — ignoring (whole-doc runs normally)');
  }

  // Per-field variation controls (Phase 2/3): count (how many options) and
  // distance (which doorways are eligible). Absent → count 1 / 'close', which
  // routes to the unchanged Phase-1 per-field path. Keyed by ctxKey.
  const scopeMeta = new Map();
  if (scopeKeys) {
    for (const t of scopedFields) {
      scopeMeta.set(ctxKey(t.assetType, t.fieldName, t.instance), normalizeVarControls(t));
    }
  }

  // Build per-asset draft targets straight from the doc. The Google Sheet has
  // been retired — per-field Notes / Funnel Stage / channel / tone no longer
  // feed the prompt; asset-level direction (from Postgres) carries the creative
  // guidance, and the doc carries field labels + char limits + positions.
  //
  // The instance ordinal is taken from parseDoc, which stamps it per HEADING_3 in
  // document order. Reading it (rather than re-counting here) is what makes it
  // agree with the post-delete re-parse below — no loop has to be careful to
  // count the same headings, because there is one ordinal per parsed entry.
  const assetTargets = assets
    .filter((asset) => asset.fields.length > 0)
    .map((asset) => ({
      assetType: asset.assetType,
      instance: asset.instance,
      assetDirection: lookupDirection ? lookupDirection(asset.assetType) : null,
      fields: asset.fields.map((field) => ({
        fieldName: field.fieldName,
        charMax: field.charMax || 0,
        charMin: field.charMin || 0,
        // Unit, recovered from the label bracket by parseDoc. Without it the draft
        // prompt tells the model "Character limit: 125" for a 125-WORD field.
        fieldType: field.fieldType === 'words' ? 'words' : 'text',
        insertIndex: field.insertIndex,
        deleteEnd: field.deleteEnd,
        // THE FIELD'S OWN GUIDANCE, WHICH THIS MAPPING USED TO DROP. parseDoc
        // recovers the italic line into `notes` and this rebuild silently left it
        // behind, so the gemini-side field-guidance composer got undefined on every
        // copy-doc draft — no tenant spec_note, no seeded note, nothing. Only
        // builtInFieldGuidance ever fired, because it keys on the field NAME.
        //
        // It went unnoticed because the A/B that proved the mechanism called
        // generateAssetDrafts DIRECTLY with notes, so the measurement was clean
        // and the wire between it and production was not.
        notes: field.notes || '',
        // Highest existing "Riff N" batch number under this field (append uses +1).
        maxRiffN: field.maxRiffN || 0,
      })),
    }))
    // Scoped: drop assets with no selected field so we don't even iterate them.
    .filter((a) => !scopeKeys || a.fields.some((f) => scopeKeys.has(ctxKey(a.assetType, f.fieldName, a.instance))));

  // Scoped drafts per field (not the cohesive whole-asset batch), so read the
  // current copy of every field once to feed each field its siblings' copy as
  // context (cohesion recovery). Best-effort — a read failure just omits siblings.
  let copyByKey = null;
  if (scopeKeys) {
    try {
      const content = await getDocContent(id, clients);
      copyByKey = new Map();
      // getDocContent stamps the same per-HEADING_3 ordinal parseDoc does, so
      // these keys line up with assetTargets' without a second count.
      for (const a of content.assets || []) {
        for (const f of a.fields || []) copyByKey.set(ctxKey(a.name, f.fieldName, a.instance), String(f.copy || ''));
      }
    } catch (err) {
      console.warn('[googleDocs] scoped sibling-copy read failed (continuing without):', err.message);
      copyByKey = new Map();
    }
  }

  // Draft each asset's fields together (one batched call per asset) so the copy
  // is cohesive. Assets run with bounded concurrency; one asset failing is
  // logged and skipped rather than aborting the whole run.
  const total = assetTargets.length;
  logMemory(`generateDraft start — ${total} asset(s), concurrency ${DRAFT_CONCURRENCY}${scopeKeys ? ', scoped' : ''}`);

  // THE DENOMINATOR. `fieldCount` has always been the number of fields WRITTEN,
  // reported with no total beside it — so a run that drafted one field of forty
  // said "1 field drafted" on a card headed "First draft ready", which is a true
  // number under a false claim. Counted the same way the loop below decides what
  // to draft: scoped runs attempt only their selection.
  const fieldsAttempted = assetTargets.reduce(
    (n, a) =>
      n +
      (scopeKeys
        ? a.fields.filter((f) => scopeKeys.has(ctxKey(a.assetType, f.fieldName, a.instance))).length
        : a.fields.length),
    0
  );

  // Why every field that came back blank did so. Collected rather than returned
  // because the three places a cause appears — a swallowed per-field failure, a
  // scoped per-field catch, and an asset that threw outright — are on three
  // different code paths through the same loop. Pushes are safe: the concurrency
  // is bounded but the runtime is single-threaded.
  const failureKinds = [];

  const perAsset = await mapWithConcurrency(assetTargets, DRAFT_CONCURRENCY, async (a, idx) => {
    const fieldsToDraft = scopeKeys
      ? a.fields.filter((f) => scopeKeys.has(ctxKey(a.assetType, f.fieldName, a.instance)))
      : a.fields;
    if (fieldsToDraft.length === 0) return [];
    console.log(`[googleDocs] generating asset ${idx + 1}/${total}: ${a.assetType} (${fieldsToDraft.length} field(s))`);
    try {
      let drafts;
      if (scopeKeys) {
        // Per-field generation with sibling context — each selected field sees the
        // current copy of its siblings so scoped copy still hangs together.
        drafts = [];
        for (const f of fieldsToDraft) {
          const siblings = a.fields
            .filter((s) => s.fieldName !== f.fieldName)
            .map((s) => ({ fieldName: s.fieldName, copy: (copyByKey.get(ctxKey(a.assetType, s.fieldName, a.instance)) || '').trim() }))
            .filter((s) => s.copy);
          const meta = scopeMeta.get(ctxKey(a.assetType, f.fieldName, a.instance)) || { count: 1, distance: 'close' };
          const hasMatrix = Array.isArray(meta.matrix) && meta.matrix.length > 0;
          const wantsVariations = hasMatrix || meta.count > 1 || meta.distance !== 'close';
          try {
            // Produce the option list (reuse existing generators — no new prompt work).
            let variations;
            if (wantsVariations) {
              // Matrix path (Step 3): expand each row into `count` explicit
              // {doorway, intensity} entries and generate against them directly
              // (assignDoorways bypassed). Legacy path: distance + count.
              let genArgs;
              if (hasMatrix) {
                const rows = [];
                for (const m of meta.matrix) {
                  for (let k = 0; k < m.count; k++) rows.push({ doorway: m.doorway, intensity: m.intensity });
                }
                genArgs = { rows };
              } else {
                genArgs = { distance: meta.distance, count: meta.count };
              }
              variations = await generateFieldVariations({
                assetType: a.assetType,
                fieldName: f.fieldName,
                charMax: f.charMax,
                charMin: f.charMin,
                fieldType: f.fieldType,
                // Same drop, same fix: a scoped redraft was the other path that
                // sent no per-field guidance at all.
                notes: f.notes,
                assetDirection: a.assetDirection,
                summary,
                writerPrompt,
                direction,
                voiceGuide,
                ...genArgs,
                currentCopy: copyByKey.get(ctxKey(a.assetType, f.fieldName, a.instance)) || '',
                siblings,
              });
            } else {
              // Phase-1 path: one bare draft, count 1 / Stay close.
              const c = await generateFieldDraft({
                assetType: a.assetType,
                brief,
                enrichedFromReferences,
                referenceStats,
                fieldName: f.fieldName,
                charMax: f.charMax,
                charMin: f.charMin,
                fieldType: f.fieldType,
                assetDirection: a.assetDirection,
                summary,
                writerPrompt,
                direction,
                voiceGuide,
                siblings,
              });
              variations = c ? [{ doorway: null, copy: c }] : [];
            }

            // Shared by both branches below — append and destructive-replace both
            // read from this same `variations` array, so one enforcement pass
            // before either of them covers both.
            variations = await enforceVariationCeiling(variations, {
              charMax: f.charMax,
              fieldType: f.fieldType,
              regen: {
                assetType: a.assetType,
                brief,
                enrichedFromReferences,
                referenceStats,
                fieldName: f.fieldName,
                charMax: f.charMax,
                charMin: f.charMin,
                fieldType: f.fieldType,
                assetDirection: a.assetDirection,
                summary,
                writerPrompt,
                direction,
                voiceGuide,
                siblings,
              },
            });

            if (appendMode) {
              // ADDITIVE write: number the batch from 1, ALWAYS label each option
              // with its (Doorway), and insert it BELOW the field's current copy
              // (at deleteEnd — the end of the last existing copy paragraph, or
              // insertIndex when the field is empty). deleteEnd is set to null so
              // this field cannot enter the deletions list — existing copy is
              // never touched. The batch is prefaced by a faint "Riff N" header in
              // Phase 2; N = the field's highest existing Riff batch + 1 (max+1).
              // NUMBERED FROM THE FIELD'S HIGHEST EXISTING OPTION, NOT FROM 1.
              //
              // This was a hardcoded `startIndex: 1`, so every appended batch
              // restarted its numbering: three separate riffs on one field wrote
              // "1.", "1.", "1." rather than 1, 2, 3. Within a single batch the
              // numbering was always right, which is why it reads as a display
              // quirk — but it is not only display.
              //
              // The option number is the only thing distinguishing two variations
              // of a field once they are in the document. copyReview parses it
              // back out (utils/variants.parseNumberedStack) and composes the
              // review unit key AND the comment locator from it —
              // `Headline · option 1 (Proof)`. Two options that share a doorway
              // therefore collide on an identical key, so one variation's review
              // comment is reconciled against the other's. Measured: three riffed
              // options, two of them Proof, gave 2 distinct keys instead of 3.
              //
              // MAX, not count, for the same reason maxRiffN uses max: deleting a
              // middle option must not let the next batch reuse a number that a
              // survivor still holds. Read off the field's current copy, which the
              // scoped path already fetched for sibling context — so this needs no
              // change to parseDoc and no new document state.
              const existingCopy = copyByKey.get(ctxKey(a.assetType, f.fieldName, a.instance)) || '';
              const maxOption = parseNumberedStack(existingCopy)
                .reduce((m, o) => Math.max(m, Number(o.index) || 0), 0);
              const block = buildVariantBlock(variations, { charMax: f.charMax, fieldType: f.fieldType, startIndex: maxOption + 1, labeled: true });
              const insertAt = f.deleteEnd != null ? f.deleteEnd : f.insertIndex;
              if (block && insertAt != null) {
                const riffN = (f.maxRiffN || 0) + 1;
                drafts.push({ fieldName: f.fieldName, copy: block, insertIndex: insertAt, deleteEnd: null, riffN });
              }
            } else {
              // Destructive-replace path (unchanged): buildVariantBlock with no
              // startIndex is byte-identical to before (bare for count-1/close).
              // Carries the field's OWN position, like the append branch above and
              // like generateAssetDrafts now does — see the mapping below for why
              // the field NAME cannot be the thing that resolves this.
              const copy = buildVariantBlock(variations, { distance: meta.distance, charMax: f.charMax, fieldType: f.fieldType });
              if (copy) drafts.push({ fieldName: f.fieldName, copy, insertIndex: f.insertIndex, deleteEnd: f.deleteEnd });
            }
          } catch (err) {
            failureKinds.push(geminiErrorKind(err));
            console.warn(`[googleDocs] scoped field failed ${a.assetType}/${f.fieldName}: ${err.message}`);
          }
        }
      } else {
        drafts = await generateAssetDrafts({
          assetType: a.assetType,
          brief,
          enrichedFromReferences,
          referenceStats,
          assetDirection: a.assetDirection,
          summary,
          writerPrompt,
          fields: a.fields,
          direction,
          voiceGuide,
        });
      }
      // generateAssetDrafts swallows every model failure — the batch and the
      // per-field rescue are both caught — so on an outage this returns a full
      // set of empty drafts and the filter below quietly removes them all. The
      // class rides out on the entry; read it BEFORE the filter or it is gone.
      for (const d of drafts) if (d && d.failure) failureKinds.push(d.failure);

      // EVERY DRAFT CARRIES THE POSITION OF THE FIELD IT WAS DRAFTED FOR. There
      // is no name lookup here any more, and that is the fix rather than an
      // optimisation.
      //
      // This used to be `new Map(a.fields.map((f) => [f.fieldName, …]))` — keyed
      // on the field NAME, last wins. The name is the label with its bracket
      // stripped (parseDoc), so "Headline [50]" and "Headline [60]" under one
      // asset are ONE key. Both fields still produced a draft, both resolved to
      // the second field's insertIndex/deleteEnd, and Phase 1 then issued that
      // identical deleteContentRange twice inside a single batchUpdate. The first
      // delete removed the range; the second reused indices computed before it and
      // deleted whatever had slid into them — the following label, its copy, and
      // on a long enough overrun the next asset heading. That is silent: a batch
      // of two identical deletes is a perfectly valid request.
      //
      // insertIndex is a label paragraph's endIndex, so it is distinct for every
      // field in the document without composing anything. Nothing else on the
      // parsed field is unique — fieldName, charMin/charMax, fieldType and notes
      // can all repeat — so this is the identity, not a convenience.
      const mapped = drafts
        .map((d) => ({
          assetType: a.assetType,
          instance: a.instance,
          fieldName: d.fieldName,
          insertIndex: d.insertIndex,
          deleteEnd: d.deleteEnd != null ? d.deleteEnd : null,
          copy: d.copy,
          // Append batches carry their Riff header number (undefined otherwise).
          riffN: d.riffN,
          // Set only by generateAssetDrafts (the whole-doc path) on a word field
          // over its own limit — never on a character field, never on the
          // scoped/riff path (enforceVariationCeiling's producers never set it).
          // Carried through untouched; both are undefined on every other draft.
          unenforced: d.unenforced,
          unenforcedDetail: d.unenforcedDetail,
        }))
        // A draft with no position is DROPPED and named, rather than falling back
        // to a lookup that can put it on top of another field. Nothing produces
        // one today — all three producers set it — so this firing means a fourth
        // has appeared without carrying its field's identity.
        .filter((r) => {
          if (r.insertIndex == null) {
            console.warn(
              `[googleDocs] draft for ${a.assetType} / ${r.fieldName} carries no insertIndex — dropped`
            );
            return false;
          }
          return Boolean(r.copy);
        });
      console.log(`[googleDocs] asset ${idx + 1}/${total} done: ${a.assetType} (${mapped.length} fields)`);
      return mapped;
    } catch (err) {
      failureKinds.push(geminiErrorKind(err));
      console.error(
        `[googleDocs] asset ${idx + 1}/${total} FAILED: ${a.assetType}: ${err.message}`
      );
      return [];
    }
  });
  logMemory(`generateDraft end — ${total} asset(s)`);

  const drafted = perAsset.flat();

  const failureKind = worstGeminiKind(failureKinds);
  // The one sentence both surfaces render. Null when nothing failed — a run that
  // drafted everything must not carry a reason for a shortfall it did not have.
  const failureReason = failureKind ? geminiFailureSentence(failureKind) : null;
  if (failureKind) {
    console.warn(
      `[googleDocs] draft shortfall — ${drafted.length}/${fieldsAttempted} fields, ` +
        `cause=${failureKind} (${failureKinds.length} failure(s))`
    );
  }

  if (fieldsAttempted > 0 && drafted.length === 0) {
    // The classified sentence IS the thrown message, because this string is what
    // both surfaces show: Slack prefixes it with "Draft generation failed", and
    // the web job hands err.message straight to the error box. The old wording —
    // "All field drafts failed (Gemini timeout or error)" — named the two causes
    // it was not on the one occasion it fired, and offered a retry that was
    // guaranteed to fail the same way. No raw response body reaches either
    // surface: the body stays on the per-call error, which is logged.
    throw new Error(failureReason || geminiFailureSentence('unknown'));
  }

  // Regeneration is done in two phases so deletes and inserts never share a
  // batch (interleaving them makes indices very hard to reason about and is the
  // source of jumbled copy / cut labels). Phase 1 removes all previously drafted
  // copy; we then RE-PARSE the now-clean doc so the inserts use indices that
  // reflect its real current state, regardless of how long the old copy was.
  //
  // First drafts have no existing copy (deleteEnd == null everywhere), so Phase
  // 1 and the re-parse are skipped — inserts run against the original parse,
  // identical to the previous behavior.

  // Ordinals over the ORIGINAL parse, taken from `assets` rather than from
  // `assetTargets` — the latter is filtered (empty assets dropped, scoped runs
  // narrowed) and its positions would not line up with a full re-parse.
  const originalOrdinals = fieldOrdinals(assets);

  // Phase 1 — delete existing copy, bottom-to-top (reverse-order deletes are
  // index-safe: a deletion at a higher index never shifts lower indices).
  const deletions = drafted
    .filter((d) => d.deleteEnd != null && d.deleteEnd > d.insertIndex)
    .sort((a, b) => b.insertIndex - a.insertIndex);

  // REFUSE THE WHOLE BATCH IF ANY TWO RANGES OVERLAP. Deletes inside one
  // batchUpdate are applied in sequence against a document that each one shrinks,
  // so the bottom-to-top ordering above is only index-safe while the ranges are
  // DISJOINT. Two that overlap mean the second is addressing indices that no
  // longer hold what its parse said they held, and Google will carry it out
  // anyway — that is the corruption this guard exists to stop being silent.
  //
  // Nothing should reach it now that a draft resolves by position rather than by
  // name, so treat it firing as a defect upstream of here and not as a document
  // problem. It is a tripwire, not the fix.
  assertDisjointDeletes(deletions);

  let insertIndexByField = null;
  if (deletions.length > 0) {
    await docs.documents.batchUpdate({
      documentId: id,
      requestBody: {
        requests: deletions.map((d) => ({
          deleteContentRange: { range: { startIndex: d.insertIndex, endIndex: d.deleteEnd } },
        })),
      },
    });

    // Re-parse the cleaned doc to recover fresh, correct insertion indices.
    //
    // RESOLVED BY DOCUMENT-ORDER ORDINAL, NOT BY NAME. This used to key on
    // ctxKey(assetType, fieldName, instance), which fixed the cross-INSTANCE
    // collapse (the same asset heading twice) and left the within-asset one:
    // fieldName is the label with its bracket stripped, so "Headline [50]" and
    // "Headline [60]" under one asset are ONE key, last wins. Both fields' copy
    // then resolved to the second one's position — the first label was left
    // empty and the second got both blocks stacked under it. That is the same
    // root cause as the duplicate delete range, on the insert side, and it
    // survived the two-phase fix because the re-parse map inherited the name.
    //
    // See fieldOrdinals for why position is the identity that crosses a parse
    // and insertIndex is not.
    const freshDoc = (await docs.documents.get({ documentId: id })).data;
    const fresh = parseDoc(freshDoc);
    const freshOrdinals = fieldOrdinals(fresh.assets);

    // THE INVARIANT THE ORDINAL RESTS ON, CHECKED RATHER THAN ASSUMED. Phase 1
    // deletes copy only, so the cleaned document must hold exactly the same
    // fields in the same order. A different count means a delete removed a label
    // — at which point every ordinal below it is off by one and the inserts would
    // land under the wrong labels, silently. Refusing here costs a failed draft;
    // not refusing costs a document.
    if (freshOrdinals.count !== originalOrdinals.count) {
      throw new Error(
        'Draft aborted after clearing old copy: the document changed shape during the delete pass ' +
          `(${originalOrdinals.count} field(s) before, ${freshOrdinals.count} after). ` +
          'Field positions can no longer be resolved safely, so no new copy was written. ' +
          'The previous copy has been removed and the labels are intact — re-run the draft.'
      );
    }
    insertIndexByField = freshOrdinals.insertIndexAt;
  }

  // Resolve each drafted field's insertion index: the re-parsed value after a
  // delete pass, otherwise the original parse (first draft). Drop any field we
  // can't place (shouldn't happen, but never insert at a stale/unknown index).
  //
  // After a delete pass the draft's own insertIndex is stale by construction, so
  // it is used ONLY to identify which field this is (it was unique in the
  // original parse) and then discarded for the fresh position at the same
  // ordinal. An append batch never reaches this branch: appendMode sets every
  // deleteEnd to null, so `deletions` is empty and insertIndexByField stays null
  // — which matters, because an append writes BELOW existing copy and the fresh
  // label position would put it above.
  const inserts = drafted
    .map((d) => {
      let idx = d.insertIndex;
      if (insertIndexByField) {
        const ordinal = originalOrdinals.ordinalOf.get(d.insertIndex);
        idx = ordinal != null ? insertIndexByField[ordinal] : null;
        if (idx == null) {
          console.warn(
            `[googleDocs] could not place ${d.assetType} / ${d.fieldName} after the delete pass — skipped`
          );
        }
      }
      return idx != null
        ? { insertIndex: idx, copy: d.copy, riffN: d.riffN, unenforced: d.unenforced, unenforcedDetail: d.unenforcedDetail }
        : null;
    })
    .filter(Boolean)
    // Bottom-to-top so each insert doesn't shift the indices of the ones above.
    .sort((a, b) => b.insertIndex - a.insertIndex);

  // Phase 2 — insert the new copy under each label (regular weight, not the
  // bold label style). Inserts run bottom-to-top (highest index first), so each
  // insert's absolute index stays valid until it's applied.
  //
  // Append batches (riffN set) are prefaced by a faint "Riff N" HEADING_6 header.
  // HEADING_6 is the structural marker parseDoc/getDocContent key off to exclude
  // the divider from copy — cosmetic faint styling is layered on top and does not
  // affect parsing. The header range stops BEFORE its newline so the paragraph
  // style lands only on the header; the block range is forced to NORMAL_TEXT so
  // it can't inherit the heading style.
  const requests = [];
  for (const { insertIndex, copy, riffN, unenforced, unenforcedDetail } of inserts) {
    if (riffN != null) {
      const header = `Riff ${riffN}`;
      requests.push({ insertText: { location: { index: insertIndex }, text: `${header}\n${copy}\n` } });
      const headerEnd = insertIndex + header.length;
      const blockStart = headerEnd + 1; // past the header's newline
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: insertIndex, endIndex: headerEnd },
          paragraphStyle: { namedStyleType: 'HEADING_6' },
          fields: 'namedStyleType',
        },
      });
      requests.push({
        updateTextStyle: {
          range: { startIndex: insertIndex, endIndex: headerEnd },
          textStyle: {
            bold: false,
            italic: true,
            fontSize: { magnitude: 8, unit: 'PT' },
            foregroundColor: { color: { rgbColor: { red: 0.6, green: 0.63, blue: 0.65 } } },
          },
          fields: 'bold,italic,fontSize,foregroundColor',
        },
      });
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: blockStart, endIndex: blockStart + copy.length },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      });
      requests.push({
        updateTextStyle: {
          range: { startIndex: blockStart, endIndex: blockStart + copy.length },
          textStyle: { bold: false, italic: false },
          fields: 'bold,italic',
        },
      });
      continue;
    }
    requests.push({ insertText: { location: { index: insertIndex }, text: copy + '\n' } });
    requests.push({
      updateTextStyle: {
        range: { startIndex: insertIndex, endIndex: insertIndex + copy.length },
        textStyle: { bold: false, italic: false },
        fields: 'bold,italic',
      },
    });

    // A word field over its own limit is written AS GENERATED — trimCeiling is
    // null for a word field, by design (gemini.js), because truncating prose
    // mid-thought is worse than the overflow and the writer has to make that
    // edit themselves. Nothing else marks this, so it is marked here.
    //
    // HEADING_5 is unclaimed anywhere else in this file (HEADING_2/3/4/6 and
    // NORMAL_TEXT are all spoken for — see parseDoc/getDocContent) and used
    // purely STRUCTURALLY: it is never bold, so it can never be read as a field
    // label or reach the "[min-max]" bracket regex (that branch is gated on
    // `bold` before the regex ever runs). parseDoc needs no change at all —
    // it never accumulates copy TEXT, only positions, so this paragraph falls
    // straight into the existing generic "any other paragraph = copy position,
    // advance deleteEnd" branch and is swept into the field's own delete range
    // on the next Regenerate, exactly like a "Riff N" header already is.
    // getDocContent DOES accumulate copy text, so it gets one new exclusion
    // (below, next to its existing HEADING_6 exclusion) so this sentence is
    // never read as part of the field's copy.
    //
    // Visual styling is fully overridden via updateTextStyle, the same
    // technique the Riff header uses — the named style is structure, not
    // appearance.
    if (unenforced) {
      const marker = `This field is over its word count (${unenforcedDetail}). Edit the length before shipping.`;
      const markerStart = insertIndex + copy.length + 1; // right after copy's own trailing \n
      const markerEnd = markerStart + marker.length; // excludes the marker's own trailing \n
      requests.push({ insertText: { location: { index: markerStart }, text: marker + '\n' } });
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: markerStart, endIndex: markerEnd },
          paragraphStyle: { namedStyleType: 'HEADING_5' },
          fields: 'namedStyleType',
        },
      });
      requests.push({
        updateTextStyle: {
          range: { startIndex: markerStart, endIndex: markerEnd },
          textStyle: {
            bold: false,
            italic: true,
            fontSize: { magnitude: 9, unit: 'PT' },
            foregroundColor: { color: { rgbColor: { red: 0.7, green: 0.4, blue: 0.05 } } },
          },
          fields: 'bold,italic,fontSize,foregroundColor',
        },
      });
    }
  }

  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: id,
      requestBody: { requests },
    });
  }

  return {
    title: doc.title,
    fieldCount: inserts.length,
    // Both additive, both read by the surfaces to decide whether this run can
    // honestly be called ready. An older caller that destructures only the
    // original three is unaffected.
    fieldsAttempted,
    failureReason,
    // How many of the WRITTEN fields are word fields over their own limit —
    // written as generated, marked in the doc above, never trimmed. Zero on
    // every run with no word-field overflow, so an unaffected caller sees the
    // same shape as before plus one always-present key.
    unenforcedCount: inserts.filter((i) => i.unenforced).length,
    url: `https://docs.google.com/document/d/${id}/edit`,
  };
}

// Read a doc back into a structured, copy-bearing shape for the web project
// view. Unlike parseDoc (which recovers field *positions* for drafting), this
// also captures the per-field italic notes + drafted copy under each label: the
// plain paragraphs that follow a bold field label, up to the next label /
// heading. Returns
//   { summary, writerDirection, assets: [{ name, instance, instanceLabel,
//     fields: [{ fieldName, charMin, charMax, notes, copy }] }] }
// `name` is the LIBRARY asset name even when the heading carries an instance
// suffix ('Demand Gen Nurture Email 2 — Downtown residents' → name 'Demand Gen
// Nurture Email', instance 1, instanceLabel 'Downtown residents').
// Throws if the doc can't be read so the caller can surface the fallback.
async function getDocContent(id, clients) {
  const { docs } = clients || (await getClients());
  const doc = (await docs.documents.get({ documentId: id })).data;

  const result = { title: doc.title || '', summary: '', writerDirection: '', assets: [] };
  let current = null; // current asset block
  let field = null; // current field collecting copy
  let expecting = null; // 'summary' | 'writerDirection'
  const assetOrdinal = instanceCounter(); // per-heading-text instance ordinals
  const instanceHeadings = instanceHeadingMap(assetHeadingTexts(doc)); // same pre-pass as parseDoc

  for (const item of doc.body.content || []) {
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = p.paragraphStyle?.namedStyleType;
    const text = paragraphText(p).trim();
    const { bold, italic } = runStyle(p);

    if (named === 'HEADING_2' && text === 'Campaign Summary') {
      expecting = 'summary';
      field = null;
      continue;
    }
    if (named === 'HEADING_2' && text === 'Writer Direction') {
      expecting = 'writerDirection';
      field = null;
      continue;
    }
    if (expecting === 'summary') {
      if (text) {
        result.summary = text;
        expecting = null;
      }
      continue;
    }
    if (expecting === 'writerDirection') {
      if (text) {
        result.writerDirection = text;
        expecting = null;
      }
      continue;
    }

    if (named === 'HEADING_3') {
      // Same decomposition + 0-based ordinal parseDoc does (see there): `name` is
      // the LIBRARY name even when the heading carries an instance suffix.
      const parts = instanceHeadings.get(text);
      current = parts
        ? { name: parts.assetType, instance: parts.instance, instanceLabel: parts.instanceLabel,
            asset_direction: '', fields: [] }
        : { name: text, instance: assetOrdinal(text), instanceLabel: null, asset_direction: '', fields: [] };
      result.assets.push(current);
      field = null;
      continue;
    }

    // A group sub-heading (e.g. "Graphic Copy", HEADING_4) is a layout label, not
    // a field — skip it and end the previous field's copy region.
    if (named === 'HEADING_4') {
      field = null;
      continue;
    }

    // Riff batch header (Step 3) — structural divider, never copy. Skip it WITHOUT
    // ending the field, so the batch options below it still accumulate into this
    // field's copy. The header is EXCLUDED from copy (the named-style check fires
    // before the bold-label and copy branches, so it can never be read as an
    // option), but its position + number are recorded on field.riffMarks so the
    // app can render a faint "Riff N" divider before that batch's first option —
    // with the doc-accurate number (gap-safe: a surviving Riff 3 renders as 3).
    // beforeLine is the index (in the \n-split of field.copy) of the first option
    // that follows this header.
    if (named === 'HEADING_6') {
      if (field) {
        const rm = text.match(/^Riff\s+(\d+)/i);
        const beforeLine = field.copy ? field.copy.split('\n').length : 0;
        field.riffMarks.push({ beforeLine, riffN: rm ? Number(rm[1]) : field.riffMarks.length + 1 });
      }
      continue;
    }

    // The word-limit marker (HEADING_5, written after an over-limit word
    // field's copy — see generateDraft's write step) is a system note, not
    // copy. Excluded the same way the Riff header just above is, so review and
    // sibling-context prompts never see this sentence as part of the field.
    if (named === 'HEADING_5') {
      continue;
    }

    if (!current) continue;

    // The italic line between the asset heading and its first field is the
    // asset-level creative direction (or legacy channel · tone) — capture it for
    // display; it isn't field copy.
    if (italic && text && current.fields.length === 0 && !field) {
      if (!current.asset_direction) current.asset_direction = text;
      continue;
    }

    // A bold paragraph (optionally ending in a [min-max] / [max] bracket) starts
    // a new field. Recover charMin/charMax exactly as parseDoc does.
    if (bold && text) {
      const m = text.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
      const fieldName = m ? m[1].trim() : text;
      const bracket = m ? m[2] : '';
      const nums = bracket.match(/\d+/g);
      // The unit rides in the bracket ("[50-125 words]") because nothing about a
      // field is persisted — see WORD_UNIT_SUFFIX. Reading it back here is what
      // keeps the drafter and the reviewer counting the same thing the writer sees.
      const fieldType = /\bwords?\b/i.test(bracket) ? 'words' : 'text';
      let charMin = 0;
      let charMax = 0;
      if (nums) {
        const vals = nums.map(Number);
        charMax = Math.max(...vals);
        if (vals.length >= 2) charMin = Math.min(...vals);
      }
      // `label` is the bold paragraph VERBATIM — "Headline (Offer 1) [50]",
      // bracket and unit included. Carried because copy review now leads each
      // comment with it, and a comment that says it is about "Headline [50]" has
      // to say the same thing the reader will scan the page for. Reconstructing it
      // from fieldName + charMin/charMax would be a second renderer of fieldLabel,
      // free to drift from the one that wrote the document. Additive: every
      // existing consumer reads fieldName/charMin/charMax and is unaffected.
      field = { fieldName, label: text, charMin, charMax, fieldType, notes: '', copy: '', riffMarks: [] };
      current.fields.push(field);
      continue;
    }

    // Per-field guidance: the italic line right after a label, before any copy.
    // Capture it for display, but never count it as drafted copy.
    if (field && italic && text && !field.copy && !field.notes) {
      // SAME STRIP AS parseDoc. Nothing renders this today — routes/app.js and
      // app.html never read it, and copyReview builds its prompts from `copy` —
      // but an undocumented asymmetry one call site from shipping a Settings
      // pointer into a review prompt is the shape of every silent failure here.
      field.notes = stripReaderOnlyLines(text);
      continue;
    }

    // Any other non-empty paragraph is drafted copy for the current field.
    if (field && text) {
      field.copy = field.copy ? `${field.copy}\n${text}` : text;
    }
  }

  return result;
}

// --- Copy-review comments (Drive API v3) ---
//
// REVIEW COMMENTS ARE UNANCHORED, DELIBERATELY. This header used to say they were
// "anchored to exact copy via quotedFileContent (verified)". That claim was false,
// and it is worth saying how it survived, because the shape recurs.
//
// quotedFileContent does not anchor anything. It is the quoted TEXT of a comment,
// not a position: Drive never searches the document for it. Anchoring is the
// separate `anchor` field, and Google publishes no text-anchor format for native
// Google Docs — documents.batchUpdate has no comment request type either, so there
// is no supported way to create an anchored comment on a Doc at all. A comment
// carrying a quote it cannot resolve is exactly what the Docs UI renders as
// "Original content deleted": the comment exists, holds its text, and points
// nowhere. Every review comment Quillio has ever posted rendered that way.
//
// The "(verified)" traced to scripts/testDocComment.js, which prints the create
// response and then asks a human to open the doc and report back. No result was
// ever recorded. The create response looks identical either way — Drive returns
// 200 and an id whether or not it anchored anything — which is the trap
// scripts/probeCellCommentAnchor.js names outright: "'the quote came back' is the
// result that would be easiest to mistake for success."
//
// So the location now travels INSIDE the comment text. services/copyReview.js
// leads every comment with a locator line (the field's label exactly as the doc
// renders it, plus its asset) and a short verbatim fragment of the copy. That is
// also what makes re-review idempotent — see the matching note there.
//
// Quillio's review comments are branded + identified by this prefix so re-review
// can find the previous ones before posting the currently-warranted set.
const REVIEW_PREFIX = '🪶 Quillio Review — ';

// List the live Quillio review comments on the doc (prefix-identified). Returns
// [{ id, content, resolved, quote, anchor }] and `resolved` is true when the user
// manually resolved it in Google Docs. RESOLVED COMMENTS ARE INCLUDED — reconcile
// needs them to respect manual dismissals. `content` has the REVIEW_PREFIX
// stripped. Non-Quillio comments are excluded by the prefix.
//
// `anchor` IS REQUESTED THOUGH NOTHING SENDS ONE, and that is the point. It is the
// only field that can ever say whether Drive pinned a comment to a region, and it
// was the one field this reader never asked for — which is why four months of
// comments could render as "Original content deleted" with nothing in the system
// able to notice. It stays requested so the next person debugging this can see the
// answer instead of inferring it. Expect '' on every row.
//
// `quote` likewise stays read (nothing sends one now either): comments posted
// before the unanchoring still carry theirs, and seeing it is how you tell a
// legacy comment from a current one.
async function listReviewComments(docId, clients) {
  const { drive } = clients || (await getClients());
  const out = [];
  let pageToken = null;
  do {
    const res = await drive.comments.list({
      fileId: docId,
      fields: 'nextPageToken, comments(id, content, anchor, deleted, resolved, quotedFileContent/value)',
      pageSize: 100,
      includeDeleted: false,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
    });
    for (const c of res.data.comments || []) {
      if (c.deleted || typeof c.content !== 'string' || !c.content.startsWith(REVIEW_PREFIX)) continue;
      out.push({
        id: c.id,
        content: c.content.slice(REVIEW_PREFIX.length),
        resolved: !!c.resolved,
        quote: (c.quotedFileContent && c.quotedFileContent.value) || '',
        anchor: typeof c.anchor === 'string' ? c.anchor : '',
      });
    }
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return out;
}

// Post ONE branded review comment. Returns the new comment id, or null on failure
// (logged). Empty content is a no-op (returns null).
//
// NO quotedFileContent — see the header above. Sending a quote that cannot resolve
// is what produced "Original content deleted" on every comment this function has
// ever posted, so the absence is the fix, not a degradation. `content` arrives
// already carrying its own locator line (services/copyReview.js composeComment).
//
// The parameter object still ACCEPTS a `quote` key and ignores it, so a caller
// that has not been updated posts a working comment rather than throwing.
async function addReviewComment(docId, { content } = {}, clients) {
  if (!content || !String(content).trim()) return null;
  const { drive } = clients || (await getClients());
  try {
    const res = await drive.comments.create({
      fileId: docId,
      fields: 'id',
      supportsAllDrives: true,
      requestBody: { content: REVIEW_PREFIX + content },
    });
    return (res.data && res.data.id) || null;
  } catch (err) {
    console.error(`[review] failed to add comment: ${err.message}`);
    return null;
  }
}

// Delete ONE comment by id. Best-effort; returns true if it was deleted.
async function deleteReviewComment(docId, commentId, clients) {
  if (!commentId) return false;
  const { drive } = clients || (await getClients());
  try {
    await drive.comments.delete({ fileId: docId, commentId, supportsAllDrives: true });
    return true;
  } catch (err) {
    console.error(`[review] failed to delete comment ${commentId}: ${err.message}`);
    return false;
  }
}

// The destination adapter contract.
// BUILD ONE TEMPLATE DOCUMENT for a project (custom document types, STEP THREE).
//
// A tenant's own document — a landscape multi-table copy matrix, typically —
// copied into the campaign folder and filled with this project's copy.
//
// COPY, DON'T REBUILD. drive.files.copy duplicates the imported Google Doc
// wholesale: landscape, tables, merged cells, column widths, shading and fonts
// all come along because they are never re-derived. The fidelity probe
// (scripts/probeDocxImport.js) confirmed those survive the .docx import in the
// first place; copy preserves whatever survived. Rebuilding the matrix from a
// schema — the docBuilder route the copy doc takes — would mean re-implementing
// every one of those, and getting column widths wrong on someone's client
// deliverable is not a recoverable kind of wrong.
//
// FILL WITH replaceAllText. One batchUpdate carrying one request per marker. No
// index arithmetic (the two-phase problem docHeaderTable.js exists to solve is
// avoided entirely), and the replacement INHERITS the formatting of the run it
// replaces — so copy dropped into a bold header cell comes out bold, which is
// what the tenant designed and what any insert-at-index approach would lose.
//
// AN UNMAPPED MARKER IS LEFT ALONE, on purpose. It stays in the output as a
// literal {{Marker}}, visible to whoever opens the document. Blanking it would
// be worse in the exact way that matters: an empty cell in a matrix reads as
// "nobody wrote this yet" and a visible {{Form ID}} reads as "this one is not
// mine to write", and only the second is true. Nothing here ever writes an
// empty string over a marker.
//
//   values: Map|Object of markerKey -> copy. A key with no value is skipped.
//   markers: [{ name, key }] — every marker in the template, so the result can
//            report what was left unfilled without a second read.
//
// Returns { id, url, title, filled: [...], unfilled: [...] }.
async function createFromTemplate({ sourceDocId, name, folderId, values, markers = [], clients }) {
  const { drive, docs } = clients || (await getClients());
  if (!sourceDocId) throw new Error('createFromTemplate: no source document.');

  const copied = await drive.files.copy({
    fileId: sourceDocId,
    requestBody: { name: name || 'Template document', ...(folderId ? { parents: [folderId] } : {}) },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  const id = copied.data.id;
  const url = copied.data.webViewLink || `https://docs.google.com/document/d/${id}/edit`;

  const get = (k) => (values instanceof Map ? values.get(k) : values ? values[k] : undefined);

  const requests = [];
  const filled = [];
  const unfilled = [];
  for (const m of markers) {
    const copy = get(m.key);
    // Only a non-empty string fills. undefined (unmapped) and '' (mapped to a
    // field that has no copy yet) both leave the marker standing.
    if (typeof copy === 'string' && copy.trim()) {
      requests.push({
        replaceAllText: {
          containsText: { text: `{{${m.name}}}`, matchCase: false },
          replaceText: copy,
        },
      });
      filled.push(m.name);
    } else {
      unfilled.push(m.name);
    }
  }

  if (requests.length) {
    await docs.documents.batchUpdate({ documentId: id, requestBody: { requests } });
  }

  console.log(
    `[googleDocs] template document "${copied.data.name}" -> ${id} — ` +
      `${filled.length} marker(s) filled, ${unfilled.length} left visible`
  );

  return { id, url, title: copied.data.name, filled, unfilled };
}

async function writeTemplateCells(documentId, { markers, values }, clients) {
  const { docs } = clients || (await getClients());
  if (!documentId) throw new Error('writeTemplateCells: no document.');

  const doc = (await docs.documents.get({ documentId })).data;
  const { found, missing } = locateCells(doc, markers || []);
  const { requests, written, skipped } = buildCellWriteRequests(found, values);

  if (requests.length) {
    await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  }

  const healed = found.filter((c) => c.healed).map((c) => ({ name: c.marker.marker_name, reason: c.reason }));
  console.log(
    `[googleDocs] template cells ${documentId} — ${written.length} written, ${skipped.length} left as-is` +
      (healed.length ? `, ${healed.length} found by label after an edit` : '') +
      (missing.length ? `, ${missing.length} NOT LOCATED` : '')
  );
  for (const m of missing) {
    console.warn(`[googleDocs]   could not place {{${m.marker && m.marker.marker_name}}}: ${m.reason}`);
  }

  return {
    written,
    skipped,
    healed,
    missing: missing.map((m) => ({ name: m.marker && m.marker.marker_name, reason: m.reason })),
    requests: requests.length,
  };
}

// READ BACK a built template document by stored coordinate (step three).
//
// One documents.get, no write. The coordinate is structural, so it still finds
// the cell after the marker has been replaced by copy — reading it back is how
// that stops being an assertion and starts being an observation.
//
// Returns { rows, missing } from templateCells.readCells. A row carries the
// cell's CURRENT text and whether it still shows its {{marker}}.
async function readTemplateCells(documentId, { markers } = {}, clients) {
  const { docs } = clients || (await getClients());
  if (!documentId) throw new Error('readTemplateCells: no document.');

  const doc = (await docs.documents.get({ documentId })).data;
  const { rows, missing } = readCells(doc, markers || []);

  const drafted = rows.filter((r) => r.is_copy && !r.showingMarker && !r.empty).length;
  const standing = rows.filter((r) => r.showingMarker).length;
  console.log(
    `[googleDocs] read ${documentId} — ${rows.length} located, ${drafted} holding copy, ` +
      `${standing} still showing a marker` + (missing.length ? `, ${missing.length} NOT LOCATED` : '')
  );
  return { rows, missing, title: (doc && doc.title) || '' };
}

// Post ONE branded review comment with NO ANCHOR.
//
// WHY UNANCHORED, AND WHY THIS IS NOT A DEGRADED addReviewComment. Because
// addReviewComment is not anchored either — nothing on a Google Doc can be.
//
// This comment used to read the probe's six "Original content deleted" results as
// a fact about TABLE CELLS. They were not. quotedFileContent is the quoted TEXT of
// a comment, never a position: Drive does not search the document for it.
// Anchoring is the separate `anchor` field, and Google publishes no text-anchor
// format for native Docs, so a quote resolves nowhere in a PARAGRAPH either. The
// copy doc carried the same banner on every comment it ever posted, which is what
// finally disproved the cell reading. See the review-section header above.
//
// So there was never an anchored path to fall back FROM, anywhere. What is true
// and specific to this path is the consequence: the field name is load-bearing,
// because it is the only thing tying the comment to a cell. A matrix is already a
// lookup table with a Field column, so naming the field in the body text is not a
// workaround — it is the same way a human would refer to a row. The copy doc
// reaches the same conclusion by a different route (services/copyReview.js
// composes a locator line), for the same reason.
async function addUnanchoredComment(docId, content, clients) {
  if (!content || !String(content).trim()) return null;
  const { drive } = clients || (await getClients());
  try {
    const res = await drive.comments.create({
      fileId: docId,
      fields: 'id',
      supportsAllDrives: true,
      // No quotedFileContent. Sending one that cannot resolve is what produces
      // the "Original content deleted" banner, so the absence is deliberate.
      requestBody: { content: REVIEW_PREFIX + content },
    });
    return (res.data && res.data.id) || null;
  } catch (err) {
    console.error(`[review] failed to add unanchored comment: ${err.message}`);
    return null;
  }
}

// Correct the character-limit bracket inside existing field labels.
//
// THE ONLY CODE PATH IN THIS REPO THAT MODIFIES A FIELD LABEL. Everything else
// that writes into a built document works BELOW a label: generateDraft's delete
// range runs from a label's endIndex to the end of its copy (assertDisjointDeletes
// guards it), and appendBody only ever adds. That invariant is deliberate and this
// function does not break it — it edits strictly INSIDE the bracket, which is a
// span that contains no field name and no copy.
//
// WHAT IT DOES NOT DO: touch the copy. A field whose limit DROPPED may now hold
// copy that is over the new limit, and that is exactly the thing the writer is
// being told about. Rewriting their line to fit would make Quillio the author of
// copy a person signed off, which is a different product.
//
// NOT replaceAllText. That request exists in this file on the template path only,
// where markers are unique by construction ("{{brand_line}}" appears once). A
// bracket is not remotely unique — "[50]" occurs on every 50-character field in
// the document, in the copy a writer may have typed, and inside a reference
// insight. replaceAllText would rewrite all of them with no way to scope it.
//
// ORDERING. Every edit is expressed against indices read from ONE parse, so an
// applied edit invalidates the indices of every edit after it in the document.
// The requests are therefore emitted in DESCENDING index order, so each edit only
// ever shifts text that is already behind us — the same reason
// `.sort((a, b) => b.insertIndex - a.insertIndex)` appears twice in generateDraft,
// and the same reason buildTemplateDocument writes its cells in reverse. A
// replacement is not length-preserving ("[150]" -> "[255]" is, "[90]" -> "[100]"
// is not), so this is load-bearing rather than defensive.
//
// `corrections` are { assetType, instance, fieldName, expectMax, newMax }. Each is
// applied only if the document's OWN bracket still reads expectMax — the manifest
// says which documents to open, the document itself decides what to change. That
// is what makes a re-run after a partial failure a no-op on the documents already
// corrected, rather than a second edit.
//
// ─── THE PROVENANCE CLAUSE MOVES WITH THE BRACKET ───────────────────────────
// A corrected field's hint line ends "Verified against Meta's spec page on
// 2026-08-20." — a claim that a human confirmed THIS number against that page.
// The bracket is moving because that is no longer what the page says, so leaving
// the sentence is not a stale date: it is the document asserting the source was
// unchanged on the one field whose number just changed because the source
// changed. It becomes "Limit corrected YYYY-MM-DD."
//
// IN THE SAME batchUpdate, which is the whole reason this is cheap. Docs applies
// a batch atomically, so three more requests in the array already built means the
// bracket and the sentence move together or neither does. There is no second
// read, and no window in which a document says both things.
//
// ONLY THE SENTENCE, NEVER THE PARAGRAPH. The hint line carries the citation
// HYPERLINK on the platform name. Replacing the paragraph would drop it, and a
// corrected field that loses its citation while gaining a "corrected" sentence
// has less provenance than it started with. The clause is appended last by
// fieldHint, so its range is computable (noteProvenanceRange) and everything
// before it — the tenant's note, the tier line, the link — is untouched.
//
// A FIELD CARRYING NO CLAUSE GETS NOTHING WRITTEN. Its bracket is corrected and
// the hint line is left exactly as it is.
//
// THE HAND-EDITED HINT LINE IS THE RULE, NOT A SIDE EFFECT OF IT. A writer who
// rewrites that line no longer matches the pattern, so the sweep leaves their
// words alone instead of appending to them. This function has one licence — to
// replace a sentence THIS CODEBASE WROTE with a more accurate one — and a line a
// person has since edited is not that sentence any more. Matching on the wording
// we composed is what keeps the licence honest; a positional rule ("the last
// sentence of the hint paragraph") would have overwritten them.
//
// The same non-match covers every other no-clause case for free: a field that
// never qualified for a date (house_default, a tenant-authored field, a source
// resolving to no platform) and a document built before the feature existed.
// Appending to those would be inventing provenance for a field that never had any.
//
// A SECOND CORRECTION REPLACES THE FIRST rather than stacking. "Limit corrected"
// is one of the three wordings PROVENANCE_AT_END matches, so a field corrected
// twice reads the newer date and no more: the sentence answers "when did this
// document's limit last move", and the history it does not carry is in
// spec_change_log, which is what that table is for.
//
// `correctedOn` is REQUIRED, ISO, and supplied by the caller — one date for a
// whole sweep run, so a run spanning midnight does not date two documents
// differently for one event. It is not defaulted from the clock here: a
// destination inventing a date is a date nobody chose and nobody can check.
async function correctFieldBrackets(id, corrections, clients, { correctedOn } = {}) {
  const { docs } = clients || (await getClients());
  const doc = (await docs.documents.get({ documentId: id })).data;
  const parsed = parseDoc(doc);

  const norm = (v) => String(v || '').trim().toLowerCase();
  const applied = [];
  const skipped = [];

  for (const c of corrections || []) {
    const asset = (parsed.assets || []).find(
      (a) => norm(a.assetType) === norm(c.assetType) && (Number(a.instance) || 0) === (Number(c.instance) || 0)
    );
    if (!asset) {
      skipped.push({ ...c, reason: 'asset_absent' });
      continue;
    }
    const field = (asset.fields || []).find((f) => norm(f.fieldName) === norm(c.fieldName));
    if (!field) {
      skipped.push({ ...c, reason: 'field_absent' });
      continue;
    }
    if (field.bracketStart == null || field.bracketEnd == null) {
      skipped.push({ ...c, reason: 'no_bracket' });
      continue;
    }
    // The document is the truth. A bracket that does not read the value the
    // change is moving away from was either already corrected, or was never the
    // spec's number — a writer may have edited it by hand. Neither is ours.
    if ((Number(field.charMax) || 0) !== (Number(c.expectMax) || 0)) {
      skipped.push({ ...c, reason: 'not_at_old_value', found: field.charMax });
      continue;
    }
    // charMin comes off the DOCUMENT, not off the spec, so a tenant who set their
    // own floor keeps it — only the maximum this change is about moves.
    const text = fieldBracket({ charMin: field.charMin, charMax: c.newMax, fieldType: field.fieldType });
    if (!text) {
      skipped.push({ ...c, reason: 'refuses_empty_bracket' });
      continue;
    }
    if (text === field.bracketText) {
      skipped.push({ ...c, reason: 'already_correct' });
      continue;
    }
    applied.push({
      assetType: asset.assetType,
      instance: Number(asset.instance) || 0,
      fieldName: field.fieldName,
      start: field.bracketStart,
      end: field.bracketEnd,
      from: field.bracketText,
      to: text,
      oldMax: field.charMax,
      newMax: c.newMax,
      // Reported so the run can say what it did to the hint line as well as to
      // the bracket. 'absent' is a normal outcome, not a failure.
      provenance: field.provenanceStart != null && field.provenanceEnd != null ? 'rewritten' : 'absent',
      provenanceFrom: field.provenanceText || null,
      provenanceStart: field.provenanceStart,
      provenanceEnd: field.provenanceEnd,
    });
  }

  if (applied.length === 0) return { docId: id, title: doc.title || '', applied: [], skipped };

  // Composed once, and BEFORE anything is built: a malformed correctedOn throws
  // here, with no requests written and the document untouched.
  const correctedText = correctedSentence(correctedOn);

  // Every span this document is about to change: each field's bracket, and the
  // provenance clause of the fields that carry one. Flattened into one list
  // because the ordering and the overlap guard are properties of the DOCUMENT,
  // not of either kind of edit — a bracket and a hint line four characters apart
  // would be just as unwritable as two brackets.
  const edits = [];
  for (const a of applied) {
    edits.push({
      start: a.start,
      end: a.end,
      to: a.to,
      // Inserted text inherits the style of what precedes it, which here is the
      // bold label — but "inherits" is a property of the API rather than of this
      // document, and a label whose runs were split could put a non-bold
      // character immediately before the bracket. Stating it costs one request
      // and removes the question.
      textStyle: { bold: true },
      textFields: 'bold',
      what: `${a.fieldName} bracket`,
    });
    if (a.provenance === 'rewritten') {
      edits.push({
        start: a.provenanceStart,
        end: a.provenanceEnd,
        to: correctedText,
        // The hint line's own italic + grey, imported from the builder that
        // wrote it rather than restated here. The character before this insertion
        // point is the tier line's tail — italic, grey, and NOT part of the
        // citation link, which sits earlier in the paragraph — so inheritance
        // would probably do it; the same argument as the bracket's bold applies.
        textStyle: NOTE_TEXT_STYLE,
        textFields: NOTE_TEXT_FIELDS,
        what: `${a.fieldName} provenance`,
      });
    }
  }

  // Two labels cannot overlap, and a label cannot overlap the paragraph below it,
  // so this can only fire on a bug in the range computation above. It refuses the
  // whole document rather than half-editing it.
  const ordered = edits.sort((a, b) => b.start - a.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].end > ordered[i - 1].start) {
      throw new Error(
        `Bracket correction aborted before writing: overlapping ranges in ${id} — ` +
          `${ordered[i].what} [${ordered[i].start}, ${ordered[i].end}) and ` +
          `${ordered[i - 1].what} [${ordered[i - 1].start}, ${ordered[i - 1].end}). ` +
          'The document was NOT modified.'
      );
    }
  }

  const requests = [];
  for (const a of ordered) {
    requests.push({ deleteContentRange: { range: { startIndex: a.start, endIndex: a.end } } });
    requests.push({ insertText: { location: { index: a.start }, text: a.to } });
    requests.push({
      updateTextStyle: {
        range: { startIndex: a.start, endIndex: a.start + a.to.length },
        textStyle: a.textStyle,
        fields: a.textFields,
      },
    });
  }

  await docs.documents.batchUpdate({ documentId: id, requestBody: { requests } });
  const rewritten = applied.filter((a) => a.provenance === 'rewritten').length;
  console.log(
    `[googleDocs] corrected ${applied.length} bracket(s) in ${id} ` +
      `(${rewritten} provenance line(s) rewritten to "${correctedText}"): ` +
      applied.map((a) => `${a.assetType}/${a.fieldName} ${a.from} -> ${a.to}`).join('; ')
  );
  return { docId: id, title: doc.title || '', applied, skipped };
}

module.exports = {
  name: 'google-docs',
  createDocument,
  createFromTemplate,
  writeTemplateCells,
  readTemplateCells,
  addUnanchoredComment,
  generateDraft,
  getDocContent,
  listReviewComments,
  addReviewComment,
  deleteReviewComment,
  REVIEW_PREFIX,
  // Consumed by services/specSweep.js through getDestination(), so it belongs to
  // the destination interface rather than to the test-only block below.
  correctFieldBrackets,
  // The platform display name for a spec_source URL. Exported because the sweep's
  // notification names the platform, and a second copy of that mapping is how the
  // doc and the notification end up disagreeing about who published a limit.
  specSourceName,
  // Exposed for unit tests only (not part of the destination interface used by
  // the registry): char-limit bracket rendering, the field explainer, doc
  // re-parsing including the regeneration delete-range detection, and the body
  // builder (to lock the default-header fallback ordering).
  fieldLabel,
  fieldBracket,
  fieldHint,
  parseDoc,
  // The delete-range disjointness guard. Unit tests only — it is called from
  // inside generateDraft and is exported so its refusal can be exercised
  // directly as well as through a replay.
  assertDisjointDeletes,
  // The house-default sentences and the strip that keeps them out of a prompt.
  // Unit tests only, like the four around them — not part of the destination
  // interface (see the table in CLAUDE.md).
  HOUSE_DEFAULT_LINE,
  HOUSE_DEFAULT_LINE_SET,
  stripReaderOnlyLines,
  // EXPORTED FOR scripts/checkSpecHealth.js, not for the destination interface.
  // Its keys are the only record in this codebase of which cited URLs are
  // STUDIES rather than platform spec pages, and the health check needs exactly
  // that distinction to tell a coverage GAP from a deliberate non-watch. Reading
  // it beats a second list, which would drift the first time a source changed
  // here and not there.
  SPEC_SOURCE_DETAIL,
  NOT_A_HARD_LIMIT,
  appendBody,
  buildVariantBlock,
  // Insert/append-path ceiling enforcement. Unit tests only, same as
  // buildVariantBlock above — not part of the destination interface.
  enforceVariationCeiling,
  // The composite (asset, field, instance) lookup key — exposed so its DEFAULT
  // serialization can be pinned byte-for-byte (it is not persisted like
  // copyReview's fieldKey, but a drift would silently mis-place drafted copy).
  ctxKey,
  // The instance-heading format, both directions. Exposed so the round trip
  // (render → read → key) is assertable without a Google client.
  assetHeadingText,
  decomposeAssetHeading,
  instanceHeadingMap,
};
