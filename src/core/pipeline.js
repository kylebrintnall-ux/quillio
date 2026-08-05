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
  // Step three: the single-field revision, and the drafter's own over-limit
  // check — imported rather than reimplemented so a regenerate and a review
  // cannot disagree with the drafter about what "over" means.
  generateFieldDraft,
  overLimit,
} = require('../services/gemini');
const { normalize } = require('../utils/normalize');
const { instanceCounter } = require('../utils/instanceKey');
const { getDestination } = require('../destinations');
const { getVoiceGuide, getHeaderSchema, getNamingPattern } = require('../db');
const { getAssetDirections, getTenantAssets } = require('../db/assets');
const { saveProject, getProjectByDocId, getProjectByAnyDocId } = require('../db/projects');
const { getDocTemplate, listDocTemplates } = require('../db/docTemplates');
const { listTemplateMarkers } = require('../db/templateMarkers');
const { postTemplateReview } = require('../services/templateReview');

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
// and the bundled library is the only sensible vocabulary.
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

// The tenant's DOCUMENT TEMPLATE names — the second vocabulary a brief can draw
// on (rework step four). A template is a first-class thing a brief names; there
// is no asset type in the middle any more.
//
// Only templates with an imported document are offered. One without a
// source_doc_id has nothing to copy, so naming it could only ever fail, and a
// vocabulary that includes things that cannot be built teaches the model to
// suggest them.
//
// A template with no CONFIRMED markers is still offered, deliberately. It can be
// named, and buildTemplateDocument refuses it with "has no confirmed fields yet
// — confirm them in Settings first", which is the sentence that tells somebody
// what to do. Leaving it out of the vocabulary instead would produce "that is
// not a template I know about" for a template sitting in their settings.
//
// THREE STATES, NOT TWO. This is the correction to a pattern copied from
// resolveAssetVocabulary that does not transfer:
//
//   no DB / no doc_templates table  → listDocTemplates returns null → [] and
//                                     SILENT. Correct: this tenant has no
//                                     templates, and never did.
//   a real library                  → the names.
//   the read THREW                  → `unavailable: true`, and the caller stops.
//
// resolveAssetVocabulary can swallow its failure because it has somewhere to
// fall back TO — config.ALLOWED_ASSETS, a real vocabulary. There is no fallback
// for templates, so swallowing it produced an empty list indistinguishable from
// "this tenant has no templates". A brief naming a template in that window was
// then refused as an unknown ASSET — the exact failure this rework removes,
// wearing a message that blames the user for a database outage and advises
// adding an asset type that would collide with the template forever after.
//
// An infrastructure failure has to look like one.
async function resolveTemplateVocabulary(tenantId) {
  if (!tenantId) return { names: [], byNorm: new Map(), unavailable: false };
  let rows = null;
  try {
    rows = await listDocTemplates(tenantId);
  } catch (err) {
    console.error('[pipeline] template vocabulary lookup FAILED:', err.message);
    return { names: [], byNorm: new Map(), unavailable: true, error: err.message };
  }
  const usable = (rows || []).filter((t) => t && t.name && t.source_doc_id);
  return {
    names: usable.map((t) => t.name),
    byNorm: new Map(usable.map((t) => [normalize(t.name), t])),
    unavailable: false,
  };
}

// REFUSE A NAME THAT IS IN BOTH VOCABULARIES.
//
// The two namespaces are matched by the same normalize(), so an asset called
// "Form and Confirmation Page" and a template called "Form & Confirmation Page"
// are one string as far as a brief is concerned. There is no right answer to
// which one the brief meant — they are different deliverables — and picking one
// silently is the failure mode this whole rework exists to remove: copy landing
// in a document nobody asked for.
//
// So it refuses, naming BOTH, before the model is asked anything. Postgres
// enforces uniqueness WITHIN each namespace (asset_types and doc_templates each
// have a unique index folded through the same normalizer); this is the one check
// that has to span them, because no index can.
function assertNoNameCollision(assetNames, templateNames) {
  const assets = new Map((assetNames || []).map((n) => [normalize(n), n]));
  const clashes = [];
  for (const t of templateNames || []) {
    const hit = assets.get(normalize(t));
    if (hit) clashes.push({ asset: hit, template: t });
  }
  if (clashes.length === 0) return;
  const detail = clashes
    .map((c) => `"${c.template}" (a document template) and "${c.asset}" (an asset type)`)
    .join('; ');
  throw new Error(
    `Two things in this workspace answer to the same name: ${detail}. ` +
      'A brief naming it could mean either, and they are different deliverables — ' +
      'rename one of them in Settings, then run the brief again.'
  );
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
  const templateVocabulary = await resolveTemplateVocabulary(tenantId);
  // STOP rather than parse a brief against a vocabulary we know is incomplete.
  // Proceeding would refuse a named template as an unknown asset and tell the
  // user to add it to their asset library — advice that is wrong now and would
  // trip the collision check forever if followed.
  if (templateVocabulary.unavailable) {
    throw new Error(
      "Couldn't read this workspace's document templates just now, so a brief naming one " +
        'would be misread as asking for an asset that does not exist. Nothing was built — try again in a moment.'
    );
  }
  // THE COLLISION CHECK, before either list reaches the model. See
  // assertNoNameCollision — a name in both vocabularies has no right answer.
  assertNoNameCollision(vocabulary.names, templateVocabulary.names);
  console.log(
    `[pipeline] parse vocabulary: ${vocabulary.names.length} asset name(s) from ${
      vocabulary.source === 'tenant' ? "the tenant's library" : 'the bundled default list'
    }` + (templateVocabulary.names.length ? `, plus ${templateVocabulary.names.length} document template(s)` : '')
  );
  const parsed = await geminiParseBrief(briefText, vocabulary.names, templateVocabulary.names);
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
      // Has the tenant set their OWN number on this house default? Changes the
      // tier line's wording only — an untouched one invites them to Settings,
      // one they have already set says it is theirs. getTenantAssets computes it
      // from the three override columns; false everywhere the columns are absent.
      specOverridden: f.spec_overridden === true,
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
function tenantAssetsToSpecs(rows, assetsOrPlan = [], limits, opts = {}) {
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
  //
  // UNLESS A TEMPLATE WAS NAMED. `assets: []` used to have exactly one meaning —
  // "a vague brief, give me everything" — and both adapters deliberately let it
  // through to the whole library. Since a brief can name a template it has two,
  // and they want opposite things: "build the form and confirmation matrix" is
  // not a vague brief, it is a precise one that asked for a single document. The
  // fallback fired anyway and produced a copy doc holding every asset type the
  // tenant owns, none of them requested.
  //
  // The caller passes wholeLibraryOnEmpty:false when the brief named a template,
  // which is the only thing that can tell the two meanings apart.
  //
  // NO BRIEF REACHES THE WHOLE-LIBRARY BRANCH ANY MORE, and the comment above
  // describes how it used to be entered rather than how it is now. An empty plan
  // with no template stops at the asset picker on both surfaces
  // (pendingBriefs.planNeedsAssetPick), and a picker submission with nothing
  // ticked is refused, so generateDoc is never handed an empty plan by the brief
  // flow at all.
  //
  // KEPT ANYWAY, as a defensive default rather than a feature: it is the sane
  // answer for any future caller that reaches generateDoc without going through a
  // picker, and deleting it would turn that caller's mistake into an empty
  // document instead of a full one. Do not read its survival as evidence that the
  // picker is optional.
  const wholeLibraryOnEmpty = opts.wholeLibraryOnEmpty !== false;
  if (plan.length === 0 && !wholeLibraryOnEmpty) return [];
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
// NAME A TEMPLATE, GET THE DOCUMENT (rework step four).
//
// Resolve the template plan parseBrief produced into the rows the build path
// needs, refusing by name rather than silently narrowing.
//
// THE OLD SHAPE IS GONE. partitionSpecsByTemplate used to sort the expanded
// asset specs into "copy doc" and "template" piles using an asset->template
// attachment, and templateValuesFor pulled the copy back out of those specs.
// Both are deleted. They existed because a template was reached THROUGH an asset
// type, which is what put form and confirmation copy in the copy doc AND the
// matrix — one ask, two deliverables, neither of them what was wanted.
//
// A template is now its own ask with its own fields (template_markers), drafted
// directly into its own cells. Nothing about it passes through the asset library.
//
// Returns { groups, refused } — refused entries carry a reason, and every one of
// them is reported rather than dropped.
function resolveTemplatePlan(templatePlan, byNorm) {
  const groups = [];
  const refused = [];
  const seen = new Set();
  for (const entry of Array.isArray(templatePlan) ? templatePlan : []) {
    const name = String((entry && (entry.template || entry.name)) || '').trim();
    if (!name) continue;
    const key = normalize(name);
    const tpl = byNorm instanceof Map ? byNorm.get(key) : null;
    if (!tpl) {
      refused.push({ name, reason: 'this workspace has no document template with that name' });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    // KNOWN LIMIT, REFUSED BY NAME RATHER THAN QUIETLY HONOURED. projects
    // carries ONE template_doc_id/url pair, so a second copy of one template has
    // nowhere to be recorded — it would be built, linked on the surfaces, and
    // then vanish from the project row. That is when a join table stops being
    // premature, and it is not this commit. Until then: say so.
    const requested = Number(entry && entry.requestedCount) || 1;
    if (requested > 1) {
      refused.push({
        name: tpl.name,
        reason: `a document template can only be asked for once per brief (this brief asked for ${requested}). ` +
          'A project row records one template document, so a second copy could be built but not tracked.',
      });
      continue;
    }
    groups.push({ templateId: String(tpl.id), templateName: tpl.name });
  }
  return { groups, refused };
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
  // TEMPLATES ARE RESOLVED FIRST, because whether one was named decides what an
  // EMPTY asset plan means — see tenantAssetsToSpecs.
  const templateVocab = await resolveTemplateVocabulary(tenantId);
  const { groups: templateGroups, refused: refusedTemplates } = templateVocab.unavailable
    // The parse already succeeded, so a template WAS resolvable a moment ago.
    // Refusing by name here beats resolveTemplatePlan's "no template with that
    // name", which would blame the brief for a database blip.
    ? {
      groups: [],
      refused: (spec.templates || []).map((t) => ({
        name: (t && (t.template || t.name)) || 'a document template',
        reason: "this workspace's document templates could not be read just now — the copy doc was built, the template document was not",
      })),
    }
    : resolveTemplatePlan(spec.templates, templateVocab.byNorm);
  for (const r of refusedTemplates) console.warn(`[pipeline] not building template "${r.name}": ${r.reason}`);
  if (templateGroups.length) {
    console.log(`[pipeline] ${templateGroups.length} document template(s) named: ${templateGroups.map((g) => g.templateName).join(', ')}`);
  }

  // `spec.assets` is an asset PLAN: a bare string[] (each name once) or entries of
  // { asset, count }. Expanded in request order; throws on an unmatched name.
  const assetSpecs = tenantAssetsToSpecs(tenantAssets, spec.assets, assetLimits, {
    // A brief that named a template and no assets asked for exactly one thing.
    wholeLibraryOnEmpty: templateGroups.length === 0,
  });
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

  // EVERY ASSET GOES IN THE COPY DOC. There is no partition any more: the copy
  // doc holds the copy assets, full stop. A document template is a separate ask
  // with separate fields, resolved above from what the brief NAMED.
  const copyDocSpecs = assetSpecs;

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
    // SAME GUARD AS THE TWO DOCUMENT PATHS, different URL shape — a folder is
    // /drive/folders/<id>, not /document/d/<id>/edit.
    //
    // It matters MORE here than it does for a document. saveProject writes
    // `drive_folder_id: projectFolderUrl ? docFolderId : null`, so a missing
    // webViewLink discarded the folder's ID as well as its link: the folder
    // existed, held the campaign's documents, and the project row recorded
    // nothing about it — with no id left to reconstruct the link from. It was
    // also indistinguishable in the data from a folder creation that genuinely
    // threw, which lands both columns null too.
    projectFolderUrl = folder.data.webViewLink || `https://drive.google.com/drive/folders/${docFolderId}`;
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
      // STRUCTURE ONLY. The copy doc is built as field labels with a blank line
      // under each and gets its words on Generate First Draft; the matrix is now
      // copied with every {{marker}} standing and gets its words on the same
      // press. Same seam, one button, and a regenerate reaches both because they
      // are one path rather than one calling the other.
      const built = await copyTemplateDocument({
        tenantId,
        templateId: group.templateId,
        folderId: docFolderId,
        clients,
        spec: { campaignTitle: spec.campaignTitle },
      });
      templateDocs.push({
        id: built.docId,
        url: built.docUrl,
        title: built.title,
        templateId: group.templateId,
        templateName: group.templateName,
        summary: built.summary,
      });
    } catch (err) {
      // BEST-EFFORT, as before. The copy doc is the project's primary artifact —
      // idempotency keys on copy_doc_id, both surfaces link to it, review runs
      // against it. A matrix that fails to build must not take the brief down.
      console.error(`[pipeline] template document "${group.templateName}" failed:`, err.message);
      templateDocs.push({ templateId: group.templateId, templateName: group.templateName, error: err.message });
    }
  }
  for (const r of refusedTemplates) {
    templateDocs.push({ templateName: r.name, error: r.reason, refused: true });
  }

  // Build the doc in parallel with the Assets subfolder.
  //
  // `copyDocSpecs` is every spec. It stays a distinct name from `assetSpecs` so
  // a future rule that does hold something back has one place to change.
  // NO ASSETS AND A TEMPLATE = ONE DOCUMENT. A copy doc with no asset groups is a
  // header and nothing else — a second file in the folder that says nothing, with
  // a "Generate First Draft" button that has no fields to draft. The brief asked
  // for one thing; it gets one thing.
  //
  // Only when a template WAS built. An empty plan with no template still falls
  // through to the whole library above, so a vague brief is untouched.
  const copyDocSkipped = copyDocSpecs.length === 0 && templateDocs.some((t) => t.id);
  if (copyDocSkipped) {
    console.log('[pipeline] no assets were requested and a template was — skipping the copy doc');
  }
  const doc = copyDocSkipped ? null : await getDestination().createDocument({
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
      // Null on a template-only brief. saveProject skips its idempotency probe
      // when there is no copy doc, so the row still lands.
      copy_doc_id: doc ? doc.id : null,
      copy_doc_url: doc ? doc.url : null,
      // The FIRST template document, if any. A named pair, not a join table —
      // see scripts/migrateAddProjectTemplateDoc.js for why, and for what
      // happens when a brief produces more than one.
      template_doc_id: (templateDocs.find((t) => t.id) || {}).id || null,
      template_doc_url: (templateDocs.find((t) => t.id) || {}).url || null,
      // WHICH template it came from, and the brief's own words — the two things
      // the draft path needs and could not otherwise know. Without the first it
      // cannot read template_markers; without the second it would have to read
      // the campaign context out of the copy doc, which is the coupling
      // syncTemplateDocuments was deleted for, and which a template-only brief
      // has no copy doc to provide.
      doc_template_id: (templateDocs.find((t) => t.id) || {}).templateId || null,
      brief_summary: spec.summary || null,
      brief_writer_prompt: spec.writerPrompt || null,
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

  // The copy doc remains the project's primary artifact: db/projects keys
  // idempotency on copy_doc_id, both surfaces link to it, copy review runs
  // against it, and drafting happens in it. A template document is a second,
  // independent deliverable — already drafted, because its fields are its own.
  return { doc, assetSpecs, copyDocSpecs, templateDocs, refusedTemplates, copyDocSkipped, projectFolderUrl, projectId };
}

// A DOCUMENT TEMPLATE IS BUILT IN TWO HALVES, ON TWO DIFFERENT PATHS.
//
// Step two did both in one call, which was right for step two: it had to prove
// the coordinate geometry end to end, and doing that in one function made the
// proof readable. It is the wrong SHIPPED shape.
//
// The copy doc builds as STRUCTURE at brief time and gets its words when
// somebody presses Generate First Draft. A matrix that drafted at brief time was
// therefore finished before the copy doc had started, and — the part that
// actually hurt — a regenerate with direction went down the draft path, reached
// the copy doc, and could not reach the matrix. The writer was told the draft
// had been regenerated when half the deliverable had not been.
//
// The fix is NOT to make the draft path call the matrix as a second step. That
// is what syncTemplateDocuments was, and it is deleted: it coupled the two
// documents so that the matrix was a function of the copy doc's content. This
// splits the template's OWN work along the same seam the copy doc's work is
// already split along, so one button drafts both because they are one path, and
// a regenerate reaches both for the same reason.
//
// A TEMPLATE IS CONFIRMED when it has template_markers rows. Without them there
// are no coordinates and nothing can be placed, so both halves refuse rather
// than falling back to a marker-name match — the whole point of the rework is
// that the position IS the mapping.

// HALF ONE, AT BRIEF TIME: copy it into the campaign folder and stop.
//
// getDestination().createFromTemplate with no values and no markers is the same
// drive.files.copy the template import uses; passing nothing to fill means it
// copies and sends no batchUpdate, so every {{marker}} is still standing. That
// is the structural equivalent of the copy doc's field labels with a blank line
// under each: the shape is there, the words are not.
//
// Returns { docId, docUrl, title, templateName, markers, copyMarkers }.
async function copyTemplateDocument({ tenantId, templateId, spec = {}, folderId = null, clients }) {
  if (!tenantId || !templateId) throw new Error('copyTemplateDocument: tenantId and templateId are required.');

  const template = await getDocTemplate(tenantId, templateId);
  if (!template) throw new Error(`No template ${templateId} for this tenant.`);
  if (!template.source_doc_id) throw new Error(`Template "${template.name}" has no imported document to copy.`);

  // The confirm state is checked HERE, not only at draft time, so a template
  // nobody has confirmed fails before a file exists in the tenant's Drive
  // rather than after.
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

  const copied = await getDestination().createFromTemplate({
    sourceDocId: template.source_doc_id,
    // NAMING: "<Campaign> — <Template>". The campaign first because the folder
    // holds one project's documents and they sort together; the template name
    // second because that is what the tenant called it.
    name: `${spec.campaignTitle || 'Untitled Campaign'} — ${template.name}`,
    folderId,
    values: new Map(),
    markers: [],
    clients,
  });

  console.log(
    `[pipeline] template "${template.name}" copied as structure — ${markers.length} marker(s), ` +
      `${copyMarkers.length} to draft when the draft runs, ${markers.length - copyMarkers.length} left as metadata`
  );

  return {
    docId: copied.id,
    docUrl: copied.url,
    title: copied.title,
    templateName: template.name,
    markers: markers.length,
    copyMarkers: copyMarkers.length,
  };
}

// HALF TWO, ON THE DRAFT PATH: draft the copy markers and write the cells.
//
// IT NEVER READS THE COPY DOC. That is the whole distinction from
// syncTemplateDocuments, which read the copy doc's drafted content and pushed it
// across — making the matrix a rendering of the other document. A template's
// fields are its own: they come from template_markers, they are drafted by the
// same batched Gemini call the copy doc's assets use, and they are written by
// coordinate. The two documents share a campaign and a button, and nothing else.
//
// THE WRITE IS UNCHANGED AND MUST STAY SO: one batchUpdate, reverse document
// order, delete range [cellStart, cellEnd - 1), coordinates from
// template_markers, is_copy=false cells never located and never touched. Not a
// line of writeTemplateCells or templateCells moved for this.
//
// Returns { docId, templateName, drafted, summary, accounted, ...writeResult }.
async function draftTemplateDocument({ tenantId, templateId, docId, spec = {}, direction, clients }) {
  if (!tenantId || !templateId || !docId) {
    throw new Error('draftTemplateDocument: tenantId, templateId and docId are required.');
  }

  const template = await getDocTemplate(tenantId, templateId);
  if (!template) throw new Error(`No template ${templateId} for this tenant.`);

  const markers = await listTemplateMarkers(tenantId, templateId);
  if (markers === null) {
    throw new Error('Template fields are not available — run scripts/migrateAddTemplateMarkers.js.');
  }
  const copyMarkers = (markers || []).filter((m) => m.is_copy);
  if (copyMarkers.length === 0) {
    throw new Error(`Template "${template.name}" has no markers ticked as copy, so there is nothing to draft.`);
  }

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
  // A draft the drafter marked `unenforced` is copy whose limit was never
  // enforced. It IS written — it is real copy — so it counts as drafted, and
  // that is exactly why it has to be named rather than left to look clean.
  const unenforced = [];
  for (const d of drafts || []) {
    const key = byName.get(String(d.fieldName || '').trim().toLowerCase());
    if (!key) continue;
    if (typeof d.copy === 'string' && d.copy.trim()) {
      values.set(key, d.copy.trim());
      if (d.unenforced) unenforced.push(d.fieldName);
    }
  }

  // Only the COPY markers are handed over. A metadata marker is never located
  // and never written — its cell is the tenant's, and leaving {{Form ID}}
  // standing is the correct outcome, not an omission.
  const result = await getDestination().writeTemplateCells(docId, { markers: copyMarkers, values }, clients);

  // ONE LINE FOR ALL THREE OUTCOMES. A copy marker ends up in exactly one of
  // them, and a marker that was placed but drafted nothing keeps its {{marker}} —
  // which in the finished document looks identical to one that was never meant
  // to be written.
  const summary =
    `${copyMarkers.length} copy marker${copyMarkers.length === 1 ? '' : 's'}: ` +
    `${result.written.length} drafted, ${result.skipped.length} left as {{marker}}, ` +
    `${result.missing.length} unplaced` +
    (unenforced.length ? ` (${unenforced.length} of the drafted are OVER LIMIT — the rescue failed)` : '');
  console.log(`[pipeline] ${summary}`);
  const accounted = result.written.length + result.skipped.length + result.missing.length;
  if (accounted !== copyMarkers.length) {
    console.warn(
      `[pipeline] template summary does not account for every copy marker: ` +
        `${accounted} of ${copyMarkers.length}`
    );
  }

  return {
    docId,
    templateName: template.name,
    markers: markers.length,
    copyMarkers: copyMarkers.length,
    drafted: values.size,
    unenforced,
    summary,
    accounted: accounted === copyMarkers.length,
    ...result,
  };
}

// BOTH HALVES, BACK TO BACK — the shape step two shipped.
//
// Kept because scripts/buildTemplateDoc.js is the by-hand entry point for
// building one template without a brief, and there is no reason for a person
// running that to press two buttons. Nothing on the brief path calls this:
// generateDoc copies, generateDraft drafts.
async function buildTemplateDocument({ tenantId, templateId, spec = {}, folderId = null, clients, direction }) {
  const copied = await copyTemplateDocument({ tenantId, templateId, spec, folderId, clients });
  const drafted = await draftTemplateDocument({
    tenantId, templateId, docId: copied.docId, spec, direction, clients,
  });
  return { ...copied, ...drafted, docId: copied.docId, docUrl: copied.docUrl, title: copied.title };
}

// --- Step three: read a built template back, revise a cell, review it --------
//
// All three start from the same place — the stored coordinates resolved against
// the BUILT document (the copy in the campaign folder, never the source
// template). Step two proved the coordinate finds the cell; these prove it still
// finds it after the marker has been replaced by copy, which is the property the
// whole design rests on and the one that was only ever asserted.

// Load a template's markers, refusing the same two ways buildTemplateDocument
// does. Shared so read/regenerate/review cannot drift on what "confirmed" means.
async function loadTemplateMarkers(tenantId, templateId) {
  const template = await getDocTemplate(tenantId, templateId);
  if (!template) throw new Error(`No template ${templateId} for this tenant.`);

  const markers = await listTemplateMarkers(tenantId, templateId);
  if (markers === null) {
    throw new Error('Template fields are not available — run scripts/migrateAddTemplateMarkers.js.');
  }
  if (markers.length === 0) {
    throw new Error(`Template "${template.name}" has no confirmed fields yet. Confirm them in Settings first.`);
  }
  return { template, markers };
}

// PART 1 — READ BACK. Every marker with a stored coordinate, resolved against
// the built document, with what its cell holds right now.
//
// Reads ALL markers, not just the copy ones. A metadata cell still showing
// {{Form ID}} is the evidence that the build left it alone, and leaving it out
// of the report would hide the thing most worth confirming by eye.
async function readTemplateDocument({ tenantId, templateId, docId, clients }) {
  if (!tenantId || !templateId || !docId) {
    throw new Error('readTemplateDocument: tenantId, templateId and docId are required.');
  }
  const { template, markers } = await loadTemplateMarkers(tenantId, templateId);
  const { rows, missing, title } = await getDestination().readTemplateCells(docId, { markers }, clients);

  const copyRows = rows.filter((r) => r.is_copy);
  const summary =
    `${rows.length} of ${markers.length} marker(s) located: ` +
    `${copyRows.filter((r) => !r.showingMarker && !r.empty).length} holding copy, ` +
    `${rows.filter((r) => r.showingMarker).length} still showing a marker, ` +
    `${missing.length} unplaced`;
  console.log(`[pipeline] read "${template.name}" — ${summary}`);

  return { templateName: template.name, title, rows, missing, summary, markers: markers.length };
}

// PART 2 — REGENERATE named fields, in place.
//
// REPLACES, NEVER STACKS. The copy doc answers a regenerate with a numbered
// block of options under a "Riff N" divider, and that is right there — the field
// is a labelled run of paragraphs with room below it. A matrix cell has no room
// below it and no way to say "these three are alternatives": stacking would put
// three headlines in the cell a client reads as the headline. One cell, one
// answer. Nothing here builds variants or riff marks.
//
// The redraft carries the cell's CURRENT copy, so it is a revision. A regenerate
// that started from nothing would quietly re-decide the offer when it was asked
// to shorten a line.
//
// Refuses per field rather than in bulk: a run naming four fields, one of them a
// metadata cell, should revise the three and say exactly why the fourth was left
// alone. Refusing the whole run would make the caller guess which one was wrong.
async function regenerateTemplateFields({
  tenantId,
  templateId,
  docId,
  fieldNames,
  direction,
  spec = {},
  clients,
}) {
  const wanted = (Array.isArray(fieldNames) ? fieldNames : [fieldNames])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (wanted.length === 0) throw new Error('regenerateTemplateFields: name at least one field.');

  const { template, markers } = await loadTemplateMarkers(tenantId, templateId);
  const { rows, missing } = await getDestination().readTemplateCells(docId, { markers }, clients);

  // Matched on the marker name, folded for case and whitespace — the same
  // looseness sameLabel applies, because a person typing --regenerate "form
  // headline" means the field called "Form Headline".
  const fold = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const byName = new Map(markers.map((m) => [fold(m.marker_name), m]));
  const rowByKey = new Map(rows.map((r) => [r.marker_key, r]));
  const unplaced = new Set(missing.map((m) => fold(m.name)));

  const targets = [];
  const refused = [];
  for (const name of wanted) {
    const m = byName.get(fold(name));
    if (!m) {
      refused.push({ name, reason: `there is no field called "${name}" on template "${template.name}"` });
    } else if (!m.is_copy) {
      refused.push({
        name: m.marker_name,
        reason: 'this marker is not ticked as copy — its cell belongs to the tenant, and writing to it is exactly what the is_copy flag exists to prevent',
      });
    } else if (m.part == null || m.table_index == null || m.row_index == null || m.column_index == null) {
      refused.push({ name: m.marker_name, reason: 'no cell coordinate was recorded for this marker, so there is nowhere to write it' });
    } else if (!rowByKey.has(m.marker_key)) {
      const why = unplaced.has(fold(m.marker_name)) ? 'it could not be located in this document' : 'it is not in this document';
      refused.push({ name: m.marker_name, reason: `${why} — reported rather than written to a guessed cell` });
    } else {
      targets.push({ marker: m, row: rowByKey.get(m.marker_key) });
    }
  }

  for (const r of refused) console.warn(`[pipeline] refusing to regenerate ${r.name}: ${r.reason}`);
  if (targets.length === 0) return { templateName: template.name, regenerated: [], refused, unenforced: [], failed: [] };

  let voiceGuide = null;
  try {
    voiceGuide = await getVoiceGuide(tenantId);
  } catch (err) {
    console.warn('[pipeline] voice guide lookup failed — using repo voice.md:', err.message);
  }

  // The other copy cells, as context, so a revised field still sits with the
  // ones around it. Same role siblings play on the copy doc's scoped path.
  const siblings = rows
    .filter((r) => r.is_copy && !r.showingMarker && !r.empty)
    .map((r) => ({ fieldName: r.marker_name, copy: r.text }));

  const values = new Map();
  const regenerated = [];
  const unenforced = [];
  const failed = [];
  for (const t of targets) {
    const m = t.marker;
    try {
      const copy = await generateFieldDraft({
        assetType: template.name,
        fieldName: m.marker_name,
        charMax: m.char_max || 0,
        charMin: m.char_min || 0,
        fieldType: m.field_type === 'words' ? 'words' : 'text',
        notes: m.spec_note || '',
        summary: spec.summary || '',
        writerPrompt: spec.writerPrompt || '',
        direction: direction || '',
        voiceGuide,
        siblings: siblings.filter((s) => s.fieldName !== m.marker_name),
        currentCopy: t.row.text,
      });
      if (!copy || !copy.trim()) {
        failed.push({ name: m.marker_name, reason: 'the redraft came back empty — the cell is unchanged' });
        continue;
      }
      values.set(m.marker_key, copy.trim());
      regenerated.push({ name: m.marker_name, before: t.row.text, after: copy.trim() });
      // Same reporting rule as the drafter: a word field has no post-hoc trim, so
      // a redraft can come back over and nothing will shorten it. Say so.
      if (overLimit(copy, m.char_max, m.field_type)) unenforced.push(m.marker_name);
    } catch (err) {
      failed.push({ name: m.marker_name, reason: err.message });
      console.warn(`[pipeline] regenerate failed for ${m.marker_name}: ${err.message}`);
    }
  }

  // The SAME write step two uses: one batchUpdate, reverse document order, the
  // delete range stopping one character short of the paragraph mark. Only the
  // regenerated markers are handed over, so no other cell is touched.
  let result = { written: [], skipped: [], healed: [], missing: [], requests: 0 };
  if (values.size) {
    result = await getDestination().writeTemplateCells(
      docId,
      { markers: targets.map((t) => t.marker), values },
      clients
    );
  }

  const summary =
    `${wanted.length} named: ${result.written.length} rewritten, ${refused.length} refused, ${failed.length} failed` +
    (unenforced.length ? ` (${unenforced.length} OVER LIMIT — a word field has no post-hoc trim)` : '');
  console.log(`[pipeline] regenerate "${template.name}" — ${summary}`);

  return { templateName: template.name, regenerated, refused, failed, unenforced, summary, ...result };
}

// PART 3 — REVIEW. Unanchored comments naming their field, for cells that are
// measurably wrong. The judgement lives in services/templateReview.js; this only
// gets it the rows.
async function reviewTemplateDocument({ tenantId, templateId, docId, clients }) {
  const read = await readTemplateDocument({ tenantId, templateId, docId, clients });
  const result = await postTemplateReview(docId, read.rows, clients);
  return { ...result, templateName: read.templateName, rows: read.rows, missing: read.missing };
}

// Draft copy for every field of an existing doc. An optional `direction` string
// is passed through as user revision feedback (the "Regenerate" path). Optional
// `clients` runs the Docs read/write as a specific tenant's OAuth user. Optional
// `tenantId` selects that tenant's saved voice guide (Postgres) for the prompt,
// falling back to the repo voice.md when there's no DB / no saved guide, and
// supplies the asset-level creative direction lookup for the drafter.
// Returns { title, fieldCount, url }.
// TEMPLATE-ONLY: the button carries the TEMPLATE document's id, because there is
// no copy doc for it to carry. Returns the project when docId names a project's
// template document AND that project has no copy doc — the one case where the
// copy-doc half of this function has nothing to do.
async function templateOnlyProject(docId, tenantId) {
  if (!docId || !tenantId) return null;
  try {
    const p = await getProjectByAnyDocId(tenantId, docId);
    if (p && !p.copy_doc_id && p.template_doc_id === docId) return p;
  } catch (err) {
    console.warn('[pipeline] template-only lookup failed:', err.message);
  }
  return null;
}

async function generateDraft(docId, direction, clients, tenantId, scopedFields, append) {
  // A TEMPLATE-ONLY BRIEF REACHES THE DRAFT PATH THROUGH THE SAME DOOR. Its
  // button carries the matrix's id, and there is no copy doc to parse — so the
  // copy-doc half is skipped and the template half runs, rather than the whole
  // press being unavailable. The alternative was a card with no buttons on a
  // document that had never been drafted, which is what shipped before this.
  const templateOnly = await templateOnlyProject(docId, tenantId);
  if (templateOnly) {
    console.log(`[pipeline] draft: project ${templateOnly.id} is template-only — drafting the matrix alone`);
    const out = await draftProjectTemplate({ docId, tenantId, direction, clients });
    return {
      title: templateOnly.name || 'Template document',
      fieldCount: (out && out.written && out.written.length) || 0,
      url: templateOnly.template_doc_url || null,
      templateDraft: out,
      templateOnly: true,
    };
  }

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

  // AND THE MATRIX, ON THIS SAME PATH.
  //
  // NOT syncTemplateDocuments coming back. That read the copy doc's drafted
  // content and pushed it into the matrix, which made one document a rendering
  // of the other; delete it and the coupling goes with it. This drafts the
  // template's OWN fields — template_markers, the same batched Gemini call, the
  // write by coordinate — and reads the copy doc never. The two documents share
  // a campaign and this function, and nothing else.
  //
  // HOOKED HERE, and not in the adapters, because this is the ONE function both
  // surfaces call for every kind of draft: a first draft, a scoped draft, a
  // regeneration, a riff. `direction` is whatever the writer typed, so a
  // regenerate reaches both documents for the only reason worth relying on —
  // they are one path.
  //
  // BEST-EFFORT. A draft that succeeded must not fail because a matrix could
  // not be written: the copy is in the copy doc, which is the writer's working
  // surface. Failures are returned, never thrown.
  const templateDraft = await draftProjectTemplate({ docId, tenantId, direction, clients });
  return templateDraft ? { ...result, templateDraft } : result;
}

// WHICH TEMPLATE a document id's project was built from, and the brief context
// to draft it with. ONE resolver, because drafting, regenerating, reading back
// and reviewing a project's template document all have to agree about it — and
// each of them is handed a document id and a tenant and nothing else.
//
// Returns null when there is nothing to resolve (no DB, no project row, no
// template document), `{ unlinked: true }` when the row predates the link
// column, else the template id + the brief's own words.
async function resolveProjectTemplate(docId, tenantId) {
  if (!docId || !tenantId) return null;

  let project = null;
  try {
    // BY EITHER DOCUMENT. On a mixed brief `docId` is the copy doc; on a
    // template-only brief the button carries the matrix's id, because that is
    // the only document there is. getProjectByDocId matches copy_doc_id alone
    // and would return null for the second — silently, which is exactly how a
    // template-only brief ended up with a document nobody could draft.
    project = await getProjectByAnyDocId(tenantId, docId);
  } catch (err) {
    console.warn('[pipeline] template lookup failed:', err.message);
    return null;
  }
  if (!project || !project.template_doc_id) return null;
  if (!project.doc_template_id) {
    // The row predates scripts/migrateAddProjectTemplateDraft.js, or the column
    // is not there yet. Said once, plainly: the matrix exists and cannot be
    // drafted, which is a thing to fix rather than a thing to be silent about.
    console.warn(
      `[pipeline] project ${project.id} has a template document but no doc_template_id — ` +
        'run scripts/migrateAddProjectTemplateDraft.js; the matrix cannot be drafted until then'
    );
    return { project, unlinked: true, templateDocId: project.template_doc_id, templateDocUrl: project.template_doc_url || null };
  }

  return {
    project,
    templateId: String(project.doc_template_id),
    templateDocId: project.template_doc_id,
    templateDocUrl: project.template_doc_url || null,
    // The brief's own words, off the project row. The copy doc is not read.
    spec: { summary: project.brief_summary || '', writerPrompt: project.brief_writer_prompt || '' },
  };
}

// Draft this project's template document, if it has one.
//
// Returns null when there is nothing to do — no DB, no project row, no template
// document, or the columns the link needs are not there yet. That is the
// overwhelmingly common case, so an ordinary brief pays one indexed lookup.
//
// A SCOPED DRAFT OF THE COPY DOC STILL REDRAFTS THE MATRIX WHOLE. That call
// targets named fields of the COPY doc; the matrix has no such notion of them,
// and its own fields have not changed, so it is redrafted entire. One batched
// Gemini call and one batchUpdate is cheaper than the machinery to decide it
// could be skipped, and it keeps "the button drafts both" true without an
// exception.
//
// `fieldNames` is the different thing: markers of THIS document, named by its
// own screen, redrafted through the step-three regenerate path — the same door
// the by-hand runner uses. Absent → the whole document. Nothing else differs;
// both write through writeTemplateCells, in one batchUpdate, at the stored
// coordinates.
async function draftProjectTemplate({ docId, tenantId, direction, clients, fieldNames }) {
  const link = await resolveProjectTemplate(docId, tenantId);
  if (!link) return null;
  if (link.unlinked) {
    return { error: 'this project predates the template-draft link', templateDocId: link.templateDocId };
  }

  const scoped = (Array.isArray(fieldNames) ? fieldNames : []).filter((n) => String(n || '').trim());
  try {
    const out = scoped.length
      ? await regenerateTemplateFields({
          tenantId,
          templateId: link.templateId,
          docId: link.templateDocId,
          fieldNames: scoped,
          direction,
          clients,
          spec: link.spec,
        })
      : await draftTemplateDocument({
          tenantId,
          templateId: link.templateId,
          docId: link.templateDocId,
          direction,
          clients,
          spec: link.spec,
        });
    return { templateDocId: link.templateDocId, templateDocUrl: link.templateDocUrl, ...out };
  } catch (err) {
    console.error('[pipeline] template draft failed (the copy doc draft is unaffected):', err.message);
    return { templateDocId: link.templateDocId, error: err.message };
  }
}

// A PROJECT's template document, in the shape the detail view renders. The web
// surface knows a document id and a tenant; it never learns a template id, so
// the resolution lives here rather than in the adapter.
async function getProjectTemplateContent({ docId, tenantId, clients }) {
  const link = await resolveProjectTemplate(docId, tenantId);
  if (!link) throw new Error('There is no template document on this project.');
  if (link.unlinked) {
    throw new Error(
      'This project predates the template-draft link — run scripts/migrateAddProjectTemplateDraft.js.'
    );
  }
  return getTemplateContent({
    tenantId,
    templateId: link.templateId,
    docId: link.templateDocId,
    clients,
  });
}

// A PROJECT's template document, reviewed. Same resolution, then the step-three
// unanchored-comment path — and the result reshaped into the { hadCopy, status,
// digest } the review overlay already speaks, so the template document's Review
// button behaves exactly like the copy doc's.
//
// The counts are of MARKERS, not of notes: "3 fields: 2 clean, 1 with a note"
// reads the same way copy review's digest does. A cell that is still showing its
// {{marker}} has nothing to review, which is `hadCopy: false` — the overlay then
// says "generate a draft first" instead of "all clean", which would be a lie.
async function reviewProjectTemplate({ docId, tenantId, clients }) {
  const link = await resolveProjectTemplate(docId, tenantId);
  if (!link) throw new Error('There is no template document on this project.');
  if (link.unlinked) {
    throw new Error(
      'This project predates the template-draft link — run scripts/migrateAddProjectTemplateDraft.js.'
    );
  }
  const out = await reviewTemplateDocument({
    tenantId,
    templateId: link.templateId,
    docId: link.templateDocId,
    clients,
  });

  const copyRows = (out.rows || []).filter((r) => r.is_copy && !r.showingMarker && String(r.text || '').trim());
  const flaggedNames = new Set((out.notes || []).map((n) => n.marker_name));
  const reviewed = copyRows.length;
  const flagged = copyRows.filter((r) => flaggedNames.has(r.marker_name)).length;
  const clean = reviewed - flagged;

  let status;
  let digest;
  if (reviewed === 0) {
    status = 'Nothing to review yet.';
    digest = 'No drafted copy to review yet.';
  } else if (flagged === 0) {
    status = 'Looking strong. ✨';
    digest = `Reviewed ${reviewed} field${reviewed === 1 ? '' : 's'} — all clean. Nothing to change.`;
  } else {
    const ratio = flagged / reviewed;
    status = ratio <= 0.25 ? 'A few things to tighten.' : ratio <= 0.6 ? 'Worth another pass.' : 'Some rework to do.';
    digest =
      `Reviewed ${reviewed} field${reviewed === 1 ? '' : 's'}: ${clean} clean, ${flagged} with a note ` +
      `on ${out.templateName}. Open the doc for the notes.`;
  }

  return {
    reviewed,
    flagged,
    clean,
    hadCopy: reviewed > 0,
    status,
    digest,
    templateName: out.templateName,
    templateDocUrl: link.templateDocUrl,
    posted: (out.posted || []).length,
    duplicates: (out.duplicates || []).length,
  };
}

// Read an existing doc into a structured, copy-bearing shape for the web
// project view. Optional `clients` runs the Docs read as a tenant's OAuth user.
// Returns { title, summary, writerDirection, assets: [...] }.
async function getProjectContent(docId, clients) {
  return getDestination().getDocContent(docId, clients);
}

// THE SAME SHAPE, FOR A TEMPLATE DOCUMENT.
//
// The web app renders a document as { title, summary, writerDirection, assets:
// [{ name, fields: [{ fieldName, charMin, charMax, fieldType, copy }] }] } —
// the shape getDocContent returns for the copy doc. A matrix has no assets and
// no sections, but it has exactly one thing that maps: itself, as one "asset"
// whose fields are its copy markers. Returning the shape the renderer already
// speaks means the detail view is the SAME renderer rather than a second one
// that will drift.
//
// READ THROUGH readTemplateDocument, which is the proven step-three path. There
// is no second reader here: this converts what that returns and adds nothing.
//
// ONLY is_copy MARKERS. A metadata cell is the tenant's — {{Form ID}} is theirs
// to fill and not Quillio's to offer as a drafting surface. It is in the
// document, it is visible when they open it, and it does not belong on a screen
// whose every affordance is "write this for me".
//
// A marker still showing its {{marker}} comes back with EMPTY copy, so the
// renderer draws its existing "Not yet drafted" state rather than printing the
// marker as though it were copy somebody wrote.
async function getTemplateContent({ tenantId, templateId, docId, clients }) {
  const read = await readTemplateDocument({ tenantId, templateId, docId, clients });
  const fields = read.rows
    .filter((r) => r.is_copy)
    .map((r) => ({
      fieldName: r.marker_name,
      charMin: r.char_min || 0,
      charMax: r.char_max || 0,
      fieldType: r.field_type === 'words' ? 'words' : 'text',
      copy: r.showingMarker ? '' : r.text,
      // Whether a riff could stack alternatives here — see
      // templateCells.hasRoomBelow. Carried per FIELD, so the surface asks the
      // marker rather than asking what kind of document it is in.
      roomBelow: r.roomBelow === true,
    }));

  return {
    title: read.title || read.templateName,
    // A matrix carries no campaign sections of its own — Campaign Summary and
    // Writer Direction are HEADING_2 sections of the copy doc, and this document
    // has neither. Empty rather than invented; `kind` lets the renderer leave
    // the two labels out entirely instead of drawing two em-dashes.
    summary: '',
    writerDirection: '',
    kind: 'template',
    assets: [{ name: read.templateName, fields }],
    // Carried so a caller can report what the read could not place.
    missing: read.missing,
    templateName: read.templateName,
  };
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
  getTemplateContent,
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
  // The named-template resolution (rework step four). Pure, so what a brief's
  // template plan turns into is assertable with no Google client and no DB.
  resolveTemplatePlan,
  resolveTemplateVocabulary,
  assertNoNameCollision,
  // The confirmed-template build path (rework step two). Reachable only from a
  // caller that already has a template id — parseBrief does not know templates
  // exist yet.
  buildTemplateDocument,
  // The two halves it is made of. generateDoc copies at brief time; generateDraft
  // drafts on the button, so one press reaches both documents.
  copyTemplateDocument,
  draftTemplateDocument,
  draftProjectTemplate,
  // Step three, same entry rule: a caller that already has a template id and a
  // built document. Read back by stored coordinate, revise one cell, review.
  readTemplateDocument,
  regenerateTemplateFields,
  reviewTemplateDocument,
  // …and the PROJECT-level wrappers the web surface uses. A surface knows a
  // document id and a tenant; resolveProjectTemplate is the one place that turns
  // those into a template id, so read / draft / regenerate / review on a
  // project's template document cannot disagree about which template it is.
  resolveProjectTemplate,
  getProjectTemplateContent,
  reviewProjectTemplate,
  normalizeAssetPlan,
  resolveAssetLimits,
  // The DEFAULT (web) ceilings, and the absolute maximum a surface can ask for.
  MAX_INSTANCES_PER_ASSET,
  MAX_TOTAL_INSTANCES,
  DEFAULT_ASSET_LIMITS,
};
