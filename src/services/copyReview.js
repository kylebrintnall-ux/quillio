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
  const results = await reviewCopyFields({ fields: withPrior, voiceGuide, briefContext });

  // Clear prior Quillio comments, then post the currently-warranted ones anchored
  // to each field's copy.
  await dest.clearReviewComments(docId, clients);
  const toPost = results
    .filter((r) => r.comment)
    .map((r) => {
      const f = fields.find((x) => x.assetType === r.assetType && x.fieldName === r.fieldName);
      return f ? { quote: f.copy, content: r.comment } : null;
    })
    .filter(Boolean);
  const posted = await dest.postReviewComments(docId, toPost, clients);

  // Persist new state (copy + comment per field) for the next re-review.
  const nextState = { fields: {} };
  for (const f of fields) {
    const r = results.find((x) => x.assetType === f.assetType && x.fieldName === f.fieldName);
    nextState.fields[fieldKey(f.assetType, f.fieldName)] = { copy: f.copy, comment: (r && r.comment) || null };
  }
  try {
    await saveReviewState(docId, nextState);
  } catch (err) {
    console.warn('[review] saveReviewState skipped:', err.message);
  }

  const flagged = results.filter((r) => r.comment).length;
  const reviewed = results.length;
  console.log(`[review] doc=${docId} reviewed=${reviewed} flagged=${flagged} posted=${posted}`);
  return {
    reviewed,
    flagged,
    clean: reviewed - flagged,
    hadCopy: true,
    digest: buildDigest(results),
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
};
