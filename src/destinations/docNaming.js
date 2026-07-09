'use strict';

// File-naming convention (doc-header-template work companion, §3).
//
// A team's copy-doc filename is mostly THEIR literal text with only a few parts
// dynamic. So a naming pattern is an ordered list of SEGMENTS, each either:
//   { type: 'static',  text: '<verbatim text>' }   — preserved exactly (spacing,
//                                                     punctuation, prefixes)
//   { type: 'dynamic', token: '<token>' }          — filled from project data
//
// Pattern shape: { version: 1, segments: [ <segment>, ... ] }
//
// The UI is select-a-span (§3): the user types the whole filename as plain text,
// then native-selects a span and marks it dynamic → a token. segmentsFromSpans()
// is the pure core of that interaction — given the raw text + the marked spans,
// it produces the canonical segment list (marked ranges become dynamic tokens,
// everything else stays static/verbatim). Default is static; the user only marks
// what varies.

// Tokens map to data available at doc-creation time. Keep in sync with makeTitle.
const NAMING_TOKENS = ['campaign', 'date', 'version', 'writer', 'year'];

// Human labels for the token dropdown (UI).
const NAMING_TOKEN_LABELS = {
  campaign: 'Campaign',
  date: 'Date',
  version: 'Version',
  writer: 'Writer',
  year: 'Year',
};

// A usable pattern is an object with a non-empty `segments` array containing at
// least one valid segment. (An all-static pattern is valid — a fixed filename.)
function isValidNamingPattern(pattern) {
  if (!pattern || typeof pattern !== 'object' || !Array.isArray(pattern.segments)) return false;
  return pattern.segments.some(
    (s) =>
      s &&
      ((s.type === 'static' && typeof s.text === 'string' && s.text.length > 0) ||
        (s.type === 'dynamic' && NAMING_TOKENS.indexOf(s.token) !== -1))
  );
}

// Coerce untrusted input (from the UI or storage) into a clean pattern. Static
// segments keep their text verbatim (including whitespace — spacing is
// meaningful); empty statics and unknown/invalid segments are dropped. Adjacent
// static segments are merged so the stored form is tidy.
function normalizeNamingPattern(raw) {
  const segsIn = raw && Array.isArray(raw.segments) ? raw.segments : [];
  const out = [];
  for (const s of segsIn) {
    if (!s) continue;
    if (s.type === 'dynamic' && NAMING_TOKENS.indexOf(s.token) !== -1) {
      out.push({ type: 'dynamic', token: s.token });
    } else if (s.type === 'static' && typeof s.text === 'string' && s.text.length > 0) {
      const prev = out[out.length - 1];
      if (prev && prev.type === 'static') prev.text += s.text; // merge adjacent statics
      else out.push({ type: 'static', text: s.text });
    }
  }
  return { version: 1, segments: out };
}

// The pure core of the select-a-span interaction: given the raw typed text and
// the spans the user marked dynamic ([{ start, end, token }], half-open ranges
// over the raw string), produce the canonical segment list. Overlapping or
// zero-length spans are ignored; the rest are applied in order, with the gaps
// between them kept as verbatim static text.
function segmentsFromSpans(text, spans) {
  const str = String(text == null ? '' : text);
  const sorted = (spans || [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && NAMING_TOKENS.indexOf(s.token) !== -1)
    .sort((a, b) => a.start - b.start);

  const segs = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start < cursor) continue; // overlaps a previous span — skip
    if (s.start > cursor) segs.push({ type: 'static', text: str.slice(cursor, s.start) });
    segs.push({ type: 'dynamic', token: s.token });
    cursor = s.end;
  }
  if (cursor < str.length) segs.push({ type: 'static', text: str.slice(cursor) });
  return segs;
}

function resolveToken(token, ctx) {
  const v = ctx && ctx[token];
  return v == null ? '' : String(v);
}

// Build a filename from a pattern + a value context. Static text is preserved
// exactly; dynamic segments are filled from ctx (empty string if a value is
// missing). No trimming of internal text — the user's spacing is intentional.
function applyNamingPattern(pattern, ctx) {
  const segs = (pattern && pattern.segments) || [];
  return segs
    .map((seg) => (seg.type === 'dynamic' ? resolveToken(seg.token, ctx) : String(seg.text == null ? '' : seg.text)))
    .join('');
}

// A seed pattern (the §3 worked example) for the preview/seed harnesses.
const SAMPLE_NAMING_PATTERN = {
  version: 1,
  segments: [
    { type: 'static', text: 'SVC: ' },
    { type: 'dynamic', token: 'campaign' },
    { type: 'static', text: '_ Promo Copy' },
  ],
};

module.exports = {
  NAMING_TOKENS,
  NAMING_TOKEN_LABELS,
  isValidNamingPattern,
  normalizeNamingPattern,
  segmentsFromSpans,
  applyNamingPattern,
  SAMPLE_NAMING_PATTERN,
};
