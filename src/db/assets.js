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

// CREATE one tenant-authored asset type and its fields, in ONE transaction.
//
// The asset row and its copy_fields rows go in together or not at all. A
// half-built asset — a type with no fields — is not merely untidy: getTenantAssets
// drops zero-field assets (tenantAssetsToSpecs filters `g.fields.length > 0`), so
// it would be a row the library shows and the pipeline silently ignores. Same
// transaction shape as seedTenantAssets above.
//
// `asset` MUST have come through utils/assetInput normalizeNewAsset. This
// function inserts exactly the columns named below and reads nothing else off
// the object, so spec_type and spec_source are never supplied and Postgres
// leaves them NULL — which is what makes a tenant field render with no tier line
// and no citation (googleDocs.js specTypeLine returns null for null).
//
// sort_order appends after the tenant's current maximum so a new asset lands at
// the end of their library rather than colliding with a seeded position.
//
// Returns the new asset's id as a string. Throws on conflict so the caller can
// map 23505 (the normalized-name unique index) to a readable message — the JS
// duplicate check in normalizeNewAsset is the message, this is the guarantee.
async function createAssetType(tenantId, asset) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/assets] DATABASE_URL not set — skipping createAssetType');
    return null;
  }
  if (!tenantId || !asset || !Array.isArray(asset.fields) || asset.fields.length === 0) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const posRes = await client.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max FROM asset_types WHERE tenant_id = $1',
      [tenantId]
    );
    const sortOrder = (parseInt(posRes.rows[0].max, 10) || 0) + 1;

    const typeRes = await client.query(
      `INSERT INTO asset_types (tenant_id, name, "group", is_active, sort_order, asset_direction)
         VALUES ($1, $2, $3, true, $4, $5)
       RETURNING id`,
      [tenantId, asset.name, asset.group || null, sortOrder, asset.asset_direction || null]
    );
    const assetTypeId = typeRes.rows[0].id;

    for (const field of asset.fields) {
      // Six columns, all from the allowlisted shape. spec_type, spec_source and
      // spec_version are deliberately not in this statement at all.
      await client.query(
        `INSERT INTO copy_fields
           (asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          assetTypeId,
          field.field_name,
          field.char_min,
          field.char_max,
          field.field_type,
          field.sort_order,
          field.spec_note || null,
        ]
      );
    }

    await client.query('COMMIT');
    console.log(
      `[db/assets] tenant ${tenantId} created asset type "${asset.name}" (${asset.fields.length} field(s))`
    );
    return String(assetTypeId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// WHICH ASSETS A TENANT MAY EDIT — and the single most load-bearing rule in this
// file, because getting it wrong is silent.
//
// An asset is SEEDED if its name is one of the 30 in the bundled default library.
// Seeded assets are read-only apart from is_active; a tenant's own creations are
// fully editable.
//
// Derived from the name rather than stored in a column, because the NAME is
// exactly what makes it unsafe to edit. services/specReview.js updates
// copy_fields by asset NAME with no tenant filter — that is how a platform's
// changed character limit reaches every tenant at once. A tenant who renamed
// "LinkedIn Single Image Ad" would silently stop matching that update: their doc
// would go on rendering "Platform limit (LinkedIn). Stay within this count." with
// a live citation link, next to a number LinkedIn no longer enforces. Nothing
// would error. Nobody would find out.
//
// So the predicate is not "did we insert this row" (which a column would record)
// but "is this row reachable by the cross-tenant write" (which the name decides).
// A tenant with no seed who hand-creates an asset under a bundled name is caught
// too, and correctly: LiveSpecs would target it.
//
// `normalize` directly, not the `normName` alias below it: this Set is built at
// module load and the alias is a `const` declared further down the file, so the
// alias would be in its temporal dead zone here. Same function either way.
const SEEDED_NAME_SET = new Set(DEFAULT_ASSETS.map((a) => normalize(a.name)));

function isSeededAssetName(name) {
  return SEEDED_NAME_SET.has(normalize(name));
}

// UPDATE one asset the tenant owns: its name, group and creative direction, and
// its full field list. ONE transaction — a half-applied edit would leave the
// library in a shape the tenant never asked for.
//
// Returns a discriminated result rather than throwing for the expected refusals,
// so the route can answer 404 vs 403 vs 409 without parsing an error string:
//   { ok: true, id }             — applied
//   { ok: false, reason: 'not_found' }  — no such asset FOR THIS TENANT
//   { ok: false, reason: 'seeded' }     — a bundled asset; read-only apart from is_active
//
// Cross-tenant is handled by 'not_found', not 'forbidden': answering differently
// would confirm that an id exists in someone else's library.
//
// FIELDS ARE RECONCILED BY ID. A submitted field carrying an id that belongs to
// THIS asset is updated in place; one with no id is inserted; a stored field
// whose id is absent from the submission is deleted. Matching by id rather than
// by name is what makes a rename a rename instead of a delete-plus-insert — and
// nothing references copy_fields(id), so the delete is safe (asset_types(id), by
// contrast, is referenced by five tables with no ON DELETE, which is why the
// ASSET-level removal is is_active and not a DELETE).
async function updateAssetType(tenantId, assetTypeId, asset) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/assets] DATABASE_URL not set — skipping updateAssetType');
    return { ok: false, reason: 'not_found' };
  }
  if (!tenantId || !assetTypeId || !asset || !Array.isArray(asset.fields) || asset.fields.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row-locked read, scoped to the tenant. The lock matters: two tabs saving
    // the same asset would otherwise interleave their field reconciles.
    const cur = await client.query(
      'SELECT id, name FROM asset_types WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [assetTypeId, tenantId]
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    // Checked against the STORED name, never the submitted one — otherwise
    // renaming a seeded asset in the same request would walk straight past this.
    if (isSeededAssetName(cur.rows[0].name)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'seeded', name: cur.rows[0].name };
    }

    await client.query(
      'UPDATE asset_types SET name = $1, "group" = $2, asset_direction = $3 WHERE id = $4 AND tenant_id = $5',
      [asset.name, asset.group || null, asset.asset_direction || null, assetTypeId, tenantId]
    );

    // The ids this asset actually owns. A submitted id outside this set is not
    // an error to argue about — it is simply not matched, so it inserts as a new
    // field rather than reaching another asset's row.
    const ownedRes = await client.query('SELECT id FROM copy_fields WHERE asset_type_id = $1', [assetTypeId]);
    const owned = new Set(ownedRes.rows.map((r) => String(r.id)));
    const kept = new Set();

    for (const field of asset.fields) {
      const id = field.id && owned.has(String(field.id)) ? String(field.id) : null;
      if (id) {
        kept.add(id);
        // Six columns, exactly the ones a create writes. spec_type, spec_source
        // and spec_version are absent from the statement, so an edit cannot set
        // them and — just as important — cannot CLEAR them either.
        await client.query(
          `UPDATE copy_fields
              SET field_name = $1, char_min = $2, char_max = $3, field_type = $4,
                  sort_order = $5, spec_note = $6
            WHERE id = $7 AND asset_type_id = $8`,
          [
            field.field_name,
            field.char_min,
            field.char_max,
            field.field_type,
            field.sort_order,
            field.spec_note || null,
            id,
            assetTypeId,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO copy_fields
             (asset_type_id, field_name, char_min, char_max, field_type, sort_order, spec_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            assetTypeId,
            field.field_name,
            field.char_min,
            field.char_max,
            field.field_type,
            field.sort_order,
            field.spec_note || null,
          ]
        );
      }
    }

    // Anything the tenant removed from the list.
    const dropped = [...owned].filter((id) => !kept.has(id));
    if (dropped.length > 0) {
      await client.query('DELETE FROM copy_fields WHERE asset_type_id = $1 AND id = ANY($2::bigint[])', [
        assetTypeId,
        dropped,
      ]);
    }

    await client.query('COMMIT');
    console.log(
      `[db/assets] tenant ${tenantId} updated asset type ${assetTypeId} "${asset.name}" ` +
        `(${asset.fields.length} field(s), ${dropped.length} removed)`
    );
    return { ok: true, id: String(assetTypeId) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  // The only tenant-facing CREATE. Asset + fields in one transaction; the
  // columns it writes are a fixed list (spec_type / spec_source are not on it).
  createAssetType,
  // The only tenant-facing UPDATE. Same fixed column list; refuses a seeded
  // asset and another tenant's asset, both from the STORED row.
  updateAssetType,
  // Read-only-ness of a bundled asset, derived from its name — see the comment
  // above it for why the name and not a column. Exported for the route (which
  // reports it) and for tests.
  isSeededAssetName,
  setActiveAssetIds,
  setActiveAssets,
  getAssetDirections,
};
