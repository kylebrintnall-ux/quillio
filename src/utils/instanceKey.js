'use strict';

// Instance ordinals for the two composite identity keys.
//
// Asset identity has always been the asset's NAME, used as half of a composite
// key in two places:
//   ctxKey(assetType, fieldName)   → `asset|field`   (destinations/googleDocs.js)
//   fieldKey(assetType, fieldName) → `asset||field`  (services/copyReview.js)
//
// A doc may eventually carry the SAME asset more than once (N instances of one
// asset type — "5 nurture emails for 2 audiences"). Both keys therefore take an
// optional instance ordinal, and this module is the single definition of how
// that ordinal is serialized, so the two key functions can never drift apart.
//
// THE DEFAULT MUST STAY BYTE-IDENTICAL. These keys are persisted verbatim as
// jsonb object keys in doc_reviews.state (services/copyReview.js saveReviewState
// → db.js), so changing what ordinal 0 serializes to would orphan every existing
// tenant's review state in production. instanceTag(0) returns '' for exactly
// that reason, and a smoke test pins it.
//
// The tag attaches to the ASSET half of the key, never the end:
//   ctxKey('Email', 'Headline', 2)   → 'email#i2|headline'
//   fieldKey('Email', 'Headline', 2) → 'email#i2||headline'
// Appending it instead would break copyReview.keyInScope, which recognizes a
// variation's state key by the `${fieldKey} · option N (Doorway)` SUFFIX.

// Marker for a non-default instance. Deliberately two characters ('#i', not a
// bare '#') so it can't be produced by a tenant asset literally named e.g.
// "Banner #2" — that normalizes to 'banner #2' (with a space), and even
// 'Banner#2' would need to be 'Banner#i2' to collide.
const INSTANCE_MARKER = '#i';

// The serialized instance component. 0 / absent / non-numeric / negative → ''
// (the default, today's exact key). n > 0 → `#i<n>`.
//
// The ordinal is a 0-BASED occurrence index, and the marker carries it verbatim:
// the first occurrence of an asset is 0 and unmarked, so '#i1' is the SECOND
// instance, '#i2' the third. (Unmarked-means-first is what keeps the default
// byte-identical; the alternative — renumbering so the marker reads 1-based —
// would put arithmetic between the ordinal and the string it produces.)
function instanceTag(instance) {
  const n = Number(instance);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${INSTANCE_MARKER}${Math.floor(n)}`;
}

// The canonical review-unit key: `asset[#iN]||field`, lowercased and trimmed.
//
// THREE call sites used to carry their own inline copy of this exact template —
// copyReview.fieldKey, and two inside gemini.reviewCopyFields' result-matching
// map. This is now the only definition. (googleDocs.ctxKey has a DIFFERENT
// serialization — a single `|`, and it stringifies a null asset as 'null' rather
// than '' — so it stays separate, but it shares instanceTag above, which is the
// only part that could drift.)
//
// Byte-identical to the pre-instance key whenever `instance` is the default; see
// instanceTag. That is load-bearing — these strings are persisted verbatim as
// jsonb object keys in doc_reviews.state.
function reviewUnitKey(assetType, fieldName, instance) {
  return `${String(assetType || '').trim().toLowerCase()}${instanceTag(instance)}||${String(fieldName || '').trim().toLowerCase()}`;
}

// A stateful counter that hands out the 0-based ordinal for each asset name as
// it is encountered, in document order: first occurrence → 0, second → 1, …
//
// Driven by the two doc READERS (parseDoc / getDocContent), which push one entry
// per HEADING_3 without deduping and now stamp each entry with its ordinal. Any
// other loop over an asset list should read that stamped `instance` rather than
// re-count, so there is one source of truth per document.
//
// Names are normalized the same way the key functions normalize them (trim +
// lowercase) so 'Email' and 'email ' are one asset, not two.
function instanceCounter() {
  const seen = new Map();
  return function nextOrdinal(assetType) {
    const name = String(assetType == null ? '' : assetType).trim().toLowerCase();
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    return n;
  };
}

module.exports = { INSTANCE_MARKER, instanceTag, reviewUnitKey, instanceCounter };
