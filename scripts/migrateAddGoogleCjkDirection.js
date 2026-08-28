'use strict';

// August 2026 — record Google's double-width counting rule on the two assets
// whose pages publish it, as asset_direction.
//
// Structural precedent: scripts/migrateAddXConversationButtonAd.js — --verify /
// dry-run-by-default / --commit, inTxn, one transaction, and a QUOTES array that
// must be found in the LIVE hashed text before anything is written.
//
// ─── IT SHIPS REFUSING ──────────────────────────────────────────────────────
// QUOTES IS EMPTY. requireHeaderEvidence() turns that absence into a refusal
// before the network and before DATABASE_URL is read. The authoring session had
// no egress to support.google.com, so no reading of these pages stands behind
// this file TODAY — even though both sentences were captured by earlier work and
// are quoted below. A capture from a previous week is a claim about a page as it
// was; the gate is about the page as it is.
//
// TO FINISH IT: fill QUOTES from the header text below (no re-dump needed — see
// "THE TEXT IS ALREADY IN THE REPO"), then run --verify from a console with
// egress.
//
// ─── THIS IS NOT ONE FACT ABOUT GOOGLE. IT IS TWO PAGES SAYING IT DIFFERENTLY ─
// The single most important constraint on this file. Two sources, two
// citations, two sentences, never merged.
//
// PERFORMANCE MAX — https://support.google.com/google-ads/answer/17091269
//
//   "In text assets, the length limits are the same across all languages. Each
//    character in double-width languages like Korean, Japanese, or Chinese
//    counts as 2 towards the limit instead of one."
//
// RESPONSIVE SEARCH — https://support.google.com/google-ads/answer/7684791
//
//   "To help your ads show in their entirety when possible, responsive search
//    ads have character limits. The headline fields for responsive search ads
//    support up to 30 characters. The description fields support up to 90
//    characters each, and the path fields support up to 15 each. Every character
//    in a double width language like Korean, Japanese, or Chinese counts as 2
//    characters."
//
// HYPHENATED on one page, NOT on the other. "double-width languages" against "a
// double width language"; "counts as 2 towards the limit instead of one" against
// "counts as 2 characters". A quote assembled from both would read perfectly and
// match neither page — which is exactly how the X media-headline quote was
// wrong, and it is the reason these are two spans rather than one.
//
// GOOGLE DEMAND GEN VIDEO IS DELIBERATELY EXCLUDED. Its page (17091270) carries
// a bare table — "Type Maximum length Headline 30 characters Long headline 90
// characters Description 90 characters Call to action 10 characters Final URL
// Any" — and no such sentence. Captured at
// scripts/migrateAddGoogleVideoAssets.js:31-33. Applying a Performance Max
// sentence to it would be a blanket-Google claim of exactly the kind this file
// is scoped against, and it would cite a page that does not say it.
//
// ─── THE TEXT IS ALREADY IN THE REPO, AND ONE HALF WAS UNGATED ────────────
// Neither sentence needed a fresh dump. Both were read through the detector's
// own fetchText + normalize by earlier work:
//
//   PERFORMANCE MAX — scripts/migrateAddGoogleVideoAssets.js:223, inside that
//   file's `quotes` array. That array is checked at :465-472 against
//   `hashableText({ content_stop_marker: null }, raw)` and the run REFUSES if
//   any quote is missing. So its presence in the hashed text is a gate that
//   migration cannot pass without — the strongest evidence available short of
//   a fetch in this run, which is what --verify adds.
//
//   RESPONSIVE SEARCH — scripts/migrateAddGoogleSearchAsset.js:20-22, from a
//   2026-08-21 dump via scripts/probeGoogleSearchSpec.js. IT WAS IN A COMMENT
//   AND IN NO GATE: that file's QUOTES array stopped at "the path fields support
//   up to 15 each" and never reached the double-width clause. A span has been
//   added there in the same change as this file, so the sentence this migration
//   cites is asserted by the migration that seeded the asset too.
//
// ─── WHY asset_direction AND NOT spec_note ──────────────────────────────────
// THIS DOES NOT OVERTURN scripts/migrateAddGoogleVideoAssets.js:81-88. That
// comment declined to put the CJK rule in spec_note because the fact is
// ASSET-LEVEL and repeating it on nine fields would be noise carrying one fact
// about the asset. That reasoning is correct and it is what sends the sentence
// here: asset_direction is the asset-level channel. Read the two together — the
// comment says where it does not go, this file says where it does.
//
// (The field list would have been 16, not 9: nine Performance Max fields plus
// seven cited Responsive Search fields. The objection gets worse with scope, not
// better.)
//
// THE OTHER ASSET-LEVEL CHANNEL IS A DEAD END, which is what leaves
// asset_direction as the only option rather than the preferred one of two.
// asset_types.spec_note is WRITTEN by db/assets.js:69, SELECTed by
// db/assets.js:182, and DROPPED by core/pipeline.js rowToSpecGroup — which maps
// name, group, sort_order and asset_direction and nothing else. `a.spec_note`
// appears zero times in core/pipeline.js. A sentence written there reaches no
// document and no prompt, and nothing errors.
//
// WHERE asset_direction DOES GO, measured rather than assumed:
// destinations/googleDocs.js:945-950 renders it as one italic line directly
// under the asset heading, and it reaches the drafting prompt.
//
// ─── THE COST, STATED BECAUSE IT IS REAL ────────────────────────────────────
// asset_direction reaches the MODEL as well as the writer. So every Latin-script
// campaign on these two assets now carries a sentence about Korean, Japanese and
// Chinese character counting in its prompt, where it can do nothing.
//
// That is the same shape as the `enforced` tier line this repo already flags as
// redundant with the character-limit bullet beside it: a true sentence with no
// work to do. It is accepted here because the alternative channels are a dead
// column and sixteen field notes, and because the reader who needs it has no
// other way to be told. IF A BEFORE/AFTER EVER SHOWS THESE TWO ASSETS GOING FLAT,
// THIS IS A CANDIDATE CAUSE AND THIS IS WHERE TO LOOK.
//
// ─── ONE WORDING FOR BOTH NOTES, TWO WORDINGS FOR THE TWO QUOTES ──────────
// The sentence appended to each asset is IDENTICAL. The quotes are not, and
// must not be.
//
// The appended sentence is NOT a quotation — it is Quillio's sentence to a
// writer, in the statement-of-consequence form notesAB measured (the imperative
// rewrite of the comparable Pinterest note scored 0/10 within its stated number,
// level with no note at all, and collapsed the spread from 64 to 13). Mirroring
// each page's hyphenation into the writer-facing text would put "double-width"
// on one asset and "double width" on the next in the same library, which reads
// as a typo rather than as fidelity.
//
// The fidelity belongs in the CITATION, and that is where it is: two spans, two
// URLs, each asset gated on its own. If you would rather the two sentences
// differ, change SENTENCE to a per-asset field — the ASSETS array already
// carries one string each and nothing else assumes they match.
//
// ─── IT APPENDS UNDER A GUARD. IT NEVER REPLACES. ──────────────────────────
// Both assets carry real creative direction today, and a character-counting rule
// must not silently take its place:
//
//   Google Performance Max
//     "The system assembles the ad. Every asset has to stand alone and beside
//      any other."
//   Google Responsive Search Ad
//     "They are already looking. Match the intent, name the thing, skip the
//      setup."
//
// The UPDATE is guarded on the exact expected string, per this repo's house rule
// for any migration that writes a value: it touches only rows still holding what
// this file expects to extend. A row holding anything else — an older direction,
// a newer one, or one this migration has already extended — is REPORTED AND
// SKIPPED, never overwritten. That also makes it idempotent: a second run finds
// the appended value, matches no guard, and reports 0.
//
// ─── NO GATE CHANGES, SO NO REDERIVE ───────────────────────────────────────
// Unlike the asset-seeding migrations this copies from, nothing here creates a
// (asset, field) pair. No copy_fields row is touched, no spec_source is written,
// no citation moves. spec_watch_list.affected_fields is unaffected and
// scripts/rederiveAffectedFields.js is NOT part of this change.
//
// The two watch rows are read anyway, and the run REFUSES if either is missing —
// not because a gate would go stale, but because this file quotes those pages as
// its evidence, and a page nobody watches is one whose wording can move with
// nothing noticing.
//
//   node scripts/migrateAddGoogleCjkDirection.js --verify   # evidence + fetch + quotes
//   node scripts/migrateAddGoogleCjkDirection.js            # dry run (ROLLBACK)
//   node scripts/migrateAddGoogleCjkDirection.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[google-cjk-direction]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const PMAX_URL = 'https://support.google.com/google-ads/answer/17091269';
const RSA_URL = 'https://support.google.com/google-ads/answer/7684791';

// ─── THE PAGE TEXT, AS READ ────────────────────────────────────────────────
// EMPTY. Fill from the header above — both spans are already in the repo and
// neither needs a re-dump:
//
//   [0] Performance Max, the whole double-width sentence, byte-identical to
//       scripts/migrateAddGoogleVideoAssets.js:223.
//   [1] Responsive Search, the double-width clause, byte-identical to the span
//       added to scripts/migrateAddGoogleSearchAsset.js in this change.
//
// Both are ASCII. Neither carries a curly apostrophe, an entity or a dash — the
// RSA page does carry U+2019 apostrophes elsewhere, which is why that file's
// other quotes have them, but not in this clause.
const QUOTES = [];

// WHICH QUOTE IS EVIDENCE FOR WHICH ASSET. Asset name -> index into QUOTES.
//
// The same arrangement scripts/migrateAddXConversationButtonAd.js uses per
// field, applied per asset because that is the grain this migration writes at.
// Every asset must be a key; an unmapped one is a refusal rather than a fall
// back to "some quote mentions double width", which is the check that would let
// the Performance Max sentence stand as evidence for the Responsive Search
// append and vice versa — the merge this whole file is scoped against.
const EVIDENCE = {};

// ─── THE SENTENCE ──────────────────────────────────────────────────────────
// One wording, appended to both. See "ONE WORDING FOR BOTH NOTES" above for why
// it does not mirror each page's hyphenation.
//
// It names the CONSEQUENCE for the limits the writer can already see in their
// brackets, rather than restating the rule as the page phrases it. "Counts as 2
// towards the limit instead of one" is about Google's counter; "so these limits
// give half the room." is about the line being written.
const SENTENCE =
  'In double-width languages such as Korean, Japanese or Chinese every character counts as two, '
  + 'so these limits give half the room.';

// [name, url, expectedDirection] — the direction this migration expects to find
// and extend. Guarded, never replaced.
//
// The expected strings are BYTE-IDENTICAL to ASSET_DIRECTION in
// src/data/defaultAssets.js:615-622 and to the `direction` values in the
// migrations that seed these assets (migrateAddGoogleSearchAsset.js:161,
// migrateAddGoogleVideoAssets.js:212). A smoke test should compare them; until
// that half lands, the guard failing on every tenant is the symptom.
const ASSETS = [
  {
    name: 'Google Performance Max',
    url: PMAX_URL,
    expected: 'The system assembles the ad. Every asset has to stand alone and beside any other.',
  },
  {
    name: 'Google Responsive Search Ad',
    url: RSA_URL,
    expected: 'They are already looking. Match the intent, name the thing, skip the setup.',
  },
];

// What the row should hold afterwards. One space, then the sentence — the
// composed value is computed here rather than written out twice, so the guard
// and the write cannot disagree about what "already appended" looks like.
function appended(asset) {
  return `${asset.expected} ${SENTENCE}`;
}

// The ONE transformation applied to a quote before matching, and it is the same
// one normalize() ends with. Not a general cleaner: no case folding, no
// punctuation folding, no entity decoding.
function asNormalized(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// ─── THE REFUSAL ────────────────────────────────────────────────────────────
// Called before the network and before the database, by --verify and by the
// write path alike.
function requireHeaderEvidence() {
  if (!Array.isArray(QUOTES) || QUOTES.length === 0) {
    return {
      ok: false,
      why: 'QUOTES is empty — no reading of these pages stands behind this run. Both sentences are in '
        + 'the header and in the repo already, so this is a transcription step rather than a dump:\n'
        + `       [0] the Performance Max sentence, from ${PMAX_URL}\n`
        + `       [1] the Responsive Search clause, from ${RSA_URL}\n`
        + '       Fill QUOTES and EVIDENCE, then run --verify from a console with egress.',
    };
  }
  for (const asset of ASSETS) {
    if (!Object.prototype.hasOwnProperty.call(EVIDENCE, asset.name)) {
      return {
        ok: false,
        why: `${asset.name} names no quote in EVIDENCE. Each asset cites its OWN page — the two pages `
          + 'word this rule differently and a shared quote would make one of them a citation for a '
          + 'sentence it does not carry.',
      };
    }
    const idx = EVIDENCE[asset.name];
    if (!Number.isInteger(idx) || idx < 0 || idx >= QUOTES.length) {
      return {
        ok: false,
        why: `EVIDENCE[${JSON.stringify(asset.name)}] is ${JSON.stringify(idx)}, which is not an index `
          + `into QUOTES (0..${QUOTES.length - 1}).`,
      };
    }
  }
  // NO TWO ASSETS MAY SHARE A QUOTE. The whole scope of this migration is that
  // these are two sources saying the same thing in different words; one span
  // standing for both is the merge, arriving through the evidence map.
  const used = ASSETS.map((a) => EVIDENCE[a.name]);
  if (new Set(used).size !== used.length) {
    return {
      ok: false,
      why: 'two assets name the same quote. Performance Max and Responsive Search publish this rule in '
        + 'different words on different pages; a shared span means one of them is cited to a sentence '
        + 'its own page does not carry.',
    };
  }
  return { ok: true };
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// --- the pages --------------------------------------------------------------
// Returns { ok, why }. Called by --verify AND by the write path, so no value is
// written without both pages being read in the same run.
async function readPages() {
  const evidence = requireHeaderEvidence();
  if (!evidence.ok) return evidence;

  const { fetchText, hashableText } = require('../src/services/specDetector');

  for (const asset of ASSETS) {
    console.log(`\n${'='.repeat(74)}\n${asset.name}\n${asset.url}\n${'='.repeat(74)}`);
    let a;
    let b;
    try {
      const rawA = await fetchText(asset.url);
      await new Promise((r) => setTimeout(r, 2500));
      const rawB = await fetchText(asset.url);
      // content_stop_marker is null on both rows, so hashableText is normalize().
      // Called through the helper anyway, so this measures the path the
      // detector's run loop takes rather than a shortcut around it.
      a = hashableText({ content_stop_marker: null }, rawA);
      b = hashableText({ content_stop_marker: null }, rawB);
    } catch (err) {
      return { ok: false, why: `${asset.name}: fetch failed: ${err.message}. A run with no network is a refusal, not a fallback.` };
    }

    console.log(`   hashed ${a.length} chars`);
    console.log(`   across two fetches: ${a === b ? 'STABLE' : 'VARIES'}`);

    const idx = EVIDENCE[asset.name];
    const q = asNormalized(QUOTES[idx]);
    const n = count(a, q);
    console.log(`   [${idx}] ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 52))}${q.length > 52 ? '…' : ''}`);
    if (n > 0) {
      const at = a.indexOf(q);
      console.log(`            at char ${at} of ${a.length} (${Math.round((at / a.length) * 1000) / 10}%)`);
    }
    if (n === 0) {
      return {
        ok: false,
        why: `${asset.name}: its quoted sentence is not on the page. BEFORE CONCLUDING GOOGLE CHANGED IT, `
          + 'check the transcription. The two pages word this rule differently — Performance Max is '
          + 'HYPHENATED ("double-width languages", "counts as 2 towards the limit instead of one") and '
          + 'Responsive Search is not ("a double width language", "counts as 2 characters") — so the '
          + 'likeliest error is one span carrying the other page\'s wording. A quote differing in '
          + 'hyphenation or phrasing is ours to fix; one saying the rule no longer applies is Google\'s, '
          + 'and that is a real finding.',
      };
    }

    // THE OTHER PAGE'S WORDING MUST NOT BE ON THIS PAGE'S SPAN. Reported, not
    // refused: if both pages ever converge on one wording the merge stops being
    // a defect, but that is a finding for a human rather than a rule.
    const other = ASSETS.find((x) => x.name !== asset.name);
    if (other) {
      const otherQ = asNormalized(QUOTES[EVIDENCE[other.name]]);
      const alsoHere = count(a, otherQ);
      if (alsoHere > 0) {
        console.log(`   NOTE: ${other.name}'s span also appears here ${alsoHere}x. The two pages have`);
        console.log('   converged, or the two spans are not as distinct as the header claims.');
      }
    }
  }
  return { ok: true };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (VERIFY) {
    const r = await readPages();
    console.log(`\n${TAG} ${r.ok ? 'VERIFY PASSED — nothing written.' : `VERIFY FAILED: ${r.why}`}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  // THE EVIDENCE CHECK RUNS BEFORE DATABASE_URL IS EVEN READ. A file with no
  // quotes has nothing to say to a database.
  const evidence = requireHeaderEvidence();
  if (!evidence.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${evidence.why}`);
    process.exit(1);
  }

  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — nothing to do.`);
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg": ${err.message}`);
    process.exit(1);
  }

  // THE PAGES ARE READ BEFORE THE DATABASE IS OPENED.
  const pages = await readPages();
  if (!pages.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${pages.why}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`\n${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  let inTxn = false;
  try {
    await client.query('BEGIN');
    inTxn = true;

    // BOTH PAGES MUST BE WATCHED. Not a gate question — nothing here changes
    // affected_fields — but this file cites these pages as its evidence, and a
    // cited page nobody watches can change its wording with nothing noticing.
    for (const asset of ASSETS) {
      const watch = await client.query(
        'SELECT id, display_name FROM spec_watch_list WHERE source_url = $1',
        [asset.url]
      );
      if (watch.rowCount === 0) {
        throw new Error(
          `no watch row for ${asset.url}, which ${asset.name}'s direction cites. Nothing written.`
        );
      }
      console.log(`${TAG} watch row #${watch.rows[0].id} — ${watch.rows[0].display_name} (not touched)`);
    }

    let changed = 0;
    let already = 0;
    let other = 0;
    let absent = 0;

    for (const asset of ASSETS) {
      console.log(`\n${'─'.repeat(74)}\n${asset.name}\n${'─'.repeat(74)}`);

      // READ FIRST, so a row that is skipped is NAMED rather than silently
      // absent from a rowCount. The three skip reasons are different problems
      // and a bare "0 rows" would collapse them into one.
      const rows = await client.query(
        `SELECT at.tenant_id, at.asset_direction
           FROM asset_types at
          WHERE at.name = $1
          ORDER BY at.tenant_id`,
        [asset.name]
      );
      if (rows.rowCount === 0) {
        absent += 1;
        console.log(`${TAG}   no tenant has this asset — nothing to extend`);
        continue;
      }

      for (const row of rows.rows) {
        const dir = String(row.asset_direction == null ? '' : row.asset_direction);
        if (dir === appended(asset)) {
          already += 1;
          console.log(`${TAG}   ${row.tenant_id}  already extended — skipped`);
        } else if (dir !== asset.expected) {
          other += 1;
          console.log(`${TAG}   ${row.tenant_id}  DIFFERENT DIRECTION — skipped, not overwritten:`);
          console.log(`${TAG}       holds    ${JSON.stringify(dir)}`);
          console.log(`${TAG}       expected ${JSON.stringify(asset.expected)}`);
        }
      }

      // GUARDED ON THE EXACT EXPECTED VALUE. Only a row still holding what this
      // file expects to extend is written; everything else was named above.
      const upd = await client.query(
        `UPDATE asset_types
            SET asset_direction = $3
          WHERE name = $1
            AND asset_direction = $2`,
        [asset.name, asset.expected, appended(asset)]
      );
      changed += upd.rowCount;
      console.log(`${TAG}   extended on ${upd.rowCount} tenant(s)`);
      console.log(`${TAG}   now: ${JSON.stringify(appended(asset))}`);
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log(`${TAG} ${changed} extended · ${already} already · ${other} different direction · ${absent} asset(s) absent`);
    console.log(`${'═'.repeat(74)}`);
    if (other > 0) {
      console.log(`${TAG} A DIFFERENT DIRECTION IS NOT AN ERROR AND IS NOT A NO-OP TO IGNORE. It means`);
      console.log(`${TAG} somebody or something changed that row since the seed. Read the value printed`);
      console.log(`${TAG} above and decide; this migration will not guess which text to keep.`);
    }
    console.log(`\n${TAG} No copy_fields row was touched, no spec_source moved, and`);
    console.log(`${TAG} affected_fields is unchanged — rederiveAffectedFields is NOT part of this.`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      inTxn = false;
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    if (inTxn) await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} FAILED${inTxn ? ' (rolled back)' : ' (before any transaction opened)'}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

// Required by smoke tests. Guarded above so requiring this file runs nothing.
module.exports = {
  ASSETS, QUOTES, EVIDENCE, SENTENCE, PMAX_URL, RSA_URL,
  appended, asNormalized, requireHeaderEvidence,
};
