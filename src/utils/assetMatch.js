'use strict';

// What we say when parseBrief could not map an asset name the brief asked for.
// Shared by BOTH surfaces so the two messages cannot drift apart — they were
// duplicated string literals in adapters/slackWorkflow.js and adapters/web.js.
//
// WHAT THE FILTER ACTUALLY CHECKS. services/gemini.js parseBrief constrains the
// model's output to config.ALLOWED_ASSETS — a GLOBAL list of the asset types
// Quillio supports, not the tenant's own asset_types library. The previous
// wording ("Couldn't match these to your asset library … Add them to your
// library") named the wrong thing AND offered a fix that does not work: adding a
// row to a tenant's library changes nothing while the filter is global, so a user
// who followed that advice would watch the same name fail again. These sentences
// say what is true today. When the allow-list is derived per tenant, both call
// sites move together because there is one definition to change.

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

// The shared first sentence. Names the thing that was actually checked.
function unmatchedSentence(names) {
  return `Couldn't match these to any asset type Quillio supports: ${names.join(', ')}.`;
}

// TOTAL miss — the brief named assets and NONE of them mapped. Nothing gets
// built, so this is a refusal and it says so. Returns null when there is nothing
// unmatched (the caller should not be refusing).
function totalMissMessage(unmatchedAssets) {
  const names = dedupeAssetNames(unmatchedAssets);
  if (names.length === 0) return null;
  return `${unmatchedSentence(names)} Nothing was built — try different asset names.`;
}

// PARTIAL miss — some names mapped and some did not. The build goes ahead with
// what matched, so this is ADVISORY, not an error: it must not read as a failure
// and it must not block. Returns null when nothing was unmatched, which is the
// signal for callers to render no notice at all.
function partialMissNotice(unmatchedAssets) {
  const names = dedupeAssetNames(unmatchedAssets);
  if (names.length === 0) return null;
  return `${unmatchedSentence(names)} ${
    names.length === 1 ? 'It was' : 'They were'
  } left out — everything else was built.`;
}

module.exports = { dedupeAssetNames, totalMissMessage, partialMissNotice };
