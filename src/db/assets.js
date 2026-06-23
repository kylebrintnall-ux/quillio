'use strict';

// Per-tenant asset library (Phase 3 / Week 7). Seeds a new tenant's
// asset_types + copy_fields from the bundled default library, and reads them
// back. All operations degrade gracefully when DATABASE_URL is unset (no pg) —
// seedTenantAssets returns false, getTenantAssets returns null — so the
// single-tenant demo and tests run unchanged.
//
// IMPORTANT (Week 7 scope): nothing here is wired into the pipeline yet. Asset
// matching still reads from the Sheet. getTenantAssets returning null on a miss
// is the feature flag — the Sheet fallback stays in place until a later week
// flips the preference.

const { getPool } = require('../db');
const { DEFAULT_ASSETS } = require('../data/defaultAssets');

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
        `INSERT INTO asset_types (tenant_id, name, "group", is_active, sort_order)
           VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [tenantId, asset.name, asset.group, asset.is_active, asset.sort_order]
      );
      const assetTypeId = typeRes.rows[0].id;

      for (const field of asset.fields) {
        await client.query(
          `INSERT INTO copy_fields
             (asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_source, spec_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            assetTypeId,
            field.field_name,
            field.char_min,
            field.char_max,
            field.field_type,
            field.sort_order,
            asset.spec_source,
            asset.spec_version,
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
// tenant has no active assets (the feature-flag "miss" that keeps the Sheet
// fallback in play). Shape per type:
//   { id, name, group, sort_order, fields: [{ field_name, char_min, char_max,
//     field_type, sort_order, spec_source, spec_version }, …] }
async function getTenantAssets(tenantId) {
  const pool = getPool();
  if (!pool || !tenantId) return null;

  const typesRes = await pool.query(
    `SELECT id, name, "group", sort_order
       FROM asset_types
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY sort_order, id`,
    [tenantId]
  );
  if (typesRes.rows.length === 0) return null;

  const typeIds = typesRes.rows.map((t) => t.id);
  const fieldsRes = await pool.query(
    `SELECT asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_source, spec_version
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
    });
  }

  return typesRes.rows.map((t) => ({
    id: t.id,
    name: t.name,
    group: t.group,
    sort_order: t.sort_order,
    fields: fieldsByType.get(t.id) || [],
  }));
}

// Onboarding asset toggles: mark a tenant's asset types active/inactive in one
// shot. Every type whose name is in `deactivatedNames` becomes inactive; all
// others become active. Returns true if the write ran, false if there's no DB.
async function setActiveAssets(tenantId, deactivatedNames = []) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/assets] DATABASE_URL not set — skipping setActiveAssets');
    return false;
  }
  if (!tenantId) return false;
  const names = Array.isArray(deactivatedNames) ? deactivatedNames : [];
  await pool.query(
    `UPDATE asset_types SET is_active = (name <> ALL($2::text[])) WHERE tenant_id = $1`,
    [tenantId, names]
  );
  return true;
}

module.exports = { seedTenantAssets, getTenantAssets, setActiveAssets };
