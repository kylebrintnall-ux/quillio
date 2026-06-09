'use strict';

const config = require('./config');
const { getClients } = require('./google');
const { parseBrief } = require('./services/gemini');
const { getAssetSpecs } = require('./services/sheets');
const { getDestination } = require('./destinations');
const { postResult, updateMessage, postChatMessage, postFolderAccessHelp } = require('./services/slack');

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
    const { campaignTitle, summary, writerPrompt, assets, unmatchedAssets, folderId, referenceLinks } =
      await parseBrief(brief);
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

  const completionText = `✓ First draft ready — *${title}* (${fieldCount} field${
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
