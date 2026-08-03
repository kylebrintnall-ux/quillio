'use strict';

// LOCATE AND REWRITE TEMPLATE CELLS BY STORED COORDINATE (document templates,
// rework step two).
//
// Pure — no Drive, no Docs, no database, no Express. Its one import is
// docPlaceholders, which is itself pure. Given a Docs API documents.get JSON and the marker
// rows stored at confirm time, it resolves each stored (part, table, row,
// column) to a real character range and builds the batchUpdate requests that
// replace those cells' contents.
//
// WHY THE TWO-PHASE TABLE PROBLEM DOES NOT APPLY. docHeaderTable.js:5-17 is
// about insertTable: a table that does not exist yet has no cell indices, so it
// has to be created, re-read, then filled. A COPIED template's tables already
// exist — drive.files.copy reproduced them — so documents.get hands back every
// cell's startIndex directly. One read, one write, no re-parse.
//
// REVERSE DOCUMENT ORDER IS THE WHOLE TRICK. Every request in a batchUpdate is
// applied in sequence against the shifting document, so an insert at index 100
// moves everything after it. Emitting cells highest-index-first means each
// request only ever touches indices ABOVE the ones still to come, so no request
// is invalidated by the ones before it. That is the same rule cellFillRequests
// uses (docHeaderTable.js:157-158), for the same reason.
//
// THE DELETE STOPS ONE CHARACTER SHORT. A Docs paragraph must keep its trailing
// newline. Deleting [cellStart, cellEnd) takes the paragraph mark with it and
// the API rejects the request — or worse, the cell structure is left in a state
// the editor renders oddly. The range is always [cellStart, cellEnd - 1).
//
// THE SELF-HEALING READ. The coordinate is stored on the TEMPLATE, and every
// project copy inherits its structure exactly — so the coordinate is right until
// somebody hand-edits the copy. If a writer inserts a row, everything below it
// shifts by one and the stored coordinate now points at the wrong cell. Step one
// stored `label_text` — the neighbouring label as it read at upload — for
// exactly this: go to the coordinate, check the label beside it, and if it does
// not match, find the row whose label does. A marker that cannot be located
// either way is REPORTED, never written to a guessed cell.

// The ONE import: the same name fold that produced marker_key at discovery time.
// Reimplementing it here is how a cell would report "still showing its marker"
// for one spelling and not another.
const { placeholderKey } = require('./docPlaceholders');

// Every table in one document part, numbered the way docPlaceholders numbers
// them, so a stored table_index means the same thing here.
function tablesIn(content) {
  const out = [];
  for (const el of content || []) if (el.table) out.push(el.table);
  return out;
}

function partsOf(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const parts = { body: tablesIn((d.body && d.body.content) || []) };
  for (const id of Object.keys(d.headers || {})) {
    parts.header = (parts.header || []).concat(tablesIn((d.headers[id] || {}).content || []));
  }
  for (const id of Object.keys(d.footers || {})) {
    parts.footer = (parts.footer || []).concat(tablesIn((d.footers[id] || {}).content || []));
  }
  return parts;
}

// The text of a cell, paragraphs joined and whitespace collapsed. Same joining
// docPlaceholders and templateTableReader do — Docs splits a paragraph at every
// formatting boundary, so reading run-by-run misses half of a bolded label.
function cellText(cell) {
  return ((cell && cell.content) || [])
    .map((el) =>
      ((el.paragraph && el.paragraph.elements) || [])
        .map((e) => (e.textRun && e.textRun.content) || '')
        .join('')
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The character range a cell's content occupies. null when the cell has no
// content elements at all (which the Docs API does not normally produce, but a
// malformed document must not throw here).
function cellRange(cell) {
  const content = (cell && cell.content) || [];
  if (!content.length) return null;
  const start = content[0].startIndex;
  const end = content[content.length - 1].endIndex;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return { start, end };
}

// Loose comparison for the self-healing check. Case and whitespace only — a
// writer who capitalises a label differently has not moved the row.
function sameLabel(a, b) {
  return String(a || '').trim().toLowerCase().replace(/\s+/g, ' ') ===
    String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Find the row in `table` whose cells contain `labelText`, returning its index or
// -1. Used only when the stored coordinate's neighbouring label does not match.
function findRowByLabel(table, labelText, skipColumn) {
  const rows = (table.tableRows || []);
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].tableCells || [];
    for (let c = 0; c < cells.length; c++) {
      if (c === skipColumn) continue;
      if (sameLabel(cellText(cells[c]), labelText)) return r;
    }
  }
  return -1;
}

// Resolve every stored marker to a live cell range in this document.
//
//   doc:     documents.get JSON of the COPIED template
//   markers: db/templateMarkers rows — { marker_key, marker_name, part,
//            table_index, row_index, column_index, label_text, ... }
//
// Returns [{ marker, start, end, row, healed, reason }] for the ones found, and
// carries `missing: [{ marker, reason }]` for the ones that could not be located.
// A marker is never written to a guessed cell — a wrong cell in a client
// deliverable is not a recoverable kind of wrong.
function locateCells(doc, markers) {
  const parts = partsOf(doc);
  const found = [];
  const missing = [];

  for (const m of markers || []) {
    if (!m || m.part == null || m.table_index == null || m.row_index == null || m.column_index == null) {
      missing.push({ marker: m, reason: 'no cell coordinate was recorded for this marker' });
      continue;
    }
    const tables = parts[m.part] || [];
    const table = tables[m.table_index];
    if (!table) {
      missing.push({ marker: m, reason: `table ${m.table_index + 1} is not in the ${m.part}` });
      continue;
    }

    let rowIndex = m.row_index;
    let healed = false;
    const rows = table.tableRows || [];

    // THE SELF-HEALING CHECK. Only runs when a label was recorded — a marker
    // whose row never had a readable label has nothing to check against, and
    // the coordinate is taken at face value.
    if (m.label_text) {
      const atCoord = rows[rowIndex] ? (rows[rowIndex].tableCells || []) : [];
      const labelHere = atCoord.some((cell, c) => c !== m.column_index && sameLabel(cellText(cell), m.label_text));
      if (!labelHere) {
        const better = findRowByLabel(table, m.label_text, m.column_index);
        if (better === -1) {
          missing.push({
            marker: m,
            reason: `row ${rowIndex + 1} no longer reads "${m.label_text}" and no other row does — the document has been edited`,
          });
          continue;
        }
        rowIndex = better;
        healed = true;
      }
    }

    const row = rows[rowIndex];
    const cell = row && (row.tableCells || [])[m.column_index];
    if (!cell) {
      missing.push({ marker: m, reason: `no cell at row ${rowIndex + 1}, column ${m.column_index + 1}` });
      continue;
    }
    const range = cellRange(cell);
    if (!range) {
      missing.push({ marker: m, reason: 'the cell has no content range' });
      continue;
    }

    found.push({
      marker: m,
      start: range.start,
      end: range.end,
      row: rowIndex,
      // What the cell reads RIGHT NOW. Carried here because the caller already
      // paid for the traversal that found the cell, and because every consumer
      // that wants a range wants the text too: the writer diffs against it, the
      // reader reports it, the reviewer measures it.
      text: cellText(cell),
      healed,
      reason: healed ? `found by label at row ${rowIndex + 1} instead of the stored row ${m.row_index + 1}` : null,
    });
  }

  return { found, missing };
}

// Build the batchUpdate requests that put `values` into the located cells.
//
//   located: locateCells(...).found
//   values:  Map|Object of marker_key -> copy
//
// EMITTED HIGHEST INDEX FIRST. See the header — this is what makes one
// batchUpdate safe without a re-read between writes.
//
// A marker with no copy sends NOTHING. Its cell keeps whatever is in it, which
// for a fresh copy is the {{marker}} itself. That is the same rule the fill path
// follows and the same reason: an empty cell reads as "nobody wrote this yet"
// and a visible {{Form ID}} reads as "this one is not mine to write", and only
// the second is true.
function buildCellWriteRequests(located, values) {
  const get = (k) => (values instanceof Map ? values.get(k) : values ? values[k] : undefined);

  const writable = [];
  const skipped = [];
  for (const c of located || []) {
    const copy = get(c.marker.marker_key);
    if (typeof copy !== 'string' || !copy.trim()) {
      skipped.push(c.marker.marker_name);
      continue;
    }
    writable.push({ ...c, copy: copy.trim() });
  }

  // Descending by start index. Two cells cannot share a start, so the order is
  // total and no tie-break is needed.
  writable.sort((a, b) => b.start - a.start);

  const requests = [];
  for (const c of writable) {
    // The trailing newline is the paragraph mark. Deleting it corrupts the cell.
    if (c.end - 1 > c.start) {
      requests.push({ deleteContentRange: { range: { startIndex: c.start, endIndex: c.end - 1 } } });
    }
    requests.push({ insertText: { location: { index: c.start }, text: c.copy } });
  }

  return { requests, written: writable.map((c) => c.marker.marker_name), skipped };
}

// Is this cell still showing the marker it was meant to have copy written into?
//
// Compared through placeholderKey, the same fold docPlaceholders used to derive
// marker_key in the first place, so `{{Form Headline}}`, `{{ form headline }}`
// and `{{Form  Headline}}` all read as the same marker still standing. Any OTHER
// {{token}} in the cell is somebody else's marker and is not this one.
//
// The distinction matters more than it looks. An empty cell means "nobody has
// written this yet"; a cell reading {{Form ID}} means "this one is not Quillio's
// to write". Only the second is a finished state, and only a cell that is BOTH
// marked as copy AND still showing its marker is a fault worth a comment.
function markerStillShowing(text, markerKey) {
  const key = String(markerKey || '').trim();
  if (!key) return false;
  for (const m of String(text || '').matchAll(/\{\{([^{}\n]*?)\}\}/g)) {
    if (placeholderKey(m[1]) === key) return true;
  }
  return false;
}

// READ BACK every stored coordinate against a BUILT document.
//
// The copy in the campaign folder, not the source template. The coordinate is
// structural — body table N, row R, column C — so it still points at the right
// cell after the marker has been replaced by copy. That is the property the whole
// rework rests on, and this is the function that makes it checkable: the marker
// text is gone, and the cell is still found.
//
// Returns one row per marker in the order given, plus the same `missing` list
// locateCells produces. A row is a report, not a write plan — nothing here
// touches the document.
function readCells(doc, markers) {
  const { found, missing } = locateCells(doc, markers || []);
  const byKey = new Map(found.map((c) => [c.marker.marker_key, c]));

  const rows = [];
  for (const m of markers || []) {
    const c = byKey.get(m.marker_key);
    if (!c) continue; // reported through `missing`
    rows.push({
      marker_key: m.marker_key,
      marker_name: m.marker_name,
      is_copy: m.is_copy === true,
      char_max: m.char_max || 0,
      char_min: m.char_min || 0,
      field_type: m.field_type === 'words' ? 'words' : 'text',
      part: m.part,
      table_index: m.table_index,
      row_index: c.row,
      column_index: m.column_index,
      text: c.text,
      empty: !String(c.text || '').trim(),
      showingMarker: markerStillShowing(c.text, m.marker_key),
      healed: c.healed,
      healedReason: c.reason,
      start: c.start,
      end: c.end,
    });
  }

  return { rows, missing: missing.map((x) => ({ name: x.marker && x.marker.marker_name, reason: x.reason })) };
}

module.exports = {
  locateCells,
  readCells,
  markerStillShowing,
  buildCellWriteRequests,
  cellText,
  cellRange,
  tablesIn,
  partsOf,
  sameLabel,
  findRowByLabel,
};
