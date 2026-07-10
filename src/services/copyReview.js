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
const { reviewCopyFields } = require('./gemini');
const { getVoiceGuide, getReviewState, saveReviewState } = require('../db');

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

// Flatten getDocContent → the reviewable fields (non-empty copy only).
function collectCopyFields(content) {
  const out = [];
  for (const asset of (content && content.assets) || []) {
    for (const f of asset.fields || []) {
      const copy = String(f.copy || '').trim();
      if (copy) out.push({ assetType: asset.name, fieldName: f.fieldName, charMax: f.charMax || 0, copy });
    }
  }
  return out;
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
  // Index live comments by anchored quote (first wins — matches the post-time
  // uniqueness guard for identical copy across fields).
  const byQuote = new Map();
  for (const c of liveComments || []) {
    if (!byQuote.has(c.quote)) byQuote.set(c.quote, c);
  }

  const toAdd = [];
  const toDelete = [];
  const nextState = { fields: {} };
  const results = [];
  const activeQuotes = new Set(); // quotes that will carry a live comment after reconcile
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
    // Prefer a comment anchored to the CURRENT copy (unchanged); else the one
    // anchored to the PRIOR copy (the stale comment after an edit).
    const existing = byQuote.get(cur) || (priorCopy != null ? byQuote.get(priorCopy) : null) || null;

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
      if (existing) { toDelete.push(existing.id); removed += 1; }
      if (verdict && planAdd(key, cur, verdict)) activeComment = verdict; // replace / re-flag
      // verdict null → issue fixed by the edit; stale comment already deleted.
    }

    nextState.fields[key] = { copy: cur, comment: activeComment, resolved: false };
    results.push({ assetType: f.assetType, fieldName: f.fieldName, comment: activeComment });
  }

  return { toAdd, toDelete, nextState, results, counts: { kept, added, removed } };
}

// Run a review pass on a doc. `clients` runs Drive/Docs as the tenant's user;
// `tenantId` selects the voice guide. Returns
//   { reviewed, flagged, clean, digest, status, hadCopy }.
// Throws on a hard failure so callers can show an error state.
async function runCopyReview(docId, tenantId, clients) {
  const dest = getDestination();
  const content = await dest.getDocContent(docId, clients);
  const fields = collectCopyFields(content);

  if (fields.length === 0) {
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

  // Prior state → attach priorCopy/priorComment per field for re-review reasoning.
  let prior = null;
  try {
    prior = await getReviewState(docId);
  } catch (err) {
    console.warn('[review] prior review state lookup failed — treating as first review:', err.message);
  }
  const priorFields = (prior && prior.fields) || {};
  const withPrior = fields.map((f) => {
    const p = priorFields[fieldKey(f.assetType, f.fieldName)];
    return { ...f, priorCopy: (p && p.copy) || null, priorComment: (p && p.comment) || null };
  });

  // Brief context: the campaign's summary + writer direction carry the brief's
  // stated audience/goal. Pass them so the review treats the BRIEF's audience as
  // authoritative (voice.md's audience is only a default the brief overrides),
  // while voice.md still governs voice/tone/craft. Already re-read from the doc —
  // no new persisted state.
  const briefContext = {
    summary: (content && content.summary) || '',
    writerDirection: (content && content.writerDirection) || '',
  };

  // Gemini review (throws on hard failure → caller shows error).
  const verdicts = await reviewCopyFields({ fields: withPrior, voiceGuide, briefContext });

  // Reconcile against the doc's EXISTING comments + prior state instead of the old
  // destructive clear-and-repost: preserve unresolved comments on unchanged copy,
  // respect manually-resolved ones, remove only when the copy was fixed, add only
  // genuinely new notes. A comment vanishes only on a fix or a manual resolve.
  const liveComments = await dest.listReviewComments(docId, clients).catch((err) => {
    console.warn('[review] listReviewComments failed — treating as none:', err.message);
    return [];
  });
  const recon = reconcileComments({ fields, priorFields, verdicts, liveComments });

  for (const id of recon.toDelete) {
    await dest.deleteReviewComment(docId, id, clients);
  }
  for (const a of recon.toAdd) {
    await dest.addReviewComment(docId, { quote: a.quote, content: a.content }, clients);
  }

  // Persist next state (copy + comment + resolved per field) for the next re-review.
  try {
    await saveReviewState(docId, recon.nextState);
  } catch (err) {
    console.warn('[review] saveReviewState skipped:', err.message);
  }

  const reviewed = recon.results.length;
  const flagged = recon.results.filter((r) => r.comment).length;
  console.log(
    `[review] doc=${docId} reviewed=${reviewed} flagged=${flagged} ` +
      `kept=${recon.counts.kept} added=${recon.counts.added} removed=${recon.counts.removed}`
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
  qualitativeStatus,
  buildDigest,
  fieldKey,
  reconcileComments,
};
