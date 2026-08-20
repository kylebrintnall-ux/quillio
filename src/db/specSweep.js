'use strict';

// The reads and writes behind the spec correction sweep.
//
// PRE-MIGRATION TOLERANCE, same contract as db/notifications.js: every function
// here catches 42P01 (undefined_table) / 42703 (undefined_column) and degrades to
// "there is nothing to sweep" rather than throwing. Railway auto-deploys `main`
// on merge, so this runs against a database without spec_sweep_state first, and a
// cron service that crashes on boot is worse than one that does nothing. The
// catch matches only those SQLSTATEs — a permissions or connectivity failure
// still throws, and still fails the run loudly.

const { getPool, isUndefinedTable, isUndefinedColumn, warnMissingSchema } = require('../db');

const MIGRATION = 'scripts/migrateAddSpecSweepState.js';

// Statuses a project is NOT swept in.
//
// AN EXCLUSION LIST, NEVER AN INCLUSION LIST, and that is the whole design of
// this constant. Production carries not_started, in_progress, finished, closed,
// and a legacy `draft` on a handful of rows; `saveProject` also defaults to
// 'draft' for any caller that omits a status. Listing the statuses to INCLUDE
// means a status added next year is silently skipped by a background job nobody
// is watching — the failure would be invisible, because a project that is never
// swept produces no error and no notification. Excluding means a new status is
// swept by default, which is the direction that fails loudly if it is wrong.
//
// WHY `closed` IS HERE AS WELL AS `finished`. The brief this was built from
// described the vocabulary as not_started / in_progress / finished plus a legacy
// `draft`, and did not mention `closed` — but it exists and it is the RETIRE
// path: getProjects hides it unless includeClosed, and app.html's card × is what
// sets it. A retired campaign is not work in progress, so correcting its document
// would be editing something its owner has put away. Raised as a deviation from
// the brief and confirmed 2026-08-20; recorded here rather than left implicit
// because the two members of this array come from different arguments.
//
// Note this is still an EXCLUSION list — adding `closed` does not weaken the
// property above. A status nobody has invented yet is swept.
const EXCLUDED_STATUSES = ['finished', 'closed'];

// Read the watermark. Returns { lastChangedAt, lastChangeId, ready }.
//
// `ready: false` means the table is not there yet — the caller reports that and
// exits cleanly rather than sweeping from the beginning of time, which is what a
// null watermark would otherwise mean.
async function getSweepState() {
  const pool = getPool();
  if (!pool) return { ready: false, reason: 'no_database', lastChangedAt: null, lastChangeId: null };
  try {
    const res = await pool.query('SELECT * FROM spec_sweep_state WHERE id = 1');
    const row = res.rows[0];
    if (!row) return { ready: false, reason: 'no_state_row', lastChangedAt: null, lastChangeId: null };
    return {
      ready: true,
      lastChangedAt: row.last_changed_at || null,
      lastChangeId: row.last_change_id == null ? null : Number(row.last_change_id),
      lastRunAt: row.last_run_at || null,
      lastRunStatus: row.last_run_status || null,
    };
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('spec_sweep_state', MIGRATION);
      return { ready: false, reason: 'no_table', lastChangedAt: null, lastChangeId: null };
    }
    throw err;
  }
}

// Move the watermark, and record how the run went.
//
// `changedAt`/`changeId` may be null, which means "the run finished nothing" —
// the status and note are still written, so a run that failed on its very first
// change is visible in the table rather than indistinguishable from one that had
// no work.
async function setSweepState({ changedAt, changeId, status, note } = {}) {
  const pool = getPool();
  if (!pool) return false;
  try {
    // COALESCE on the watermark columns: a run that advanced nothing must LEAVE
    // the previous watermark where it was, never null it. Passing null here is
    // "no progress", not "start again from the beginning".
    await pool.query(
      `UPDATE spec_sweep_state
          SET last_changed_at = COALESCE($1, last_changed_at),
              last_change_id  = COALESCE($2, last_change_id),
              last_run_at     = NOW(),
              last_run_status = $3,
              last_run_note   = $4
        WHERE id = 1`,
      [changedAt || null, changeId == null ? null : changeId, status || null, note || null]
    );
    return true;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('spec_sweep_state', MIGRATION);
      return false;
    }
    throw err;
  }
}

// Every char_max change newer than the watermark, oldest first.
//
// ORDERED, AND THE ORDER IS THE POINT. The sweep advances its watermark to the
// last change it FULLY finished and stops at the first one it did not, so the
// rows have to arrive in the same order the watermark walks. `(changed_at, id)`
// rather than `changed_at` alone because commitReview writes every attribute of
// one approval inside a single transaction, and NOW() is the transaction
// timestamp — so a multi-field approval produces several rows sharing a
// timestamp to the microsecond, and only the id separates them.
//
// spec_note changes are excluded: this sweep corrects a NUMBER inside a bracket.
// A changed note is rendered by the italic line under the label, which no
// existing document reproduces from stored state and which no bracket carries.
async function getChangesSince(lastChangedAt, lastChangeId, limit = 500) {
  const pool = getPool();
  if (!pool) return [];
  const cap = Math.max(1, Math.min(2000, parseInt(limit, 10) || 500));
  try {
    // The tuple comparison is written out rather than using row-value syntax so
    // the NULL case (nothing swept yet -> take everything) is one branch instead
    // of a COALESCE against a sentinel date.
    const where = lastChangedAt
      ? `WHERE field_attr = 'char_max'
           AND (changed_at, id) > ($1::timestamptz, $2::bigint)`
      : "WHERE field_attr = 'char_max'";
    const params = lastChangedAt ? [lastChangedAt, lastChangeId == null ? 0 : lastChangeId, cap] : [cap];
    const res = await pool.query(
      `SELECT id, asset_type, field_name, field_attr, old_value, new_value, source_url, changed_at
         FROM spec_change_log
         ${where}
        ORDER BY changed_at ASC, id ASC
        LIMIT $${params.length}`,
      params
    );
    return (res.rows || []).map((r) => ({
      id: Number(r.id),
      assetType: r.asset_type,
      fieldName: r.field_name,
      oldValue: r.old_value,
      newValue: r.new_value,
      sourceUrl: r.source_url || null,
      changedAt: r.changed_at,
    }));
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('spec_change_log', 'scripts/migrateAddSpecChangeLog.js');
      return [];
    }
    throw err;
  }
}

// Every tenant's own row for every (asset, field) in the library, with the two
// facts that decide whether the sweep may touch it.
//
// WHY THE WHOLE LIBRARY IN ONE QUERY, AND WHY THE MATCH HAPPENS IN JAVASCRIPT.
// spec_change_log stores `asset_type` as a NAME, and names are compared in this
// codebase through ONE normalizer (src/utils/normalize.js) whose SQL twin
// `quillio_normalize_name` exists only because two unique indexes needed it.
// Matching in SQL would mean either depending on that function from a background
// job — a dependency on a migration this feature does not otherwise need — or
// hand-rolling a second normalization in SQL, which is exactly the drift the
// single-normalizer rule exists to prevent. The whole table is ~440 rows across
// every tenant, so reading it and matching in JS with the real normalizer costs
// one query and removes the question.
//
// spec_type is read HERE, per tenant, and not from the change log — the log does
// not record it. That means the tier is evaluated as it stands NOW rather than as
// it stood when the change was approved. That is the right reading for this
// feature: the question is "may this tenant's document be corrected today", and a
// field retiered to house_default since the approval is one whose number is now
// the tenant's to set.
async function getLibraryRows() {
  const pool = getPool();
  if (!pool) return [];
  const variants = [
    `SELECT at.tenant_id, at.name AS asset_name, at.is_active,
            cf.field_name, cf.field_type, cf.spec_type, cf.spec_source,
            cf.char_min, cf.char_max, cf.char_min_override, cf.char_max_override
       FROM copy_fields cf
       JOIN asset_types at ON at.id = cf.asset_type_id`,
    // Pre-override database (CLAUDE.md: either deploy order is safe). Reporting
    // no overrides is honest there — the columns do not exist, so no tenant can
    // have set one.
    `SELECT at.tenant_id, at.name AS asset_name, at.is_active,
            cf.field_name, cf.field_type, cf.spec_type, cf.spec_source,
            cf.char_min, cf.char_max, NULL AS char_min_override, NULL AS char_max_override
       FROM copy_fields cf
       JOIN asset_types at ON at.id = cf.asset_type_id`,
  ];
  let lastErr = null;
  for (const sql of variants) {
    try {
      const res = await pool.query(sql);
      return (res.rows || []).map((r) => ({
        tenantId: r.tenant_id,
        assetName: r.asset_name,
        isActive: r.is_active !== false,
        fieldName: r.field_name,
        fieldType: r.field_type === 'words' ? 'words' : 'text',
        specType: r.spec_type || null,
        specSource: r.spec_source || null,
        charMin: r.char_min == null ? null : Number(r.char_min),
        charMax: r.char_max == null ? null : Number(r.char_max),
        charMinOverride: r.char_min_override == null ? null : Number(r.char_min_override),
        charMaxOverride: r.char_max_override == null ? null : Number(r.char_max_override),
      }));
    } catch (err) {
      lastErr = err;
      if (isUndefinedColumn(err) || isUndefinedTable(err)) continue;
      throw err;
    }
  }
  if (lastErr && (isUndefinedTable(lastErr) || isUndefinedColumn(lastErr))) return [];
  if (lastErr) throw lastErr;
  return [];
}

// Sweepable projects: not finished, not closed, and carrying a manifest.
//
// THE NULL MANIFEST IS RETURNED, NOT FILTERED OUT, so the caller can COUNT it.
// A project created before scripts/migrateAddProjectFieldManifest.js ran has NULL
// there, and NULL means the contents are UNKNOWN — not empty. The alternative to
// skipping is opening every one of them through the Docs API on every sweep to
// find out, which is a Google read per document per week for a population that
// shrinks to zero on its own as those projects finish. Skipping and reporting the
// number is the honest version; the number is the thing that makes it visible.
async function getSweepableProjects() {
  const pool = getPool();
  if (!pool) return { projects: [], skippedNoManifest: 0 };
  const placeholders = EXCLUDED_STATUSES.map((_, i) => `$${i + 1}`).join(', ');
  const variants = [
    `SELECT id, tenant_id, name, status, copy_doc_id, created_by, field_manifest
       FROM projects
      WHERE (status IS NULL OR status NOT IN (${placeholders}))
        AND copy_doc_id IS NOT NULL`,
    // Pre-created_by database. Losing the acting user means the sweep falls back
    // to the tenant credential, which is the same degradation resolveTenant
    // already has.
    `SELECT id, tenant_id, name, status, copy_doc_id, NULL AS created_by, field_manifest
       FROM projects
      WHERE (status IS NULL OR status NOT IN (${placeholders}))
        AND copy_doc_id IS NOT NULL`,
  ];
  let lastErr = null;
  for (const sql of variants) {
    try {
      const res = await pool.query(sql, EXCLUDED_STATUSES);
      const rows = res.rows || [];
      const projects = [];
      let skippedNoManifest = 0;
      for (const r of rows) {
        if (r.field_manifest == null) {
          skippedNoManifest += 1;
          continue;
        }
        projects.push({
          id: Number(r.id),
          tenantId: r.tenant_id,
          name: r.name || '',
          status: r.status || null,
          copyDocId: r.copy_doc_id,
          createdBy: r.created_by == null ? null : Number(r.created_by),
          manifest: r.field_manifest,
        });
      }
      return { projects, skippedNoManifest };
    } catch (err) {
      lastErr = err;
      if (isUndefinedColumn(err) || isUndefinedTable(err)) continue;
      throw err;
    }
  }
  if (lastErr && (isUndefinedTable(lastErr) || isUndefinedColumn(lastErr))) {
    return { projects: [], skippedNoManifest: 0 };
  }
  if (lastErr) throw lastErr;
  return { projects: [], skippedNoManifest: 0 };
}

// Has this tenant already been told about this change?
//
// Reads the change id off the notification's own link (utils/specNotice.js puts
// it there). Queried DIRECTLY rather than through listNotifications, because that
// function hides anything older than seven days and this question is about what
// was ever written, not about what is currently on show — a change that stalled
// for a fortnight must not be re-announced just because its first notification
// aged out of the panel.
async function hasSpecNotification(tenantId, changeId) {
  const pool = getPool();
  if (!pool || !tenantId || changeId == null) return false;
  try {
    const res = await pool.query(
      `SELECT 1 FROM notifications
        WHERE tenant_id = $1
          AND type = 'spec_change'
          AND link ->> 'changeId' = $2
        LIMIT 1`,
      [tenantId, String(changeId)]
    );
    return res.rows.length > 0;
  } catch (err) {
    if (isUndefinedTable(err) || isUndefinedColumn(err)) return false;
    throw err;
  }
}

// Keep the manifest describing what the document now says.
//
// The manifest's stated job is "what this document was built with", and the
// sweep is the one thing that can make that a lie: after a correction the
// bracket reads 255 and the manifest still says 150. Nothing depends on this —
// candidate selection matches on asset and field NAME only, and the document
// itself decides whether to edit — but leaving a column knowingly stale for the
// next reader to trip over is worse than one UPDATE.
async function updateManifestMax(projectId, { assetType, instance, fieldName, newMax }) {
  const pool = getPool();
  if (!pool || !projectId) return false;
  const norm = (v) => String(v || '').trim().toLowerCase();
  try {
    const res = await pool.query('SELECT field_manifest FROM projects WHERE id = $1', [projectId]);
    const manifest = res.rows[0] && res.rows[0].field_manifest;
    if (!manifest || !Array.isArray(manifest.fields)) return false;
    let touched = false;
    const fields = manifest.fields.map((f) => {
      if (
        norm(f.assetType) === norm(assetType) &&
        (Number(f.instance) || 0) === (Number(instance) || 0) &&
        norm(f.fieldName) === norm(fieldName)
      ) {
        touched = true;
        return { ...f, charMax: Number(newMax) || 0 };
      }
      return f;
    });
    if (!touched) return false;
    await pool.query('UPDATE projects SET field_manifest = $2::jsonb WHERE id = $1', [
      projectId,
      JSON.stringify({ ...manifest, fields }),
    ]);
    return true;
  } catch (err) {
    if (isUndefinedTable(err) || isUndefinedColumn(err)) return false;
    throw err;
  }
}

module.exports = {
  getSweepState,
  setSweepState,
  getChangesSince,
  getLibraryRows,
  getSweepableProjects,
  hasSpecNotification,
  updateManifestMax,
  EXCLUDED_STATUSES,
};
