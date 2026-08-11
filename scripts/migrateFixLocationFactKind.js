'use strict';

// August 2026 corrective migration: `Track / Room Label` and `Location Label`
// were tiered `fact_kind = 'datetime'` by migrateAddReminderDateLine.js. They
// carry a ROOM and a PLACE, not a date.
//
// WHY IT WAS WRONG. That migration marked four field names as transcription
// fields in one list, which was right — all four carry a supplied fact rather
// than generating one — and gave them all the same KIND, which was not. A track
// label wants "Track 3 · Room 210"; a directional label wants "Registration →".
// Neither is a date, the datetime detector would never fire on one, and the note
// the kind gates says "The brief does not state a date or time", which on those
// two fields is a sentence about the wrong fact.
//
// 'location' RATHER THAN NULL. The classification was right and only the kind
// was wrong — these ARE transcription fields, and NULLing them throws away the
// true half. `fact_kind` is free text, so this needs no schema change: it is a
// second value in a column that already exists.
//
// NOTHING FIRES ON 'location' YET, DELIBERATELY. The note and the surface notice
// both gate on 'datetime'. Location is out of scope until the detector is strong
// enough — src/utils/briefFacts.js LOCATION misses "at Moscone West" and "at the
// Hilton", which is the common shape of a venue, and no location invention has
// ever been measured. See ROADMAP.md.
//
// GUARDED ON THE VALUE IT EXPECTS TO REPLACE, per the house rule for any
// migration that writes a value: only rows still holding 'datetime' move, so a
// tenant who has set something themselves is left alone and a re-run is a no-op.
//
// DRY RUN BY DEFAULT. Run in the Railway console as plain node, never
// `railway run`:
//
//   node scripts/migrateFixLocationFactKind.js            # report only
//   node scripts/migrateFixLocationFactKind.js --commit   # write

const FIELDS = ['Track / Room Label', 'Location Label'];
const FROM = 'datetime';
const TO = 'location';

const COMMIT = process.argv.includes('--commit');

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-location-kind] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-location-kind] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  let moved = 0;

  try {
    await client.connect();
    await client.query('BEGIN');

    for (const fieldName of FIELDS) {
      const r = await client.query(
        `UPDATE copy_fields SET fact_kind = $3
          WHERE field_name = $1 AND fact_kind = $2`,
        [fieldName, FROM, TO]
      );
      moved += r.rowCount;
      console.log(
        `  ${COMMIT ? 'SET' : 'would set'} fact_kind '${FROM}' -> '${TO}' on ${r.rowCount} row(s) `
        + `named ${JSON.stringify(fieldName)}`
      );
    }

    // What is left on 'datetime' — the two Date / Location Line rows and nothing
    // else. Printed because a corrective migration should show the state it is
    // correcting TO, not only what it touched.
    const left = await client.query(
      `SELECT field_name, COUNT(*)::int AS n
         FROM copy_fields WHERE fact_kind = $1 GROUP BY field_name ORDER BY field_name`,
      [FROM]
    );
    console.log(`  still '${FROM}' after this:`);
    for (const row of left.rows) console.log(`    ${row.n} x ${JSON.stringify(row.field_name)}`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`[migrate-location-kind] COMMITTED — ${moved} row(s) moved to '${TO}'.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`[migrate-location-kind] DRY RUN — would move ${moved} row(s). Nothing written.`);
    }
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-location-kind] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = { FIELDS, FROM, TO };
