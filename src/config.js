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

  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,

  SHEET_ID: process.env.SHEET_ID || '1skbkkKlHMDUzeG8_bFpcSjrvweumivePuSOvr5qIfqk',
  DRIVE_FOLDER_ID: process.env.DRIVE_FOLDER_ID || '1gdf5-R3J8IGY1I5pJJj2O-KFOju0UsqU',

  // Slack incoming webhook the Block Kit result is posted to. This is a secret,
  // so it is NOT hardcoded — set it via the SLACK_WEBHOOK_URL env var.
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,

  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,

  ALLOWED_ASSETS,
};
