'use strict';

// Two guards protecting the ONE Slack message a run owns.
//
// THE BUG. dbd3306 collapsed the whole Slack flow onto a single message ts —
// the plan card becomes "Building your document…" becomes the doc-ready card
// becomes the draft-ready card, all at the same (channel, ts). That removed the
// stray orphan messages it was meant to remove, and created a worse failure in
// their place: before, a late write posted a visible second message and the
// finished card survived; after, a late write OVERWRITES the finished card. A
// real run went draft-complete → tapped Open in Drive → came back to find
// "Building your document…" and the working GIF, permanently.
//
// WHAT CAN WRITE LATE. Two things, and they need different answers:
//
// 1. A DUPLICATE DELIVERY. Slack redelivers an interaction it believes failed,
//    up to three times. server.js acks in milliseconds and does the work
//    asynchronously, so an ack lost in transit — exactly what a slow run makes
//    more likely — arrives as a second identical payload. A double-tap on a
//    phone produces the same thing without any retry at all. Either way the
//    whole flow runs twice: resumeBriefWorkflow's pending record is dropped only
//    AFTER buildAndPost resolves, so a second delivery still finds it, writes
//    BUILDING_TEXT over whatever is on the message, and builds a second doc.
//    → claimDelivery: the second delivery never starts.
//
// 2. A SLOW EARLIER RUN. Run N is still in flight when the user starts run N+1
//    (Generate First Draft on a doc-ready card is exactly this). N's remaining
//    writes must not land on top of N+1's.
//    → beginRun / mayWrite: a run that has been superseded cannot write.
//
// WHY A SEQUENCE AND NOT A "TERMINAL" FLAG. The obvious guard — refuse to
// overwrite a terminal card — is wrong here, because driving a terminal card
// back to a progress state is a thing the user does deliberately: the doc-ready
// card is terminal, and clicking Generate First Draft on it must be able to
// write "Drafting 3 assets…". What is illegitimate is not progress-after-
// terminal, it is OLD-after-NEW. A per-message monotonic sequence says exactly
// that and nothing more.
//
// Single-instance, like pendingBriefs and routes/app.js's JOBS. A restart clears
// both maps: an in-flight run is already lost at that point, and the guards
// failing open afterwards is the same behavior as before they existed.

// Longer than any run (the slowest brief is ~5 minutes) so a retry can never
// outlive the claim it should have been blocked by. Claims are released in a
// `finally`, so this ceiling only matters if the run's process dies — which
// clears the map anyway.
const CLAIM_TTL_MS = 15 * 60 * 1000;
// A message stops being interesting once nothing can plausibly still be writing
// to it. Generous because the cost of remembering is one small object.
const RUN_TTL_MS = 60 * 60 * 1000;

const CLAIMS = new Map(); // delivery key -> { done: bool, at: ms }
const RUNS = new Map(); // `${channel}|${ts}` -> { seq, at }

function sweep(map, ttl) {
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - (typeof v === 'number' ? v : v.at) > ttl) map.delete(k);
  }
}

function msgKey(channel, ts) {
  return `${channel || ''}|${ts || ''}`;
}

// --- Guard 1: one run per delivery ------------------------------------------

// Try to claim a delivery. Returns true when this caller owns the work.
//
// The key identifies the WORK, not the request: Slack's retry carries the same
// payload as the original, and a double-tap produces two payloads identical in
// every field the work depends on. See deliveryKey.
//
// `isRetry` is Slack's own X-Slack-Retry-Num, and it is what makes this correct
// rather than merely helpful. Without it the rule has to be "refuse while in
// flight, allow afterwards" — which is exactly wrong for the reported bug, where
// the redelivery lands AFTER the run finished and reverts the terminal card. And
// "refuse forever" is also wrong, because a deliberate second click (Regenerate
// again, Build again after an error) is a legitimate repeat of the same tuple.
// The retry header separates the two cases exactly:
//
//   retry, key already seen (in flight OR finished) → refuse. Slack is
//     redelivering work we already accepted; re-running it is never right.
//   retry, key never seen → RUN it. The original genuinely never arrived, and
//     this is the user's only remaining chance to have their click honoured.
//   fresh, key in flight → refuse. A double-tap, or two devices.
//   fresh, key finished → run. A deliberate repeat.
//
// A finished key is REMEMBERED (not deleted) for CLAIM_TTL_MS, which is what
// makes case 1 possible; releaseDelivery marks, it does not forget.
function claimDelivery(key, isRetry) {
  if (!key) return true; // nothing to key on → never block the work
  sweep(CLAIMS, CLAIM_TTL_MS);
  const seen = CLAIMS.get(key);
  if (isRetry) {
    if (seen) return false;
  } else if (seen && !seen.done) {
    return false;
  }
  CLAIMS.set(key, { done: false, at: Date.now() });
  return true;
}

// Mark a claim finished once the run has settled. Deliberately NOT a delete: the
// key has to stay visible so a later retry of the same delivery can be told apart
// from a deliberate re-click. Must run in a `finally` — a run that throws is still
// a run that happened, and its retry must not re-run it.
function releaseDelivery(key) {
  if (key && CLAIMS.has(key)) CLAIMS.set(key, { done: true, at: Date.now() });
}

// The identity of a piece of work, for claimDelivery. Same click twice → same
// string. Different button, different message or different target → different.
function deliveryKey(kind, channel, ts, value) {
  return [kind || '', channel || '', ts || '', value || ''].join('|');
}

// --- Guard 2: only the newest run may write ---------------------------------

// Claim this message for a new run. Every later write from an EARLIER run is
// refused. Call once, at the top of a flow that owns a (channel, ts).
function beginRun(channel, ts) {
  if (!channel || !ts) return null; // no coordinates → no guard, and no need for one
  sweep(RUNS, RUN_TTL_MS);
  const key = msgKey(channel, ts);
  const prev = RUNS.get(key);
  const seq = (prev ? prev.seq : 0) + 1;
  RUNS.set(key, { seq, at: Date.now() });
  return seq;
}

// May a write from run `seq` still land on this message? True when it is the
// newest run (or when there is no sequence to compare against — an untagged
// write is never blocked, so adding the guard cannot break a path that has not
// been taught about it).
function mayWrite(channel, ts, seq) {
  if (seq == null || !channel || !ts) return true;
  const cur = RUNS.get(msgKey(channel, ts));
  if (!cur) return true;
  return seq >= cur.seq;
}

// Test/diagnostic only: forget everything. Never called by the app.
function _reset() {
  CLAIMS.clear();
  RUNS.clear();
}

module.exports = {
  CLAIM_TTL_MS,
  RUN_TTL_MS,
  claimDelivery,
  releaseDelivery,
  deliveryKey,
  beginRun,
  mayWrite,
  _reset,
};
