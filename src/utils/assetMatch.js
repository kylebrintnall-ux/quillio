'use strict';

// What we say when parseBrief could not map an asset name the brief asked for.
// Shared by BOTH surfaces so the two messages cannot drift apart — they were
// duplicated string literals in adapters/slackWorkflow.js and adapters/web.js.
//
// WHAT THE FILTER ACTUALLY CHECKS, and why there are two wordings.
//
// services/gemini.js parseBrief constrains the model's output to a vocabulary
// core/pipeline resolveAssetVocabulary picks, and it can be either of two
// things — so the message has to say which, or it is guessing:
//
//   source 'tenant'  — the tenant's own active asset_types names. "Your asset
//                      library" is literally what was checked, and "add it to
//                      your library" is real, actionable advice: doing that
//                      makes the same brief work next time.
//   source 'default' — config.ALLOWED_ASSETS, the bundled library. This is the
//                      no-DB / demo / unseeded case. There is no library to add
//                      to, so promising that adding one would help would be a
//                      lie, and the message names the global list instead.
//
// Getting this backwards is not cosmetic. The wording before the allow-list was
// per-tenant said "add them to your library" while the gate was global — advice
// that could not work, so anyone who followed it watched the same name fail
// again. An unqualified switch to the library wording would recreate exactly
// that bug for demo deployments. Hence the source, threaded from the parse.

const { normalize } = require('./normalize');

// === RETIRED ASSET TYPES: SAY WHAT REPLACED THEM =============================
//
// f3683f4 retired six asset types. For five of them "add it to your asset
// library" — the generic advice below — is not merely unhelpful, it is the
// wrong instruction: following it recreates the exact near-duplicate the prune
// existed to remove. So a name that used to be one of them gets told what took
// its place instead.
//
// MATCH ON PHRASE, NOT ON THE RETIRED NAME. THIS IS THE WHOLE DESIGN, AND IT IS
// THE FIRST THING SOMEBODY WILL TRY TO "SIMPLIFY" INTO AN EXACT-NAME LOOKUP.
//
// A lookup keyed on 'Form Confirm Page' would essentially never fire, because
// that string does not arrive here. services/gemini.js instructs the model:
//
//     "do NOT substitute a nearest guess. Put the ORIGINAL PHRASE in
//      unmatchedAssets and leave it out of assets."
//
// (parseBrief's prompt, and again in the unmatchedAssets field description.) So
// what reaches this file is the BRIEF'S OWN WORDS — "confirm page", "the
// confirmation page", "variant B" — and never the canonical name of a type that,
// by definition, is no longer in the vocabulary the model was given. A retired
// name cannot come back as itself. Matching it as itself is matching the one
// string that cannot appear.
//
// Hence trigger predicates over the normalized phrase. They are deliberately
// narrow: bare "form" or bare "page" must not fire, because "landing page" and
// "form" are ordinary brief words. A smoke test asserts every name in
// scripts/migrateRetireDeadAssets.js RETIRE is covered by exactly one entry, so
// the table cannot silently fall behind what was actually retired.
const RETIRED_GUIDANCE = [
  {
    // 'Form Confirm Page' (was seeded) and 'Form and Confirmation Copy' (a
    // tenant row). Both named the same artifact, which is a document template a
    // tenant names now — see the template vocabulary in core/pipeline.js.
    key: 'form-confirmation',
    test: (s) => /confirm/.test(s) && /\b(page|form)\b/.test(s),
    // Importing a template needs Settings and a tenant, so this is worthless on
    // the bundled-list path — where there is no library and no Settings to go
    // to. Same discipline as the two wordings above: never advise a fix the
    // reader's surface cannot perform.
    tenantOnly: true,
    line:
      'A form-and-confirmation page is a document template now — import one in Settings ' +
      'and name it in your brief.',
  },
  {
    // 'LinkedIn Single Image Ad — Variant A/B/C/D'. Multi-instance replaced them:
    // asking for four of an asset is a count, not four asset types.
    key: 'variant-letters',
    test: (s) => /\bvariant\s*[a-d]\b/.test(s),
    // True on both paths — count works with or without a tenant library.
    tenantOnly: false,
    line:
      'Asking for several versions of an asset is a count now — say "4 LinkedIn single ' +
      'image ads" and you get four.',
  },
];

// Which retired-name guidance applies to this batch of unmatched names.
//
// Returns the lines to emit (in table order, one per entry however many names
// hit it) and the set of names they account for. A name is only reported as
// accounted-for when a line is ACTUALLY emitted for it — an entry skipped for
// being tenant-only on the bundled path leaves its names to the generic advice,
// which is the honest outcome there.
function retiredGuidance(names, source) {
  const tenant = isTenantVocabulary(source);
  const lines = [];
  const retired = new Set();
  for (const entry of RETIRED_GUIDANCE) {
    if (entry.tenantOnly && !tenant) continue;
    const hits = names.filter((n) => entry.test(normalize(n)));
    if (hits.length === 0) continue;
    for (const n of hits) retired.add(n);
    lines.push(entry.line);
  }
  return { lines, retired };
}

// Join names for a sentence: "A", "A and B", "A, B and C".
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// De-duplicate the names case-insensitively, preserving first-seen order and the
// original casing. parseBrief merges two sources — the model's own
// `unmatchedAssets` and the names its defensive filter rejected
// (services/gemini.js:533-535) — so one name the model both listed AND emitted
// arrives twice, and repeating it in the message reads like two failures.
function dedupeAssetNames(unmatchedAssets) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(unmatchedAssets) ? unmatchedAssets : []) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Was this parse gated on a real tenant library? Anything other than the
// explicit 'tenant' marker is treated as the bundled list, so an absent or
// unrecognized source degrades to the weaker (but never false) claim.
function isTenantVocabulary(source) {
  return source === 'tenant';
}

// The shared first sentence. Names the thing that was actually checked.
function unmatchedSentence(names, source) {
  const joined = names.join(', ');
  return isTenantVocabulary(source)
    ? `Couldn't match these to your asset library: ${joined}.`
    : `Couldn't match these to any asset type Quillio supports: ${joined}.`;
}

// TOTAL miss — the brief named assets and NONE of them mapped. Nothing gets
// built, so this is a refusal and it says so. Returns null when there is nothing
// unmatched (the caller should not be refusing).
function totalMissMessage(unmatchedAssets, source) {
  const names = dedupeAssetNames(unmatchedAssets);
  if (names.length === 0) return null;
  const { lines, retired } = retiredGuidance(names, source);

  // No retired name in the batch — byte-identical to what this returned before
  // the guidance table existed. The common path must not shift by a character.
  if (lines.length === 0) {
    const fix = isTenantVocabulary(source)
      ? 'Nothing was built — add them to your asset library, or try different asset names.'
      : 'Nothing was built — try different asset names.';
    return `${unmatchedSentence(names, source)} ${fix}`;
  }

  // At least one name is retired. The generic fix is REPLACED rather than
  // appended for those names — the two are contradictory advice, and printing
  // both leaves the reader to guess which one is current.
  const rest = names.filter((n) => !retired.has(n));
  const parts = [unmatchedSentence(names, source), 'Nothing was built.', ...lines];
  if (rest.length > 0) {
    parts.push(
      isTenantVocabulary(source)
        ? `Add ${joinNames(rest)} to your asset library, or try ${
            rest.length === 1 ? 'a different name' : 'different names'
          }.`
        : `Try a different name for ${joinNames(rest)}.`
    );
  }
  return parts.join(' ');
}

// PARTIAL miss — some names mapped and some did not. The build goes ahead with
// what matched, so this is ADVISORY, not an error: it must not read as a failure
// and it must not block. Returns null when nothing was unmatched, which is the
// signal for callers to render no notice at all.
function partialMissNotice(unmatchedAssets, source) {
  const names = dedupeAssetNames(unmatchedAssets);
  if (names.length === 0) return null;
  const subject = names.length === 1 ? 'It was' : 'They were';
  const head = `${unmatchedSentence(names, source)} ${subject} left out — everything else was built.`;
  const { lines, retired } = retiredGuidance(names, source);

  // As above: unchanged output when nothing in the batch was retired.
  if (lines.length === 0) {
    const fix = isTenantVocabulary(source)
      ? ` Add ${names.length === 1 ? 'it' : 'them'} to your asset library to include ${
          names.length === 1 ? 'it' : 'them'
        } next time.`
      : '';
    return `${head}${fix}`;
  }

  const rest = names.filter((n) => !retired.has(n));
  const parts = [head, ...lines];
  if (rest.length > 0 && isTenantVocabulary(source)) {
    parts.push(
      `Add ${joinNames(rest)} to your asset library to include ${
        rest.length === 1 ? 'it' : 'them'
      } next time.`
    );
  }
  return parts.join(' ');
}

module.exports = {
  dedupeAssetNames,
  totalMissMessage,
  partialMissNotice,
  // Exported for the coverage test only: it reads RETIRE out of
  // scripts/migrateRetireDeadAssets.js and asserts this table still speaks for
  // every name that migration switched off.
  RETIRED_GUIDANCE,
};
