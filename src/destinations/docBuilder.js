'use strict';

// Builds a Google Docs batchUpdate payload from a sequence of styled blocks.
//
// Google Docs has no API to insert text and style it in one call, and indices
// shift as text is inserted. To keep the math simple we build the entire
// document text first (tracking each block's index range), insert it in one
// shot at index 1, then apply paragraph/text styling over the recorded ranges.
//
// Note: Google Docs does not support inserting a real <hr> element via the API,
// so a horizontal rule is rendered as an empty paragraph with a bottom border.

const {
  tableInsertRequests,
  tableStyleRequests,
  cellFillRequests,
} = require('./docHeaderTable');

const BLACK_BORDER = {
  color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
  width: { magnitude: 1, unit: 'PT' },
  padding: { magnitude: 1, unit: 'PT' },
  dashStyle: 'SOLID',
};

// Left-indent a paragraph by `pt` points (both the block and its first line, so
// wrapped lines and the paragraph align). Used to nest grouped fields.
function indentStyle(pt) {
  return {
    indentStart: { magnitude: pt, unit: 'PT' },
    indentFirstLine: { magnitude: pt, unit: 'PT' },
  };
}

class DocBuilder {
  // `startIndex` is where this builder's text is inserted (default 1 — the top of
  // an empty doc). Pass a higher index to render a body AFTER something already in
  // the doc (e.g. a header table), so all recorded ranges land at the right place.
  constructor(startIndex = 1) {
    this.startIndex = startIndex;
    this.text = '';
    this.paragraphRequests = [];
    this.textRequests = [];
    this.bulletRequests = [];
    this.headerSchema = null;
  }

  // Append a paragraph (text + trailing newline) and record its styling.
  // Returns the [start, end) document index range of the inserted text.
  _push(content, { paragraphStyle, paragraphFields, textStyle, textFields } = {}) {
    const start = this.startIndex + this.text.length;
    this.text += content + '\n';
    const end = this.startIndex + this.text.length; // includes the newline

    const range = { startIndex: start, endIndex: end };

    if (paragraphStyle) {
      this.paragraphRequests.push({
        updateParagraphStyle: { range, paragraphStyle, fields: paragraphFields },
      });
    }
    if (textStyle && content.length > 0) {
      this.textRequests.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: start + content.length },
          textStyle,
          fields: textFields,
        },
      });
    }
    return range;
  }

  title(text) {
    this._push(text, {
      paragraphStyle: { alignment: 'CENTER' },
      paragraphFields: 'alignment',
      textStyle: { bold: true, fontSize: { magnitude: 18, unit: 'PT' } },
      textFields: 'bold,fontSize',
    });
  }

  horizontalRule() {
    this._push('', {
      paragraphStyle: { borderBottom: BLACK_BORDER },
      paragraphFields: 'borderBottom',
    });
  }

  heading(text) {
    this._push(text, {
      paragraphStyle: { namedStyleType: 'HEADING_2' },
      paragraphFields: 'namedStyleType',
    });
  }

  assetHeading(text) {
    this._push(text, {
      paragraphStyle: { namedStyleType: 'HEADING_3' },
      paragraphFields: 'namedStyleType',
    });
  }

  // A sub-group heading within an asset, e.g. "Graphic Copy" — the on-graphic
  // copy fields (Graphic Headline / Subhead / CTA) rendered as one unit. Styled
  // as HEADING_4 so parseDoc recognizes and skips it (it is NOT a field and must
  // never be drafted into); the fields beneath it are indented for grouping.
  groupLabel(text) {
    this._push(text, {
      paragraphStyle: { namedStyleType: 'HEADING_4' },
      paragraphFields: 'namedStyleType',
    });
  }

  italic(text) {
    this._push(text, {
      textStyle: { italic: true },
      textFields: 'italic',
    });
  }

  // A centered, bold, muted-grey line — used as a visible, system-looking
  // boundary between an editable header and the sample body in the onboarding
  // sample doc (docHeaderSample.js). Styled so it reads as a divider/instruction,
  // not editable copy; the exact text is the stable marker a later re-read keys
  // off (see HEADER_BOUNDARY_MARKER).
  boundaryMarker(text) {
    this._push(text, {
      paragraphStyle: { alignment: 'CENTER' },
      paragraphFields: 'alignment',
      textStyle: {
        bold: true,
        foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } },
      },
      textFields: 'bold,foregroundColor',
    });
    return this;
  }

  // Per-field writing guidance (the Sheet's Notes), shown under the field label.
  // Italic + muted grey so it reads as guidance, distinct from drafted copy
  // (regular weight) and the asset meta line (plain italic). Parsers recognize
  // it by the italic style + its position right after the bold label.
  fieldNote(text, { indent = 0 } = {}) {
    this._push(text, {
      paragraphStyle: indent ? indentStyle(indent) : undefined,
      paragraphFields: indent ? 'indentStart,indentFirstLine' : undefined,
      textStyle: {
        italic: true,
        foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } },
      },
      textFields: 'italic,foregroundColor',
    });
  }

  // A bold field label, e.g. "Headline [30]". `indent` (PT) shifts the paragraph
  // right so fields grouped under a sub-heading (e.g. Graphic Copy) read as
  // nested. Indentation is purely visual — parseDoc ignores it.
  boldLabel(text, { indent = 0 } = {}) {
    this._push(text, {
      paragraphStyle: indent ? indentStyle(indent) : undefined,
      paragraphFields: indent ? 'indentStart,indentFirstLine' : undefined,
      textStyle: { bold: true },
      textFields: 'bold',
    });
  }

  // A paragraph rendered as a clickable hyperlink.
  link(label, url) {
    this._push(label, {
      textStyle: {
        link: { url },
        underline: true,
        foregroundColor: { color: { rgbColor: { red: 0.06, green: 0.45, blue: 0.86 } } },
      },
      textFields: 'link,underline,foregroundColor',
    });
  }

  // A blank paragraph — the draft-insertion point under a field label. When the
  // field is grouped, indent it so the drafted copy inherits the group's
  // indentation and stays visually nested.
  blankLine({ indent = 0 } = {}) {
    this._push(
      '',
      indent
        ? { paragraphStyle: indentStyle(indent), paragraphFields: 'indentStart,indentFirstLine' }
        : {}
    );
  }

  // A plain text line (regular weight, left aligned) — the generic `text` header
  // block. Empty string renders an empty paragraph.
  text(str) {
    this._push(String(str == null ? '' : str));
    return this;
  }

  // A row of "label: value" pairs on one line, values bold — used for the
  // `field_row` header block (e.g. Date / Version) and for a single-field `text`
  // block that carries a label. Mirrors the table cell's visual language:
  // "Label: " in regular weight, the value in bold, multiple pairs separated by a
  // 4-space gap. Bold is applied per-value via recorded text ranges.
  fieldRow(fields) {
    const list = (fields || []).filter((f) => f && (f.label != null || f.value != null));
    if (list.length === 0) {
      this.blankLine();
      return this;
    }
    let content = '';
    const boldRanges = [];
    list.forEach((f, i) => {
      if (i > 0) content += '    '; // gap between pairs (matches the table cells)
      content += `${f.label == null ? '' : f.label}: `;
      const valStart = content.length;
      const val = f.value == null ? '' : String(f.value);
      content += val;
      if (val) boldRanges.push([valStart, content.length]);
    });
    const range = this._push(content);
    for (const [s, e] of boldRanges) {
      this.textRequests.push({
        updateTextStyle: {
          range: { startIndex: range.startIndex + s, endIndex: range.startIndex + e },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    }
    return this;
  }

  // Render a block-based header schema (see docHeaderSchema.js) by looping its
  // blocks and dispatching each to the matching primitive. Reuses existing
  // primitives where they fit; only text()/fieldRow() are new. A `table` block is
  // recorded via headerTable() (two-phase — the caller orchestrates it, see
  // createDocument). Unknown block types are skipped safely.
  //
  // The `fill` classification on fields is carried in the schema but not consumed
  // here — rendering uses each field's stored `value` verbatim; auto-fill
  // population is a later step.
  renderHeader(schema) {
    const blocks = (schema && schema.blocks) || [];
    for (const block of blocks) {
      switch (block && block.type) {
        case 'heading':
          this.heading(String(block.text || ''));
          break;
        case 'text':
          if (block.label != null) this.fieldRow([{ label: block.label, value: block.value }]);
          else this.text(String(block.text || ''));
          break;
        case 'field_row':
          this.fieldRow(block.fields || []);
          break;
        case 'divider':
          this.horizontalRule();
          break;
        case 'table':
          this.headerTable(block.table);
          break;
        default:
          // Unknown/edge block — skip rather than fail doc creation.
          break;
      }
    }
    return this;
  }

  // True once renderHeader() (or headerTable()) has recorded a pending header
  // table — the signal to run the two-phase table flow instead of a single batch.
  hasHeaderTable() {
    return !!this.headerSchema;
  }

  // A disc-bullet list item. Records a createParagraphBullets request over the
  // paragraph's range using the BULLET_DISC_CIRCLE_SQUARE preset (disc at the
  // top level). The bullet text carries no leading tabs, so the operation adds
  // no nesting and removes no characters — absolute indices stay stable, so it
  // can be applied after the text is inserted without shifting other ranges.
  bullet(text) {
    const range = this._push(text);
    this.bulletRequests.push({
      createParagraphBullets: { range, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
    });
  }

  // Returns the full ordered batchUpdate requests array. Inserts this builder's
  // text at `startIndex` (all recorded style ranges are already relative to it),
  // then applies paragraph/text/bullet styling over those ranges.
  buildRequests() {
    return [
      { insertText: { location: { index: this.startIndex }, text: this.text } },
      ...this.paragraphRequests,
      ...this.textRequests,
      ...this.bulletRequests,
    ];
  }

  // --- Structured metadata header table (doc-header-template work, step 1) ---
  //
  // Unlike the text blocks above, a Docs table can't be built in one batchUpdate:
  // cell indices aren't known until the table exists (see docHeaderTable.js). So
  // this records the schema, and rendering is two-phase — the caller:
  //   1. applies headerTableInsertRequests()  (inserts the empty table),
  //   2. re-reads the doc + locates the table (docHeaderTable.findHeaderTable),
  //   3. applies headerTableFillRequests(tableEl)  (styles + fills the cells),
  //   4. re-reads for the table's new end index and renders the body after it
  //      (new DocBuilder(tableEndIndex)).
  headerTable(schema) {
    this.headerSchema = schema;
    return this;
  }

  // Phase 1 requests: insert the empty header table at the top (index 1).
  headerTableInsertRequests() {
    return this.headerSchema ? tableInsertRequests(this.headerSchema) : [];
  }

  // Phase 2 requests: style the table + fill its cells, given the table element
  // located in the re-read document. Structural styling first (index-stable),
  // then reverse-order cell fills.
  headerTableFillRequests(tableEl) {
    if (!this.headerSchema || !tableEl) return [];
    return [
      ...tableStyleRequests(tableEl, this.headerSchema),
      ...cellFillRequests(tableEl, this.headerSchema),
    ];
  }
}

module.exports = { DocBuilder };
