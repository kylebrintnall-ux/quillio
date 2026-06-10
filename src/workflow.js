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

// Matches a Google Drive *file* link and captures its file id.
const DRIVE_FILE_RE = /(?:drive\.google\.com\/file\/d\/|docs\.google\.com\/document\/d\/)([a-zA-Z0-9_-]+)/;
const REF_CONTENT_MAX = 3000; // per-file char cap, protects the context window

// Phase 2 — read the plain-text content of Drive file links in the brief so the
// enrichment pass has real source material. Best-effort: any file that can't be
// read (permissions, unsupported type, network) is skipped silently. Uses the
// same Drive client as doc creation (OAuth user when configured, else the SA).
// Returns [{ url, fileId, title, content }].
async function fetchDriveReferenceContent(links) {
  if (!Array.isArray(links) || links.length === 0) return [];
  const { drive } = await getClients();
  const out = [];

  for (const url of links) {
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

      let content;
      if (mimeType === 'text/plain' || mimeType === 'application/json') {
        const res = await drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'text' }
        );
        content = String(res.data || '');
      } else {
        const res = await drive.files.export(
          { fileId, mimeType: 'text/plain' },
          { responseType: 'text' }
        );
        content = String(res.data || '');
      }

      out.push({ url, fileId, title, content: content.slice(0, REF_CONTENT_MAX) });
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
    // Skip .pdf URLs — fetchPDFContent handles those (avoid double-fetching).
    if (SKIP_EXTERNAL_RE.test(url) || !/^https?:\/\//i.test(url) || urlPathEndsPdf(url)) continue;

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
        try {
          title = new URL(url).hostname;
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

      let title = parsed.info && parsed.info.Title ? String(parsed.info.Title).trim() : '';
      if (!title) {
        try {
          const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
          title = last.replace(/\.pdf$/i, '');
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

    // Decide the target folder: forced default, explicit override, or the
    // brief's folder.
    const effectiveFolderId = opts.forceDefaultFolder
      ? null
      : opts.folderIdOverride !== undefined
        ? opts.folderIdOverride
        : folderId;

    // Phase 2 (additive): read linked Drive files AND external web pages, and
    // enrich the summary / writer direction with their content. Fully isolated —
    // any failure leaves the parsed brief unchanged and the pipeline untouched.
    try {
      const [refDocs, refExternal, refPdf] = await Promise.all([
        fetchDriveReferenceContent(referenceLinks),
        fetchExternalURLContent(referenceLinks),
        fetchPDFContent(referenceLinks),
      ]);
      const refs = [...refDocs, ...refExternal, ...refPdf];
      if (refs.length > 0) {
        const referenceContext = refs
          .map((r) => `\n\n--- Reference: ${r.title} ---\n${r.content}`)
          .join('');
        const enriched = await enrichWithReferences({ summary, writerPrompt }, referenceContext);
        summary = enriched.summary;
        writerPrompt = enriched.writerPrompt;
        referenceInsights = Array.isArray(enriched.referenceInsights) ? enriched.referenceInsights : [];
        console.log(
          `[Quillio] enriched brief from ${refDocs.length} Drive + ${refExternal.length} external + ${refPdf.length} PDF reference(s)`
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
    await emit(`:quillio-doc-done: Your doc is ready — ${doc.title}`, buildResultBlocks(result).blocks, () =>
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

  const progressText = ':quillio: Generating your first draft… this takes about 60 seconds.';
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
