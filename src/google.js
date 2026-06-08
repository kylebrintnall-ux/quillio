'use strict';

const { google } = require('googleapis');
const config = require('./config');

// Scopes: create/read Drive files, edit Docs, read the specs Sheet.
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

let cached = null;

function loadCredentials() {
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  }
  try {
    return JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message);
  }
}

// Returns memoized Drive / Docs / Sheets clients authenticated as the service
// account. The email used here is what the Sheet and Drive folder must be
// shared with.
async function getClients() {
  if (cached) return cached;

  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  const authClient = await auth.getClient();

  cached = {
    drive: google.drive({ version: 'v3', auth: authClient }),
    docs: google.docs({ version: 'v1', auth: authClient }),
    sheets: google.sheets({ version: 'v4', auth: authClient }),
    serviceAccountEmail: credentials.client_email,
  };
  return cached;
}

module.exports = { getClients };
