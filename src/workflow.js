'use strict';

const config = require('./config');
const { getClients } = require('./google');
const { parseBrief, enrichWithReferences } = require('./services/gemini');
const { getAssetSpecs } = require('./services/sheets');
const { getDestination } = require('./destinations');
const { postResult, updateMessage, postChatMessage, postFolderAccessHelp } = require('./services/slack');

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

  try {
    // 1. Parse the brief into title / summary / writerPrompt / assets (+ folder & links).
    const parsedBrief = await parseBrief(brief);
    const { campaignTitle, assets, unmatchedAssets, folderId, referenceLinks } = parsedBrief;
    let { summary, writerPrompt } = parsedBrief; // may be enriched below
    console.log('[workflow] Gemini parse OK — assets:', JSON.stringify(assets));
    console.log('[workflow] campaignTitle:', JSON.stringify(campaignTitle));
    console.log('[workflow] unmatchedAssets:', JSON.stringify(unmatchedAssets));
    console.log('[workflow] folderId:', folderId, '| referenceLinks:', JSON.stringify(referenceLinks));

    // Issue 2: all requested assets are unknown — don't substitute a nearest
    // guess; tell the user exactly what couldn't be matched. (A vague brief with
    // no assets at all still falls through to "all assets".)
    if (assets.length === 0 && unmatchedAssets.length > 0) {
      console.log('[workflow] no assets matched the library — surfacing unmatched list');
      await updateMessage(
        `Couldn't match these to your asset library: ${unmatchedAssets.join(
          ', '
        )}. Add them to your library or try different asset names.`,
        responseUrl,
        { label: 'unmatched-assets' }
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

    // Phase 2 (additive): read linked Drive files and enrich the summary /
    // writer direction with their content. Fully isolated — any failure leaves
    // the parsed brief unchanged and the rest of the pipeline untouched.
    try {
      const refDocs = await fetchDriveReferenceContent(referenceLinks);
      if (refDocs.length > 0) {
        const referenceContext = refDocs
          .map((r) => `\n\n--- Reference: ${r.title} ---\n${r.content}`)
          .join('');
        const enriched = await enrichWithReferences({ summary, writerPrompt }, referenceContext);
        summary = enriched.summary;
        writerPrompt = enriched.writerPrompt;
        console.log(`[Quillio] enriched brief from ${refDocs.length} reference file(s)`);
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
      });
    } catch (err) {
      if (isFolderAccessError(err, effectiveFolderId)) {
        console.log('[workflow] folder access error — offering recovery for', effectiveFolderId);
        const { serviceAccountEmail } = await getClients();
        await postFolderAccessHelp({
          email: serviceAccountEmail,
          folderId: effectiveFolderId,
          brief,
          responseUrl,
        });
        return;
      }
      throw err;
    }
    console.log('[workflow] doc created:', doc.id);

    // 4. Post the Block Kit result back to the channel the command came from
    //    (via response_url), falling back to the configured webhook.
    await postResult(
      {
        title: doc.title,
        webViewLink: doc.url,
        assets: assetSpecs.map((a) => a.assetType),
        docId: doc.id,
      },
      responseUrl
    );
    console.log('[workflow] runBriefWorkflow DONE — doc', doc.id);
  } catch (err) {
    console.error('[workflow] runBriefWorkflow FAILED:', err && err.stack ? err.stack : err);
    throw err;
  }
}

// Handles the "Generate First Draft" button. Updates the original message in
// place: first an immediate "working on it" so the tap feels responsive, then
// the final confirmation when the draft is done.
async function runGenerateDraft(docId, responseUrl, channelId) {
  console.log(
    '[workflow] runGenerateDraft START — response_url present:',
    !!responseUrl,
    '| channel:',
    channelId || '(none)'
  );

  // Progress: fire immediately on the response_url (well within its window).
  await updateMessage(
    ':quillio: Generating your first draft… this takes about 60 seconds.',
    responseUrl,
    { label: 'draft-progress' }
  );

  const { title, fieldCount, url } = await getDestination().generateDraft(docId);
  console.log('[workflow] generateDraft returned — posting completion message');

  const completionText = `:quillio-copy-done: First draft ready — *${title}* (${fieldCount} field${
    fieldCount === 1 ? '' : 's'
  } drafted).`;

  // Completion: post via chat.postMessage (no expiry) so it lands even after a
  // long (multi-asset) generation outlives the response_url. Fall back to a
  // fresh response_url message if the bot token / channel isn't available.
  try {
    await postChatMessage({ channel: channelId, text: completionText, webViewLink: url });
  } catch (err) {
    console.error(
      '[workflow] chat.postMessage completion failed, falling back to response_url:',
      err.message
    );
    await updateMessage(completionText, responseUrl, {
      webViewLink: url,
      label: 'draft-complete',
      newMessage: true,
    });
  }
  console.log('[workflow] runGenerateDraft DONE');
}

module.exports = { runBriefWorkflow, runGenerateDraft };
