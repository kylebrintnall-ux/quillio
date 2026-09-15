'use strict';

// SPEC CHECK — answer a writer's question about a character limit from the
// SEEDED LIBRARY, never from the model's own knowledge.
//
// ═══ THE ONE PROPERTY THAT MAKES THIS TRUSTWORTHY ═══════════════════════════
//
// THE MODEL NEVER SEES A NUMBER. The prompt this file builds carries asset names
// and field names and nothing else — no char_max, no char_min, no spec_note, no
// spec_source, no tier. So the model cannot report a limit from its own training
// even if it decides to: there is no limit in the prompt to repeat, and nothing
// downstream reads a number off its reply. It returns NAMES; this file looks the
// numbers up.
//
// That is the same mechanism CLAUDE.md records for withholding the source name
// from the drafting prompt, and it was chosen for the same reason stated there:
// a prohibition ("do not invent a limit") has a compliance rate, and no
// instruction in this system has ever had one of 1.0. Withholding differs in
// KIND — there is no object in the prompt, so there is nothing to reason about
// and no rate to fall below.
//
// Behind that sits a DEFENSIVE FILTER, the same belt-and-braces parseBrief uses:
// every (asset, field) pair the model returns is re-resolved against the
// library, and one that does not resolve is DROPPED. A hallucinated asset name
// therefore degrades to "not in your library" — never to a number.
//
// ═══ THE ANSWER KEY IS THE PAIR, AND DISAMBIGUATION IS THE MAIN PATH ════════
//
// Measured over the seeded library: 47 of 134 distinct field names appear on
// more than one asset, and TWENTY of those carry DIVERGENT limits.
//
//     Headline        9 assets:  70, 27, 30, 60, 40      ← five different limits
//     Body Copy       5 assets:  0-90, 25-75, 50-100, 0-300
//     Subhead        11 assets:  40-90, 20-40
//     CTA Button      8 assets:  20, 30
//     Subject Line 1  5 assets:  70, 40
//
// So "how long can a headline be?" — the single likeliest question a writer
// types mid-brief — HAS NO ANSWER. Any one number is wrong for eight of the
// nine assets, and under this feature's own provenance rule that wrong number
// ships with a real citation link and a real verification date attached to it.
// A wrong number wearing proof is worse than no feature: it is the LinkedIn-600
// shape CLAUDE.md records (a value that looks authoritative because it is in the
// shape of an authority) arriving on a new surface.
//
// THEREFORE: the key is always (asset, field). When a question names no asset
// and the field resolves to several pairs, the ANSWER IS THE LIST. Picking one
// is never an available behaviour, and `agreement` below reports whether the
// pairs agree so the surface can say so rather than leaving a reader to compare
// five cards by eye.
//
// ═══ WHAT IS NOT HERE ═══════════════════════════════════════════════════════
//
// THERE IS NO SECOND MODEL CALL, and the answer is not phrased by a model. The
// sentences are composed by utils/specTier.specTypeLine and
// utils/specFreshness.specFreshness — the SAME composers the generated document
// delegates to — so "as citable as a doc hint line" is a property of the code
// rather than a quality of some phrasing. A model asked to rewrite
// "45, or 30 with a Lead Gen Form CTA" can drop the condition, and nothing in
// this system would detect that it had.

const { getTenantLibrary } = require('../db/assets');
const { getWatchStateBySource } = require('../db/specWatch');
const { specFreshness } = require('../utils/specFreshness');
const { specTypeLine, sourceDetail } = require('../utils/specTier');
const { specSourceName } = require('../utils/specSource');
const { normalize } = require('../utils/normalize');
const { parseSpecQuestion } = require('./gemini');

// THE PAIR KEY'S SEPARATOR IS A NUL, WRITTEN AS AN ESCAPE. Third instance of a
// rule CLAUDE.md records twice (specReview.pairKey, then agentProposalReport),
// and the second instance is what made it a rule rather than a note.
//
// A space is ambiguous across two parts: ['Meta Single Image Ad Primary',
// 'Text'] and ['Meta Single Image Ad', 'Primary Text'] space-join to the same
// string, so a question about one would be answered with the other's limit —
// the exact class of wrong-number-wearing-proof this file exists to prevent.
//
// AS AN ESCAPE, NOT A LITERAL BYTE. agentProposalReport got the separator right
// and the spelling wrong: two literal NULs made git classify the whole file
// BINARY, so a 500-line diff was unreviewable. It parsed, it ran, the suite was
// green. A test asserts this file contains no literal NUL.
const SEP = '\u0000';

function pairKey(asset, field) {
  return `${normalize(asset)}${SEP}${normalize(field)}`;
}

// The unit a limit is counted in. IDENTICAL to core/pipeline rowToSpecGroup and
// to settings.html's libUnit: anything that is not 'words' is characters. Kept
// identical on purpose — the unit shown here has to be the unit the doc's [50]
// bracket means, and three surfaces disagreeing about that is worse than none
// of them saying it.
function unitFor(fieldType) {
  return fieldType === 'words' ? 'words' : 'characters';
}

// How a limit reads. Mirrors googleDocs.fieldBracket's THREE cases (a range, a
// ceiling, or no limit at all) rather than assuming a max is always present:
// char_max 0 is a real state in the library and "0 characters" would be a lie
// about a field that simply has no ceiling.
function limitText(min, max, fieldType) {
  const unit = unitFor(fieldType);
  const lo = Number(min) || 0;
  const hi = Number(max) || 0;
  if (lo > 0 && hi > 0) return `${lo}–${hi} ${unit}`;
  if (hi > 0) return `${hi} ${unit}`;
  return 'No limit set';
}

// ─── THE INDEX ──────────────────────────────────────────────────────────────
//
// Built over the WHOLE library, active and inactive. getTenantLibrary is the
// read rather than getTenantAssets for exactly that reason: getTenantAssets
// filters is_active = true, which would collapse "you have that, it is switched
// off" into "I do not have that field seeded" — a FALSE statement about a field
// that is sitting in the tenant's own library. CLAUDE.md's decision rule
// settles which way to fail: the visible failure is a tenant reading "switched
// off in Settings" and going to switch it on; the invisible one is a tenant
// being told a field does not exist and adding a duplicate of it.
//
// Both reads resolve the tenant's override to the effective value, so the
// number here is the number that tenant's documents carry — which is the whole
// point of answering from their library rather than from a spec sheet.
function buildIndex(library) {
  const byPair = new Map();
  const byField = new Map(); // normalized field name -> [entry]
  const byAsset = new Map(); // normalized asset name -> { name, is_active, fields }
  for (const asset of library) {
    byAsset.set(normalize(asset.name), asset);
    for (const field of asset.fields || []) {
      const entry = { asset, field };
      byPair.set(pairKey(asset.name, field.field_name), entry);
      const fk = normalize(field.field_name);
      if (!byField.has(fk)) byField.set(fk, []);
      byField.get(fk).push(entry);
    }
  }
  return { byPair, byField, byAsset };
}

// The vocabulary the model is given. NAMES ONLY — see the header. Inactive
// assets are included and MARKED, because a question about one has its own
// honest answer and the model cannot route to an asset it was never shown.
function vocabularyLines(library) {
  return library.map((a) => {
    const names = (a.fields || []).map((f) => f.field_name).join(' | ');
    const off = a.is_active === false ? ' [switched off]' : '';
    return `${a.name}${off}: ${names}`;
  });
}

// ─── COMPOSING ONE ANSWER ───────────────────────────────────────────────────
//
// Everything below is read out of the row or composed by the two shared
// composers. Nothing here is phrased by a model and nothing is re-derived: the
// tier sentence comes from specTypeLine (the one the document renders) and both
// provenance sentences from specFreshness (likewise).
function composeResult(entry, watchBySource) {
  const { asset, field } = entry;
  const sourceName = specSourceName(field.spec_source);
  const tier = specTypeLine(
    field.spec_type,
    sourceName,
    sourceDetail(field.spec_source),
    field.spec_overridden === true
  );

  // THE CONDITION, VERBATIM AND NEVER SUMMARISED. LinkedIn Carousel's card
  // headline is 45 to a destination URL and 30 with a Lead Gen Form CTA — one
  // field, two published limits, and the bracket can only carry one of them. The
  // other lives in spec_note, and src/data/defaultAssets.js already states the
  // rule that keeps it visible: that note is deliberately NOT in SHOW_ONCE_NOTES,
  // because "a writer on Card 4 who did not read it writes 45 into a field that
  // caps at 30 and ships a broken deliverable."
  //
  // The document's run-collapse cannot reach this surface — that suppression is
  // a property of ADJACENT paragraphs and an answer here is one field — so the
  // only way to lose the condition would be to shorten the note. Nothing does.
  const note = field.spec_note || null;

  return {
    asset: asset.name,
    field: field.field_name,
    // Absent from the doc, which only ever renders live assets. Here it is the
    // difference between two different true answers.
    active: asset.is_active !== false,
    limit: {
      min: Number(field.char_min) || 0,
      max: Number(field.char_max) || 0,
      unit: unitFor(field.field_type),
      text: limitText(field.char_min, field.char_max, field.field_type),
    },
    // The tier sentence and the offsets that locate the platform name inside it,
    // so the browser can wrap exactly that substring in a link instead of
    // string-searching a sentence it was handed. See utils/specTier's header.
    tier: tier
      ? { text: tier.text, nameStart: tier.nameStart, nameLen: tier.nameLen, kind: field.spec_type }
      : null,
    note,
    // { sourceName, sourceUrl, verified, state, machine } or null. null on the
    // 146 of 173 seeded fields carrying the quillio_default sentinel: no cited
    // page, no claim, nothing to qualify.
    freshness: specFreshness({
      specVerifiedAt: field.spec_verified_at,
      specSource: field.spec_source,
      watch: watchBySource.get(String(field.spec_source)) || null,
    }),
    // Whether THIS tenant has pinned their own number, and what Quillio's own
    // default is — so an answer that differs from the seed says why it differs
    // rather than silently disagreeing with a colleague's memory.
    overridden: field.spec_overridden === true,
    base: field.spec_overridden
      ? { text: limitText(field.base_char_min, field.base_char_max, field.field_type) }
      : null,
  };
}

// Do these pairs actually disagree? A shared field name is only a PROBLEM when
// the numbers behind it differ — 27 of the 47 shared names in the seeded library
// carry one limit everywhere, and telling a writer to choose between five
// identical answers is its own kind of unhelpful.
//
//   'single'    one pair. Nothing to disambiguate.
//   'agree'     several pairs, one limit. Answer it, and name the assets it holds for.
//   'divergent' several pairs, several limits. THE LIST IS THE ANSWER.
function agreementOf(results) {
  if (results.length <= 1) return 'single';
  const seen = new Set(results.map((r) => `${r.limit.min}-${r.limit.max}-${r.limit.unit}`));
  return seen.size === 1 ? 'agree' : 'divergent';
}

// ─── THE SCOPE REFUSAL ──────────────────────────────────────────────────────
//
// Requirement 4's wording, in ONE place. Short, and it redirects rather than
// apologising or offering to try: the panel answers questions about limits, and
// a sentence that hedges invites a second attempt at the same out-of-scope ask.
//
// THE INTENT FLAG IS THE NICETY; THE SHAPE IS THE ENFORCEMENT. Every string this
// module returns is either read from copy_fields or a fixed literal written
// here. There is no key a model's prose could travel in, so a model that decides
// to write a headline has nowhere to put it — which is what makes the narrow
// scope structural rather than a matter of the prompt holding.
const OUT_OF_SCOPE =
  'Spec Check answers questions about character limits and where they come from. ' +
  'For anything else, put it in the brief and run it.';

// ─── THE ENTRY POINT ────────────────────────────────────────────────────────
//
// Returns a plain object; does no messaging, writes nothing, and never throws
// for an unanswerable question — "I do not have that" is an ANSWER here, not an
// error, and rendering it as one would put a red box around the honest case.
async function answerSpecQuestion({ tenantId, question } = {}) {
  const q = String(question == null ? '' : question).trim();
  if (!q) return { available: true, status: 'empty', results: [], notice: null };

  const library = await getTenantLibrary(tenantId);
  // null is "no database / no tenant", which is a different screen from an empty
  // library — the same distinction routes/settings.js draws with `available`.
  if (library === null) return { available: false, status: 'no_library', results: [], notice: null };
  if (library.length === 0) {
    return {
      available: true,
      status: 'no_library',
      results: [],
      notice: 'Your asset library is empty, so there are no limits to look up yet.',
    };
  }

  const index = buildIndex(library);
  const parsed = await parseSpecQuestion({ question: q, vocabulary: vocabularyLines(library) });

  if (parsed.intent === 'out_of_scope') {
    return { available: true, status: 'out_of_scope', results: [], notice: OUT_OF_SCOPE };
  }

  // THE DEFENSIVE FILTER. Same shape as parseBrief's: the model was given the
  // vocabulary AND its output is checked against it, because being told the list
  // is not the same as being bound by it. A pair that does not resolve is
  // dropped here and reported as a miss below — it can never become a number.
  const seen = new Set();
  const results = [];
  let watchBySource = new Map();
  try {
    watchBySource = await getWatchStateBySource();
  } catch (err) {
    // A freshness line is worth having and is not worth failing a lookup for —
    // the same call routes/settings.js makes for the same read. The limit, the
    // tier and the citation all still render; only the two dated sentences go.
    console.error('[specLookup] watch state unavailable, answering without it:', err.stack || err.message);
  }

  for (const m of Array.isArray(parsed.matches) ? parsed.matches : []) {
    if (!m || !m.asset || !m.field) continue;
    const key = pairKey(m.asset, m.field);
    if (seen.has(key)) continue;
    const entry = index.byPair.get(key);
    if (!entry) continue; // not in the library → not an answer
    seen.add(key);
    results.push(composeResult(entry, watchBySource));
  }

  if (results.length > 0) {
    return {
      available: true,
      status: agreementOf(results) === 'divergent' ? 'ambiguous' : 'answer',
      agreement: agreementOf(results),
      results,
      notice: null,
    };
  }

  // Nothing resolved. WHICH KIND of nothing is the whole value of this branch —
  // see the miss taxonomy below.
  return describeMiss(parsed, index, q);
}

// ─── THE MISS TAXONOMY ──────────────────────────────────────────────────────
//
// Four different true statements, and collapsing them into "I don't have that"
// throws away the one thing the tenant could act on. Ordered most-specific
// first, because an asset we DO have is a better thing to talk about than a
// field name we cannot place.
function describeMiss(parsed, index, question) {
  const askedAssets = (Array.isArray(parsed.unmatchedAssets) ? parsed.unmatchedAssets : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const askedFields = (Array.isArray(parsed.unmatchedFields) ? parsed.unmatchedFields : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  // 1. THE ASSET EXISTS AND THE FIELD DOES NOT — the highest-value miss, because
  //    the answer teaches the field list. A writer who asked for a "preheader" on
  //    a LinkedIn ad learns what that asset actually has, which is more useful
  //    than the correction they asked for.
  for (const name of askedAssets.concat(parsed.asset ? [parsed.asset] : [])) {
    const asset = index.byAsset.get(normalize(name));
    if (!asset) continue;
    const fields = (asset.fields || []).map((f) => f.field_name);
    const wanted = askedFields.length
      ? ` doesn't have a field called ${quoteList(askedFields)}.`
      : ' has no field matching that.';
    return {
      available: true,
      status: 'field_not_found',
      results: [],
      notice: `${asset.name}${wanted}`,
      fieldList: { asset: asset.name, active: asset.is_active !== false, fields },
    };
  }

  // 2. A FIELD NAME WE KNOW, ON AN ASSET WE DO NOT. The field is real; the
  //    routing is not. Offer the assets that DO carry it rather than refusing —
  //    the writer is one pick away from an answer.
  for (const name of askedFields) {
    const entries = index.byField.get(normalize(name));
    if (!entries || entries.length === 0) continue;
    return {
      available: true,
      status: 'asset_not_found',
      results: [],
      notice:
        `${askedAssets.length ? `${quoteList(askedAssets)} isn't in your library. ` : ''}` +
        `“${entries[0].field.field_name}” is on ${entries.length} asset${entries.length === 1 ? '' : 's'} — which one?`,
      candidates: entries.map((e) => ({ asset: e.asset.name, field: e.field.field_name })),
    };
  }

  // 3. NOTHING RESOLVED AT ALL. Say what was checked and stop. NO NEAREST GUESS
  //    — parseBrief's own instruction, for the reason CLAUDE.md records at
  //    length: a plausible substitution is invisible to every gate downstream,
  //    because a mapped name is not an unmatched one.
  const named = askedAssets.concat(askedFields);
  return {
    available: true,
    status: 'not_found',
    results: [],
    notice: named.length
      ? `Couldn't match ${quoteList(named)} to your asset library. Nothing was looked up.`
      : `Couldn't tell which asset and field that's about. Try naming both — ` +
        `"LinkedIn Single Image Ad headline", say.`,
    question,
  };
}

function quoteList(names) {
  const q = names.map((n) => `“${n}”`);
  if (q.length <= 1) return q.join('');
  return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

module.exports = {
  answerSpecQuestion,
  // Exported for tests: the index and the composers are the half that has to be
  // exercisable without a model or a database.
  buildIndex,
  vocabularyLines,
  composeResult,
  agreementOf,
  limitText,
  unitFor,
  pairKey,
  describeMiss,
  OUT_OF_SCOPE,
  SEP,
};
