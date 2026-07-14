'use strict';

// Copy-review orchestration (copy-review feature). Reviews a generated copy doc
// like a thoughtful editor and leaves inline, anchored comments only where a
// material issue genuinely warrants it — silence is a good outcome.
//
// Flow:
//   1. getDocContent parses the doc; we evaluate ONLY fields with non-empty copy
//      (labels, notes, asset/group headings, direction, summary, references, and
//      the header table are already separated out by getDocContent).
//   2. Load the tenant's voice.md (getVoiceGuide, repo voice.md fallback) — the
//      single comprehensive brand reference.
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

// Repo voice.md fallback, loaded once (same source gemini.js uses for drafting).
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

function fieldKey(assetType, fieldName) {
  return `${String(assetType || '').trim().toLowerCase()}||${String(fieldName || '').trim().toLowerCase()}`;
}

// Flatten getDocContent → the SINGLE-copy reviewable fields (non-empty). Numbered
// STACKS are handled separately by the variant-aware path (collectVariationStacks
// + reviewVariationStack), so they're routed out here, not reviewed as one blob.
// A SOLO labeled variation (`(Reframe) …`) is already resolved and IS reviewed —
// its leading doorway tag is stripped so the length/voice check sees the sentence.
function collectCopyFields(content) {
  const out = [];
  for (const asset of (content && content.assets) || []) {
    for (const f of asset.fields || []) {
      const raw = String(f.copy || '').trim();
      if (!raw) continue;
      if (isNumberedStack(raw)) continue; // an unresolved stack → the variant path handles it
      const copy = stripSoloLabel(raw).trim();
      if (copy) out.push({ assetType: asset.name, fieldName: f.fieldName, charMax: f.charMax || 0, copy });
    }
  }
  return out;
}

// getDocContent → the unresolved NUMBERED STACKS, each with its parsed options.
// [{ assetType, fieldName, charMax, variations: [{ index, doorway, copy, line }] }].
function collectVariationStacks(content) {
  const out = [];
  for (const asset of (content && content.assets) || []) {
    for (const f of asset.fields || []) {
      const raw = String(f.copy || '').trim();
      if (!raw || !isNumberedStack(raw)) continue;
      const variations = parseNumberedStack(raw);
      if (variations.length >= 2) {
        out.push({ assetType: asset.name, fieldName: f.fieldName, charMax: f.charMax || 0, variations });
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
  const assets = new Set(results.filter((r) => r.comment).map((r) => r.assetType));
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
//   fields: [{ assetType, fieldName, copy }]
//   priorFields: { key: { copy, comment, resolved } }
//   verdicts: [{ assetType, fieldName, comment }] (comment: string|null)
//   liveComments: [{ id, content, resolved, quote }]
function reconcileComments({ fields, priorFields, verdicts, liveComments } = {}) {
  const prior = priorFields || {};
  const verdictByKey = new Map();
  for (const v of verdicts || []) {
    const c = v && typeof v.comment === 'string' && v.comment.trim() ? v.comment.trim() : null;
    verdictByKey.set(fieldKey(v.assetType, v.fieldName), c);
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
    const key = fieldKey(f.assetType, f.fieldName);
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
      results.push({ assetType: f.assetType, fieldName: f.fieldName, comment: null }); // dismissed → not an active note
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
    results.push({ assetType: f.assetType, fieldName: f.fieldName, comment: activeComment });
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
async function runCopyReview(docId, tenantId, clients) {
  const dest = getDestination();
  const content = await dest.getDocContent(docId, clients);
  const singleFields = collectCopyFields(content); // resolved / solo-labeled fields
  const stacks = collectVariationStacks(content); // unresolved numbered stacks

  if (singleFields.length === 0 && stacks.length === 0) {
    return { reviewed: 0, flagged: 0, clean: 0, hadCopy: false, digest: 'Nothing to review yet — this doc has no drafted copy.', status: 'Nothing to review yet' };
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
  const priorFor = (assetType, fieldName) => priorFields[fieldKey(assetType, fieldName)] || {};

  // Brief context: the campaign's summary + writer direction carry the brief's
  // stated audience/goal. The BRIEF's audience is authoritative (voice.md's is a
  // default it overrides); voice.md still governs voice/tone/craft. It also lets
  // the variant review infer funnel stage. No new persisted state.
  const briefContext = {
    summary: (content && content.summary) || '',
    writerDirection: (content && content.writerDirection) || '',
  };

  // --- Review UNITS. One per single field; one per stack VARIATION. Each unit's
  // `copy` is what a comment anchors to and what change-detection compares: a
  // single field's copy, or a variation's full "N. (Doorway) …" doc line (unique
  // via its number). reconcile keys/persists on (assetType, fieldName). ---
  const units = [];
  for (const f of singleFields) {
    units.push({ assetType: f.assetType, fieldName: f.fieldName, charMax: f.charMax, copy: f.copy });
  }
  for (const st of stacks) {
    for (const v of st.variations) {
      units.push({
        assetType: st.assetType,
        fieldName: variationFieldName(st.fieldName, v.index, v.doorway),
        charMax: st.charMax,
        copy: v.line,
      });
    }
  }

  // --- Verdicts. Single fields → the batch review; each stack → its own focused
  // variant review, run concurrently. ---
  const singleInputs = singleFields.map((f) => {
    const p = priorFor(f.assetType, f.fieldName);
    return { assetType: f.assetType, fieldName: f.fieldName, charMax: f.charMax, copy: f.copy, priorCopy: p.copy || null, priorComment: p.comment || null };
  });
  const singleVerdicts = singleInputs.length
    ? await reviewCopyFields({ fields: singleInputs, voiceGuide, briefContext })
    : [];

  const stackResults = await Promise.all(
    stacks.map((st) => {
      const options = st.variations.map((v) => {
        const p = priorFor(st.assetType, variationFieldName(st.fieldName, v.index, v.doorway));
        return { index: v.index, doorway: v.doorway, copy: v.copy, priorComment: p.comment || null };
      });
      return reviewVariationStack({ assetType: st.assetType, fieldName: st.fieldName, charMax: st.charMax, variations: options, voiceGuide, briefContext })
        .then((res) => ({ st, res }))
        .catch((err) => {
          console.warn(`[review] variant review failed for ${st.fieldName}: ${err.message}`);
          return { st, res: [] };
        });
    })
  );

  // Compose each variation's comment: STRATEGY first, then CRAFT; null when clean.
  const variationVerdicts = [];
  for (const { st, res } of stackResults) {
    const byIndex = new Map((res || []).map((r) => [r.index, r]));
    for (const v of st.variations) {
      const r = byIndex.get(v.index) || {};
      const parts = [r.strategy, r.craft].filter((s) => typeof s === 'string' && s.trim());
      variationVerdicts.push({
        assetType: st.assetType,
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
  // Orphan sweep: a live Quillio comment bound to no current unit belongs to a
  // unit that no longer exists — a stack the writer resolved down, or a deleted
  // field. Remove it so a variation's note disappears once its option is gone.
  const claimed = new Set(recon.claimedIds);
  const deleting = new Set(recon.toDelete);
  let swept = 0;
  for (const c of liveComments) {
    if (!claimed.has(c.id) && !deleting.has(c.id)) {
      if (await dest.deleteReviewComment(docId, c.id, clients)) swept += 1;
    }
  }
  for (const a of recon.toAdd) {
    await dest.addReviewComment(docId, { quote: a.quote, content: a.content }, clients);
  }

  // Persist next state (copy + comment + resolved per unit) for the next re-review.
  try {
    await saveReviewState(docId, recon.nextState);
  } catch (err) {
    console.warn('[review] saveReviewState skipped:', err.message);
  }

  const reviewed = recon.results.length;
  const flagged = recon.results.filter((r) => r.comment).length;
  console.log(
    `[review] doc=${docId} reviewed=${reviewed} flagged=${flagged} ` +
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
  qualitativeStatus,
  buildDigest,
  fieldKey,
  reconcileComments,
};
