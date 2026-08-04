'use strict';

// Re-derive spec_watch_list.affected_fields for ONE watch entry.
//
// WHY. affected_fields is the LiveSpecs write gate — services/specReview.js
// guardEdits refuses any edit whose (asset, field) pair is not in it — and it was
// computed once by scripts/migrateAddSpecTables.js and never recomputed. So a
// rename since then leaves the entry naming an asset that no longer exists. Watch
// #3's four Google pairs still say 'Google DV360 / Responsive Display', which
// migrateSpecIntegrityFixes.js renamed to 'Google Responsive Display Ad'. Since
// the zero-row guard those approvals fail honestly; this makes them work.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE ASSUMING IT FIXED THE PROBLEM
//
// IT RE-FREEZES THE SNAPSHOT THE INSTANT IT WRITES. This script recomputes one
// entry from the library as it is right now and stores that. It does not make the
// entry self-maintaining, and there is still no code path anywhere that refreshes
// affected_fields. The next rename, retirement or field rename orphans it again,
// exactly as before, and nothing will say so.
//
// AND IT DOES NOT REPAIR THE WORST CASE AT ALL. Of the ways an entry goes stale,
// this one is invisible from both ends: a field ADDED to a watched asset after
// the snapshot was taken is outside the gate, so it can never be approved through
// the queue. It produces no error — guardEdits simply refuses an edit nobody
// thought to make, and the zero-row guard never fires because no write is
// attempted. scripts/auditWatchList.js cannot see it either: it checks that every
// pair IN the entry still resolves, not that every field that SHOULD be in the
// entry is. Nothing in this codebase detects it. Re-deriving happens to sweep such
// fields in, but only for the one entry you name, only at the moment you run it,
// and you will not know whether it did — the diff below will just show pairs
// added.
//
// So: this fixes one instance of a class. It is not a fix for the class.
// ─────────────────────────────────────────────────────────────────────────────
//
// SCOPE — --only=<id> IS REQUIRED. This commit builds the Google repair and
// nothing else. Re-deriving the other entries is a real decision, not a bigger
// loop: on the July 2026 data the LinkedIn entry would LOSE its six carousel
// pairs (correctly — they were repointed to the carousel specs page — but that
// page is on no watch row, so they would end up gated by nothing) and the X entry
// would GAIN 'Organic Social — Twitter/X / Post Copy'. There is deliberately no
// --all until those two have been looked at with dry-run numbers in front of you.
//
// HOW A PAIR IS DERIVED, and the one place this DIVERGES from the original seed:
//
//   SELECT DISTINCT at.name, cf.field_name
//     FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
//    WHERE cf.spec_source = <the entry's source_url>
//      AND at.is_active                      <-- NOT in affectedFieldsWhere()
//    ORDER BY at.name, cf.field_name
//
// `AND at.is_active` is added on purpose and is the only difference from
// affectedFieldsWhere() in scripts/migrateAddSpecTables.js. That function predates
// b2e13f2, which taught specReview to resolve copy_fields only through an ACTIVE
// asset_types row on both the read and the write. Deactivating is how this schema
// retires an asset (there is no DELETE FROM asset_types anywhere), so without the
// predicate this script would write pairs that specReview then cannot reach — the
// zero-row guard would refuse them, and the entry would be freshly re-derived and
// still broken. Inert on today's data: every retired asset is house_default /
// quillio_default, so none can carry a platform spec_source. It is here so the
// gate and the writer agree by construction rather than by luck.
//
// WHAT IT REFUSES, rather than writing:
//   - an empty derivation on a real entry. If the entry's source_url no longer
//     matches any copy_fields.spec_source, re-deriving yields nothing — and an
//     empty gate is not a correct answer, it means the URL is what is stale.
//     (Concretely: if migrateFixGoogleSpecSource.js never ran, the watch row sits
//     on answer/7684791 while the library sits on answer/17090561, and the repair
//     is to repoint source_url first.)
//   - an is_test entry. NULL affected_fields there is load-bearing — it is what
//     stops a test flag from ever naming a real field.
//   - a note-derived entry. The two Litmus rows are matched by spec_note text, not
//     by URL; their fields carry 'quillio_default', so applying the URL rule to
//     them would derive EMPTY and silently wipe 15 pairs of gate. Their rule is
//     not implemented here, so they are refused by name.
//
// DRY RUN BY DEFAULT — it applies inside a transaction and ROLLBACKs, printing the
// exact diff. Pass --commit to write. Idempotent: a second run finds the stored
// list already equal to the derived one and writes nothing.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/rederiveAffectedFields.js --only=3            # dry run
//   node scripts/rederiveAffectedFields.js --only=3 --commit   # write

const { Pool } = require('pg');

const TAG = '[rederive-affected]';
const COMMIT = process.argv.includes('--commit');

// The note-derived entries, by URL. Kept BYTE-IDENTICAL to LITMUS in
// scripts/migrateAddSpecTables.js (a smoke test asserts it) so this list cannot
// drift away from the rows it is meant to protect.
const NOTE_DERIVED_URLS = [
  'https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic',
  'https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support',
];

// The platform rule. `AND at.is_active` is the deliberate divergence — see the
// header. Row counts come back too, so the report can say how much library each
// pair actually stands for.
const DERIVE_SQL = `
  SELECT at.name AS asset, cf.field_name AS field, count(*)::int AS rows
    FROM copy_fields cf
    JOIN asset_types at ON at.id = cf.asset_type_id
   WHERE cf.spec_source = $1
     AND at.is_active
   GROUP BY at.name, cf.field_name
   ORDER BY at.name, cf.field_name`;

function sslFor(url) {
  // A unix-socket connection is local by construction and never speaks SSL.
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function parseOnly(argv) {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  const raw = arg.slice('--only='.length).trim();
  return /^\d+$/.test(raw) ? raw : null;
}

// A pair as one comparable string. Order-insensitive comparison of the two lists
// is what makes a re-run a no-op rather than a rewrite of identical JSON.
//
// Separated by NUL rather than a space, because an asset name can contain spaces
// and so can a field name — 'A B' / 'C' and 'A' / 'B C' would otherwise compare
// equal, and a real change could read as no change. Written as the ESCAPE and
// never as a literal: a raw NUL in the source makes git treat this whole file as
// binary, which costs every future diff, blame and review of it.
const key = (p) => `${p.asset}\u0000${p.field}`;
const sortedKeys = (pairs) => pairs.map(key).sort();

function pairsFromStored(af) {
  if (!Array.isArray(af)) return [];
  return af.filter((p) => p && p.asset && p.field).map((p) => ({ asset: p.asset, field: p.field }));
}

function show(list) {
  return list.length === 0 ? '    (none)' : list.map((p) => `    ${p.asset} / ${p.field}`).join('\n');
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const only = parseOnly(process.argv);
  if (!only) {
    console.error(
      `${TAG} --only=<watch id> is required.\n` +
        '  This commit re-derives ONE entry. There is no --all yet: the LinkedIn entry\n' +
        '  would lose six pairs and the X entry would gain one, and both are decisions\n' +
        '  to make with dry-run numbers in front of you, not side effects of a loop.\n' +
        '  Usage: node scripts/rederiveAffectedFields.js --only=3 [--commit]'
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString, ssl: sslFor(connectionString) });
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  const client = await pool.connect();
  let refused = false;
  try {
    await client.query('BEGIN');

    const res = await client.query(
      'SELECT id, source_url, display_name, affected_fields, is_test FROM spec_watch_list WHERE id = $1 FOR UPDATE',
      [only]
    );
    if (res.rowCount === 0) {
      console.error(`${TAG} no watch entry with id ${only}.`);
      await client.query('ROLLBACK');
      process.exit(1);
    }
    const w = res.rows[0];
    console.log(`\n${TAG} watch #${w.id} "${w.display_name || '(no name)'}"`);
    console.log(`${TAG} source_url: ${w.source_url}`);

    // --- Refusals, before any derivation ---
    if (w.is_test) {
      console.error(
        `\n${TAG} REFUSED: this is the is_test entry. Its NULL affected_fields is what stops a\n` +
          '  test flag from ever naming a real field. Nothing written.'
      );
      refused = true;
    } else if (NOTE_DERIVED_URLS.includes(w.source_url)) {
      console.error(
        `\n${TAG} REFUSED: this entry is derived from spec_note text, not from source_url.\n` +
          "  Its fields carry spec_source 'quillio_default', so the URL rule would derive an\n" +
          '  EMPTY list and wipe the gate. That rule is not implemented here. Nothing written.'
      );
      refused = true;
    }

    if (!refused) {
      const current = pairsFromStored(w.affected_fields);
      const derivedRows = (await client.query(DERIVE_SQL, [w.source_url])).rows;
      const derived = derivedRows.map((r) => ({ asset: r.asset, field: r.field }));
      const rowsFor = new Map(derivedRows.map((r) => [key(r), r.rows]));

      console.log(`\n  CURRENT (${current.length} pair(s)) — the frozen snapshot:`);
      console.log(show(current));
      console.log(`\n  DERIVED (${derived.length} pair(s)) — from the library as it is now:`);
      console.log(
        derived.length === 0
          ? '    (none)'
          : derived.map((p) => `    ${p.asset} / ${p.field}   [${rowsFor.get(key(p))} row(s)]`).join('\n')
      );

      // --- The refusal that matters: an empty derivation on a real entry ---
      if (derived.length === 0) {
        console.error(
          `\n${TAG} REFUSED: the derivation is EMPTY. No copy_fields row carries\n` +
            `  spec_source = '${w.source_url}'.\n` +
            '  An empty gate is not a correct answer — it means the URL on this watch row is\n' +
            '  what is stale, not the pair list. Check whether the library was repointed to a\n' +
            '  different URL (for the Google entry: scripts/migrateFixGoogleSpecSource.js moves\n' +
            '  both the rows and this source_url together, so if it never ran they disagree),\n' +
            '  repoint source_url first, then re-run this. Nothing written.'
        );
        refused = true;
      } else {
        const before = sortedKeys(current);
        const after = sortedKeys(derived);
        const inAfter = new Set(after);
        const inBefore = new Set(before);
        const added = derived.filter((p) => !inBefore.has(key(p)));
        const removed = current.filter((p) => !inAfter.has(key(p)));

        console.log(`\n  ADDED (${added.length}):`);
        console.log(show(added));
        console.log(`  REMOVED (${removed.length}):`);
        console.log(show(removed));

        if (added.length === 0 && removed.length === 0) {
          console.log(
            `\n${TAG} NO CHANGE — the stored list already equals the derived one. Nothing to write.`
          );
        } else {
          const upd = await client.query(
            'UPDATE spec_watch_list SET affected_fields = $1::jsonb WHERE id = $2',
            [JSON.stringify(derived), w.id]
          );
          console.log(`\n${TAG} would update ${upd.rowCount} watch row (+${added.length} / -${removed.length})`);
        }
      }
    }

    if (refused) {
      await client.query('ROLLBACK');
    } else if (COMMIT) {
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED`);
    } else {
      await client.query('ROLLBACK');
      console.log(`${TAG} ROLLED BACK (dry run) — nothing was written. Re-run with --commit to apply.`);
    }

    if (!refused) {
      console.log(
        `\n${TAG} reminder: this re-froze the snapshot. Nothing refreshes affected_fields, and a\n` +
          '  field added to a watched asset after this moment is outside the gate with nothing\n' +
          '  anywhere to detect it. Verify with: node scripts/auditWatchList.js'
      );
    }
    console.log(`${TAG} done`);
    process.exit(refused ? 2 : 0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED (rolled back): ${err.message}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();
