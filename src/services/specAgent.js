'use strict';

// LiveSpecs agentic read — the proposal the detector persists when it raises a
// flag. services/specDetector.js calls readSpecProposal() on the `changed` branch,
// with the page text that produced the changed hash still in hand, and stores the
// result on spec_review_queue.agent_proposal.
//
// WHY IT RUNS HERE AND NOT AT REVIEW TIME. specReview.getSuggestions asks the same
// question of the same page, on demand, when an admin opens the approve form. It
// keeps nothing, so every answer is computed from a fetch made days after the
// event — against a page that may have moved again, and against a hash that
// already advanced, because recordChange writes the new hash in the same
// transaction that inserts the flag. The bytes that raised the flag exist exactly
// once, in memory, in the run that raised it. This reads them there.
//
// IT IS SHADOW MODE. Nothing here writes copy_fields, and nothing on a write path
// reads what it stores: buildPreview and commitReview never look at agent_proposal,
// and the admin form renders it beside the field for a human to accept or ignore.
// Smoke tests pin both halves. The proposal is evidence for a review, never a
// substitute for one.
//
// ─── THE TWO GUARDS ─────────────────────────────────────────────────────────
//
// 1. IT MUST NEVER FAIL THE DETECTION RUN. railway.cron.json sets
//    restartPolicyType: NEVER, so an uncaught throw out of the weekly run is not a
//    retry — it is no detection until next Monday. readSpecProposal is awaited,
//    its every failure is caught, logged with a stack and swallowed, and it
//    returns a record of the failure rather than propagating it. That is the
//    shape adapters/web.js notifyDraftComplete uses for the same reason ("a
//    notification failure must never fail a draft"), and the reasoning transfers
//    exactly: a flag with no proposal is acceptable, a run that died recording one
//    is not.
//
//    The second half of that guard is NOT in this file — it is recordChange's
//    42703 fallback. The INSERT carrying agent_proposal runs inside the
//    transaction that also advances current_hash, so on a deploy that lands before
//    scripts/migrateAddAgentProposal.js an unhandled undefined-column would roll
//    back the FLAG too, and detection would stop recording anything at all while
//    reporting nothing wrong.
//
// 2. THE READ IS CAPPED PER RUN. A change to normalize() re-baselines every
//    watched page at once (CLAUDE.md, "Changing `normalize()` re-baselines every
//    affected page"), so the pathological run is not one flag, it is all of them.
//    The budget lives in the detector's RUN scope — not a module global, which
//    would leak across on-demand POST /admin/api/run-detection calls — and a flag
//    the budget refused is recorded as skipped rather than silently absent.
//
// ─── THE SHAPE, AND WHY `fields` IS SOMETIMES ABSENT ────────────────────────
//
//   null                                   no read happened: the reader is off
//                                          (no GEMINI_API_KEY, or
//                                          SPEC_AGENT_ENABLED=false). The column
//                                          is NULL and says nothing further.
//   { status: 'skipped', reason, ... }      the reader was on and declined: the
//                                          run budget was spent, or the watch row
//                                          named no fields.
//   { status: 'failed', reason, ... }       the page was read at and the model or
//                                          the fetch of values failed.
//   { status: 'read', fields: [...], ... }  the page was read. `fields: []` here
//                                          means "read, proposed nothing".
//
// `fields` IS ABSENT ON EVERY OUTCOME BUT 'read', deliberately, and it is the one
// invariant a reader of this column must not lose. `[]` is a claim about a page —
// "we looked and it stated no limit for any of these fields". A skipped read makes
// no such claim, and the case where the difference bites is already live:
// spec_watch_list.affected_fields is a snapshot nothing recomputes, so a row whose
// pairs went stale yields NO fields to propose on, and recording that as `[]`
// would report a gate problem as a page fact. Branch on `status`.
//
// Same three-state discipline as projects.field_manifest's `provenance`, for the
// same reason: a recorded absence and an unrecorded one are different facts, and
// only one of them is evidence.

const config = require('../config');
const { getPool } = require('../db');
const { currentFieldValues } = require('../db/specWatch');
const { extractSpecValuesDetailed, SPEC_EXTRACT_PROMPT_VERSION } = require('./gemini');

// NOT REQUIRED FROM HERE, AND IT CANNOT BE: services/specDetector.js requires THIS
// module, so requiring it back would close a cycle and hand one of the two a
// half-initialised copy of the other (both assign module.exports at the bottom of
// the file). That is why the run-history probe below is a local one-liner rather
// than specDetector.hasRunHistoryColumns, and why the current-value read lives in
// db/specWatch.js rather than in services/specReview.js, which every other
// LiveSpecs caller reaches it through.

// ─── Thresholds ─────────────────────────────────────────────────────────────
// THESE ARE ARGUMENTS, NOT MEASUREMENTS. Nothing in this repo has measured how
// often a correct extraction moves a limit by more than half, and the sample that
// could is the one shadow mode exists to collect. They are set to be
// OVER-INCLUSIVE on purpose: the cost of a false ambiguity is one extra look by a
// human who was going to look anyway, and the cost of a missed one is a wrong
// number approved because it arrived wearing a confidence label. When the shadow
// run has enough flags to price them, price them — do not tune them by feel.

// A proposal that moves the stored value by at least half is not thereby wrong; it
// is the size of change that deserves the page open beside it. LinkedIn Carousel's
// real conditional pair (45 against 30) is 0.33 and does NOT trip this — it is
// caught by the conditional-language and candidate triggers instead, which is the
// division of labour intended here.
const LARGE_DELTA_RATIO = 0.5;

// Above this, a "character limit" is almost certainly a pixel dimension, a file
// size or a word count the model read off the wrong table. extractSpecValues
// already bounds to 100000, which is wide enough to admit all three.
const IMPLAUSIBLE_CHAR_MAX = 5000;

// Characters either side of the located snippet searched for conditional wording.
// A limit's condition is usually in the same sentence or the row above it.
const CONDITIONAL_WINDOW = 240;

// Three is not a measurement either. It is "more than the number of pages that
// have ever changed in one real run" (the recorded maximum is 2, both Litmus, and
// those rows are no longer hash-watched) and far fewer than the eleven a
// normalize() change would flag at once.
const DEFAULT_MAX_EXTRACTIONS = 3;

// Bumped when the STORED SHAPE changes, so scripts/agentProposalReport.js can
// branch rather than guess. It is not the prompt's version — that travels
// separately, as promptVersion, because the prompt can move without the shape
// moving and the shadow-mode comparison needs to see that.
const PROPOSAL_VERSION = 1;

// ─── Citation verification ──────────────────────────────────────────────────
//
// A stored proposal whose citation cannot be found in the page is worse than no
// proposal: it renders in the admin form as a quote, which is what grounding looks
// like, without being grounding. So the snippet is checked against the SAME text
// the model was given, and a miss is DEMOTED AND SURFACED — never silently
// dropped, and never silently kept.
//
// THREE TIERS, because the two ways a well-chosen quote misses are a capital
// letter and a tag boundary. That is not a guess: it is what
// scripts/migrateAddSpecAnchors.js --verify already reports, for exactly this
// reason, about the anchor strings on these same pages. A whitespace or
// case-insensitive match is a real match on a real page, so it verifies — and it
// is a weaker match than an exact one, so it also raises an ambiguity. Both facts
// are recorded rather than one being rounded to the other.

function collapseWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function verifyCitation(snippet, pageText) {
  const raw = String(snippet == null ? '' : snippet).trim();
  if (!raw) return { verified: false, tier: 'none', reason: 'no snippet returned' };
  const hay = String(pageText == null ? '' : pageText);
  if (hay.includes(raw)) return { verified: true, tier: 'exact', reason: null };

  const cHay = collapseWs(hay);
  const cSnip = collapseWs(raw);
  if (cSnip && cHay.includes(cSnip)) return { verified: true, tier: 'whitespace', reason: null };
  if (cSnip && cHay.toLowerCase().includes(cSnip.toLowerCase())) {
    return { verified: true, tier: 'case', reason: null };
  }
  return { verified: false, tier: 'none', reason: 'snippet not found in the page text' };
}

// ─── Current stored value ───────────────────────────────────────────────────
//
// The per-tenant rows collapsed to what the admin form compares against. This is
// the same collapse services/specReview.js distinctValue performs — a smoke test
// asserts the two agree on the same rows, as a consistency check between two
// files rather than as a claim about either — but it keeps more than a string,
// because two of the triggers below need to know whether there IS a number.
//
// `diverges` is a real state, not a defensive branch: commitReview matches
// copy_fields by asset and field name with NO tenant predicate, so tenants can
// and do hold different values for one pair, and distinctValue reports that as
// "45 | 30". A delta computed against that string would be a delta against
// nothing.
function collapseCurrentCharMax(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const vals = Array.from(
    new Set(list.map((r) => (r && r.char_max != null ? String(r.char_max) : '')))
  );
  const display = vals.join(' | ');
  const diverges = vals.length > 1;
  const only = vals.length === 1 ? vals[0] : '';
  const n = Number(only);
  return {
    display,
    diverges,
    tenantCount: list.length,
    numeric: !diverges && only !== '' && Number.isFinite(n) ? n : null,
  };
}

// ─── Conditional-limit detection ────────────────────────────────────────────
//
// THE CASE THIS EXISTS FOR is LinkedIn Carousel's card headline: the specs page
// publishes 45 for a carousel driving to a destination URL and 30 for one whose
// CTA opens a Lead Gen Form. One field, two published limits, and
// src/data/defaultAssets.js already carries the note explaining that the bracket
// can only hold one of them. An extraction that returns 45 with high confidence is
// not wrong about the page — it is silent about the half of the page that would
// change the answer, and silence is what this catches.
//
// Detected in CODE, deterministically, rather than by asking the model whether it
// was uncertain. A model's report of its own uncertainty is another model output
// with the same failure mode as the number; a regex over the page text either
// matched or did not, and a test can drive it with no key and no network.
const CONDITIONAL_PATTERNS = [
  ['conditional wording', /\b(?:if|when|unless|otherwise|except)\b/i],
  ['dependency wording', /\b(?:depend(?:s|ing)? on|var(?:y|ies)|differs?|based on)\b/i],
  ['alternative wording', /\b(?:with(?:out)? an?|or an?|rather than)\b/i],
  ['lead gen form', /\blead[\s-]?gen(?:eration)?\b/i],
  ['destination/click-through', /\b(?:destination url|click[\s-]?through|landing page)\b/i],
  ['per-unit wording', /\bper\s+(?:line|card|image|slide|frame|placement)\b/i],
  ['placement wording', /\b(?:placement|in[\s-]?feed|stories|reels|desktop|mobile)\b/i],
];

// Two or more DISTINCT integers sitting within the window is itself a conditional
// signal — a spec table row reading "45 (30 with a Lead Gen Form)" trips this even
// if none of the wordings above survived normalize().
function distinctNumbersIn(text) {
  const found = String(text || '').match(/\b\d{1,5}\b/g) || [];
  return Array.from(new Set(found));
}

// The window around the snippet, or the snippet alone when it could not be
// located. Searching the whole page would match conditional wording anywhere on
// it, which on a multi-format spec page is always.
function conditionalWindow(snippet, pageText) {
  const cHay = collapseWs(pageText);
  const cSnip = collapseWs(snippet);
  if (!cSnip) return '';
  const at = cHay.toLowerCase().indexOf(cSnip.toLowerCase());
  if (at < 0) return cSnip;
  return cHay.slice(Math.max(0, at - CONDITIONAL_WINDOW), at + cSnip.length + CONDITIONAL_WINDOW);
}

function detectConditional(snippet, pageText) {
  const window = conditionalWindow(snippet, pageText);
  if (!window) return { conditional: false, markers: [] };
  const markers = [];
  for (const [label, re] of CONDITIONAL_PATTERNS) if (re.test(window)) markers.push(label);
  if (distinctNumbersIn(window).length > 1) markers.push('more than one number nearby');
  return { conditional: markers.length > 0, markers };
}

// ─── Ambiguity triggers ─────────────────────────────────────────────────────
//
// EVERY ONE OF THESE FORCES A HUMAN READ. They do not reject a proposal and they
// do not hide it — they cap its confidence and say, in the admin row, what it is
// about this proposal that the reviewer has to settle. Over-inclusive by design:
// this list is tuned to catch false confidence, not to keep the queue short.
//
// The codes are stable strings because scripts/agentProposalReport.js buckets on
// them — renaming one silently re-buckets the shadow-mode history.
const AMBIGUITY = {
  CITATION_UNVERIFIED: 'citation_unverified',
  CITATION_FUZZY: 'citation_fuzzy_match',
  SNIPPET_OMITS_NUMBER: 'snippet_omits_number',
  CONDITIONAL: 'conditional_limit',
  MULTIPLE_CANDIDATES: 'multiple_candidates',
  LARGE_DELTA: 'large_delta',
  IMPLAUSIBLE: 'implausible_value',
  CURRENT_DIVERGES: 'current_value_diverges',
  CURRENT_UNKNOWN: 'current_value_unknown',
  FIRST_CHANGE: 'first_change_since_baseline',
  HISTORY_UNAVAILABLE: 'change_history_unavailable',
  PAGE_TRUNCATED: 'page_text_truncated',
};

// Whether this is the watch row's FIRST change since it was baselined.
//
// The literal reading of "baseline status" cannot occur on a proposal: the
// baseline branch of runDetection records no flag, so there is nothing to attach
// one to. What this catches is the first CHANGE after a baseline — a row with no
// prior confirmed change, whose extraction has therefore never been checked
// against a human decision, and whose one previous hash is the only evidence that
// the page holds still at all.
//
// ABSENT IS NOT ZERO. spec_watch_list's run-history columns arrive with
// scripts/migrateAddWatchRunHistory.js and db/specWatch's WATCH_TIERS drops them
// on a pre-migration database, where the honest answer is "cannot assess" rather
// than "no changes yet". That gets its OWN code and also raises an ambiguity: a
// trigger that cannot be evaluated must not read as a trigger that passed, which
// is the whole failure class this feature exists to surface.
function changeHistoryAmbiguity(row) {
  const hasColumn = !!row && Object.prototype.hasOwnProperty.call(row, 'change_count');
  if (!hasColumn) return AMBIGUITY.HISTORY_UNAVAILABLE;
  return (Number(row.change_count) || 0) === 0 ? AMBIGUITY.FIRST_CHANGE : null;
}

// Confidence is capped, never raised. The model's own label is an input; any
// ambiguity pulls it down, and an unverifiable citation pins it to the floor.
function cappedConfidence(modelConfidence, ambiguities) {
  const base = ['high', 'medium', 'low'].includes(modelConfidence) ? modelConfidence : 'low';
  if (ambiguities.includes(AMBIGUITY.CITATION_UNVERIFIED)) return 'low';
  if (ambiguities.length === 0) return base;
  return base === 'high' ? 'medium' : base;
}

// One requested field → one proposal row. Pure: every input is already in hand,
// so this is drivable with no key, no network and no database.
function buildFieldProposal({ field, extracted, pageText, rowAmbiguities, truncated }) {
  const e = extracted || {};
  const suggested = e.suggested_char_max != null ? e.suggested_char_max : null;
  const candidates = Array.isArray(e.candidates) ? e.candidates : [];
  const current = field.current;

  const cite = verifyCitation(e.snippet, pageText);
  const ambiguities = [];
  const detail = {};
  const add = (code, why) => {
    if (!ambiguities.includes(code)) ambiguities.push(code);
    if (why) detail[code] = why;
  };

  for (const code of rowAmbiguities) add(code, rowAmbiguityDetail(code));
  if (truncated) {
    add(AMBIGUITY.PAGE_TRUNCATED, 'the model saw only the first part of the page');
  }

  // THE CITATION GATE. A snippet that does not appear in the page is emptied —
  // not kept, not shown, not stored — and the fact that it was emptied is stored
  // in its place. The number survives so the reviewer can see what was proposed;
  // what does not survive is the quote that made it look sourced.
  let snippet = '';
  if (cite.verified) {
    snippet = String(e.snippet || '').trim();
    if (cite.tier !== 'exact') {
      add(AMBIGUITY.CITATION_FUZZY, `matched only after ${cite.tier} normalisation`);
    }
  } else if (suggested != null || String(e.snippet || '').trim()) {
    // Only a proposal that claims SOMETHING can fail to ground it. A field the
    // model correctly declined (null value, no snippet) is not an unverified
    // citation, and marking it as one would bury the real ones.
    add(AMBIGUITY.CITATION_UNVERIFIED, cite.reason || 'snippet not found in the page text');
  }

  if (suggested != null) {
    if (suggested > IMPLAUSIBLE_CHAR_MAX) {
      add(AMBIGUITY.IMPLAUSIBLE, `${suggested} is far outside the range of a copy-field limit`);
    }
    // A verified quote that does not contain the number it is cited for supports
    // nothing. Checked only when the quote verified — an unverified one is
    // already at the floor and a second code would just be noise on it.
    if (cite.verified && snippet && !distinctNumbersIn(snippet).includes(String(suggested))) {
      add(AMBIGUITY.SNIPPET_OMITS_NUMBER, 'the quoted text does not contain the proposed number');
    }
    if (current.diverges) {
      add(AMBIGUITY.CURRENT_DIVERGES, `tenants hold different values (${current.display})`);
    } else if (current.numeric == null) {
      add(AMBIGUITY.CURRENT_UNKNOWN, 'no single stored value to compare against');
    } else if (current.numeric > 0) {
      const ratio = Math.abs(suggested - current.numeric) / current.numeric;
      if (ratio >= LARGE_DELTA_RATIO) {
        add(AMBIGUITY.LARGE_DELTA, `${current.numeric} → ${suggested}`);
      }
    }
  }

  const distinctCandidates = Array.from(
    new Set(candidates.concat(suggested != null ? [suggested] : []))
  );
  if (distinctCandidates.length > 1) {
    add(AMBIGUITY.MULTIPLE_CANDIDATES, `the page states ${distinctCandidates.join(', ')}`);
  }

  // Conditional wording is looked for around the CITED text, so it needs one.
  if (snippet) {
    const cond = detectConditional(snippet, pageText);
    if (cond.conditional) add(AMBIGUITY.CONDITIONAL, cond.markers.join('; '));
  }

  return {
    asset: field.asset,
    field: field.field,
    currentCharMax: current.display,
    suggestedCharMax: suggested,
    snippet,
    citationTier: cite.tier,
    candidates: distinctCandidates,
    confidence: cappedConfidence(e.confidence, ambiguities),
    ambiguities,
    ambiguityDetail: detail,
  };
}

function rowAmbiguityDetail(code) {
  if (code === AMBIGUITY.FIRST_CHANGE) return 'first change since this page was baselined';
  if (code === AMBIGUITY.HISTORY_UNAVAILABLE) {
    return 'this database has no run history — run scripts/migrateAddWatchRunHistory.js';
  }
  return null;
}

// Is the reader switched on at all? No key means no extraction is possible; the
// env var is the deliberate off switch. Both produce a NULL column, because both
// mean "no agentic read happened" — which is exactly what NULL says, and is a
// different fact from a read that was attempted and declined.
function readerEnabled() {
  if (String(process.env.SPEC_AGENT_ENABLED || '').toLowerCase() === 'false') return false;
  return !!config.GEMINI_API_KEY;
}

function envMaxExtractions() {
  const n = Number(process.env.SPEC_AGENT_MAX_EXTRACTIONS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_EXTRACTIONS;
}

// ─── The entry point ────────────────────────────────────────────────────────
//
// Returns the object to store on spec_review_queue.agent_proposal, or null for
// "store NULL". NEVER THROWS — see guard 1 at the top of this file. The caller is
// the weekly cron, and the cron does not get to die because a model did.
async function readSpecProposal({ row, pageText, pageHash, budget, runner } = {}) {
  const max = budget && Number.isInteger(budget.max) ? budget.max : envMaxExtractions();
  const used = budget && Number.isInteger(budget.used) ? budget.used : 0;
  const stamp = () => ({
    version: PROPOSAL_VERSION,
    readAt: new Date().toISOString(),
    pageHash: pageHash || null,
    budget: { max, used },
  });

  try {
    if (!readerEnabled()) return null;

    if (used >= max) {
      // THE CAP IS RECORDED ON THE FLAG IT REFUSED, which is the only place the
      // fact is knowable when the row is written — whether a LATER flag in the
      // same run also capped out is not known yet. "Did this run hit its cap" is
      // then answerable by asking whether any flag in the window carries it.
      return { ...stamp(), status: 'skipped', reason: 'run_cap', capped: true };
    }

    const pairs = Array.isArray(row && row.affected_fields) ? row.affected_fields : [];
    const wanted = pairs.filter((p) => p && p.asset && p.field);
    if (wanted.length === 0) {
      // NOT `fields: []`. The watch row named no pairs, which is a fact about
      // spec_watch_list.affected_fields — a snapshot nothing recomputes — and not
      // a fact about the page.
      return { ...stamp(), status: 'skipped', reason: 'no_affected_fields', capped: false };
    }

    const text = String(pageText || '');
    if (!text.trim()) {
      return { ...stamp(), status: 'skipped', reason: 'no_page_text', capped: false };
    }

    const pool = runner || getPool();
    if (!pool) return { ...stamp(), status: 'failed', reason: 'no database', capped: false };

    const fields = [];
    for (const p of wanted) {
      const rows = await currentFieldValues(pool, p.asset, p.field);
      fields.push({ asset: p.asset, field: p.field, current: collapseCurrentCharMax(rows) });
    }

    const out = await extractSpecValuesDetailed({
      pageText: text,
      fields: fields.map((f) => ({
        asset: f.asset,
        field: f.field,
        current_char_max: f.current.display,
      })),
    });

    if (!out.ok) {
      // A model failure is NOT an empty page. This is the whole reason
      // extractSpecValuesDetailed exists beside extractSpecValues.
      return {
        ...stamp(),
        status: 'failed',
        reason: out.error || 'extraction failed',
        capped: false,
      };
    }

    const byRef = new Map();
    for (const r of out.rows) byRef.set(r.ref, r);

    const rowAmbiguities = [];
    const hist = changeHistoryAmbiguity(row);
    if (hist) rowAmbiguities.push(hist);

    const proposals = fields.map((f, i) =>
      buildFieldProposal({
        field: f,
        extracted: byRef.get(i),
        pageText: text,
        rowAmbiguities,
        truncated: !!out.truncated,
      })
    );

    return {
      ...stamp(),
      status: 'read',
      capped: false,
      // WHAT PRODUCED IT. Shadow mode's question is comparative — whether one
      // model catches conditional limits another misses — and a stored proposal
      // that cannot name the model and prompt behind it is unattributable the
      // moment either changes. Same reasoning as projects.field_manifest
      // recording the provenance sentence rather than only the columns to
      // recompute it from.
      model: config.GEMINI_MODEL || null,
      promptVersion: SPEC_EXTRACT_PROMPT_VERSION || null,
      pageTextTruncated: !!out.truncated,
      fields: proposals,
    };
  } catch (err) {
    // Logged with its stack because this is the only place it will ever be seen,
    // and then turned into a record. The detection run stands.
    console.error(
      '[specAgent] proposal failed (the flag is unaffected):',
      err && err.stack ? err.stack : err
    );
    try {
      return { ...stamp(), status: 'failed', reason: err && err.message ? err.message : String(err), capped: false };
    } catch (_) {
      // Even the record could not be built. Store NULL and keep going — there is
      // nothing above this that is allowed to fail.
      return null;
    }
  }
}

module.exports = {
  readSpecProposal,
  // Pure, and exported so each can be driven on its own with no key, no network
  // and no database. Every one of them is a claim that can be wrong quietly.
  verifyCitation,
  collapseCurrentCharMax,
  detectConditional,
  buildFieldProposal,
  cappedConfidence,
  changeHistoryAmbiguity,
  readerEnabled,
  envMaxExtractions,
  AMBIGUITY,
  PROPOSAL_VERSION,
  DEFAULT_MAX_EXTRACTIONS,
  LARGE_DELTA_RATIO,
  IMPLAUSIBLE_CHAR_MAX,
};
