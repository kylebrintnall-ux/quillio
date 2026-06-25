'use strict';

// Asset-name normalization, shared by the pipeline (Postgres spec matching) and
// tests. Folds case, dash variants (en/em dash, minus sign → hyphen), spacing
// around hyphens, and runs of whitespace, so "Paid Social - LinkedIn",
// "Paid Social – LinkedIn", and "Paid Social-LinkedIn" all compare equal.
//
// Previously lived in services/sheets.js; relocated here when the Google Sheet
// was fully retired (asset specs now come from Postgres only).
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-') // unicode dashes / minus -> hyphen
    .replace(/\s*-\s*/g, '-') // drop spaces around hyphens
    .replace(/\s+/g, ' ') // collapse remaining whitespace
    .trim();
}

module.exports = { normalize };
