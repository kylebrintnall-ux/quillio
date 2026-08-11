'use strict';

// Copy-review orchestration (copy-review feature). Reviews a generated copy doc
// like a thoughtful editor and leaves comments only where a material issue
// genuinely warrants it — silence is a good outcome.
//
// THE COMMENTS ARE UNANCHORED. Drive cannot pin a comment to a region of a native
// Google Doc, and pretending otherwise is what made every review comment render as
// "Original content deleted" — see the review-section header in
// destinations/googleDocs.js. Each comment instead LEADS with a locator line
// naming its field and asset, then a short verbatim fragment of the copy, then the
// note. See "The comment LOCATOR" below.
//
// Flow:
//   1. getDocContent parses the doc; we evaluate ONLY fields with non-empty copy
//      (labels, notes, asset/group headings, direction, summary, references, and
//      the header table are already separated out by getDocContent).
//   2. Load the tenant's brand guide (getVoiceGuide, repo voice.md fallback).
//      gemini.js pairs it with the repo craft.md, which always applies — the
//      review judges against both craft and brand.
//   3. Load prior review state (per-field prior copy + prior comment) so Gemini
//      can recognize the writer's improvements and not re-nag.
//   4. Gemini returns a per-field comment or null (materiality/silence bar).
//   5. Reconcile against the doc's existing Quillio comments (matched by content,
//      else by locator) and post only the newly-warranted ones. Resolved issues
//      simply disappear.
//   6. Persist the new state; return a digest + qualitative status (no grade).

const { getDestination } = require('../destinations');
const { reviewCopyFields, reviewVariationStack } = require('./gemini');
const { getVoiceGuide, getReviewState, saveReviewState } = require('../db');
const { isNumberedStack, stripSoloLabel, parseNumberedStack } = require('../utils/variants');
const { instanceTag, reviewUnitKey, instanceCounter } = require('../utils/instanceKey');

// Repo voice.md fallback — the BRAND half only, loaded once (same source
// gemini.js uses for drafting). The craft half (craft.md) is added by gemini.js
// and is never replaced by tenant content.
let repoVoice = null;
function repoVoiceGuide() {
  if (repoVoice != null) return repoVoice;
  try {
    repoVoice = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'voice.md'), 'utf8');
  } catch {
    repoVoice = '';
  }
  return repoVoice;
}

// Reconcile/state key for one review unit — `fieldKey(assetType, fieldName,
// instance)`. THE shared implementation, not a local one: it is an alias for
// utils/instanceKey.reviewUnitKey, which gemini.reviewCopyFields' result-matching
// map also calls. That map used to carry its own inline copy of this template,
// free to drift from this one; now there is a single definition.
//
// `instance` is the asset's 0-based instance ordinal, for a doc carrying the same
// asset more than once. It defaults to 0, which serializes to nothing at all, so
// `fieldKey(a, f)` and `fieldKey(a, f, 0)` are byte-identical to each other and to
// the pre-instance key. That is load-bearing, not cosmetic: these strings are the
// jsonb object keys persisted in doc_reviews.state, so a changed default would
// orphan every tenant's stored review state.
const fieldKey = reviewUnitKey;

// The instance ordinal for one asset entry from getDocContent. Prefers the
// ordinal the READER stamped (the authority: it saw document order). Falls back
// to counting when absent, so a hand-built `content` — tests, or any future
// caller that assembles asset lists itself — still distinguishes repeated names
// instead of silently collapsing them to 0.
function assetInstance(asset, countFallback) {
  return asset && asset.instance != null ? asset.instance : countFallback(asset && asset.name);
}

// Flatten getDocContent → the SINGLE-copy reviewable fields (non-empty). Numbered
// STACKS are handled separately by the variant-aware path (collectVariationStacks
// + reviewVariationStack), so they're routed out here, not reviewed as one blob.
// A SOLO labeled variation (`(Reframe) …`) is already resolved and IS reviewed —
// its leading doorway tag is stripped so the length/voice check sees the sentence.
// Each unit carries its asset's `instance` ordinal (0 for the first/only
// occurrence of that asset name), counted over getDocContent's positional asset
// list so repeated headings stay distinguishable downstream.
//
// The units carry charMax and fieldType but deliberately NOT charMin. The floor
// exists to stop a field being structurally empty; handed to the reviewer it
// became "142 characters, short of the 150-character minimum — expand slightly",
// i.e. an instruction to pad. gemini.LENGTH_RULE tells the model not to; not
// carrying the number is what makes that unfalsifiable. Do not add it back —
// judging "this CTA has no verb" needs no count.
//
// RE-EXAMINED 2026-08-05 AND HELD. The house-default work let a tenant set a
// character floor for the first time, one drafted under it, and the obvious
// follow-up was a deterministic under-minimum note computed HERE in code — no
// model, no LENGTH_RULE change, so none of the padding advice above could come
// back. It was designed and then not built, because the premise was wrong rather
// than the mechanism: the draft that came in at 32 against a floor of 40 was
// BETTER than the band, and a note flagging it would have flagged the best line
// in the document.
//
// So the rule is not "the model must not be trusted with a floor". It is that
// UNDER A FLOOR IS NOT A DEFECT. Copy that says the thing in fewer characters
// beats copy padded to reach a number, whoever is doing the counting and however
// the note is worded. Only the ceiling is enforced: over is a defect, under is a
// choice. A deterministic check would have been technically clean and would
// still have been telling writers off for being concise.
//
// The floor is not useless — it belongs in the DRAFT prompt, where it tells the
// model where the useful range is (see gemini.lengthClause). It does not belong
// in a review, where it can only ever be an accusation.
function collectCopyFields(content) {
  const out = [];
  const ordinal = instanceCounter();
  for (const asset of (content && content.assets) || []) {
    const instance = assetInstance(asset, ordinal);
    for (const f of asset.fields || []) {
      const raw = String(f.copy || '').trim();
      if (!raw) continue;
      if (isNumberedStack(raw)) continue; // an unresolved stack → the variant path handles it
      const copy = stripSoloLabel(raw).trim();
      // `label` rides along for the comment LOCATOR only — it is the doc's own bold
      // label, and it never reaches a prompt (singleInputs below picks its keys
      // explicitly). Note it carries the char MIN when the doc shows one, which the
      // review units deliberately do not; that is safe for the same reason.
      if (copy) out.push({ assetType: asset.name, instance, fieldName: f.fieldName, label: f.label || '', charMax: f.charMax || 0, fieldType: f.fieldType || 'text', copy });
    }
  }
  return out;
}

// getDocContent → the unresolved NUMBERED STACKS, each with its parsed options.
// [{ assetType, instance, fieldName, charMax, variations: [{ index, doorway, copy, line }] }].
function collectVariationStacks(content) {
  const out = [];
  const ordinal = instanceCounter();
  for (const asset of (content && content.assets) || []) {
    const instance = assetInstance(asset, ordinal);
    for (const f of asset.fields || []) {
      const raw = String(f.copy || '').trim();
      if (!raw || !isNumberedStack(raw)) continue;
      const variations = parseNumberedStack(raw);
      if (variations.length >= 2) {
        out.push({ assetType: asset.name, instance, fieldName: f.fieldName, label: f.label || '', charMax: f.charMax || 0, fieldType: f.fieldType || 'text', variations });
      }
    }
  }
  return out;
}

// The ` · option N (Doorway)` tail. ONE definition, because it is now produced in
// two places that must agree character for character: the state key below, and the
// comment LOCATOR. keyInScope also recognizes a variation's state key by this
// suffix, so a drift here would silently unscope every variation.
function optionSuffix(index, doorway) {
  return ` · option ${index}${doorway ? ` (${doorway})` : ''}`;
}

// Stable reconcile/state key for one variation of a stack. Content-matching in
// reconcileComments tolerates index drift; this just has to be deterministic.
function variationFieldName(fieldName, index, doorway) {
  return `${fieldName}${optionSuffix(index, doorway)}`;
}

// --- The comment LOCATOR: how an unanchored comment says where it belongs ------
//
// Drive cannot pin a comment to a region of a Google Doc (see the header of
// destinations/googleDocs.js's review section). So the location travels in the
// comment TEXT, on its own first line, and that line does two jobs:
//
//   1. a reader in Docs can tell which field the note is about, and scan for it;
//   2. re-review can find its own previous comment WITHOUT the anchor, which is
//      what keeps a second pass from posting a duplicate of every note.
//
// It must therefore be unique per review unit and stable across a copy edit. The
// field label alone is neither — two assets can both have "Headline [50]" — so the
// asset (with its instance tag) is on the line too.

// Fallback when the doc's own bold label wasn't carried. Real documents always
// supply `label` (getDocContent reads the paragraph verbatim); this covers a
// hand-built `content` — tests, or any caller assembling asset lists itself — and
// is deliberately the simplest thing that still names the field.
function fallbackLabel(f) {
  const max = Number(f && f.charMax) || 0;
  const name = String((f && f.fieldName) || '').trim();
  if (!max) return name;
  return `${name} [${max}${f.fieldType === 'words' ? ' words' : ''}]`;
}

// `<field label as the doc renders it>[ · option N (Doorway)] — <Asset>[#iN]`
function composeLocator(labelPart, assetType, instance) {
  return `${labelPart} — ${String(assetType || '').trim()}${instanceTag(instance)}`;
}

// The locator for one review unit. Prefers the one runCopyReview built from the
// doc's own label; falls back to reconstructing.
function unitLocator(f) {
  if (f && f.locator) return f.locator;
  return composeLocator(fallbackLabel(f), f && f.assetType, f && f.instance);
}

// The model's own words for a field, out of persisted state. State written before
// the unanchoring kept them in `comment`; state written since keeps the posted
// BODY there and the words in `note`. Reading through this fallback is what lets an
// existing tenant's doc_reviews row keep working with no migration — and it is why
// the digest and the "here is what you said last time" prompt input never show a
// reader the locator line.
function priorNote(p, fallback) {
  if (p && p.note != null) return p.note;
  if (p && p.comment != null) return p.comment;
  return fallback != null ? fallback : null;
}

// Read a locator back off a comment: its first line. A comment posted before this
// change has a note there instead, which matches no constructed locator — so it is
// simply not found this way, and the content matcher (which is exact, and is what
// legacy state holds) handles it. That is the whole migration.
function locatorOf(content) {
  const first = String(content || '').split('\n')[0].trim();
  return first || null;
}

// A SHORT verbatim fragment of the copy — enough to recognize the line on the
// page, short enough to survive the trim/stripSoloLabel transformations the copy
// has already been through. Not a reconstruction of the field: a whole-field quote
// was what the anchor used to carry, and it is exactly the thing that could not be
// kept faithful. Whitespace is collapsed because a fragment must not span the
// paragraph joins getDocContent introduces.
const FRAGMENT_WORDS = 8;
const FRAGMENT_CHARS = 60;
function copyFragment(copy) {
  const flat = String(copy || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const take = [];
  for (const w of flat.split(' ')) {
    if (take.length >= FRAGMENT_WORDS) break;
    if (take.length && take.join(' ').length + 1 + w.length > FRAGMENT_CHARS) break;
    take.push(w);
  }
  const frag = take.join(' ');
  return frag.length < flat.length ? `${frag}…` : frag;
}

// The posted comment body: locator, fragment, then the note EXACTLY as the model
// wrote it. This string is also what gets persisted as the field's `comment` and
// what listReviewComments reads back, so the three are the same bytes by
// construction rather than by agreement.
function composeComment(locator, copy, note) {
  const frag = copyFragment(copy);
  return `${frag ? `${locator}\n“${frag}”` : locator}\n\n${note}`;
}

// THE LOCATOR IS DISPLAYED VERBATIM AND MATCHED LOOSELY, and the split is the
// point. The line a reader sees has to carry the limit exactly as the document
// shows it; the string we MATCH on must survive that limit changing. LiveSpecs
// approving a new character limit turns "Headline [50]" into "Headline [55]", and
// on the strict string that is a comment nothing can find — so the note would be
// posted a second time beside the one already there.
//
// Only the FIRST bracket goes: it is the field label's, and a field has exactly
// one per asset, so nothing collides once it is dropped.
function normLocator(locator) {
  return String(locator || '').replace(/\s*\[[^\]]*\]/, '').trim();
}

// Does this comment body carry a locator at all — i.e. did WE compose it in this
// format? Structural, not a guess: composeComment always puts a curly-quoted
// fragment on line 2 and a blank line 3, and both sides of that are ours.
//
// It exists to protect comments posted BEFORE the unanchoring, whose first line is
// the note itself. Without this check the scoped sweep below would read that note
// as a locator, find it inactive, and delete a comment on a field the writer never
// selected.
function hasLocatorShape(content) {
  const lines = String(content || '').split('\n');
  return lines.length >= 3 && lines[2] === '' && /^“.*”$/.test(lines[1]);
}

// Collector output → review UNITS: one per single field, one per stack variation,
// each carrying the LOCATOR its comment will lead with. Built here because this is
// the only place holding the doc's own label, the asset and (for a stack) the
// option number at once — and used twice, for the units being reviewed and for the
// sweep's set of every locator still live in the document, so the two can never
// disagree about how a locator is spelled.
function buildUnits(singles, stacks) {
  const units = [];
  for (const f of singles || []) {
    units.push({
      assetType: f.assetType,
      instance: f.instance,
      fieldName: f.fieldName,
      charMax: f.charMax,
      fieldType: f.fieldType,
      copy: f.copy,
      locator: composeLocator(f.label || fallbackLabel(f), f.assetType, f.instance),
    });
  }
  for (const st of stacks || []) {
    for (const v of st.variations || []) {
      units.push({
        assetType: st.assetType,
        instance: st.instance,
        fieldName: variationFieldName(st.fieldName, v.index, v.doorway),
        charMax: st.charMax,
        fieldType: st.fieldType,
        copy: v.line,
        locator: composeLocator(
          `${st.label || fallbackLabel(st)}${optionSuffix(v.index, v.doorway)}`,
          st.assetType,
          st.instance
        ),
      });
    }
  }
  return units;
}

// Choose the review targets. Whole-doc (scopeKeys null) → every single + stack,
// no sibling context. Scoped → only the selected fields, each carrying its ASSET
// CONTEXT (its sibling fields' current copy) so the review can judge it in place
// and flag cross-field interactions. Pure.
function selectReviewTargets(content, scopeKeys) {
  const singles = collectCopyFields(content);
  const stacks = collectVariationStacks(content);
  // `all` is the UNFILTERED set. The orphan sweep needs every unit's locator, not
  // just the selected ones, to tell a comment whose field is gone from a comment
  // whose field simply was not selected this time.
  const all = { singles, stacks };
  if (!scopeKeys) return { singles, stacks, all, scoped: false };

  // Per-asset list of every non-empty field's { fieldName, copy } (for siblings).
  //
  // Keyed by (asset name, instance ordinal), NOT by name alone. A doc carrying the
  // same asset heading twice (today only reachable by hand-editing — pasting an
  // asset section) used to collapse here: the later occurrence overwrote the
  // earlier, so BOTH instances were handed the LAST one's sibling copy as context
  // and the review judged instance 1's fields against instance 2's neighbours.
  // Reuses fieldKey with an empty field name so the asset half normalizes and
  // tags exactly the way the scope keys below do.
  const assetKey = (assetName, instance) => fieldKey(assetName, '', instance);
  const byAsset = new Map();
  const ordinal = instanceCounter();
  for (const asset of (content && content.assets) || []) {
    const list = [];
    for (const f of asset.fields || []) {
      const raw = String(f.copy || '').trim();
      if (raw) list.push({ fieldName: f.fieldName, copy: raw });
    }
    byAsset.set(assetKey(asset.name, assetInstance(asset, ordinal)), list);
  }
  const siblingsFor = (assetName, fieldName, instance) =>
    (byAsset.get(assetKey(assetName, instance)) || [])
      .filter((s) => s.fieldName !== fieldName)
      .map((s) => ({ fieldName: s.fieldName, copy: stripSoloLabel(s.copy).trim() }));

  const inScope = (assetType, fieldName, instance) => scopeKeys.has(fieldKey(assetType, fieldName, instance));
  return {
    scoped: true,
    all,
    singles: singles
      .filter((f) => inScope(f.assetType, f.fieldName, f.instance))
      .map((f) => ({ ...f, siblings: siblingsFor(f.assetType, f.fieldName, f.instance) })),
    stacks: stacks
      .filter((st) => inScope(st.assetType, st.fieldName, st.instance))
      .map((st) => ({ ...st, siblings: siblingsFor(st.assetType, st.fieldName, st.instance) })),
  };
}

// Is a persisted-state key within the scope of this review? True for a selected
// field's own key OR any of its variation keys ("…field · option N (Door)").
// Used to (a) restrict the orphan sweep and (b) refresh only in-scope state.
function keyInScope(key, scopeKeys) {
  if (scopeKeys.has(key)) return true;
  for (const sk of scopeKeys) {
    if (key.startsWith(`${sk} · option`)) return true;
  }
  return false;
}

// Comment ids to sweep. Whole-doc: any live Quillio comment bound to no current
// unit is a true orphan. Scoped: sweep ONLY orphans that belonged to an in-scope
// field/variation — so an unselected field's comment from a previous whole-doc
// review is never touched.
//
// EVERY CANDIDATE HERE IS ALREADY KNOWN TO BE QUILLIO'S. `liveComments` comes from
// listReviewComments, which keeps a comment only if its content starts with
// REVIEW_PREFIX; a human's comment never enters this list and so can never be
// swept. That prefix filter is the whole of the authorship test, and it is the
// reason this function can delete by id without re-checking.
//
// `activeLocatorKeys` is the normalized locator of EVERY unit in the document —
// not just the in-scope ones. It closes the case the content rule cannot see: a
// comment whose locator changed underneath it (the asset heading was renamed, or
// state was lost and the field label moved) belongs to no current unit at all, so
// it is stale regardless of scope. Without it, a scoped review left the old
// comment sitting beside the new one, and only a later WHOLE-DOC review cleaned up.
//
// Guarded two ways, because "no active locator" is also true of things we must not
// touch: the comment must carry a locator in the first place (hasLocatorShape —
// a comment from before the unanchoring does not, and its note text must never be
// read as a locator), and a unit that still exists keeps its comment because its
// locator is still active.
function orphanSweepIds({ liveComments, claimedIds, toDelete, scopeKeys, priorFields, activeLocatorKeys }) {
  const claimed = new Set(claimedIds);
  const deleting = new Set(toDelete);
  const candidates = (liveComments || []).filter((c) => !claimed.has(c.id) && !deleting.has(c.id));
  if (!scopeKeys) return candidates.map((c) => c.id);
  // Prior comments that belonged to in-scope keys — these may be swept.
  const inScopePriorComments = new Set();
  for (const [key, entry] of Object.entries(priorFields || {})) {
    if (entry && entry.comment && keyInScope(key, scopeKeys)) inScopePriorComments.add(String(entry.comment));
  }
  // ABSENT MEANS OFF, NOT EMPTY — the drift sweep is a DELETE keyed on a negative
  // ("no unit claims this"), so a missing set must disable it rather than make it
  // vacuously true of everything. Defaulting to an empty Set deleted every
  // locator-shaped comment on the doc; a test pins it.
  const active = activeLocatorKeys instanceof Set ? activeLocatorKeys : null;
  const strandedByDrift = (c) =>
    !!active && hasLocatorShape(c.content) && !active.has(normLocator(locatorOf(c.content)));
  return candidates
    .filter((c) => inScopePriorComments.has(String(c.content)) || strandedByDrift(c))
    .map((c) => c.id);
}

// A supportive, non-numeric read of overall quality (never a grade/score).
//
// These are HEADLINES — Slack renders them as the review message's lead line and
// the web app as .review-status — so they are punctuated as the sentences a
// reader takes them for, not as UI labels. (A button label stays bare; a line of
// copy someone reads does not.) One function, both surfaces, one rule.
function qualitativeStatus(flagged, total) {
  if (total === 0) return 'Nothing to review yet.';
  if (flagged === 0) return 'Looking strong. ✨';
  const ratio = flagged / total;
  if (ratio <= 0.25) return 'A few things to tighten.';
  if (ratio <= 0.6) return 'Worth another pass.';
  return 'Some rework to do.';
}

// The high-level shape of the result (not the individual notes — those live in
// the doc), to drive the writer to open the doc for specifics.
function buildDigest(results) {
  const total = results.length;
  const flagged = results.filter((r) => r.comment).length;
  const clean = total - flagged;
  if (total === 0) return 'No drafted copy to review yet.';
  if (flagged === 0) return `Reviewed ${total} field${total === 1 ? '' : 's'} — all clean. Nothing to change.`;
  // Distinct asset INSTANCES, so two instances of one asset read as two assets.
  // Only .size is used, and units without an instance produce one entry each
  // exactly as before, so the sentence is unchanged for a single-instance doc.
  const assets = new Set(results.filter((r) => r.comment).map((r) => `${r.assetType}${instanceTag(r.instance)}`));
  return (
    `Reviewed ${total} field${total === 1 ? '' : 's'}: ${clean} clean, ${flagged} with a note ` +
    `across ${assets.size} asset${assets.size === 1 ? '' : 's'}. Open the doc for the inline notes.`
  );
}

// Reconcile the currently-warranted per-field verdicts against the doc's EXISTING
// Quillio comments + stored prior state — instead of destructively clearing and
// reposting. Pure (no I/O): returns the add/delete plan, the next state to persist,
// and the active per-field results (for the digest). Decision table per field:
//   • resolved comment + copy UNCHANGED → respect dismissal (keep, never re-add).
//   • copy UNCHANGED + existing (unresolved) → keep in place (no delete/repost).
//   • copy UNCHANGED + no comment + a genuine verdict → add.
//   • copy CHANGED + verdict null (fixed) → delete the stale comment.
//   • copy CHANGED + verdict note → replace: delete stale + add anchored to new copy.
//   • new field / no prior + verdict note → add.
// A comment vanishes ONLY when the writer fixed the copy or manually resolved it.
//   fields: [{ assetType, instance, fieldName, copy }]  (instance optional → 0)
//   priorFields: { key: { copy, comment, resolved } }
//   verdicts: [{ assetType, instance, fieldName, comment }] (comment: string|null)
//   liveComments: [{ id, content, resolved, quote }]
function reconcileComments({ fields, priorFields, verdicts, liveComments } = {}) {
  const prior = priorFields || {};
  const verdictByKey = new Map();
  for (const v of verdicts || []) {
    const c = v && typeof v.comment === 'string' && v.comment.trim() ? v.comment.trim() : null;
    verdictByKey.set(fieldKey(v.assetType, v.fieldName, v.instance), c);
  }
  // Index live comments two ways. CONTENT is the reliable key: Google does not
  // change a comment's text when the doc is edited, so it still matches the stored
  // priorComment after a fix.
  //
  // THE FALLBACK USED TO BE THE QUOTE, AND IT CANNOT BE ANY MORE. `c.quote` is
  // quotedFileContent read back, and nothing sends one now — it is '' on every
  // comment this code posts, so a quote index would collapse every row onto one
  // key and match nothing. Its replacement is the LOCATOR (the comment's first
  // line), which is strictly better at the job the quote was doing: it identifies
  // the review unit rather than its copy, so it does not change when the writer
  // edits the field. That is why the old two quote lookups (current copy, then
  // prior copy) are one lookup now. First occurrence wins for each key.
  const byContent = new Map();
  const byLocator = new Map();
  for (const c of liveComments || []) {
    if (typeof c.content === 'string' && !byContent.has(c.content)) byContent.set(c.content, c);
    const loc = locatorOf(c.content);
    const norm = loc ? normLocator(loc) : null;
    if (norm && !byLocator.has(norm)) byLocator.set(norm, c);
  }

  const toAdd = [];
  const toDelete = [];
  const nextState = { fields: {} };
  const results = [];
  const activeLocators = new Set(); // locators that will carry a live comment after reconcile
  const claimed = new Set(); // comment ids already bound to a field (no double-match)
  let kept = 0;
  let added = 0;
  let removed = 0;

  // THIS GUARD USED TO BE KEYED ON THE COPY, and that was an anchoring workaround:
  // two comments quoting identical text would have made Drive pick one of them, so
  // the second was dropped. Nothing is quoted now, so identical copy in two fields
  // is no longer a collision — and dropping the second field's note was a real
  // loss (two instances of one asset holding the same headline each deserve their
  // own). Keyed on the LOCATOR it keeps the invariant that still matters: never
  // two comments for one review unit.
  const planAdd = (key, locator, content) => {
    if (activeLocators.has(locator)) {
      console.warn(`[review] two comments for one review unit (${locator}) — skipping the second`);
      return false;
    }
    toAdd.push({ key, locator, content });
    activeLocators.add(locator);
    added += 1;
    return true;
  };

  for (const f of fields) {
    const key = fieldKey(f.assetType, f.fieldName, f.instance);
    const cur = String(f.copy || '');
    const locator = unitLocator(f);
    const p = prior[key] || {};
    const priorCopy = p.copy != null ? String(p.copy) : null;
    const changed = priorCopy == null ? true : cur !== priorCopy;
    const verdict = verdictByKey.has(key) ? verdictByKey.get(key) : null;
    // What Drive is holding for this field (the composed body), and the model's own
    // words inside it. State written before the unanchoring has only the latter, in
    // `comment` — priorNote falls back to it, which is what makes an existing
    // tenant's stored state keep working without a migration.
    const priorComment = p.comment != null ? String(p.comment) : null;
    // Match this field's existing comment. Content first (exact, and what legacy
    // state holds), then the locator for state-loss cases. Never bind one comment
    // to two fields.
    let existing = (priorComment && byContent.get(priorComment)) || byLocator.get(normLocator(locator)) || null;
    if (existing && claimed.has(existing.id)) existing = null;
    if (existing) claimed.add(existing.id);

    // Manual dismissal on UNCHANGED copy → respect it; never re-add. Honor a
    // persisted dismissal too, in case the resolved comment later disappeared.
    if (!changed && ((existing && existing.resolved) || p.resolved === true)) {
      if (existing) { activeLocators.add(locator); kept += 1; }
      nextState.fields[key] = {
        copy: cur,
        comment: (existing && existing.content) || p.comment || null,
        note: priorNote(p, existing && existing.content),
        resolved: true,
      };
      results.push({ assetType: f.assetType, instance: f.instance, fieldName: f.fieldName, comment: null }); // dismissed → not an active note
      continue;
    }

    let activeComment = null; // the body in Drive
    let activeNote = null; // the model's words, for the digest and the next prompt
    if (!changed) {
      if (existing) {
        // Leave the existing unresolved comment exactly in place.
        activeLocators.add(locator);
        kept += 1;
        activeComment = existing.content;
        activeNote = priorNote(p, existing.content);
      } else if (verdict) {
        if (planAdd(key, locator, composeComment(locator, cur, verdict))) {
          activeComment = composeComment(locator, cur, verdict);
          activeNote = verdict;
        }
      }
    } else {
      // Copy changed → the matched comment quotes the old line and is stale.
      if (existing) {
        toDelete.push(existing.id);
        removed += 1;
      } else if (priorComment) {
        // We previously flagged this field but can't find the comment now — it may
        // have been deleted by hand or lost with state. Log it so a lingering
        // comment on a fixed field is diagnosable.
        console.warn(`[review] changed field "${key}" had a prior comment but no live match to remove`);
      }
      if (verdict && planAdd(key, locator, composeComment(locator, cur, verdict))) {
        activeComment = composeComment(locator, cur, verdict); // replace / re-flag
        activeNote = verdict;
      }
      // verdict null → issue fixed by the edit; stale comment already deleted.
    }

    nextState.fields[key] = { copy: cur, comment: activeComment, note: activeNote, resolved: false };
    results.push({ assetType: f.assetType, instance: f.instance, fieldName: f.fieldName, comment: activeNote || activeComment });
  }

  // claimedIds = every live comment bound to a current review unit (kept OR
  // slated for delete). Live comments NOT in this set belong to units that no
  // longer exist — e.g. a stack the writer resolved down — and are swept.
  return {
    toAdd,
    toDelete,
    nextState,
    results,
    counts: { kept, added, removed },
    claimedIds: [...claimed],
  };
}

// Run a review pass on a doc. `clients` runs Drive/Docs as the tenant's user;
// `tenantId` selects the voice guide. Returns
//   { reviewed, flagged, clean, digest, status, hadCopy }.
// Throws on a hard failure so callers can show an error state.
async function runCopyReview(docId, tenantId, clients, scopedFields) {
  const dest = getDestination();
  const content = await dest.getDocContent(docId, clients);

  // Scoped review: when the writer selected fields, review ONLY those (each with
  // its asset/sibling context) and comment only on them. Absent → whole-doc.
  const scopeKeys =
    Array.isArray(scopedFields) && scopedFields.length > 0
      ? new Set(scopedFields.map((t) => fieldKey(t.assetType, t.fieldName, t.instance)))
      : null;
  const { singles: singleFields, stacks, all, scoped } = selectReviewTargets(content, scopeKeys);

  if (singleFields.length === 0 && stacks.length === 0) {
    const digest = scoped
      ? 'Nothing to review in the selected field(s) yet.'
      : 'Nothing to review yet — this doc has no drafted copy.';
    // Same headline as qualitativeStatus(0, 0), and punctuated the same way.
    return { reviewed: 0, flagged: 0, clean: 0, hadCopy: false, digest, status: qualitativeStatus(0, 0) };
  }

  // Voice guide: tenant override, else repo voice.md.
  let voiceGuide = null;
  try {
    if (tenantId) voiceGuide = await getVoiceGuide(tenantId);
  } catch (err) {
    console.warn('[review] voice guide lookup failed — using repo voice.md:', err.message);
  }
  if (!voiceGuide) voiceGuide = repoVoiceGuide();

  // Prior state for re-review reasoning (keyed by fieldKey, incl. per-variation).
  let prior = null;
  try {
    prior = await getReviewState(docId);
  } catch (err) {
    console.warn('[review] prior review state lookup failed — treating as first review:', err.message);
  }
  const priorFields = (prior && prior.fields) || {};
  const priorFor = (assetType, fieldName, instance) => priorFields[fieldKey(assetType, fieldName, instance)] || {};

  // Brief context: the campaign's summary + writer direction carry the brief's
  // stated audience/goal. The BRIEF's audience is authoritative (the brand
  // guide's is a default it overrides); craft.md + the brand guide still govern
  // craft and voice. It also lets
  // the variant review infer funnel stage. No new persisted state.
  const briefContext = {
    summary: (content && content.summary) || '',
    writerDirection: (content && content.writerDirection) || '',
  };

  // --- Review UNITS. One per single field; one per stack VARIATION. Each unit's
  // `copy` is what a comment anchors to and what change-detection compares: a
  // single field's copy, or a variation's full "N. (Doorway) …" doc line (unique
  // via its number). reconcile keys/persists on (assetType, instance, fieldName). ---
  //
  // Each unit also carries its LOCATOR — the line the comment leads with, built
  // here because this is the only place holding the doc's own label, the asset and
  // (for a stack) the option number at the same time.
  const units = buildUnits(singleFields, stacks);
  // Every unit in the DOCUMENT, in scope or not — the sweep's "does this comment
  // still belong to something" test. Built through buildUnits so a locator here is
  // produced by the same line of code as the locator on a posted comment.
  const activeLocatorKeys = new Set(buildUnits(all.singles, all.stacks).map((u) => normLocator(u.locator)));

  // --- Verdicts. Single fields → the batch review; each stack → its own focused
  // variant review, run concurrently. ---
  const singleInputs = singleFields.map((f) => {
    const p = priorFor(f.assetType, f.fieldName, f.instance);
    // priorComment is what the model is told it said last time, so it is the NOTE,
    // never the posted body — the locator and the fragment are addressed to a human
    // reading the doc and would just be noise in the prompt.
    return { assetType: f.assetType, instance: f.instance, fieldName: f.fieldName, charMax: f.charMax, fieldType: f.fieldType, copy: f.copy, priorCopy: p.copy || null, priorComment: priorNote(p) || null, siblings: f.siblings || [] };
  });
  const rawSingleVerdicts = singleInputs.length
    ? await reviewCopyFields({ fields: singleInputs, voiceGuide, briefContext, scoped })
    : [];
  // reviewCopyFields returns exactly one verdict per input, in input order, echoing
  // each input's own assetType/fieldName — but it rebuilds the objects and so does
  // NOT carry `instance` through. Re-attach it positionally instead of trusting the
  // model round trip to preserve it.
  const singleVerdicts = rawSingleVerdicts.map((v, i) => {
    const src = singleInputs[i];
    return src ? { ...v, instance: src.instance } : v;
  });

  const stackResults = await Promise.all(
    stacks.map((st) => {
      const options = st.variations.map((v) => {
        const p = priorFor(st.assetType, variationFieldName(st.fieldName, v.index, v.doorway), st.instance);
        return { index: v.index, doorway: v.doorway, copy: v.copy, priorComment: priorNote(p) || null };
      });
      return reviewVariationStack({ assetType: st.assetType, fieldName: st.fieldName, charMax: st.charMax, fieldType: st.fieldType, variations: options, voiceGuide, briefContext, siblings: st.siblings || [] })
        .then((res) => ({ st, res }))
        .catch((err) => {
          console.warn(`[review] variant review failed for ${st.fieldName}: ${err.message}`);
          return { st, res: [] };
        });
    })
  );

  // Compose each variation's comment: STRATEGY, then CRAFT, then the cross-field
  // FLAG (scoped only); null when all clean.
  const variationVerdicts = [];
  for (const { st, res } of stackResults) {
    const byIndex = new Map((res || []).map((r) => [r.index, r]));
    for (const v of st.variations) {
      const r = byIndex.get(v.index) || {};
      const parts = [r.strategy, r.craft, r.flag].filter((s) => typeof s === 'string' && s.trim());
      variationVerdicts.push({
        assetType: st.assetType,
        instance: st.instance,
        fieldName: variationFieldName(st.fieldName, v.index, v.doorway),
        comment: parts.length ? parts.join(' ') : null,
      });
    }
  }
  const verdicts = [...singleVerdicts, ...variationVerdicts];

  // Reconcile over ALL units at once (content-keyed persistence: unchanged units
  // keep their comment, fixed/changed ones are replaced, resolved/dismissed ones
  // are respected).
  const liveComments = await dest.listReviewComments(docId, clients).catch((err) => {
    console.warn('[review] listReviewComments failed — treating as none:', err.message);
    return [];
  });
  const recon = reconcileComments({ fields: units, priorFields, verdicts, liveComments });

  for (const id of recon.toDelete) {
    await dest.deleteReviewComment(docId, id, clients);
  }
  // Orphan sweep — remove a comment whose unit no longer exists (a resolved stack,
  // a deleted field). Whole-doc: any unclaimed comment. Scoped: ONLY unclaimed
  // comments that belonged to an in-scope field/variation, so an UNSELECTED
  // field's comment from a previous whole-doc review is never touched.
  const sweepIds = orphanSweepIds({
    liveComments,
    claimedIds: recon.claimedIds,
    toDelete: recon.toDelete,
    scopeKeys,
    priorFields,
    activeLocatorKeys,
  });
  let swept = 0;
  for (const id of sweepIds) {
    if (await dest.deleteReviewComment(docId, id, clients)) swept += 1;
  }
  for (const a of recon.toAdd) {
    await dest.addReviewComment(docId, { content: a.content }, clients);
  }

  // Persist next state. Whole-doc replaces the whole state (it saw everything).
  // Scoped MERGES: carry every unselected field's prior state forward untouched,
  // and refresh only the in-scope keys — so the next review still reconciles the
  // fields this scoped pass didn't look at.
  let nextState = recon.nextState;
  if (scoped) {
    const mergedFields = { ...priorFields };
    for (const k of Object.keys(mergedFields)) {
      if (keyInScope(k, scopeKeys)) delete mergedFields[k]; // drop stale in-scope entries
    }
    Object.assign(mergedFields, recon.nextState.fields); // install freshly-reviewed ones
    nextState = { fields: mergedFields };
  }
  try {
    await saveReviewState(docId, nextState);
  } catch (err) {
    console.warn('[review] saveReviewState skipped:', err.message);
  }

  const reviewed = recon.results.length;
  const flagged = recon.results.filter((r) => r.comment).length;
  console.log(
    `[review] doc=${docId}${scoped ? ` scoped ${singleFields.length + stacks.length}` : ''} reviewed=${reviewed} flagged=${flagged} ` +
      `kept=${recon.counts.kept} added=${recon.counts.added} removed=${recon.counts.removed} swept=${swept}`
  );
  return {
    reviewed,
    flagged,
    clean: reviewed - flagged,
    hadCopy: true,
    digest: buildDigest(recon.results),
    status: qualitativeStatus(flagged, reviewed),
  };
}

module.exports = {
  runCopyReview,
  // exposed for unit tests
  collectCopyFields,
  collectVariationStacks,
  variationFieldName,
  selectReviewTargets,
  orphanSweepIds,
  keyInScope,
  qualitativeStatus,
  buildDigest,
  fieldKey,
  reconcileComments,
  optionSuffix,
  fallbackLabel,
  composeLocator,
  unitLocator,
  locatorOf,
  normLocator,
  hasLocatorShape,
  buildUnits,
  copyFragment,
  composeComment,
  priorNote,
};
