'use strict';

const config = require('./config');
const { getClients } = require('./google');
const { parseBrief, enrichWithReferences } = require('./services/gemini');
const { getAssetSpecs } = require('./services/sheets');
const { getDestination } = require('./destinations');
const {
  postResult,
  updateMessage,
  postChatMessage,
  postFolderAccessHelp,
  buildFolderAccessBlocks,
  buildResultBlocks,
  openInDriveBlocks,
  postLive,
  updateLive,
} = require('./services/slack');

const BUILDING_TEXT = ':quillio-scroll: Building your document…';

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
          if (clean && !links.includes(clean)) {
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

async function fetchSlackCanvasContent(links) {
  if (!Array.isArray(links) || links.length === 0) return [];
  // Prefer the user token (reads what the authorizing user can see, including
  // user-owned canvases); fall back to the bot token when none is configured.
  const token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (!token) return [];
  const out = [];

  for (const raw of links) {
    const url = String(raw);
    if (!SLACK_CANVAS_RE.test(url)) continue;

    // Canvas id = the LAST path segment after /canvas/ or /docs/. A /docs/ URL
    // is /docs/TEAM_ID/CANVAS_ID, so the canvas id is always the final segment.
    const after = url.replace(/^.*\.slack\.com\/(?:canvas|docs)\//i, '');
    const canvasId = after.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
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

// The full 7s+ workflow. Runs AFTER Slack has been acknowledged — never call
// this before the slash command's 200 response has been sent. The entire body
// is wrapped so any failure surfaces in the logs with a full stack trace
// instead of dying silently; it re-throws so the caller can notify Slack.
//
// opts.forceDefaultFolder ignores the brief's folder (used by "Build in Default
// Folder"); opts.folderIdOverride pins a specific folder (used by "Retry").
async function runBriefWorkflow(brief, responseUrl, opts = {}) {
  // Confirms the pipeline is actually invoked after the ack (before any I/O).
  console.log('[workflow] runBriefWorkflow START — brief chars:', (brief || '').length);

  // Establish a single "live" message we transform in place (chat.update is the
  // only reliable way to do this). opts.live = {channel, ts} edits an existing
  // message (recovery buttons); opts.channelId posts a fresh building message.
  // If neither works (no bot token), fall back to response_url posts.
  let live = opts.live || null;
  const canLive = !!config.SLACK_BOT_TOKEN;
  try {
    if (live && canLive) {
      await updateLive(live.channel, live.ts, BUILDING_TEXT);
    } else if (opts.channelId && canLive) {
      live = await postLive(opts.channelId, BUILDING_TEXT);
    } else if (responseUrl) {
      await updateMessage(BUILDING_TEXT, responseUrl, { newMessage: true, label: 'build-progress' });
      live = null;
    }
  } catch (e) {
    console.error('[workflow] building message failed:', e.message);
  }

  // Give Slack ~500ms to render the "Building…" message before the pipeline
  // starts updating it in place — a fast pipeline (or a slow Slack API
  // response) can otherwise overwrite it before it visibly appears.
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Emit a final/early message: edit the live message in place when we have one,
  // otherwise fall back to a response_url post.
  const emit = async (text, blocks, fallback) => {
    if (live && canLive) return updateLive(live.channel, live.ts, text, blocks);
    return fallback();
  };

  try {
    // 1. Parse the brief into title / summary / writerPrompt / assets (+ folder & links).
    const parsedBrief = await parseBrief(brief);
    const { campaignTitle, assets, unmatchedAssets, folderId, referenceLinks } = parsedBrief;
    let { summary, writerPrompt } = parsedBrief; // may be enriched below
    let referenceInsights = []; // populated by enrichment, rendered in the doc
    console.log('[workflow] Gemini parse OK — assets:', JSON.stringify(assets));
    console.log('[workflow] campaignTitle:', JSON.stringify(campaignTitle));
    console.log('[workflow] unmatchedAssets:', JSON.stringify(unmatchedAssets));
    console.log('[workflow] folderId:', folderId, '| referenceLinks:', JSON.stringify(referenceLinks));

    // Issue 2: all requested assets are unknown — don't substitute a nearest
    // guess; tell the user exactly what couldn't be matched. (A vague brief with
    // no assets at all still falls through to "all assets".)
    if (assets.length === 0 && unmatchedAssets.length > 0) {
      console.log('[workflow] no assets matched the library — surfacing unmatched list');
      const unmatchedText = `Couldn't match these to your asset library: ${unmatchedAssets.join(
        ', '
      )}. Add them to your library or try different asset names.`;
      await emit(unmatchedText, undefined, () =>
        updateMessage(unmatchedText, responseUrl, { label: 'unmatched-assets' })
      );
      return;
    }

    // Extract a Drive folder URL straight from the brief text (deterministic
    // regex). If present, the doc is created there; otherwise the default folder.
    const briefFolderMatch = String(brief || '').match(DRIVE_FOLDER_RE);
    const briefFolderId = briefFolderMatch ? briefFolderMatch[1] : null;
    if (briefFolderId) {
      console.log('[workflow] folderId from brief:', briefFolderId);
    } else {
      console.log('[workflow] folderId: default (none in brief)');
    }

    // Decide the target folder: forced default, explicit override, or the
    // brief's folder (null → createDocument uses the default DRIVE_FOLDER_ID).
    const effectiveFolderId = opts.forceDefaultFolder
      ? null
      : opts.folderIdOverride !== undefined
        ? opts.folderIdOverride
        : briefFolderId;
    // Whether we're using a folder the brief linked (for the confirmation line).
    const folderFromBrief = !!effectiveFolderId && effectiveFolderId === briefFolderId;

    // Phase 2 (additive): read linked Drive files AND external web pages, and
    // enrich the summary / writer direction with their content. Fully isolated —
    // any failure leaves the parsed brief unchanged and the pipeline untouched.
    try {
      const [refDocs, refExternal, refPdf, refCanvas] = await Promise.all([
        fetchDriveReferenceContent(referenceLinks),
        fetchExternalURLContent(referenceLinks),
        fetchPDFContent(referenceLinks),
        fetchSlackCanvasContent(referenceLinks),
      ]);
      // Tag each reference with its true source type (the fetcher knows it;
      // Gemini only guesses). pdf/canvas already carry a type.
      const refs = [
        ...refDocs.map((r) => ({ ...r, type: r.type || 'drive' })),
        ...refExternal.map((r) => ({ ...r, type: 'external' })),
        ...refPdf,
        ...refCanvas,
      ];
      if (refs.length > 0) {
        const referenceContext = refs
          .map((r) => `\n\n--- Reference (${r.type}): ${r.title} ---\n${sanitizeText(r.content)}`)
          .join('');
        const enriched = await enrichWithReferences({ summary, writerPrompt }, referenceContext);
        summary = enriched.summary;
        writerPrompt = enriched.writerPrompt;
        const insights = Array.isArray(enriched.referenceInsights) ? enriched.referenceInsights : [];
        // Stamp the real source type onto each insight by matching it back to
        // its reference (by title), instead of trusting Gemini's guessed type.
        const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        referenceInsights = insights.map((ins) => {
          const src = norm(ins && ins.source);
          const match =
            refs.find((r) => norm(r.title) === src) ||
            (src && refs.find((r) => norm(r.title).includes(src) || src.includes(norm(r.title)))) ||
            (refs.length === 1 ? refs[0] : null);
          return match ? { ...ins, type: match.type } : ins;
        });
        console.log(
          `[Quillio] enriched brief from ${refDocs.length} Drive + ${refExternal.length} external + ${refPdf.length} PDF + ${refCanvas.length} canvas reference(s)`
        );
      }
    } catch (err) {
      console.error('[Quillio] reference enrichment skipped:', err.message);
    }

    // 2. Read + filter the asset specs. Log the Sheet ID so a permission/403 on
    //    the v2 Sheet is obvious in the logs.
    console.log('[workflow] reading Sheet', config.SHEET_ID, '…');
    const assetSpecs = await getAssetSpecs(assets);
    console.log(
      '[workflow] Sheet read OK —',
      assetSpecs.length,
      'asset group(s):',
      JSON.stringify(assetSpecs.map((a) => a.assetType))
    );

    // 3. Build the formatted document. If a brief-provided folder is
    //    inaccessible, surface the recoverable folder-access flow (Issue 3)
    //    instead of a dead-end error.
    let doc;
    try {
      doc = await getDestination().createDocument({
        brief,
        campaignTitle,
        summary,
        writerPrompt,
        assetSpecs,
        folderId: effectiveFolderId,
        referenceLinks,
        referenceInsights,
      });
    } catch (err) {
      if (isFolderAccessError(err, effectiveFolderId)) {
        console.log('[workflow] folder access error — offering recovery for', effectiveFolderId);
        const { serviceAccountEmail } = await getClients();
        const help = buildFolderAccessBlocks({
          email: serviceAccountEmail,
          folderId: effectiveFolderId,
          brief,
        });
        await emit(help.text, help.blocks, () =>
          postFolderAccessHelp({
            email: serviceAccountEmail,
            folderId: effectiveFolderId,
            brief,
            responseUrl,
          })
        );
        return;
      }
      throw err;
    }
    console.log('[workflow] doc created:', doc.id);

    // 4. Show the doc-ready card — editing the build message in place when we
    //    have a live message, else posting via response_url.
    const result = {
      title: doc.title,
      webViewLink: doc.url,
      assets: assetSpecs.map((a) => a.assetType),
      docId: doc.id,
    };
    const resultBlocks = buildResultBlocks(result).blocks;
    // If the doc went to a brief-linked folder, note it below the doc card.
    if (folderFromBrief) {
      let folderName = 'your linked folder';
      try {
        const { drive } = await getClients();
        const meta = await drive.files.get({
          fileId: effectiveFolderId,
          fields: 'name',
          supportsAllDrives: true,
        });
        if (meta.data && meta.data.name) folderName = meta.data.name;
      } catch (err) {
        console.warn('[workflow] folder name fetch failed:', err.message);
      }
      resultBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `📁 Saved to ${folderName}` },
      });
    }
    await emit(`:quillio-doc-done: Your doc is ready — ${doc.title}`, resultBlocks, () =>
      postResult(result, responseUrl)
    );
    console.log('[workflow] runBriefWorkflow DONE — doc', doc.id);
  } catch (err) {
    console.error('[workflow] runBriefWorkflow FAILED:', err && err.stack ? err.stack : err);
    throw err;
  }
}

// Handles the "Generate First Draft" button. Transforms the clicked card in
// place via chat.update: generating → first-draft-ready (single message, no
// stray posts). Falls back to response_url progress + chat.postMessage
// completion if the bot token / message ts isn't available.
async function runGenerateDraft(docId, responseUrl, channel, messageTs) {
  const canLive = !!config.SLACK_BOT_TOKEN && channel && messageTs;
  console.log('[workflow] runGenerateDraft START — canLive:', canLive, '| channel:', channel || '(none)');

  // Count the assets in the doc (one HEADING_3 heading per asset) so the
  // progress message can name how many are being drafted.
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

  const count = assetCount;
  let progressMsg;
  if (count <= 3) {
    progressMsg = `Drafting ${count} asset${count === 1 ? '' : 's'} — back in a minute.`;
  } else if (count <= 8) {
    progressMsg = `Drafting ${count} assets — usually 2–3 minutes. Hang tight.`;
  } else if (count <= 20) {
    progressMsg = `Drafting ${count} assets — this one's a big brief, give it 4–5 minutes.`;
  } else {
    progressMsg = `Drafting ${count} assets — full brief, grab a coffee. Back in ~5 minutes.`;
  }

  const progressText = `:quillio: ${progressMsg}`;
  if (canLive) await updateLive(channel, messageTs, progressText);
  else await updateMessage(progressText, responseUrl, { label: 'draft-progress' });

  const { title, fieldCount, url } = await getDestination().generateDraft(docId);
  console.log('[workflow] generateDraft returned — posting completion');

  const completionText = `:quillio-copy-done: First draft ready — *${title}* (${fieldCount} field${
    fieldCount === 1 ? '' : 's'
  } drafted).`;

  if (canLive) {
    await updateLive(channel, messageTs, completionText, openInDriveBlocks(completionText, url));
  } else {
    try {
      await postChatMessage({ channel, text: completionText, webViewLink: url });
    } catch (err) {
      console.error('[workflow] completion fallback to response_url:', err.message);
      await updateMessage(completionText, responseUrl, {
        webViewLink: url,
        label: 'draft-complete',
        newMessage: true,
      });
    }
  }
  console.log('[workflow] runGenerateDraft DONE');
}

module.exports = { runBriefWorkflow, runGenerateDraft };
