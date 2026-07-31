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
//   source 'default' — config.ALLOWED_ASSETS, the bundled 30. This is the
//                      no-DB / demo / unseeded case. There is no library to add
//                      to, so promising that adding one would help would be a
//                      lie, and the message names the global list instead.
//
// Getting this backwards is not cosmetic. The wording before the allow-list was
// per-tenant said "add them to your library" while the gate was global — advice
// that could not work, so anyone who followed it watched the same name fail
// again. An unqualified switch to the library wording would recreate exactly
// that bug for demo deployments. Hence the source, threaded from the parse.

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
  const fix = isTenantVocabulary(source)
    ? 'Nothing was built — add them to your asset library, or try different asset names.'
    : 'Nothing was built — try different asset names.';
  return `${unmatchedSentence(names, source)} ${fix}`;
}

// PARTIAL miss — some names mapped and some did not. The build goes ahead with
// what matched, so this is ADVISORY, not an error: it must not read as a failure
// and it must not block. Returns null when nothing was unmatched, which is the
// signal for callers to render no notice at all.
function partialMissNotice(unmatchedAssets, source) {
  const names = dedupeAssetNames(unmatchedAssets);
  if (names.length === 0) return null;
  const subject = names.length === 1 ? 'It was' : 'They were';
  const fix = isTenantVocabulary(source)
    ? ` Add ${names.length === 1 ? 'it' : 'them'} to your asset library to include ${
        names.length === 1 ? 'it' : 'them'
      } next time.`
    : '';
  return `${unmatchedSentence(names, source)} ${subject} left out — everything else was built.${fix}`;
}

module.exports = { dedupeAssetNames, totalMissMessage, partialMissNotice };
