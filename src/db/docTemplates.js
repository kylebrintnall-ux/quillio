'use strict';

// Storage for tenant-uploaded template documents (custom document types, step
// one). Deliberately thin: save one, list a tenant's, read one back. No mapping,
// no defaults, no asset link — see scripts/migrateAddDocTemplates.js for why.
//
// Same degradation contract as db/assets.js: with no DATABASE_URL every read
// returns null (meaning "no library here", distinct from an empty one) and every
// write returns null rather than throwing, so the demo path keeps working.
//
// And the same deploy-order tolerance the rest of the schema has: this table
// arrives in a migration, Railway auto-deploys `main` on merge, so this code runs
// against a database without it first. Every query catches 42P01 (undefined_table)
// and degrades to "no templates" instead of 500ing the settings page.

const { getPool, isUndefinedTable, warnMissingSchema } = require('../db');

function rowToTemplate(row) {
  return {
    id: String(row.id),
    name: row.name,
    source_doc_id: row.source_doc_id,
    source_doc_url: row.source_doc_url,
    original_filename: row.original_filename,
    placeholders: Array.isArray(row.placeholders) ? row.placeholders : [],
    discovered_at: row.discovered_at,
    created_at: row.created_at,
  };
}

// Every template this tenant has uploaded, newest first. null = no DB / no table.
async function listDocTemplates(tenantId) {
  const pool = getPool();
  if (!pool || !tenantId) return null;
  try {
    const res = await pool.query(
      `SELECT id, name, source_doc_id, source_doc_url, original_filename,
              placeholders, discovered_at, created_at
         FROM doc_templates
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC`,
      [tenantId]
    );
    return res.rows.map(rowToTemplate);
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('doc_templates', 'listDocTemplates', err);
      return null;
    }
    throw err;
  }
}

// Save one imported template + its discovered placeholders. Returns the new id,
// or null when there is nowhere to save it.
async function saveDocTemplate(tenantId, template) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/docTemplates] DATABASE_URL not set — skipping saveDocTemplate');
    return null;
  }
  if (!tenantId || !template || !template.source_doc_id) return null;
  try {
    // Columns named one by one, the same rule the asset writes follow: nothing
    // from the request reaches a column that is not listed here.
    const res = await pool.query(
      `INSERT INTO doc_templates
         (tenant_id, name, source_doc_id, source_doc_url, original_filename,
          placeholders, discovered_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), $7)
       RETURNING id`,
      [
        tenantId,
        template.name,
        template.source_doc_id,
        template.source_doc_url || null,
        template.original_filename || null,
        JSON.stringify(Array.isArray(template.placeholders) ? template.placeholders : []),
        template.created_by || null,
      ]
    );
    const id = String(res.rows[0].id);
    console.log(
      `[db/docTemplates] tenant ${tenantId} saved template ${id} "${template.name}" ` +
        `(${(template.placeholders || []).length} placeholder(s))`
    );
    return id;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('doc_templates', 'saveDocTemplate', err);
      return null;
    }
    throw err;
  }
}

// Read ONE template, scoped to the tenant. null = no DB, no table, or not
// theirs — the caller answers 404 for all three, because distinguishing "does
// not exist" from "is not yours" confirms an id in someone else's account.
async function getDocTemplate(tenantId, id) {
  const pool = getPool();
  if (!pool || !tenantId || !id) return null;
  try {
    const res = await pool.query(
      `SELECT id, name, source_doc_id, source_doc_url, original_filename,
              placeholders, discovered_at, created_at
         FROM doc_templates
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return res.rows.length ? rowToTemplate(res.rows[0]) : null;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('doc_templates', 'getDocTemplate', err);
      return null;
    }
    throw err;
  }
}

// RENAME one template. The upload takes its name from the filename, which is how
// a tenant ends up with "copy-matrix-template-v4-FINAL" in a settings panel they
// read every week. Only the display name is writable — the imported doc, the
// discovered markers and the mapping all key off the id, so a rename touches
// nothing but the label.
//
// Returns true when a row changed, false when nothing matched THIS TENANT.
async function renameDocTemplate(tenantId, id, name) {
  const pool = getPool();
  if (!pool || !tenantId || !id) return false;
  const clean = String(name == null ? '' : name).trim().slice(0, 120);
  if (!clean) return false;
  try {
    const res = await pool.query(
      'UPDATE doc_templates SET name = $1 WHERE id = $2 AND tenant_id = $3',
      [clean, id, tenantId]
    );
    return res.rowCount > 0;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('doc_templates', 'renameDocTemplate', err);
      return false;
    }
    throw err;
  }
}

module.exports = { listDocTemplates, saveDocTemplate, getDocTemplate, renameDocTemplate };
