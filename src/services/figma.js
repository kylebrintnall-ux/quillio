'use strict';

// Figma OAuth token lifecycle (Phase 4, Stage 1.4). ensureFigmaAccessToken()
// returns a currently-valid access token for a tenant, transparently refreshing
// via the stored refresh token when the current one is expired or within a
// safety buffer of expiry. Utility only — not wired into any endpoint yet; later
// stages call it immediately before each Figma REST request.
//
// Figma access tokens are long-lived (~90 days in practice), so the refresh path
// rarely fires — but it exists so the integration doesn't silently break when a
// token eventually ages out.

const config = require('../config');
const { getFigmaTokens, saveFigmaTokens } = require('../db');

// Refresh a bit early so an in-flight request never races the expiry boundary.
const REFRESH_BUFFER_MS = 60 * 60 * 1000; // 1 hour

// Figma's current OAuth (granular-scope system) refreshes at the SAME token
// endpoint as the code exchange, using grant_type=refresh_token and HTTP Basic
// auth. (The legacy /v1/oauth/refresh endpoint belongs to the pre-granular flow.)
const TOKEN_URL = 'https://api.figma.com/v1/oauth/token';

// Return a valid Figma access token for the tenant, refreshing if needed.
// Returns null when the tenant has never connected Figma, or when a refresh is
// required but can't be performed (no refresh token / creds, or Figma rejects
// it). Best-effort: any error degrades to null rather than throwing, so callers
// treat a null as "Figma unavailable" and proceed (the codebase's graceful
// pattern). Never logs tokens.
async function ensureFigmaAccessToken(tenantId) {
  try {
    const tokens = await getFigmaTokens(tenantId);
    if (!tokens || !tokens.accessToken) return null; // not connected

    // Still valid beyond the buffer → use as-is (the common case for ~90-day
    // tokens). An unknown/null expiry is treated as stale and forces a refresh.
    const expMs = tokens.expiresAt ? tokens.expiresAt.getTime() : 0;
    if (expMs && expMs - Date.now() > REFRESH_BUFFER_MS) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      console.warn('[figma] token expired/near-expiry but no refresh_token stored — cannot refresh');
      return null;
    }
    if (!config.FIGMA_CLIENT_ID || !config.FIGMA_CLIENT_SECRET) {
      console.error('[figma] FIGMA_CLIENT_ID / FIGMA_CLIENT_SECRET not configured — cannot refresh');
      return null;
    }

    const refreshed = await refreshFigmaToken(tenantId, tokens.refreshToken);
    return refreshed ? refreshed.accessToken : null;
  } catch (err) {
    console.error('[figma] ensureFigmaAccessToken failed:', err && err.message ? err.message : err);
    return null;
  }
}

// Exchange a refresh token for a fresh access token, persist it (recomputing the
// absolute expiry from expires_in SECONDS, the same conversion as the 1.3
// callback), and store a rotated refresh token if Figma returns one (else keep
// the existing one). Returns { accessToken } on success, null on failure.
// Never logs tokens.
async function refreshFigmaToken(tenantId, refreshToken) {
  const basicAuth = Buffer.from(
    `${config.FIGMA_CLIENT_ID}:${config.FIGMA_CLIENT_SECRET}`
  ).toString('base64');

  let resp, data;
  try {
    resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    data = await resp.json().catch(() => null);
  } catch (err) {
    console.error('[figma] token refresh request failed:', err && err.message ? err.message : err);
    return null;
  }

  const accessToken = data && data.access_token;
  if (!resp.ok || !accessToken) {
    // Log the error code/status only — never the token payload.
    console.error('[figma] token refresh failed:', (data && (data.error || data.message)) || resp.status);
    return null;
  }

  const expiresIn = data && data.expires_in; // SECONDS
  const expiresAt = Number(expiresIn) > 0 ? new Date(Date.now() + Number(expiresIn) * 1000) : null;
  // Figma may rotate the refresh token; keep the existing one if it doesn't.
  const newRefreshToken = (data && data.refresh_token) || refreshToken;

  await saveFigmaTokens(tenantId, { accessToken, refreshToken: newRefreshToken, expiresAt });
  console.log('[figma] access token refreshed for tenant', tenantId);
  return { accessToken };
}

module.exports = { ensureFigmaAccessToken, refreshFigmaToken };
