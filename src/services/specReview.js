'use strict';

// LiveSpecs review + approve-to-write service (chunk 3a). This is the ONLY place
// that writes to copy_fields -- the production spec data every doc depends on.
//
// Every write is gated behind:
//   1. is_test hard-block -- a test flag can NEVER write copy_fields (dismiss only).
//   2. affected-pair check -- an edit must target a (asset,field) pair listed in
//      the flag's watch entry's affected_fields (no arbitrary field writes).
//   3. server-side validation -- char_max positive int, spec_note non-empty.
//   4. a two-step flow -- buildPreview() computes the diff and writes NOTHING;
//      commitReview() re-validates and writes, only when the route calls it after
//      the admin's explicit second confirm.
//
// commitReview does the value write, the spec_verified_at stamp, the audit log,
// and the flag status flip in ONE transaction across ALL tenant rows for each
// field -- all-or-nothing.

const { getPool } = require('../db');
const { fetchText, normalize } = require('./specDetector');
const { extractSpecValues } = require('./gemini');

// A field name repeats across assets, so always match the (asset, field) PAIR.
function pairKey(asset, field) {
  return String(asset) + ' ' + String(field);
}

// Parse the affected_fields JSONB (already an array of {asset, field}) into a
// Set of pair keys for membership checks.
function affectedPairSet(affectedFields) {
  const set = new Set();
  if (Array.isArray(affectedFields)) {
    for (const p of affectedFields) {
      if (p && p.asset && p.field) set.add(pairKey(p.asset, p.field));
    }
  }
  return set;
}

// Validate one edit's typed values. Returns { errors, charMax, specNote }. An
// edit must carry at least one attribute.
function validateEdit(edit) {
  const errors = [];
  let charMax;
  let specNote;

  const hasCharMax = edit.char_max !== undefined && edit.char_max !== null && edit.char_max !== '';
  const hasSpecNote = edit.spec_note !== undefined && edit.spec_note !== null;

  if (hasCharMax) {
    const n = Number(edit.char_max);
    if (!Number.isInteger(n) || n <= 0 || n > 100000) {
      errors.push('char_max for "' + edit.asset + ' / ' + edit.field + '" must be a positive integer');
    } else {
      charMax = n;
    }
  }
  if (hasSpecNote) {
    const s = String(edit.spec_note).trim();
    if (s.length === 0 || s.length > 2000) {
      errors.push('spec_note for "' + edit.asset + ' / ' + edit.field + '" must be 1-2000 chars');
    } else {
      specNote = s;
    }
  }
  if (charMax === undefined && specNote === undefined) {
    errors.push('no new value provided for "' + edit.asset + ' / ' + edit.field + '"');
  }
  return { errors, charMax, specNote };
}

// Current per-tenant values for a (asset, field) pair. Uses a supplied runner
// (pool or transaction client).
async function currentValues(runner, asset, field) {
  const res = await runner.query(
    'SELECT at.tenant_id, cf.char_max, cf.spec_note' +
      '  FROM copy_fields cf' +
      '  JOIN asset_types at ON at.id = cf.asset_type_id' +
      ' WHERE at.name = $1 AND cf.field_name = $2' +
      ' ORDER BY at.tenant_id',
    [asset, field]
  );
  return res.rows;
}

// Distinct current value of one attribute across tenant rows, as a string for
// the diff/log. Usually a single value; if tenants somehow differ, joins them.
function distinctValue(rows, attr) {
  const vals = Array.from(
    new Set(rows.map((r) => (r[attr] === null || r[attr] === undefined ? '' : String(r[attr]))))
  );
  return vals.join(' | ');
}

// Load a flag joined to its watch entry (display_name, source_url, affected
// fields, is_test). Returns null if not found.
async function loadFlag(runner, flagId) {
  const res = await runner.query(
    'SELECT q.id, q.watch_id, q.source_url, q.old_hash, q.new_hash, q.status, q.is_test,' +
      '       q.detected_at, w.display_name, w.affected_fields' +
      '  FROM spec_review_queue q' +
      '  JOIN spec_watch_list w ON w.id = q.watch_id' +
      ' WHERE q.id = $1',
    [flagId]
  );
  return (res.rows && res.rows[0]) || null;
}

// Public: the flag plus every affected (asset,field) with its current values,
// to render the approve form. Read-only.
async function getFlagForReview(flagId) {
  const pool = getPool();
  if (!pool) return null;
  const flag = await loadFlag(pool, flagId);
  if (!flag) return null;

  const fields = [];
  const pairs = Array.isArray(flag.affected_fields) ? flag.affected_fields : [];
  for (const p of pairs) {
    if (!p || !p.asset || !p.field) continue;
    const rows = await currentValues(pool, p.asset, p.field);
    fields.push({
      asset: p.asset,
      field: p.field,
      tenant_count: rows.length,
      current_char_max: distinctValue(rows, 'char_max'),
      current_spec_note: distinctValue(rows, 'spec_note'),
    });
  }

  return {
    id: flag.id,
    watch_id: flag.watch_id,
    display_name: flag.display_name,
    source_url: flag.source_url,
    is_test: flag.is_test,
    status: flag.status,
    detected_at: flag.detected_at,
    fields,
  };
}

// Shared guard: load the flag, block test flags and non-pending flags, and check
// every edit targets an affected pair + passes validation. Returns { ok, error }
// or { ok:true, flag, edits }.
async function guardEdits(runner, flagId, edits) {
  const flag = await loadFlag(runner, flagId);
  if (!flag) return { ok: false, error: 'flag not found' };
  if (flag.is_test) return { ok: false, error: 'test flags cannot be approved -- dismiss only' };
  if (flag.status !== 'pending') return { ok: false, error: 'flag is already ' + flag.status };

  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'no fields selected for update' };
  }

  const allowed = affectedPairSet(flag.affected_fields);
  const clean = [];
  const errors = [];
  for (const edit of edits) {
    if (!edit || !edit.asset || !edit.field) {
      errors.push('an edit is missing asset/field');
      continue;
    }
    if (!allowed.has(pairKey(edit.asset, edit.field))) {
      errors.push('"' + edit.asset + ' / ' + edit.field + '" is not an affected field of this flag');
      continue;
    }
    const v = validateEdit(edit);
    for (const e of v.errors) errors.push(e);
    if (v.errors.length === 0) {
      clean.push({ asset: edit.asset, field: edit.field, charMax: v.charMax, specNote: v.specNote });
    }
  }
  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, flag, edits: clean };
}

// Build the diff preview for the checked fields. Writes NOTHING.
async function buildPreview(flagId, edits) {
  const pool = getPool();
  if (!pool) return { ok: false, error: 'no database' };

  const guard = await guardEdits(pool, flagId, edits);
  if (!guard.ok) return guard;

  const changes = [];
  for (const e of guard.edits) {
    const rows = await currentValues(pool, e.asset, e.field);
    if (e.charMax !== undefined) {
      changes.push({
        asset: e.asset,
        field: e.field,
        attr: 'char_max',
        old: distinctValue(rows, 'char_max'),
        new: String(e.charMax),
        tenant_count: rows.length,
      });
    }
    if (e.specNote !== undefined) {
      changes.push({
        asset: e.asset,
        field: e.field,
        attr: 'spec_note',
        old: distinctValue(rows, 'spec_note'),
        new: e.specNote,
        tenant_count: rows.length,
      });
    }
  }

  return {
    ok: true,
    flagId: guard.flag.id,
    source_url: guard.flag.source_url,
    display_name: guard.flag.display_name,
    changes,
  };
}

// Commit the checked edits: value write + spec_verified_at stamp + audit log +
// flag status flip, ALL in one transaction across every tenant row per field.
async function commitReview(flagId, edits, changedBy) {
  const pool = getPool();
  if (!pool) return { ok: false, error: 'no database' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const guard = await guardEdits(client, flagId, edits);
    if (!guard.ok) {
      await client.query('ROLLBACK');
      return guard;
    }
    const flag = guard.flag;
    const written = [];

    for (const e of guard.edits) {
      // Capture old values (inside the txn) for the log.
      const before = await currentValues(client, e.asset, e.field);

      // Build the SET clause from whichever attributes were provided, and always
      // stamp spec_verified_at. One UPDATE per field -> all tenant rows for the
      // (asset,field) pair move together.
      const sets = [];
      const params = [];
      if (e.charMax !== undefined) {
        params.push(e.charMax);
        sets.push('char_max = $' + params.length);
      }
      if (e.specNote !== undefined) {
        params.push(e.specNote);
        sets.push('spec_note = $' + params.length);
      }
      sets.push('spec_verified_at = NOW()');
      params.push(e.asset);
      const assetIdx = params.length;
      params.push(e.field);
      const fieldIdx = params.length;

      const upd = await client.query(
        'UPDATE copy_fields cf' +
          '   SET ' + sets.join(', ') +
          '  FROM asset_types at' +
          ' WHERE cf.asset_type_id = at.id' +
          '   AND at.name = $' + assetIdx +
          '   AND cf.field_name = $' + fieldIdx +
          ' RETURNING at.tenant_id',
        params
      );
      const tenantCount = upd.rowCount;

      // Audit log -- one row per changed attribute.
      if (e.charMax !== undefined) {
        await client.query(
          'INSERT INTO spec_change_log' +
            ' (flag_id, asset_type, field_name, field_attr, old_value, new_value, tenant_count, source_url, changed_by)' +
            " VALUES ($1,$2,$3,'char_max',$4,$5,$6,$7,$8)",
          [flag.id, e.asset, e.field, distinctValue(before, 'char_max'), String(e.charMax), tenantCount, flag.source_url, changedBy || null]
        );
      }
      if (e.specNote !== undefined) {
        await client.query(
          'INSERT INTO spec_change_log' +
            ' (flag_id, asset_type, field_name, field_attr, old_value, new_value, tenant_count, source_url, changed_by)' +
            " VALUES ($1,$2,$3,'spec_note',$4,$5,$6,$7,$8)",
          [flag.id, e.asset, e.field, distinctValue(before, 'spec_note'), e.specNote, tenantCount, flag.source_url, changedBy || null]
        );
      }

      written.push({
        asset: e.asset,
        field: e.field,
        tenant_count: tenantCount,
        char_max: e.charMax,
        spec_note: e.specNote,
      });
    }

    // Flip the flag to reviewed (only after every write above succeeded).
    await client.query("UPDATE spec_review_queue SET status = 'reviewed' WHERE id = $1", [flag.id]);

    await client.query('COMMIT');
    return { ok: true, flagId: flag.id, flagStatus: 'reviewed', written };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[specReview] commit failed, rolled back:', err.message);
    return { ok: false, error: 'write failed -- rolled back, nothing changed' };
  } finally {
    client.release();
  }
}

// Chunk 3b: suggest a new char_max per affected field by reading the changed
// page. Re-fetches source_url, normalizes it, and asks Gemini for the limit each
// field's page states -- returning a per-field suggestion + supporting snippet.
// SUGGESTION ONLY: this never writes anything. A test flag returns no suggestions
// (it can't be approved); a fetch/model failure degrades to empty (manual entry).
// Suggestions map back to fields by `ref` (index), so repeated field names across
// assets can't cross-wire.
async function getSuggestions(flagId) {
  const pool = getPool();
  if (!pool) return { ok: false, error: 'no database' };
  const flag = await loadFlag(pool, flagId);
  if (!flag) return { ok: false, error: 'flag not found' };
  if (flag.is_test) return { ok: false, error: 'test flags cannot be approved -- no suggestions' };

  const pairs = Array.isArray(flag.affected_fields) ? flag.affected_fields : [];
  const fields = [];
  for (const p of pairs) {
    if (!p || !p.asset || !p.field) continue;
    const rows = await currentValues(pool, p.asset, p.field);
    fields.push({ asset: p.asset, field: p.field, current_char_max: distinctValue(rows, 'char_max') });
  }
  if (fields.length === 0) return { ok: true, suggestions: [], note: 'no affected fields' };

  let pageText = '';
  try {
    pageText = normalize(await fetchText(flag.source_url));
  } catch (err) {
    return { ok: true, suggestions: [], note: 'could not fetch page: ' + err.message };
  }

  const raw = await extractSpecValues({ pageText, fields });
  const byRef = new Map();
  for (const s of raw) byRef.set(s.ref, s);

  const suggestions = fields.map((f, i) => {
    const s = byRef.get(i) || {};
    return {
      asset: f.asset,
      field: f.field,
      current_char_max: f.current_char_max,
      suggested_char_max: s.suggested_char_max != null ? s.suggested_char_max : null,
      snippet: s.snippet || '',
      confidence: s.confidence || 'low',
    };
  });
  return { ok: true, suggestions };
}

// Dismiss a flag (false positive / nothing real changed). Touches ONLY the queue
// status -- never copy_fields. Allowed for any flag, including test flags.
async function dismiss(flagId) {
  const pool = getPool();
  if (!pool) return { ok: false, error: 'no database' };
  const res = await pool.query(
    "UPDATE spec_review_queue SET status = 'dismissed' WHERE id = $1 AND status = 'pending' RETURNING id",
    [flagId]
  );
  if (!res.rowCount) return { ok: false, error: 'flag not found or not pending' };
  return { ok: true, flagId: flagId, status: 'dismissed' };
}

module.exports = { getFlagForReview, getSuggestions, buildPreview, commitReview, dismiss };
