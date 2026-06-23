'use strict';

const { google } = require('googleapis');
const config = require('./config');

// Global per-request timeout for ALL Drive/Docs/Sheets calls. Without this the
// googleapis (gaxios) client waits indefinitely, so a stalled Docs/Drive call
// would hang the fire-and-forget workflow forever — leaving Slack stuck on
// "building your doc…" / "Generating…" with no error. Overridable via
// GOOGLE_TIMEOUT_MS.
google.options({ timeout: Number(process.env.GOOGLE_TIMEOUT_MS) || 30000 });

// Service-account scopes. Includes Drive/Docs so the service account can still
// do writes on the no-OAuth (Shared Drive) path; Sheets is read-only.
const SA_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

let cached = null;

function loadServiceAccountCredentials() {
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  }
  try {
    return JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message);
  }
}

// OAuth2 client for Drive/Docs writes. Used only when GOOGLE_REFRESH_TOKEN is
// set. The refresh token is exchanged for access tokens automatically.
function buildOAuthClient() {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_REFRESH_TOKEN is set but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing.'
    );
  }
  const client = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
  return client;
}

// Returns memoized Google API clients:
//   - sheets: ALWAYS the service account (reads the specs Sheet).
//   - drive / docs: OAuth2 user when GOOGLE_REFRESH_TOKEN is set (personal
//     Gmail path), otherwise the service account (Workspace / Shared Drive).
async function getClients() {
  if (cached) return cached;

  const credentials = loadServiceAccountCredentials();
  const saAuth = new google.auth.GoogleAuth({ credentials, scopes: SA_SCOPES });
  const saClient = await saAuth.getClient();

  const usingOAuth = !!config.GOOGLE_REFRESH_TOKEN;
  const writeAuth = usingOAuth ? buildOAuthClient() : saClient;

  cached = {
    drive: google.drive({ version: 'v3', auth: writeAuth }),
    docs: google.docs({ version: 'v1', auth: writeAuth }),
    sheets: google.sheets({ version: 'v4', auth: saClient }),
    serviceAccountEmail: credentials.client_email,
    usingOAuth,
  };
  return cached;
}

// Per-tenant clients (Phase 3 — per-user Google OAuth). When the tenant has a
// stored Google refresh token (tenant_tokens service='google'), Drive/Docs run
// as that user via OAuth2; Sheets stays on the service account. Falls back to
// the shared env-based getClients() when there's no tenant id, no DB, no stored
// token, or no OAuth client creds — so the env GOOGLE_REFRESH_TOKEN demo path is
// untouched. Built fresh per call (once per web request); never logs the token.
async function getClientsForTenant(tenantId) {
  if (!tenantId) return getClients();
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return getClients();

  let refreshToken = null;
  try {
    // Lazy-require to avoid a load-time dependency on the DB layer (and pg).
    const { getTenantToken } = require('./db');
    refreshToken = await getTenantToken(tenantId, 'google');
  } catch (err) {
    console.warn('[google] tenant token lookup failed — falling back to env auth:', err.message);
  }
  if (!refreshToken) return getClients();

  // Reuse the env path's service-account Sheets client + SA email; only the
  // Drive/Docs write client is swapped to the tenant's OAuth user.
  const base = await getClients();
  const userAuth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
  userAuth.setCredentials({ refresh_token: refreshToken });

  return {
    drive: google.drive({ version: 'v3', auth: userAuth }),
    docs: google.docs({ version: 'v1', auth: userAuth }),
    sheets: base.sheets,
    serviceAccountEmail: base.serviceAccountEmail,
    usingOAuth: true,
  };
}

module.exports = { getClients, getClientsForTenant };
