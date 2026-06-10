'use strict';

// Google Docs destination adapter.
//
// Implements the destination contract consumed by the core workflow:
//   createDocument({ brief, summary, writerPrompt, assetSpecs, folderId, referenceLinks }) -> { id, url, title }
//   generateDraft(id) -> { title, fieldCount, url }
//
// Everything Google-Docs-specific (the Drive/Docs API calls, the batchUpdate
// formatting, the stateless doc re-parsing) lives behind this boundary so a
// future Notion/OneDrive adapter can be added without touching the workflow.

const config = require('../config');
const { getClients } = require('../google');
const { DocBuilder } = require('./docBuilder');
const { generateAssetDrafts } = require('../services/gemini');
const { getAssetSpecs } = require('../services/sheets');

// How many assets to draft concurrently (each asset is one batched Gemini call
// plus possible per-field fallbacks). Capped low to bound peak memory/CPU on an
// all-8-assets run. Tunable via DRAFT_CONCURRENCY.
const DRAFT_CONCURRENCY = Number(process.env.DRAFT_CONCURRENCY) || 3;

// Log a memory snapshot so we can see if a big run is approaching a ceiling.
function logMemory(label) {
  const m = process.memoryUsage();
  const mb = (b) => Math.round(b / 1024 / 1024);
  console.log(
    `[mem] ${label}: rss ${mb(m.rss)}MB, heapUsed ${mb(m.heapUsed)}MB, heapTotal ${mb(m.heapTotal)}MB`
  );
}

// Run `fn` over `items` with at most `limit` in flight; preserves input order.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function todayStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Articles / short prepositions that stay lowercase in Title Case unless they
// are the first word.
const SMALL_WORDS = new Set(['a', 'an', 'the', 'for', 'in', 'of', 'at', 'by']);

function toTitleCase(str) {
  return str
    .split(/\s+/)
    .map((word, i) => {
      if (!word) return word;
      if (i > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      // Capitalize the first letter; leave the rest as-is to preserve acronyms.
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// Cleanup pass for Gemini's campaign title: strip the junk models sometimes
// add (labels, surrounding quotes/markdown, an accidental leading date,
// trailing punctuation) and cap the length. Returns '' if nothing usable.
function cleanCampaignTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/^(?:campaign\s*title|title|campaign|name)\s*[:\-–—]\s*/i, ''); // leading label
  t = t.replace(/^\d{4}-\d{2}-\d{2}\s*[-–—:]*\s*/, ''); // accidental leading date
  t = t.replace(/^[*_"'“”‘’\s]+|[*_"'“”‘’\s]+$/g, ''); // surrounding quotes/markdown
  t = t.replace(/[.,;:!]+$/, '').trim(); // trailing punctuation
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 8) t = words.slice(0, 8).join(' '); // keep it concise
  return t;
}

function makeTitle(brief, campaignTitle) {
  // Prefer Gemini's (cleaned) campaign title; fall back to the first few words
  // of the brief if it's empty. Either way: Title Case, with a YYYY-MM-DD prefix.
  const base =
    cleanCampaignTitle(campaignTitle) ||
    String(brief).trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ') ||
    'Campaign';
  return `${todayStamp()} — ${toTitleCase(base)}`;
}

function fieldLabel(field) {
  const limit = field.charLimit && /\d/.test(String(field.charLimit)) ? field.charLimit : 'no limit';
  return `${field.fieldName} [${limit}]`;
}

// Strip the bits of markdown that render as literal characters in a Google Doc:
// **bold** / *italic* markers, leading # heading markers, and leading bullet
// symbols. Returns clean plain text. Applied at doc-write time only.
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1') // *italic* -> italic
    .replace(/^#{1,6}\s*/gm, '') // # heading markers
    .replace(/^\s*[-*•]\s+/gm, ' ') // leading bullet -> space
    .trim();
}

// Pull a Drive/Docs file or folder id out of a Google URL, or null.
function driveIdFromUrl(url) {
  if (!/(?:drive|docs)\.google\.com/.test(url)) return null;
  const m =
    url.match(/\/(?:d|folders)\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Resolve a reference URL to { url, label }. For Drive links, use the file's
// real name; otherwise (or on any failure) fall back to the raw URL.
async function resolveLinkLabel(drive, url) {
  const fileId = driveIdFromUrl(url);
  if (!fileId) return { url, label: url };
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'name',
      supportsAllDrives: true,
    });
    return { url, label: res.data.name || url };
  } catch {
    return { url, label: url };
  }
}

// Creates the formatted Google Doc in the target Drive folder.
// `assetSpecs` is the grouped output of sheets.getAssetSpecs(). `folderId`
// overrides the default folder when present; `referenceLinks` adds a Reference
// Materials section. Returns the destination-agnostic shape { id, url, title }.
async function createDocument({
  brief,
  campaignTitle,
  summary,
  writerPrompt,
  assetSpecs,
  folderId,
  referenceLinks = [],
  referenceInsights = [],
}) {
  logMemory(`createDocument start — ${assetSpecs.length} asset(s), ${referenceLinks.length} link(s)`);
  const { drive, docs } = await getClients();
  const title = makeTitle(brief, campaignTitle);

  const created = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId || config.DRIVE_FOLDER_ID],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const docId = created.data.id;

  // Resolve reference link labels (Drive file names where possible) up front.
  const resolvedLinks = [];
  for (const url of referenceLinks) {
    resolvedLinks.push(await resolveLinkLabel(drive, url));
  }

  const b = new DocBuilder();
  b.title(title);
  b.horizontalRule();

  b.heading('Campaign Summary');
  b.italic(stripMarkdown(summary) || '(no summary)');

  b.heading('Writer Direction');
  const wdLines = (stripMarkdown(writerPrompt) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (wdLines.length === 0) {
    b.italic('(no direction)');
  } else {
    for (const line of wdLines) {
      // Pain Points renders as a label line + a disc bullet per pipe-separated
      // item. Every other field stays a plain prose line.
      const pp = line.match(/^pain points\s*:\s*(.*)$/i);
      if (pp) {
        b.italic('Pain Points:');
        const points = pp[1].split('|').map((p) => p.trim()).filter(Boolean);
        for (const p of points) b.bullet(p);
      } else {
        b.italic(line);
      }
    }
  }

  // Reference Insights — what was extracted per source. Omitted when empty.
  if (Array.isArray(referenceInsights) && referenceInsights.length > 0) {
    b.heading('Reference Insights');
    for (const ins of referenceInsights) {
      const source = String((ins && ins.source) || '').trim() || 'Unknown source';
      const type = String((ins && ins.type) || '').trim();
      b.italic(type ? `From: ${source} (${type})` : `From: ${source}`);

      const stats = Array.isArray(ins && ins.stats) ? ins.stats.filter(Boolean) : [];
      if (stats.length) {
        b.italic('Stats:');
        for (const s of stats) b.bullet(String(s).trim());
      }

      const keyMessages = Array.isArray(ins && ins.keyMessages) ? ins.keyMessages.filter(Boolean) : [];
      if (keyMessages.length) {
        b.italic('Key messages:');
        for (const m of keyMessages) b.bullet(String(m).trim());
      }

      b.blankLine();
    }
  }

  if (resolvedLinks.length > 0) {
    b.heading('Reference Materials');
    for (const { url, label } of resolvedLinks) {
      b.link(label, url);
    }
  }

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

// Lookup key for matching a doc field back to its Sheet row.
function ctxKey(assetType, fieldName) {
  return `${String(assetType).trim().toLowerCase()}|${String(fieldName).trim().toLowerCase()}`;
}

// Reads the spec Sheet and returns a Map of ctxKey -> { channel, toneNotes,
// notes, funnelStage, charLimit } so drafting can recover the per-field
// guidance the doc doesn't carry. Best-effort: returns an empty Map on failure.
async function loadSheetContext() {
  const map = new Map();
  try {
    const specs = await getAssetSpecs();
    for (const group of specs) {
      for (const f of group.fields) {
        map.set(ctxKey(group.assetType, f.fieldName), {
          channel: group.channel,
          toneNotes: group.toneNotes,
          notes: f.notes,
          funnelStage: f.funnelStage,
          charLimit: f.charLimit,
        });
      }
    }
  } catch (err) {
    console.warn('[googleDocs] could not load Sheet context for drafting:', err.message);
  }
  return map;
}

// Reads the doc, drafts copy for every field via Gemini, and inserts it under
// each label. Returns { title, fieldCount }.
async function generateDraft(id) {
  const { docs } = await getClients();

  const doc = (await docs.documents.get({ documentId: id })).data;
  const { summary, writerPrompt, assets } = parseDoc(doc);

  // The doc only carries asset/channel/tone/field-label — the Sheet's per-field
  // Notes and Funnel Stage never made it in. Re-read the Sheet and match by
  // asset + field name to restore that context for the drafter. (The doc is
  // still the source of truth for *positions*.) Best-effort: if the Sheet read
  // fails, drafting proceeds with just the doc-derived context.
  const sheetCtx = await loadSheetContext();

  // Build per-asset draft targets, enriching each field with Sheet context.
  const assetTargets = assets
    .filter((asset) => asset.fields.length > 0)
    .map((asset) => {
      const fields = asset.fields.map((field) => {
        const ctx = sheetCtx.get(ctxKey(asset.assetType, field.fieldName)) || {};
        return {
          fieldName: field.fieldName,
          charLimit: field.charLimit || ctx.charLimit,
          notes: ctx.notes || '',
          funnelStage: ctx.funnelStage || '',
          insertIndex: field.insertIndex,
        };
      });
      const ctx0 = sheetCtx.get(ctxKey(asset.assetType, asset.fields[0].fieldName)) || {};
      return {
        assetType: asset.assetType,
        channel: ctx0.channel || asset.channel,
        toneNotes: ctx0.toneNotes || asset.toneNotes,
        fields,
      };
    });

  // Draft each asset's fields together (one batched call per asset) so the copy
  // is cohesive. Assets run with bounded concurrency; one asset failing is
  // logged and skipped rather than aborting the whole run.
  const total = assetTargets.length;
  logMemory(`generateDraft start — ${total} asset(s), concurrency ${DRAFT_CONCURRENCY}`);

  const perAsset = await mapWithConcurrency(assetTargets, DRAFT_CONCURRENCY, async (a, idx) => {
    console.log(`[googleDocs] generating asset ${idx + 1}/${total}: ${a.assetType}`);
    try {
      const drafts = await generateAssetDrafts({
        assetType: a.assetType,
        channel: a.channel,
        toneNotes: a.toneNotes,
        summary,
        writerPrompt,
        fields: a.fields,
      });
      const idxByName = new Map(a.fields.map((f) => [f.fieldName, f.insertIndex]));
      const mapped = drafts
        .map((d) => ({ insertIndex: idxByName.get(d.fieldName), copy: d.copy }))
        .filter((r) => r.insertIndex != null && r.copy);
      console.log(`[googleDocs] asset ${idx + 1}/${total} done: ${a.assetType} (${mapped.length} fields)`);
      return mapped;
    } catch (err) {
      console.error(
        `[googleDocs] asset ${idx + 1}/${total} FAILED: ${a.assetType}: ${err.message}`
      );
      return [];
    }
  });
  logMemory(`generateDraft end — ${total} asset(s)`);

  const drafted = perAsset.flat();

  const totalFields = assetTargets.reduce((n, a) => n + a.fields.length, 0);
  if (totalFields > 0 && drafted.length === 0) {
    throw new Error('All field drafts failed (Gemini timeout or error).');
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

  return {
    title: doc.title,
    fieldCount: drafted.length,
    url: `https://docs.google.com/document/d/${id}/edit`,
  };
}

// The destination adapter contract.
module.exports = {
  name: 'google-docs',
  createDocument,
  generateDraft,
};
