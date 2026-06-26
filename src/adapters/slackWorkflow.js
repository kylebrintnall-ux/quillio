'use strict';

// Slack adapter: owns the Slack message lifecycle and orchestrates the core
// pipeline. All platform-agnostic work lives in core/pipeline.js; this file is
// the only place that talks to Slack (via ../services/slack).

const pipeline = require('../core/pipeline');
const { resolveTenant } = require('../db');
const {
  postResult,
  updateMessage,
  postChatMessage,
  postFolderAccessHelp,
  buildFolderAccessBlocks,
  buildResultBlocks,
  copyCompleteBlocks,
  postLive,
  updateLive,
} = require('../services/slack');
const { emoji } = require('../emoji');

const BUILDING_TEXT = `${emoji('quillio-scroll')} Building your document…`;

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

  // Resolve this workspace's tenant tokens (DB-backed; env fallback for the
  // demo workspace). Token source changes; nothing else does.
  const { tenant, tokens, source } = await resolveTenant(opts.workspaceId);
  const tenantId = tenant && tenant.id;
  // Log the token SOURCE only (db = Postgres tenant_tokens, env = fallback) —
  // never the tokens themselves.
  console.log(
    `[workflow] tenant resolved — source: ${source} | tenantId: ${tenantId || '(none)'}`
  );

  // Establish a single "live" message we transform in place (chat.update is the
  // only reliable way to do this). opts.live = {channel, ts} edits an existing
  // message (recovery buttons); opts.channelId posts a fresh building message.
  // If neither works (no bot token), fall back to response_url posts.
  let live = opts.live || null;
  const canLive = !!tokens.slack_bot;
  try {
    if (live && canLive) {
      await updateLive(live.channel, live.ts, BUILDING_TEXT, undefined, tokens.slack_bot);
    } else if (opts.channelId && canLive) {
      live = await postLive(opts.channelId, BUILDING_TEXT, undefined, tokens.slack_bot);
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
    if (live && canLive) return updateLive(live.channel, live.ts, text, blocks, tokens.slack_bot);
    return fallback();
  };

  try {
    // 1. Parse the brief into title / summary / writerPrompt / assets (+ folder & links).
    const parsedBrief = await pipeline.parseBrief(brief);
    // NB: parsedBrief.folderId (Gemini's guess) is intentionally NOT used — it
    // can truncate a long id. Folder routing uses extractBriefFolderId below.
    const { campaignTitle, assets, unmatchedAssets, referenceLinks } = parsedBrief;
    let { summary, writerPrompt } = parsedBrief; // may be enriched below
    let referenceInsights = []; // populated by enrichment, rendered in the doc
    console.log('[workflow] Gemini parse OK — assets:', JSON.stringify(assets));
    console.log('[workflow] campaignTitle:', JSON.stringify(campaignTitle));
    console.log('[workflow] unmatchedAssets:', JSON.stringify(unmatchedAssets));
    console.log('[workflow] referenceLinks:', JSON.stringify(referenceLinks));

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
    const briefFolderId = pipeline.extractBriefFolderId(brief);
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

    // Phase 2 (additive): read linked references and enrich the summary / writer
    // direction with their content. Fully isolated — any failure leaves the
    // parsed brief unchanged and the pipeline untouched.
    try {
      // opts.attachments (Slack file objects: { url, filename, mimetype }) are
      // downloaded with the bot token and ingested as type:'upload'. Plumbing is
      // ready; standard slash commands don't carry files, so this is normally
      // empty until the Events API (message-with-files) feeds it.
      const { refs, counts } = await pipeline.fetchAllReferences(
        referenceLinks,
        tokens.slack_user,
        opts.attachments,
        tokens.slack_bot
      );
      if (refs.length > 0) {
        const enriched = await pipeline.enrichWithReferences({ summary, writerPrompt }, refs);
        summary = enriched.summary;
        writerPrompt = enriched.writerPrompt;
        referenceInsights = Array.isArray(enriched.referenceInsights) ? enriched.referenceInsights : [];
        console.log(
          `[Quillio] enriched brief from ${counts.drive} Drive + ${counts.external} external + ${counts.pdf} PDF + ${counts.canvas} canvas + ${counts.upload || 0} upload reference(s)`
        );
      }
    } catch (err) {
      console.error('[Quillio] reference enrichment skipped:', err.message);
    }

    // 2-3. Read specs, create the project folder, and build the document. If a
    //      brief-provided folder is inaccessible, surface the recoverable
    //      folder-access flow (Issue 3) instead of a dead-end error.
    let docResult;
    try {
      console.log(
        `[workflow] pre-generateDoc references → links=${(referenceLinks || []).length} insights=${(referenceInsights || []).length}`
      );
      docResult = await pipeline.generateDoc(
        { brief, campaignTitle, summary, writerPrompt, assets, referenceLinks, referenceInsights },
        effectiveFolderId,
        undefined, // Slack uses the shared env Google client
        tenantId
      );
    } catch (err) {
      if (pipeline.isFolderAccessError(err, effectiveFolderId)) {
        console.log('[workflow] folder access error — offering recovery for', effectiveFolderId);
        const email = await pipeline.getServiceAccountEmail();
        const help = buildFolderAccessBlocks({ email, folderId: effectiveFolderId, brief });
        await emit(help.text, help.blocks, () =>
          postFolderAccessHelp({ email, folderId: effectiveFolderId, brief, responseUrl })
        );
        return;
      }
      throw err;
    }
    const { doc, assetSpecs, projectFolderUrl } = docResult;
    console.log('[workflow] doc created:', doc.id);

    // 4. Show the doc-ready card — ONE message. The Campaign folder / Copy doc
    //    links and the "Saved to <folder>" line are folded into this single card
    //    (no separate folder-confirmation post). Editing the build message in
    //    place when we have a live message, else posting via response_url.
    //
    //    This emit is the LAST Slack write in the brief flow. Previously a
    //    second chat.postMessage fired after it (the project-folder post), which
    //    is what made the card appear to "revert" — the final state must be
    //    written exactly once, with nothing following it.
    const folderName = folderFromBrief
      ? (await pipeline.getFolderName(effectiveFolderId)) || 'your linked folder'
      : null;
    const result = {
      title: doc.title,
      webViewLink: doc.url,
      assets: assetSpecs.map((a) => a.assetType),
      docId: doc.id,
      folderUrl: projectFolderUrl, // null if folder creation failed → link omitted
      folderName, // null unless the doc went to a brief-linked folder
    };
    const resultBlocks = buildResultBlocks(result).blocks;
    await emit(`${emoji('quillio-doc-done')} Your doc is ready — ${doc.title}`, resultBlocks, () =>
      postResult(result, responseUrl)
    );

    console.log('[workflow] runBriefWorkflow DONE — doc', doc.id);
  } catch (err) {
    console.error('[workflow] runBriefWorkflow FAILED:', err && err.stack ? err.stack : err);
    throw err;
  }
}

// Handles "Generate First Draft" and "Regenerate". Transforms the clicked card
// in place via chat.update: generating → (re)draft-ready (single message, no
// stray posts). Falls back to response_url progress + chat.postMessage
// completion if the bot token / message ts isn't available. An optional
// `direction` string (from the Regenerate modal) is threaded into the drafter
// as user revision feedback; empty/undefined behaves exactly like a first draft.
async function runGenerateDraft(docId, responseUrl, channel, messageTs, workspaceId, direction) {
  const { tenant, tokens } = await resolveTenant(workspaceId);
  const canLive = !!tokens.slack_bot && channel && messageTs;
  const isRegen = !!(direction && String(direction).trim());
  console.log(
    `[workflow] runGenerateDraft START — canLive: ${canLive} | channel: ${channel || '(none)'} | regen: ${isRegen}`
  );

  // Count the assets in the doc (one HEADING_3 heading per asset) so the
  // progress message can name how many are being drafted.
  const assetCount = await pipeline.countDocAssets(docId);

  const count = assetCount;
  const verb = isRegen ? 'Regenerating' : 'Drafting';
  let progressMsg;
  if (count <= 3) {
    progressMsg = `${verb} ${count} asset${count === 1 ? '' : 's'} — back in a minute.`;
  } else if (count <= 8) {
    progressMsg = `${verb} ${count} assets — usually 2–3 minutes. Hang tight.`;
  } else if (count <= 20) {
    progressMsg = `${verb} ${count} assets — this one's a big brief, give it 4–5 minutes.`;
  } else {
    progressMsg = `${verb} ${count} assets — full brief, grab a coffee. Back in ~5 minutes.`;
  }

  const progressText = `${emoji('quillio')} ${progressMsg}`;
  if (canLive) await updateLive(channel, messageTs, progressText, undefined, tokens.slack_bot);
  else await updateMessage(progressText, responseUrl, { label: 'draft-progress' });

  const { title, fieldCount, url } = await pipeline.generateDraft(
    docId,
    direction,
    undefined,
    tenant && tenant.id
  );
  console.log('[workflow] generateDraft returned — posting completion');

  const headline = isRegen ? 'Draft regenerated' : 'First draft ready';
  const completionText = `${emoji('quillio-copy-done')} ${headline} — *${title}* (${fieldCount} field${
    fieldCount === 1 ? '' : 's'
  } drafted).`;

  if (canLive) {
    await updateLive(channel, messageTs, completionText, copyCompleteBlocks(completionText, url, docId), tokens.slack_bot);
  } else {
    try {
      await postChatMessage({ channel, text: completionText, webViewLink: url, token: tokens.slack_bot });
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
