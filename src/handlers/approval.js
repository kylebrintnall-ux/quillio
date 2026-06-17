'use strict';

// Submit-for-Review / approval flow handlers (Phase 3).
//
// These drive the copy → review → approve/changes loop. They depend on the
// Phase 3 Postgres schema (`projects`, `workflow_roles`) which does not exist
// yet, so every DB call is best-effort: with no DATABASE_URL (or no matching
// rows) the handler logs and degrades gracefully rather than throwing. The
// Slack-message edits that don't need the DB still run.
//
// NOTE: for these to fire, src/server.js must route the new interaction
// action_ids (submit_for_review, approve, request_changes, resubmit) to the
// handlers exported here. That wiring is intentionally left out of scope.

const {
  postLive,
  updateLive,
  reviewRequestBlocks,
  designerHandoffBlocks,
  changesRequestedBlocks,
} = require('../services/slack');

// --- Postgres (Phase 3) — lazy, guarded, self-contained ---
let pool = null;
function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  const { Pool } = require('pg'); // lazy — only when a DB is configured
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}
async function query(text, params) {
  const p = getPool();
  if (!p) {
    console.warn('[approval] DATABASE_URL not set — skipping query (Phase 3 DB)');
    return null;
  }
  return p.query(text, params);
}

async function getProjectByThread(channelId, threadTs) {
  const r = await query(
    'SELECT * FROM projects WHERE slack_channel_id = $1 AND slack_thread_ts = $2 LIMIT 1',
    [channelId, threadTs]
  );
  return r && r.rows && r.rows[0] ? r.rows[0] : null;
}
async function getProjectById(id) {
  const r = await query('SELECT * FROM projects WHERE id = $1 LIMIT 1', [id]);
  return r && r.rows && r.rows[0] ? r.rows[0] : null;
}
async function getRoleUser(tenantId, role) {
  const r = await query(
    'SELECT slack_user_id FROM workflow_roles WHERE tenant_id = $1 AND role = $2 LIMIT 1',
    [tenantId, role]
  );
  return r && r.rows && r.rows[0] ? r.rows[0].slack_user_id : null;
}
async function getAssetList(projectId) {
  const r = await query(
    `SELECT at.name FROM project_assets pa
       JOIN asset_types at ON at.id = pa.asset_type_id
      WHERE pa.project_id = $1 ORDER BY at.sort_order`,
    [projectId]
  );
  return r && r.rows ? r.rows.map((x) => x.name).filter(Boolean).join(', ') : '';
}
async function setStatus(projectId, status) {
  await query('UPDATE projects SET status = $2 WHERE id = $1', [projectId, status]);
}
async function bumpVersion(projectId) {
  await query('UPDATE projects SET version = COALESCE(version, 1) + 1 WHERE id = $1', [projectId]);
}

const ctx = (payload) => ({
  channelId: payload.channel && payload.channel.id,
  ts: payload.message && payload.message.ts,
  threadTs: (payload.message && (payload.message.thread_ts || payload.message.ts)) || undefined,
  userId: payload.user && payload.user.id,
  userName: (payload.user && (payload.user.name || payload.user.username)) || 'your reviewer',
  value: payload.actions && payload.actions[0] && payload.actions[0].value,
});

// STEP 2 — Copywriter clicked "Submit for Review".
async function handleSubmitForReview(payload) {
  const { channelId, ts, threadTs } = ctx(payload);

  // Reflect the submitted state on the clicked message (no DB needed).
  if (channelId && ts) {
    await updateLive(channelId, ts, ':quillio: Submitted for review.').catch((e) =>
      console.error('[approval] submit status update failed:', e.message)
    );
  }

  const project = await getProjectByThread(channelId, threadTs);
  if (!project) {
    console.warn('[approval] submit_for_review: no project found (Phase 3 DB not set up)');
    return;
  }
  await setStatus(project.id, 'in_review');

  const reviewerId = await getRoleUser(project.tenant_id, 'reviewer');
  if (!reviewerId) {
    console.warn('[approval] no reviewer configured in workflow_roles');
    return;
  }
  const assetList = await getAssetList(project.id);
  await postLive(
    reviewerId,
    `Copy ready for your review — ${project.name}`,
    reviewRequestBlocks({
      campaignTitle: project.name,
      assetList,
      docUrl: project.copy_doc_url,
      projectRef: String(project.id),
    })
  );
}

// STEP 3 — Reviewer clicked "Approve".
async function handleApprove(payload) {
  const { channelId, ts, userName, value } = ctx(payload);
  const project = await getProjectById(value);
  if (!project) {
    console.warn('[approval] approve: no project found (Phase 3 DB not set up)');
    if (channelId && ts) await updateLive(channelId, ts, `:doc-done: Copy approved by ${userName}.`).catch(() => {});
    return;
  }
  await setStatus(project.id, 'copy_approved');

  const copywriterId = (await getRoleUser(project.tenant_id, 'copywriter')) || project.created_by;
  if (copywriterId) {
    await postLive(copywriterId, `:doc-done: Copy approved by ${userName}`).catch((e) =>
      console.error('[approval] copywriter approve DM failed:', e.message)
    );
  }

  const designerId = await getRoleUser(project.tenant_id, 'designer');
  if (designerId) {
    await postLive(
      designerId,
      'Copy approved — ready for handoff',
      designerHandoffBlocks({ docUrl: project.copy_doc_url, projectRef: String(project.id) })
    ).catch((e) => console.error('[approval] designer handoff DM failed:', e.message));
  }

  if (channelId && ts) {
    await updateLive(channelId, ts, `:doc-done: Copy approved by ${userName}.`).catch(() => {});
  }
}

// STEP 4 — Reviewer clicked "Request Changes".
async function handleRequestChanges(payload) {
  const { channelId, ts, userName, value } = ctx(payload);
  const project = await getProjectById(value);
  if (!project) {
    console.warn('[approval] request_changes: no project found (Phase 3 DB not set up)');
    if (channelId && ts) await updateLive(channelId, ts, `:quillio: Changes requested by ${userName}.`).catch(() => {});
    return;
  }
  await setStatus(project.id, 'changes_requested');

  const copywriterId = (await getRoleUser(project.tenant_id, 'copywriter')) || project.created_by;
  if (copywriterId) {
    await postLive(
      copywriterId,
      `Changes requested — ${userName} left feedback in the doc.`,
      changesRequestedBlocks({ reviewerName: userName, docUrl: project.copy_doc_url, projectRef: String(project.id) })
    ).catch((e) => console.error('[approval] changes-requested DM failed:', e.message));
  }

  if (channelId && ts) {
    await updateLive(channelId, ts, `:quillio: Changes requested by ${userName}.`).catch(() => {});
  }
}

// STEP 4 (loop) — Copywriter clicked "Resubmit when ready": bump version, then
// re-run the submit-for-review flow.
async function handleResubmit(payload) {
  const { value } = ctx(payload);
  const project = await getProjectById(value);
  if (project) await bumpVersion(project.id);
  return handleSubmitForReview(payload);
}

module.exports = {
  handleSubmitForReview,
  handleApprove,
  handleRequestChanges,
  handleResubmit,
};
