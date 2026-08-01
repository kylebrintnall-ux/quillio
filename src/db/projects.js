'use strict';

// Per-tenant project history (Phase 3 / Week 10). Persists a project row after
// a successful brief run and reads them back for the web app's history + project
// views. All operations degrade gracefully when DATABASE_URL is unset (no pg):
// saveProject returns null, getProjects returns [], getProject returns null — so
// the single-tenant demo and tests run unchanged (history simply shows empty).

const { getPool, isUndefinedColumn, warnMissingSchema } = require('../db');

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
    // The acting user (users.id) — who ran the brief. Nullable: the demo/env
    // path and any flow with no identified user record NULL, exactly as every
    // row created before this column existed does.
    created_by = null,
    // The template document this brief produced, if any (custom document types,
    // step three). Null for every copy-doc-only brief, which is nearly all of
    // them. copy_doc_id still means the promo doc and still keys idempotency.
    template_doc_id = null,
    template_doc_url = null,
  } = projectData;

  console.log(
    `[db/projects] saveProject → tenant=${tenantId} user=${created_by || 'none'} name=${JSON.stringify(name)} doc=${copy_doc_id || 'none'}`
  );
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

    const cols = [tenantId, name, drive_folder_id, drive_folder_url, copy_doc_id, copy_doc_url, status, slack_channel_id, slack_thread_ts];

    // The insert degrades by dropping OPTIONAL COLUMN GROUPS. Every column here
    // arrived in a migration, and Railway auto-deploys `main` on merge, so this
    // runs against a database missing some of them for as long as it takes
    // someone to run one. Losing the whole project row from history would be far
    // worse than a NULL in a column that did not exist a minute ago.
    //
    // EVERY COMBINATION, not a priority order. A first cut tried newest-first
    // (created_by + template, then created_by, then neither) on the assumption
    // that the older migration is always present. A database with template_doc_*
    // but no created_by then lost BOTH — the second attempt still named
    // created_by, so it failed too, and the third dropped everything. Enumerating
    // the combinations costs three extra array entries and removes the
    // assumption, which is worth more than the assumption was.
    const CREATED_BY = { extra: ['created_by'], values: [created_by] };
    const TEMPLATE = { extra: ['template_doc_id', 'template_doc_url'], values: [template_doc_id, template_doc_url] };
    const combine = (...gs) => ({ extra: gs.flatMap((g) => g.extra), values: gs.flatMap((g) => g.values) });
    const attempts = [
      combine(CREATED_BY, TEMPLATE),
      combine(CREATED_BY),
      combine(TEMPLATE),
      combine(),
    ];
    let res;
    for (let i = 0; i < attempts.length; i++) {
      const { extra, values } = attempts[i];
      const names = ['tenant_id', 'name', 'drive_folder_id', 'drive_folder_url', 'copy_doc_id', 'copy_doc_url', 'status', 'slack_channel_id', 'slack_thread_ts', ...extra];
      const params = [...cols, ...values];
      try {
        res = await pool.query(
          `INSERT INTO projects
             (${names.join(', ')})
           VALUES (${params.map((_, n) => '$' + (n + 1)).join(', ')})
           RETURNING *`,
          params
        );
        break;
      } catch (err) {
        if (!isUndefinedColumn(err) || i === attempts.length - 1) throw err;
        // Named by what the NEXT attempt gives up, so the log says which
        // migration is outstanding rather than restating the driver's error.
        warnMissingSchema(`projects (${names.join(', ')})`);
      }
    }
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

// ONE project, looked up by the copy doc it produced. The same key saveProject
// uses for idempotency, so it finds exactly the row a given doc belongs to.
//
// Exists so a surface holding only a doc id can reach the rest of what the run
// produced — the campaign folder, and any template documents. Returns null for
// no DB, no match, or another tenant's doc; every caller falls back to linking
// the doc it already has, so a null is a smaller card, never an error.
async function getProjectByDocId(tenantId, copyDocId) {
  const pool = getPool();
  if (!pool || !tenantId || !copyDocId) return null;
  try {
    const res = await pool.query(
      'SELECT * FROM projects WHERE tenant_id = $1 AND copy_doc_id = $2 LIMIT 1',
      [tenantId, copyDocId]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.warn(`[db/projects] getProjectByDocId failed for ${copyDocId}: ${err.message}`);
    return null;
  }
}

module.exports = { saveProject, getProjects, getProject, getProjectByDocId, setProjectStatus };
