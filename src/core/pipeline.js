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
} = require('../services/gemini');
const { normalize } = require('../utils/normalize');
const { getDestination } = require('../destinations');
const { getVoiceGuide } = require('../db');
const { getAssetDirections, getTenantAssets } = require('../db/assets');

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

// Parse a free-form brief into structured data (campaignTitle, summary,
// writerPrompt, assets, unmatchedAssets, folderId, referenceLinks).
async function parseBrief(briefText) {
  const parsed = await geminiParseBrief(briefText);

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

// Convert a tenant's Postgres asset library (getTenantAssets output) into the
// exact shape getAssetSpecs returns, so every downstream consumer (createDocument,
// generateAssetDrafts) is identical regardless of source. Postgres has no
// channel / toneNotes / per-field notes / funnelStage columns → those map to
// empty strings (the same value the Sheet yields when those cells are blank).
// Applies the same filter semantics as getAssetSpecs: restrict to the requested
// assets (normalized), but return all when the filter is empty or matches nothing.
function tenantAssetsToSpecs(rows, assetFilter = []) {
  let result = (rows || [])
    .map((a) => ({
      assetType: a.name,
      channel: '', // not stored in Postgres (Sheet-only)
      toneNotes: '', // not stored in Postgres (Sheet-only)
      asset_direction: a.asset_direction || null,
      fields: (a.fields || []).map((f) => ({
        fieldName: f.field_name,
        charMin: parseInt(f.char_min, 10) || 0,
        charMax: parseInt(f.char_max, 10) || 0,
        notes: '', // not stored in copy_fields (Sheet-only)
        funnelStage: '', // not stored in copy_fields (Sheet-only)
      })),
    }))
    // getAssetSpecs never emits an asset with zero fields — match that.
    .filter((g) => g.fields.length > 0);

  if (Array.isArray(assetFilter) && assetFilter.length > 0) {
    const wanted = new Set(assetFilter.map(normalize));
    const filtered = result.filter((g) => wanted.has(normalize(g.assetType)));
    if (filtered.length > 0) result = filtered;
  }
  return result;
}

// Read + filter asset specs, create the campaign project folder (+ empty Assets
// subfolder) inside the target folder, and build the formatted document inside
// it. Returns { doc, assetSpecs, projectFolderUrl }. Throws createDocument
// errors so the caller can classify them (e.g. folder-access recovery).
// Optional `clients` (from getClientsForTenant) runs the Drive folder + Doc
// creation as a specific tenant's OAuth user; omitted → shared env getClients().
// `tenantId` selects the per-tenant Postgres asset library — the sole spec
// source (the Google Sheet was fully retired) — and supplies asset_direction.
// Throws if the tenant has no Postgres asset library (no DB / unseeded tenant):
// Postgres is mandatory, there is no Sheet fallback.
async function generateDoc(spec, folderId, clients, tenantId) {
  // Asset specs come exclusively from the tenant's Postgres library.
  const tenantAssets = await getTenantAssets(tenantId);
  if (!tenantAssets || tenantAssets.length === 0) {
    throw new Error(
      'No asset library found in Postgres for this tenant — cannot build a doc. ' +
        'Ensure DATABASE_URL is set and the tenant has been seeded (asset_types/copy_fields).'
    );
  }
  const assetSpecs = tenantAssetsToSpecs(tenantAssets, spec.assets);
  console.log('[pipeline] asset specs source: postgres');
  console.log(
    '[workflow] asset specs read OK —',
    assetSpecs.length,
    'asset group(s):',
    JSON.stringify(assetSpecs.map((a) => a.assetType))
  );

  // asset_direction comes from Postgres regardless of spec source. Best-effort:
  // null without a DB/seed → renders nothing. (Idempotent for the Postgres path —
  // re-sets the same value the rows already carry.)
  const lookupDirection = await getAssetDirections(tenantId);
  for (const a of assetSpecs) a.asset_direction = lookupDirection(a.assetType);

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
    const { drive } = clients || (await getClients());
    const parent = folderId || config.DRIVE_FOLDER_ID;
    const folder = await drive.files.create({
      requestBody: {
        name: spec.campaignTitle || 'Untitled Campaign',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parent],
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

  // Build the doc in parallel with the Assets subfolder.
  const doc = await getDestination().createDocument({
    brief: spec.brief,
    campaignTitle: spec.campaignTitle,
    summary: spec.summary,
    writerPrompt: spec.writerPrompt,
    assetSpecs,
    folderId: docFolderId,
    referenceLinks: spec.referenceLinks,
    referenceInsights: spec.referenceInsights,
    clients,
  });

  // Make sure the subfolder call has settled before returning (best-effort).
  await assetsSubfolderPromise;

  return { doc, assetSpecs, projectFolderUrl };
}

// Draft copy for every field of an existing doc. An optional `direction` string
// is passed through as user revision feedback (the "Regenerate" path). Optional
// `clients` runs the Docs read/write as a specific tenant's OAuth user. Optional
// `tenantId` selects that tenant's saved voice guide (Postgres) for the prompt,
// falling back to the repo voice.md when there's no DB / no saved guide, and
// supplies the asset-level creative direction lookup for the drafter.
// Returns { title, fieldCount, url }.
async function generateDraft(docId, direction, clients, tenantId) {
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
  return getDestination().generateDraft(docId, direction, clients, voiceGuide, lookupDirection);
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
};
