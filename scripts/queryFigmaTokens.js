'use strict';

// Read-only diagnostic: confirm a tenant's Figma OAuth tokens landed (Phase 4,
// Stage 1.3). Prints whether a service='figma' row exists in tenant_tokens, if
// figma_access_token / figma_refresh_token are present (masked — never printed
// in full), and the figma_token_expires_at timestamp (with whether it's still
// in the future). Saves pasting SQL into a console.
//
// Usage:  railway run node scripts/queryFigmaTokens.js [tenantId]
//   tenantId defaults to the demo tenant T0B8LPRDKHR.
// Requires DATABASE_URL. Reads only — never writes, never prints a full token.

const TENANT = process.argv[2] || 'T0B8LPRDKHR';

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Show only the length + first 4 chars of a secret, never the whole thing.
function mask(v) {
  if (!v) return '(null)';
  const s = String(v);
  return `set (${s.length} chars, starts "${s.slice(0, 4)}…")`;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[query] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[query] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT figma_access_token, figma_refresh_token, figma_token_expires_at, updated_at
         FROM tenant_tokens
        WHERE tenant_id = $1 AND service = 'figma'
        LIMIT 1`,
      [TENANT]
    );

    console.log(`\nFigma tokens for tenant ${TENANT} (tenant_tokens, service='figma')\n`);
    if (res.rows.length === 0) {
      console.log("  ✗ No service='figma' row — the OAuth callback has not stored tokens yet.");
      console.log('    (Connect via /auth/figma, and make sure migrateAddFigmaSchema.js has run.)\n');
      process.exit(0);
    }

    const r = res.rows[0];
    const exp = r.figma_token_expires_at ? new Date(r.figma_token_expires_at) : null;
    const future = exp ? exp.getTime() > Date.now() : null;
    const hoursOut = exp ? Math.round((exp.getTime() - Date.now()) / 3600000) : null;

    console.log('  ✓ row exists');
    console.log('  figma_access_token  :', mask(r.figma_access_token));
    console.log('  figma_refresh_token :', mask(r.figma_refresh_token));
    console.log(
      '  figma_token_expires_at:',
      exp ? `${exp.toISOString()} (${future ? 'in the future' : 'EXPIRED'}, ~${hoursOut}h from now)` : '(null)'
    );
    console.log('  updated_at          :', r.updated_at ? new Date(r.updated_at).toISOString() : '(null)');

    // Overall verdict matching the acceptance check.
    const ok = !!r.figma_access_token && !!exp;
    console.log(
      `\n  ${ok ? '✓ PASS' : '✗ FAIL'} — non-null figma_access_token and a real figma_token_expires_at timestamp: ${ok}\n`
    );
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('[query] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
