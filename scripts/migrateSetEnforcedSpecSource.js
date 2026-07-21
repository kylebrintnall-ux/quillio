'use strict';

// Re-anchoring migration (data only). Sets a real per-field spec_source URL on
// the 25 'enforced' fields so the copy-doc tier line renders the platform name
// (e.g. "Platform limit (LinkedIn)."). The renderer already substring-matches
// spec_source to a display name (specSourceName in destinations/googleDocs.js) —
// no code/render change here.
//
// Targets EXACTLY the 25 enforced (asset, field) pairs — the union of the two
// prior spec_type migrations (migrateAddCopyFieldSpecType.ENFORCED, 23, plus
// migrateAddCopyFieldSpecTypeFixes.PROMOTE, 2) — matched per-asset-pair. Never a
// global field_name match, and never touches house_default fields.
//
// Idempotent + non-clobbering: guarded by spec_type='enforced' AND
// spec_source='quillio_default', so a re-run (sources now set) changes nothing
// and it never overwrites a source set elsewhere.
//
// Run on Railway with: railway run node scripts/migrateSetEnforcedSpecSource.js
//
// SEQUENCING: run BEFORE deploying the seed change (defaultAssets.js now seeds
// these same URLs) — same ordering as the prior spec_type work.

const { ENFORCED } = require('./migrateAddCopyFieldSpecType');
const { PROMOTE } = require('./migrateAddCopyFieldSpecTypeFixes');

// Full source URLs per platform. Each contains its specSourceName trigger token
// (facebook / linkedin / x.com / google). Kept BYTE-IDENTICAL to
// ENFORCED_SOURCE_URLS in src/data/defaultAssets.js (the smoke test asserts it).
const PLATFORM_URLS = {
  Meta: 'https://www.facebook.com/business/ads-guide/update',
  LinkedIn: 'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs',
  X: 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications',
  Google: 'https://support.google.com/google-ads/answer/7684791',
};

// The enforced assets belong to exactly these four platforms.
function platformForAsset(assetName) {
  if (assetName.startsWith('Meta ')) return 'Meta';
  if (assetName.startsWith('LinkedIn ')) return 'LinkedIn';
  if (assetName === 'Twitter/X Ad') return 'X';
  if (assetName.startsWith('Google DV360')) return 'Google';
  return null;
}

// Group the 25 enforced pairs by platform.
const PAIRS_BY_PLATFORM = { Meta: [], LinkedIn: [], X: [], Google: [] };
for (const [asset, field] of [...ENFORCED, ...PROMOTE]) {
  const p = platformForAsset(asset);
  if (p) PAIRS_BY_PLATFORM[p].push([asset, field]);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-specsource] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-specsource] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    let total = 0;
    for (const platform of ['Meta', 'LinkedIn', 'X', 'Google']) {
      const pairs = PAIRS_BY_PLATFORM[platform];
      const url = PLATFORM_URLS[platform];
      const tuples = pairs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
      const res = await client.query(
        `UPDATE copy_fields cf
            SET spec_source = $${pairs.length * 2 + 1}
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND cf.spec_type = 'enforced'
            AND cf.spec_source = 'quillio_default'
            AND (at.name, cf.field_name) IN (${tuples})`,
        [...pairs.flat(), url]
      );
      total += res.rowCount;
      console.log(`[migrate-specsource] ${platform}: set spec_source on ${res.rowCount} row(s)`);
    }
    console.log(
      `[migrate-specsource] total ${total} row(s) (expected 50: Meta 20, LinkedIn 18, X 4, Google 8)`
    );

    console.log('[migrate-specsource] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-specsource] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

// Run only when invoked directly. Requiring this module (e.g. the smoke test's
// byte-identity check of PLATFORM_URLS) must NOT connect to a database.
if (require.main === module) {
  main();
}

module.exports = { PLATFORM_URLS };
