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
const { findHeaderTable } = require('./docHeaderTable');
const { isValidHeaderSchema } = require('./docHeaderSchema');
const { isValidNamingPattern, applyNamingPattern } = require('./docNaming');
const { generateAssetDrafts } = require('../services/gemini');

// How many assets to draft concurrently (each asset is one batched Gemini call
// plus possible per-field fallbacks). Bounded to keep peak memory/CPU sane on an
// all-8-assets run while cutting wall-clock for typical 4-6 asset briefs.
// Tunable via DRAFT_CONCURRENCY.
const DRAFT_CONCURRENCY = Number(process.env.DRAFT_CONCURRENCY) || 5;

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

// Today's exact default doc name: Title Case campaign with a YYYY-MM-DD prefix.
function defaultTitle(brief, campaignTitle) {
  const base =
    cleanCampaignTitle(campaignTitle) ||
    String(brief).trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ') ||
    'Campaign';
  return `${todayStamp()} — ${toTitleCase(base)}`;
}

// Build the doc filename. With a stored per-tenant naming pattern, fill its
// dynamic spans from real project data and keep the static text verbatim; with
// no/invalid pattern, produce today's EXACT default name unchanged. `namingCtx`
// supplies optional writer/version (campaign/date/year are derived here).
function makeTitle(brief, campaignTitle, namingPattern, namingCtx) {
  if (isValidNamingPattern(namingPattern)) {
    const stamp = todayStamp();
    const campaign =
      cleanCampaignTitle(campaignTitle) ||
      String(brief).trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ') ||
      'Campaign';
    const name = applyNamingPattern(namingPattern, {
      campaign: toTitleCase(campaign),
      date: stamp,
      year: stamp.slice(0, 4),
      version: (namingCtx && namingCtx.version) || 'v1',
      writer: (namingCtx && namingCtx.writer) || '',
    }).trim();
    if (name) return name.slice(0, 200); // usable pattern result
    // empty result (e.g. all-blank tokens) → fall through to the default
  }
  return defaultTitle(brief, campaignTitle);
}

// Left indent (points) applied to fields nested under a group sub-heading.
const GROUP_INDENT_PT = 18;

// Optional writer-facing explainer rendered as an italic line under a field
// label. Pattern-based (not hardcoded per asset) so it applies wherever the
// field appears. "Hook" fields carry the platform's visible-then-"…more"
// mechanic — the char limit is the visible portion; the full post runs longer.
function fieldHint(field) {
  const name = String(field.fieldName || '');
  if (/^Hook\b/i.test(name)) {
    return (
      'Only this opening runs before the app collapses the rest behind “…more.” ' +
      'Land the hook within the character limit; the full caption/post can keep going — it just shows after the fold.'
    );
  }
  return null;
}

function fieldLabel(field) {
  const min = Number(field.charMin) || 0;
  const max = Number(field.charMax) || 0;
  if (min > 0 && max > 0) return `${field.fieldName} [${min}-${max}]`;
  if (max > 0) return `${field.fieldName} [${max}]`;
  return field.fieldName; // charMax === 0 → no bracket
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

// Appends the doc BODY (everything below the top header) onto `b`:
// Campaign Summary, Writer Direction, optional Reference Insights / Reference
// Materials, a horizontal rule, then one section per asset. Identical whether
// the header above it is today's default (title + HR) or a stored header schema,
// so the drafting pipeline still parses these sections the same way in both.
function appendBody(b, { summary, writerPrompt, resolvedLinks, referenceInsights, assetSpecs }) {
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
    // Asset-level creative direction (from Postgres) — one italic line directly
    // under the heading. Falls back to the Sheet's channel · tone meta when no
    // direction is set; omitted entirely when both are empty.
    const direction = String(asset.asset_direction || '').trim();
    const meta = [asset.channel, asset.toneNotes].filter(Boolean).join(' · ');
    const headerLine = direction || meta;
    if (headerLine) b.italic(headerLine);
    // Fields render top-to-bottom. Consecutive fields sharing a group_label
    // (e.g. "Graphic Copy") emit that sub-heading once, then render indented so
    // the on-graphic copy reads as one nested unit.
    let openGroup = null;
    for (const field of asset.fields) {
      const group = field.groupLabel || null;
      if (group !== openGroup) {
        if (group) b.groupLabel(group);
        openGroup = group;
      }
      const indent = group ? GROUP_INDENT_PT : 0;
      b.boldLabel(fieldLabel(field), { indent });
      const hint = fieldHint(field);
      if (hint) b.fieldNote(hint, { indent });
      b.blankLine({ indent });
    }
  }
}

// Creates the formatted Google Doc in the target Drive folder.
// `assetSpecs` is the grouped asset library from Postgres (pipeline's
// tenantAssetsToSpecs). `folderId` overrides the default folder when present;
// `referenceLinks` adds a Reference Materials section. `headerSchema` (optional,
// resolved per-tenant in the pipeline) renders a custom top-of-doc metadata
// header via DocBuilder.renderHeader(); when absent/invalid the doc uses today's
// exact default header (title + HR) unchanged. Returns { id, url, title }.
async function createDocument({
  brief,
  campaignTitle,
  summary,
  writerPrompt,
  assetSpecs,
  folderId,
  referenceLinks = [],
  referenceInsights = [],
  headerSchema = null,
  namingPattern = null,
  namingContext = null,
  clients,
}) {
  logMemory(`createDocument start — ${assetSpecs.length} asset(s), ${referenceLinks.length} link(s)`);
  // Diagnostic (counts only, never content): a missing Reference Materials /
  // Reference Insights section traces back to one of these being 0 here.
  console.log(
    `[googleDocs] createDocument references → links=${(referenceLinks || []).length} insights=${(referenceInsights || []).length}`
  );
  const { drive, docs } = clients || (await getClients());
  const title = makeTitle(brief, campaignTitle, namingPattern, namingContext);
  console.log(`[googleDocs] doc name: ${isValidNamingPattern(namingPattern) ? 'tenant pattern' : 'default'}`);

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

  const bodyFields = { summary, writerPrompt, resolvedLinks, referenceInsights, assetSpecs };
  const useSchema = isValidHeaderSchema(headerSchema);
  console.log(`[googleDocs] doc header: ${useSchema ? 'tenant schema' : 'default (title + HR)'}`);

  // Build the header. With a stored schema, DocBuilder.renderHeader() lays out its
  // blocks; otherwise the default is today's exact header (title + HR) — byte-for-
  // byte unchanged for existing tenants (the critical safety property).
  const b = new DocBuilder();
  if (useSchema) {
    b.renderHeader(headerSchema);
  } else {
    b.title(title);
    b.horizontalRule();
  }

  if (b.hasHeaderTable()) {
    // Two-phase table header (a Docs table can't be built in one batchUpdate —
    // see docHeaderTable.js). Insert the table, re-read to locate/fill it, then
    // render the body BELOW it starting at the table's post-fill end index.
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.headerTableInsertRequests() },
    });

    let reread = (await docs.documents.get({ documentId: docId })).data;
    let tableEl = findHeaderTable(reread);
    if (!tableEl) throw new Error('header table not found after insert');
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.headerTableFillRequests(tableEl) },
    });

    reread = (await docs.documents.get({ documentId: docId })).data;
    tableEl = findHeaderTable(reread);
    const body = new DocBuilder(tableEl.endIndex);
    appendBody(body, bodyFields);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: body.buildRequests() },
    });
  } else {
    // No table anywhere — header + body fold into a single batchUpdate.
    appendBody(b, bodyFields);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.buildRequests() },
    });
  }

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
  let currentField = null; // last field whose copy region we're scanning
  let notesSeen = false; // whether the current field's italic notes line was seen
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
      currentField = null; // a new asset ends the previous field's copy region
      notesSeen = false;
      continue;
    }

    // A group sub-heading (e.g. "Graphic Copy", rendered HEADING_4) is a layout
    // label, not a field — skip it. It ends the previous field's copy region so
    // the heading is never mistaken for drafted copy.
    if (named === 'HEADING_4') {
      currentField = null;
      notesSeen = false;
      continue;
    }

    if (current && !current.gotMeta && current.fields.length === 0 && italic && text) {
      const parts = text.split('·').map((s) => s.trim());
      current.channel = parts[0] || '';
      current.toneNotes = parts.slice(1).join(' · ');
      current.gotMeta = true;
      continue;
    }

    // A field label is a bold paragraph, optionally ending in a [min-max] /
    // [max] bracket (no bracket when charMax was 0). Recover charMin/charMax.
    if (current && bold && text) {
      const m = text.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
      const fieldName = m ? m[1].trim() : text;
      const nums = (m ? m[2] : '').match(/\d+/g);
      let charMin = 0;
      let charMax = 0;
      if (nums) {
        const vals = nums.map(Number);
        charMax = Math.max(...vals);
        if (vals.length >= 2) charMin = Math.min(...vals);
      }
      currentField = {
        fieldName,
        charMin,
        charMax,
        // The blank paragraph immediately after the label starts where this
        // label paragraph ends; that's our draft insertion point (moved past the
        // notes line below when one is present).
        insertIndex: item.endIndex,
        // End of the last non-empty paragraph of already-drafted copy under this
        // label (null = nothing drafted yet). Drives delete-before-insert on
        // regeneration; stays null for a first draft so that path is untouched.
        deleteEnd: null,
        notes: '',
      };
      current.fields.push(currentField);
      notesSeen = false;
      continue;
    }

    // Per-field writing guidance: the italic paragraph right after a label,
    // before any drafted copy (which is always inserted non-italic). It's
    // permanent guidance — never copy, never deleted. Copy goes BELOW it, so
    // advance the insertion point past the notes line.
    if (current && currentField && currentField.deleteEnd == null && !notesSeen && italic && text) {
      notesSeen = true;
      currentField.notes = text;
      currentField.insertIndex = item.endIndex;
      continue;
    }

    // Any other non-empty paragraph under an active field is previously drafted
    // copy. Advance deleteEnd to this paragraph's end; trailing blank lines have
    // empty text and never reach here, so the template blank is preserved.
    if (current && currentField && text) {
      currentField.deleteEnd = item.endIndex;
      continue;
    }
  }

  return { summary: summary.value, writerPrompt: writer.value, assets };
}

// Lookup key for matching a doc field back to its Sheet row.
function ctxKey(assetType, fieldName) {
  return `${String(assetType).trim().toLowerCase()}|${String(fieldName).trim().toLowerCase()}`;
}

// Reads the doc, drafts copy for every field via Gemini, and inserts it under
// each label. Returns { title, fieldCount }.
async function generateDraft(id, direction, clients, voiceGuide, lookupDirection) {
  const { docs } = clients || (await getClients());

  const doc = (await docs.documents.get({ documentId: id })).data;
  const { summary, writerPrompt, assets } = parseDoc(doc);

  // Build per-asset draft targets straight from the doc. The Google Sheet has
  // been retired — per-field Notes / Funnel Stage / channel / tone no longer
  // feed the prompt; asset-level direction (from Postgres) carries the creative
  // guidance, and the doc carries field labels + char limits + positions.
  const assetTargets = assets
    .filter((asset) => asset.fields.length > 0)
    .map((asset) => ({
      assetType: asset.assetType,
      assetDirection: lookupDirection ? lookupDirection(asset.assetType) : null,
      fields: asset.fields.map((field) => ({
        fieldName: field.fieldName,
        charMax: field.charMax || 0,
        insertIndex: field.insertIndex,
        deleteEnd: field.deleteEnd,
      })),
    }));

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
        assetDirection: a.assetDirection,
        summary,
        writerPrompt,
        fields: a.fields,
        direction,
        voiceGuide,
      });
      const metaByName = new Map(
        a.fields.map((f) => [f.fieldName, { insertIndex: f.insertIndex, deleteEnd: f.deleteEnd }])
      );
      const mapped = drafts
        .map((d) => {
          const meta = metaByName.get(d.fieldName) || {};
          return {
            assetType: a.assetType,
            fieldName: d.fieldName,
            insertIndex: meta.insertIndex,
            deleteEnd: meta.deleteEnd,
            copy: d.copy,
          };
        })
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

  // Regeneration is done in two phases so deletes and inserts never share a
  // batch (interleaving them makes indices very hard to reason about and is the
  // source of jumbled copy / cut labels). Phase 1 removes all previously drafted
  // copy; we then RE-PARSE the now-clean doc so the inserts use indices that
  // reflect its real current state, regardless of how long the old copy was.
  //
  // First drafts have no existing copy (deleteEnd == null everywhere), so Phase
  // 1 and the re-parse are skipped — inserts run against the original parse,
  // identical to the previous behavior.

  // Phase 1 — delete existing copy, bottom-to-top (reverse-order deletes are
  // index-safe: a deletion at a higher index never shifts lower indices).
  const deletions = drafted
    .filter((d) => d.deleteEnd != null && d.deleteEnd > d.insertIndex)
    .sort((a, b) => b.insertIndex - a.insertIndex);

  let insertIndexByField = null;
  if (deletions.length > 0) {
    await docs.documents.batchUpdate({
      documentId: id,
      requestBody: {
        requests: deletions.map((d) => ({
          deleteContentRange: { range: { startIndex: d.insertIndex, endIndex: d.deleteEnd } },
        })),
      },
    });

    // Re-parse the cleaned doc to recover fresh, correct insertion indices.
    const freshDoc = (await docs.documents.get({ documentId: id })).data;
    const fresh = parseDoc(freshDoc);
    insertIndexByField = new Map();
    for (const asset of fresh.assets) {
      for (const f of asset.fields) {
        insertIndexByField.set(ctxKey(asset.assetType, f.fieldName), f.insertIndex);
      }
    }
  }

  // Resolve each drafted field's insertion index: the re-parsed value after a
  // delete pass, otherwise the original parse (first draft). Drop any field we
  // can't place (shouldn't happen, but never insert at a stale/unknown index).
  const inserts = drafted
    .map((d) => {
      const idx = insertIndexByField
        ? insertIndexByField.get(ctxKey(d.assetType, d.fieldName))
        : d.insertIndex;
      return idx != null ? { insertIndex: idx, copy: d.copy } : null;
    })
    .filter(Boolean)
    // Bottom-to-top so each insert doesn't shift the indices of the ones above.
    .sort((a, b) => b.insertIndex - a.insertIndex);

  // Phase 2 — insert the new copy under each label (regular weight, not the
  // bold label style).
  const requests = [];
  for (const { insertIndex, copy } of inserts) {
    requests.push({ insertText: { location: { index: insertIndex }, text: copy + '\n' } });
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
    fieldCount: inserts.length,
    url: `https://docs.google.com/document/d/${id}/edit`,
  };
}

// Read a doc back into a structured, copy-bearing shape for the web project
// view. Unlike parseDoc (which recovers field *positions* for drafting), this
// also captures the per-field italic notes + drafted copy under each label: the
// plain paragraphs that follow a bold field label, up to the next label /
// heading. Returns
//   { summary, writerDirection, assets: [{ name, fields: [{ fieldName,
//     charMin, charMax, notes, copy }] }] }
// Throws if the doc can't be read so the caller can surface the fallback.
async function getDocContent(id, clients) {
  const { docs } = clients || (await getClients());
  const doc = (await docs.documents.get({ documentId: id })).data;

  const result = { title: doc.title || '', summary: '', writerDirection: '', assets: [] };
  let current = null; // current asset block
  let field = null; // current field collecting copy
  let expecting = null; // 'summary' | 'writerDirection'

  for (const item of doc.body.content || []) {
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = p.paragraphStyle?.namedStyleType;
    const text = paragraphText(p).trim();
    const { bold, italic } = runStyle(p);

    if (named === 'HEADING_2' && text === 'Campaign Summary') {
      expecting = 'summary';
      field = null;
      continue;
    }
    if (named === 'HEADING_2' && text === 'Writer Direction') {
      expecting = 'writerDirection';
      field = null;
      continue;
    }
    if (expecting === 'summary') {
      if (text) {
        result.summary = text;
        expecting = null;
      }
      continue;
    }
    if (expecting === 'writerDirection') {
      if (text) {
        result.writerDirection = text;
        expecting = null;
      }
      continue;
    }

    if (named === 'HEADING_3') {
      current = { name: text, asset_direction: '', fields: [] };
      result.assets.push(current);
      field = null;
      continue;
    }

    // A group sub-heading (e.g. "Graphic Copy", HEADING_4) is a layout label, not
    // a field — skip it and end the previous field's copy region.
    if (named === 'HEADING_4') {
      field = null;
      continue;
    }
    if (!current) continue;

    // The italic line between the asset heading and its first field is the
    // asset-level creative direction (or legacy channel · tone) — capture it for
    // display; it isn't field copy.
    if (italic && text && current.fields.length === 0 && !field) {
      if (!current.asset_direction) current.asset_direction = text;
      continue;
    }

    // A bold paragraph (optionally ending in a [min-max] / [max] bracket) starts
    // a new field. Recover charMin/charMax exactly as parseDoc does.
    if (bold && text) {
      const m = text.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
      const fieldName = m ? m[1].trim() : text;
      const nums = (m ? m[2] : '').match(/\d+/g);
      let charMin = 0;
      let charMax = 0;
      if (nums) {
        const vals = nums.map(Number);
        charMax = Math.max(...vals);
        if (vals.length >= 2) charMin = Math.min(...vals);
      }
      field = { fieldName, charMin, charMax, notes: '', copy: '' };
      current.fields.push(field);
      continue;
    }

    // Per-field guidance: the italic line right after a label, before any copy.
    // Capture it for display, but never count it as drafted copy.
    if (field && italic && text && !field.copy && !field.notes) {
      field.notes = text;
      continue;
    }

    // Any other non-empty paragraph is drafted copy for the current field.
    if (field && text) {
      field.copy = field.copy ? `${field.copy}\n${text}` : text;
    }
  }

  return result;
}

// --- Copy-review comments (Drive API v3) ---
// Comments are anchored to exact copy via quotedFileContent (verified). Quillio's
// review comments are branded + identified by this prefix so re-review can clear
// the previous ones before posting the currently-warranted set.
const REVIEW_PREFIX = '🪶 Quillio Review — ';

// List the live Quillio review comments on the doc (prefix-identified). Returns
// [{ id, content, resolved, quote }] where `quote` is the copy the comment was
// anchored to (quotedFileContent snapshot at post time) and `resolved` is true
// when the user manually resolved it in Google Docs. RESOLVED COMMENTS ARE
// INCLUDED — reconcile needs them to respect manual dismissals. `content` has the
// REVIEW_PREFIX stripped. Non-Quillio comments are excluded by the prefix.
async function listReviewComments(docId, clients) {
  const { drive } = clients || (await getClients());
  const out = [];
  let pageToken = null;
  do {
    const res = await drive.comments.list({
      fileId: docId,
      fields: 'nextPageToken, comments(id, content, deleted, resolved, quotedFileContent/value)',
      pageSize: 100,
      includeDeleted: false,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
    });
    for (const c of res.data.comments || []) {
      if (c.deleted || typeof c.content !== 'string' || !c.content.startsWith(REVIEW_PREFIX)) continue;
      out.push({
        id: c.id,
        content: c.content.slice(REVIEW_PREFIX.length),
        resolved: !!c.resolved,
        quote: (c.quotedFileContent && c.quotedFileContent.value) || '',
      });
    }
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return out;
}

// Post ONE branded review comment anchored to `quote` via quotedFileContent.
// Returns the new comment id, or null on failure (logged). Empty quote/content
// is a no-op (returns null).
async function addReviewComment(docId, { quote, content } = {}, clients) {
  const q = String(quote || '');
  if (!q.trim() || !content) return null;
  const { drive } = clients || (await getClients());
  try {
    const res = await drive.comments.create({
      fileId: docId,
      fields: 'id',
      supportsAllDrives: true,
      requestBody: {
        content: REVIEW_PREFIX + content,
        quotedFileContent: { mimeType: 'text/plain', value: q },
      },
    });
    return (res.data && res.data.id) || null;
  } catch (err) {
    console.error(`[review] failed to add comment: ${err.message}`);
    return null;
  }
}

// Delete ONE comment by id. Best-effort; returns true if it was deleted.
async function deleteReviewComment(docId, commentId, clients) {
  if (!commentId) return false;
  const { drive } = clients || (await getClients());
  try {
    await drive.comments.delete({ fileId: docId, commentId, supportsAllDrives: true });
    return true;
  } catch (err) {
    console.error(`[review] failed to delete comment ${commentId}: ${err.message}`);
    return false;
  }
}

// Delete all prior Quillio review comments on the doc (identified by the prefix).
// Best-effort; returns the count removed. NOTE: no longer used by the review flow
// (reconcile preserves unresolved comments); kept for completeness / other uses.
async function clearReviewComments(docId, clients) {
  const comments = await listReviewComments(docId, clients);
  let removed = 0;
  for (const c of comments) {
    if (await deleteReviewComment(docId, c.id, clients)) removed++;
  }
  return removed;
}

// Post branded review comments, each anchored to its field's copy via
// quotedFileContent. `items`: [{ quote, content }]. Uniqueness guard: if the same
// copy text appears in more than one field, only the first is anchored (Drive
// would otherwise anchor every duplicate to the same first occurrence) — the
// collision is logged and skipped rather than mis-anchored. Returns the count posted.
async function postReviewComments(docId, items, clients) {
  const { drive } = clients || (await getClients());
  const seen = new Set();
  let posted = 0;
  for (const it of items || []) {
    const quote = String(it.quote || '');
    if (!quote.trim() || !it.content) continue;
    if (seen.has(quote)) {
      console.warn('[review] duplicate copy text — skipping a comment to avoid mis-anchoring');
      continue;
    }
    seen.add(quote);
    try {
      await drive.comments.create({
        fileId: docId,
        fields: 'id',
        supportsAllDrives: true,
        requestBody: {
          content: REVIEW_PREFIX + it.content,
          quotedFileContent: { mimeType: 'text/plain', value: quote },
        },
      });
      posted++;
    } catch (err) {
      console.error(`[review] failed to post comment: ${err.message}`);
    }
  }
  return posted;
}

// The destination adapter contract.
module.exports = {
  name: 'google-docs',
  createDocument,
  generateDraft,
  getDocContent,
  listReviewComments,
  addReviewComment,
  deleteReviewComment,
  clearReviewComments,
  postReviewComments,
  REVIEW_PREFIX,
  // Exposed for unit tests only (not part of the destination interface used by
  // the registry): char-limit bracket rendering, the field explainer, doc
  // re-parsing including the regeneration delete-range detection, and the body
  // builder (to lock the default-header fallback ordering).
  fieldLabel,
  fieldHint,
  parseDoc,
  appendBody,
};
