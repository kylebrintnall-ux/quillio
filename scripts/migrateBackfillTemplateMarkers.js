'use strict';

// Migration — carry the existing attach/map state onto template_markers
// (document templates, REWORK step one: DATA).
//
// The old shape put an asset type in the middle: upload a template, create an
// asset, attach it, map each field to a marker. That mapping IS template_markers
// data — a mapped copy_fields row already carries the field name, the limit, the
// unit and the note, keyed to a marker. So the tenant who did it the old way does
// not rebuild anything; their work moves.
//
// FOR EVERY TEMPLATE, TWO PASSES:
//
//   1. MAPPED FIELDS become copy markers. copy_fields rows whose
//      template_marker_key is set, on an asset attached to this template:
//      field_name -> marker_name's field, with char_min/char_max/field_type/
//      spec_note/sort_order carried over and is_copy = TRUE. They were mapped by
//      a human, so they are copy by definition.
//
//   2. EVERY OTHER MARKER in doc_templates.placeholders becomes a row with
//      is_copy = FALSE. Those are the cells nobody mapped — {{Form ID}},
//      {{Owner}}, {{Last Updated}} — and false is the right default for exactly
//      the reason it is the column default: wrongly-copy drafts prose into a form
//      ID, wrongly-metadata just leaves the marker showing.
//
// THE POSITION comes from placeholders[].locations[0], which discovery already
// recorded. label_text is left NULL for backfilled rows: the old flow never read
// the neighbouring cell, so there is nothing to carry. Re-uploading the template
// fills it in; until then the self-healing check simply has nothing to check
// against, which is the same as not having it.
//
// WHAT IS LOST, AND IT IS NAMED RATHER THAN GUESSED AT. This script REPORTS,
// per template:
//   • the asset's NAME — the template has its own name, so the asset's is not
//     carried. Printed so the tenant can rename the template if they preferred it.
//   • the asset's asset_direction — creative guidance that has nowhere to live
//     yet. Printed IN FULL, not summarised, so it can be pasted somewhere.
//   • fields mapped to NOTHING — copy a matrix had no cell for. Named, not
//     dropped silently, because they are the tenant's own field definitions and
//     only they can say whether the matrix should grow a row for them.
//
// NOTHING IS DELETED. asset_types.doc_template_id and the copy_fields marker
// columns are left exactly as they are; the old path keeps working until it is
// removed in a later step. Re-running is safe — rows are upserted by
// (template_id, marker_key), and a row the tenant has since EDITED is left alone
// (see the ON CONFLICT clause).
//
// Dry run by default (applies inside a transaction, prints the would-be state,
// then ROLLBACKs). --commit writes.
//
//   node scripts/migrateBackfillTemplateMarkers.js            # dry run
//   node scripts/migrateBackfillTemplateMarkers.js --commit   # write

const { Pool } = require('pg');

const TAG = '[backfill-template-markers]';
const COMMIT = process.argv.includes('--commit');

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function assertSchema(client) {
  const res = await client.query("SELECT to_regclass('template_markers') AS oid");
  if (!res.rows[0].oid) {
    throw new Error('template_markers does not exist. Run scripts/migrateAddTemplateMarkers.js --commit first.');
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString) });
  const client = await pool.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await assertSchema(client);
    await client.query('BEGIN');

    const templates = (
      await client.query(
        `SELECT id, tenant_id, name, placeholders FROM doc_templates ORDER BY id`
      )
    ).rows;
    console.log(`\n${TAG} ${templates.length} template(s) to consider.\n`);

    let insertedCopy = 0;
    let insertedMeta = 0;
    const lost = [];

    for (const tpl of templates) {
      // The assets attached to this template, and their mapped fields.
      const mapped = (
        await client.query(
          `SELECT at.id AS asset_id, at.name AS asset_name, at.asset_direction,
                  cf.id AS field_id, cf.field_name, cf.char_min, cf.char_max,
                  cf.field_type, cf.spec_note, cf.sort_order,
                  cf.template_marker_key, cf.template_marker_name
             FROM asset_types at
             JOIN copy_fields cf ON cf.asset_type_id = at.id
            WHERE at.doc_template_id = $1
            ORDER BY at.id, cf.sort_order, cf.id`,
          [tpl.id]
        )
      ).rows;

      const markers = Array.isArray(tpl.placeholders) ? tpl.placeholders : [];
      const posByKey = new Map();
      for (const m of markers) {
        const loc = (m.locations || [])[0] || null;
        posByKey.set(m.key, {
          name: m.name,
          part: loc ? loc.part : null,
          tableIndex: loc && loc.kind === 'table' ? loc.tableIndex : null,
          row: loc && loc.kind === 'table' ? loc.row : null,
          column: loc && loc.kind === 'table' ? loc.column : null,
          rowSpan: (loc && loc.rowSpan) || 1,
          columnSpan: (loc && loc.columnSpan) || 1,
        });
      }

      console.log(`  TEMPLATE ${tpl.id} "${tpl.name}" (tenant ${tpl.tenant_id})`);
      console.log(`    ${markers.length} discovered marker(s), ${mapped.length} field(s) on attached asset(s)`);

      if (!mapped.length && !markers.length) {
        console.log('    nothing to carry.\n');
        continue;
      }

      // --- pass 1: mapped fields -> copy markers ----------------------------
      const claimed = new Set();
      const assetsSeen = new Map();
      for (const f of mapped) {
        if (!assetsSeen.has(f.asset_id)) {
          assetsSeen.set(f.asset_id, { name: f.asset_name, direction: f.asset_direction, unmapped: [] });
        }
        if (!f.template_marker_key) {
          assetsSeen.get(f.asset_id).unmapped.push(f.field_name);
          continue;
        }
        const pos = posByKey.get(f.template_marker_key) || {};
        // ON CONFLICT DO NOTHING, not DO UPDATE: a row the tenant has already
        // confirmed on the new screen must not be reverted to what the old
        // mapping said. Re-running is then genuinely safe.
        const res = await client.query(
          `INSERT INTO template_markers
             (template_id, marker_key, marker_name, is_copy, char_min, char_max, field_type,
              spec_note, sort_order, part, table_index, row_index, column_index,
              row_span, column_span, label_text)
           VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL)
           ON CONFLICT (template_id, marker_key) DO NOTHING`,
          [
            tpl.id,
            f.template_marker_key,
            f.template_marker_name || pos.name || f.template_marker_key,
            f.char_min || 0,
            f.char_max || 0,
            f.field_type || 'text',
            f.spec_note || null,
            f.sort_order || 0,
            pos.part || null,
            pos.tableIndex,
            pos.row,
            pos.column,
            pos.rowSpan || 1,
            pos.columnSpan || 1,
          ]
        );
        claimed.add(f.template_marker_key);
        insertedCopy += res.rowCount;
        console.log(
          `      copy   {{${f.template_marker_name || f.template_marker_key}}}` +
            `  <- field "${f.field_name}" [${f.char_max || 'no limit'}]${res.rowCount ? '' : '  (already present — left alone)'}`
        );
      }

      // --- pass 2: every other marker -> metadata ---------------------------
      let order = 1000;
      for (const m of markers) {
        if (claimed.has(m.key)) continue;
        const pos = posByKey.get(m.key) || {};
        const res = await client.query(
          `INSERT INTO template_markers
             (template_id, marker_key, marker_name, is_copy, sort_order, part,
              table_index, row_index, column_index, row_span, column_span, label_text)
           VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8,$9,$10,NULL)
           ON CONFLICT (template_id, marker_key) DO NOTHING`,
          [tpl.id, m.key, m.name, order++, pos.part || null, pos.tableIndex, pos.row, pos.column,
            pos.rowSpan || 1, pos.columnSpan || 1]
        );
        insertedMeta += res.rowCount;
        console.log(`      NOT copy {{${m.name}}}  (nobody mapped it)${res.rowCount ? '' : '  (already present)'}`);
      }

      // --- what did not come with it ----------------------------------------
      for (const [assetId, a] of assetsSeen) {
        lost.push({ template: tpl.name, assetId, assetName: a.name, direction: a.direction, unmapped: a.unmapped });
      }
      console.log('');
    }

    console.log(`${TAG} ${insertedCopy} copy marker(s) and ${insertedMeta} metadata marker(s) written.`);

    if (lost.length) {
      console.log(`\n${TAG} WHAT DOES NOT COME WITH IT — named, not guessed at:`);
      for (const l of lost) {
        console.log(`\n  from asset ${l.assetId} "${l.assetName}" (attached to "${l.template}")`);
        console.log(`    ASSET NAME: "${l.assetName}" is not carried — the template has its own name.`);
        console.log(`      Rename the template to it if that was the better name.`);
        if (l.direction) {
          console.log(`    ASSET_DIRECTION is not carried — a template has nowhere to put it yet.`);
          console.log(`      Here it is in full so it can be kept somewhere:`);
          for (const ln of String(l.direction).split('\n')) console.log(`        ${ln}`);
        } else {
          console.log(`    ASSET_DIRECTION: none set — nothing lost.`);
        }
        if (l.unmapped.length) {
          console.log(`    FIELDS MAPPED TO NOTHING (${l.unmapped.length}) — copy the matrix had no cell for:`);
          for (const n of l.unmapped) console.log(`        "${n}"`);
          console.log(`      These are NOT carried. Only you can say whether the matrix should grow`);
          console.log(`      a row for them or whether they belonged to the asset and not the document.`);
        } else {
          console.log(`    FIELDS MAPPED TO NOTHING: none — every field found a marker.`);
        }
      }
    }

    const after = await client.query(
      `SELECT t.name, count(*)::int AS markers,
              count(*) FILTER (WHERE m.is_copy)::int AS copy
         FROM template_markers m JOIN doc_templates t ON t.id = m.template_id
        GROUP BY t.name ORDER BY t.name`
    );
    if (after.rows.length) {
      console.log(`\n${TAG} resulting state:`);
      for (const r of after.rows) console.log(`  "${r.name}": ${r.markers} marker(s), ${r.copy} copy`);
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
