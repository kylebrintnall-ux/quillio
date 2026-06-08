'use strict';

// Google Docs destination adapter.
//
// Implements the destination contract consumed by the core workflow:
//   createDocument({ brief, summary, writerPrompt, assetSpecs }) -> { id, url, title }
//   generateDraft(id) -> { title, fieldCount }
//
// Everything Google-Docs-specific (the Drive/Docs API calls, the batchUpdate
// formatting, the stateless doc re-parsing) lives behind this boundary so a
// future Notion/OneDrive adapter can be added without touching the workflow.

const config = require('../config');
const { getClients } = require('../google');
const { DocBuilder } = require('./docBuilder');
const { generateFieldDraft } = require('../services/gemini');

function todayStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function makeTitle(brief) {
  const words = String(brief).trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  return `${todayStamp()} — ${words || 'Campaign'}`;
}

function fieldLabel(field) {
  const limit = field.charLimit && /\d/.test(String(field.charLimit)) ? field.charLimit : 'no limit';
  return `${field.fieldName} [${limit}]`;
}

// Creates the formatted Google Doc in the configured Drive folder.
// `assetSpecs` is the grouped output of sheets.getAssetSpecs().
// Returns the destination-agnostic shape { id, url, title }.
async function createDocument({ brief, summary, writerPrompt, assetSpecs }) {
  const { drive, docs } = await getClients();
  const title = makeTitle(brief);

  const created = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      parents: [config.DRIVE_FOLDER_ID],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const docId = created.data.id;

  const b = new DocBuilder();
  b.title(title);
  b.horizontalRule();

  b.heading('Campaign Summary');
  b.italic(summary || '(no summary)');

  b.heading('Writer Direction');
  b.italic(writerPrompt || '(no direction)');

  b.horizontalRule();

  for (const asset of assetSpecs) {
    b.assetHeading(asset.assetType);
    const meta = [asset.channel, asset.toneNotes].filter(Boolean).join(' · ');
    if (meta) b.italic(meta);
    for (const field of asset.fields) {
      b.boldLabel(fieldLabel(field));
      b.blankLine();
    }
  }

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: b.buildRequests() },
  });

  return { id: docId, url: created.data.webViewLink, title };
}

// --- Draft generation (stateless: re-parses the doc) ---

function runStyle(paragraph) {
  const el = (paragraph.elements || []).find(
    (e) => e.textRun && e.textRun.content && e.textRun.content.trim()
  );
  const ts = el?.textRun?.textStyle || {};
  return { bold: !!ts.bold, italic: !!ts.italic };
}

function paragraphText(paragraph) {
  return (paragraph.elements || [])
    .map((e) => (e.textRun ? e.textRun.content : ''))
    .join('')
    .replace(/\n+$/, '');
}

// Walks the document and reconstructs the campaign context needed to draft copy.
function parseDoc(doc) {
  const summary = { value: '' };
  const writer = { value: '' };
  const assets = [];
  let current = null;
  let expecting = null; // 'summary' | 'writerPrompt'

  for (const item of doc.body.content || []) {
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = p.paragraphStyle?.namedStyleType;
    const text = paragraphText(p).trim();
    const { bold, italic } = runStyle(p);

    if (named === 'HEADING_2' && text === 'Campaign Summary') {
      expecting = 'summary';
      continue;
    }
    if (named === 'HEADING_2' && text === 'Writer Direction') {
      expecting = 'writerPrompt';
      continue;
    }
    if (expecting === 'summary') {
      if (text) {
        summary.value = text;
        expecting = null;
      }
      continue;
    }
    if (expecting === 'writerPrompt') {
      if (text) {
        writer.value = text;
        expecting = null;
      }
      continue;
    }

    if (named === 'HEADING_3') {
      current = { assetType: text, channel: '', toneNotes: '', fields: [], gotMeta: false };
      assets.push(current);
      continue;
    }

    if (current && !current.gotMeta && current.fields.length === 0 && italic && text) {
      const parts = text.split('·').map((s) => s.trim());
      current.channel = parts[0] || '';
      current.toneNotes = parts.slice(1).join(' · ');
      current.gotMeta = true;
      continue;
    }

    const m = text.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
    if (current && bold && m) {
      current.fields.push({
        fieldName: m[1].trim(),
        charLimit: m[2].trim(),
        // The blank paragraph immediately after the label starts where this
        // label paragraph ends; that's our draft insertion point.
        insertIndex: item.endIndex,
      });
    }
  }

  return { summary: summary.value, writerPrompt: writer.value, assets };
}

// Reads the doc, drafts copy for every field via Gemini, and inserts it under
// each label. Returns { title, fieldCount }.
async function generateDraft(id) {
  const { docs } = await getClients();

  const doc = (await docs.documents.get({ documentId: id })).data;
  const { summary, writerPrompt, assets } = parseDoc(doc);

  // Collect all draft targets, then draft copy for each.
  const targets = [];
  for (const asset of assets) {
    for (const field of asset.fields) {
      targets.push({ asset, field });
    }
  }

  const drafted = [];
  for (const { asset, field } of targets) {
    const copy = await generateFieldDraft({
      assetType: asset.assetType,
      channel: asset.channel,
      fieldName: field.fieldName,
      charLimit: field.charLimit,
      toneNotes: asset.toneNotes,
      notes: '',
      summary,
      writerPrompt,
    });
    drafted.push({ insertIndex: field.insertIndex, copy });
  }

  // Insert from the bottom of the doc upward so earlier indices stay valid.
  drafted.sort((a, b) => b.insertIndex - a.insertIndex);

  const requests = [];
  for (const { insertIndex, copy } of drafted) {
    const text = copy + '\n';
    requests.push({ insertText: { location: { index: insertIndex }, text } });
    // Drafted copy should be regular weight, not inherit the bold label style.
    requests.push({
      updateTextStyle: {
        range: { startIndex: insertIndex, endIndex: insertIndex + copy.length },
        textStyle: { bold: false, italic: false },
        fields: 'bold,italic',
      },
    });
  }

  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: id,
      requestBody: { requests },
    });
  }

  return { title: doc.title, fieldCount: drafted.length };
}

// The destination adapter contract.
module.exports = {
  name: 'google-docs',
  createDocument,
  generateDraft,
};
