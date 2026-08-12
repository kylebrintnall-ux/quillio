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

const { getPool, isUndefinedTable, isUndefinedColumn, warnMissingSchema } = require('../db');
const { DEFAULT_ASSETS } = require('../data/defaultAssets');
const { normalize } = require('../utils/normalize');

// The copy_fields INSERT, most-complete first.
//
// EVERY COLUMN THE SEED COMPUTES HAS TO BE NAMED HERE, and `fact_kind` was not.
// defaultAssets.js computes it for three fields (Date / Location Line →
// 'datetime'; Location Label and Track / Room Label → 'location') and this
// statement listed eleven columns without it, so every tenant seeded since the
// column shipped got NULL on all three. Nothing errored: the note that tells a
// drafter a date is missing gates on `factKind === 'datetime'`
// (core/pipeline.js), and missingDateTimeNotice reads the same rows, so both
// simply never fired for a new tenant. The two migrations that DO write
// fact_kind are backfills matched by field name — they reach the tenants that
// existed when they ran, and nobody since.
//
// The lesson is in the test that missed it: it compared the seed constant to the
// migration constant, and both were right. Nothing looked at this statement.
// test/smoke.test.js drives seedTenantAssets against a fake pool and rebuilds
// the inserted rows from the SQL and its params, so a column dropped from here
// fails there — for any column, not just this one.
//
// TWO VARIANTS, because Railway auto-deploys `main` on merge and this runs
// against a database that has not had scripts/migrateAddReminderDateLine.js run
// yet (CLAUDE.md: either deploy order is safe). The fallback is the exact
// pre-fact_kind statement. Losing the note until someone runs the migration is a
// silence; losing the INSERT is a tenant with NO asset library at all, and
// seedTenantAssets is called best-effort from both install paths — so the
// failure would be logged, sign-in would continue, and the first brief would
// fail the Postgres asset-library check with a message about something else.
const COPY_FIELD_INSERTS = [
  {
    factKind: true,
    sql: `INSERT INTO copy_fields
             (asset_type_id, field_name, char_min, char_max, field_type, sort_order,
              spec_source, spec_version, group_label, spec_note, spec_type, fact_kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
  },
  {
    factKind: false,
    sql: `INSERT INTO copy_fields
             (asset_type_id, field_name, char_min, char_max, field_type, sort_order,
              spec_source, spec_version, group_label, spec_note, spec_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
  },
];

// Insert the whole bundled library for one tenant, in one transaction, using one
// of the variants above. Throws on any failure with the transaction rolled back.
async function insertDefaultLibrary(client, tenantId, variant) {
  await client.query('BEGIN');
  try {
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
        const params = [
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
        ];
        // NULL for every generative field, which is nearly all of them — the
        // absence is the value, so it is passed rather than skipped.
        if (variant.factKind) params.push(field.fact_kind || null);
        await client.query(variant.sql, params);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

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

    // RETRIED AT THE TRANSACTION LEVEL, not per statement. A failed INSERT aborts
    // the surrounding transaction, so every later statement comes back 25P02 and
    // a per-statement catch has nothing left to recover with — the whole seed has
    // to be replayed on the reduced variant. That costs one rollback, once per
    // tenant, and only in the window before the migration has run.
    for (let i = 0; i < COPY_FIELD_INSERTS.length; i++) {
      const variant = COPY_FIELD_INSERTS[i];
      const last = i === COPY_FIELD_INSERTS.length - 1;
      try {
        await insertDefaultLibrary(client, tenantId, variant);
        console.log(
          `[db/assets] seeded ${DEFAULT_ASSETS.length} asset types for tenant ${tenantId}` +
            (variant.factKind ? '' : ' (without fact_kind — pre-migration database)')
        );
        return true;
      } catch (err) {
        // Only a missing column is recoverable, and only while a reduced variant
        // remains. Anything else — a permissions failure, a lost connection —
        // is the caller's to see.
        if (last || !isUndefinedColumn(err)) throw err;
        warnMissingSchema('copy_fields.fact_kind', 'scripts/migrateAddReminderDateLine.js');
      }
    }
    return false;
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
  // THE EFFECTIVE VALUE IS THE OVERRIDE WHEN THERE IS ONE. COALESCE, not a JS
  // merge, so the pipeline sees one number and cannot forget which to prefer.
  //
  // `spec_overridden` is carried alongside because the doc's tier line differs:
  // an untouched house default invites the tenant to Settings, one they have
  // already set does not. It is a THREE-column OR, not "does the effective value
  // differ from the seed" — a tenant who deliberately re-typed the seed's own
  // number has overridden it, and a later seed change must not drag them along.
  //
  // The columns arrive in scripts/migrateAddHouseDefaultOverrides.js, and Railway
  // auto-deploys `main` on merge, so this runs against a database without them
  // first (CLAUDE.md: either deploy order is safe). The fallback is the exact
  // pre-migration query and reports nothing overridden — which is true.
  // PROGRESSIVE FALLBACK, because two independent migrations add columns here and
  // Railway auto-deploys `main` on merge — so this code runs against a database
  // missing either, or both (CLAUDE.md: either deploy order is safe). Each
  // variant drops exactly one optional group and reports the honest default for
  // it: nothing overridden, no fact kind. Ordered most-complete first, so a
  // fully migrated database takes the first query and never pays for the rest.
  //
  // It is a LIST rather than nested try/catch because the two groups are
  // independent: the override columns shipped first and are already in
  // production, so the realistic gap is fact_kind alone, and a nested catch
  // would have made that case fall back past the overrides it does have.
  const OVERRIDE_COLS = `COALESCE(char_min_override, char_min) AS char_min,
              COALESCE(char_max_override, char_max) AS char_max,
              COALESCE(spec_note_override, spec_note) AS spec_note,
              (char_min_override IS NOT NULL
                OR char_max_override IS NOT NULL
                OR spec_note_override IS NOT NULL) AS spec_overridden`;
  const NO_OVERRIDE_COLS = 'char_min, char_max, spec_note, false AS spec_overridden';
  const variants = [
    ['copy_fields.fact_kind', OVERRIDE_COLS, 'fact_kind'],
    ['copy_fields.fact_kind', NO_OVERRIDE_COLS, 'fact_kind'],
    ['copy_fields.char_max_override', OVERRIDE_COLS, 'NULL AS fact_kind'],
    [null, NO_OVERRIDE_COLS, 'NULL AS fact_kind'],
  ];

  let fieldsRes = null;
  let lastErr = null;
  for (const [missing, valueCols, factCol] of variants) {
    try {
      fieldsRes = await pool.query(
        `SELECT asset_type_id, field_name,
                ${valueCols},
                field_type, sort_order, spec_source, spec_version, group_label,
                spec_type, ${factCol}
           FROM copy_fields
          WHERE asset_type_id = ANY($1::bigint[])
          ORDER BY sort_order, id`,
        [typeIds]
      );
      break;
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err;
      lastErr = err;
      if (missing) warnMissingSchema(missing, 'getTenantAssets', err);
    }
  }
  if (!fieldsRes) throw lastErr;

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
      // Which supplied fact this field CARRIES, if any ('datetime' today). NULL on
      // every generative field and on any database predating the column.
      fact_kind: row.fact_kind || null,
      // An override of '' is the tenant DELETING the note, and COALESCE already
      // returned it. `|| null` folds '' to null here exactly as it always has for
      // an empty base note — the renderer treats both as "no note".
      spec_note: row.spec_note || null,
      spec_type: row.spec_type || null,
      spec_overridden: row.spec_overridden === true,
    });
  }

  return typesRes.rows.map((t) => ({
    id: t.id,
    name: t.name,
    group: t.group,
    sort_order: t.sort_order,
    asset_direction: t.asset_direction || null,
    spec_note: t.spec_note || null,
    // NO doc_template_id AND NO template_marker HERE, deliberately. This is the
    // PIPELINE's read, and the attachment is inert until step three: an attached
    // asset must render into the copy doc exactly as it did before. The editor
    // read below carries the attachment; this one must not, or "inert" becomes a
    // claim rather than a property of the code.
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

  // The template columns arrive in scripts/migrateAddTemplateMapping.js, and
  // Railway auto-deploys `main` on merge — so this query runs against a database
  // without them first. Both reads fall back to the pre-migration shape and
  // report every asset as unattached, which is exactly what it is.
  let typesRes;
  try {
    typesRes = await pool.query(
      `SELECT id, name, "group", is_active, sort_order, asset_direction, spec_note, doc_template_id
         FROM asset_types
        WHERE tenant_id = $1
        ORDER BY sort_order, id`,
      [tenantId]
    );
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    warnMissingSchema('asset_types.doc_template_id', 'getTenantLibrary', err);
    typesRes = await pool.query(
      `SELECT id, name, "group", is_active, sort_order, asset_direction, spec_note
         FROM asset_types
        WHERE tenant_id = $1
        ORDER BY sort_order, id`,
      [tenantId]
    );
  }
  if (typesRes.rows.length === 0) return [];

  const typeIds = typesRes.rows.map((t) => t.id);
  let fieldsRes;
  try {
    fieldsRes = await pool.query(
      `SELECT id, asset_type_id, field_name, char_min, char_max, field_type,
              group_label, sort_order, spec_type, spec_source, spec_note,
              template_marker_key, template_marker_name
         FROM copy_fields
        WHERE asset_type_id = ANY($1::bigint[])
        ORDER BY sort_order, id`,
      [typeIds]
    );
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    warnMissingSchema('copy_fields.template_marker_key', 'getTenantLibrary', err);
    fieldsRes = await pool.query(
      `SELECT id, asset_type_id, field_name, char_min, char_max, field_type,
              group_label, sort_order, spec_type, spec_source, spec_note
         FROM copy_fields
        WHERE asset_type_id = ANY($1::bigint[])
        ORDER BY sort_order, id`,
      [typeIds]
    );
  }

  // THE OVERRIDES, AS THEIR OWN QUERY. Deliberately not folded into the SELECT
  // above: that one already has a template-column fallback, and a second optional
  // column group inside it would need four variants to cover both migrations
  // being absent independently. Separate query, separate catch, no combinatorics
  // — and an empty map is exactly right when the columns are not there yet
  // (scripts/migrateAddHouseDefaultOverrides.js; Railway auto-deploys `main` on
  // merge, so this runs against a database without them first).
  const overrides = new Map();
  try {
    const ovRes = await pool.query(
      `SELECT id, char_min_override, char_max_override, spec_note_override
         FROM copy_fields
        WHERE asset_type_id = ANY($1::bigint[])`,
      [typeIds]
    );
    for (const row of ovRes.rows) overrides.set(String(row.id), row);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    warnMissingSchema('copy_fields.char_max_override', 'getTenantLibrary', err);
  }

  const fieldsByType = new Map();
  for (const row of fieldsRes.rows) {
    if (!fieldsByType.has(row.asset_type_id)) fieldsByType.set(row.asset_type_id, []);
    const ov = overrides.get(String(row.id)) || {};
    // BASE is the seed's value — the column every migration writes. EFFECTIVE is
    // what is in force. The editor needs BOTH: the form prefills from effective,
    // and the row says "Quillio's default is N" beside it so a tenant can see
    // what they changed and put it back.
    const baseMin = parseInt(row.char_min, 10) || 0;
    const baseMax = parseInt(row.char_max, 10) || 0;
    const baseNote = row.spec_note || null;
    const hasMin = ov.char_min_override != null;
    const hasMax = ov.char_max_override != null;
    const hasNote = ov.spec_note_override != null;
    fieldsByType.get(row.asset_type_id).push({
      id: String(row.id),
      field_name: row.field_name,
      char_min: hasMin ? parseInt(ov.char_min_override, 10) || 0 : baseMin,
      char_max: hasMax ? parseInt(ov.char_max_override, 10) || 0 : baseMax,
      field_type: row.field_type || null,
      group_label: row.group_label || null,
      sort_order: row.sort_order,
      spec_type: row.spec_type || null,
      spec_source: row.spec_source || null,
      // An override of '' is the tenant having DELETED the note; folded to null
      // the same way an empty base note always has been.
      spec_note: hasNote ? ov.spec_note_override || null : baseNote,
      // What the seed says, for the "Quillio's default" line and the reset.
      base_char_min: baseMin,
      base_char_max: baseMax,
      base_spec_note: baseNote,
      // Per VALUE, not just per field: a tenant may have set a limit and left the
      // note alone, and a reset control that cannot tell them apart would throw
      // away the half they meant to keep.
      overridden: { char_min: hasMin, char_max: hasMax, spec_note: hasNote },
      spec_overridden: hasMin || hasMax || hasNote,
      // Both null = unmapped, which is a valid state: a matrix carries markers
      // no writer drafts, and a field with nowhere to go is worth seeing.
      template_marker_key: row.template_marker_key || null,
      template_marker_name: row.template_marker_name || null,
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
    // null = "renders into the copy doc", which is every asset today and stays
    // the default. Stringified for the same bigint reason as the ids above.
    doc_template_id: t.doc_template_id == null ? null : String(t.doc_template_id),
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
// An asset is SEEDED if its name is one of those in the bundled default library.
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

// WHICH TIER A TENANT MAY SET THEIR OWN NUMBER ON. The three tiers are three
// different relationships to the writer:
//
//   enforced       the platform decides    — not the tenant's call
//   recommended    someone measured it     — the tenant may disagree knowingly
//   house_default  THE TENANT DECIDES
//
// The name rule above exists to stop a tenant editing an enforced platform limit,
// which is right; it caught house_default in the same net, which is the one tier
// whose number is supposed to be theirs. This is the second half of the gate.
//
// NULL IS OPEN. It renders identically to house_default today (specTypeLine
// returns null for both), the seed gives the same field house_default, and every
// TENANT-AUTHORED field is NULL by construction (createAssetType never writes
// spec_type). Locking NULL would freeze custom assets, which have always been
// fully editable.
//
// AN UNRECOGNISED TIER IS LOCKED. An allowlist, not `!== 'enforced' && !==
// 'recommended'`, so a fourth tier added later — which would only be added to
// carry some authority — is refused by default and has to be let in on purpose.
// Failing closed on the authority axis is the whole reason this gate exists.
const TENANT_EDITABLE_TIERS = new Set([null, 'house_default']);

function isTenantEditableTier(specType) {
  return TENANT_EDITABLE_TIERS.has(specType == null || specType === '' ? null : specType);
}

// THE SEEDED-ASSET WRITE. Sets char_min / char_max / spec_note OVERRIDES on the
// house_default fields of a bundled asset, and refuses everything else about it.
//
// Called only from updateAssetType, inside its transaction and after its row
// lock, so every decision here is made against rows nobody else can move.
//
// FOUR THINGS IT WILL NOT DO, each a way the asset-level rule could have leaked:
//   • no INSERT — a submitted field with no id is ignored, not added. A seeded
//     asset's field LIST is part of what LiveSpecs reaches by name.
//   • no DELETE — a stored field missing from the submission is left alone. The
//     full path treats absence as removal; here absence means "not submitted",
//     which is what a reduced form legitimately sends.
//   • no rename, no field_type, no sort_order — a house number is not a licence
//     to rename a bundled field or move it. field_type in particular is why the
//     UI disables that control: silently ignoring input the user can still type
//     is the failure this codebase keeps refusing.
//   • no spec_type, spec_source or spec_version — as everywhere else.
//
// THE TIER IS READ FROM THE STORED ROW, NEVER THE SUBMISSION. The client sends
// whatever it likes; the only spec_type that counts is the one in Postgres. A
// field whose stored tier is enforced or recommended is counted in `locked` and
// skipped — not an error, because the reduced form legitimately posts every row
// it rendered and only some of them are the tenant's to set.
//
// A null override CLEARS. `undefined` on a submitted value means "not offered",
// so it is left as it is; an explicit null is the reset control, putting the
// field back on the seed's number for good — including future seed changes.
async function applyHouseDefaultOverrides(client, assetTypeId, submitted) {
  const stored = await client.query(
    'SELECT id, spec_type FROM copy_fields WHERE asset_type_id = $1',
    [assetTypeId]
  );
  const tierById = new Map(stored.rows.map((r) => [String(r.id), r.spec_type || null]));

  let changed = 0;
  let cleared = 0;
  let locked = 0;
  let skipped = 0;

  for (const field of submitted) {
    const id = field && field.id ? String(field.id) : null;
    // No id, or an id this asset does not own: not an error to argue about, and
    // NOT an insert. It simply names nothing here.
    if (!id || !tierById.has(id)) {
      skipped++;
      continue;
    }
    if (!isTenantEditableTier(tierById.get(id))) {
      locked++;
      continue;
    }

    // `reset` is the explicit "put me back on Quillio's default" — all three
    // overrides to NULL in one statement, so a half-reset row cannot exist.
    if (field.reset === true) {
      const r = await client.query(
        `UPDATE copy_fields
            SET char_min_override = NULL, char_max_override = NULL, spec_note_override = NULL
          WHERE id = $1 AND asset_type_id = $2
            AND (char_min_override IS NOT NULL
                 OR char_max_override IS NOT NULL
                 OR spec_note_override IS NOT NULL)`,
        [id, assetTypeId]
      );
      cleared += r.rowCount;
      continue;
    }

    // Only the values actually offered. `undefined` is absent from the form;
    // null is the tenant clearing that one value back to the seed.
    const sets = [];
    const params = [];
    const put = (col, value) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (field.char_min !== undefined) put('char_min_override', field.char_min);
    if (field.char_max !== undefined) put('char_max_override', field.char_max);
    // '' is a real override meaning "I deleted the note", and is stored as ''
    // rather than folded to NULL — NULL here means "no override", so folding
    // would silently restore the seed's note the tenant just removed.
    if (field.spec_note !== undefined) put('spec_note_override', field.spec_note);
    if (sets.length === 0) {
      skipped++;
      continue;
    }

    params.push(id, assetTypeId);
    const r = await client.query(
      `UPDATE copy_fields SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND asset_type_id = $${params.length}`,
      params
    );
    changed += r.rowCount;
  }

  return { ok: true, changed, cleared, locked, skipped };
}

// UPDATE one asset the tenant owns: its name, group and creative direction, and
// its full field list. ONE transaction — a half-applied edit would leave the
// library in a shape the tenant never asked for.
//
// Returns a discriminated result rather than throwing for the expected refusals,
// so the route can answer 404 vs 403 vs 409 without parsing an error string:
//   { ok: true, id }             — applied
//   { ok: false, reason: 'not_found' }  — no such asset FOR THIS TENANT
//   { ok: false, reason: 'seeded' }     — a bundled asset, in FULL-edit mode
//
// Cross-tenant is handled by 'not_found', not 'forbidden': answering differently
// would confirm that an id exists in someone else's library.
//
// TWO MODES, AND THE ROW DECIDES WHICH. A tenant-authored asset gets the full
// edit below. A SEEDED asset gets houseDefaultsOnly (see the branch), which
// writes nothing but char_min/char_max/spec_note OVERRIDES, and only on fields
// whose STORED spec_type is house_default or NULL. Everything else about a
// seeded asset — its name, its field list, its tiers — stays exactly as
// read-only as it was. `mode: 'full'` is required to touch a seeded asset's
// structure, and no caller passes it, so the refusal is unchanged for every
// existing path.
//
// FIELDS ARE RECONCILED BY ID. A submitted field carrying an id that belongs to
// THIS asset is updated in place; one with no id is inserted; a stored field
// whose id is absent from the submission is deleted. Matching by id rather than
// by name is what makes a rename a rename instead of a delete-plus-insert — and
// nothing references copy_fields(id), so the delete is safe (asset_types(id), by
// contrast, is referenced by five tables with no ON DELETE, which is why the
// ASSET-level removal is is_active and not a DELETE).
async function updateAssetType(tenantId, assetTypeId, asset, { mode = 'full' } = {}) {
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
    // Both branches read it: one to refuse, the other to pick its mode.
    const seeded = isSeededAssetName(cur.rows[0].name);
    if (seeded && mode !== 'houseDefaultsOnly') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'seeded', name: cur.rows[0].name };
    }
    // The inverse is refused too. houseDefaultsOnly against a TENANT asset would
    // silently drop every rename, insert and delete in the request and report
    // success — the caller has misread which asset it is holding, and answering
    // "done" to that is worse than answering "no".
    if (!seeded && mode === 'houseDefaultsOnly') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_seeded', name: cur.rows[0].name };
    }

    if (seeded) {
      const applied = await applyHouseDefaultOverrides(client, assetTypeId, asset.fields);
      if (!applied.ok) {
        await client.query('ROLLBACK');
        return applied;
      }
      await client.query('COMMIT');
      console.log(
        `[db/assets] tenant ${tenantId} set house defaults on seeded asset ${assetTypeId} ` +
          `"${cur.rows[0].name}" (${applied.changed} changed, ${applied.cleared} reset, ${applied.locked} locked field(s) left alone)`
      );
      return { ok: true, id: String(assetTypeId), houseDefaults: applied };
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
  // The pipeline's ONLY view of the attachment — separate from getTenantAssets
  // on purpose, so the spec source stays exactly what it was.
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
  // The OTHER half of the gate: which TIER a tenant may set their own number on.
  // A seeded asset is still read-only structurally; its house_default fields are
  // not. Exported for the route (which reports per-field editability) and tests.
  isTenantEditableTier,
  setActiveAssetIds,
  setActiveAssets,
  getAssetDirections,
};
