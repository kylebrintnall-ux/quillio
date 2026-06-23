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
  } = projectData;

  const res = await pool.query(
    `INSERT INTO projects
       (tenant_id, name, drive_folder_id, drive_folder_url, copy_doc_id, copy_doc_url, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, name, drive_folder_id, drive_folder_url, copy_doc_id, copy_doc_url, status]
  );
  return res.rows[0] || null;
}

// All of a tenant's projects, newest first. Returns [] if there's no DB or the
// tenant has none — so the history view can render its empty state uniformly.
async function getProjects(tenantId) {
  const pool = getPool();
  if (!pool || !tenantId) return [];

  const res = await pool.query(
    'SELECT * FROM projects WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId]
  );
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

module.exports = { saveProject, getProjects, getProject };
