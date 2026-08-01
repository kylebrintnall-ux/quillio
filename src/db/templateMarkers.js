'use strict';

// The confirmed fields of a document template (rework step one).
//
// A marker row is what a copy_fields row is for an asset: a name, a limit, a
// unit, a note — plus the CELL it lives in, which is what removes the mapping
// step entirely. Nothing reads this yet; the confirm screen writes it.
//
// Same degradation contract as db/assets.js and db/docTemplates.js: with no
// DATABASE_URL every read returns null (meaning "no table here", distinct from
// an empty one) and every write returns false rather than throwing. And the same
// deploy-order tolerance — this table arrives in a migration, Railway
// auto-deploys `main` on merge, so this code runs against a database without it
// first. Every query catches 42P01 and degrades to "not available yet", which is
// what the panel says.

const { getPool, isUndefinedTable, warnMissingSchema } = require('../db');

function rowToMarker(row) {
  return {
    id: String(row.id),
    marker_key: row.marker_key,
    marker_name: row.marker_name,
    is_copy: row.is_copy === true,
    char_min: parseInt(row.char_min, 10) || 0,
    char_max: parseInt(row.char_max, 10) || 0,
    field_type: row.field_type || 'text',
    spec_note: row.spec_note || null,
    sort_order: row.sort_order,
    // The stored position. `part` null means the marker is not in a table.
    part: row.part || null,
    table_index: row.table_index,
    row_index: row.row_index,
    column_index: row.column_index,
    row_span: row.row_span || 1,
    column_span: row.column_span || 1,
    // The self-healing hint — the label cell's text as it read at upload.
    label_text: row.label_text || null,
  };
}

// Every marker on one template, in sort order. null = no DB or no table.
// Tenant-scoped through the join, so a template id from another account yields
// nothing rather than somebody else's fields.
async function listTemplateMarkers(tenantId, templateId) {
  const pool = getPool();
  if (!pool || !tenantId || !templateId) return null;
  try {
    const res = await pool.query(
      `SELECT m.* FROM template_markers m
         JOIN doc_templates t ON t.id = m.template_id
        WHERE m.template_id = $1 AND t.tenant_id = $2
        ORDER BY m.sort_order, m.id`,
      [templateId, tenantId]
    );
    return res.rows.map(rowToMarker);
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('template_markers', 'listTemplateMarkers', err);
      return null;
    }
    throw err;
  }
}

// SAVE the tenant's confirmed answers for one template.
//
// The whole set is submitted at once and replaces what is stored — the same
// whole-object shape the asset editor uses, and for the same reason: a marker
// turned OFF has to be expressible, and a per-marker PATCH cannot say
// "no longer copy" without a second verb.
//
// UPSERT BY (template_id, marker_key), never delete-and-reinsert. A re-uploaded
// template rediscovers its markers; matching on the key is what lets the limits
// and notes a tenant typed survive that.
//
// Returns a discriminated result, like the asset writes:
//   { ok: true, saved }
//   { ok: false, reason: 'not_found' }   — no such template FOR THIS TENANT
//   { ok: false, reason: 'unavailable' } — no DB, or the migration has not run
async function saveTemplateMarkers(tenantId, templateId, markers) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/templateMarkers] DATABASE_URL not set — skipping saveTemplateMarkers');
    return { ok: false, reason: 'unavailable' };
  }
  if (!tenantId || !templateId || !Array.isArray(markers)) return { ok: false, reason: 'not_found' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ownership is checked against the STORED row, and the row is locked — two
    // tabs confirming the same template must not interleave their upserts.
    const tpl = await client.query(
      'SELECT id FROM doc_templates WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [templateId, tenantId]
    );
    if (tpl.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }

    let saved = 0;
    for (const [i, m] of markers.entries()) {
      const key = m && m.marker_key ? String(m.marker_key).trim() : '';
      if (!key) continue;
      // Columns named one by one — nothing off the request reaches a column that
      // is not listed here. Same rule every other write in this codebase follows.
      await client.query(
        `INSERT INTO template_markers
           (template_id, marker_key, marker_name, is_copy, char_min, char_max,
            field_type, spec_note, sort_order, part, table_index, row_index,
            column_index, row_span, column_span, label_text, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         ON CONFLICT (template_id, marker_key) DO UPDATE SET
           marker_name = EXCLUDED.marker_name,
           is_copy     = EXCLUDED.is_copy,
           char_min    = EXCLUDED.char_min,
           char_max    = EXCLUDED.char_max,
           field_type  = EXCLUDED.field_type,
           spec_note   = EXCLUDED.spec_note,
           sort_order  = EXCLUDED.sort_order,
           updated_at  = now()`,
        // The POSITION is deliberately absent from the DO UPDATE list. It comes
        // from reading the document, never from the browser — a confirm screen
        // that could move a marker to a different cell would be a way to point a
        // field at the wrong column with no way to notice.
        [
          templateId,
          key,
          String(m.marker_name || key).slice(0, 200),
          m.is_copy === true,
          Math.max(0, parseInt(m.char_min, 10) || 0),
          Math.max(0, parseInt(m.char_max, 10) || 0),
          m.field_type === 'words' ? 'words' : 'text',
          m.spec_note ? String(m.spec_note).slice(0, 400) : null,
          Number.isFinite(parseInt(m.sort_order, 10)) ? parseInt(m.sort_order, 10) : i,
          m.part || null,
          m.table_index == null ? null : parseInt(m.table_index, 10),
          m.row_index == null ? null : parseInt(m.row_index, 10),
          m.column_index == null ? null : parseInt(m.column_index, 10),
          parseInt(m.row_span, 10) || 1,
          parseInt(m.column_span, 10) || 1,
          m.label_text ? String(m.label_text).slice(0, 200) : null,
        ]
      );
      saved += 1;
    }

    await client.query('COMMIT');
    console.log(`[db/templateMarkers] tenant ${tenantId} template ${templateId} — ${saved} marker(s) saved`);
    return { ok: true, saved };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (isUndefinedTable(err)) {
      warnMissingSchema('template_markers', 'saveTemplateMarkers', err);
      return { ok: false, reason: 'unavailable' };
    }
    throw err;
  } finally {
    client.release();
  }
}

// Seed a freshly-uploaded template's markers from what the reader proposed.
// Never overwrites: ON CONFLICT DO NOTHING, so re-uploading a template that
// already has confirmed rows leaves the tenant's answers alone and only adds
// markers that are new.
//
// Returns the number of rows inserted, or 0 when there is nowhere to write.
async function seedTemplateMarkers(templateId, derived) {
  const pool = getPool();
  if (!pool || !templateId || !Array.isArray(derived) || derived.length === 0) return 0;
  try {
    let inserted = 0;
    for (const [i, d] of derived.entries()) {
      const pos = d.position || {};
      const res = await pool.query(
        `INSERT INTO template_markers
           (template_id, marker_key, marker_name, is_copy, char_min, char_max,
            field_type, spec_note, sort_order, part, table_index, row_index,
            column_index, row_span, column_span, label_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (template_id, marker_key) DO NOTHING`,
        [
          templateId,
          d.key,
          d.name,
          d.isCopy === true,
          d.charMin || 0,
          d.charMax || 0,
          d.fieldType === 'words' ? 'words' : 'text',
          d.specNote || null,
          i,
          pos.part || null,
          pos.tableIndex == null ? null : pos.tableIndex,
          pos.row == null ? null : pos.row,
          pos.column == null ? null : pos.column,
          pos.rowSpan || 1,
          pos.columnSpan || 1,
          d.labelText || null,
        ]
      );
      inserted += res.rowCount;
    }
    console.log(`[db/templateMarkers] template ${templateId} seeded — ${inserted} marker row(s) proposed`);
    return inserted;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('template_markers', 'seedTemplateMarkers', err);
      return 0;
    }
    // A seed failure must never fail an upload — the document imported fine and
    // the markers are still in doc_templates.placeholders. The confirm screen
    // will simply have nothing proposed until the next upload.
    console.error(`[db/templateMarkers] seed failed for template ${templateId}: ${err.message}`);
    return 0;
  }
}

module.exports = { listTemplateMarkers, saveTemplateMarkers, seedTemplateMarkers };
