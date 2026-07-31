'use strict';

// Per-tenant asset library (Phase 3 / Week 7). Seeds a new tenant's
// asset_types + copy_fields from the bundled default library, and reads them
// back. All operations degrade gracefully when DATABASE_URL is unset (no pg) —
// seedTenantAssets returns false, getTenantAssets returns null — so the
// single-tenant demo and tests run unchanged.
//
// IMPORTANT: this IS the pipeline's spec source. The Google Sheet was fully
// retired (services/sheets.js no longer exists), so there is no fallback —
// core/pipeline.js generateDoc() THROWS when getTenantAssets returns null or an
// empty library. A null here means "no DB or unseeded tenant", not "fall back".

const { getPool } = require('../db');
const { DEFAULT_ASSETS } = require('../data/defaultAssets');
const { normalize } = require('../utils/normalize');

// Seed the default asset library into a tenant. Idempotent: if the tenant
// already has any asset_types rows we skip entirely (there's no unique
// (tenant_id, name) constraint to ON CONFLICT against, so we guard at the
// tenant level). Runs in a transaction so a partial seed never persists.
//
// Returns true if rows were inserted, false if there's no DB or the tenant was
// already seeded.
async function seedTenantAssets(tenantId) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/assets] DATABASE_URL not set — skipping seedTenantAssets');
    return false;
  }
  if (!tenantId) {
    console.warn('[db/assets] seedTenantAssets called without a tenantId — skipping');
    return false;
  }

  const client = await pool.connect();
  try {
    // Idempotency guard: bail if this tenant already has any asset types.
    const existing = await client.query(
      'SELECT 1 FROM asset_types WHERE tenant_id = $1 LIMIT 1',
      [tenantId]
    );
    if (existing.rows.length > 0) {
      console.log(`[db/assets] tenant ${tenantId} already has assets — skipping seed`);
      return false;
    }

    await client.query('BEGIN');
    for (const asset of DEFAULT_ASSETS) {
      const typeRes = await client.query(
        `INSERT INTO asset_types (tenant_id, name, "group", is_active, sort_order, asset_direction, spec_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          tenantId,
          asset.name,
          asset.group,
          asset.is_active,
          asset.sort_order,
          asset.asset_direction || null,
          asset.spec_note || null,
        ]
      );
      const assetTypeId = typeRes.rows[0].id;

      for (const field of asset.fields) {
        await client.query(
          `INSERT INTO copy_fields
             (asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_source, spec_version, group_label, spec_note, spec_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            assetTypeId,
            field.field_name,
            field.char_min,
            field.char_max,
            field.field_type,
            field.sort_order,
            field.spec_source || asset.spec_source,
            asset.spec_version,
            field.group_label || null,
            field.spec_note || null,
            field.spec_type || null,
          ]
        );
      }
    }
    await client.query('COMMIT');
    console.log(`[db/assets] seeded ${DEFAULT_ASSETS.length} asset types for tenant ${tenantId}`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Read a tenant's active asset library — active asset_types in sort_order, each
// with its copy_fields in sort_order. Returns null if there's no DB or the
// tenant has no active assets; there is no Sheet fallback, so generateDoc()
// turns that null into a thrown error. Shape per type:
//   { id, name, group, sort_order, fields: [{ field_name, char_min, char_max,
//     field_type, sort_order, spec_source, spec_version, group_label, spec_note,
//     spec_type }, …] }
async function getTenantAssets(tenantId) {
  const pool = getPool();
  if (!pool || !tenantId) return null;

  const typesRes = await pool.query(
    `SELECT id, name, "group", sort_order, asset_direction, spec_note
       FROM asset_types
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY sort_order, id`,
    [tenantId]
  );
  if (typesRes.rows.length === 0) return null;

  const typeIds = typesRes.rows.map((t) => t.id);
  const fieldsRes = await pool.query(
    `SELECT asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_source, spec_version, group_label, spec_note, spec_type
       FROM copy_fields
      WHERE asset_type_id = ANY($1::bigint[])
      ORDER BY sort_order, id`,
    [typeIds]
  );

  const fieldsByType = new Map();
  for (const row of fieldsRes.rows) {
    if (!fieldsByType.has(row.asset_type_id)) fieldsByType.set(row.asset_type_id, []);
    fieldsByType.get(row.asset_type_id).push({
      field_name: row.field_name,
      char_min: row.char_min,
      char_max: row.char_max,
      field_type: row.field_type,
      sort_order: row.sort_order,
      spec_source: row.spec_source,
      spec_version: row.spec_version,
      group_label: row.group_label || null,
      spec_note: row.spec_note || null,
      spec_type: row.spec_type || null,
    });
  }

  return typesRes.rows.map((t) => ({
    id: t.id,
    name: t.name,
    group: t.group,
    sort_order: t.sort_order,
    asset_direction: t.asset_direction || null,
    spec_note: t.spec_note || null,
    fields: fieldsByType.get(t.id) || [],
  }));
}

// THE EDITOR READ. Every asset a tenant has — ACTIVE AND INACTIVE — with stable
// ids on both the asset and each of its fields.
//
// Deliberately NOT getTenantAssets. That one is built for the pipeline: it
// filters `is_active = true` (an asset switched off in onboarding is invisible,
// which is correct when deciding what to put in a doc and wrong when showing
// someone their library), and its field mapper drops copy_fields.id entirely
// (the pipeline matches fields by name; an editor cannot). Widening it would
// have quietly changed what every brief builds, so this is a second reader.
//
// Field values are returned AS STORED, not as the pipeline coerces them —
// rowToSpecGroup turns any field_type that isn't 'words' into 'text', which is
// the right call for rendering a doc and the wrong one for showing a row.
//
// Returns null when there is no DB or no tenant (nothing to show), and [] for a
// tenant that simply has no rows yet — a distinction getTenantAssets collapses
// but an editor needs, because "no database" and "empty library" are different
// screens. Shape per asset:
//   { id, name, group, is_active, sort_order, asset_direction, spec_note,
//     fields: [{ id, field_name, char_min, char_max, field_type, group_label,
//                sort_order, spec_type, spec_source, spec_note }, …] }
async function getTenantLibrary(tenantId) {
  const pool = getPool();
  if (!pool || !tenantId) return null;

  const typesRes = await pool.query(
    `SELECT id, name, "group", is_active, sort_order, asset_direction, spec_note
       FROM asset_types
      WHERE tenant_id = $1
      ORDER BY sort_order, id`,
    [tenantId]
  );
  if (typesRes.rows.length === 0) return [];

  const typeIds = typesRes.rows.map((t) => t.id);
  const fieldsRes = await pool.query(
    `SELECT id, asset_type_id, field_name, char_min, char_max, field_type,
            group_label, sort_order, spec_type, spec_source, spec_note
       FROM copy_fields
      WHERE asset_type_id = ANY($1::bigint[])
      ORDER BY sort_order, id`,
    [typeIds]
  );

  const fieldsByType = new Map();
  for (const row of fieldsRes.rows) {
    if (!fieldsByType.has(row.asset_type_id)) fieldsByType.set(row.asset_type_id, []);
    fieldsByType.get(row.asset_type_id).push({
      id: String(row.id),
      field_name: row.field_name,
      char_min: parseInt(row.char_min, 10) || 0,
      char_max: parseInt(row.char_max, 10) || 0,
      field_type: row.field_type || null,
      group_label: row.group_label || null,
      sort_order: row.sort_order,
      spec_type: row.spec_type || null,
      spec_source: row.spec_source || null,
      spec_note: row.spec_note || null,
    });
  }

  // ids are stringified because Postgres BIGSERIAL exceeds a JS safe integer and
  // node-postgres hands bigints back as strings. Keeping them strings all the way
  // to the browser and back is the only way an id survives the round trip intact.
  return typesRes.rows.map((t) => ({
    id: String(t.id),
    name: t.name,
    group: t.group || null,
    is_active: t.is_active !== false,
    sort_order: t.sort_order,
    asset_direction: t.asset_direction || null,
    spec_note: t.spec_note || null,
    fields: fieldsByType.get(t.id) || [],
  }));
}

// Asset toggles, BY ID. Every type whose id is in `deactivatedIds` becomes
// inactive; every other one becomes active. Returns true if the write ran.
//
// This is the primary path. Matching on id rather than on name is the point of
// the uniqueness work that preceded it: a name is a value a tenant will soon be
// able to edit, so a toggle keyed on one is a toggle that breaks the moment
// somebody renames something between loading the page and saving it.
async function setActiveAssetIds(tenantId, deactivatedIds = []) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/assets] DATABASE_URL not set — skipping setActiveAssetIds');
    return false;
  }
  if (!tenantId) return false;
  // Ids arrive from a browser, so they are neither trusted nor assumed numeric.
  // Anything that isn't a run of digits is dropped rather than passed to
  // Postgres, where a bad cast would abort the whole statement.
  const ids = (Array.isArray(deactivatedIds) ? deactivatedIds : [])
    .map((v) => String(v == null ? '' : v).trim())
    .filter((v) => /^\d+$/.test(v));
  await pool.query(
    `UPDATE asset_types SET is_active = (id <> ALL($2::bigint[])) WHERE tenant_id = $1`,
    [tenantId, ids]
  );
  return true;
}

// Asset toggles by NAME — the legacy path, kept for one deploy window.
//
// The ONLY caller of the name form was routes/onboarding.js, and the browser
// posting to it is public/onboarding.html. Both now send ids. This still exists
// because a browser that loaded the page BEFORE this deploy is still holding the
// old script and will post names at whatever moment the user finishes onboarding
// — dropping it immediately would make those saves silently do nothing.
//
// It no longer runs a raw-text SQL match. It resolves names to ids through
// utils/normalize (the same fold the pipeline and the Postgres unique index use)
// and delegates, so the dash-and-spacing fragility is fixed on this path too:
// 'Direct Mail — Box' posted against a stored 'Direct Mail - Box' used to match
// nothing and silently deactivate nothing.
async function setActiveAssets(tenantId, deactivatedNames = []) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/assets] DATABASE_URL not set — skipping setActiveAssets');
    return false;
  }
  if (!tenantId) return false;
  const wanted = new Set(
    (Array.isArray(deactivatedNames) ? deactivatedNames : []).map((n) => normalize(n)).filter(Boolean)
  );
  const rows = (await getTenantLibrary(tenantId)) || [];
  const ids = rows.filter((r) => wanted.has(normalize(r.name))).map((r) => r.id);
  const unmatched = [...wanted].filter((w) => !rows.some((r) => normalize(r.name) === w));
  if (unmatched.length > 0) {
    console.warn(`[db/assets] setActiveAssets: ${unmatched.length} name(s) matched no asset — ignored`);
  }
  return setActiveAssetIds(tenantId, ids);
}

// Best-effort asset-level creative direction lookup for a tenant. Reads the
// tenant's asset library (getTenantAssets) and returns a function
// (assetName) => direction|null, matched by normalized name. Degrades to a
// function that always returns null when there's no DB / no rows / no column
// data — so the pipeline merges nothing and renders normally.
//
// `normName` used to be a third, hand-copied definition of utils/normalize —
// byte-identical to it, so this is a pure de-duplication with no behavior
// change. It is now the shared one, which is also what the Postgres unique
// index folds on, so the lookup and the constraint cannot drift apart.
const normName = normalize;

async function getAssetDirections(tenantId) {
  let rows = null;
  try {
    rows = await getTenantAssets(tenantId);
  } catch (err) {
    console.warn('[db/assets] getAssetDirections lookup failed — no directions:', err.message);
  }
  const byNorm = new Map();
  if (Array.isArray(rows)) {
    for (const a of rows) {
      if (a && a.asset_direction) byNorm.set(normName(a.name), a.asset_direction);
    }
  }
  return (assetName) => byNorm.get(normName(assetName)) || null;
}

module.exports = {
  seedTenantAssets,
  getTenantAssets,
  // The EDITOR read — every asset, active or not, with stable ids. Separate from
  // getTenantAssets on purpose (see its comment).
  getTenantLibrary,
  setActiveAssetIds,
  setActiveAssets,
  getAssetDirections,
};
