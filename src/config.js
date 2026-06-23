'use strict';

// Central configuration. Everything is overridable via env vars, but the
// IDs/URLs that are specific to this deployment ship with defaults so the app
// runs with only the three required secrets set.

const ALLOWED_ASSETS = [
  'LinkedIn Single Image Ad',
  'LinkedIn Carousel Ad',
  'LinkedIn Single Image Ad — Variant A',
  'LinkedIn Single Image Ad — Variant B',
  'LinkedIn Single Image Ad — Variant C',
  'LinkedIn Single Image Ad — Variant D',
  'Meta Single Image Ad',
  'Meta Carousel Ad',
  'Twitter/X Ad',
  'Display Banner — Standard',
  'Google DV360 / Responsive Display',
  'Demand Gen Nurture Email',
  'Event Invitation Email',
  'Event Reminder Email',
  'Event Follow-Up / Recap Email',
  'Sales Basho Email',
  'Event Landing Page',
  'On-Site Signage — General',
  'On-Site Signage — Session Title Card',
  'On-Site Signage — Directional',
  'Campaign Landing Page',
  'Form Confirm Page',
  'Organic Social — LinkedIn',
  'Organic Social — Instagram',
  'Organic Social — Twitter/X',
  'Direct Mail — Box / Mailer',
  'Direct Mail — Note Card / Rep Letter',
  'Direct Mail — Insert',
  'One-Pager',
  'Battle Card',
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

  // Per-user Google OAuth (Phase 3): redirect URI registered for the
  // /oauth/google flow that stores a refresh token per tenant in Postgres.
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,

  SHEET_ID: process.env.ASSET_SHEET_ID || '1NVDCcjPO2ZG1Vmt40WTwTYmXTl27dBiwrinHHKK9tCU',

  // Target folder for created docs. With OAuth2 this is a normal My Drive
  // folder owned by the OAuth user. With the service account (no OAuth2), this
  // should be a Shared Drive folder (service accounts have no personal quota).
  DRIVE_FOLDER_ID: process.env.DRIVE_FOLDER_ID || '1u12O9tkm0lZI8BAIfWErXAo88NWIOM0U',

  // Output destination adapter (src/destinations/). Google Docs today; Notion,
  // OneDrive, etc. can be added and selected here later.
  DESTINATION: process.env.DESTINATION || 'google-docs',

  // Slack incoming webhook the Block Kit result is posted to. This is a secret,
  // so it is NOT hardcoded — set it via the SLACK_WEBHOOK_URL env var.
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,

  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,

  // Bot token (xoxb-…) for Slack Web API calls (chat.postMessage). Used for the
  // draft-complete message, which can finish after the interaction response_url
  // has expired/been used up. Needs the chat:write scope (and chat:write.public
  // to post in channels the bot isn't a member of).
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,

  // Slack OAuth (Phase 3 install flow). Client id/secret identify the Quillio
  // app; redirect URI must match the one registered in the Slack app config.
  SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
  SLACK_REDIRECT_URI: process.env.SLACK_REDIRECT_URI,

  // Secret used to sign web session cookies (express-session). Set in prod;
  // a random per-boot fallback is used when unset (sessions won't survive a
  // restart, which is fine for the keyless demo). Never logged.
  SESSION_SECRET: process.env.SESSION_SECRET,

  ALLOWED_ASSETS,
};
