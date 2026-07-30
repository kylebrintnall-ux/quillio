'use strict';

// Slack adapter: owns the Slack message lifecycle and orchestrates the core
// pipeline. All platform-agnostic work lives in core/pipeline.js; this file is
// the only place that talks to Slack (via ../services/slack).

const pipeline = require('../core/pipeline');
const { resolveTenant } = require('../db');
const { getClientsForTenant } = require('../google');
const {
  postResult,
  updateMessage,
  postChatMessage,
  postFolderAccessHelp,
  buildFolderAccessBlocks,
  buildResultBlocks,
  buildPlanCardBlocks,
  copyCompleteBlocks,
  postLive,
  updateLive,
  refuseUnlinkedSlack,
} = require('../services/slack');
const { emoji } = require('../emoji');
const { getTenantAssets } = require('../db/assets');
const {
  putPending,
  getPending,
  dropPending,
  planNeedsConfirmation,
  sanitizeAssetPlan,
  slackOwner,
} = require('../pendingBriefs');

const BUILDING_TEXT = `${emoji('quillio-scroll')} Building your document…`;

// Instance ceilings for the SLACK surface — the SAME as the web's defaults
// (10 per asset / 40 total).
//
// These were briefly tighter (3 / 6), on the reasoning that Slack has no
// confirmation step so a misread plan is only discovered once the doc exists.
// That over-weighted what a misread actually costs. Building a doc is a Drive
// write and some Docs batchUpdate calls — cheap, and easy to throw away. The
// expensive operation is Gemini DRAFTING, one call per asset group, and that is a
// separate deliberate button press on both surfaces: "Generate First Draft" here,
// the same on the web. A misread plan costs a discarded doc either way, not a pile
// of Gemini calls, so there was nothing for the asymmetry to buy.
//
// The per-surface mechanism in core/pipeline stays — pointing this at a tighter
// pair is all it takes to make Slack stricter again, and both the expansion and
// the card's clamp notice follow from this one constant.
const SLACK_ASSET_LIMITS = pipeline.DEFAULT_ASSET_LIMITS;

// Which entries in a plan will be cut down by the per-asset ceiling, and by how
// much. The clamp itself happens inside the expansion (core/pipeline); this only
// reads the plan to describe it, so the doc-ready card can say what was built
// instead of leaving the difference in a server log the writer never sees.
//
// A count OVER the ceiling is not an error — 3 usable emails beat a refusal — so
// this returns advisory text, never a throw. (An over-TOTAL plan is a different
// case and does throw, inside the expansion, with the hint above.)
function clampNotice(plan, limits) {
  const cut = [];
  for (const entry of Array.isArray(plan) ? plan : []) {
    if (!entry || typeof entry !== 'object') continue;
    const asked = parseInt(entry.count, 10);
    if (Number.isFinite(asked) && asked > limits.maxPerAsset) {
      cut.push({ asset: String(entry.asset || ''), asked });
    }
  }
  if (cut.length === 0) return null;
  const each = cut
    .map((c) => `${limits.maxPerAsset} of ${c.asked} ${c.asset}${c.asked === 1 ? '' : 's'}`)
    .join(', ');
  return (
    `Built ${each} — the ceiling here is ${limits.maxPerAsset} per asset. ` +
    'Use the web app for larger plans.'
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

  // Resolve the tenant for the *user who ran /quillio* (team + user), not the
  // workspace's installing tenant. Token source changes; nothing else does.
  const resolved = await resolveTenant(opts.workspaceId, opts.slackUserId);
  // Unlinked user: refuse (ephemeral) rather than building against a stranger's
  // tenant. Only reachable on the Slack path (opts.slackUserId set) with a DB.
  if (resolved.unlinked) {
    console.log('[workflow] runBriefWorkflow — unlinked Slack user, refusing');
    await refuseUnlinkedSlack({
      responseUrl,
      channel: opts.channelId || (opts.live && opts.live.channel),
      slackUserId: opts.slackUserId,
    });
    return;
  }
  const { tenant, tokens, source, user } = resolved;
  const tenantId = tenant && tenant.id;
  // The acting user: the person whose Slack identity ran the command. Their own
  // Google credentials do the Drive/Docs writes and they're recorded as the
  // project's author. Null on the env/demo path and for a legacy tenant-level
  // Slack link, where no user record is known.
  const actingUserId = (user && user.id) || null;
  // Log the token SOURCE only (db = Postgres, env = fallback) and WHO is acting
  // — never the tokens themselves.
  console.log(
    `[workflow] tenant resolved — source: ${source} | tenantId: ${tenantId || '(none)'} | user: ${actingUserId || '(none)'}`
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

    // Decide the target folder: forced default, explicit override, else the
    // routing priority (brief folder URL → tenant's saved default folder → null,
    // where null makes createDocument fall back to config.DRIVE_FOLDER_ID).
    const effectiveFolderId = opts.forceDefaultFolder
      ? null
      : opts.folderIdOverride !== undefined
        ? opts.folderIdOverride
        : pipeline.resolveDestinationFolderId(brief, tenant);
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

    // 1b. PAUSE FOR CONFIRMATION when the plan has something a human would want to
    //     correct — the same rule the web uses (pendingBriefs.planNeedsConfirmation:
    //     any count > 1, or a label). A one-of-each brief skips this entirely: no
    //     card, no click, no behavior change, which is every brief run before
    //     instances existed.
    //
    //     Slack cannot open a modal here. A modal needs a trigger_id valid ~3s and
    //     parse is a multi-second network round-trip, so the plan goes out as a
    //     Block Kit card via the live message instead — chat.update/postMessage
    //     need no trigger_id. The plan itself cannot ride in the buttons either
    //     (Slack caps an action value near 2000 chars), so only the pendingId does;
    //     the plan lives in the shared store keyed by workspace.
    if (planNeedsConfirmation(assets)) {
      const pendingId = putPending(slackOwner(opts.workspaceId), {
        surface: 'slack',
        brief,
        campaignTitle,
        summary,
        writerPrompt,
        referenceLinks,
        referenceInsights,
        plan: assets,
        effectiveFolderId,
        folderFromBrief,
        workspaceId: opts.workspaceId,
        slackUserId: opts.slackUserId,
        responseUrl,
        live,
      });
      console.log(
        `[workflow] plan needs confirmation → pending=${pendingId} ` +
          `plan=${JSON.stringify(assets.map((e) => `${e.asset}x${e.count}`))}`
      );
      const card = buildPlanCardBlocks({ pendingId, campaignTitle, plan: assets });
      await emit(card.text, card.blocks, () =>
        updateMessage(card.text, responseUrl, { blocks: card.blocks, label: 'plan-confirm' })
      );
      return;
    }

    await buildAndPost({
      brief, campaignTitle, summary, writerPrompt, referenceLinks, referenceInsights,
      plan: assets, effectiveFolderId, folderFromBrief,
      tenantId, actingUserId, live, responseUrl, emit,
    });

    console.log('[workflow] runBriefWorkflow DONE');
  } catch (err) {
    console.error('[workflow] runBriefWorkflow FAILED:', err && err.stack ? err.stack : err);
    throw err;
  }
}

// The BUILD half of the brief flow: specs → project folder → doc → doc-ready card.
// Extracted so it can run either straight after parse (nothing to confirm) or later
// from a confirmed plan, with identical behavior. Everything it needs is passed in;
// it holds no state of its own.
async function buildAndPost(ctx) {
  const {
    brief, campaignTitle, summary, writerPrompt, referenceLinks, referenceInsights,
    plan, effectiveFolderId, folderFromBrief, tenantId, actingUserId, live, responseUrl, emit,
  } = ctx;
  {
    // 2-3. Read specs, create the project folder, and build the document. If a
    //      brief-provided folder is inaccessible, surface the recoverable
    //      folder-access flow (Issue 3) instead of a dead-end error.
    let docResult;
    try {
      console.log(
        `[workflow] pre-generateDoc references → links=${(referenceLinks || []).length} insights=${(referenceInsights || []).length}`
      );
      // Drive/Docs writes run as the ACTING USER's own Google identity, falling
      // back to the tenant token and then the shared env client.
      const clients = await getClientsForTenant({ tenantId, userId: actingUserId });
      docResult = await pipeline.generateDoc(
        { brief, campaignTitle, summary, writerPrompt, assets: plan, referenceLinks, referenceInsights },
        effectiveFolderId,
        clients,
        tenantId,
        // The live card's channel + ts become the project's Slack linkage so a
        // future in-thread action (e.g. Hand Off to Design) can resolve the
        // project by thread. Null when there's no live message (response_url
        // fallback) — the project still persists, just without thread linkage.
        // createdBy records who ran the command.
        {
          slackChannelId: live && live.channel,
          slackThreadTs: live && live.ts,
          createdBy: actingUserId,
        },
        // The Slack surface's instance ceilings (see SLACK_ASSET_LIMITS above).
        SLACK_ASSET_LIMITS
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
      // "Built 3 of 5 …" when a per-asset count hit the Slack ceiling; null when
      // nothing was clamped (every brief reachable before instances existed).
      notice: clampNotice(plan, SLACK_ASSET_LIMITS),
    };
    const resultBlocks = buildResultBlocks(result).blocks;
    await emit(`${emoji('quillio-doc-done')} Your doc is ready — ${doc.title}`, resultBlocks, () =>
      postResult(result, responseUrl)
    );

    console.log('[workflow] build DONE — doc', doc.id);
  }
}

// Handles "Generate First Draft" and "Regenerate". Transforms the clicked card
// in place via chat.update: generating → (re)draft-ready (single message, no
// stray posts). Falls back to response_url progress + chat.postMessage
// completion if the bot token / message ts isn't available. An optional
// `direction` string (from the Regenerate modal) is threaded into the drafter
// as user revision feedback; empty/undefined behaves exactly like a first draft.
async function runGenerateDraft(docId, responseUrl, channel, messageTs, workspaceId, direction, slackUserId) {
  const resolved = await resolveTenant(workspaceId, slackUserId);
  // Unlinked user: refuse (ephemeral) rather than drafting against a stranger's
  // tenant. response_url covers the block-action path; the Regenerate modal
  // (view_submission) has no response_url, so refuseUnlinkedSlack falls back to
  // chat.postEphemeral via channel + user.
  if (resolved.unlinked) {
    console.log('[workflow] runGenerateDraft — unlinked Slack user, refusing');
    await refuseUnlinkedSlack({ responseUrl, channel, slackUserId });
    return;
  }
  const { tenant, tokens, user } = resolved;
  const actingUserId = (user && user.id) || null;
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

  // Docs read/write runs as the ACTING USER's own Google identity, falling back
  // to the tenant token and then the shared env client.
  const clients = await getClientsForTenant({
    tenantId: tenant && tenant.id,
    userId: actingUserId,
  });
  const { title, fieldCount, url } = await pipeline.generateDraft(
    docId,
    direction,
    clients,
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

// Resume a paused brief from its confirmed plan. Called by the Slack interaction
// handlers (Build, and the Edit modal's submission) — never by the slash command.
//
// `rawPlan` is null for Build (use the plan exactly as parsed) or a user-edited
// plan from the modal. A user-supplied plan is NEVER trusted: it goes through the
// same sanitizeAssetPlan the web confirm route uses, validated against this
// tenant's real asset library.
//
// A missing pendingId is the expected path after a restart or a 30-minute wait, so
// it reports rather than throwing: the card becomes a plain explanation that
// nothing was created and the brief needs running again.
async function resumeBriefWorkflow(pendingId, rawPlan, opts = {}) {
  const owner = slackOwner(opts.workspaceId);
  const pending = getPending(pendingId, owner);
  const channel = opts.channel || null;
  const messageTs = opts.messageTs || null;
  const responseUrl = opts.responseUrl || null;

  // One place to write the outcome back, mirroring runBriefWorkflow's `emit`. Edits
  // the clicked card in place when we can; falls back to response_url when there is
  // no bot token (slackApi throws) or no message coordinates.
  const say = async (text, blocks) => {
    if (channel && messageTs) {
      try {
        return await updateLive(channel, messageTs, text, blocks);
      } catch (err) {
        console.warn('[workflow] resume: chat.update failed, falling back:', err.message);
      }
    }
    return updateMessage(text, responseUrl, blocks ? { blocks } : undefined);
  };

  if (!pending) {
    console.log(`[workflow] resume: pending=${pendingId} is gone (expired or restarted)`);
    await say(
      `${emoji('quillio-scroll')} That plan is no longer available — Quillio restarted or it sat for more than 30 minutes. ` +
        'Nothing was created. Run `/quillio` again with the same brief.'
    );
    return;
  }

  // Re-resolve the tenant: tokens are never parked in the pending record, and the
  // acting user must be the person whose Google identity does the Drive write.
  const resolved = await resolveTenant(opts.workspaceId, opts.slackUserId);
  if (resolved.unlinked) {
    console.log('[workflow] resume: unlinked Slack user, refusing');
    await refuseUnlinkedSlack({ responseUrl, channel, slackUserId: opts.slackUserId });
    return;
  }
  const { tenant, tokens, user } = resolved;
  const tenantId = tenant && tenant.id;
  const actingUserId = (user && user.id) || null;

  let plan = pending.plan;
  if (rawPlan) {
    let libraryNames = [];
    try {
      const rows = await getTenantAssets(tenantId);
      libraryNames = (rows || []).map((r) => r.name);
    } catch (err) {
      console.error('[workflow] resume: library read failed:', err.message);
      await say(`⚠️ Couldn't read your asset library: ${err.message}`);
      return;
    }
    if (libraryNames.length === 0) {
      await say("⚠️ This workspace has no asset library yet, so there's nothing to build from.");
      return;
    }
    const checked = sanitizeAssetPlan(rawPlan, libraryNames);
    if (checked.error) {
      await say(`⚠️ ${checked.error}`);
      return;
    }
    if (checked.plan.length === 0) {
      await say('⚠️ That plan had no assets left in it — run `/quillio` again.');
      return;
    }
    plan = checked.plan;
  }

  console.log(
    `[workflow] resume: building pending=${pendingId} ` +
      `plan=${JSON.stringify(plan.map((e) => `${e.asset}x${e.count}`))}`
  );
  await say(BUILDING_TEXT);

  const live = channel && messageTs ? { channel, ts: messageTs } : pending.live || null;
  const canLive = !!tokens.slack_bot;
  const emit = async (text, blocks, fallback) => {
    if (live && canLive) return updateLive(live.channel, live.ts, text, blocks, tokens.slack_bot);
    return fallback();
  };

  try {
    await buildAndPost({
      brief: pending.brief,
      campaignTitle: pending.campaignTitle,
      summary: pending.summary,
      writerPrompt: pending.writerPrompt,
      referenceLinks: pending.referenceLinks,
      referenceInsights: pending.referenceInsights,
      plan,
      effectiveFolderId: pending.effectiveFolderId,
      folderFromBrief: pending.folderFromBrief,
      tenantId,
      actingUserId,
      live,
      responseUrl,
      emit,
    });
    // Built successfully — the plan has served its purpose.
    dropPending(pendingId, owner);
  } catch (err) {
    console.error('[workflow] resume FAILED:', err && err.stack ? err.stack : err);
    // Leave the pending record in place so the user can hit Build again rather
    // than re-paying for the whole parse.
    await say(`⚠️ Quillio hit an error building that plan: ${err.message}`);
  }
}

// Discard a paused brief without building. The record would expire on its own; this
// just frees it early and confirms to the user that nothing was created.
async function cancelBriefWorkflow(pendingId, opts = {}) {
  dropPending(pendingId, slackOwner(opts.workspaceId));
  const text = '✓ Cancelled — nothing was created.';
  if (opts.channel && opts.messageTs) {
    try {
      return await updateLive(opts.channel, opts.messageTs, text);
    } catch (err) {
      console.warn('[workflow] cancel: chat.update failed, falling back:', err.message);
    }
  }
  return updateMessage(text, opts.responseUrl);
}

// Read a paused brief's plan for the Edit modal. Ownership is checked against the
// WORKSPACE, synchronously — a button click has ~3s to open a modal, so it cannot
// afford a resolveTenant round-trip first. Returns null when the record is gone.
function peekPendingPlan(pendingId, workspaceId) {
  const pending = getPending(pendingId, slackOwner(workspaceId));
  return pending ? pending.plan : null;
}

module.exports = {
  runBriefWorkflow,
  runGenerateDraft,
  resumeBriefWorkflow,
  cancelBriefWorkflow,
  peekPendingPlan,
  SLACK_ASSET_LIMITS,
  clampNotice,
};
