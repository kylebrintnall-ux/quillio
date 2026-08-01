'use strict';

// READ A TEMPLATE'S TABLE AND WORK OUT WHAT EACH MARKER IS (document templates,
// rework step one).
//
// Pure, like docPlaceholders — and like it, requires NOTHING: no Drive, no Docs,
// no database, no Express, no Gemini. It takes the Docs API documents.get JSON
// plus the discovered markers and proposes, per marker, a field name and a
// character limit — read off the TABLE ITSELF.
//
// WHY NO MODEL. A copy matrix already carries everything a copy doc's labels
// carry, just in a different geometry: a row has an Element column ("Headline"),
// a Char limit column ("60"), and a Copy column holding {{Headline}}. Reading
// that row is table walking, not language understanding. Three reasons the
// structural read is the RIGHT call and not merely the cheap one:
//
//   1. It is EXPLAINABLE. "Column 3 looked like limits: 60, 120, 40 — right?"
//      is a proposal a tenant corrects in one glance. A model's answer cannot be
//      shown its own reasoning and cannot be spot-checked the same way.
//   2. It is free and instant. A model call on upload is a latency spike on the
//      one screen where the tenant is already waiting for an import.
//   3. The failure mode is better. A hallucinated limit of 60 on a 200-character
//      field silently truncates copy forever, invisibly. A structural read that
//      finds nothing reports nothing, and the tenant fills it in.
//
// EVERYTHING HERE IS A PROPOSAL. The tenant confirms on one screen and their
// answer is what gets stored. Nothing derived here is treated as fact.
//
// TWO WAYS TO READ A ROW, in order:
//
//   A. COLUMN ROLES from the header row. A real matrix names its columns —
//      "Field | Copy | Character limit | Element ID | Notes" — so row 0 of the
//      marker's own table is read once, each header matched against a small set
//      of patterns, and every marker row below is then addressed by role. This
//      is the accurate path and the one a real document takes.
//
//   B. POSITIONAL FALLBACK when there is no header row. The label is the
//      leftmost non-empty text cell in the row that is not the marker cell; the
//      limit is any cell whose whole text is a bare integer or an obvious
//      count ("60 chars", "max 60"). Deterministic, weaker, and reported as
//      such — `labelSource` and `limitSource` say which path produced each
//      value so the confirm screen can show its work.

// Column-role patterns. Deliberately narrow: a header that does not clearly
// name a role produces no role, and the row falls back to the positional read.
// Guessing a role wrong is worse than not having one — it puts a confident wrong
// label in front of a tenant who is skim-reading 33 rows.
const ROLE_PATTERNS = [
  ['label', /field|element|section|name|placement|item/i],
  ['limit', /char|limit|count|max|length/i],
  ['note', /note|guidance|direction|comment|instruction/i],
];

// Markers a writer does not draft. Used ONLY to propose is_copy = false; the
// tenant ticks. Kept here rather than imported from the reporting script so the
// production path does not depend on a script.
const METADATA_HINT = /\b(id|code|url|owner|updated|locale|version|status|date|link|slug|key|ref)\b/i;

// The text of one table cell, paragraphs joined. Same run-joining docPlaceholders
// does, and for the same reason: Docs splits a paragraph at every formatting
// boundary, so reading run-by-run misses half of a bolded label.
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

// Every table in a document part, in the order docPlaceholders numbers them, so
// a stored tableIndex means the same thing in both modules.
function tablesIn(content) {
  const out = [];
  for (const el of content || []) if (el.table) out.push(el.table);
  return out;
}

// Read row 0's cells as column roles. Returns { label: 2, limit: 3, ... } keyed
// by role → column index, or an empty object when the row names nothing.
//
// A row only counts as a header if at least ONE cell matches a role AND no cell
// contains a marker — a matrix whose first row is already data has no header,
// and treating it as one would label every field with the first field's copy.
function columnRoles(table) {
  const rows = table.tableRows || [];
  if (!rows.length) return {};
  const cells = rows[0].tableCells || [];
  const texts = cells.map(cellText);
  if (texts.some((t) => /\{\{/.test(t))) return {};

  const roles = {};
  texts.forEach((text, i) => {
    if (!text) return;
    for (const [role, pattern] of ROLE_PATTERNS) {
      // First column to claim a role keeps it. A matrix with both "Character
      // limit" and "Max length" is claiming the same thing twice; the left one
      // is the one a reader's eye lands on.
      if (roles[role] == null && pattern.test(text)) roles[role] = i;
    }
  });
  return roles;
}

// A bare count, or an obvious one. "60", "60 chars", "max 60", "up to 60
// characters" → 60. "—", "n/a", "" → null. A cell with prose and a number in it
// ("keep under 60 if possible") is deliberately NOT read: it is a note, and
// lifting a number out of a sentence is exactly the confident-wrong-answer this
// module avoids.
function parseLimit(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:max(?:imum)?|up to|under|≤|<=)?\s*(\d+)\s*(?:char(?:acter)?s?|chars?)?$/i);
  if (m) return parseInt(m[1], 10);
  const m2 = t.match(/^(\d+)\s*(?:char(?:acter)?s?|words?)\b/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

// Does this cell text look like a count rather than a label? Used by the
// positional fallback to avoid proposing "60" as a field name.
function looksNumeric(text) {
  return parseLimit(text) != null;
}

// Is the limit counted in WORDS? Only when the cell says so — a matrix that
// writes "120 words" means something different from "120", and the drafter is
// told a different thing (googleDocs generateDraft passes fieldType through).
function limitUnit(text) {
  return /\bwords?\b/i.test(String(text || '')) ? 'words' : 'text';
}

// Derive one marker's field properties from the row it sits in.
function deriveOne(marker, location, table) {
  const rows = (table && table.tableRows) || [];
  const row = rows[location.row];
  const cells = (row && row.tableCells) || [];
  const roles = columnRoles(table);

  const out = {
    key: marker.key,
    name: marker.name,
    label: null,
    labelSource: 'none',
    labelText: null,
    charMin: 0,
    charMax: 0,
    fieldType: 'text',
    limitSource: 'none',
    specNote: null,
  };

  // --- label ---------------------------------------------------------------
  if (roles.label != null && roles.label !== location.column) {
    const text = cellText(cells[roles.label]);
    if (text && !/\{\{/.test(text)) {
      out.label = text;
      out.labelSource = 'header-column';
    }
  }
  if (!out.label) {
    // Positional fallback: leftmost non-empty text cell that is neither the
    // marker's own cell nor a number.
    for (let c = 0; c < cells.length; c++) {
      if (c === location.column) continue;
      const text = cellText(cells[c]);
      if (!text || /\{\{/.test(text) || looksNumeric(text)) continue;
      out.label = text;
      out.labelSource = 'leftmost';
      break;
    }
  }
  if (!out.label) {
    // Nothing in the row to read. The marker's own name is the last resort and
    // is always available — {{Form Headline}} is a serviceable field name.
    out.label = marker.name;
    out.labelSource = 'marker-name';
  }
  // THE SELF-HEALING HINT. Stored beside the coordinate so a later read can
  // check it: go to (table, row, column), and if the neighbouring label is not
  // this string, the document has been edited and the row must be found by
  // label instead. Null when the label came from the marker itself — there is
  // no neighbouring cell to check against.
  out.labelText = out.labelSource === 'marker-name' ? null : out.label;

  // --- limit ---------------------------------------------------------------
  let limitText = null;
  if (roles.limit != null && roles.limit !== location.column) {
    limitText = cellText(cells[roles.limit]);
    if (parseLimit(limitText) != null) out.limitSource = 'header-column';
  }
  if (out.limitSource === 'none') {
    for (let c = 0; c < cells.length; c++) {
      if (c === location.column) continue;
      const text = cellText(cells[c]);
      if (parseLimit(text) == null) continue;
      limitText = text;
      out.limitSource = 'bare-number';
      break;
    }
  }
  if (out.limitSource !== 'none') {
    out.charMax = parseLimit(limitText) || 0;
    out.fieldType = limitUnit(limitText);
  }
  // char_max 0 means NO LIMIT throughout this codebase, which is exactly what an
  // unreadable or absent limit should mean — never a limit of zero.

  // --- note ----------------------------------------------------------------
  if (roles.note != null && roles.note !== location.column) {
    const text = cellText(cells[roles.note]);
    if (text && !/\{\{/.test(text)) out.specNote = text.slice(0, 400);
  }

  // --- is_copy -------------------------------------------------------------
  // PROPOSED FALSE unless it looks like copy. Wrongly copy = prose drafted into
  // a form-ID cell, invisible until a client reads it. Wrongly metadata = the
  // marker stays visible, which is this feature's established failure mode
  // everywhere else. The tenant ticks; this only decides which way the box
  // starts.
  const haystack = `${marker.name} ${out.label || ''}`;
  const metadata = METADATA_HINT.test(haystack);
  out.isCopy = !metadata;
  out.isCopyReason = metadata
    ? 'looks like metadata (an id, a code, a date, an owner)'
    : out.limitSource !== 'none'
      ? 'has a character limit, so somebody writes it'
      : 'no metadata words in its name';

  return out;
}

// Derive field properties for every marker in a discovery result.
//
//   doc:          the Docs API documents.get JSON
//   placeholders: docPlaceholders.discoverPlaceholders(doc).placeholders
//
// Returns [{ key, name, label, labelSource, labelText, charMin, charMax,
//            fieldType, limitSource, specNote, isCopy, isCopyReason,
//            position: { part, tableIndex, row, column, rowSpan, columnSpan } }]
// in discovery order. A marker that is NOT in a table (a page header, a loose
// paragraph) still gets a row — its label falls back to the marker name and its
// position records the paragraph — because leaving it out of the confirm screen
// would hide it from the one person who can say what it is.
function deriveTemplateFields(doc, placeholders) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const byPart = {
    body: tablesIn((d.body && d.body.content) || []),
  };
  for (const id of Object.keys(d.headers || {})) {
    byPart.header = (byPart.header || []).concat(tablesIn((d.headers[id] || {}).content || []));
  }
  for (const id of Object.keys(d.footers || {})) {
    byPart.footer = (byPart.footer || []).concat(tablesIn((d.footers[id] || {}).content || []));
  }

  const out = [];
  for (const marker of placeholders || []) {
    // FIRST location wins. A marker appearing in two cells is one field with one
    // limit; the copy goes in both, and the confirm screen shows the count.
    const loc = (marker.locations || [])[0] || null;
    const base = {
      key: marker.key,
      name: marker.name,
      count: marker.count || 1,
      position: loc
        ? {
            part: loc.part,
            tableIndex: loc.kind === 'table' ? loc.tableIndex : null,
            row: loc.kind === 'table' ? loc.row : null,
            column: loc.kind === 'table' ? loc.column : null,
            rowSpan: loc.rowSpan || 1,
            columnSpan: loc.columnSpan || 1,
            paragraphIndex: loc.kind === 'paragraph' ? loc.index : null,
          }
        : null,
    };

    if (!loc || loc.kind !== 'table') {
      // Outside a table: nothing to read a label or a limit from.
      const metadata = METADATA_HINT.test(marker.name);
      out.push({
        ...base,
        label: marker.name,
        labelSource: 'marker-name',
        labelText: null,
        charMin: 0,
        charMax: 0,
        fieldType: 'text',
        limitSource: 'none',
        specNote: null,
        isCopy: !metadata,
        isCopyReason: metadata ? 'looks like metadata' : 'not in a table — nothing to read',
      });
      continue;
    }

    const tables = byPart[loc.part] || [];
    const table = tables[loc.tableIndex];
    if (!table) {
      out.push({ ...base, label: marker.name, labelSource: 'marker-name', labelText: null,
        charMin: 0, charMax: 0, fieldType: 'text', limitSource: 'none', specNote: null,
        isCopy: !METADATA_HINT.test(marker.name), isCopyReason: 'table not found' });
      continue;
    }
    out.push({ ...base, ...deriveOne(marker, loc, table) });
  }
  return out;
}

// A one-line human description of what a table's header row named, for the
// confirm screen and for the report. "" when nothing was named.
function describeRoles(table) {
  const roles = columnRoles(table);
  const parts = [];
  for (const [role] of ROLE_PATTERNS) {
    if (roles[role] != null) parts.push(`${role} = column ${roles[role] + 1}`);
  }
  return parts.join(', ');
}

module.exports = {
  deriveTemplateFields,
  columnRoles,
  describeRoles,
  parseLimit,
  cellText,
  tablesIn,
  METADATA_HINT,
  ROLE_PATTERNS,
};
