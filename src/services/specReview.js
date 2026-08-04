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
//
// ACTIVE ROWS ONLY. Deactivating an asset type is how this schema removes one
// (db/assets.js; there is no DELETE FROM asset_types anywhere), and an inactive
// row is invisible to every doc — getTenantAssets filters on is_active, so its
// values cannot reach a brief, a draft or a review. Counting it here would
// inflate tenant_count and pad the divergence breakdown with tenants who are not
// actually affected, and that breakdown exists precisely so an admin can see
// whether tenants already disagree before deciding what to type. A number that
// includes dead rows is a number that lies about the blast radius.
//
// This is the ONLY read in this file that joins asset_types, and all four
// callers (getFlagForReview, buildPreview, commitReview's `before` capture, and
// getSuggestions) go through it — which is why the filter belongs here and not
// at each call site. The UPDATE in commitReview carries the same predicate.
//
// Inert today: nothing retired so far has a tiered field, so no pair reachable
// through affected_fields has an inactive row behind it. This is the guard for
// the next retirement, not a fix for a live miscount.
async function currentValues(runner, asset, field) {
  const res = await runner.query(
    'SELECT at.tenant_id, cf.char_max, cf.spec_note' +
      '  FROM copy_fields cf' +
      '  JOIN asset_types at ON at.id = cf.asset_type_id' +
      ' WHERE at.name = $1 AND cf.field_name = $2' +
      '   AND at.is_active' +
      ' ORDER BY at.tenant_id',
    [asset, field]
  );
  return res.rows;
}

// Distinct current value of one attribute across tenant rows, as a string for
// the diff/log. Usually a single value; if tenants somehow differ, joins them.
function distinctValue(rows, attr) {
  const vals = Array.from(new Set(rows.map((r) => rowValue(r, attr))));
  return vals.join(' | ');
}

// One row's value of an attribute, normalized to the string form used for
// comparison, grouping and logging. null/undefined collapse to '' so an unset
// spec_note and an empty one are not reported as two different values.
function rowValue(row, attr) {
  const v = row && row[attr];
  return v === null || v === undefined ? '' : String(v);
}

// Group the per-tenant rows for one (asset, field, attr) by the value they
// currently hold.
//
// WHY THIS EXISTS. The write below (commitReview) matches copy_fields by asset
// name and field name with NO tenant predicate, so ONE admin approval rewrites
// every tenant's row. distinctValue already knew when tenants disagreed — it
// joins them into "150 | 200" — but a joined string is not a fact an admin can
// act on: it does not say how many tenants sit on each value, or which ones.
// This turns that string into the breakdown, so divergence is visible BEFORE the
// write rather than inferred from a suspicious-looking diff.
//
// `expected` is the value the most rows hold — the curated value the library was
// seeded with, in every normal case. Everything else is divergence: a tenant
// whose row was changed by an earlier approval they have since moved away from,
// or (once tenants can edit their own limits) a deliberate local edit this write
// is about to revert. Ties break on the first value seen, which is the lowest
// tenant_id because currentValues orders by tenant_id — deterministic, so the
// same state always previews the same way.
//
// Pure: takes rows, returns a plain object. No I/O, no pool.
function tenantValueBreakdown(rows, attr) {
  const byValue = new Map(); // value -> { value, tenants: [], row_count }
  for (const r of rows || []) {
    const value = rowValue(r, attr);
    if (!byValue.has(value)) byValue.set(value, { value, tenants: [], row_count: 0 });
    const entry = byValue.get(value);
    entry.row_count += 1;
    const tenantId = r && r.tenant_id != null ? String(r.tenant_id) : '(unknown)';
    if (!entry.tenants.includes(tenantId)) entry.tenants.push(tenantId);
  }
  const groups = Array.from(byValue.values());
  if (groups.length === 0) {
    return { expected: '', expected_row_count: 0, divergent_row_count: 0, divergent: [], diverged: false };
  }
  // Most rows wins; first-seen (lowest tenant_id) breaks a tie.
  let expectedGroup = groups[0];
  for (const g of groups) {
    if (g.row_count > expectedGroup.row_count) expectedGroup = g;
  }
  const divergent = groups
    .filter((g) => g !== expectedGroup)
    .sort((a, b) => b.row_count - a.row_count || (a.value < b.value ? -1 : 1));
  return {
    expected: expectedGroup.value,
    expected_row_count: expectedGroup.row_count,
    divergent_row_count: divergent.reduce((n, g) => n + g.row_count, 0),
    divergent,
    diverged: divergent.length > 0,
  };
}

// The rows whose value this write actually CHANGES, from the pre-write snapshot.
// One entry per row, carrying the tenant and the value it held. Rows already on
// the new value are excluded — they are being re-stamped, not overwritten, and
// reporting them would hide the ones that matter.
//
// `diverged` separates the two kinds of overwrite, which is the distinction the
// admin actually needs: false is a routine update of a row that held the same
// value as everyone else, true means this row held something DIFFERENT and that
// value is now gone. Only the second kind is a tenant's own state being reverted.
// Pure.
function changedRows(before, attr, newValue) {
  const next = newValue === null || newValue === undefined ? '' : String(newValue);
  const { expected } = tenantValueBreakdown(before, attr);
  const out = [];
  for (const r of before || []) {
    const old = rowValue(r, attr);
    if (old === next) continue;
    out.push({
      tenant_id: r && r.tenant_id != null ? String(r.tenant_id) : '(unknown)',
      attr,
      old_value: old,
      new_value: next,
      diverged: old !== expected,
    });
  }
  return out;
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
      // Same breakdown the preview carries, on the form that precedes it — so an
      // admin can see tenants already disagree before deciding what to type.
      char_max_divergence: tenantValueBreakdown(rows, 'char_max'),
      spec_note_divergence: tenantValueBreakdown(rows, 'spec_note'),
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
    // Each change carries `divergence`: which tenants hold the expected value,
    // which hold something else, and what those other values are. `old` (the
    // joined "150 | 200" string) is kept alongside it unchanged — it is what the
    // audit log records and what an existing caller reads.
    if (e.charMax !== undefined) {
      changes.push({
        asset: e.asset,
        field: e.field,
        attr: 'char_max',
        old: distinctValue(rows, 'char_max'),
        new: String(e.charMax),
        tenant_count: rows.length,
        divergence: tenantValueBreakdown(rows, 'char_max'),
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
        divergence: tenantValueBreakdown(rows, 'spec_note'),
      });
    }
  }

  // A preview-level roll-up so the admin sees "this write touches rows that do
  // not all agree" without reading every row of the table first.
  const divergentChanges = changes.filter((c) => c.divergence && c.divergence.diverged);
  if (divergentChanges.length > 0) {
    console.warn(
      `[specReview] preview flag=${guard.flag.id}: ${divergentChanges.length} field(s) diverge across tenants — ` +
        divergentChanges
          .map(
            (c) =>
              `${c.asset}/${c.field}.${c.attr} expected="${c.divergence.expected}" ` +
              `(${c.divergence.expected_row_count} row(s)), ` +
              c.divergence.divergent
                .map((d) => `"${d.value}" on ${d.tenants.join(',')}`)
                .join('; ')
          )
          .join(' | ')
    );
  }

  return {
    ok: true,
    flagId: guard.flag.id,
    source_url: guard.flag.source_url,
    display_name: guard.flag.display_name,
    changes,
    diverged: divergentChanges.length > 0,
    divergent_field_count: divergentChanges.length,
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

      // `AND at.is_active` matches currentValues above, and the two must stay in
      // step: `before` was captured through that helper, so a write reaching a
      // row the capture skipped would report an overwrite nobody could have seen
      // coming — and would log a spec_change_log entry for a row no doc reads.
      // Deliberately still no TENANT predicate: one platform changing a limit
      // for everyone at once is the designed behaviour, not an oversight.
      const upd = await client.query(
        'UPDATE copy_fields cf' +
          '   SET ' + sets.join(', ') +
          '  FROM asset_types at' +
          ' WHERE cf.asset_type_id = at.id' +
          '   AND at.name = $' + assetIdx +
          '   AND cf.field_name = $' + fieldIdx +
          '   AND at.is_active' +
          ' RETURNING at.tenant_id',
        params
      );
      const tenantCount = upd.rowCount;

      // WHO JUST GOT OVERWRITTEN. The UPDATE above has no tenant predicate, so it
      // rewrote every tenant's row for this (asset, field) — including any tenant
      // holding a different value from the rest. `before` was captured inside the
      // transaction, so this is exactly what each of them held a moment ago.
      //
      // Only rows whose VALUE actually changed are reported: the write also
      // stamps spec_verified_at on every matched row, and calling a re-stamp an
      // overwrite would bury the real ones in noise.
      const overwritten = [];
      if (e.charMax !== undefined) {
        overwritten.push(...changedRows(before, 'char_max', String(e.charMax)));
      }
      if (e.specNote !== undefined) {
        overwritten.push(...changedRows(before, 'spec_note', e.specNote));
      }
      if (overwritten.length > 0) {
        console.warn(
          `[specReview] commit flag=${flag.id} "${e.asset} / ${e.field}": overwrote ${overwritten.length} row(s) ` +
            `(${overwritten.filter((o) => o.diverged).length} of them holding a DIVERGENT value) — ` +
            overwritten
              .map(
                (o) =>
                  `tenant ${o.tenant_id} ${o.attr} "${o.old_value}" -> "${o.new_value}"` +
                  (o.diverged ? ' [diverged]' : '')
              )
              .join('; ')
        );
      }

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
        // The audit trail for the silent half of this write: every row that held
        // something other than what we just set, and what it held. Empty on the
        // normal path where all tenants already agreed.
        overwritten,
      });
    }

    // Flip the flag to reviewed (only after every write above succeeded).
    await client.query("UPDATE spec_review_queue SET status = 'reviewed' WHERE id = $1", [flag.id]);

    await client.query('COMMIT');
    // Roll-up across every field in this approval, so one line in the log says
    // whether this write reverted anybody.
    const overwrittenTotal = written.reduce((n, w) => n + w.overwritten.length, 0);
    const divergedTotal = written.reduce((n, w) => n + w.overwritten.filter((o) => o.diverged).length, 0);
    console.log(
      `[specReview] commit flag=${flag.id} wrote ${written.length} field(s), ` +
        `${written.reduce((n, w) => n + w.tenant_count, 0)} row(s); ` +
        `${overwrittenTotal} row(s) held a different value and were overwritten, ` +
        `${divergedTotal} of which had diverged from the rest`
    );
    return {
      ok: true,
      flagId: flag.id,
      flagStatus: 'reviewed',
      written,
      overwritten_count: overwrittenTotal,
      diverged_overwritten_count: divergedTotal,
    };
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

module.exports = {
  getFlagForReview,
  getSuggestions,
  buildPreview,
  commitReview,
  dismiss,
  // exposed for unit tests — both are pure and carry the divergence reporting
  tenantValueBreakdown,
  changedRows,
};
