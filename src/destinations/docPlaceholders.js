'use strict';

// PLACEHOLDER DISCOVERY — step one of custom document types.
//
// Given a Google Doc (the Docs API documents.get JSON), find every {{Token}} in
// it and say WHERE it was found. Pure: no Drive, no Docs, no database, no
// Express. That is the point — the risky question this answers is "does the
// convention survive a real tenant's document", and answering it must not
// require credentials.
//
// It discovers only. Nothing here maps a placeholder to a field, and nothing
// here fills one in.
//
// TRAVERSAL. The same shape docHeaderReader walks (:16-21): body.content is a
// list of structural elements, each either a `paragraph` or a `table`; a table
// has tableRows[].tableCells[].content[], which is the same list again. This
// module keeps its own copy rather than importing docHeaderReader's, for one
// reason: that module's traversal is welded to header reconstruction — it stops
// at HEADER_BOUNDARY_MARKER, classifies paragraphs into schema blocks, and
// infers label/value pairs. Discovery wants none of that and must NOT stop at a
// marker. What IS shared is the load-bearing idea, below.
//
// THE LOAD-BEARING IDEA: JOIN THE RUNS FIRST. Google Docs splits a paragraph
// into textRuns at every formatting boundary, and it does this invisibly — a
// user who bolds one brace, or whose document has a spellcheck mark inside a
// word, gets a placeholder split across two or three runs:
//
//     "{{Hero " | "Headline}}"          <- looks identical on screen
//
// Scanning run-by-run finds nothing. paraInfo in docHeaderReader (:57-80) already
// concatenates run contents into one string for the same reason, and that is
// exactly what makes split placeholders work here for free. Every scan in this
// file runs over JOINED text, never over an individual run.
//
// WHAT IS DELIBERATELY NOT HANDLED, and reported instead:
//   • A malformed token ({{Unclosed) is a WARNING, not silence. A tenant who
//     typo'd a brace needs to see it — a discovery pass that quietly finds four
//     of five placeholders is worse than one that finds four and says so.
//   • Headers and footers are OUTSIDE body.content. The Docs API returns them in
//     separate top-level `headers` / `footers` maps. docHeaderReader never looks
//     at them because a copy-doc header block is body content; a real template's
//     running header is not. They are walked here, and labelled, so a tenant
//     whose marker is in a page header is told where it is rather than told it
//     does not exist.

// {{ Anything }} — non-greedy, no nested braces, at most one line. The name is
// trimmed; "{{ Hero Headline }}" and "{{Hero Headline}}" are the same
// placeholder, because a tenant editing in Docs will not be consistent about it.
const TOKEN_RE = /\{\{([^{}\n]*?)\}\}/g;

// The two malformed shapes. Both are scanned over text with every WELL-FORMED
// token already removed (see scanText) — without that, `}}` matches the tail of
// every valid placeholder and the warning list fills with false positives, which
// is exactly what the first version of this did.
const UNCLOSED_RE = /\{\{([^\n]{0,60})/g;
const UNOPENED_RE = /\}\}/g;

// Normalized identity for a placeholder name, so {{Hero Headline}} and
// {{hero  headline}} are one placeholder in the summary. Folded the same way
// utils/normalize folds an asset name, so a future mapping step can key on it
// with the same rules the rest of the system uses.
function placeholderKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Join a paragraph's textRuns into one string. See "THE LOAD-BEARING IDEA".
function paragraphText(paragraph) {
  const els = (paragraph && paragraph.elements) || [];
  let text = '';
  for (const el of els) {
    const tr = el.textRun;
    if (tr && tr.content != null) text += tr.content;
  }
  return text;
}

// Join every paragraph in a cell (or any content list) into one string. A
// placeholder split across two PARAGRAPHS is not joined — a line break inside a
// token is a different document, not a formatting artifact — but a cell holding
// several paragraphs still yields all of their tokens.
function contentTexts(content) {
  return ((content || []).map((e) => (e.paragraph ? paragraphText(e.paragraph) : null)) || []).filter(
    (t) => t != null
  );
}

// Scan one joined string, pushing findings onto the accumulators.
function scanText(text, location, out) {
  if (!text) return;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const raw = m[1];
    const name = raw.trim();
    if (!name) {
      out.warnings.push({ kind: 'empty', text: m[0], location });
      continue;
    }
    out.occurrences.push({ name, key: placeholderKey(name), token: m[0], location });
  }

  // What is left once every valid token is taken out. Anything brace-shaped in
  // the remainder is a typo, and saying so is the whole point: a discovery pass
  // that quietly finds four of five placeholders is worse than one that finds
  // four and tells you the fifth is broken.
  const rest = text.replace(TOKEN_RE, ' ');
  UNCLOSED_RE.lastIndex = 0;
  while ((m = UNCLOSED_RE.exec(rest)) !== null) {
    out.warnings.push({ kind: 'unclosed', text: ('{{' + m[1]).trimEnd().slice(0, 62), location });
  }
  UNOPENED_RE.lastIndex = 0;
  while ((m = UNOPENED_RE.exec(rest)) !== null) {
    out.warnings.push({ kind: 'unopened', text: '}}', location });
  }
}

// Walk a content list (body, a header, a footer, or a table cell).
function walkContent(content, part, out, depth = 0) {
  let tableIndex = 0;
  (content || []).forEach((element, index) => {
    if (element.paragraph) {
      scanText(paragraphText(element.paragraph), { part, kind: 'paragraph', index }, out);
      return;
    }
    if (element.table) {
      const thisTable = tableIndex;
      tableIndex += 1;
      out.tables += 1;
      const rows = element.table.tableRows || [];
      rows.forEach((row, r) => {
        (row.tableCells || []).forEach((cell, c) => {
          const style = cell.tableCellStyle || {};
          // MERGED CELLS. The Docs API puts merged content in the anchor cell and
          // gives it a columnSpan/rowSpan; the covered positions may still appear
          // as empty cells. Both the raw column index and the span are reported,
          // so a caller can tell "column 2" from "columns 2-4 merged" — and an
          // empty covered cell simply yields no tokens, which is correct.
          const location = {
            part,
            kind: 'table',
            tableIndex: thisTable,
            row: r,
            column: c,
            rowSpan: style.rowSpan || 1,
            columnSpan: style.columnSpan || 1,
          };
          for (const text of contentTexts(cell.content)) scanText(text, location, out);
          // A table nested inside a cell is rare but legal. Recurse rather than
          // silently miss it; depth-capped so a malformed document cannot spin.
          if (depth < 4) {
            const nested = (cell.content || []).filter((e) => e.table);
            if (nested.length) walkContent(nested, part, out, depth + 1);
          }
        });
      });
      return;
    }
    if (element.tableOfContents && element.tableOfContents.content) {
      walkContent(element.tableOfContents.content, part, out, depth + 1);
    }
  });
}

// Discover every {{Token}} in a Docs API document.
//
// Returns:
//   {
//     placeholders: [{ name, key, count, locations: [...] }]   // deduped, in first-seen order
//     occurrences:  [{ name, key, token, location }]           // every hit, in document order
//     warnings:     [{ kind, text, location }]                 // malformed markers
//     counts:       { distinct, total, tables, warnings, headers, footers }
//   }
//
// `name` is the token's text as written (trimmed). `key` is its folded identity —
// two spellings of one placeholder share a key and are reported as ONE
// placeholder with two occurrences, because that is what a tenant means by it.
function discoverPlaceholders(doc) {
  const out = { occurrences: [], warnings: [], tables: 0 };
  const d = doc && typeof doc === 'object' ? doc : {};

  walkContent((d.body && d.body.content) || [], 'body', out);

  // Headers and footers live OUTSIDE body.content — see the module comment. Each
  // is keyed by its own id, and a document can have several (first page,
  // even/odd, per-section), so the id is carried into the location.
  const headerIds = Object.keys(d.headers || {});
  for (const id of headerIds) {
    walkContent((d.headers[id] || {}).content || [], 'header', out);
  }
  const footerIds = Object.keys(d.footers || {});
  for (const id of footerIds) {
    walkContent((d.footers[id] || {}).content || [], 'footer', out);
  }

  // Deduped view, in first-seen order.
  const byKey = new Map();
  for (const o of out.occurrences) {
    if (!byKey.has(o.key)) byKey.set(o.key, { name: o.name, key: o.key, count: 0, locations: [] });
    const entry = byKey.get(o.key);
    entry.count += 1;
    entry.locations.push(o.location);
  }
  const placeholders = [...byKey.values()];

  return {
    placeholders,
    occurrences: out.occurrences,
    warnings: out.warnings,
    counts: {
      distinct: placeholders.length,
      total: out.occurrences.length,
      tables: out.tables,
      warnings: out.warnings.length,
      headers: headerIds.length,
      footers: footerIds.length,
    },
  };
}

// A one-line human description of a location, for the settings UI and for logs.
function describeLocation(loc) {
  if (!loc) return 'unknown';
  const part = loc.part === 'body' ? '' : `${loc.part} · `;
  if (loc.kind === 'table') {
    const span =
      loc.columnSpan > 1 || loc.rowSpan > 1 ? ` (merged ${loc.rowSpan}×${loc.columnSpan})` : '';
    return `${part}table ${loc.tableIndex + 1}, row ${loc.row + 1}, column ${loc.column + 1}${span}`;
  }
  return `${part}paragraph ${loc.index + 1}`;
}

module.exports = {
  discoverPlaceholders,
  describeLocation,
  placeholderKey,
  TOKEN_RE,
};
