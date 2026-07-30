'use strict';

// Migration — UNIQUE INDEXES on the asset library.
//
//   asset_types  (tenant_id, normalized name)
//   copy_fields  (asset_type_id, normalized field_name)
//
// WHY NOW. There is no tenant-facing write path to the asset library yet: rows
// only ever arrive from seedTenantAssets() (30 distinct bundled names) and the
// scripts/ migrations. That makes this the cheapest moment this constraint will
// ever cost — the tables are small, the data is machine-generated, and nobody
// has hand-authored a duplicate yet. Adding it after a clone-and-edit UI ships
// means reconciling duplicates somebody deliberately created.
//
// WHY IT MATTERS. Duplicate names do not fail loudly today; they resolve
// INCONSISTENTLY, in four different directions:
//   • core/pipeline.js tenantAssetsToSpecs  → FIRST row wins (byName has-guard)
//   • db/assets.js getAssetDirections       → LAST row wins (Map.set, no guard)
//   • services/copyReview.js fieldKey       → (asset, field, instance), no field
//                                             ordinal, so a second field of the
//                                             same name overwrites the first's verdict
//   • destinations/googleDocs.js ctxKey     → same collapse on the draft insert path
// So one duplicated name renders row A's fields under row B's creative direction
// and silently drops a review verdict. That is not a bug you find by reading a
// doc; it is a bug you find by not finding something.
//
// FUNCTIONAL, NOT RAW-TEXT. The index folds names with the SAME function
// src/utils/normalize.js applies (case, unicode dashes, spaces around hyphens,
// whitespace runs). A raw-text UNIQUE would let the constraint and the lookup
// disagree: 'Nurture Email' and 'nurture  email' are two rows to raw text and
// ONE asset to the pipeline, so raw-text uniqueness would accept exactly the
// duplicates that break it. See NORMALIZE_SQL below.
//
// REPORTS BEFORE IT ENFORCES. Dry run (the default) lists every conflict it
// finds, per tenant, with both rows. --commit refuses outright if any conflict
// exists — it does NOT auto-resolve, because which row survives is a judgement
// about a tenant's data that this script has no basis to make. Everything runs
// in ONE transaction, so a refusal leaves nothing behind: no function, no index.
//
//   node scripts/migrateAddAssetUniqueness.js            # dry run — writes nothing
//   node scripts/migrateAddAssetUniqueness.js --commit   # create the indexes
//
// Run it in the Railway console as plain `node` (never `railway run node …`).

const TAG = '[asset-uniqueness]';
const COMMIT = process.argv.includes('--commit');

// --- The normalizer, as SQL --------------------------------------------------
//
// A functional index needs an IMMUTABLE expression, so this is a mirror of
// src/utils/normalize.js in SQL rather than a call into it. The two character
// classes are written as \uXXXX escapes so this file stays pure ASCII and no
// editor or transfer can silently mangle an invisible character.
//
// Both classes are DERIVED FROM the JS regexes, not retyped: WS is exactly the
// 25 characters JS `\s` matches, DASH exactly the 7 that `[‐-―−]` matches
// (U+2010..U+2015 plus U+2212). test/smoke.test.js recomputes both by scanning
// codepoints and asserts they still equal these strings, so if a future edit to
// normalize.js changes either class this migration fails CI instead of drifting
// out of agreement with the pipeline.
//
// Spelling WS out is load-bearing, not pedantry: Postgres `\s` is
// locale-dependent and does NOT match U+00A0 (verified on PG 16 / C.UTF-8),
// while JS `\s` does. Using `\s` here would make the index LAXER than the
// pipeline — it would accept two names the pipeline treats as one, which is
// precisely the ambiguity this migration exists to remove.
const WS = '\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const DASH = '\\u2010-\\u2015\\u2212';

// Mirrors normalize(): lower → fold dashes → drop spaces around hyphens →
// collapse whitespace runs → trim. The step ORDER matters and matches the JS:
// dropping spaces around hyphens BEFORE collapsing runs is what turns
// 'A  —  B' into 'a-b' rather than 'a - b'.
//
// btrim's second argument is a plain ASCII space on purpose: by the time it
// runs, every whitespace run has already become one U+0020, so there is nothing
// exotic left at either end.
const NORMALIZE_SQL = `
  btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(coalesce($1, '')), '[${DASH}]', '-', 'g'),
        '[${WS}]*-[${WS}]*', '-', 'g'),
      '[${WS}]+', ' ', 'g'),
    ' ')`;

const CREATE_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION quillio_normalize_name(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$ SELECT${NORMALIZE_SQL} $fn$`;

// The two indexes.
//
// coalesce() on the leading column: both tenant_id and asset_type_id are
// NULLABLE, and a unique index treats NULLs as DISTINCT — so without this, two
// orphan rows sharing a name would slip straight through the constraint.
// NULLS NOT DISTINCT would say it better but is PG15+, and this has to run on
// whatever Railway is serving. '' is not a reachable tenants.id and -1 is not a
// reachable asset_types.id, so neither sentinel can collide with a real row.
const INDEXES = [
  {
    name: 'asset_types_tenant_name_norm_uniq',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS asset_types_tenant_name_norm_uniq
            ON asset_types (coalesce(tenant_id, ''), quillio_normalize_name(name))`,
  },
  {
    name: 'copy_fields_asset_field_norm_uniq',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS copy_fields_asset_field_norm_uniq
            ON copy_fields (coalesce(asset_type_id, -1), quillio_normalize_name(field_name))`,
  },
];

// --- Conflict detection ------------------------------------------------------

// Duplicate asset names within one tenant, under the normalized form. Returns
// one row per COLLIDING GROUP with the members as a JSON array, so the report
// can show every row a human has to choose between.
const ASSET_CONFLICT_SQL = `
  SELECT coalesce(at.tenant_id, '(null tenant)') AS tenant_id,
         quillio_normalize_name(at.name)         AS normalized,
         count(*)                                AS n,
         json_agg(json_build_object(
           'id', at.id, 'name', at.name, 'is_active', at.is_active,
           'sort_order', at.sort_order) ORDER BY at.id) AS rows
    FROM asset_types at
   GROUP BY coalesce(at.tenant_id, ''), coalesce(at.tenant_id, '(null tenant)'),
            quillio_normalize_name(at.name)
  HAVING count(*) > 1
   ORDER BY 1, 2`;

// Duplicate field names within one asset type. Carries the owning asset and
// tenant so the report names the thing a human would go looking for.
const FIELD_CONFLICT_SQL = `
  SELECT coalesce(at.tenant_id, '(null tenant)')  AS tenant_id,
         coalesce(at.name, '(orphan field row)')  AS asset_name,
         cf.asset_type_id                         AS asset_type_id,
         quillio_normalize_name(cf.field_name)    AS normalized,
         count(*)                                 AS n,
         json_agg(json_build_object(
           'id', cf.id, 'field_name', cf.field_name,
           'char_max', cf.char_max, 'sort_order', cf.sort_order) ORDER BY cf.id) AS rows
    FROM copy_fields cf
    LEFT JOIN asset_types at ON at.id = cf.asset_type_id
   GROUP BY coalesce(at.tenant_id, '(null tenant)'), coalesce(at.name, '(orphan field row)'),
            cf.asset_type_id, quillio_normalize_name(cf.field_name)
  HAVING count(*) > 1
   ORDER BY 1, 2, 4`;

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Print one conflict group the way a person has to read it: the normalized key
// they collide on, then every row, so the choice of which survives is obvious.
function reportAssetConflicts(groups) {
  console.log(`\n${TAG} asset_types — ${groups.length} conflicting name(s):`);
  for (const g of groups) {
    console.log(`\n  tenant ${g.tenant_id} · normalizes to "${g.normalized}" · ${g.n} rows`);
    for (const r of g.rows) {
      console.log(
        `    id=${r.id}  name=${JSON.stringify(r.name)}  active=${r.is_active}  sort_order=${r.sort_order}`
      );
    }
  }
}

function reportFieldConflicts(groups) {
  console.log(`\n${TAG} copy_fields — ${groups.length} conflicting field name(s):`);
  for (const g of groups) {
    console.log(
      `\n  tenant ${g.tenant_id} · asset ${JSON.stringify(g.asset_name)} (asset_type_id=${g.asset_type_id})` +
        ` · normalizes to "${g.normalized}" · ${g.n} rows`
    );
    for (const r of g.rows) {
      console.log(
        `    id=${r.id}  field_name=${JSON.stringify(r.field_name)}  char_max=${r.char_max}  sort_order=${r.sort_order}`
      );
    }
  }
}

// Rows the index's coalesce() sentinels are covering for. Not a conflict on its
// own — reported so a NULL owner is a thing somebody saw, not a thing the
// constraint quietly absorbed.
async function reportNullOwners(client) {
  const a = await client.query('SELECT count(*)::int AS n FROM asset_types WHERE tenant_id IS NULL');
  const f = await client.query('SELECT count(*)::int AS n FROM copy_fields WHERE asset_type_id IS NULL');
  if (a.rows[0].n > 0 || f.rows[0].n > 0) {
    console.log(
      `\n${TAG} NOTE: ${a.rows[0].n} asset_types row(s) with NULL tenant_id, ` +
        `${f.rows[0].n} copy_fields row(s) with NULL asset_type_id. ` +
        'The index groups these under a sentinel so they constrain each other.'
    );
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(`${TAG} DATABASE_URL is not set in this environment.`);
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg" — is it installed? ${err.message}`);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: sslFor(process.env.DATABASE_URL),
  });

  let refused = false;
  try {
    await client.connect();
    console.log(
      `${TAG} mode: ${COMMIT ? 'COMMIT (creates the indexes)' : 'DRY RUN (rolls back — pass --commit to apply)'}`
    );

    // Everything, including the helper function, happens inside ONE transaction.
    // A dry run therefore leaves no trace of the function it needed in order to
    // detect conflicts, and a refusal leaves no half-built index.
    await client.query('BEGIN');

    for (const t of ['asset_types', 'copy_fields']) {
      const res = await client.query('SELECT to_regclass($1) AS oid', [t]);
      if (!res.rows[0].oid) throw new Error(`table "${t}" does not exist — run scripts/migrateDb.js first`);
    }

    await client.query(CREATE_FUNCTION_SQL);
    console.log(`${TAG} defined quillio_normalize_name(text) (IMMUTABLE)`);

    const counts = await client.query(
      'SELECT (SELECT count(*) FROM asset_types)::int AS assets, (SELECT count(*) FROM copy_fields)::int AS fields'
    );
    const tenants = await client.query(
      'SELECT count(DISTINCT coalesce(tenant_id, \'\'))::int AS n FROM asset_types'
    );
    console.log(
      `${TAG} scanning ${counts.rows[0].assets} asset_types row(s) and ` +
        `${counts.rows[0].fields} copy_fields row(s) across ${tenants.rows[0].n} tenant(s)`
    );

    const assetConflicts = (await client.query(ASSET_CONFLICT_SQL)).rows;
    const fieldConflicts = (await client.query(FIELD_CONFLICT_SQL)).rows;
    await reportNullOwners(client);

    if (assetConflicts.length) reportAssetConflicts(assetConflicts);
    if (fieldConflicts.length) reportFieldConflicts(fieldConflicts);

    const total = assetConflicts.length + fieldConflicts.length;
    if (total === 0) {
      console.log(`\n${TAG} no conflicts — every name is already unique under the normalized form.`);
    }

    if (total > 0) {
      // Refuse. Deliberately NOT resolved automatically: picking which row
      // survives decides which fields a tenant's doc renders, and nothing in
      // the schema says which one they meant.
      console.error(
        `\n${TAG} REFUSING TO CREATE THE INDEXES — ${total} conflict(s) above must be resolved by hand first.` +
          '\n' + TAG + ' Nothing was written. Decide which row survives, delete or rename the other,' +
          '\n' + TAG + ' then re-run this script.'
      );
      await client.query('ROLLBACK');
      refused = true;
    } else if (!COMMIT) {
      console.log(`${TAG} DRY RUN — rolling back. Re-run with --commit to create:`);
      for (const ix of INDEXES) console.log(`${TAG}   ${ix.name}`);
      await client.query('ROLLBACK');
    } else {
      for (const ix of INDEXES) {
        await client.query(ix.sql);
        console.log(`${TAG} created index ${ix.name}`);
      }
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED — the asset library is now unique under the normalized form.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED (rolled back, nothing changed): ${err.message}`);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
  // Non-zero on refusal so a deploy pipeline treats it as the stop it is.
  process.exit(refused ? 2 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { WS, DASH, NORMALIZE_SQL, CREATE_FUNCTION_SQL, INDEXES, ASSET_CONFLICT_SQL, FIELD_CONFLICT_SQL };
