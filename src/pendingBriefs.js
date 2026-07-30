'use strict';

// Parsed briefs waiting on a human to confirm their asset plan — the state behind
// parse-then-confirm on BOTH surfaces.
//
// This started life inside routes/app.js for the web flow. It moved here when the
// Slack flow needed the same thing: the store was module-local to the web router,
// and reaching it from adapters/slackWorkflow.js would have made the Slack adapter
// depend on the web router (and pull express through with it). One store, one TTL,
// one ownership check, one validator — not two of each that can drift.
//
// Single-instance, like routes/app.js's JOBS: a Railway restart loses every pending
// brief. That is a real path, not a hypothetical, and both surfaces must handle a
// missing id visibly rather than silently (see each caller).

const crypto = require('crypto');
const { normalize } = require('./utils/normalize');
const { MAX_INSTANCES_PER_ASSET, MAX_TOTAL_INSTANCES } = require('./core/pipeline');

// 30 minutes: far longer than the seconds it takes to read a plan and hit Build,
// short enough that abandoned parses cannot accumulate. Deliberately the same
// number as routes/app.js's JOB_TTL_MS so there is one duration to reason about.
const PENDING_TTL_MS = 30 * 60 * 1000;

const PENDING = new Map(); // pendingId -> { owner, payload, ts }

function sweepPending() {
  const now = Date.now();
  for (const [id, p] of PENDING) {
    if (now - p.ts > PENDING_TTL_MS) PENDING.delete(id);
  }
}

// `owner` is an opaque ownership key the caller chooses and must present again to
// read the record back. The web passes the session tenant id; Slack passes
// `slack:<teamId>`, which lets its handlers check ownership SYNCHRONOUSLY — a
// button click has ~3s to open a modal, so it cannot afford a resolveTenant
// round-trip first. Both are per-workspace scopes; neither is guessable.
function putPending(owner, payload) {
  sweepPending();
  const pendingId = crypto.randomUUID();
  PENDING.set(pendingId, { owner: String(owner), payload, ts: Date.now() });
  return pendingId;
}

// Read a pending brief for THIS owner. Missing, expired, and someone else's all
// return null, so a caller cannot distinguish them — the web answers 404 either
// way rather than 403, because a 403 would confirm the id exists and turn the
// endpoint into an oracle for probing other tenants' ids.
//
// NOT consumed on read. Generation can fail (an unreachable Drive folder, a Gemini
// timeout) and re-parsing to retry would mean paying for the whole Gemini +
// reference-ingestion pass again; the TTL sweeps it instead.
function getPending(pendingId, owner) {
  const entry = PENDING.get(pendingId);
  if (!entry || entry.owner !== String(owner)) return null;
  if (Date.now() - entry.ts > PENDING_TTL_MS) {
    PENDING.delete(pendingId);
    return null;
  }
  return entry.payload;
}

// Explicit disposal, for a user who cancels. Idempotent.
function dropPending(pendingId, owner) {
  const entry = PENDING.get(pendingId);
  if (entry && entry.owner === String(owner)) PENDING.delete(pendingId);
}

// Does this plan have anything a user could meaningfully correct? Only a repeated
// asset or a label does. One instance of every asset — and the empty plan a vague
// brief produces, which renders the whole library — goes straight to generation
// with no extra card, no extra click, and no extra round trip. THE one-of-each
// case is every brief anyone ran before instances existed, so it must not pause.
function planNeedsConfirmation(plan) {
  return (Array.isArray(plan) ? plan : []).some(
    (e) => e && ((Number(e.count) || 1) > 1 || (Array.isArray(e.labels) && e.labels.some(Boolean)))
  );
}

// Validate + clamp a plan that came back from a USER — a browser POST body or a
// Slack modal submission. Neither is trusted. Returns { plan } or { error }.
// `libraryNames` is the tenant's actual asset_types names; an entry naming
// anything else is rejected BY NAME rather than silently dropped, because
// dropping is the silent-narrowing bug tenantAssetsToSpecs was changed to stop.
// Counts clamp to the same ceilings the expansion enforces.
function sanitizeAssetPlan(raw, libraryNames) {
  if (!Array.isArray(raw)) return { error: 'plan must be an array' };
  const known = new Set((libraryNames || []).map(normalize));
  const plan = [];
  const unknown = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const asset = String(entry.asset || entry.assetType || '').trim();
    if (!asset) continue;
    if (!known.has(normalize(asset))) {
      unknown.push(asset);
      continue;
    }
    const count = Math.max(1, Math.min(MAX_INSTANCES_PER_ASSET, parseInt(entry.count, 10) || 1));
    const labels = (Array.isArray(entry.labels) ? entry.labels : [])
      .slice(0, count)
      .map((l) => (typeof l === 'string' && l.trim() ? l.trim().slice(0, 80) : null));
    plan.push(labels.some(Boolean) ? { asset, count, labels } : { asset, count });
  }
  if (unknown.length > 0) {
    return { error: `These assets are not in your library: ${unknown.join(', ')}` };
  }
  const total = plan.reduce((n, e) => n + e.count, 0);
  if (total > MAX_TOTAL_INSTANCES) {
    return { error: `That plan asks for ${total} assets, above the limit of ${MAX_TOTAL_INSTANCES}.` };
  }
  return { plan };
}

// Ownership key for a Slack workspace. Kept here so both the adapter (which
// stores) and server.js (which reads) derive it the same way.
function slackOwner(workspaceId) {
  return `slack:${workspaceId || ''}`;
}

module.exports = {
  PENDING_TTL_MS,
  putPending,
  getPending,
  dropPending,
  planNeedsConfirmation,
  sanitizeAssetPlan,
  slackOwner,
};
