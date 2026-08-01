'use strict';

// AUTO-MATCH {{markers}} TO COPY FIELDS — step two of custom document types.
//
// Pure, like docPlaceholders: no Drive, no Docs, no database, no Express. It
// takes a template's discovered markers and an asset's copy fields and proposes
// a mapping. It proposes; a human confirms. Nothing here writes.
//
// THE GOVERNING RULE: A WRONG MATCH IS WORSE THAN NO MATCH.
//
// An unmatched marker is visible — it sits in the "unmapped" list and someone
// picks a field for it in about four seconds. A WRONG match is invisible: the
// mapping looks complete, and at build time the confirmation headline lands in
// the form's headline cell. Nobody reads a matrix cell and asks "is this the
// copy I asked for" — they read it and ship it.
//
// So this matcher is deliberately conservative. It makes only matches it can
// justify by name, and when two candidates are equally good it makes NEITHER and
// says so. A lower hit rate that is right beats a higher one that needs auditing,
// because auditing a mapping costs more than building it.
//
// THE CASE THAT FORCES THE CONSERVATISM. A real "Form & Confirmation Matrix"
// holds {{Form Headline}} AND {{Confirmation Headline}}. An asset with a field
// called "Headline" is a plausible target for both. Matching the first one seen
// would be a coin flip resolved by document order — so both are reported as
// contested and neither is matched.
//
// TIERS, most confident first. A tier only considers what earlier tiers left
// over, and within a tier a pair is taken only when it is unique in BOTH
// directions (one field, one marker).
//
//   1. exact    normalize(marker) === normalize(field)
//               {{Hero Headline}} -> "Hero Headline"
//   2. suffix   the field's tokens are a trailing run of the marker's tokens
//               {{Form Headline}} -> "Headline"
//               This is the shape a matrix actually uses: a section word in
//               front of the field name. It is directional on purpose — see
//               below.
//
// WHY SUFFIX AND NOT "CONTAINS". "Contains" would match {{Benefit 1 Headline}}
// to "Headline", and in a document with four benefit rows that is four markers
// contesting one field — noise. It would also match {{Meta Title}} to "Title"
// in an asset that has both "Meta Title" and "OG Title". Requiring the field to
// be a trailing run keeps the qualifier where a human puts it: in front.
//
// The fold is utils/normalize — the same one the asset-name unique index uses,
// so "matches" here means what Postgres means by it everywhere else.

const { normalize } = require('../utils/normalize');

// Normalized identity, then split into words. Punctuation a matrix uses for
// decoration — parentheses, slashes, commas — is separator, not content, so
// "CTA / Ask" and "CTA Ask" are the same three... two words, and
// "Headline (Offer 1)" is [headline, offer, 1].
function tokens(s) {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function keyOf(s) {
  return tokens(s).join(' ');
}

// Are `field` tokens a trailing run of `marker` tokens, and strictly shorter?
// ["headline"] within ["form","headline"] -> true
// ["headline"] within ["benefit","headline","1"] -> false (not trailing)
function isSuffix(markerToks, fieldToks) {
  if (!fieldToks.length || fieldToks.length >= markerToks.length) return false;
  const offset = markerToks.length - fieldToks.length;
  return fieldToks.every((t, i) => markerToks[offset + i] === t);
}

// Take every pair the scorer proposes that is unique in BOTH directions.
// Contested pairs are recorded rather than resolved: whichever way a tie is
// broken it is a guess, and a guess here is the invisible-wrong-match failure.
function takeUnique(markers, fields, isPair, how, out) {
  const byMarker = new Map();
  const byField = new Map();
  for (const m of markers) {
    for (const f of fields) {
      if (!isPair(m, f)) continue;
      if (!byMarker.has(m.key)) byMarker.set(m.key, []);
      if (!byField.has(f.id)) byField.set(f.id, []);
      byMarker.get(m.key).push(f);
      byField.get(f.id).push(m);
    }
  }
  for (const m of markers) {
    const fs = byMarker.get(m.key) || [];
    if (fs.length !== 1) {
      if (fs.length > 1) {
        out.contested.push({
          marker: m.name,
          markerKey: m.key,
          reason: 'several fields fit this marker equally well',
          candidates: fs.map((f) => f.field_name),
          how,
        });
      }
      continue;
    }
    const f = fs[0];
    const ms = byField.get(f.id) || [];
    if (ms.length !== 1) {
      // Recorded against the FIELD, once — several markers wanting one field is
      // one decision for a human, not one per marker.
      if (!out.contested.some((c) => c.field === f.field_name && c.how === how)) {
        out.contested.push({
          field: f.field_name,
          fieldId: f.id,
          reason: 'several markers fit this field equally well',
          candidates: ms.map((x) => x.name),
          how,
        });
      }
      continue;
    }
    out.matched.push({
      fieldId: f.id,
      fieldName: f.field_name,
      markerKey: m.key,
      markerName: m.name,
      how,
    });
  }
}

// Propose a mapping between a template's markers and an asset's copy fields.
//
//   markers: [{ name, key }]        — from doc_templates.placeholders
//   fields:  [{ id, field_name }]   — the asset's copy_fields
//
// Returns:
//   {
//     matched:          [{ fieldId, fieldName, markerKey, markerName, how }],
//     contested:        [{ marker|field, candidates, reason, how }],
//     unmatchedFields:  [{ id, field_name }],
//     unmatchedMarkers: [{ name, key }],
//     counts: { markers, fields, matched, contested, unmatchedFields, unmatchedMarkers, hitRate }
//   }
//
// `hitRate` is matched / fields — the share of the WRITER'S work that is placed.
// Deliberately not matched/markers: a matrix carries markers no writer drafts
// ({{Form ID}}, {{Owner}}, {{Last Updated}}), and counting those in the
// denominator would make the matcher look worse the more metadata a tenant's
// template happens to have. Both totals are in `counts` so either can be read.
function matchMarkersToFields(markers, fields) {
  const m0 = (markers || [])
    .filter((m) => m && (m.name || m.key))
    .map((m) => ({ name: m.name || m.key, key: m.key || keyOf(m.name), toks: tokens(m.name || m.key) }));
  const f0 = (fields || [])
    .filter((f) => f && f.field_name)
    .map((f) => ({ id: String(f.id), field_name: f.field_name, toks: tokens(f.field_name) }));

  const out = { matched: [], contested: [] };

  takeUnique(m0, f0, (m, f) => m.toks.join(' ') === f.toks.join(' '), 'exact', out);

  // Tier 2 sees only what tier 1 left. An exact match already claimed its field,
  // so {{Headline}} -> "Headline" cannot be re-contested by {{Form Headline}}.
  const usedMarkers = new Set(out.matched.map((x) => x.markerKey));
  const usedFields = new Set(out.matched.map((x) => x.fieldId));
  takeUnique(
    m0.filter((m) => !usedMarkers.has(m.key)),
    f0.filter((f) => !usedFields.has(f.id)),
    (m, f) => isSuffix(m.toks, f.toks),
    'suffix',
    out
  );

  const finalMarkers = new Set(out.matched.map((x) => x.markerKey));
  const finalFields = new Set(out.matched.map((x) => x.fieldId));
  const unmatchedFields = f0.filter((f) => !finalFields.has(f.id)).map((f) => ({ id: f.id, field_name: f.field_name }));
  const unmatchedMarkers = m0.filter((m) => !finalMarkers.has(m.key)).map((m) => ({ name: m.name, key: m.key }));

  return {
    matched: out.matched,
    contested: out.contested,
    unmatchedFields,
    unmatchedMarkers,
    counts: {
      markers: m0.length,
      fields: f0.length,
      matched: out.matched.length,
      contested: out.contested.length,
      unmatchedFields: unmatchedFields.length,
      unmatchedMarkers: unmatchedMarkers.length,
      hitRate: f0.length ? Math.round((out.matched.length / f0.length) * 100) : 0,
      markerCoverage: m0.length ? Math.round((out.matched.length / m0.length) * 100) : 0,
    },
  };
}

module.exports = { matchMarkersToFields, tokens, keyOf, isSuffix };
