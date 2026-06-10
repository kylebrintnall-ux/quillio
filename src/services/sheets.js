'use strict';

const config = require('../config');
const { getClients } = require('../google');

// Header names expected in the specs Sheet, normalized for lookup.
const COLUMNS = {
  assetType: 'asset type',
  channel: 'channel',
  fieldName: 'field name',
  charLimit: 'character limit',
  notes: 'notes',
  funnelStage: 'funnel stage',
  toneNotes: 'tone notes',
};

// Normalize an asset name for comparison. Folds case, dash variants (en/em
// dash, minus sign → hyphen), spacing around hyphens, and runs of whitespace,
// so "Paid Social - LinkedIn", "Paid Social – LinkedIn", and
// "Paid Social-LinkedIn" all compare equal.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-') // unicode dashes / minus -> hyphen
    .replace(/\s*-\s*/g, '-') // drop spaces around hyphens
    .replace(/\s+/g, ' ') // collapse remaining whitespace
    .trim();
}

// Reads the asset spec Sheet and returns an ordered list of asset groups:
//   [{ assetType, channel, toneNotes, fields: [{ fieldName, charMin, charMax, notes, funnelStage }] }]
// Filtered to `assetFilter` (the assets Gemini returned). If the filter is
// empty or matches nothing, all assets are returned.
async function getAssetSpecs(assetFilter = []) {
  const { sheets } = await getClients();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: 'A1:Z10000',
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const header = rows[0].map(normalize);
  const idx = {};
  for (const [key, label] of Object.entries(COLUMNS)) {
    idx[key] = header.indexOf(label);
  }
  if (idx.assetType < 0 || idx.fieldName < 0) {
    throw new Error('Specs Sheet is missing required "Asset Type" / "Field Name" columns.');
  }

  const cell = (row, key) => (idx[key] >= 0 ? String(row[idx[key]] || '').trim() : '');

  // Group rows by asset type, preserving first-seen order.
  const order = [];
  const groups = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const assetType = cell(row, 'assetType');
    const fieldName = cell(row, 'fieldName');
    if (!assetType || !fieldName) continue;

    if (!groups.has(assetType)) {
      order.push(assetType);
      groups.set(assetType, {
        assetType,
        channel: cell(row, 'channel'),
        toneNotes: cell(row, 'toneNotes'),
        fields: [],
      });
    }
    const group = groups.get(assetType);
    // Backfill channel/tone from any row that has them.
    if (!group.channel) group.channel = cell(row, 'channel');
    if (!group.toneNotes) group.toneNotes = cell(row, 'toneNotes');
    group.fields.push({
      fieldName,
      charMin: parseInt(row[3], 10) || 0,
      charMax: parseInt(row[4], 10) || 0,
      notes: cell(row, 'notes'),
      funnelStage: cell(row, 'funnelStage'),
    });
  }

  let result = order.map((a) => groups.get(a));

  if (Array.isArray(assetFilter) && assetFilter.length > 0) {
    const wanted = new Set(assetFilter.map(normalize));
    const filtered = result.filter((g) => wanted.has(normalize(g.assetType)));

    // Diagnostic: surface exactly what was requested vs. what the Sheet has, so
    // asset-name mismatches (dashes, spacing, casing) are easy to spot in logs.
    const matched = filtered.map((g) => g.assetType);
    const unmatched = assetFilter.filter(
      (a) => !result.some((g) => normalize(g.assetType) === normalize(a))
    );
    console.log('[sheets] requested assets:', JSON.stringify(assetFilter));
    console.log('[sheets] sheet asset types:', JSON.stringify(order));
    console.log('[sheets] matched:', JSON.stringify(matched));
    if (unmatched.length > 0) {
      console.warn('[sheets] UNMATCHED (in brief, not found in Sheet):', JSON.stringify(unmatched));
    }

    if (filtered.length > 0) result = filtered;
  }

  return result;
}

module.exports = { getAssetSpecs };
