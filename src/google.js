'use strict';

const { google } = require('googleapis');
const config = require('./config');

// Global per-request timeout for ALL Drive/Docs calls. Without this the
// googleapis (gaxios) client waits indefinitely, so a stalled Docs/Drive call
// would hang the fire-and-forget workflow forever — leaving Slack stuck on
// "building your doc…" / "Generating…" with no error. Overridable via
// GOOGLE_TIMEOUT_MS.
google.options({ timeout: Number(process.env.GOOGLE_TIMEOUT_MS) || 30000 });

// Service-account scopes. Drive/Docs so the service account can do writes on the
// no-OAuth (Shared Drive) path. (Sheets was dropped when the Google Sheet asset
// library was retired — asset specs now come from Postgres.)
const SA_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
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
    serviceAccountEmail: credentials.client_email,
    usingOAuth,
  };
  return cached;
}

// Accept either a bare tenant id (the original signature) or
// { tenantId, userId }. Keeping one polymorphic argument means every existing
// call site stays valid while user-aware callers can name the acting person.
function normalizeIdentity(arg) {
  if (arg && typeof arg === 'object') {
    return { tenantId: arg.tenantId || null, userId: arg.userId || null };
  }
  return { tenantId: arg || null, userId: null };
}

// Pick the Google refresh token a Drive/Docs write should run as, in priority
// order:
//   1. the ACTING USER's own token (user_tokens) — the person who ran the
//      command or holds the session;
//   2. the tenant-level token (tenant_tokens) — DEPRECATED, and only still read
//      so credentials that predate the per-user split keep working until
//      scripts/migrateBackfillUserCredentials.js has run;
//   3. none → the caller falls back to the shared env clients.
// Returns { token, source } where source is 'user' | 'tenant' | 'env'. Exported
// for tests; never logs the token itself.
async function resolveGoogleRefreshToken(identity) {
  const { tenantId, userId } = normalizeIdentity(identity);

  if (userId) {
    try {
      // Lazy-require to avoid a load-time dependency on the DB layer (and pg).
      const { getUserToken } = require('./db/users');
      const token = await getUserToken(userId, 'google');
      if (token) return { token, source: 'user' };
    } catch (err) {
      console.warn('[google] user token lookup failed — trying the tenant token:', err.message);
    }
  }

  if (tenantId) {
    try {
      const { getTenantToken } = require('./db');
      const token = await getTenantToken(tenantId, 'google');
      if (token) return { token, source: 'tenant' };
    } catch (err) {
      console.warn('[google] tenant token lookup failed — falling back to env auth:', err.message);
    }
  }

  return { token: null, source: 'env' };
}

// Clients for a specific writer (Phase 3 per-user Google OAuth, now keyed on the
// acting USER rather than the tenant). Pass { tenantId, userId } — or a bare
// tenant id for the legacy behavior. When a refresh token is found, Drive/Docs
// run as that Google user via OAuth2; otherwise this falls back to the shared
// env-based getClients(), so the GOOGLE_REFRESH_TOKEN demo path is untouched.
// Built fresh per call (once per request); never logs the token.
async function getClientsForTenant(identity) {
  const { tenantId, userId } = normalizeIdentity(identity);
  if (!tenantId && !userId) return getClients();
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return getClients();

  const { token: refreshToken, source } = await resolveGoogleRefreshToken({ tenantId, userId });
  if (!refreshToken) return getClients();

  // Log WHICH identity is writing (never the token) — with two people on a
  // tenant, "whose Drive did this land in" is the first question asked.
  console.log(
    `[google] Drive/Docs writing as the ${source} Google identity` +
      (source === 'user' ? ` (user ${userId})` : '')
  );

  // Reuse the env path's SA email; only the Drive/Docs write client is swapped
  // to the resolved OAuth user.
  const base = await getClients();
  const userAuth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
  userAuth.setCredentials({ refresh_token: refreshToken });

  return {
    drive: google.drive({ version: 'v3', auth: userAuth }),
    docs: google.docs({ version: 'v1', auth: userAuth }),
    serviceAccountEmail: base.serviceAccountEmail,
    usingOAuth: true,
  };
}

module.exports = { getClients, getClientsForTenant, resolveGoogleRefreshToken };
