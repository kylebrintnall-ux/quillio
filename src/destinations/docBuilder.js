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

const BLACK_BORDER = {
  color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
  width: { magnitude: 1, unit: 'PT' },
  padding: { magnitude: 1, unit: 'PT' },
  dashStyle: 'SOLID',
};

class DocBuilder {
  constructor() {
    this.text = '';
    this.paragraphRequests = [];
    this.textRequests = [];
    this.bulletRequests = [];
  }

  // Append a paragraph (text + trailing newline) and record its styling.
  // Returns the [start, end) document index range of the inserted text.
  _push(content, { paragraphStyle, paragraphFields, textStyle, textFields } = {}) {
    const start = 1 + this.text.length;
    this.text += content + '\n';
    const end = 1 + this.text.length; // includes the newline

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

  italic(text) {
    this._push(text, {
      textStyle: { italic: true },
      textFields: 'italic',
    });
  }

  // Per-field writing guidance (the Sheet's Notes), shown under the field label.
  // Italic + muted grey so it reads as guidance, distinct from drafted copy
  // (regular weight) and the asset meta line (plain italic). Parsers recognize
  // it by the italic style + its position right after the bold label.
  fieldNote(text) {
    this._push(text, {
      textStyle: {
        italic: true,
        foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } },
      },
      textFields: 'italic,foregroundColor',
    });
  }

  // A bold field label, e.g. "Headline [30]".
  boldLabel(text) {
    this._push(text, {
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

  blankLine() {
    this._push('');
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

  // Returns the full ordered batchUpdate requests array.
  buildRequests() {
    return [
      { insertText: { location: { index: 1 }, text: this.text } },
      ...this.paragraphRequests,
      ...this.textRequests,
      ...this.bulletRequests,
    ];
  }
}

module.exports = { DocBuilder };
