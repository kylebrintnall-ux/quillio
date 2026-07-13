'use strict';

// Detection + marker helpers for stacked / labeled copy variations (Phase 2/3).
//
// Two doc shapes carry variation markers, distinguished by whether there is
// anything to RESOLVE between:
//   • Numbered stack  — `1. (Pain) …` / `2. (Proof) …` — count > 1, UNRESOLVED.
//     The writer has yet to pick one. Review skips these (comparing unchosen
//     options against a char limit + voice is noise). Detected by ≥2 numbered
//     lines; once the writer deletes down to one line it's reviewable again.
//   • Solo label     — `(Reframe) …` — a count = 1 Explore/Roam-wide variation.
//     Already resolved (there's one copy); it stays reviewable. The leading
//     `(Doorway)` tag is strategy metadata, not copy, so it's stripped before a
//     length/voice check and for the app's char count.
// A bare Phase-1 draft (count = 1, Stay close) carries neither marker.

// A line that opens a stack option: "1. ", "2. ", optionally then "(Doorway) ".
const NUMBERED_LINE = /^\s*\d+\.\s/;

// A solo variation's leading doorway tag: "(Reframe) ", "(Pain) ", etc.
const SOLO_LABEL = /^\s*\(([A-Za-z]+)\)\s+/;

// True when the copy is an UNRESOLVED numbered stack (≥2 numbered option lines).
// Trailing/blank lines are ignored so a resolved single line reads as not-a-stack.
function isNumberedStack(copy) {
  const lines = String(copy || '')
    .split('\n')
    .filter((l) => l.trim());
  return lines.filter((l) => NUMBERED_LINE.test(l)).length >= 2;
}

// The doorway named by a solo label, or null when there isn't one.
function soloDoorway(copy) {
  const m = String(copy || '').match(SOLO_LABEL);
  return m ? m[1] : null;
}

// Strip a leading solo doorway tag so downstream sees just the sentence. Only
// touches a single-line, non-stack copy — a numbered stack is returned unchanged.
function stripSoloLabel(copy) {
  const s = String(copy || '');
  if (isNumberedStack(s)) return s;
  return s.replace(SOLO_LABEL, '');
}

module.exports = { isNumberedStack, soloDoorway, stripSoloLabel, NUMBERED_LINE, SOLO_LABEL };
