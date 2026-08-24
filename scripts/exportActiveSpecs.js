'use strict';

// Export the active, verified platform specs — READ-ONLY.
//
// One row per distinct spec: asset type, platform, field, the limit, its tier,
// the page it is cited to, and the date a human last read that page. CSV or
// JSON, with a count summary at the top.
//
//   node scripts/exportActiveSpecs.js                    # CSV to stdout
//   node scripts/exportActiveSpecs.js --format=json
//   node scripts/exportActiveSpecs.js --out=specs.csv
//   node scripts/exportActiveSpecs.js --per-tenant       # one row per tenant row
//   node scripts/exportActiveSpecs.js --all-tiers        # + house_default / untiered
//   node scripts/exportActiveSpecs.js --tenant=T0B8LPRDKHR
//   node scripts/exportActiveSpecs.js --selftest         # no DB, no network
//
// Run in the Railway console as plain node — NEVER `railway run` (CLAUDE.md,
// "Running migrations").
//
// ─── THERE IS NO `spec_review` TABLE, AND THE ONE THAT SOUNDS LIKE IT IS NOT IT ─
// This was asked for against a `spec_review` table. No such table exists on this
// schema. The near-miss is `spec_review_queue`, and reaching for it would have
// produced a confident, wrong answer: it holds the DETECTOR'S FLAGS — watch_id,
// source_url, old_hash, new_hash, detected_at, status — one row per time a
// watched page's hash moved. It carries no asset, no field, no limit and no
// tier. A "spec export" built from it would be an export of hash diffs.
//
// The specs live in `copy_fields`, joined to `asset_types` for the asset name and
// the tenant. That is the sole spec source (CLAUDE.md, "Asset library").
//
// ─── THE REQUESTED COLUMNS DO NOT ALL EXIST, AND THREE ARE DERIVED ──────────
// Stated here rather than silently emitted, because a COMPUTED column and a
// STORED one look identical in a CSV, and the whole value of this file is that
// somebody can paste it into a comparison and trust it.
//
//   asset_type          <- asset_types.name                          STORED
//   platform            <- specSourceName(copy_fields.spec_source)   DERIVED
//   field_name          <- copy_fields.field_name                    STORED
//   enforced_value      <- copy_fields.char_max WHERE tier=enforced      SPLIT
//   recommended_value   <- copy_fields.char_max WHERE tier=recommended   SPLIT
//   spec_source         <- specSourceName(...) + placement qualifier  DERIVED
//   last_verified_date  <- copy_fields.spec_verified_at              STORED
//   spec_url            <- copy_fields.spec_source                   STORED
//
// THE NAME COLLISION IS REAL AND IS THE THING MOST LIKELY TO MISLEAD. In this
// schema `spec_source` IS THE URL. The request asks for `spec_source` and
// `spec_url` as two different columns, so `spec_source` here is the display name
// the product renders ("Meta (Facebook Feed)") and `spec_url` is the stored
// column of that name. Both are emitted; neither is invented.
//
// THERE IS NO `platform` COLUMN. Platform is derived from the citation URL by
// src/utils/specSource.specSourceName — IMPORTED, never reimplemented. That
// module's own header says why it lives there: a second copy of the mapping is
// how surfaces come to disagree about who published a limit.
//
// THERE ARE NO `enforced_value` / `recommended_value` COLUMNS. A field holds ONE
// limit (char_min/char_max) and ONE tier (spec_type). The two columns are that
// one value routed by tier, so exactly one of them is populated per row and the
// other is empty. `spec_type` is emitted beside them so the tier is stated rather
// than inferred from which column happens to be filled.
//
// ─── A BARE `enforced_value` IS UNITLESS, SO THREE MORE COLUMNS ARE NOT OPTIONAL ─
// `char_max` alone is a number with no unit and no floor. `field_type` decides
// whether 70 means characters or WORDS, and char_min is the other half of a band
// (Preheader is 85-100, not "100"). A comparison sheet carrying the ceiling alone
// would read 70-words and 70-chars as the same spec. So char_min, char_max,
// field_type and a rendered `limit` string ride along after the requested eight.
//
// ─── WHAT "ACTIVE (VERIFIED)" RESOLVES TO ───────────────────────────────────
// Neither word is a column, and each is one AND in the WHERE clause:
//
//   active    asset_types.is_active = true
//             The retired-asset flag. scripts/rederiveAffectedFields.js carries
//             the same predicate for the same reason.
//
//   verified  copy_fields.spec_verified_at IS NOT NULL
//             A HUMAN opened the cited page and confirmed this number. It is NOT
//             the weekly detector, which compares a hash and never re-reads a
//             number — CLAUDE.md, "'Checked', not 'verified'". Rows are excluded
//             when nobody has ever read their page, which is the honest reading
//             of the word and is why house defaults fall out below.
//
//   tiered    spec_type IN ('enforced','recommended')
//             The population the requested columns describe. A house_default or
//             untiered field has no platform, no citation URL and no verification
//             date by construction — its spec_source is the 'quillio_default'
//             sentinel, which specSourceName maps to null and never prints.
//             --all-tiers includes them anyway, with those columns empty.
//
// ─── ONE SPEC IS N ROWS: copy_fields IS PER TENANT ──────────────────────────
// asset_types carries tenant_id, so the same LinkedIn headline limit exists once
// per tenant. A straight SELECT returns the cross-product, and a comparison sheet
// then shows each platform limit two or more times — which reads as duplicates in
// the data rather than as the schema working correctly.
//
// So the DEFAULT collapses identical rows and reports `tenants`, how many tenant
// rows back each spec. --per-tenant emits the raw rows with tenant_id instead.
//
// THE COLLAPSE KEY INCLUDES THE VALUES, WHICH IS THE POINT. If two tenants hold
// DIFFERENT numbers for one (asset, field) they do not collapse — they stay as
// two rows and the summary names the split under DIVERGENT. That is a real
// finding (a stale row a migration missed, or a base value one tenant's
// correction reached and another's did not), and a GROUP BY keyed on the asset
// and field alone would average it into invisibility.
//
// ─── BASE VALUES, NOT EFFECTIVE ONES — AND THE OVERRIDE IS STILL SURFACED ───
// The value columns read the BASE `char_min`/`char_max`, not
// COALESCE(override, base). Deliberate, and the same call specReview.currentValues
// makes: an override is the TENANT'S OWN number, and this sheet is for comparing
// what we store against what a platform publishes. Resolving the override would
// silently swap one tenant's house preference into a row labelled as Meta's
// published limit.
//
// Overrides cannot merely be dropped either — that would hide a tenant whose docs
// render something else. `overridden_by_tenants` counts them per spec, so the
// sheet says "this base value is right AND n tenants have pinned their own". It
// is 0 nearly everywhere: CLAUDE.md records exactly one override row in
// production, and migrateClearRedundantOverrides cleared the phantom.
//
// ─── READ-ONLY BY CONSTRUCTION ──────────────────────────────────────────────
// One pool, SELECTs only. No INSERT, no UPDATE, no DELETE, no DDL, no
// transaction. Safe to run at any time, including mid-detection-run. The selftest
// asserts this rather than trusting this paragraph.

const { specSourceName, specPlacementName } = require('../src/utils/specSource');

const TAG = '[export-specs]';

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : null;
}

const OPTS = {
  format: (argValue('format') || 'csv').toLowerCase(),
  out: argValue('out'),
  tenant: argValue('tenant'),
  perTenant: process.argv.includes('--per-tenant'),
  allTiers: process.argv.includes('--all-tiers'),
};

// A unix-socket connection is local by construction and never speaks SSL.
// Same helper as scripts/auditWatchList.js.
function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// ─── THE QUERY ──────────────────────────────────────────────────────────────
// $1 is the tenant filter and is nullable: `($1::text IS NULL OR ...)` keeps one
// statement rather than concatenating a predicate, so there is no shape of this
// query that was never exercised. $2 opens the tier gate for --all-tiers.
//
// The requested ORDER BY is platform, asset_type, field_name. Platform is DERIVED
// in JS, so ordering by it in SQL would mean duplicating specSourceName into a
// CASE expression — exactly what src/utils/specSource.js exists to prevent. The
// sort is therefore applied in JS after derivation (see sortRows) and the SQL
// orders by its own stable keys so the input is deterministic either way.
const SPEC_SQL = [
  'SELECT at.tenant_id,',
  '       at.name              AS asset_type,',
  '       cf.field_name,',
  '       cf.spec_type,',
  '       cf.char_min,',
  '       cf.char_max,',
  '       cf.field_type,',
  '       cf.spec_source,',
  "       to_char(cf.spec_verified_at, 'YYYY-MM-DD') AS last_verified_date,",
  '       (cf.char_min_override IS NOT NULL',
  '        OR cf.char_max_override IS NOT NULL',
  '        OR cf.spec_note_override IS NOT NULL) AS overridden',
  '  FROM copy_fields cf',
  '  JOIN asset_types at ON at.id = cf.asset_type_id',
  ' WHERE at.is_active',
  '   AND cf.spec_verified_at IS NOT NULL',
  '   AND ($1::text IS NULL OR at.tenant_id = $1)',
  "   AND ($2::boolean OR cf.spec_type IN ('enforced', 'recommended'))",
  ' ORDER BY at.name, cf.field_name, at.tenant_id',
].join('\n');

// ─── SHAPING ────────────────────────────────────────────────────────────────

// The display name the product renders, with Meta's placement qualifier when the
// URL carries one — composed the same way destinations/googleDocs.js composes it,
// through the same two imported functions.
function sourceDisplay(specSource) {
  const name = specSourceName(specSource);
  if (!name) return '';
  const placement = specPlacementName(specSource);
  return placement ? name + ' (' + placement + ')' : name;
}

// A number is not a spec without its unit. 'words' comes from field_type; the
// column is null on most rows and characters is the library's default.
function limitText(row) {
  const unit = String(row.field_type || '').toLowerCase() === 'words' ? 'words' : 'chars';
  const min = Number(row.char_min) || 0;
  const max = Number(row.char_max) || 0;
  if (!max) return min ? min + '+ ' + unit : '';
  return min ? min + '-' + max + ' ' + unit : max + ' ' + unit;
}

function toRecord(row) {
  const platform = specSourceName(row.spec_source) || '';
  const tier = String(row.spec_type || '');
  // Gate the URL on the same test that gates the name, so an unrecognised source
  // (or the quillio_default sentinel) cannot reach the sheet through this column
  // after specSourceName has already refused to print it.
  const url = platform ? String(row.spec_source || '') : '';
  return {
    // The eight requested columns, in the requested order.
    asset_type: String(row.asset_type || ''),
    platform: platform,
    field_name: String(row.field_name || ''),
    enforced_value: tier === 'enforced' ? String(row.char_max) : '',
    recommended_value: tier === 'recommended' ? String(row.char_max) : '',
    spec_source: sourceDisplay(row.spec_source),
    last_verified_date: row.last_verified_date || '',
    spec_url: url,
    // Carried because the eight above are ambiguous without them — see header.
    spec_type: tier,
    char_min: String(Number(row.char_min) || 0),
    char_max: String(Number(row.char_max) || 0),
    field_type: String(row.field_type || 'characters'),
    limit: limitText(row),
  };
}

// Everything except the per-tenant facts. Two tenant rows agreeing on all of this
// are ONE spec; disagreeing on any of it keeps them apart. See header.
const COLLAPSE_KEYS = [
  'asset_type', 'platform', 'field_name', 'enforced_value', 'recommended_value',
  'spec_source', 'last_verified_date', 'spec_url', 'spec_type',
  'char_min', 'char_max', 'field_type', 'limit',
];

function collapse(records, rawRows) {
  const byKey = new Map();
  records.forEach(function (rec, i) {
    // Newline join: no asset or field name can contain one, so two different
    // key tuples cannot collide by running their values together.
    const key = COLLAPSE_KEYS.map(function (k) { return rec[k]; }).join('\n');
    let hit = byKey.get(key);
    if (!hit) {
      hit = Object.assign({}, rec, { tenants: 0, overridden_by_tenants: 0 });
      byKey.set(key, hit);
    }
    hit.tenants += 1;
    if (rawRows[i].overridden) hit.overridden_by_tenants += 1;
  });
  return Array.from(byKey.values()).map(function (r) {
    return Object.assign({}, r, {
      tenants: String(r.tenants),
      overridden_by_tenants: String(r.overridden_by_tenants),
    });
  });
}

// Requested order: platform, then asset_type, then field_name. An empty platform
// (an --all-tiers house default) sorts LAST rather than first — a run of blanks
// leading the sheet reads as missing data above the real rows.
function sortRows(rows) {
  const cmp = function (a, b) { return a.localeCompare(b, 'en'); };
  return rows.sort(function (a, b) {
    if (a.platform !== b.platform) {
      if (!a.platform) return 1;
      if (!b.platform) return -1;
      return cmp(a.platform, b.platform);
    }
    if (a.asset_type !== b.asset_type) return cmp(a.asset_type, b.asset_type);
    return cmp(a.field_name, b.field_name);
  });
}

// ─── SUMMARY ────────────────────────────────────────────────────────────────

// Two tenants holding different values for one (asset, field). Computed from the
// COLLAPSED rows, so it is exactly "this pair survived as more than one row".
function divergent(rows) {
  const seen = new Map();
  rows.forEach(function (r) {
    const k = r.asset_type + '\n' + r.field_name;
    seen.set(k, (seen.get(k) || 0) + 1);
  });
  return Array.from(seen.entries())
    .filter(function (e) { return e[1] > 1; })
    .map(function (e) { return e[0].split('\n'); });
}

// `rows` is what the sheet shows; `collapsed` is always the deduplicated set.
//
// DIVERGENCE AND OVERRIDES ARE COMPUTED FROM `collapsed`, NEVER FROM `rows`, and
// that is not a tidiness point — it was a bug. Under --per-tenant nothing
// collapses, so every two-tenant spec appears twice and a divergence test over
// the visible rows called EVERY one of them a disagreement. The summary would
// have reported the schema working correctly as a library-wide inconsistency.
// Both facts are properties of the spec set, so both read the spec set, and the
// two modes now report identical findings over identical data.
function summarize(rows, rawCount, collapsed) {
  const byPlatform = new Map();
  const byTier = new Map();
  const dates = [];
  rows.forEach(function (r) {
    const p = r.platform || '(no platform — house default)';
    byPlatform.set(p, (byPlatform.get(p) || 0) + 1);
    const t = r.spec_type || '(untiered)';
    byTier.set(t, (byTier.get(t) || 0) + 1);
    if (r.last_verified_date) dates.push(r.last_verified_date);
  });
  dates.sort();
  const rank = function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); };
  return {
    // What the sheet shows. Equal to distinct_specs unless --per-tenant.
    total_specs: rows.length,
    distinct_specs: collapsed.length,
    source_rows: rawCount,
    by_platform: Array.from(byPlatform.entries()).sort(rank),
    by_tier: Array.from(byTier.entries()).sort(rank),
    // ISO dates sort lexicographically, which is why to_char formats them in SQL.
    verified_from: dates[0] || null,
    verified_to: dates[dates.length - 1] || null,
    distinct_verification_dates: Array.from(new Set(dates)).sort(),
    overridden_specs: collapsed.filter(function (r) {
      return Number(r.overridden_by_tenants) > 0;
    }).length,
    divergent: divergent(collapsed),
  };
}

function summaryLines(s, prefix) {
  const p = prefix || '';
  const n = s.distinct_verification_dates.length;
  const L = [];
  L.push(p + 'total specs: ' + s.total_specs
    + (s.total_specs === s.distinct_specs ? '' : ' rows / ' + s.distinct_specs + ' distinct')
    + '   (from ' + s.source_rows + ' tenant rows)');
  L.push(p + 'by platform: ' + (s.by_platform.map(function (e) {
    return e[0] + '=' + e[1];
  }).join(', ') || '(none)'));
  L.push(p + 'by tier: ' + (s.by_tier.map(function (e) {
    return e[0] + '=' + e[1];
  }).join(', ') || '(none)'));
  L.push(p + 'last verified: ' + (s.verified_from || 'n/a') + ' .. ' + (s.verified_to || 'n/a')
    + '  (' + n + ' distinct date' + (n === 1 ? '' : 's')
    + (n ? ': ' + s.distinct_verification_dates.join(', ') : '') + ')');
  L.push(p + 'specs with a tenant override: ' + s.overridden_specs
    + " (base values shown; an override is the tenant's own number)");
  if (s.divergent.length) {
    L.push(p + 'DIVERGENT — tenants disagree on these ' + s.divergent.length + ':');
    s.divergent.forEach(function (d) { L.push(p + '  ' + d[0] + ' / ' + d[1]); });
  } else {
    L.push(p + 'divergent (tenants disagreeing on a value): none');
  }
  return L;
}

// ─── FORMATTING ─────────────────────────────────────────────────────────────

// RFC 4180. A spec_note never reaches this sheet, but an asset name with a comma
// does, and an unquoted one silently shifts every column to its right.
const CSV_NEEDS_QUOTE = new RegExp('["' + ',' + '\\r\\n]');

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return CSV_NEEDS_QUOTE.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows, summary) {
  const out = summaryLines(summary, '# ');
  if (!rows.length) return out.join('\n') + '\n';
  const cols = Object.keys(rows[0]);
  out.push('#');
  out.push(cols.join(','));
  rows.forEach(function (r) {
    out.push(cols.map(function (c) { return csvCell(r[c]); }).join(','));
  });
  return out.join('\n') + '\n';
}

// The CSV is a string rendering; the JSON is the typed one. A comparison against
// a platform page is arithmetic, and `"70"` vs `70` is the kind of thing that
// silently compares as unequal in whatever the sheet is pasted into.
//
// EMPTY BECOMES null, NOT 0. `enforced_value` is empty on a recommended row
// because that tier does not apply — a 0 there would read as "the platform
// publishes zero", which is a different and false claim.
const NUMERIC_COLS = [
  'enforced_value', 'recommended_value', 'char_min', 'char_max',
  'tenants', 'overridden_by_tenants',
];

function typedRow(row) {
  const out = {};
  Object.keys(row).forEach(function (k) {
    const v = row[k];
    if (NUMERIC_COLS.indexOf(k) >= 0) {
      out[k] = v === '' || v === null || v === undefined ? null : Number(v);
    } else {
      out[k] = v === '' ? null : v;
    }
  });
  return out;
}

// Ordered pairs are right for the CSV's summary lines and wrong for a JSON
// consumer, who wants to look a platform up by name. String keys that are not
// integer-like keep insertion order, so the rank order above survives.
function pairsToObject(pairs) {
  const o = {};
  pairs.forEach(function (e) { o[e[0]] = e[1]; });
  return o;
}

function toJson(rows, summary) {
  const s = Object.assign({}, summary, {
    by_platform: pairsToObject(summary.by_platform),
    by_tier: pairsToObject(summary.by_tier),
    divergent: summary.divergent.map(function (d) {
      return { asset_type: d[0], field_name: d[1] };
    }),
  });
  return JSON.stringify({ summary: s, specs: rows.map(typedRow) }, null, 2) + '\n';
}

// ─── RUN ────────────────────────────────────────────────────────────────────

// Takes a pool rather than making one, so --selftest drives this exact function.
async function buildExport(pool, opts) {
  const res = await pool.query(SPEC_SQL, [opts.tenant || null, !!opts.allTiers]);
  const rawRows = res.rows || [];
  const records = rawRows.map(toRecord);
  // Always computed, in both modes — the summary's divergence and override facts
  // are properties of the SPEC SET, not of whichever view is being printed.
  const collapsed = sortRows(collapse(records, rawRows));
  const rows = opts.perTenant
    ? sortRows(records.map(function (rec, i) {
      return Object.assign({}, rec, {
        tenant_id: String(rawRows[i].tenant_id || ''),
        overridden: rawRows[i].overridden ? 'yes' : '',
      });
    }))
    : collapsed;
  const summary = summarize(rows, rawRows.length, collapsed);
  const text = opts.format === 'json' ? toJson(rows, summary) : toCsv(rows, summary);
  return { rows: rows, summary: summary, text: text };
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  if (OPTS.format !== 'csv' && OPTS.format !== 'json') {
    console.error(TAG + " --format must be csv or json (got '" + OPTS.format + "')");
    process.exitCode = 1;
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(TAG + ' DATABASE_URL is not set. Run this in the Railway console as plain node.');
    console.error(TAG + ' Check the instrument without a database:');
    console.error(TAG + '   node scripts/exportActiveSpecs.js --selftest');
    process.exitCode = 1;
    return;
  }

  const Pool = require('pg').Pool;
  const pool = new Pool({ connectionString: connectionString, ssl: sslFor(connectionString) });
  try {
    const built = await buildExport(pool, OPTS);
    if (OPTS.out) {
      require('fs').writeFileSync(OPTS.out, built.text);
      console.log(summaryLines(built.summary, TAG + ' ').join('\n'));
      console.log(TAG + ' wrote ' + built.rows.length + ' rows to ' + OPTS.out);
    } else {
      process.stdout.write(built.text);
    }
    if (!built.rows.length) {
      console.error(TAG + ' no rows matched. Every spec needs an ACTIVE asset, a tier of');
      console.error(TAG + ' enforced/recommended, and a non-null spec_verified_at.');
      console.error(TAG + ' Try --all-tiers, or check migrateBackfillSpecVerifiedAt.js has run.');
    }
  } finally {
    await pool.end();
  }
}

// ─── SELFTEST ───────────────────────────────────────────────────────────────
// Drives buildExport — the function main calls — against a stub pool. CLAUDE.md,
// "check the measurement calls the entry point production calls": a harness that
// exercises its own copy of the logic verifies nothing about the shipped path.
//
// No key, no network, no database.

// Parse one CSV line the way a spreadsheet would, so the escaping test measures
// what a consumer sees rather than re-asserting the writer's own rules.
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') { quoted = false; } else { cur += ch; }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

async function selftest() {
  const assert = require('assert');

  const LI_URL = 'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs';
  const META_URL = 'https://www.facebook.com/business/ads-guide/update/image/facebook-feed';
  const G_URL = 'https://support.google.com/google-ads/answer/17090561';
  const X_URL = 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications';

  // Two tenants agreeing (collapses to one spec), a comma in an asset name, a
  // words field, an override, a divergent pair, and a house_default that only
  // --all-tiers should reach.
  const FIXTURE = [
    { tenant_id: 'T1', asset_type: 'LinkedIn Single Image Ad', field_name: 'Headline', spec_type: 'enforced', char_min: 0, char_max: 70, field_type: 'characters', spec_source: LI_URL, last_verified_date: '2026-08-20', overridden: false },
    { tenant_id: 'T2', asset_type: 'LinkedIn Single Image Ad', field_name: 'Headline', spec_type: 'enforced', char_min: 0, char_max: 70, field_type: 'characters', spec_source: LI_URL, last_verified_date: '2026-08-20', overridden: true },
    { tenant_id: 'T1', asset_type: 'Meta Single Image Ad', field_name: 'Primary Text', spec_type: 'recommended', char_min: 50, char_max: 150, field_type: 'characters', spec_source: META_URL, last_verified_date: '2026-08-20', overridden: false },
    { tenant_id: 'T1', asset_type: 'Direct Mail, 6x9', field_name: 'Body Copy', spec_type: 'recommended', char_min: 0, char_max: 90, field_type: 'words', spec_source: G_URL, last_verified_date: '2026-07-23', overridden: false },
    { tenant_id: 'T1', asset_type: 'X Post Ad', field_name: 'Post Copy', spec_type: 'enforced', char_min: 0, char_max: 280, field_type: 'characters', spec_source: X_URL, last_verified_date: '2026-08-20', overridden: false },
    { tenant_id: 'T2', asset_type: 'X Post Ad', field_name: 'Post Copy', spec_type: 'enforced', char_min: 0, char_max: 257, field_type: 'characters', spec_source: X_URL, last_verified_date: '2026-08-20', overridden: false },
  ];
  const HOUSE = { tenant_id: 'T1', asset_type: 'Nurture Email', field_name: 'Subject Line 1', spec_type: 'house_default', char_min: 0, char_max: 40, field_type: 'characters', spec_source: 'quillio_default', last_verified_date: '2026-08-20', overridden: false };

  const calls = [];
  const stub = function (rows) {
    return {
      query: async function (sql, params) {
        calls.push({ sql: sql, params: params });
        // The stub honours the tier parameter the way the real WHERE clause
        // does, so --all-tiers is exercised rather than assumed.
        const all = params[1];
        return {
          rows: rows.filter(function (r) {
            return all || r.spec_type === 'enforced' || r.spec_type === 'recommended';
          }),
        };
      },
      end: async function () {},
    };
  };

  // 1. READ-ONLY BY CONSTRUCTION — asserted, not claimed in a comment.
  //
  // THE REGION IS AS MUCH PART OF THE CLAIM AS THE PATTERNS ARE (CLAUDE.md, "AN
  // ASSERTION THAT QUIETLY RELOCATES"). Both anchors are asserted rather than
  // assumed: a missing one would make `slice` read -1 as "one char from the end"
  // and the scan would pass against almost nothing.
  //
  // The END anchor is not decoration. The first version of this check scanned to
  // end-of-file and failed on ITS OWN pattern list — the literal /BEGIN/ below is
  // in the source too. Scanning the production half only is what makes the answer
  // about the queries rather than about the scanner.
  const src = require('fs').readFileSync(__filename, 'utf8');
  const START = 'const SPEC_SQL';
  const END = 'async function selftest(';
  const from = src.indexOf(START);
  const to = src.indexOf(END);
  assert.ok(from > 0, 'read-only scan: start anchor "' + START + '" not found');
  assert.ok(to > 0, 'read-only scan: end anchor "' + END + '" not found');
  assert.ok(to > from, 'read-only scan: end anchor precedes start anchor');
  const body = src.slice(from, to);
  assert.ok(body.length > 2000, 'read-only scan: the region is the production half, not a sliver');
  assert.ok(body.indexOf('buildExport') > 0, 'read-only scan: the region contains the query path');
  [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+[a-z_]+\s+SET\b/i, /\bDELETE\s+FROM\b/i,
    /\bDROP\s+TABLE\b/i, /\bALTER\s+TABLE\b/i, /\bCREATE\s+TABLE\b/i,
    /\bBEGIN\b/i, /\bCOMMIT\b/i].forEach(function (re) {
    assert.ok(!re.test(body), 'read-only: ' + re + ' must not appear');
  });

  // 2. Default run: collapse, order, derive.
  const a = await buildExport(stub(FIXTURE), { format: 'csv' });
  assert.strictEqual(calls.length, 1, 'one query');
  assert.deepStrictEqual(calls[0].params, [null, false], 'nullable tenant, tiered-only');
  assert.strictEqual(a.rows.length, 5,
    'the two agreeing LinkedIn rows collapse to one; the divergent X pair does not');
  assert.strictEqual(a.summary.source_rows, 6, 'source count is the pre-collapse total');

  // Requested ordering: platform, asset_type, field_name.
  assert.deepStrictEqual(a.rows.map(function (r) { return r.platform; }),
    ['Google', 'LinkedIn', 'Meta', 'X', 'X']);

  const li = a.rows.find(function (r) { return r.platform === 'LinkedIn'; });
  assert.strictEqual(li.tenants, '2', 'both tenants back it');
  assert.strictEqual(li.overridden_by_tenants, '1', 'one has pinned its own number');
  assert.strictEqual(li.enforced_value, '70');
  assert.strictEqual(li.recommended_value, '', 'exactly one tier column is populated');
  assert.strictEqual(li.limit, '70 chars');
  assert.strictEqual(li.spec_url, LI_URL, 'the stored column rides along beside the name');

  const meta = a.rows.find(function (r) { return r.platform === 'Meta'; });
  assert.strictEqual(meta.spec_source, 'Meta (Facebook Feed)',
    'the placement qualifier is composed from the URL');
  assert.strictEqual(meta.recommended_value, '150');
  assert.strictEqual(meta.enforced_value, '');
  assert.strictEqual(meta.limit, '50-150 chars', 'a band keeps its floor');

  const words = a.rows.find(function (r) { return r.field_type === 'words'; });
  assert.strictEqual(words.limit, '90 words', 'the unit is not assumed to be characters');

  // 3. Divergence is a finding, not an average.
  assert.deepStrictEqual(a.summary.divergent, [['X Post Ad', 'Post Copy']]);
  assert.strictEqual(a.summary.verified_from, '2026-07-23');
  assert.strictEqual(a.summary.verified_to, '2026-08-20');
  assert.deepStrictEqual(a.summary.by_platform,
    [['X', 2], ['Google', 1], ['LinkedIn', 1], ['Meta', 1]]);
  assert.deepStrictEqual(a.summary.by_tier, [['enforced', 3], ['recommended', 2]]);
  assert.deepStrictEqual(a.summary.distinct_verification_dates, ['2026-07-23', '2026-08-20']);

  // 4. The eight requested columns are present, first, and in the requested order.
  const lines = a.text.split('\n');
  const header = lines.find(function (l) { return l.indexOf('asset_type,') === 0; });
  const cols = parseCsvLine(header);
  assert.deepStrictEqual(cols.slice(0, 8), [
    'asset_type', 'platform', 'field_name', 'enforced_value',
    'recommended_value', 'spec_source', 'last_verified_date', 'spec_url',
  ]);

  // 5. CSV escaping — an asset name with a comma must not shift the columns.
  const dmLine = lines.find(function (l) { return l.indexOf('Direct Mail') >= 0; });
  const dmCells = parseCsvLine(dmLine);
  assert.strictEqual(dmCells.length, cols.length, 'the quoted comma did not add a column');
  assert.strictEqual(dmCells[0], 'Direct Mail, 6x9', 'the name round-trips intact');
  assert.strictEqual(dmCells[1], 'Google', 'the column to its right is still the platform');

  // 6. --all-tiers reaches the house default, and it renders no platform, no URL
  //    and no source name — the sentinel is never printed.
  const b = await buildExport(stub(FIXTURE.concat([HOUSE])), { format: 'csv', allTiers: true });
  const hd = b.rows.find(function (r) { return r.field_name === 'Subject Line 1'; });
  assert.ok(hd, 'the house default is included');
  assert.strictEqual(hd.platform, '');
  assert.strictEqual(hd.spec_url, '', 'quillio_default is never emitted as a URL');
  assert.strictEqual(hd.spec_source, '');
  assert.strictEqual(b.rows[b.rows.length - 1].field_name, 'Subject Line 1',
    'no-platform rows sort last');
  assert.ok(b.text.indexOf('quillio_default') === -1,
    'the sentinel appears nowhere in the output');

  // 7. --per-tenant keeps every row and names the tenant.
  const c = await buildExport(stub(FIXTURE), { format: 'json', perTenant: true });
  assert.strictEqual(c.rows.length, 6, 'nothing collapses');
  assert.ok(c.rows.every(function (r) { return r.tenant_id; }), 'every row names its tenant');
  const parsed = JSON.parse(c.text);
  assert.strictEqual(parsed.specs.length, 6);
  assert.strictEqual(parsed.summary.total_specs, 6);

  // 7b. DIVERGENCE IS A PROPERTY OF THE SPEC SET, NOT OF THE PRINTED VIEW.
  //     Under --per-tenant every two-tenant spec appears twice, so a divergence
  //     test over the visible rows would call the LinkedIn pair a disagreement —
  //     it did, before summarize took the collapsed set. Both modes must report
  //     the SAME single finding.
  assert.strictEqual(parsed.summary.distinct_specs, 5, 'the spec set is still 5');
  assert.deepStrictEqual(parsed.summary.divergent,
    [{ asset_type: 'X Post Ad', field_name: 'Post Copy' }],
    'the agreeing LinkedIn pair is NOT divergent under --per-tenant');
  assert.deepStrictEqual(parsed.summary.divergent.map(function (d) { return d.asset_type; }),
    a.summary.divergent.map(function (d) { return d[0]; }),
    'both modes agree on what is divergent');
  assert.strictEqual(parsed.summary.overridden_specs, a.summary.overridden_specs,
    'both modes agree on the override count');

  // 7c. JSON is TYPED — numbers compare as numbers, an inapplicable tier is null
  //     rather than 0, and by_platform is keyed for lookup, still rank-ordered.
  const jli = parsed.specs.find(function (r) { return r.platform === 'LinkedIn'; });
  assert.strictEqual(jli.enforced_value, 70, 'a number, not "70"');
  assert.strictEqual(jli.recommended_value, null, 'the inapplicable tier is null, never 0');
  assert.strictEqual(jli.char_min, 0, 'a real zero floor stays 0, not null');
  assert.deepStrictEqual(parsed.summary.by_platform, { X: 2, LinkedIn: 2, Google: 1, Meta: 1 },
    'per-tenant tallies count rows, which is what that view is for');
  assert.deepStrictEqual(Object.keys(parsed.summary.by_platform),
    ['LinkedIn', 'X', 'Google', 'Meta'], 'rank order survives the object conversion');

  // 8. An empty result still prints a summary rather than a bare header.
  const d = await buildExport(stub([]), { format: 'csv' });
  assert.strictEqual(d.rows.length, 0);
  assert.ok(d.text.indexOf('total specs: 0') >= 0, 'the summary survives an empty result');

  // 9. The tenant filter reaches the query as a parameter.
  await buildExport(stub(FIXTURE), { format: 'csv', tenant: 'T0B8LPRDKHR' });
  assert.deepStrictEqual(calls[calls.length - 1].params, ['T0B8LPRDKHR', false]);

  console.log(TAG + ' selftest OK');
  console.log(TAG + '   - read-only: no INSERT/UPDATE/DELETE/DDL/BEGIN in the body');
  console.log(TAG + '   - collapse keeps agreeing tenants as one spec, splits disagreeing ones');
  console.log(TAG + '   - platform/source/placement derived through src/utils/specSource');
  console.log(TAG + '   - the quillio_default sentinel never reaches the output');
  console.log(TAG + '   - CSV quoting holds a comma inside an asset name');
  console.log('');
  console.log('Sample output below is FIXTURE DATA, not the database:');
  console.log('');
  console.log(a.text);
}

if (require.main === module) {
  main().catch(function (err) {
    console.error(TAG + ' ' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}

module.exports = {
  buildExport: buildExport,
  toRecord: toRecord,
  toCsv: toCsv,
  toJson: toJson,
  csvCell: csvCell,
  limitText: limitText,
  sourceDisplay: sourceDisplay,
  summarize: summarize,
  sortRows: sortRows,
  collapse: collapse,
  parseCsvLine: parseCsvLine,
  typedRow: typedRow,
  SPEC_SQL: SPEC_SQL,
};
