'use strict';

// Read-only audit — the LiveSpecs watch list, and whether it still points at
// anything real.
//
// WHY THIS EXISTS. spec_watch_list.affected_fields was computed once, by
// scripts/migrateAddSpecTables.js, from the copy_fields state of that moment, and
// nothing recomputes it (CLAUDE.md now says so). It is not a hint: specReview's
// guardEdits refuses any edit whose (asset, field) pair is not in it, and
// currentValues resolves that pair by asset NAME. So a snapshot taken once decides
// what LiveSpecs may write forever, and every rename or retirement since then can
// have quietly emptied an entry without emptying the queue it feeds. The failure is
// silent in the worst way — the approve form still renders, the write still
// commits, the flag still flips to 'reviewed', and the UPDATE matches zero rows.
//
// FOUR CHECKS:
//
//   1. THE RENAMED ASSET. Rows whose affected_fields still mention 'DV360' or
//      'Responsive Display', with whether that exact name is in asset_types today.
//      migrateSpecIntegrityFixes.js renamed 'Google DV360 / Responsive Display' to
//      'Google Responsive Display Ad' and did not touch spec_watch_list.
//
//   2. PAGES THAT NORMALIZED TO NOTHING. Entries whose stored hash equals
//      hashText(normalize('')) — sha256 of the empty string,
//      e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. A JS
//      shell, an empty body, or a page that is all script/style hashes to this and
//      then reports 'unchanged' on every run forever, because nothing asserts the
//      fetched bytes were the expected page. The constant is COMPUTED from the
//      detector's own normalize/hashText rather than pasted, so it cannot drift
//      away from what the detector actually stores.
//
//   3. COLLIDING HASHES. Any two entries sharing a hash. Distinct URLs are not
//      supposed to agree; when they do it means both fetched the same thing — a
//      host-level interstitial, a consent wall, a redirect to one landing page —
//      and both are watching that instead of their spec page.
//
//   4. EVERY PAIR, RESOLVED. The general form of check 1, since the table is open
//      anyway: for each (asset, field) in each entry, does it still reach a live
//      copy_fields row? Four outcomes, and the middle two are the silent ones:
//        LIVE          resolves; LiveSpecs can read and write it
//        DEAD          rows exist but the asset is deactivated — see below
//        ORPHAN-ASSET  no asset_types row of that name at all (a rename)
//        ORPHAN-FIELD  the asset exists, that field_name does not
//
// WHAT b2e13f2 CHANGED ABOUT "RESOLVES". That commit added `AND at.is_active` to
// currentValues and to commitReview's UPDATE. Deactivating is how this schema
// removes an asset type (there is no DELETE FROM asset_types anywhere), so a pair
// whose rows are all deactivated now matches zero — it reads as resolved against
// the old query and as empty against the new one. This script counts BOTH
// (field_rows_any vs field_rows_active) and reports the difference explicitly, so
// "did that commit change what any watch entry sees?" is answered with a number
// instead of an argument. The commit says it is inert today because every asset
// retired so far is house_default/quillio_default and so was never in an
// affected_fields to begin with; this is the check of that claim, not a restatement
// of it.
//
// ONE MORE THING WORTH KNOWING. currentValues matches on RAW name
// (`at.name = $1`), while the library's uniqueness indexes and tenantAssetsToSpecs
// match through quillio_normalize_name. So a stored name differing only by case,
// dash variant or spacing is ONE asset to the app and a miss to LiveSpecs. Any pair
// that fails the exact match is re-probed through the normalizer, and a pair that
// resolves only that way is called out — it is a different bug from a rename and
// wants a different fix.
//
// A NOTE ON THE COLUMN NAME. The hash column is `current_hash` (see
// migrateAddSpecTables.js and specDetector.js); `content_hash` does not exist on
// this schema. The script reads information_schema first and uses whichever of the
// two it finds, printing which — so it is correct either way rather than failing
// with an undefined_column deep in a query.
//
// WRITES NOTHING. One pool, SELECTs only, no transaction, no DDL.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/auditWatchList.js

const { Pool } = require('pg');
const { normalize, hashText } = require('../src/services/specDetector');

const TAG = '[watch-list-audit]';

// The hash a page with no visible text produces, taken from the detector's own
// functions so this can never disagree with what a run would store.
const EMPTY_HASH = hashText(normalize(''));

function sslFor(url) {
  // A unix-socket connection is local by construction and never speaks SSL.
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// A table that may not exist yet on an un-migrated database. 42P01 is
// undefined_table — the same tolerance db.js applies everywhere else.
async function maybeQuery(pool, sql, label, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    if (err && err.code === '42P01') {
      console.log(`  (${label}: table does not exist on this database — skipped)`);
      return null;
    }
    throw err;
  }
}

function short(h) {
  return h ? String(h).slice(0, 12) : '(null)';
}

// One pair's verdict, from the four counts. Ordered most-specific first: a pair
// with live rows is LIVE whatever else is true of the name.
function classify(p) {
  if (p.asset === null || p.field === null) return 'NO-PAIRS';
  if (p.field_rows_active > 0) return 'LIVE';
  if (p.field_rows_any > 0) return 'DEAD';
  if (p.asset_rows === 0) return 'ORPHAN-ASSET';
  return 'ORPHAN-FIELD';
}

// Every (asset, field) in every watch entry, with the four counts that decide
// whether it resolves. LEFT JOIN LATERAL so an entry with NULL affected_fields
// (the is_test row) still appears, as one row with a null pair. The jsonb_typeof
// guard keeps a non-array value from erroring the whole query.
const PAIRS_SQL = `
  WITH src AS (
    SELECT w.id, w.display_name, w.source_url, w.is_test,
           CASE WHEN jsonb_typeof(w.affected_fields) = 'array'
                THEN w.affected_fields ELSE '[]'::jsonb END AS af
      FROM spec_watch_list w
  ),
  pairs AS (
    SELECT s.id AS watch_id, s.display_name, s.source_url, s.is_test,
           e.ord::int AS pos, e.p->>'asset' AS asset, e.p->>'field' AS field
      FROM src s
      LEFT JOIN LATERAL jsonb_array_elements(s.af) WITH ORDINALITY AS e(p, ord) ON true
  )
  SELECT pr.watch_id, pr.display_name, pr.source_url, pr.is_test, pr.pos,
         pr.asset, pr.field,
         (SELECT count(*)::int FROM asset_types at
           WHERE at.name = pr.asset)                                   AS asset_rows,
         (SELECT count(*)::int FROM asset_types at
           WHERE at.name = pr.asset AND at.is_active)                  AS asset_rows_active,
         (SELECT count(*)::int FROM copy_fields cf
             JOIN asset_types at ON at.id = cf.asset_type_id
           WHERE at.name = pr.asset AND cf.field_name = pr.field)      AS field_rows_any,
         (SELECT count(*)::int FROM copy_fields cf
             JOIN asset_types at ON at.id = cf.asset_type_id
           WHERE at.name = pr.asset AND cf.field_name = pr.field
             AND at.is_active)                                         AS field_rows_active
    FROM pairs pr
   ORDER BY pr.is_test, pr.watch_id, pr.pos`;

// The normalized re-probe for a pair that failed the exact match. Uses the same
// IMMUTABLE function the uniqueness indexes use, so "would this resolve if
// LiveSpecs matched names the way the rest of the app does?" gets a real answer.
const NORM_SQL = `
  SELECT count(*)::int AS n
    FROM copy_fields cf
    JOIN asset_types at ON at.id = cf.asset_type_id
   WHERE quillio_normalize_name(at.name) = quillio_normalize_name($1)
     AND quillio_normalize_name(cf.field_name) = quillio_normalize_name($2)
     AND at.is_active`;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString) });

  try {
    // --- Preflight: does the table exist, and what is the hash column called? ---
    const cols = await maybeQuery(
      pool,
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'spec_watch_list' ORDER BY ordinal_position`,
      'spec_watch_list'
    );
    if (!cols || cols.rowCount === 0) {
      console.log(`${TAG} spec_watch_list does not exist on this database. Nothing to audit.`);
      return;
    }
    const names = cols.rows.map((r) => r.column_name);
    const hashCol = names.includes('current_hash')
      ? 'current_hash'
      : names.includes('content_hash')
        ? 'content_hash'
        : null;
    if (!hashCol) {
      console.error(`${TAG} spec_watch_list has neither current_hash nor content_hash. Columns: ${names.join(', ')}`);
      process.exit(1);
    }

    const total = (await pool.query('SELECT count(*)::int AS n FROM spec_watch_list')).rows[0].n;
    console.log(`${TAG} ${total} watch entr${total === 1 ? 'y' : 'ies'}; hash column is "${hashCol}"`);
    console.log(`${TAG} empty-page hash (computed from the detector's own normalize/hashText):`);
    console.log(`         ${EMPTY_HASH}\n`);

    // --- 1. The renamed asset ------------------------------------------------
    console.log('1. RENAMED ASSET — entries still naming the pre-rename Google asset');
    const renamed = await pool.query(
      `SELECT w.id, w.display_name, w.source_url,
              p->>'asset' AS asset, p->>'field' AS field,
              (SELECT count(*)::int FROM asset_types at WHERE at.name = p->>'asset')                  AS rows_any,
              (SELECT count(*)::int FROM asset_types at WHERE at.name = p->>'asset' AND at.is_active) AS rows_active
         FROM spec_watch_list w,
              jsonb_array_elements(CASE WHEN jsonb_typeof(w.affected_fields) = 'array'
                                        THEN w.affected_fields ELSE '[]'::jsonb END) AS p
        WHERE w.affected_fields::text ILIKE '%DV360%'
           OR w.affected_fields::text ILIKE '%Responsive Display%'
        ORDER BY w.id, p->>'asset', p->>'field'`
    );
    if (renamed.rowCount === 0) {
      console.log('   none — no entry mentions DV360 or Responsive Display.\n');
    } else {
      const missing = renamed.rows.filter((r) => r.rows_any === 0);
      for (const r of renamed.rows) {
        const state =
          r.rows_any === 0
            ? 'NOT IN asset_types — orphaned by the rename'
            : r.rows_active === 0
              ? `${r.rows_any} row(s), ALL INACTIVE`
              : `${r.rows_active} active row(s) — resolves`;
        console.log(`   watch #${r.id} "${r.asset}" / "${r.field}"  ->  ${state}`);
      }
      console.log(
        `   ${missing.length} of ${renamed.rowCount} pair(s) name an asset that no longer exists.` +
          (missing.length
            ? '\n   Those pairs pass guardEdits and then UPDATE zero rows: the approve reports\n' +
              '   success, writes the audit row, and flips the flag to reviewed anyway.'
            : '')
      );
      console.log('');
    }

    // --- 2. Pages that normalized to nothing ---------------------------------
    console.log("2. EMPTY-PAGE HASH — entries watching a page with no visible text");
    const empty = await pool.query(
      `SELECT id, display_name, source_url, is_test, last_checked_at, last_error
         FROM spec_watch_list WHERE ${hashCol} = $1 ORDER BY id`,
      [EMPTY_HASH]
    );
    if (empty.rowCount === 0) {
      console.log('   none — no entry is baselined to the empty-string hash.');
    } else {
      for (const r of empty.rows) {
        console.log(
          `   watch #${r.id} ${r.is_test ? '[TEST] ' : ''}${r.display_name || '(no name)'} — ${r.source_url}`
        );
        console.log(
          `      last checked ${r.last_checked_at ? new Date(r.last_checked_at).toISOString() : 'never'}` +
            `, last_error ${r.last_error || 'none'}`
        );
      }
      console.log('   These will report "unchanged" on every run forever — the fetch succeeds,');
      console.log('   the strip leaves nothing, and nothing checks that the bytes were the page.');
    }
    // Adjacent and free while the table is open: never-baselined entries. Not a
    // fault (a new row is null until its first run), but it is the other way an
    // entry can be watching nothing.
    const nulls = await pool.query(
      `SELECT id, display_name, source_url, last_error FROM spec_watch_list
        WHERE ${hashCol} IS NULL ORDER BY id`
    );
    if (nulls.rowCount > 0) {
      console.log(`   (${nulls.rowCount} entr${nulls.rowCount === 1 ? 'y has' : 'ies have'} no hash yet — never baselined:`);
      for (const r of nulls.rows) {
        console.log(`      #${r.id} ${r.display_name || '(no name)'} — ${r.source_url}` +
          (r.last_error ? `  last_error: ${r.last_error}` : ''));
      }
      console.log('    a fresh row, or one whose hash was reset. Expected only if a run has not happened since.)');
    }
    console.log('');

    // --- 3. Colliding hashes -------------------------------------------------
    console.log('3. COLLIDING HASHES — two or more entries agreeing on one hash');
    const dupes = await pool.query(
      `SELECT ${hashCol} AS h, count(*)::int AS n,
              array_agg(source_url ORDER BY id)   AS urls,
              array_agg(id ORDER BY id)           AS ids,
              array_agg(coalesce(display_name,'(no name)') ORDER BY id) AS labels
         FROM spec_watch_list
        WHERE ${hashCol} IS NOT NULL
        GROUP BY ${hashCol} HAVING count(*) > 1
        ORDER BY count(*) DESC, ${hashCol}`
    );
    if (dupes.rowCount === 0) {
      console.log('   none — every baselined entry has a distinct hash.\n');
    } else {
      for (const g of dupes.rows) {
        console.log(
          `   ${short(g.h)}…  ${g.n} entries${g.h === EMPTY_HASH ? '  (this is the EMPTY-PAGE hash)' : ''}`
        );
        for (let i = 0; i < g.urls.length; i++) {
          console.log(`      #${g.ids[i]} ${g.labels[i]} — ${g.urls[i]}`);
        }
      }
      console.log('   Distinct pages do not agree by accident. Both entries fetched the same');
      console.log('   thing — an interstitial, a consent wall, or a redirect to one landing page.\n');
    }

    // --- 4. Every pair, resolved --------------------------------------------
    console.log('4. PAIR RESOLUTION — does each (asset, field) still reach a live copy_fields row?');
    const pairs = (await pool.query(PAIRS_SQL)).rows;

    // Re-probe the failures through the normalizer, so a raw-text miss is not
    // reported as a rename. Disabled after one 42883 (the function is absent on a
    // database that never ran migrateAddAssetUniqueness.js).
    let normOk = true;
    for (const p of pairs) {
      p.verdict = classify(p);
      p.norm = null;
      if (!normOk || (p.verdict !== 'ORPHAN-ASSET' && p.verdict !== 'ORPHAN-FIELD')) continue;
      try {
        p.norm = (await pool.query(NORM_SQL, [p.asset, p.field])).rows[0].n;
      } catch (err) {
        if (err && err.code === '42883') {
          normOk = false;
          console.log('   (quillio_normalize_name is absent — normalized re-probe skipped)');
        } else throw err;
      }
    }

    const real = pairs.filter((p) => p.asset !== null);
    const tally = { LIVE: 0, DEAD: 0, 'ORPHAN-ASSET': 0, 'ORPHAN-FIELD': 0 };
    for (const p of real) tally[p.verdict]++;

    let lastWatch = null;
    for (const p of pairs) {
      if (p.watch_id !== lastWatch) {
        lastWatch = p.watch_id;
        const of = pairs.filter((x) => x.watch_id === p.watch_id && x.asset !== null);
        const bad = of.filter((x) => x.verdict !== 'LIVE').length;
        console.log(
          `\n   watch #${p.watch_id} ${p.is_test ? '[TEST] ' : ''}${p.display_name || '(no name)'} — ${p.source_url}`
        );
        console.log(
          `      ${of.length} pair(s), ${of.length - bad} live, ${bad} not` +
            (of.length === 0 ? '   (affected_fields is null or empty)' : '')
        );
      }
      if (p.asset === null || p.verdict === 'LIVE') continue;
      const why =
        p.verdict === 'DEAD'
          ? `${p.field_rows_any} row(s) exist but the asset is DEACTIVATED — zero after b2e13f2`
          : p.verdict === 'ORPHAN-ASSET'
            ? 'no asset_types row of that name (renamed or removed)'
            : `asset exists (${p.asset_rows_active} active) but has no field of that name`;
      const norm = p.norm ? `  [would resolve under quillio_normalize_name: ${p.norm} row(s)]` : '';
      console.log(`      ${p.verdict.padEnd(12)} "${p.asset}" / "${p.field}" — ${why}${norm}`);
    }

    // The b2e13f2 question, as a number: pairs the old query counted and the new
    // one does not.
    const changedByIsActive = real.filter((p) => p.field_rows_any > p.field_rows_active);
    console.log(`\n   TOTALS: ${real.length} pair(s) — ${tally.LIVE} live, ${tally.DEAD} dead, ` +
      `${tally['ORPHAN-ASSET']} orphaned asset, ${tally['ORPHAN-FIELD']} orphaned field`);
    console.log(`\n   EFFECT OF b2e13f2 (\`AND at.is_active\` on currentValues + the commitReview UPDATE):`);
    if (changedByIsActive.length === 0) {
      console.log('   No entry is affected. Every pair reachable through affected_fields has the same');
      console.log('   row count with and without the predicate, so the commit is inert here — which is');
      console.log('   what it claimed, now measured rather than assumed.');
    } else {
      console.log(`   ${changedByIsActive.length} pair(s) LOSE rows under the new predicate:`);
      for (const p of changedByIsActive) {
        console.log(
          `      watch #${p.watch_id} "${p.asset}" / "${p.field}": ` +
            `${p.field_rows_any} row(s) before -> ${p.field_rows_active} after`
        );
      }
      console.log('   Those are rows no doc could read anyway, so the smaller number is the true blast');
      console.log('   radius — but a pair dropping to 0 now writes nothing while still reporting success.');
    }

    // --- Verdict -------------------------------------------------------------
    const clean =
      renamed.rows.every((r) => r.rows_any > 0) &&
      empty.rowCount === 0 &&
      dupes.rowCount === 0 &&
      tally.DEAD === 0 &&
      tally['ORPHAN-ASSET'] === 0 &&
      tally['ORPHAN-FIELD'] === 0;
    console.log(
      clean
        ? `\n${TAG} CLEAN. Every entry is baselined to distinct, non-empty content, and every\n` +
            '  (asset, field) it names still reaches a live copy_fields row. Nothing to re-derive.'
        : `\n${TAG} See the rows above. A non-live pair cannot be fixed from copy_fields — it is\n` +
            '  spec_watch_list.affected_fields that is stale, and only re-deriving that entry (the\n' +
            '  query in migrateAddSpecTables.js seedWatchList) restores it.'
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
