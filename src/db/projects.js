'use strict';

// Per-tenant project history (Phase 3 / Week 10). Persists a project row after
// a successful brief run and reads them back for the web app's history + project
// views. All operations degrade gracefully when DATABASE_URL is unset (no pg):
// saveProject returns null, getProjects returns [], getProject returns null — so
// the single-tenant demo and tests run unchanged (history simply shows empty).

const { getPool } = require('../db');

// Insert a project after a successful brief run. `projectData` carries the
// Drive/doc identifiers the pipeline produced; `status` defaults to 'draft' when
// omitted. Returns the saved row, or null if there's no DB (best-effort — the
// caller never lets a history-save failure break the brief).
async function saveProject(tenantId, projectData = {}) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/projects] DATABASE_URL not set — skipping saveProject');
    return null;
  }
  if (!tenantId) {
    console.warn('[db/projects] saveProject called without a tenantId — skipping');
    return null;
  }

  const {
    name = null,
    drive_folder_id = null,
    drive_folder_url = null,
    copy_doc_id = null,
    copy_doc_url = null,
    status = 'draft',
    slack_channel_id = null,
    slack_thread_ts = null,
  } = projectData;

  console.log(`[db/projects] saveProject → tenant=${tenantId} name=${JSON.stringify(name)} doc=${copy_doc_id || 'none'}`);
  try {
    // Idempotent: a project is uniquely identified by its copy doc. If the
    // pipeline runs twice for the same doc (a retry, or being invoked from more
    // than one place), return the existing row instead of inserting a duplicate.
    if (copy_doc_id) {
      const existing = await pool.query(
        'SELECT * FROM projects WHERE tenant_id = $1 AND copy_doc_id = $2 LIMIT 1',
        [tenantId, copy_doc_id]
      );
      if (existing.rows[0]) {
        console.log(
          `[db/projects] saveProject → existing project id=${existing.rows[0].id} for doc=${copy_doc_id} (idempotent — no insert)`
        );
        return existing.rows[0];
      }
    }

    const res = await pool.query(
      `INSERT INTO projects
         (tenant_id, name, drive_folder_id, drive_folder_url, copy_doc_id, copy_doc_url, status, slack_channel_id, slack_thread_ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [tenantId, name, drive_folder_id, drive_folder_url, copy_doc_id, copy_doc_url, status, slack_channel_id, slack_thread_ts]
    );
    const saved = res.rows[0] || null;
    console.log(`[db/projects] saveProject OK → project id=${saved ? saved.id : 'null'} for tenant=${tenantId}`);
    return saved;
  } catch (err) {
    // Surface the failure (common cause: tenant_id has no matching tenants row,
    // so the FK rejects the insert) and rethrow for the caller to handle.
    console.error(`[db/projects] saveProject FAILED for tenant=${tenantId}: ${err.message}`);
    throw err;
  }
}

// All of a tenant's projects, newest first. Closed projects are hidden unless
// `includeClosed` is true (legacy 'draft' and NULL statuses are always shown —
// only 'closed' is filtered). Returns [] if there's no DB or the tenant has none.
async function getProjects(tenantId, includeClosed = false) {
  const pool = getPool();
  if (!pool || !tenantId) return [];

  const sql = includeClosed
    ? 'SELECT * FROM projects WHERE tenant_id = $1 ORDER BY created_at DESC'
    : "SELECT * FROM projects WHERE tenant_id = $1 AND status IS DISTINCT FROM 'closed' ORDER BY created_at DESC";
  const res = await pool.query(sql, [tenantId]);
  return res.rows || [];
}

// A single project scoped to its tenant. Returns null if there's no DB or no
// match (the tenant scope prevents reading another tenant's project by id).
async function getProject(tenantId, projectId) {
  const pool = getPool();
  if (!pool || !tenantId || !projectId) return null;

  const res = await pool.query(
    'SELECT * FROM projects WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [tenantId, projectId]
  );
  return (res.rows && res.rows[0]) || null;
}

// Update a project's status (scoped to its tenant). Returns the updated row, or
// null if there's no DB / no matching project. Callers validate the status.
async function setProjectStatus(tenantId, projectId, status) {
  const pool = getPool();
  if (!pool || !tenantId || !projectId) return null;

  const res = await pool.query(
    'UPDATE projects SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [tenantId, projectId, status]
  );
  return (res.rows && res.rows[0]) || null;
}

module.exports = { saveProject, getProjects, getProject, setProjectStatus };
