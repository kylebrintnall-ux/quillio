'use strict';

// Platform-agnostic core pipeline. Pure logic + integration calls (Gemini,
// Sheets, Google Drive/Docs, destinations). NO Slack imports allowed here —
// all Slack messaging lives in the adapters (src/adapters/slackWorkflow.js).

const config = require('../config');
const { getClients } = require('../google');
const {
  parseBrief: geminiParseBrief,
  enrichWithReferences: geminiEnrich,
  describeImage,
  // The SAME batched draft call the copy doc's assets go through — a template
  // is one asset whose fields are its copy markers. No new prompt.
  generateAssetDrafts,
} = require('../services/gemini');
const { normalize } = require('../utils/normalize');
const { instanceCounter } = require('../utils/instanceKey');
const { getDestination } = require('../destinations');
const { getVoiceGuide, getHeaderSchema, getNamingPattern } = require('../db');
const { getAssetDirections, getTenantAssets, getAssetTemplateBindings } = require('../db/assets');
const { saveProject, getProjectByDocId, setProjectTemplateFill } = require('../db/projects');
const { getDocTemplate } = require('../db/docTemplates');
const { listTemplateMarkers } = require('../db/templateMarkers');

// Matches a Google Drive *file* link (Drive file, Doc, or Slides) and captures its id.
const DRIVE_FILE_RE = /(?:drive\.google\.com\/file\/d\/|docs\.google\.com\/(?:document|presentation)\/d\/)([a-zA-Z0-9_-]+)/;
// Matches a Google Drive *folder* link (folders/ID or open?id=ID) and captures its id.
const DRIVE_FOLDER_RE = /drive\.google\.com\/(?:drive\/folders\/|open\?id=)([a-zA-Z0-9_-]+)/;
const REF_CONTENT_MAX = 6000; // per-file char cap, protects the context window

// Strips control characters (form feeds, NULs, other non-printables below 0x20
// except \n/\t, and DEL) and normalizes whitespace. Reference content fetched
// from Drive/external/PDF sources can carry these, and they corrupt Gemini's
// JSON response when passed through in the enrichment context. Applied to each
// reference's content when building the concatenated referenceContext.
function sanitizeText(text) {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

// Phase 2 — read the plain-text content of Drive file links in the brief so the
// enrichment pass has real source material. Best-effort: any file that can't be
// read (permissions, unsupported type, network) is skipped silently. Uses the
// same Drive client as doc creation (OAuth user when configured, else the SA).
// Returns [{ url, fileId, title, content, type }] (type 'slides' or 'drive').
async function fetchDriveReferenceContent(links) {
  if (!Array.isArray(links) || links.length === 0) return [];
  const { drive } = await getClients();
  const out = [];

  for (const url of links) {
    // Skip Drive *folder* URLs — only file URLs are fetchable as references.
    if (DRIVE_FOLDER_RE.test(String(url))) continue;
    const m = String(url).match(DRIVE_FILE_RE);
    if (!m) continue; // not a Drive file link — leave for the Reference Materials section
    const fileId = m[1];
    let title = url;
    try {
      const meta = await drive.files.get({
        fileId,
        fields: 'name, mimeType',
        supportsAllDrives: true,
      });
      title = meta.data.name || url;
      const mimeType = meta.data.mimeType || '';
      const isSlides = mimeType === 'application/vnd.google-apps.presentation';

      let content;
      if (mimeType === 'text/plain' || mimeType === 'application/json') {
        const res = await drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'text' }
        );
        content = String(res.data || '');
      } else {
        // Docs and Slides both export to text/plain (Slides → all slide titles,
        // body text, and speaker notes concatenated).
        const res = await drive.files.export(
          { fileId, mimeType: 'text/plain' },
          { responseType: 'text' }
        );
        content = String(res.data || '');
      }

      if (isSlides) {
        console.log(`[Quillio] read Slides deck: ${title} (${content.length} chars)`);
        // Harvest URLs embedded in the deck (raw content, before sanitizing) and
        // add any new ones to the shared links array so the existing pipeline
        // fetches them as additional reference sources. Dedupe against links.
        const found = content.match(/https?:\/\/[^\s)>\]"'<]+/g) || [];
        let added = 0;
        for (const raw of found) {
          const clean = raw.replace(/[).,;]+$/, '').trim();
          // Skip Drive folder URLs — they're destinations, not references.
          if (clean && !DRIVE_FOLDER_RE.test(clean) && !links.includes(clean)) {
            links.push(clean);
            added++;
          }
        }
        console.log(`[Quillio] extracted ${added} URLs from Slides deck: ${title}`);
      }

      out.push({
        url,
        fileId,
        title,
        content: content.slice(0, REF_CONTENT_MAX),
        type: isSlides ? 'slides' : 'drive',
      });
    } catch (err) {
      console.error(`[Quillio] Could not read reference file ${fileId}: ${err.message}`);
    }
  }
  return out;
}

// Phase 2 Slice 2 — read the text of non-Drive external web pages linked in the
// brief, for enrichment context. Best-effort: any URL that can't be fetched
// (timeout, non-200, network error, non-text) is skipped silently.
const EXTERNAL_CONTENT_MAX = 2000; // web pages are noisier, so a tighter cap
const EXTERNAL_FETCH_TIMEOUT_MS = 5000;
// Skip Google Drive/Docs (handled separately) and non-readable URL patterns.
const SKIP_EXTERNAL_RE = /drive\.google\.com|docs\.google\.com|slack\.com|^mailto:|^tel:|localhost|127\.0\.0\.1/i;
// Matches a Slack Canvas link (canvases.read handled by fetchSlackCanvasContent).
const SLACK_CANVAS_RE = /\.slack\.com\/(?:canvas|docs)\//i;

// Turn a URL-path filename into a readable title: drop the .pdf extension,
// swap hyphens/underscores for spaces, and Title Case the words. So
// "fIeld-service-guide-4th-edition" becomes "Field Service Guide 4th Edition".
function cleanFilenameTitle(name) {
  return String(name || '')
    .replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// True if the URL's path ends in .pdf (ignoring any query/fragment).
function urlPathEndsPdf(url) {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(String(url));
  }
}

async function fetchExternalURLContent(links) {
  if (!Array.isArray(links) || links.length === 0) return [];
  const out = [];

  for (const raw of links) {
    const url = String(raw);
    // Skip .pdf URLs (fetchPDFContent handles those) and Slack Canvas links
    // (fetchSlackCanvasContent handles those) to avoid double-fetching.
    if (
      SKIP_EXTERNAL_RE.test(url) ||
      SLACK_CANVAS_RE.test(url) ||
      !/^https?:\/\//i.test(url) ||
      urlPathEndsPdf(url)
    )
      continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Quillio/1.0 (brief-ingestion-bot)' },
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (/^(image|video|audio)\/|application\/(pdf|octet-stream|zip|gzip)/i.test(ct)) {
        throw new Error(`non-text content-type: ${ct}`);
      }

      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      let title = titleMatch ? titleMatch[1].trim() : '';
      if (!title) {
        // No <title> tag: a hostname is fine as-is, but if the path carries a
        // filename, clean it up the same way the PDF fallback does.
        try {
          const u = new URL(url);
          const last = u.pathname.split('/').filter(Boolean).pop() || '';
          title = last ? cleanFilenameTitle(last) : u.hostname;
        } catch {
          title = url;
        }
      }
      const content = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, EXTERNAL_CONTENT_MAX);

      out.push({ url, title, content });
    } catch (err) {
      console.error(`[Quillio] Could not fetch external URL ${url}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

// Phase 2 Slice 3 — fetch and extract text from PDFs linked in the brief.
// Best-effort: anything that can't be fetched/parsed is skipped silently.
const PDF_CONTENT_MAX = 4000; // PDFs are higher signal than web pages
const PDF_FETCH_TIMEOUT_MS = 10000; // PDFs are larger — 10s not 5s
const PDF_HEAD_TIMEOUT_MS = 5000;

async function fetchPDFContent(links) {
  if (!Array.isArray(links) || links.length === 0) return [];
  const out = [];

  for (const raw of links) {
    const url = String(raw);
    if (SKIP_EXTERNAL_RE.test(url) || !/^https?:\/\//i.test(url)) continue;

    // PDF if the path ends in .pdf; otherwise HEAD-check the content-type.
    let isPdf = urlPathEndsPdf(url);
    if (!isPdf) {
      const headCtrl = new AbortController();
      const headTimer = setTimeout(() => headCtrl.abort(), PDF_HEAD_TIMEOUT_MS);
      try {
        const head = await fetch(url, {
          method: 'HEAD',
          signal: headCtrl.signal,
          headers: { 'User-Agent': 'Quillio/1.0 (brief-ingestion-bot)' },
        });
        isPdf = (head.headers.get('content-type') || '').toLowerCase().includes('application/pdf');
      } catch {
        isPdf = false;
      } finally {
        clearTimeout(headTimer);
      }
    }
    if (!isPdf) continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Quillio/1.0 (brief-ingestion-bot)' },
      });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/pdf') && !ct.includes('octet-stream')) {
        console.error(`[Quillio] URL did not return PDF content: ${url}`);
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      // pdf-parse reads a bundled test file on require in some setups; suppress
      // the related warning and require lazily so it never runs at startup.
      process.env.SUPPRESS_NO_CONFIG_WARNING = true;
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);

      const content = String(parsed.text || '').slice(0, PDF_CONTENT_MAX);

      // Title, in order of preference: (1) the PDF's own Title metadata,
      // (2) the first meaningful line of extracted text, (3) a cleaned-up
      // filename from the URL path, (4) the hostname.
      let title = parsed.info && parsed.info.Title ? String(parsed.info.Title).trim() : '';
      if (!title) {
        const firstLine = String(parsed.text || '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length >= 4)[0];
        if (firstLine) title = firstLine.slice(0, 60).trim();
      }
      if (!title) {
        try {
          const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
          title = cleanFilenameTitle(last);
        } catch {
          /* fall through to hostname */
        }
      }
      if (!title) {
        try {
          title = new URL(url).hostname;
        } catch {
          title = url;
        }
      }

      out.push({ url, title, content, type: 'pdf' });
    } catch (err) {
      console.error(`[Quillio] Could not parse PDF ${url}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

// Phase 2 Slice 4 — read the text of Slack Canvas links in the brief so the
// enrichment pass can use them. A canvas is a file: files.info gives its title
// and a private download URL, which we fetch (with the token) for the content.
// canvases.sections.lookup is no use here — it only finds header-delimited
// sections, so it returns nothing for a header-less canvas. Best-effort: any
// canvas that can't be read is skipped silently. Prefers SLACK_USER_TOKEN
// (with files:read + canvases:read) since the bot identity gets `not_visible`
// on user-owned canvases. Returns [{ url, canvasId, title, content, type }].
const CANVAS_CONTENT_MAX = 3000;
const CANVAS_FETCH_TIMEOUT_MS = 10000;

// Strip the markdown that Slack returns in canvas section content so the
// enrichment context is clean plain text.
function stripCanvasMarkdown(text) {
  return String(text || '')
    .replace(/^#{1,6}\s*/gm, '') // ##/###/#### headers -> keep text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1') // *italic* -> italic
    .replace(/^\s*[-*]\s+/gm, '') // leading bullet chars
    .trim();
}

// Canvas id = the LAST path segment after /canvas/ or /docs/. A /docs/ URL is
// /docs/TEAM_ID/CANVAS_ID, so the canvas id is always the final segment.
// Query/fragment are stripped. Returns '' if nothing usable.
function extractCanvasId(url) {
  const after = String(url).replace(/^.*\.slack\.com\/(?:canvas|docs)\//i, '');
  return after.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
}

async function fetchSlackCanvasContent(links, userToken) {
  if (!Array.isArray(links) || links.length === 0) return [];
  // Prefer the resolved tenant user token (reads what the authorizing user can
  // see, including user-owned canvases); fall back to env when none is passed.
  const token = userToken || process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (!token) return [];
  const out = [];

  for (const raw of links) {
    const url = String(raw);
    if (!SLACK_CANVAS_RE.test(url)) continue;

    const canvasId = extractCanvasId(url);
    if (!canvasId) continue;

    try {
      // files.info → title + private download URL.
      const infoRes = await fetch(
        `https://slack.com/api/files.info?file=${encodeURIComponent(canvasId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const info = await infoRes.json();
      if (!info.ok || !info.file) {
        console.error(`[Quillio] canvas files.info failed for ${canvasId}: ${info.error}`);
        continue;
      }
      const file = info.file;
      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) {
        console.error(`[Quillio] canvas ${canvasId} has no download URL`);
        continue;
      }

      // Fetch the canvas body (authorized download).
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CANVAS_FETCH_TIMEOUT_MS);
      let body;
      try {
        const dlRes = await fetch(downloadUrl, {
          signal: ctrl.signal,
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!dlRes.ok) throw new Error(`download status ${dlRes.status}`);
        body = await dlRes.text();
      } finally {
        clearTimeout(timer);
      }

      // Canvas downloads come back as HTML or markdown — strip both to plain text.
      const content = stripCanvasMarkdown(String(body || '').replace(/<[^>]+>/g, ' '))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, CANVAS_CONTENT_MAX);
      if (!content) {
        console.error(`[Quillio] canvas ${canvasId} download empty after cleaning`);
        continue;
      }

      const title = String(file.title || file.name || canvasId).trim();
      console.log(`[Quillio] canvas read OK — ${canvasId} "${title}" (${content.length} chars)`);
      out.push({ url, canvasId, title, content, type: 'canvas' });
    } catch (err) {
      console.error(`[Quillio] Could not fetch Slack canvas ${canvasId}: ${err.message}`);
    }
  }
  return out;
}

// Did this error come from an inaccessible (brief-provided) Drive folder?
function isFolderAccessError(err, folderId) {
  if (!folderId) return false;
  const code = err && (err.code || err.status);
  const msg = (err && err.message) || '';
  return (
    code === 403 ||
    code === 404 ||
    msg.includes(folderId) ||
    /not ?found|forbidden|permission|insufficient/i.test(msg)
  );
}

// === Public pipeline API ===

// The asset names a brief may name, for THIS tenant, plus where they came from.
//
// The tenant's own active asset_types names when they have a library, else
// config.ALLOWED_ASSETS. The fallback is the no-DB / demo / unseeded case
// (db/assets.js getTenantAssets returns null), where there is no library to read
// and the bundled 30 are the only sensible vocabulary.
//
// Active rows only, because that is what getTenantAssets returns and what
// tenantAssetsToSpecs will expand against later — an asset the tenant switched
// off in onboarding should not be offered to the model as something to request.
//
// `source` is carried to the caller so the unmatched message can name the right
// thing: with a real library "your asset library" is true and "add it" is
// actionable; on the fallback neither is, and the message says so instead.
async function resolveAssetVocabulary(tenantId) {
  let rows = null;
  try {
    rows = await getTenantAssets(tenantId);
  } catch (err) {
    // A read failure must not take the whole brief down — the bundled list still
    // parses a sensible plan, and generateDoc will surface the DB problem itself.
    console.warn('[pipeline] asset vocabulary lookup failed — using the bundled list:', err.message);
  }
  const names = (rows || []).map((r) => r && r.name).filter(Boolean);
  if (names.length === 0) return { names: config.ALLOWED_ASSETS, source: 'default' };
  return { names, source: 'tenant' };
}

// Parse a free-form brief into structured data (campaignTitle, summary,
// writerPrompt, assets, unmatchedAssets, folderId, referenceLinks,
// assetVocabulary).
//
// `tenantId` selects the asset vocabulary the model is constrained to. Omitting
// it (tests, a direct call) falls back to config.ALLOWED_ASSETS, which is the
// pre-tenant behavior exactly.
async function parseBrief(briefText, tenantId) {
  const vocabulary = await resolveAssetVocabulary(tenantId);
  console.log(
    `[pipeline] parse vocabulary: ${vocabulary.names.length} asset name(s) from ${
      vocabulary.source === 'tenant' ? "the tenant's library" : 'the bundled default list'
    }`
  );
  const parsed = await geminiParseBrief(briefText, vocabulary.names);
  // Carried out so the adapters can word the unmatched message correctly, and so
  // the pending record can carry it across the web's confirmation pause.
  parsed.assetVocabulary = { source: vocabulary.source, count: vocabulary.names.length };

  // Folder routing NEVER trusts Gemini's folderId. Gemini frequently truncates
  // a long Drive folder id in its JSON output (observed: the 33-char id
  // `1BB6nSrJbooQafNRR8LGXFwowMb8hOb9o` came back as `1BB6nSrJbooQafNRR8LG`).
  // extractBriefFolderId reads the raw brief text with a deterministic regex,
  // so it always recovers the full id. Override parsed.folderId with it so any
  // consumer of parsedBrief.folderId gets the correct value regardless of what
  // Gemini did. (The Slack/web adapters already call extractBriefFolderId
  // directly for routing; this keeps the parsed object internally consistent.)
  const rawFolderId = extractBriefFolderId(briefText);
  if (rawFolderId && rawFolderId !== parsed.folderId) {
    console.log(
      `[gemini] overriding Gemini folderId ${JSON.stringify(parsed.folderId)} with raw-text folderId ${JSON.stringify(rawFolderId)}`
    );
  }
  parsed.folderId = rawFolderId || null;

  // A Drive folder URL is a destination (folder routing), not a reference
  // document — strip it from referenceLinks so it's never ingested or listed
  // in the doc's Reference Materials. This also drops any *truncated* folder URL
  // Gemini may have placed there (DRIVE_FOLDER_RE matches the partial id too).
  // Folder routing reads the brief text directly (extractBriefFolderId above),
  // so this doesn't affect where the doc lands.
  if (Array.isArray(parsed.referenceLinks)) {
    parsed.referenceLinks = parsed.referenceLinks.filter((u) => !DRIVE_FOLDER_RE.test(String(u)));
  }
  return parsed;
}

// --- Attached file references (uploads) ---
// Files attached directly to a brief (web upload or Slack file) are ingested
// through the same enrichment pipeline as reference links and tagged
// type:'upload'. Caps: 10MB per file, 3 files max.
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_MAX_FILES = 3;
const ATTACH_CONTENT_MAX = 5000;

// Extract reference content from one file buffer by mimetype / filename:
//   PDF   → pdf-parse,  DOCX → mammoth,  JPG/PNG → Gemini vision (describeImage).
// Returns { title, content, type:'upload' } or null (unsupported / empty /
// failed). Per-file failures are logged and swallowed so one bad file never
// blocks the brief.
async function extractAttachment(buffer, mimetype, filename) {
  const mt = String(mimetype || '').toLowerCase();
  const name = String(filename || 'attachment');
  const title = cleanFilenameTitle(name) || name;
  try {
    if (mt.includes('pdf') || /\.pdf$/i.test(name)) {
      process.env.SUPPRESS_NO_CONFIG_WARNING = true;
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);
      const content = String(parsed.text || '').trim().slice(0, ATTACH_CONTENT_MAX);
      return content ? { title, content, type: 'upload' } : null;
    }
    if (
      mt.includes('wordprocessingml') ||
      mt.includes('msword') ||
      /\.docx$/i.test(name)
    ) {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer });
      const content = String(value || '').trim().slice(0, ATTACH_CONTENT_MAX);
      return content ? { title, content, type: 'upload' } : null;
    }
    if (mt.startsWith('image/') || /\.(jpe?g|png)$/i.test(name)) {
      const description = await describeImage(buffer.toString('base64'), mt || 'image/png');
      const content = String(description || '').trim().slice(0, ATTACH_CONTENT_MAX);
      return content ? { title, content, type: 'upload' } : null;
    }
    console.warn(`[Quillio] attachment skipped (unsupported type ${mt || '?'}): ${name}`);
  } catch (err) {
    console.error(`[Quillio] attachment extract failed (${name}): ${err.message}`);
  }
  return null;
}

// Web path: read attached files from local (temp) paths and extract content.
// fileRefs: [{ path, filename, mimetype }]. Enforces the 3-file / 10MB caps.
// Returns upload refs ([{ title, content, type:'upload' }]).
async function processAttachedFiles(fileRefs) {
  if (!Array.isArray(fileRefs) || fileRefs.length === 0) return [];
  const fs = require('fs').promises;
  const out = [];
  for (const f of fileRefs.slice(0, ATTACH_MAX_FILES)) {
    if (!f || !f.path) continue;
    try {
      const stat = await fs.stat(f.path);
      if (stat.size > ATTACH_MAX_BYTES) {
        console.warn(`[Quillio] attachment too large (${stat.size}B), skipping: ${f.filename}`);
        continue;
      }
      const buffer = await fs.readFile(f.path);
      const ref = await extractAttachment(buffer, f.mimetype, f.filename);
      if (ref) out.push(ref);
    } catch (err) {
      console.error(`[Quillio] could not process attachment ${f && f.filename}: ${err.message}`);
    }
  }
  return out;
}

// Slack path: download file attachments (authorized fetch with the bot token,
// same pattern as canvas ingestion) and extract content. attachments:
// [{ url, filename, mimetype }] where url is a Slack url_private_download.
// Enforces the 3-file / 10MB caps. Returns upload refs.
async function fetchAttachedFiles(attachments, token) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const authToken = token || process.env.SLACK_BOT_TOKEN;
  const out = [];
  for (const a of attachments.slice(0, ATTACH_MAX_FILES)) {
    if (!a || !a.url) continue;
    try {
      const res = await fetch(a.url, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (!res.ok) throw new Error(`download status ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > ATTACH_MAX_BYTES) {
        console.warn(`[Quillio] Slack attachment too large (${buffer.length}B), skipping: ${a.filename}`);
        continue;
      }
      const ref = await extractAttachment(buffer, a.mimetype, a.filename);
      if (ref) out.push(ref);
    } catch (err) {
      console.error(`[Quillio] could not fetch Slack attachment ${a && a.filename}: ${err.message}`);
    }
  }
  return out;
}

// Best-effort temp-file cleanup for web uploads. Unlinks each path, ignoring
// errors (already gone / never written). Call in a finally so files are removed
// on success or failure.
async function cleanupAttachedFiles(fileRefs) {
  if (!Array.isArray(fileRefs) || fileRefs.length === 0) return;
  const fs = require('fs').promises;
  for (const f of fileRefs) {
    if (!f || !f.path) continue;
    try {
      await fs.unlink(f.path);
    } catch {
      /* already gone — ignore */
    }
  }
}

// Fetch every linked reference (Drive/Docs/Slides, external URLs, PDFs, Slack
// canvases) in parallel, tag each with its source type, then second-pass fetch
// any URLs harvested from a Slides deck (appended to referenceLinks). Optional
// `attachments` (Slack file objects) are downloaded + ingested as type:'upload'.
// Returns { refs, counts } where counts are the per-type counts.
async function fetchAllReferences(referenceLinks, userToken, attachments, botToken) {
  // Snapshot links before fetching: fetchDriveReferenceContent may append
  // URLs harvested from a Slides deck, which we second-pass fetch below.
  const originalLinks = [...referenceLinks];
  const [refDocs, refExternal, refPdf, refCanvas] = await Promise.all([
    fetchDriveReferenceContent(referenceLinks),
    fetchExternalURLContent(referenceLinks),
    fetchPDFContent(referenceLinks),
    fetchSlackCanvasContent(referenceLinks, userToken),
  ]);
  // Tag each reference with its true source type (the fetcher knows it;
  // Gemini only guesses). pdf/canvas already carry a type.
  const refs = [
    ...refDocs.map((r) => ({ ...r, type: r.type || 'drive' })),
    ...refExternal.map((r) => ({ ...r, type: 'external' })),
    ...refPdf,
    ...refCanvas,
  ];

  // Second pass: fetchDriveReferenceContent may have harvested URLs from a
  // Slides deck and appended them to referenceLinks. Fetch only those new
  // ones (external + PDF; harvested deck URLs need no Drive fetch).
  const harvested = referenceLinks.filter((u) => !originalLinks.includes(u));
  if (harvested.length > 0) {
    console.log(`[Quillio] second-pass fetch: ${harvested.length} harvested URLs from Slides deck`);
    const [moreExternal, morePdf] = await Promise.all([
      fetchExternalURLContent(harvested),
      fetchPDFContent(harvested),
    ]);
    refs.push(...moreExternal.map((r) => ({ ...r, type: 'external' })), ...morePdf);
  }

  // Attached files (Slack uploads): download + extract, tagged type:'upload'.
  const uploadRefs = await fetchAttachedFiles(attachments, botToken);
  if (uploadRefs.length > 0) refs.push(...uploadRefs);

  return {
    refs,
    counts: {
      drive: refDocs.length,
      external: refExternal.length,
      pdf: refPdf.length,
      canvas: refCanvas.length,
      upload: uploadRefs.length,
    },
  };
}

// Enrich the summary / writer direction from the fetched references. Builds the
// sanitized reference context, runs the second Gemini pass, and stamps each
// insight's source type from the matching reference. Returns
// { summary, writerPrompt, referenceInsights }.
async function enrichWithReferences(parsed, refs) {
  const referenceContext = refs
    .map((r) => `\n\n--- Reference (${r.type}): ${r.title} ---\n${sanitizeText(r.content)}`)
    .join('');
  const enriched = await geminiEnrich(
    { summary: parsed.summary, writerPrompt: parsed.writerPrompt },
    referenceContext
  );
  const insights = Array.isArray(enriched.referenceInsights) ? enriched.referenceInsights : [];
  // Stamp the real source type onto each insight by matching it back to
  // its reference (by title), instead of trusting Gemini's guessed type.
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const referenceInsights = insights.map((ins) => {
    const src = norm(ins && ins.source);
    const match =
      refs.find((r) => norm(r.title) === src) ||
      (src && refs.find((r) => norm(r.title).includes(src) || src.includes(norm(r.title)))) ||
      (refs.length === 1 ? refs[0] : null);
    return match ? { ...ins, type: match.type } : ins;
  });
  // Surface the silent failure mode: references were read but the enrich pass
  // produced no structured insights (e.g. Gemini JSON parse failed) — so the
  // doc's Reference Insights section would be omitted.
  if (refs.length > 0 && referenceInsights.length === 0) {
    console.warn(
      `[workflow] enrichWithReferences: ${refs.length} reference(s) read but 0 insights produced — Reference Insights will be empty`
    );
  }
  return { summary: enriched.summary, writerPrompt: enriched.writerPrompt, referenceInsights };
}

// === Asset-plan expansion ===
//
// Per-asset instance ceiling. The motivating case is "5 nurture emails for 2
// audiences" = 10, so 10 is the top of the stated use case. Requests above it are
// CLAMPED (not rejected) and logged, matching the count clamp on scoped variation
// controls in routes/app.js.
const MAX_INSTANCES_PER_ASSET = 10;

// Whole-plan ceiling. The largest doc reachable before instances was the full
// library — 30 groups / 195 fields — and every group costs a Gemini call at draft
// time, so 40 leaves real headroom for instance work while bounding doc size and
// cost. Exceeding it THROWS rather than truncating: silently dropping requested
// instances is the same class of bug as silently adding 29 unrequested assets.
const MAX_TOTAL_INSTANCES = 40;

// The ceilings are PER SURFACE, because the cost of a misread is per surface.
// These are the defaults — the web's, which can afford them because /api/brief
// pauses and shows the interpretation before building anything. A surface with no
// confirmation step passes its own tighter pair (see adapters/slackWorkflow.js).
// `hint` is an optional surface-specific sentence appended to the over-total
// error, so the message can suggest a way forward without core knowing what
// surface it is running on.
const DEFAULT_ASSET_LIMITS = { maxPerAsset: MAX_INSTANCES_PER_ASSET, maxTotal: MAX_TOTAL_INSTANCES, hint: null };

// Coerce a caller's limits to sane numbers, never above the absolute ceilings —
// a surface can be STRICTER than the defaults, never looser.
function resolveAssetLimits(limits) {
  const l = limits || {};
  const perAsset = Math.max(1, Math.min(MAX_INSTANCES_PER_ASSET, parseInt(l.maxPerAsset, 10) || MAX_INSTANCES_PER_ASSET));
  const total = Math.max(1, Math.min(MAX_TOTAL_INSTANCES, parseInt(l.maxTotal, 10) || MAX_TOTAL_INSTANCES));
  return { maxPerAsset: perAsset, maxTotal: total, hint: typeof l.hint === 'string' && l.hint.trim() ? l.hint.trim() : null };
}

// One library row (getTenantAssets output) → the exact shape getAssetSpecs used to
// return, so every downstream consumer (createDocument, generateAssetDrafts) is
// identical regardless of source. Postgres has no channel / toneNotes /
// funnelStage columns → those map to empty strings (the same value the Sheet
// yielded when those cells were blank). Per-field guidance IS stored
// (copy_fields.spec_note) and is carried through as `specNote` → the italic note
// fieldHint() renders under the field label. Per-field spec metadata (`spec_type`,
// `spec_source`) is also carried through as `specType`/`specSource` — both are
// RENDERED in the doc by googleDocs.js fieldHint(): spec_type becomes the italic
// tier sentence under the field label (specTypeLine) and spec_source supplies the
// platform name plus the clickable citation link (specSourceName).
function rowToSpecGroup(a) {
  return {
    assetType: a.name,
    channel: '', // not stored in Postgres (Sheet-only)
    toneNotes: '', // not stored in Postgres (Sheet-only)
    asset_direction: a.asset_direction || null,
    fields: (a.fields || []).map((f) => ({
      fieldName: f.field_name,
      charMin: parseInt(f.char_min, 10) || 0,
      charMax: parseInt(f.char_max, 10) || 0,
      // The UNIT charMin/charMax are counted in: 'words' for email body copy,
      // 'text' (characters) for everything else. This row was previously dropped
      // here, so field_type reached the database and stopped — the label, the
      // prompt and the review all assumed characters.
      fieldType: f.field_type === 'words' ? 'words' : 'text',
      groupLabel: f.group_label || null, // consecutive same-label fields → one indented Doc sub-group
      specNote: f.spec_note || null, // per-field guidance → italic note under the field label (fieldHint)
      specType: f.spec_type || null, // 'enforced' | 'recommended' | 'house_default' → tier line under the field label
      specSource: f.spec_source || null, // provenance → platform name + citation link in the tier line
      notes: '', // not stored in copy_fields (Sheet-only)
      funnelStage: '', // not stored in copy_fields (Sheet-only)
    })),
  };
}

// A fresh, fully independent copy of a spec group — fields included. Every emitted
// instance gets its own objects so nothing downstream can alias two instances
// together (generateDoc already writes asset_direction onto each group in place).
function cloneSpecGroup(g) {
  return { ...g, fields: g.fields.map((f) => ({ ...f })) };
}

// Coerce the caller's asset request into an ordered plan of { asset, count }.
// Accepts, in the same array:
//   'Demand Gen Nurture Email'                       → count 1 (the legacy shape)
//   { asset: 'Demand Gen Nurture Email', count: 5 }  → count 5
// `assetType` is honored as an alias for `asset`, since that is the field name
// used for an asset everywhere else in the codebase.
// Counts are clamped here — a caller's number is never trusted.
//
// An optional `labels: string[]` names the instances, positionally, and surfaces in
// the doc heading ('… 2 — Downtown residents'). NOTHING populates it: parseBrief
// returns a bare string[], so only a direct pipeline call can supply one. It exists
// so the path is wired and tested ahead of the parse step.
function normalizeAssetPlan(assetsOrPlan, maxPerAsset = MAX_INSTANCES_PER_ASSET) {
  const plan = [];
  for (const entry of Array.isArray(assetsOrPlan) ? assetsOrPlan : []) {
    if (entry == null) continue;
    if (typeof entry === 'string') {
      const asset = entry.trim();
      if (asset) plan.push({ asset, count: 1 });
      continue;
    }
    if (typeof entry !== 'object') continue;
    const asset = String(entry.asset || entry.assetType || '').trim();
    if (!asset) continue;
    const requested = parseInt(entry.count, 10);
    const count = Math.max(1, Math.min(maxPerAsset, requested || 1));
    if (Number.isFinite(requested) && requested > maxPerAsset) {
      console.warn(
        `[pipeline] asset plan: "${asset}" requested ${requested} instances — clamped to ${maxPerAsset}`
      );
    }
    // Positional instance labels, trimmed; absent/blank entries stay null so a
    // partly-labeled plan is fine. Extra labels beyond `count` are dropped.
    const labels = (Array.isArray(entry.labels) ? entry.labels : [])
      .slice(0, count)
      .map((l) => (typeof l === 'string' && l.trim() ? l.trim() : null));
    plan.push(labels.some(Boolean) ? { asset, count, labels } : { asset, count });
  }
  return plan;
}

// How many instances the caller ASKED for, before any per-asset clamping. Each
// count is floored at 1 and capped at the absolute per-asset maximum, so a junk
// 1e9 can't produce a nonsense number in the error message — but a genuine
// over-ask is counted at full size so it can be refused rather than quietly cut.
function requestedInstanceTotal(assetsOrPlan) {
  let total = 0;
  for (const entry of Array.isArray(assetsOrPlan) ? assetsOrPlan : []) {
    if (entry == null) continue;
    if (typeof entry === 'string') {
      if (entry.trim()) total += 1;
      continue;
    }
    if (typeof entry !== 'object') continue;
    if (!String(entry.asset || entry.assetType || '').trim()) continue;
    total += Math.max(1, Math.min(MAX_INSTANCES_PER_ASSET, parseInt(entry.count, 10) || 1));
  }
  return total;
}

// Expand an asset PLAN into spec groups, in REQUEST ORDER.
//
// This used to be a filter over the library: it kept the rows whose names matched
// and emitted them in the library's own sort_order, so at most one group per row
// and the brief's ordering was discarded. It now looks each named row up once and
// emits `count` groups for it, in the order the plan asked for them. Field order
// WITHIN a group is still the library's (copy_fields.sort_order, as read).
//
// Each emitted group carries `instance`: its 0-based ordinal among groups with the
// same asset name, counted across the WHOLE plan. Because appendBody renders
// groups in this order, document order equals request order, so parseDoc's
// positional ordinals (assigned per repeated HEADING_3) come out identical — the
// write and read sides agree without either knowing about the other.
//
// An EMPTY plan still returns the entire library in library order. That is a real
// dependency, not the fallback being removed here: both adapters deliberately let
// a vague brief with no assets through to "all assets"
// (adapters/slackWorkflow.js, adapters/web.js — each refuses only when the brief
// named assets and NONE matched).
//
// A NON-EMPTY plan naming anything the library doesn't have now THROWS. Previously
// an all-unmatched filter fell through to the whole library, and a partially
// matched one silently dropped the misses — both produced a plausible-looking doc
// that answered a different question than the one asked.
function tenantAssetsToSpecs(rows, assetsOrPlan = [], limits) {
  const { maxPerAsset, maxTotal, hint } = resolveAssetLimits(limits);
  const groups = (rows || [])
    .map(rowToSpecGroup)
    // getAssetSpecs never emits an asset with zero fields — match that.
    .filter((g) => g.fields.length > 0);

  const plan = normalizeAssetPlan(assetsOrPlan, maxPerAsset);

  // Empty plan → the whole library, library order. Deliberately does NOT go
  // through the name lookup below: asset_types has no UNIQUE (tenant_id, name),
  // so a double-seeded library has two rows with one name and both should still
  // render (they get ordinals 0 and 1 rather than colliding).
  if (plan.length === 0) {
    const ordinal = instanceCounter();
    return groups.map((g) => ({ ...cloneSpecGroup(g), instance: ordinal(g.assetType), instanceLabel: null }));
  }

  // One pass to build the lookup — each named row is resolved once, not per
  // instance. First row wins for a duplicated name.
  const byName = new Map();
  for (const g of groups) {
    const key = normalize(g.assetType);
    if (!byName.has(key)) byName.set(key, g);
  }

  const unmatched = plan.map((p) => p.asset).filter((asset) => !byName.has(normalize(asset)));
  if (unmatched.length > 0) {
    throw new Error(
      `These assets are not in this tenant's library: ${unmatched.join(', ')}. ` +
        `The library has ${byName.size} asset type(s). Add them to the library, or request different assets.`
    );
  }

  // The total is checked against what was REQUESTED, not against the per-asset
  // clamped counts. Otherwise the clamp launders an oversized ask into compliance:
  // under a 3-per-asset / 6-total ceiling, "5 emails and 5 landing pages" would be
  // cut to 3 + 3 = 6, pass the total check, and quietly build something the brief
  // did not ask for — on the surface that has no confirmation step to show it.
  const requestedTotal = requestedInstanceTotal(assetsOrPlan);
  if (requestedTotal > maxTotal) {
    throw new Error(
      `Asset plan asks for ${requestedTotal} asset instances, above the ${maxTotal}-instance ceiling. ` +
        (hint || 'Split this into more than one brief.')
    );
  }

  const ordinal = instanceCounter();
  const out = [];
  for (const { asset, count, labels } of plan) {
    const template = byName.get(normalize(asset));
    for (let i = 0; i < count; i += 1) {
      out.push({
        ...cloneSpecGroup(template),
        instance: ordinal(template.assetType),
        // Positional within THIS plan entry (not the whole plan), so a second entry
        // naming the same asset labels its own instances from its own list.
        instanceLabel: (labels && labels[i]) || null,
      });
    }
  }
  return out;
}

// Expand the asset plan into specs, create the campaign project folder (+ empty Assets
// subfolder) inside the target folder, and build the formatted document inside
// it. Returns { doc, assetSpecs, projectFolderUrl }. Throws createDocument
// errors so the caller can classify them (e.g. folder-access recovery).
// Optional `clients` (from getClientsForTenant) runs the Drive folder + Doc
// creation as the acting user's OAuth identity; omitted → shared env getClients().
// `projectMeta.createdBy` (users.id) is recorded as the project's author.
// `tenantId` selects the per-tenant Postgres asset library — the sole spec
// source (the Google Sheet was fully retired) — and supplies asset_direction.
// Throws if the tenant has no Postgres asset library (no DB / unseeded tenant):
// Postgres is mandatory, there is no Sheet fallback.
// `assetLimits` (optional) is the CALLING SURFACE's instance ceiling — omit for
// the defaults. A surface with no confirmation step should pass a tighter pair.
// PARTITION SPEC GROUPS BY THE TEMPLATE THEY RENDER INTO (custom document
// types, STEP THREE).
//
// One brief can produce more than one document. Assets with no attachment — every
// asset today, and the default forever — go into the copy doc exactly as they
// always have. Assets attached to a template are pulled out and grouped BY
// TEMPLATE, not by asset: two assets attached to the same matrix fill one
// document between them, which is what a "Form & Confirmation Matrix" holding
// both pages means.
//
// Pure, and exported, so the partition is assertable without a Google client or
// a database — this is the one piece of step three that decides what lands where.
//
//   specs:      the expanded assetSpecs array (tenantAssetsToSpecs output)
//   bindingFor: (assetName) => null | { templateId, templateName, sourceDocId,
//                                       markers, fieldMarkers }
//
// Returns { copyDocSpecs, templateGroups } where templateGroups is
//   [{ templateId, templateName, sourceDocId, markers, specs, fieldMarkers }]
// in first-seen order, so document order follows brief order.
function partitionSpecsByTemplate(specs, bindingFor) {
  const copyDocSpecs = [];
  const byTemplate = new Map();
  const lookup = typeof bindingFor === 'function' ? bindingFor : () => null;

  for (const spec of specs || []) {
    const binding = lookup(spec.assetType);
    // EVERY SPEC GOES IN THE COPY DOC — including template-attached ones. This is
    // a partition for OUTPUT, not for content.
    //
    // Step three diverted attached assets out of the copy doc, and that turned
    // out to be the wrong cut: the copy doc is where drafting and review happen.
    // generateDraft re-parses it, copyReview reads it, the web project view
    // renders it. An asset that is not in it is an asset no writer can draft, no
    // reviewer can comment on, and no surface can show — and the template
    // document would arrive empty forever.
    //
    // So the asset renders in the copy doc like any other, and the template
    // document is a SECOND RENDERING of the same copy in the tenant's own format.
    // That is what a copy matrix is: the deliverable, not the workspace.
    copyDocSpecs.push(spec);

    // A binding with no source document to copy produces no second rendering.
    // A template row whose imported Doc was deleted must not stop the asset
    // reaching the copy doc — which, now, it cannot.
    if (!binding || !binding.sourceDocId) continue;
    if (!byTemplate.has(binding.templateId)) {
      byTemplate.set(binding.templateId, {
        templateId: binding.templateId,
        templateName: binding.templateName,
        sourceDocId: binding.sourceDocId,
        markers: binding.markers || [],
        specs: [],
        // Merged across every asset in the group, keyed "asset|field" so two
        // assets sharing a field name cannot collide on one marker.
        fieldMarkers: new Map(),
      });
    }
    const group = byTemplate.get(binding.templateId);
    group.specs.push(spec);
    for (const [fieldNorm, marker] of binding.fieldMarkers || new Map()) {
      group.fieldMarkers.set(`${normalize(spec.assetType)}|${fieldNorm}`, marker);
    }
  }

  return { copyDocSpecs, templateGroups: [...byTemplate.values()] };
}

// The copy each mapped marker should receive, keyed by marker key.
//
// AT BRIEF TIME THIS IS EMPTY, and that is not a bug in this function — it is a
// fact about when copy exists. generateDoc builds STRUCTURE: field labels, limits
// and hints, with a blank line under each for copy that has not been written yet.
// The words arrive later, from generateDraft, which re-reads the copy doc. So a
// template document built at brief time is correctly a copy of the tenant's
// matrix with every marker still visible.
//
// The function takes the copy from wherever a caller has it (spec.fields[].copy),
// so the day a drafting path reaches these assets, filling them is this call and
// nothing else.
function templateValuesFor(group) {
  const values = new Map();
  for (const spec of group.specs || []) {
    for (const field of spec.fields || []) {
      const marker = group.fieldMarkers.get(`${normalize(spec.assetType)}|${normalize(field.fieldName)}`);
      if (!marker) continue; // unmapped field — nothing to place
      const copy = field.copy || field.draft || null;
      if (typeof copy === 'string' && copy.trim()) values.set(marker.key, copy);
    }
  }
  return values;
}

async function generateDoc(spec, folderId, clients, tenantId, projectMeta = {}, assetLimits) {
  // Asset specs come exclusively from the tenant's Postgres library.
  const tenantAssets = await getTenantAssets(tenantId);
  if (!tenantAssets || tenantAssets.length === 0) {
    throw new Error(
      'No asset library found in Postgres for this tenant — cannot build a doc. ' +
        'Ensure DATABASE_URL is set and the tenant has been seeded (asset_types/copy_fields).'
    );
  }
  // `spec.assets` is an asset PLAN: a bare string[] (each name once) or entries of
  // { asset, count }. Expanded in request order; throws on an unmatched name.
  const assetSpecs = tenantAssetsToSpecs(tenantAssets, spec.assets, assetLimits);
  console.log('[pipeline] asset specs source: postgres');
  console.log(
    '[workflow] asset specs read OK —',
    assetSpecs.length,
    'asset group(s):',
    JSON.stringify(assetSpecs.map((a) => (a.instance ? `${a.assetType}#i${a.instance}` : a.assetType)))
  );

  // asset_direction comes from Postgres regardless of spec source. Best-effort:
  // null without a DB/seed → renders nothing. (Idempotent for the Postgres path —
  // re-sets the same value the rows already carry.)
  const lookupDirection = await getAssetDirections(tenantId);
  for (const a of assetSpecs) a.asset_direction = lookupDirection(a.assetType);

  // WHICH OF THESE RENDER SOMEWHERE ELSE. A second, named read — getTenantAssets
  // deliberately carries neither the attachment nor the markers, so the spec
  // source is exactly what it always was. An empty lookup (no DB, no migration,
  // no attachments) puts every asset in the copy doc, which is today's behaviour
  // reached by today's code path.
  const bindingFor = await getAssetTemplateBindings(tenantId);
  const { copyDocSpecs, templateGroups } = partitionSpecsByTemplate(assetSpecs, bindingFor);
  if (templateGroups.length) {
    console.log(
      `[pipeline] ${templateGroups.length} template document(s) to build: ` +
        JSON.stringify(templateGroups.map((g) => `${g.templateName} <- ${g.specs.map((x) => x.assetType).join(', ')}`))
    );
  }

  // Create the project folder (named after the campaign) inside the target
  // folder, with an empty Assets subfolder. The copy doc then goes inside the
  // project folder rather than the bare target folder.
  //
  // Only the PROJECT folder must finish before the doc (the doc lives in it).
  // The empty "Assets" subfolder is independent — nothing downstream reads it —
  // so we kick it off WITHOUT awaiting and let it run concurrently with the doc
  // build, shaving a Drive round-trip off the critical path. It's settled
  // (best-effort) before we return so a failure is still logged, not orphaned.
  let docFolderId = folderId;
  let projectFolderUrl = null;
  let assetsSubfolderPromise = Promise.resolve();
  try {
    const activeClients = clients || (await getClients());
    const { drive } = activeClients;
    // Folder placement: an explicit folderId (brief URL or tenant default) always
    // wins. With none, a real OAuth user gets the folder in THEIR My Drive root
    // (parents omitted) — never the global default. The service account has ~no
    // personal Drive quota, so it still falls back to config.DRIVE_FOLDER_ID
    // (a Shared Drive).
    const parent = folderId || (activeClients.usingOAuth ? null : config.DRIVE_FOLDER_ID);
    const folder = await drive.files.create({
      requestBody: {
        name: spec.campaignTitle || 'Untitled Campaign',
        mimeType: 'application/vnd.google-apps.folder',
        ...(parent ? { parents: [parent] } : {}),
      },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });
    docFolderId = folder.data.id;
    projectFolderUrl = folder.data.webViewLink;
    console.log('[Quillio] project folder created:', docFolderId);
    // Empty Assets subfolder, ready for exports — fire-and-forget (not on the
    // doc's critical path). Failure is logged, never thrown.
    assetsSubfolderPromise = drive.files
      .create({
        requestBody: {
          name: 'Assets',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [docFolderId],
        },
        supportsAllDrives: true,
      })
      .catch((err) => {
        console.error('[Quillio] Assets subfolder creation failed:', err.message);
      });
  } catch (err) {
    console.error('[Quillio] project folder creation failed:', err.message);
    docFolderId = folderId; // fall back to the bare target folder
  }

  // Per-tenant copy-doc header schema (doc-header-template work). Best-effort: a
  // DB miss/error, or a tenant with no stored schema, yields null → createDocument
  // renders today's exact default header (title + HR), unchanged.
  let headerSchema = null;
  let namingPattern = null;
  if (tenantId) {
    try {
      headerSchema = await getHeaderSchema(tenantId);
    } catch (err) {
      console.warn('[pipeline] header schema lookup failed — using default header:', err.message);
    }
    try {
      namingPattern = await getNamingPattern(tenantId);
    } catch (err) {
      console.warn('[pipeline] naming pattern lookup failed — using default naming:', err.message);
    }
  }
  console.log(`[pipeline] doc header schema: ${headerSchema ? 'tenant (Postgres)' : 'default'}`);
  console.log(`[pipeline] doc naming: ${namingPattern ? 'tenant pattern' : 'default'}`);

  // TEMPLATE DOCUMENTS FIRST, then the copy doc.
  //
  // The ordering is deliberate and is set now so it does not have to be
  // rearranged later: the copy doc will eventually carry a link to these, and a
  // link cannot be written to a document that does not exist yet. Nothing reads
  // `templateDocs` on the way into createDocument today — that is step six.
  //
  // Each one is independent and BEST-EFFORT. The copy doc is the project's
  // primary artifact: db/projects keys idempotency on copy_doc_id, both surfaces
  // link to it, and copy review runs against it. A tenant's matrix failing to
  // copy — a deleted source doc, a Drive permission — must not take the brief
  // down with it, so a failure is logged and reported, never thrown.
  const templateDocs = [];
  for (const group of templateGroups) {
    try {
      const built = await getDestination().createFromTemplate({
        sourceDocId: group.sourceDocId,
        // NAMING: "<Campaign> — <Template>". The campaign first because the
        // folder holds one project's documents and they sort together; the
        // template name second because that is what the tenant called it and
        // what they will look for. Deliberately NOT the asset name — two assets
        // can share one template, and naming it after the first would be wrong
        // half the time.
        name: `${spec.campaignTitle || 'Untitled Campaign'} — ${group.templateName}`,
        folderId: docFolderId,
        values: templateValuesFor(group),
        markers: group.markers,
        clients,
      });
      templateDocs.push({ ...built, templateId: group.templateId, templateName: group.templateName });
    } catch (err) {
      console.error(`[pipeline] template document "${group.templateName}" failed:`, err.message);
      templateDocs.push({ templateId: group.templateId, templateName: group.templateName, error: err.message });
    }
  }

  // Build the doc in parallel with the Assets subfolder.
  //
  // `copyDocSpecs` is every spec — a template-attached asset renders here too,
  // so the existing drafter and reviewer reach it. It stays a distinct name
  // because partitionSpecsByTemplate owns the decision, and a future rule that
  // does hold something back should have one place to change.
  const doc = await getDestination().createDocument({
    brief: spec.brief,
    campaignTitle: spec.campaignTitle,
    summary: spec.summary,
    writerPrompt: spec.writerPrompt,
    assetSpecs: copyDocSpecs,
    folderId: docFolderId,
    referenceLinks: spec.referenceLinks,
    referenceInsights: spec.referenceInsights,
    headerSchema,
    namingPattern,
    clients,
  });

  // Make sure the subfolder call has settled before returning (best-effort).
  await assetsSubfolderPromise;

  // Persist the project to history — shared by BOTH adapters so web and Slack
  // briefs always appear in the web project list identically. Best-effort: a DB
  // hiccup (or no DATABASE_URL on the demo) must never fail an otherwise-good
  // brief, so any error is swallowed. slack_channel_id / slack_thread_ts come
  // from projectMeta on the Slack path and are null for web (correct). drive
  // folder id is the project folder we created (null if creation failed).
  let projectId = null;
  try {
    const saved = await saveProject(tenantId, {
      name: spec.campaignTitle || null,
      drive_folder_id: projectFolderUrl ? docFolderId : null,
      drive_folder_url: projectFolderUrl,
      copy_doc_id: doc.id,
      copy_doc_url: doc.url,
      // The FIRST template document, if any. A named pair, not a join table —
      // see scripts/migrateAddProjectTemplateDoc.js for why, and for what
      // happens when a brief produces more than one.
      template_doc_id: (templateDocs.find((t) => t.id) || {}).id || null,
      template_doc_url: (templateDocs.find((t) => t.id) || {}).url || null,
      status: 'not_started',
      slack_channel_id: projectMeta.slackChannelId || null,
      slack_thread_ts: projectMeta.slackThreadTs || null,
      // Authorship: the acting user (users.id). On Slack that's whoever ran the
      // command (resolved from their Slack identity); on the web it's the
      // session user. Null when no user is identified (demo/env path).
      created_by: projectMeta.createdBy || null,
    });
    if (saved) projectId = saved.id;
  } catch (err) {
    console.error('[pipeline] saveProject skipped:', err.message);
  }

  // THE COPY DOC ALWAYS HOLDS EVERY ASSET, so the "every requested asset is
  // template-attached" case step three had to reason about no longer exists —
  // the copy doc is never empty of assets. It remains the project's primary
  // artifact: db/projects keys idempotency on copy_doc_id, both surfaces link to
  // it, copy review runs against it, and drafting happens in it.
  //
  // The template documents built above are still UNFILLED at this point. There
  // is no drafted copy at brief time — the copy doc is built as structure and
  // the words arrive from generateDraft — so every marker is still visible.
  // syncTemplateDocuments below fills them, after drafting.
  return { doc, assetSpecs, copyDocSpecs, templateDocs, projectFolderUrl, projectId };
}

// Draft copy for every field of an existing doc. An optional `direction` string
// is passed through as user revision feedback (the "Regenerate" path). Optional
// `clients` runs the Docs read/write as a specific tenant's OAuth user. Optional
// `tenantId` selects that tenant's saved voice guide (Postgres) for the prompt,
// falling back to the repo voice.md when there's no DB / no saved guide, and
// supplies the asset-level creative direction lookup for the drafter.
// Returns { title, fieldCount, url }.
// BUILD AND DRAFT A DOCUMENT TEMPLATE (document templates, rework step two).
//
// The whole path from a CONFIRMED template: copy it into the campaign folder,
// draft copy for every marker the tenant ticked as copy, and write that copy
// into the cells whose coordinates were stored at confirm time.
//
// REACHABLE ONLY FROM THE CONFIRMED-TEMPLATE FLOW. parseBrief does not know
// templates exist yet (that is step four), so nothing routes here from a brief.
// A caller has to hand over a template id it already has.
//
// A TEMPLATE IS CONFIRMED when it has template_markers rows. Without them there
// are no coordinates and nothing can be placed, so this refuses rather than
// falling back to a marker-name match — the whole point of the rework is that
// the position IS the mapping.
//
// THE THREE STEPS, and why each reuses what exists:
//
//   1. COPY — getDestination().createFromTemplate with no values and no markers.
//      That is the same drive.files.copy the existing template import uses;
//      passing nothing to fill means it copies and sends no batchUpdate, so the
//      markers are still standing when step 3 goes looking for their cells.
//   2. DRAFT — gemini.generateAssetDrafts, the same batched call the copy doc's
//      assets go through. The template becomes one "asset" whose fields are its
//      copy markers, so the prompt, the character-limit enforcement and the
//      craft/brand context are all the existing ones. No new prompt.
//   3. WRITE — getDestination().writeTemplateCells, one batchUpdate in reverse
//      document order.
//
// Returns { docId, docUrl, title, drafted, written, skipped, healed, missing }.
async function buildTemplateDocument({ tenantId, templateId, spec = {}, folderId = null, clients, direction }) {
  if (!tenantId || !templateId) throw new Error('buildTemplateDocument: tenantId and templateId are required.');

  const template = await getDocTemplate(tenantId, templateId);
  if (!template) throw new Error(`No template ${templateId} for this tenant.`);
  if (!template.source_doc_id) throw new Error(`Template "${template.name}" has no imported document to copy.`);

  const markers = await listTemplateMarkers(tenantId, templateId);
  if (markers === null) {
    throw new Error('Template fields are not available — run scripts/migrateAddTemplateMarkers.js.');
  }
  if (markers.length === 0) {
    throw new Error(`Template "${template.name}" has no confirmed fields yet. Confirm them in Settings first.`);
  }
  const copyMarkers = markers.filter((m) => m.is_copy);
  if (copyMarkers.length === 0) {
    throw new Error(`Template "${template.name}" has no markers ticked as copy, so there is nothing to draft.`);
  }

  console.log(
    `[pipeline] template "${template.name}": ${markers.length} marker(s), ` +
      `${copyMarkers.length} to draft, ${markers.length - copyMarkers.length} left as metadata`
  );

  // --- 1. copy -------------------------------------------------------------
  // No values, no markers: copy only. The {{markers}} stay in place so step 3
  // can find their cells, and nothing is filled by replaceAllText — which would
  // consume the marker and is the mechanism this rework replaced.
  const copied = await getDestination().createFromTemplate({
    sourceDocId: template.source_doc_id,
    name: `${spec.campaignTitle || 'Untitled Campaign'} — ${template.name}`,
    folderId,
    values: new Map(),
    markers: [],
    clients,
  });

  // --- 2. draft ------------------------------------------------------------
  let voiceGuide = null;
  try {
    voiceGuide = await getVoiceGuide(tenantId);
  } catch (err) {
    console.warn('[pipeline] voice guide lookup failed — using repo voice.md:', err.message);
  }

  // The template is ONE asset whose fields are its copy markers. `assetType` is
  // the template's name, which is what gemini slices craft.md by
  // (mediumKeywordsForAsset) — a name with "form" or "confirmation" in it gets
  // the right medium section, and one that matches nothing falls back to the
  // whole file, which is the documented safe outcome.
  const fields = copyMarkers.map((m) => ({
    fieldName: m.marker_name,
    charMin: m.char_min || 0,
    charMax: m.char_max || 0,
    fieldType: m.field_type === 'words' ? 'words' : 'text',
    notes: m.spec_note || '',
  }));

  const drafts = await generateAssetDrafts({
    assetType: template.name,
    summary: spec.summary || '',
    writerPrompt: spec.writerPrompt || '',
    fields,
    direction: direction || '',
    voiceGuide,
  });

  // marker_key -> copy. Matched on the field name the draft came back with,
  // which is the marker name it was asked for.
  const byName = new Map(copyMarkers.map((m) => [String(m.marker_name).trim().toLowerCase(), m.marker_key]));
  const values = new Map();
  for (const d of drafts || []) {
    const key = byName.get(String(d.fieldName || '').trim().toLowerCase());
    if (!key) continue;
    if (typeof d.copy === 'string' && d.copy.trim()) values.set(key, d.copy.trim());
  }

  // --- 3. write ------------------------------------------------------------
  // Only the COPY markers are handed over. A metadata marker is never located
  // and never written — its cell is the tenant's, and leaving {{Form ID}}
  // standing is the correct outcome, not an omission.
  const result = await getDestination().writeTemplateCells(
    copied.id,
    { markers: copyMarkers, values },
    clients
  );

  return {
    docId: copied.id,
    docUrl: copied.url,
    title: copied.title,
    templateName: template.name,
    markers: markers.length,
    copyMarkers: copyMarkers.length,
    drafted: values.size,
    ...result,
  };
}

// SYNC THE DRAFTED COPY INTO THIS PROJECT'S TEMPLATE DOCUMENT(S).
//
// Runs after every draft. Reads the copy doc back — the same read the web
// project view uses — maps each field to its marker, and pushes the text into
// the template document.
//
// WHY A FULL RE-SYNC, EVEN FOR A SCOPED DRAFT. Regeneration and scoped drafts
// target individual fields, so a scoped sync is possible: map scopedFields to
// their markers and send only those. It is not worth it. getDocContent reads the
// WHOLE document either way (there is no partial read), the marker set is a
// couple of dozen strings, and fillTemplateMarkers sends nothing for a field
// whose copy has not changed — so a full sync of an unchanged document is one
// Docs read and zero write requests.
//
// What the full sync buys is the case a scoped one gets wrong: a writer who
// regenerated field A after hand-editing field B in the copy doc. A scoped sync
// carries A and silently leaves B's older copy in the matrix. The full sync
// carries both, and the two documents agree.
//
// EVERYTHING HERE IS BEST-EFFORT. A draft that succeeded must not fail because a
// template could not be updated — the copy is in the copy doc, which is the
// writer's working surface. Failures are logged and returned, never thrown.
//
// Returns null when there is nothing to sync (the overwhelmingly common case:
// no DB, no project row, or a project with no template document), so the cost
// for an ordinary brief is one indexed lookup.
async function syncTemplateDocuments(docId, clients, tenantId) {
  if (!docId || !tenantId) return null;

  let project = null;
  try {
    project = await getProjectByDocId(tenantId, docId);
  } catch (err) {
    console.warn('[pipeline] template sync: project lookup failed:', err.message);
    return null;
  }
  if (!project || !project.template_doc_id) return null;

  try {
    const bindingFor = await getAssetTemplateBindings(tenantId);
    // The drafted copy, read back out of the copy doc. This is why the asset has
    // to render there: this read is the ONLY place the words exist.
    const content = await getDestination().getDocContent(docId, clients);

    // markerKey -> drafted copy, and the marker display names, gathered from the
    // bindings of the assets that actually appear in the document.
    const values = new Map();
    const markers = new Map();
    for (const asset of (content && content.assets) || []) {
      const binding = bindingFor(asset.name);
      if (!binding) continue;
      for (const m of binding.markers || []) markers.set(m.key, m);
      for (const field of asset.fields || []) {
        const marker = binding.fieldMarkers.get(normalize(field.fieldName));
        if (!marker) continue; // unmapped field — its marker stays visible
        const copy = field.copy == null ? '' : String(field.copy);
        // The LAST instance wins for a repeated asset. A matrix has one cell per
        // marker, so multiple instances of one asset cannot all be placed; taking
        // the last is arbitrary but stable, and the copy doc still holds them all.
        if (copy.trim()) values.set(marker.key, copy.trim());
      }
    }

    const result = await getDestination().fillTemplateMarkers(
      project.template_doc_id,
      {
        values,
        previous: (project.template_fill && typeof project.template_fill === 'object') ? project.template_fill : {},
        markers: [...markers.values()],
      },
      clients
    );

    // Remember what was written, so the NEXT sync can find it — replaceAllText
    // consumed the marker, so the copy itself is the only handle left.
    await setProjectTemplateFill(tenantId, project.id, result.applied);

    console.log(
      `[pipeline] template sync for project ${project.id}: ` +
        `${result.filled.length} updated, ${result.unchanged.length} unchanged, ${result.skipped.length} still showing a marker`
    );
    return { templateDocId: project.template_doc_id, templateDocUrl: project.template_doc_url, ...result };
  } catch (err) {
    // The draft SUCCEEDED. The copy is in the copy doc; the matrix is stale until
    // the next draft. That is a far better outcome than failing the draft.
    console.error('[pipeline] template sync failed (the draft is unaffected):', err.message);
    return { error: err.message };
  }
}

async function generateDraft(docId, direction, clients, tenantId, scopedFields, append) {
  // Best-effort: a DB miss/error just falls back to the repo voice.md. Never
  // log the guide content — only whether one was found.
  let voiceGuide = null;
  if (tenantId) {
    try {
      voiceGuide = await getVoiceGuide(tenantId);
    } catch (err) {
      console.warn('[workflow] voice guide lookup failed — using repo voice.md:', err.message);
    }
  }
  console.log(`[workflow] draft voice guide: ${voiceGuide ? 'tenant (Postgres)' : 'repo voice.md'}`);
  const lookupDirection = await getAssetDirections(tenantId);
  // `scopedFields` (optional [{assetType, fieldName}]) scopes the draft to those
  // fields; undefined → whole-doc, exactly as before. `append` (Variations Matrix
  // Step 1) makes a scoped call ADDITIVE — insert below existing copy, no delete.
  const result = await getDestination().generateDraft(
    docId, direction, clients, voiceGuide, lookupDirection, scopedFields, append
  );

  // HOOKED HERE, and not in the adapters, because this is the ONE function both
  // of them call for every kind of draft: a first draft, a scoped draft, a
  // regeneration, a riff. Putting it in slackWorkflow would have meant a second
  // copy in web.js and a third the next time a surface appears — and a
  // regeneration that skipped the sync is exactly the silent divergence this
  // step exists to prevent.
  //
  // Awaited, so the completion card a caller posts next is telling the truth
  // about both documents. Never throws — see syncTemplateDocuments.
  const templateSync = await syncTemplateDocuments(docId, clients, tenantId);

  return templateSync ? { ...result, templateSync } : result;
}

// Read an existing doc into a structured, copy-bearing shape for the web
// project view. Optional `clients` runs the Docs read as a tenant's OAuth user.
// Returns { title, summary, writerDirection, assets: [...] }.
async function getProjectContent(docId, clients) {
  return getDestination().getDocContent(docId, clients);
}

// Count the assets in a doc (one HEADING_3 heading per asset). Best-effort:
// returns 0 if the doc can't be read.
async function countDocAssets(docId) {
  let assetCount = 0;
  try {
    const { docs } = await getClients();
    const doc = (await docs.documents.get({ documentId: docId })).data;
    assetCount = (doc.body.content || []).filter(
      (it) => it.paragraph?.paragraphStyle?.namedStyleType === 'HEADING_3'
    ).length;
  } catch (err) {
    console.warn('[workflow] asset count for progress message failed:', err.message);
  }
  return assetCount;
}

// Look up a Drive folder's name. Best-effort: returns null on failure.
async function getFolderName(folderId) {
  try {
    const { drive } = await getClients();
    const meta = await drive.files.get({
      fileId: folderId,
      fields: 'name',
      supportsAllDrives: true,
    });
    return (meta.data && meta.data.name) || null;
  } catch (err) {
    console.warn('[workflow] folder name fetch failed:', err.message);
    return null;
  }
}

// Extract a Drive folder id straight from the brief text (deterministic — never
// trust the Gemini-parsed folderId, which can truncate a long id). The id is the
// full run of characters after /folders/ (or open?id=) up to the next delimiter
// — slash, query, fragment, whitespace, or wrapping punctuation — or end of
// string. Google ids are [A-Za-z0-9_-], but we capture broadly and stop only at
// a true boundary so a valid id is never cut short.
const FOLDER_ID_STOP = "/?#&\\s\"'<>()\\[\\]{}";
const BRIEF_FOLDER_PATH_RE = new RegExp(`drive\\.google\\.com/drive/folders/([^${FOLDER_ID_STOP}]+)`);
const BRIEF_FOLDER_OPEN_RE = new RegExp(`drive\\.google\\.com/open\\?id=([^${FOLDER_ID_STOP}]+)`);

function extractBriefFolderId(briefText) {
  const text = String(briefText || '');
  const m = text.match(BRIEF_FOLDER_PATH_RE) || text.match(BRIEF_FOLDER_OPEN_RE);
  return m ? m[1] : null;
}

// Decide where a generated doc should land, in priority order:
//   1. A Drive folder URL embedded in the brief text (explicit per-brief override)
//   2. The tenant's saved default folder (Settings → tenants.default_folder_id)
//   3. null → generateDoc falls back to config.DRIVE_FOLDER_ID (global default)
// `tenant` is the object resolveTenant returns; it carries default_folder_id in
// both the Postgres and env-fallback shapes. Centralized so the web + Slack
// adapters route identically.
function resolveDestinationFolderId(briefText, tenant) {
  return extractBriefFolderId(briefText) || (tenant && tenant.default_folder_id) || null;
}

// The service account's email (for folder-access recovery messaging).
async function getServiceAccountEmail() {
  const { serviceAccountEmail } = await getClients();
  return serviceAccountEmail;
}

module.exports = {
  parseBrief,
  resolveAssetVocabulary,
  fetchAllReferences,
  fetchAttachedFiles,
  processAttachedFiles,
  cleanupAttachedFiles,
  enrichWithReferences,
  generateDoc,
  generateDraft,
  getProjectContent,
  countDocAssets,
  getFolderName,
  extractBriefFolderId,
  resolveDestinationFolderId,
  extractCanvasId,
  isFolderAccessError,
  getServiceAccountEmail,
  // Asset-plan expansion. Exported for unit tests (and so the ceilings are
  // assertable) — generateDoc is its only production caller.
  tenantAssetsToSpecs,
  // The build-time partition — which specs go to the copy doc and which to a
  // template. Pure, so what lands where is assertable with no Google client.
  partitionSpecsByTemplate,
  templateValuesFor,
  // The after-drafting sync. Exported for tests; generateDraft is its only
  // production caller.
  syncTemplateDocuments,
  // The confirmed-template build path (rework step two). Reachable only from a
  // caller that already has a template id — parseBrief does not know templates
  // exist yet.
  buildTemplateDocument,
  normalizeAssetPlan,
  resolveAssetLimits,
  // The DEFAULT (web) ceilings, and the absolute maximum a surface can ask for.
  MAX_INSTANCES_PER_ASSET,
  MAX_TOTAL_INSTANCES,
  DEFAULT_ASSET_LIMITS,
};
