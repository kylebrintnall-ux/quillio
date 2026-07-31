'use strict';

// Copy-review orchestration (copy-review feature). Reviews a generated copy doc
// like a thoughtful editor and leaves inline, anchored comments only where a
// material issue genuinely warrants it — silence is a good outcome.
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
//   5. Clear previous Quillio review comments, then post the currently-warranted
//      ones anchored to each field's copy. Resolved issues simply disappear.
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
      if (copy) out.push({ assetType: asset.name, instance, fieldName: f.fieldName, charMax: f.charMax || 0, fieldType: f.fieldType || 'text', copy });
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
        out.push({ assetType: asset.name, instance, fieldName: f.fieldName, charMax: f.charMax || 0, fieldType: f.fieldType || 'text', variations });
      }
    }
  }
  return out;
}

// Stable reconcile/state key for one variation of a stack. Content-matching in
// reconcileComments tolerates index drift; this just has to be deterministic.
function variationFieldName(fieldName, index, doorway) {
  return `${fieldName} · option ${index}${doorway ? ` (${doorway})` : ''}`;
}

// Choose the review targets. Whole-doc (scopeKeys null) → every single + stack,
// no sibling context. Scoped → only the selected fields, each carrying its ASSET
// CONTEXT (its sibling fields' current copy) so the review can judge it in place
// and flag cross-field interactions. Pure.
function selectReviewTargets(content, scopeKeys) {
  const singles = collectCopyFields(content);
  const stacks = collectVariationStacks(content);
  if (!scopeKeys) return { singles, stacks, scoped: false };

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
// field/variation (matched via prior state by content) — so an unselected field's
// comment from a previous whole-doc review is never touched.
function orphanSweepIds({ liveComments, claimedIds, toDelete, scopeKeys, priorFields }) {
  const claimed = new Set(claimedIds);
  const deleting = new Set(toDelete);
  const candidates = (liveComments || []).filter((c) => !claimed.has(c.id) && !deleting.has(c.id));
  if (!scopeKeys) return candidates.map((c) => c.id);
  // Prior comments that belonged to in-scope keys — only these may be swept.
  const inScopePriorComments = new Set();
  for (const [key, entry] of Object.entries(priorFields || {})) {
    if (entry && entry.comment && keyInScope(key, scopeKeys)) inScopePriorComments.add(String(entry.comment));
  }
  return candidates.filter((c) => inScopePriorComments.has(String(c.content))).map((c) => c.id);
}

// A supportive, non-numeric read of overall quality (never a grade/score).
function qualitativeStatus(flagged, total) {
  if (total === 0) return 'Nothing to review yet';
  if (flagged === 0) return 'Looking strong ✨';
  const ratio = flagged / total;
  if (ratio <= 0.25) return 'A few things to tighten';
  if (ratio <= 0.6) return 'Worth another pass';
  return 'Some rework to do';
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
  // priorComment after a fix. QUOTE (quotedFileContent.value) is a weak fallback
  // only — after an edit Drive orphans/rewrites the anchor, so the readback value
  // equals neither the new nor the old copy, which is why quote-only matching left
  // fixed-field comments stranded. First occurrence wins for each key.
  const byContent = new Map();
  const byQuote = new Map();
  for (const c of liveComments || []) {
    if (typeof c.content === 'string' && !byContent.has(c.content)) byContent.set(c.content, c);
    if (!byQuote.has(c.quote)) byQuote.set(c.quote, c);
  }

  const toAdd = [];
  const toDelete = [];
  const nextState = { fields: {} };
  const results = [];
  const activeQuotes = new Set(); // quotes that will carry a live comment after reconcile
  const claimed = new Set(); // comment ids already bound to a field (no double-match)
  let kept = 0;
  let added = 0;
  let removed = 0;

  const planAdd = (key, quote, content) => {
    // Don't post two comments anchored to identical copy (Drive would mis-anchor).
    if (activeQuotes.has(quote)) {
      console.warn('[review] duplicate copy text — skipping an added comment to avoid mis-anchoring');
      return false;
    }
    toAdd.push({ key, quote, content });
    activeQuotes.add(quote);
    added += 1;
    return true;
  };

  for (const f of fields) {
    const key = fieldKey(f.assetType, f.fieldName, f.instance);
    const cur = String(f.copy || '');
    const p = prior[key] || {};
    const priorCopy = p.copy != null ? String(p.copy) : null;
    const changed = priorCopy == null ? true : cur !== priorCopy;
    const verdict = verdictByKey.has(key) ? verdictByKey.get(key) : null;
    const priorComment = p.comment != null ? String(p.comment) : null;
    // Match this field's existing comment. Content first (stable across edits, so
    // it locates the stale comment on a FIXED field), then quote as a fallback for
    // state-loss cases. Never bind one comment to two fields.
    let existing =
      (priorComment && byContent.get(priorComment)) ||
      byQuote.get(cur) ||
      (priorCopy != null ? byQuote.get(priorCopy) : null) ||
      null;
    if (existing && claimed.has(existing.id)) existing = null;
    if (existing) claimed.add(existing.id);

    // Manual dismissal on UNCHANGED copy → respect it; never re-add. Honor a
    // persisted dismissal too, in case the resolved comment later disappeared.
    if (!changed && ((existing && existing.resolved) || p.resolved === true)) {
      if (existing) { activeQuotes.add(cur); kept += 1; }
      nextState.fields[key] = { copy: cur, comment: (existing && existing.content) || p.comment || null, resolved: true };
      results.push({ assetType: f.assetType, instance: f.instance, fieldName: f.fieldName, comment: null }); // dismissed → not an active note
      continue;
    }

    let activeComment = null;
    if (!changed) {
      if (existing) {
        // Leave the existing unresolved comment exactly in place.
        activeQuotes.add(cur);
        kept += 1;
        activeComment = existing.content;
      } else if (verdict) {
        if (planAdd(key, cur, verdict)) activeComment = verdict;
      }
    } else {
      // Copy changed → any matched comment is stale (anchored to old text).
      if (existing) {
        toDelete.push(existing.id);
        removed += 1;
      } else if (priorComment) {
        // We previously flagged this field but can't find the comment now — it may
        // have been orphaned/renamed by the edit or lost with state. Log it so a
        // lingering comment on a fixed field is diagnosable.
        console.warn(`[review] changed field "${key}" had a prior comment but no live match to remove`);
      }
      if (verdict && planAdd(key, cur, verdict)) activeComment = verdict; // replace / re-flag
      // verdict null → issue fixed by the edit; stale comment already deleted.
    }

    nextState.fields[key] = { copy: cur, comment: activeComment, resolved: false };
    results.push({ assetType: f.assetType, instance: f.instance, fieldName: f.fieldName, comment: activeComment });
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
  const { singles: singleFields, stacks, scoped } = selectReviewTargets(content, scopeKeys);

  if (singleFields.length === 0 && stacks.length === 0) {
    const digest = scoped
      ? 'Nothing to review in the selected field(s) yet.'
      : 'Nothing to review yet — this doc has no drafted copy.';
    return { reviewed: 0, flagged: 0, clean: 0, hadCopy: false, digest, status: 'Nothing to review yet' };
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
  const units = [];
  for (const f of singleFields) {
    units.push({ assetType: f.assetType, instance: f.instance, fieldName: f.fieldName, charMax: f.charMax, fieldType: f.fieldType, copy: f.copy });
  }
  for (const st of stacks) {
    for (const v of st.variations) {
      units.push({
        assetType: st.assetType,
        instance: st.instance,
        fieldName: variationFieldName(st.fieldName, v.index, v.doorway),
        charMax: st.charMax,
        fieldType: st.fieldType,
        copy: v.line,
      });
    }
  }

  // --- Verdicts. Single fields → the batch review; each stack → its own focused
  // variant review, run concurrently. ---
  const singleInputs = singleFields.map((f) => {
    const p = priorFor(f.assetType, f.fieldName, f.instance);
    return { assetType: f.assetType, instance: f.instance, fieldName: f.fieldName, charMax: f.charMax, fieldType: f.fieldType, copy: f.copy, priorCopy: p.copy || null, priorComment: p.comment || null, siblings: f.siblings || [] };
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
        return { index: v.index, doorway: v.doorway, copy: v.copy, priorComment: p.comment || null };
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
  });
  let swept = 0;
  for (const id of sweepIds) {
    if (await dest.deleteReviewComment(docId, id, clients)) swept += 1;
  }
  for (const a of recon.toAdd) {
    await dest.addReviewComment(docId, { quote: a.quote, content: a.content }, clients);
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
};
