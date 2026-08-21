'use strict';

// HOW CURRENT IS THIS NUMBER — the two sentences, and the one place they live.
//
// A limit in this product carries two different facts about its own currency,
// and they are different KINDS of fact:
//
//   THE HUMAN EVENT   a person opened the cited page and confirmed this number.
//                     copy_fields.spec_verified_at. Fixed, historical, true when
//                     written and true forever. This is what a generated DOCUMENT
//                     carries, because a document is a file and a date written
//                     into one is frozen at creation.
//
//   THE MACHINE STATE when the detector last fetched that page and what it found.
//                     spec_watch_list.last_checked_at and the row's health. This
//                     MOVES — weekly — so it can only be shown honestly on a
//                     surface that re-reads it every time somebody opens it.
//
// Neither substitutes for the other, and this module composes both so that the
// document and the settings library cannot come to say different things.
// destinations/googleDocs.js delegates its provenance sentence to verifiedSentence
// below; nothing else composes one.
//
// ─── THE SECOND LINE'S JOB IS TO WITHDRAW, NOT TO REASSURE ──────────────────
// "We watch that page for edits — not the number" is the content. The date is
// incidental. Written the other way round — a date with a tick beside it — it
// becomes a freshness badge, which is exactly the mistake the document sentence
// made in its first version: a value that looks like a guarantee and carries
// none. If a future edit makes this line read as a reassurance, it has moved the
// same defect onto a new surface.
//
// ─── WHAT THIS CANNOT TELL YOU, AND IT IS NOT A GAP THAT CAN BE CLOSED ──────
// EVERY STATE BELOW IS DERIVED FROM STORED STATE. Not one of them involves
// reading the cited page. So a row watching the WRONG PAGE reports perfectly
// clean here, forever.
//
// That is not hypothetical. Meta's two assets watched the ads-guide INDEX for
// months — 2,208 characters of nav, marketing copy and a signup form, containing
// no character limit at all. Every week it reported `unchanged`, with last_error
// null and both streak counters at zero. It would have rendered "no change" on
// this surface with total confidence about a page that could never have flagged.
//
// The only thing that catches that is scripts/checkSpecHealth.js, which FETCHES
// — it asks whether the hashed text still contains the row's own char_max values,
// whether the anchor is present today, whether the page varies between fetches,
// and whether a cited URL is watched by anybody. It is manual and read-only by
// design, so the dependency is on somebody running it.
//
// THEREFORE: this is not a health display and must never be described as one. A
// green line here means "the comparison we perform came back equal", nothing
// more. CLAUDE.md's note that the fields carrying a verification date rest on
// somebody running the health check does not get weaker because a status now
// renders on a screen.

const { specSourceName } = require('./specSource');
// A util reaching UP to a service, on purpose and for one number. The
// unconfirmed threshold is the detector's — it is the point at which a run
// declares a row stuck — and restating it here is how this screen and the admin
// health page would come to disagree about whether a row is in trouble. The
// import is safe in both directions: specDetector requires crypto, ../db and
// ../db/specWatch, none of which reaches back here.
const { UNCONFIRMED_STREAK_ALERT } = require('../services/specDetector');

// ISO, because a generated document and a settings panel are both read in more
// than one locale and 08/09 is ambiguous in exactly the way a provenance date
// must not be. Both dates in the block use it, so two dates side by side cannot
// be in two formats.
function isoDay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// "Verified against LinkedIn's spec page on 2026-08-20.", or '' when there is
// nothing to say.
//
// "VERIFIED" IS THE RIGHT WORD HERE and it is the one place in this codebase
// that may use it. The rule elsewhere — say "checked", never "verified" — exists
// because the weekly detector compares a hash and never re-reads the number, so
// "verified" would claim something the machine does not do. This sentence is
// about a HUMAN who did read the page. Where the claim is genuinely a person's,
// the word is literally true.
//
// EVERY FAILURE LANDS ON THE SAME SILENT PATH. No date, a value that is not a
// date, an unparseable one, and a source that resolves to no platform name all
// return '' — a field with no recorded verification must render with NO clause
// rather than an empty or malformed one. "Verified against null's spec page on
// Invalid Date." is what these guards make unreachable.
//
// KNOWN WORDING EDGE, currently unreachable. "spec page" is right for the six
// platform pages and wrong for a study — Constant Contact and Gong are cited by
// two `recommended` fields whose sources are research, and specSourceName does
// resolve both. No such field carries a verification date today and the backfill
// does not give them one, so the sentence cannot render for them. If one is ever
// verified, the wording needs a second form rather than calling a study a spec
// page.
function verifiedSentence(specVerifiedAt, specSource) {
  if (!specVerifiedAt) return '';
  const sourceName = specSourceName(specSource);
  if (!sourceName) return '';
  const day = isoDay(specVerifiedAt);
  if (!day) return '';
  return `Verified against ${sourceName}'s spec page on ${day}.`;
}

// A failing read is called out from TWO in a row, not one. One bad Monday is a
// transient; two is a pattern. Deliberately lower than the unconfirmed alert,
// which needs three because the confirm step legitimately produces one.
const FAILURE_STREAK_ALERT = 2;

// The states, most-withdrawing first. Order is the whole design of this
// function, so it is written once here and the branch below follows it:
//
//   unwatched   no watch row cites this page at all. Nothing else can apply.
//   observed    a study, deliberately never hash-watched. Not a fault.
//   baselining  a row that has never compared anything yet.
//   pending     a change WAS detected and is waiting on a human.
//   failing     the page could not be read.
//   unstable    the page reads differently every time.
//   unanchored  no anchor, so nothing asserts the fetch read the right page.
//   clean       the last comparison came back equal.
//
// PENDING OUTRANKS THE MECHANICAL FAULTS, and that is a judgement rather than an
// obvious ordering. failing / unstable / unanchored are statements about the
// MECHANISM — "we cannot tell you anything". pending is a statement about the
// NUMBER — "we saw this page change and nobody has looked yet". The writer is
// reading this to decide whether to trust a limit, so the fact about the limit
// wins.
const STATES = ['unwatched', 'observed', 'baselining', 'pending', 'failing', 'unstable', 'unanchored', 'clean'];

// `watch` is the tenant-safe subset db/specWatch.getWatchStateBySource returns,
// or null when no row cites this page. Never the raw row: last_error's text,
// the stored hashes and the test row's URL do not belong on a tenant surface.
function freshnessState(watch) {
  if (!watch) return 'unwatched';
  if (watch.sourceKind === 'observed_practice') return 'observed';
  if (!watch.baselined) return 'baselining';
  if (Number(watch.pendingCount) > 0) return 'pending';
  if (Number(watch.failures) >= FAILURE_STREAK_ALERT || watch.hasError) return 'failing';
  if (Number(watch.unconfirmed) >= UNCONFIRMED_STREAK_ALERT) return 'unstable';
  if (!watch.anchored) return 'unanchored';
  return 'clean';
}

// The sentence for a state. Tenant-facing: no counters, no error strings, no
// hashes, and nothing that reads as a task — a writer can do nothing about any
// of these, so the text withdraws the claim and stops.
//
// TWO OF THESE DELIBERATELY CARRY NO DATE, and the reason is a fact about the
// detector rather than a style choice. `last_checked_at` is stamped on a FAILED
// read as well as a clean one (specDetector.js bumpFailure), so "we haven't been
// able to read this page since <date>" is not derivable from it — the date would
// be when we last TRIED, which reads as when we last succeeded. `pending` is the
// exception: spec_review_queue.detected_at is a real event date.
function freshnessLine(watch) {
  const state = freshnessState(watch);
  switch (state) {
    case 'unwatched':
      return 'This page is not being watched for changes.';
    case 'observed':
      return 'Measured practice, not a platform limit — the page does not change, it ages.';
    case 'baselining':
      return 'Watching starts at the next check.';
    case 'pending': {
      const since = isoDay(watch.pendingSince);
      return since
        ? `This page changed on ${since} and is waiting on review — this number may be out of date.`
        : 'This page changed and is waiting on review — this number may be out of date.';
    }
    case 'failing':
      return 'The last few checks could not read this page.';
    case 'unstable':
      return 'This page reads differently every time, so we cannot tell whether the spec moved.';
    case 'unanchored':
      return 'We cannot confirm these checks are reading the right page.';
    default: {
      const day = isoDay(watch.lastCheckedAt);
      // The withdrawal comes FIRST and the date second, so the sentence reads as
      // a limit on what we know rather than as a badge. A row with no date yet
      // still says what we do; it just cannot say when.
      return day
        ? `We watch that page for edits — not the number. Last checked ${day}: no change.`
        : 'We watch that page for edits — not the number.';
    }
  }
}

// Both lines for one field, plus the state so a surface can style it without
// re-deriving the rule. Returns null when there is nothing to say at all — which
// is the common case: 146 of 173 seeded fields carry the `quillio_default`
// sentinel, have no cited page, and make no claim that needs qualifying.
function specFreshness({ specVerifiedAt, specSource, watch } = {}) {
  const sourceName = specSourceName(specSource);
  if (!sourceName) return null;
  return {
    sourceName,
    sourceUrl: String(specSource),
    verified: verifiedSentence(specVerifiedAt, specSource),
    state: freshnessState(watch),
    machine: freshnessLine(watch),
  };
}

module.exports = {
  specFreshness,
  verifiedSentence,
  freshnessState,
  freshnessLine,
  FAILURE_STREAK_ALERT,
  STATES,
};
