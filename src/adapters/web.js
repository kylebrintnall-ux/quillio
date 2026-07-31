'use strict';

// Web adapter (Phase 3 / Week 8). Drives the same core/pipeline.js as the Slack
// adapter, but for browser requests — so it returns plain data objects and does
// NO messaging. There are intentionally zero Slack imports in this file (a smoke
// test enforces it); the only platform-specific input is the resolved tenant
// context, used read-only for token-gated reference fetching.
//
// tenantContext is the { tenant, tokens, source, user } shape resolveTenant
// returns. `user` is the acting (signed-in) user; its id selects that person's
// own Google credentials for Drive/Docs writes and is recorded as the author of
// any project created, so two people on one tenant never write as each other.

const pipeline = require('../core/pipeline');
const { getClientsForTenant } = require('../google');
const { totalMissMessage, partialMissNotice } = require('../utils/assetMatch');

// The acting user's id from a resolved tenant context, or null.
function actingUserId(tenantContext) {
  return (tenantContext && tenantContext.user && tenantContext.user.id) || null;
}

// FIRST HALF of a brief run: parse + reference enrichment, stopping BEFORE any
// doc is created. Returns everything the second half needs, plus the asset PLAN
// (an ordered [{ asset, count, labels }]) for the user to review. Splitting here
// is what lets the route show an interpretation before building anything — a
// misread brief that asked for ten sections is cheap to correct at this point and
// expensive after. Throws on failure, same as the combined path.
async function runWebBriefParse(briefText, tenantContext = {}, fileRefs = []) {
  const tokens = tenantContext.tokens || {};

  // 1. Parse the brief into title / summary / writerPrompt / assets (+ links).
  //    The tenant id constrains the model to THIS tenant's asset names, so an
  //    asset they own but the bundled 30 lack is requestable. Falls back to
  //    config.ALLOWED_ASSETS when there's no library (demo / unseeded).
  const tenantIdForParse = (tenantContext.tenant && tenantContext.tenant.id) || null;
  const parsedBrief = await pipeline.parseBrief(briefText, tenantIdForParse);
  const { campaignTitle, assets, unmatchedAssets, referenceLinks } = parsedBrief;
  // Which vocabulary actually gated this parse — decides whether the unmatched
  // message can honestly say "your asset library".
  const vocabularySource = (parsedBrief.assetVocabulary && parsedBrief.assetVocabulary.source) || 'default';
  let { summary, writerPrompt } = parsedBrief; // may be enriched below
  let referenceInsights = [];

  // TOTAL miss: the brief named assets and none of them mapped. Refuse rather
  // than silently building the full set. (A vague brief with no assets at all
  // still falls through to "all assets".) Unchanged behavior — only the wording
  // moved to the shared builder.
  if (assets.length === 0 && unmatchedAssets.length > 0) {
    throw new Error(totalMissMessage(unmatchedAssets, vocabularySource));
  }

  // 2. Enrich from linked references + attached files (best-effort — any failure
  //    leaves the parsed brief unchanged, exactly like the Slack adapter). Temp
  //    upload files are always cleaned up, success or failure.
  try {
    const { refs, counts } = await pipeline.fetchAllReferences(referenceLinks, tokens.slack_user);

    // Attached files (web uploads): read from temp paths, extract, then delete
    // the temp files immediately regardless of outcome.
    let uploadRefs = [];
    if (Array.isArray(fileRefs) && fileRefs.length > 0) {
      try {
        uploadRefs = await pipeline.processAttachedFiles(fileRefs);
      } finally {
        await pipeline.cleanupAttachedFiles(fileRefs);
      }
    }

    const allRefs = uploadRefs.length > 0 ? [...refs, ...uploadRefs] : refs;
    if (allRefs.length > 0) {
      const enriched = await pipeline.enrichWithReferences({ summary, writerPrompt }, allRefs);
      summary = enriched.summary;
      writerPrompt = enriched.writerPrompt;
      referenceInsights = Array.isArray(enriched.referenceInsights) ? enriched.referenceInsights : [];
      console.log(
        `[web] enriched brief from ${counts.drive} Drive + ${counts.external} external + ${counts.pdf} PDF + ${counts.canvas} canvas + ${uploadRefs.length} upload reference(s)`
      );
    }
  } catch (err) {
    console.error('[web] reference enrichment skipped:', err.message);
    // Ensure temp uploads are removed even if processing threw before its finally.
    await pipeline.cleanupAttachedFiles(fileRefs);
  }

  // The asset PLAN, straight from parseBrief: an ordered [{ asset, count, labels? }].
  // A one-of-each brief yields every count 1 and no labels, so planNeedsConfirmation
  // is false and the flow runs through without a pause, exactly as before counts
  // existed. `labels` is normalized to an array so the confirm screen and the
  // interpretation payload always see the same shape.
  const plan = (Array.isArray(assets) ? assets : []).map((e) =>
    typeof e === 'string'
      ? { asset: e, count: 1, labels: [] }
      : { asset: e.asset, count: e.count || 1, labels: Array.isArray(e.labels) ? e.labels : [] }
  );

  // `unmatchedAssets` rides out with the parse. It used to stop here, which is
  // what made a PARTIAL miss invisible: the confirmation screen and the result
  // payload are both built from this return value, so neither could show what
  // was dropped even though the parse knew. `unmatchedNotice` is the rendered
  // sentence (null when everything matched) so the route and the browser never
  // rebuild the wording themselves.
  return {
    briefText,
    campaignTitle,
    summary,
    writerPrompt,
    referenceLinks,
    referenceInsights,
    plan,
    unmatchedAssets,
    // Carried so runWebBriefGenerate can re-render the notice after the
    // confirmation pause without re-parsing (and without guessing the wording).
    assetVocabulary: parsedBrief.assetVocabulary || { source: vocabularySource },
    unmatchedNotice: partialMissNotice(unmatchedAssets, vocabularySource),
  };
}

// SECOND HALF: folder routing + doc creation, resuming from a parse result and an
// asset plan (which the user may have edited). `parsed` is runWebBriefParse's
// return value; `plan` overrides the plan it carried. Returns the structured
// payload the browser renders — identical whether or not a confirmation step ran.
async function runWebBriefGenerate(parsed, plan, tenantContext = {}) {
  const tenantId = tenantContext.tenant && tenantContext.tenant.id;
  const userId = actingUserId(tenantContext);
  // Drive/Docs writes run as the SIGNED-IN USER's own Google OAuth identity when
  // they've connected one, falling back to the tenant-level token and then the
  // shared env path. Reference reads stayed on the SA path inside
  // fetchAllReferences — the drive.file scope can't read arbitrary pre-existing
  // Drive files, only ones this app created.
  const clients = await getClientsForTenant({ tenantId, userId });

  const { briefText, campaignTitle, summary, writerPrompt, referenceLinks, referenceInsights } = parsed;
  const assets = Array.isArray(plan) ? plan : parsed.plan;
  // Carried from the parse so the result screen can say what was left out —
  // including on the confirm-then-build path, where the notice was already shown
  // once on the confirmation screen and would otherwise vanish from the result.
  const unmatchedAssets = Array.isArray(parsed.unmatchedAssets) ? parsed.unmatchedAssets : [];
  const vocabularySource = (parsed.assetVocabulary && parsed.assetVocabulary.source) || 'default';

  // 3. Folder routing (priority): a Drive folder URL embedded in the brief, else
  //    the tenant's saved default folder (Settings → default_folder_id), else
  //    null → generateDoc falls back to config.DRIVE_FOLDER_ID.
  const effectiveFolderId = pipeline.resolveDestinationFolderId(briefText, tenantContext.tenant);

  // 4. Build the document.
  console.log(
    `[web] folder routing → effectiveFolderId=${effectiveFolderId || '(config default)'}; pre-generateDoc references → links=${(referenceLinks || []).length} insights=${(referenceInsights || []).length}`
  );
  let docResult;
  try {
    docResult = await pipeline.generateDoc(
      { brief: briefText, campaignTitle, summary, writerPrompt, assets, referenceLinks, referenceInsights },
      effectiveFolderId,
      clients,
      tenantId,
      // Authorship: the signed-in user on the web path.
      { createdBy: userId }
    );
  } catch (err) {
    // A user-specified destination folder (brief URL or Settings default) that
    // the writing identity can't reach: surface a clear, actionable message
    // rather than a generic failure. effectiveFolderId is null when no folder
    // was specified, so isFolderAccessError returns false and we rethrow.
    if (pipeline.isFolderAccessError(err, effectiveFolderId)) {
      // Name the identity that actually writes: the signed-in Google user when
      // this tenant connected OAuth, otherwise the shared service account.
      let share;
      if (clients && clients.usingOAuth) {
        share =
          'Make sure that folder is in the Google account you signed in with (or shared with it as Editor), then run the brief again. ' +
          'Or clear the default folder in Settings to let Quillio create the doc in your own Drive.';
      } else {
        let email = null;
        try {
          email = await pipeline.getServiceAccountEmail();
        } catch (_) {
          /* best-effort — fall back to a generic share hint below */
        }
        share = email
          ? `Share it with the Quillio service account (${email}) and give it Editor access, then run the brief again.`
          : `Make sure it's shared (Editor access) with the Google account Quillio writes as, then run the brief again.`;
      }
      throw new Error(`Couldn't write to your Drive folder (${effectiveFolderId}). ${share}`);
    }
    throw err;
  }
  // Project persistence now lives in the shared pipeline (generateDoc), so both
  // the web and Slack adapters record history identically — nothing to save here.
  const { doc, assetSpecs, projectFolderUrl, projectId } = docResult;

  return {
    projectId,
    docUrl: doc.url,
    folderUrl: projectFolderUrl,
    campaignTitle,
    assets: assetSpecs.map((a) => a.assetType),
    // Richer per-asset detail for the web UI: name + each field's char spec.
    // Keeps `assets` (names only) above for backward compatibility.
    assetBlocks: assetSpecs.map((a) => ({
      name: a.assetType,
      asset_direction: a.asset_direction || null,
      fields: (a.fields || []).map((f) => ({
        fieldName: f.fieldName,
        charMin: f.charMin,
        charMax: f.charMax,
      })),
    })),
    summary,
    writerDirection: writerPrompt,
    referenceInsights,
    // Advisory, not an error: the doc above WAS built. Null/[] when everything
    // the brief named matched, which is every run that reached here before.
    unmatchedAssets,
    unmatchedNotice: partialMissNotice(unmatchedAssets, vocabularySource),
  };
}

// Run a brief end to end — parse, enrich, build — with no confirmation pause.
// The composition of the two halves above, kept because it IS the flow whenever
// there is nothing to confirm (the only flow reachable today), and because the
// Slack adapter's sequence has no pause either.
async function runWebBrief(briefText, tenantContext = {}, fileRefs = []) {
  const parsed = await runWebBriefParse(briefText, tenantContext, fileRefs);
  return runWebBriefGenerate(parsed, parsed.plan, tenantContext);
}

// Generate (or, with `direction`, regenerate) the draft for an existing doc.
// tenantContext is accepted for a consistent signature (and future per-tenant
// config); generateDraft re-reads the doc itself, so no tokens are needed today.
// `direction` is optional user revision feedback threaded into the prompt.
// `scopedFields` (optional [{assetType, fieldName}]) scopes the draft to only
// those fields (selective generate/regenerate); undefined → whole doc, as before.
async function runWebDraft(docId, tenantContext = {}, direction, scopedFields, append) {
  const tenantId = tenantContext.tenant && tenantContext.tenant.id;
  const clients = await getClientsForTenant({ tenantId, userId: actingUserId(tenantContext) });
  const { title, fieldCount, url } = await pipeline.generateDraft(docId, direction, clients, tenantId, scopedFields, append);
  return { docId, title, fieldCount, url };
}

// Read a project's doc into the structured, copy-bearing shape the project view
// renders. The Docs read runs as the tenant's Google OAuth user when connected,
// else the shared env path. Throws on read failure so the route shows a fallback.
async function runWebProjectContent(docId, tenantContext = {}) {
  const clients = await getClientsForTenant({
    tenantId: tenantContext.tenant && tenantContext.tenant.id,
    userId: actingUserId(tenantContext),
  });
  return pipeline.getProjectContent(docId, clients);
}

// Run a copy review on a doc as the tenant's user. Returns the review result
// ({ reviewed, flagged, clean, hadCopy, digest, status }). Throws on failure so
// the route surfaces an error state (rather than a stuck review).
async function runWebReview(docId, tenantContext = {}, scopedFields) {
  const tenantId = tenantContext.tenant && tenantContext.tenant.id;
  const clients = await getClientsForTenant({ tenantId, userId: actingUserId(tenantContext) });
  const { runCopyReview } = require('../services/copyReview');
  return runCopyReview(docId, tenantId, clients, scopedFields);
}

module.exports = {
  runWebBrief,
  // The two halves, for the parse-then-confirm route split.
  runWebBriefParse,
  runWebBriefGenerate,
  runWebDraft,
  runWebProjectContent,
  runWebReview,
};
