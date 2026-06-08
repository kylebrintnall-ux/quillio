'use strict';

// Central configuration. Everything is overridable via env vars, but the
// IDs/URLs that are specific to this deployment ship with defaults so the app
// runs with only the three required secrets set.

const ALLOWED_ASSETS = [
  'Display Banner',
  'Organic Social',
  'Dynamic Email',
  'Sales Basho',
  'Form Confirm Page',
  'Paid Social - LinkedIn',
  'Paid Social - Meta',
  'Paid Social - Twitter/X',
];

module.exports = {
  PORT: process.env.PORT || 3000,

  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Service account: used for reading the specs Sheet, and for Drive/Docs
  // writes when OAuth2 is NOT configured (the Google Workspace / Shared Drive
  // path).
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,

  // OAuth2 (optional): when GOOGLE_REFRESH_TOKEN is set, Drive/Docs WRITES run
  // as this OAuth2 user instead of the service account. This is the personal
  // Gmail path — files are owned by a real account with real storage quota,
  // sidestepping the service account's zero-quota limitation. Sheet reads
  // always stay on the service account.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,

  SHEET_ID: process.env.SHEET_ID || '1skbkkKlHMDUzeG8_bFpcSjrvweumivePuSOvr5qIfqk',

  // Target folder for created docs. With OAuth2 this is a normal My Drive
  // folder owned by the OAuth user. With the service account (no OAuth2), this
  // should be a Shared Drive folder (service accounts have no personal quota).
  DRIVE_FOLDER_ID: process.env.DRIVE_FOLDER_ID || '1gdf5-R3J8IGY1I5pJJj2O-KFOju0UsqU',

  // Output destination adapter (src/destinations/). Google Docs today; Notion,
  // OneDrive, etc. can be added and selected here later.
  DESTINATION: process.env.DESTINATION || 'google-docs',

  // Slack incoming webhook the Block Kit result is posted to. This is a secret,
  // so it is NOT hardcoded — set it via the SLACK_WEBHOOK_URL env var.
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,

  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,

  ALLOWED_ASSETS,
};
