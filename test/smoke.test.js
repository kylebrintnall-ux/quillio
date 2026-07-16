'use strict';

// Layer-1 smoke / wiring tests + a few pure-logic checks. No secrets, no
// network — these just confirm the modules load, the public APIs are intact
// (so a refactor can't silently break the wiring), the core stays free of Slack
// imports, and a handful of pure functions behave. Run with: npm test
//
// Uses Node's built-in test runner (node --test) — no dependencies to install.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// --- Wiring: every module loads and exposes the expected public API ---

test('core/pipeline exposes the expected functions', () => {
  const p = require('../src/core/pipeline');
  const expected = [
    'parseBrief',
    'fetchAllReferences',
    'enrichWithReferences',
    'generateDoc',
    'generateDraft',
    'countDocAssets',
    'getFolderName',
    'extractBriefFolderId',
    'isFolderAccessError',
    'getServiceAccountEmail',
  ];
  for (const fn of expected) {
    assert.strictEqual(typeof p[fn], 'function', `pipeline.${fn} should be a function`);
  }
});

test('core/pipeline does NOT import the Slack messaging layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'pipeline.js'), 'utf8');
  assert.ok(!/services\/slack/.test(src), 'pipeline.js must not import services/slack');
});

test('adapters/slackWorkflow exposes the two entry points', () => {
  const a = require('../src/adapters/slackWorkflow');
  assert.strictEqual(typeof a.runBriefWorkflow, 'function');
  assert.strictEqual(typeof a.runGenerateDraft, 'function');
});

test('emoji config maps custom emoji to standard fallbacks', () => {
  const { emoji, EMOJI, USE_CUSTOM_EMOJI } = require('../src/emoji');
  // Existing behavior unchanged: custom emoji on, so emoji() yields :name:.
  assert.strictEqual(USE_CUSTOM_EMOJI, true);
  assert.strictEqual(emoji('quillio-scroll'), ':quillio-scroll:');
  assert.strictEqual(emoji('quillio-folder'), ':quillio-folder:');
  // Fallback map is complete and correct (used when USE_CUSTOM_EMOJI is false).
  assert.deepStrictEqual(EMOJI, {
    'quillio-scroll': '📜',
    'quillio-doc-done': '📄',
    'quillio-folder': '📁',
    'quillio-copy-done': '🪶',
    quillio: '🪶',
  });
});

test('workflow.js shim re-exports the entry points', () => {
  const w = require('../src/workflow');
  assert.strictEqual(typeof w.runBriefWorkflow, 'function');
  assert.strictEqual(typeof w.runGenerateDraft, 'function');
});

test('services/slack exposes posting + Block Kit helpers', () => {
  const s = require('../src/services/slack');
  const expected = [
    'postResult',
    'updateMessage',
    'postChatMessage',
    'postFolderAccessHelp',
    'buildFolderAccessBlocks',
    'buildResultBlocks',
    'openInDriveBlocks',
    'copyCompleteBlocks',
    'reviewRequestBlocks',
    'designerHandoffBlocks',
    'changesRequestedBlocks',
    'postLive',
    'updateLive',
  ];
  for (const fn of expected) {
    assert.strictEqual(typeof s[fn], 'function', `slack.${fn} should be a function`);
  }
});

test('services, destinations, db, and handlers load with their APIs', () => {
  const gemini = require('../src/services/gemini');
  assert.strictEqual(typeof gemini.parseBrief, 'function');
  assert.strictEqual(typeof gemini.generateVoiceGuide, 'function');
  assert.strictEqual(typeof require('../src/destinations').getDestination, 'function');
  assert.strictEqual(typeof require('../src/db').saveVoiceGuide, 'function');
  const approval = require('../src/handlers/approval');
  for (const fn of ['handleSubmitForReview', 'handleApprove', 'handleRequestChanges', 'handleResubmit']) {
    assert.strictEqual(typeof approval[fn], 'function', `approval.${fn} should be a function`);
  }
});

// --- Pure logic: functions safe to call without secrets/network ---

test('extractBriefFolderId pulls folder ids from both URL forms', () => {
  const { extractBriefFolderId } = require('../src/core/pipeline');
  assert.strictEqual(
    extractBriefFolderId('drop it in https://drive.google.com/drive/folders/ABC_123 please'),
    'ABC_123'
  );
  assert.strictEqual(extractBriefFolderId('https://drive.google.com/open?id=XYZ-789'), 'XYZ-789');
  assert.strictEqual(extractBriefFolderId('no folder link here'), null);
  // A Drive *file* link must NOT be treated as a folder.
  assert.strictEqual(extractBriefFolderId('https://drive.google.com/file/d/FILEID/view'), null);
});

test('isFolderAccessError classifies folder-access failures', () => {
  const { isFolderAccessError } = require('../src/core/pipeline');
  assert.strictEqual(isFolderAccessError(new Error('anything'), null), false); // no folder → false
  assert.strictEqual(isFolderAccessError({ code: 403, message: 'Forbidden' }, 'F1'), true);
  assert.strictEqual(isFolderAccessError({ code: 404 }, 'F1'), true);
  assert.strictEqual(isFolderAccessError(new Error('insufficient permission'), 'F1'), true);
  assert.strictEqual(isFolderAccessError(new Error('totally unrelated failure'), 'F1'), false);
});

test('resolveDestinationFolderId prioritizes brief URL > tenant default > none', () => {
  const { resolveDestinationFolderId } = require('../src/core/pipeline');
  const tenant = { default_folder_id: 'TENANT_DEFAULT' };
  // 1. A folder URL in the brief overrides the tenant default.
  assert.strictEqual(
    resolveDestinationFolderId('put it in https://drive.google.com/drive/folders/BRIEF_FOLDER', tenant),
    'BRIEF_FOLDER'
  );
  // 2. No brief URL → the tenant's saved default folder (the Settings value).
  assert.strictEqual(resolveDestinationFolderId('no folder link here', tenant), 'TENANT_DEFAULT');
  // 3. No brief URL and no tenant default → null (generateDoc uses config.DRIVE_FOLDER_ID).
  assert.strictEqual(resolveDestinationFolderId('no folder', { default_folder_id: null }), null);
  assert.strictEqual(resolveDestinationFolderId('no folder', null), null);
});

test('copyCompleteBlocks builds Open in Drive + Submit for Review', () => {
  const { copyCompleteBlocks } = require('../src/services/slack');
  const blocks = copyCompleteBlocks('done', 'https://doc', 'DOC1');
  const actions = blocks.find((b) => b.type === 'actions').elements;
  const ids = actions.map((e) => e.action_id);
  assert.ok(ids.includes('open_in_drive'), 'has Open in Drive');
  assert.ok(ids.includes('submit_for_review'), 'has Submit for Review');
  assert.strictEqual(
    actions.find((e) => e.action_id === 'submit_for_review').value,
    'DOC1',
    'submit button carries the doc id'
  );
});

test('reviewRequestBlocks has Review Copy / Approve / Request Changes', () => {
  const { reviewRequestBlocks } = require('../src/services/slack');
  const blocks = reviewRequestBlocks({
    campaignTitle: 'Q3 Always On',
    assetList: 'LinkedIn, Email',
    docUrl: 'https://doc',
    projectRef: '7',
  });
  const ids = blocks.find((b) => b.type === 'actions').elements.map((e) => e.action_id);
  assert.deepStrictEqual(ids, ['review_copy', 'approve', 'request_changes']);
});

test('config.ALLOWED_ASSETS is the 30-name v3 taxonomy', () => {
  const { ALLOWED_ASSETS } = require('../src/config');
  assert.strictEqual(ALLOWED_ASSETS.length, 30);
  assert.ok(ALLOWED_ASSETS.includes('Battle Card'));
  assert.ok(ALLOWED_ASSETS.includes('LinkedIn Single Image Ad'));
});

test('extractCanvasId returns the final path segment (handles /docs/TEAM/ID)', () => {
  const { extractCanvasId } = require('../src/core/pipeline');
  assert.strictEqual(extractCanvasId('https://acme.slack.com/canvas/F0ABC123'), 'F0ABC123');
  assert.strictEqual(extractCanvasId('https://acme.slack.com/docs/T123/F0XYZ789'), 'F0XYZ789');
  assert.strictEqual(extractCanvasId('https://acme.slack.com/canvas/F0DEF456?foo=bar#x'), 'F0DEF456');
  assert.strictEqual(extractCanvasId('https://acme.slack.com/docs/T123/F0AAA111/'), 'F0AAA111');
});

test('asset-name normalize folds case, dash variants, and spacing', () => {
  const { normalize } = require('../src/utils/normalize');
  const base = normalize('Paid Social - LinkedIn');
  assert.strictEqual(normalize('Paid Social – LinkedIn'), base, 'en dash matches'); // en dash
  assert.strictEqual(normalize('paid social-linkedin'), base, 'case + spacing match');
  assert.notStrictEqual(normalize('Paid Social - Meta'), base, 'different name differs');
});

test('fieldLabel renders char-limit brackets per min/max', () => {
  const { fieldLabel } = require('../src/destinations/googleDocs');
  assert.strictEqual(fieldLabel({ fieldName: 'Headline', charMin: 50, charMax: 75 }), 'Headline [50-75]');
  assert.strictEqual(fieldLabel({ fieldName: 'Body', charMin: 0, charMax: 500 }), 'Body [500]');
  assert.strictEqual(fieldLabel({ fieldName: 'CTA', charMin: 0, charMax: 0 }), 'CTA');
});

test('parseDoc detects per-field copy delete ranges (regeneration vs first draft)', () => {
  const { parseDoc } = require('../src/destinations/googleDocs');

  // Build a synthetic doc the way Google Docs returns it: each paragraph carries
  // start/endIndex, a namedStyleType, and a textRun with its bold/italic style.
  // The body starts at index 1 and every paragraph includes its trailing "\n".
  function makeDoc(paras) {
    let idx = 1;
    const content = paras.map((para) => {
      const raw = (para.text || '') + '\n';
      const startIndex = idx;
      const endIndex = idx + raw.length;
      idx = endIndex;
      return {
        startIndex,
        endIndex,
        paragraph: {
          paragraphStyle: para.style ? { namedStyleType: para.style } : {},
          elements: [{ textRun: { content: raw, textStyle: { bold: !!para.bold, italic: !!para.italic } } }],
        },
      };
    });
    return { body: { content } };
  }

  const paras = [
    { text: 'Campaign Summary', style: 'HEADING_2' },
    { text: 'the summary', italic: true },
    { text: 'Writer Direction', style: 'HEADING_2' },
    { text: 'the direction', italic: true },
    { text: 'LinkedIn Single Image Ad', style: 'HEADING_3' },
    { text: 'Paid Social · confident', italic: true }, // meta line (channel · tone)
    { text: 'Headline [50]', bold: true }, // field 0 label
    { text: 'First line of old copy' }, //     field 0 copy (para idx 7)
    { text: 'Second line of old copy' }, //    field 0 copy (para idx 8, last non-empty)
    { text: '' }, //                           field 0 trailing blank — must be preserved
    { text: 'Body [100]', bold: true }, //     field 1 label (un-drafted)
    { text: '' }, //                           field 1 trailing blank
  ];
  const doc = makeDoc(paras);
  const c = doc.body.content;
  const { summary, writerPrompt, assets } = parseDoc(doc);

  assert.strictEqual(summary, 'the summary');
  assert.strictEqual(writerPrompt, 'the direction');
  assert.strictEqual(assets.length, 1);
  assert.strictEqual(assets[0].assetType, 'LinkedIn Single Image Ad');
  assert.strictEqual(assets[0].channel, 'Paid Social');
  assert.strictEqual(assets[0].toneNotes, 'confident');

  const [headline, body] = assets[0].fields;

  // Field 0 was already drafted → delete range covers the copy and ends at the
  // LAST non-empty copy paragraph (idx 8), never the trailing blank (idx 9).
  assert.strictEqual(headline.fieldName, 'Headline');
  assert.strictEqual(headline.charMax, 50);
  assert.strictEqual(headline.insertIndex, c[6].endIndex);
  assert.strictEqual(headline.deleteEnd, c[8].endIndex);
  assert.ok(headline.deleteEnd > headline.insertIndex);
  assert.ok(headline.deleteEnd < c[9].endIndex, 'delete range stops before the trailing blank');

  // Field 1 is un-drafted → deleteEnd null, so generateDraft takes the
  // untouched first-draft (insert-only) path.
  assert.strictEqual(body.fieldName, 'Body');
  assert.strictEqual(body.charMax, 100);
  assert.strictEqual(body.insertIndex, c[10].endIndex);
  assert.strictEqual(body.deleteEnd, null);
});

test('parseDoc skips per-field italic notes (insertion below notes, never deleted)', () => {
  const { parseDoc } = require('../src/destinations/googleDocs');

  function makeDoc(paras) {
    let idx = 1;
    const content = paras.map((para) => {
      const raw = (para.text || '') + '\n';
      const startIndex = idx;
      const endIndex = idx + raw.length;
      idx = endIndex;
      return {
        startIndex,
        endIndex,
        paragraph: {
          paragraphStyle: para.style ? { namedStyleType: para.style } : {},
          elements: [{ textRun: { content: raw, textStyle: { bold: !!para.bold, italic: !!para.italic } } }],
        },
      };
    });
    return { body: { content } };
  }

  const paras = [
    { text: 'LinkedIn Single Image Ad', style: 'HEADING_3' }, // idx 0
    { text: 'Paid Social · confident', italic: true }, //       idx 1 (asset meta)
    { text: 'Headline [50]', bold: true }, //                   idx 2 (field 0 label)
    { text: 'Write this as a question.', italic: true }, //     idx 3 (field 0 NOTES)
    { text: 'Drafted headline copy', italic: false }, //        idx 4 (field 0 copy)
    { text: '' }, //                                            idx 5 (blank)
    { text: 'Body [100]', bold: true }, //                      idx 6 (field 1 label)
    { text: 'Lead with the pain point.', italic: true }, //     idx 7 (field 1 NOTES)
    { text: '' }, //                                            idx 8 (blank, un-drafted)
  ];
  const doc = makeDoc(paras);
  const c = doc.body.content;
  const [headline, body] = parseDoc(doc).assets[0].fields;

  // Field 0 (drafted): notes captured; copy inserts BELOW the notes; delete
  // range covers only the copy — the notes paragraph is entirely before it.
  assert.strictEqual(headline.notes, 'Write this as a question.');
  assert.strictEqual(headline.insertIndex, c[3].endIndex, 'insertion point is after the notes line');
  assert.strictEqual(headline.deleteEnd, c[4].endIndex, 'delete range covers only the copy');
  assert.ok(c[3].endIndex <= headline.insertIndex, 'notes paragraph ends at/before the delete start → never deleted');

  // Field 1 (un-drafted): notes captured; insertion is after the notes; no copy.
  assert.strictEqual(body.notes, 'Lead with the pain point.');
  assert.strictEqual(body.insertIndex, c[7].endIndex, 'insertion point is after the notes line');
  assert.strictEqual(body.deleteEnd, null);
});

test('db exposes the tenant resolver + install-write API', () => {
  const db = require('../src/db');
  for (const fn of [
    'getTenantByWorkspace',
    'getTenantToken',
    'resolveTenant',
    'createTenantIfMissing',
    'saveTenantToken',
  ]) {
    assert.strictEqual(typeof db[fn], 'function', `db.${fn} should be a function`);
  }
});

test('install writes degrade gracefully with no database', async () => {
  const { createTenantIfMissing, saveTenantToken } = require('../src/db');
  assert.strictEqual(await createTenantIfMissing('T123', 'Acme'), false);
  assert.strictEqual(await saveTenantToken('T123', 'slack_bot', 'xoxb-x'), false);
});

test('oauth router mounts and exposes its routes', () => {
  const router = require('../src/routes/oauth');
  assert.strictEqual(typeof router, 'function', 'router is an express middleware fn');
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path)
    .sort();
  assert.deepStrictEqual(paths, [
    '/auth/figma',
    '/auth/figma/callback',
    '/oauth/google',
    '/oauth/google/callback',
    '/oauth/slack',
    '/oauth/slack/callback',
    '/welcome',
  ]);
});

test('google exposes getClients + getClientsForTenant', () => {
  // Export-only check — invoking would require real service-account creds.
  const g = require('../src/google');
  assert.strictEqual(typeof g.getClients, 'function');
  assert.strictEqual(typeof g.getClientsForTenant, 'function');
});

test('oauth.js wires the Google OAuth flow (per-user token storage)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oauth.js'), 'utf8');
  assert.ok(/accounts\.google\.com\/o\/oauth2/.test(src), 'redirects to Google consent');
  assert.ok(/oauth2\.googleapis\.com\/token/.test(src), 'exchanges code at the Google token endpoint');
  assert.ok(/saveTenantToken\([^)]*'google'/.test(src), "stores the token under service='google'");
  assert.ok(/connected=google/.test(src) && /error=google_failed/.test(src), 'redirects back to /app');
});

test('oauth.js wires the Figma OAuth redirect (Phase 4, granular scopes)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oauth.js'), 'utf8');
  assert.ok(/www\.figma\.com\/oauth/.test(src), 'redirects to the Figma consent screen');
  assert.ok(
    /current_user:read file_content:read file_metadata:read file_comments:write projects:read/.test(src),
    'requests the current granular Figma scopes'
  );
  assert.ok(/response_type.*code/.test(src), 'uses the authorization-code flow');
  assert.ok(/error=figma_failed/.test(src), 'redirects back with a sanitized error on misconfig');
});

test('oauth.js wires the Figma OAuth callback (token exchange + storage)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oauth.js'), 'utf8');
  // Current Figma OAuth token endpoint (granular-scope system), Basic auth.
  assert.ok(/api\.figma\.com\/v1\/oauth\/token/.test(src), 'exchanges at the current Figma token endpoint');
  assert.ok(/Authorization: `Basic \$\{basicAuth\}`/.test(src), 'uses HTTP Basic auth for the exchange');
  assert.ok(/grant_type: 'authorization_code'/.test(src), 'authorization-code grant');
  assert.ok(/consumeState\(req\.query\.state\)/.test(src), 'validates the CSRF state');
  // expires_in (seconds) is converted to an absolute timestamp, not stored raw.
  assert.ok(/expires_in/.test(src) && /Date\.now\(\) \+ Number\(expiresIn\) \* 1000/.test(src), 'converts expires_in seconds to a timestamp');
  assert.ok(/saveFigmaTokens\(/.test(src), 'stores tokens via saveFigmaTokens');
  assert.ok(/error=figma_failed/.test(src) && /connected=figma/.test(src), 'redirects on failure and success');
});

test('db exposes saveFigmaTokens and it degrades with no database', async () => {
  const db = require('../src/db');
  assert.strictEqual(typeof db.saveFigmaTokens, 'function');
  // No DATABASE_URL in the test env → no-op returns false.
  assert.strictEqual(await db.saveFigmaTokens('T0B8LPRDKHR', { accessToken: 'x' }), false);
});

test('db exposes getFigmaTokens and it degrades with no database', async () => {
  const db = require('../src/db');
  assert.strictEqual(typeof db.getFigmaTokens, 'function');
  // No DATABASE_URL in the test env → returns null.
  assert.strictEqual(await db.getFigmaTokens('T0B8LPRDKHR'), null);
});

test('services/figma token utility: exports + refresh wiring (Phase 4 Stage 1.4)', () => {
  const figma = require('../src/services/figma');
  assert.strictEqual(typeof figma.ensureFigmaAccessToken, 'function');
  assert.strictEqual(typeof figma.refreshFigmaToken, 'function');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'figma.js'), 'utf8');
  // Refresh at the current Figma token endpoint with the refresh_token grant.
  assert.ok(/api\.figma\.com\/v1\/oauth\/token/.test(src), 'refreshes at the current Figma token endpoint');
  assert.ok(/grant_type: 'refresh_token'/.test(src), 'uses the refresh_token grant');
  assert.ok(/Authorization: `Basic \$\{basicAuth\}`/.test(src), 'HTTP Basic auth (client_id:client_secret)');
  // Same expires_in seconds → absolute timestamp conversion as the 1.3 callback.
  assert.ok(/Number\(expiresIn\) \* 1000/.test(src), 'converts expires_in seconds to a timestamp');
  // Rotates the refresh token if returned, else keeps the existing one.
  assert.ok(/data\.refresh_token\) \|\| refreshToken/.test(src), 'keeps the old refresh token if not rotated');
  // Refreshes within a buffer before expiry, and persists via saveFigmaTokens.
  assert.ok(/REFRESH_BUFFER_MS/.test(src), 'refreshes within a pre-expiry buffer');
  assert.ok(/saveFigmaTokens\(/.test(src), 'persists via the saveFigmaTokens upsert');
});

test('ensureFigmaAccessToken returns null when the tenant has no stored Figma tokens', async () => {
  // No DATABASE_URL → getFigmaTokens returns null → utility returns null (not connected).
  const { ensureFigmaAccessToken } = require('../src/services/figma');
  assert.strictEqual(await ensureFigmaAccessToken('T0B8LPRDKHR'), null);
});

// --- Week 11: onboarding + sign-in ---

test('oauth.js requests the userinfo scopes for Sign in with Google', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oauth.js'), 'utf8');
  assert.ok(/userinfo\.email/.test(src) && /userinfo\.profile/.test(src), 'requests userinfo scopes');
  assert.ok(/oauth2\/v2\/userinfo/.test(src), 'calls the Google userinfo endpoint');
  assert.ok(/req\.session\.userId/.test(src), 'sets the session userId on sign-in');
});

test('db/users exposes the finder + create/update API', () => {
  const u = require('../src/db/users');
  for (const fn of ['findUserByGoogleId', 'findUserByEmail', 'findUserById', 'createUser', 'updateUser']) {
    assert.strictEqual(typeof u[fn], 'function', `users.${fn} should be a function`);
  }
});

test('db/users degrades gracefully with no database', async () => {
  delete process.env.DATABASE_URL;
  const { findUserByGoogleId, findUserByEmail, findUserById, createUser, updateUser } = require('../src/db/users');
  assert.strictEqual(await findUserByGoogleId('g1'), null);
  assert.strictEqual(await findUserByEmail('a@b.co'), null);
  assert.strictEqual(await findUserById(1), null);
  assert.strictEqual(await createUser({ email: 'a@b.co' }), null);
  assert.strictEqual(await updateUser(1, { role: 'owner' }), null);
});

test('requireAuth bypasses (attaches a demo user) with no database', () => {
  delete process.env.DATABASE_URL;
  const { requireAuth } = require('../src/middleware/auth');
  assert.strictEqual(typeof requireAuth, 'function');
  let called = false;
  const req = { session: {}, path: '/app' };
  const res = { redirect: () => assert.fail('should not redirect in demo mode') };
  requireAuth(req, res, () => { called = true; });
  assert.ok(called, 'next() called in demo mode');
  assert.ok(req.user && req.user.tenant_id, 'a demo user is attached');
});

test('onboarding router mounts and exposes its routes', () => {
  const router = require('../src/routes/onboarding');
  assert.strictEqual(typeof router, 'function', 'router is an express middleware fn');
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path)
    .sort();
  assert.deepStrictEqual(paths, [
    '/api/onboarding/assets',
    '/api/onboarding/assets',
    '/api/onboarding/folder',
    '/api/onboarding/me',
    '/api/onboarding/voice',
    '/api/onboarding/voice',
    '/onboarding',
  ]);
});

test('routes/onboarding does NOT import the Slack messaging layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'onboarding.js'), 'utf8');
  assert.ok(!/services\/slack/.test(src), 'onboarding.js must not import services/slack');
});

test('public/onboarding.html has all six steps and talks to the onboarding API', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  for (let i = 1; i <= 6; i++) {
    assert.ok(html.includes(`id="step-${i}"`), `onboarding.html should contain step ${i}`);
  }
  assert.ok(/\/oauth\/google\?redirect=onboarding/.test(html), 'Step 1 signs in with Google');
  assert.ok(/\/api\/onboarding\/voice/.test(html), 'voice step posts to the API');
  // v8 design system: StarCrush via @font-face + IBM Plex from Google Fonts
  // (matches app.html / settings.html). Scripts must still all be inline.
  assert.ok(/@font-face[\s\S]*Star_Crush\.otf/.test(html), 'loads the StarCrush font via @font-face');
  assert.ok(/Encode\+Sans\+Semi\+Condensed/.test(html), 'loads Encode Sans Semi Condensed (font experiment)');
  assert.ok(!/<script\s+[^>]*src=/i.test(html), 'no external scripts');
});

// --- Week 12: settings page ---

test('settings router mounts and exposes its routes', () => {
  const router = require('../src/routes/settings');
  assert.strictEqual(typeof router, 'function', 'router is an express middleware fn');
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path)
    .sort();
  assert.deepStrictEqual(paths, [
    '/api/auth/signout',
    '/api/settings/voice',
    '/api/settings/voice',
    '/api/settings/voice/generate',
    '/api/settings/workspace',
    '/api/settings/workspace/folder',
    '/settings',
  ]);
});

test('routes/settings does NOT import the Slack messaging layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'settings.js'), 'utf8');
  assert.ok(!/services\/slack/.test(src), 'settings.js must not import services/slack');
});

test('public/settings.html has the three sections, terminal styling, and settings API wiring', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  for (const id of ['panel-voice', 'panel-workspace', 'panel-account']) {
    assert.ok(html.includes(id), `settings.html should contain #${id}`);
  }
  assert.ok(/IBM\+Plex\+Mono/.test(html), 'loads IBM Plex Mono');
  assert.ok(/#1C1F3B/i.test(html), 'terminal navy background');
  assert.ok(/\/api\/settings\/voice/.test(html), 'talks to the voice API');
  assert.ok(/\/api\/auth\/signout/.test(html), 'wires sign out');
  assert.ok(/\/oauth\/google\?redirect=settings/.test(html), 'reconnect Google returns to settings');
  assert.ok(!/<script\s+[^>]*src=/i.test(html), 'no external scripts');
});

test('oauth.js handles redirect=settings for Google and Slack', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oauth.js'), 'utf8');
  assert.ok(/\/settings\?connected=google/.test(src), 'Google callback can return to settings');
  assert.ok(/\/settings\?slack=connected/.test(src), 'Slack callback can return to settings');
});

test('getTenantByWorkspace returns null with no database', async () => {
  // No DATABASE_URL in the test env → graceful null, not a throw.
  const { getTenantByWorkspace } = require('../src/db');
  assert.strictEqual(await getTenantByWorkspace('T0B8LPRDKHR'), null);
});

test('resolveTenant falls back to a consistent env-var shape with no DB', async () => {
  const { resolveTenant } = require('../src/db');
  const r = await resolveTenant('T0B8LPRDKHR');
  assert.strictEqual(r.source, 'env');
  // tenant shape
  assert.strictEqual(r.tenant.workspace_id, 'T0B8LPRDKHR');
  for (const k of ['id', 'workspace_id', 'workspace_name', 'plan', 'onboarding_complete', 'default_folder_id']) {
    assert.ok(k in r.tenant, `tenant.${k} present`);
  }
  // tokens shape — keys always present (values may be null without env set)
  assert.deepStrictEqual(Object.keys(r.tokens).sort(), ['google', 'slack_bot', 'slack_user']);
});

// --- Week 7: per-tenant asset library ---

test('defaultAssets is the 30-type v3 library with valid shape', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  assert.strictEqual(DEFAULT_ASSETS.length, 30, 'exactly 30 asset types');

  const groups = new Set([
    'Paid Social',
    'Display',
    'Email',
    'Events',
    'Web',
    'Organic Social',
    'Direct Mail',
    'Sales Enablement',
  ]);

  const seenSortOrders = new Set();
  for (const a of DEFAULT_ASSETS) {
    // required top-level keys
    for (const k of ['name', 'group', 'sort_order', 'is_active', 'spec_source', 'spec_version', 'fields']) {
      assert.ok(k in a, `asset "${a.name}" missing ${k}`);
    }
    assert.strictEqual(typeof a.name, 'string');
    assert.ok(a.name.length > 0, 'asset name non-empty');
    assert.ok(groups.has(a.group), `asset "${a.name}" has known group (got "${a.group}")`);
    assert.strictEqual(a.is_active, true);
    // spec metadata
    assert.strictEqual(a.spec_source, 'quillio_default');
    assert.strictEqual(a.spec_version, '1.0');
    // contiguous, unique sort_order across types
    assert.ok(!seenSortOrders.has(a.sort_order), `duplicate sort_order ${a.sort_order}`);
    seenSortOrders.add(a.sort_order);
    // fields
    assert.ok(Array.isArray(a.fields) && a.fields.length > 0, `asset "${a.name}" has fields`);
    for (const f of a.fields) {
      for (const k of ['field_name', 'char_min', 'char_max', 'field_type', 'sort_order']) {
        assert.ok(k in f, `field in "${a.name}" missing ${k}`);
      }
      assert.strictEqual(typeof f.field_name, 'string');
      assert.strictEqual(typeof f.char_min, 'number');
      assert.strictEqual(typeof f.char_max, 'number');
      assert.strictEqual(f.field_type, 'text');
      assert.ok(f.char_max >= f.char_min, `field "${f.field_name}" max >= min`);
    }
  }
  // sort_order is 1..30 contiguous
  assert.deepStrictEqual(
    [...seenSortOrders].sort((x, y) => x - y),
    Array.from({ length: 30 }, (_, i) => i + 1)
  );
});

test('defaultAssets Graphic Copy group is contiguous and correctly placed', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const grouped = DEFAULT_ASSETS.filter((a) => a.fields.some((f) => f.group_label === 'Graphic Copy'));
  assert.strictEqual(grouped.length, 14, '14 assets carry a Graphic Copy group');
  for (const a of grouped) {
    // Grouped fields must be one uninterrupted run so the Doc renders a single
    // sub-heading (and the Figma population step maps them as a unit).
    const idxs = a.fields.map((f, i) => (f.group_label === 'Graphic Copy' ? i : -1)).filter((i) => i >= 0);
    for (let k = 1; k < idxs.length; k++) {
      assert.strictEqual(idxs[k], idxs[k - 1] + 1, `${a.name}: Graphic Copy fields must be contiguous`);
    }
    const groupNames = idxs.map((i) => a.fields[i].field_name);
    assert.ok(groupNames.includes('Subhead'), `${a.name}: Subhead in group`);
    assert.ok(groupNames.includes('Graphic Headline'), `${a.name}: Graphic Headline in group`);
  }
  // Display Banner merged its two headlines — only Graphic Headline remains.
  const disp = DEFAULT_ASSETS.find((a) => a.name === 'Display Banner — Standard');
  assert.ok(!disp.fields.some((f) => f.field_name === 'Headline'), 'display banner has no plain Headline');
  // The three organic assets gained a Graphic Headline (post + graphic model).
  for (const n of ['Organic Social — LinkedIn', 'Organic Social — Instagram', 'Organic Social — Twitter/X']) {
    const a = DEFAULT_ASSETS.find((x) => x.name === n);
    assert.ok(a.fields.some((f) => f.field_name === 'Graphic Headline'), `${n}: has Graphic Headline`);
  }
});

test('DocBuilder renders a Graphic Copy group heading (HEADING_4) with indented fields', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const b = new DocBuilder();
  b.assetHeading('LinkedIn Single Image Ad');
  b.groupLabel('Graphic Copy');
  b.boldLabel('Graphic Headline [70]', { indent: 18 });
  b.blankLine({ indent: 18 });
  const reqs = b.buildRequests();
  const styleReqs = reqs.filter((r) => r.updateParagraphStyle);
  // The group heading uses HEADING_4 — the named style parseDoc skips.
  const h4 = styleReqs.filter((r) => r.updateParagraphStyle.paragraphStyle.namedStyleType === 'HEADING_4');
  assert.strictEqual(h4.length, 1, 'exactly one HEADING_4 group heading');
  // The grouped label + blank draft slot carry a left indent.
  const indented = styleReqs.filter((r) => r.updateParagraphStyle.paragraphStyle.indentStart);
  assert.ok(indented.length >= 2, 'grouped label and blank line are indented');
});

test('parseDoc skips the Graphic Copy group heading and recovers grouped fields', () => {
  const { parseDoc } = require('../src/destinations/googleDocs');
  function makeDoc(paras) {
    let idx = 1;
    const content = paras.map((para) => {
      const raw = (para.text || '') + '\n';
      const startIndex = idx;
      const endIndex = idx + raw.length;
      idx = endIndex;
      return {
        startIndex,
        endIndex,
        paragraph: {
          paragraphStyle: para.style ? { namedStyleType: para.style } : {},
          elements: [{ textRun: { content: raw, textStyle: { bold: !!para.bold, italic: !!para.italic } } }],
        },
      };
    });
    return { body: { content } };
  }
  const paras = [
    { text: 'LinkedIn Single Image Ad', style: 'HEADING_3' },
    { text: 'Direct. Benefit-led.', italic: true },
    { text: 'Intro Text [600]', bold: true },
    { text: '' },
    { text: 'Headline [70]', bold: true },
    { text: '' },
    { text: 'Graphic Copy', style: 'HEADING_4' }, // group heading — must be skipped
    { text: 'Graphic Headline [70]', bold: true },
    { text: '' },
    { text: 'Subhead [40-90]', bold: true },
    { text: '' },
    { text: 'CTA Button [20]', bold: true },
    { text: '' },
  ];
  const fields = parseDoc(makeDoc(paras)).assets[0].fields;
  const names = fields.map((f) => f.fieldName);
  assert.deepStrictEqual(names, ['Intro Text', 'Headline', 'Graphic Headline', 'Subhead', 'CTA Button']);
  assert.ok(!names.includes('Graphic Copy'), 'the group heading is never parsed as a field');
  // Char limits are still recovered for fields that follow the group heading.
  const sub = fields.find((f) => f.fieldName === 'Subhead');
  assert.strictEqual(sub.charMin, 40);
  assert.strictEqual(sub.charMax, 90);
});

test('fieldHint explains the visible-then-more mechanic for Hook fields only', () => {
  const { fieldHint } = require('../src/destinations/googleDocs');
  assert.ok(fieldHint({ fieldName: 'Hook (first 125 chars, before More)' }), 'Instagram hook gets a hint');
  assert.ok(fieldHint({ fieldName: 'Hook (first 150 chars, before See more)' }), 'LinkedIn hook gets a hint');
  assert.match(fieldHint({ fieldName: 'Hook' }), /more/i);
  assert.strictEqual(fieldHint({ fieldName: 'Headline' }), null);
  assert.strictEqual(fieldHint({ fieldName: 'Subhead' }), null);
});

test('parseDoc treats a Hook field explainer as notes, not copy (insertion below it)', () => {
  const { parseDoc } = require('../src/destinations/googleDocs');
  function makeDoc(paras) {
    let idx = 1;
    const content = paras.map((para) => {
      const raw = (para.text || '') + '\n';
      const startIndex = idx;
      const endIndex = idx + raw.length;
      idx = endIndex;
      return {
        startIndex,
        endIndex,
        paragraph: {
          paragraphStyle: para.style ? { namedStyleType: para.style } : {},
          elements: [{ textRun: { content: raw, textStyle: { bold: !!para.bold, italic: !!para.italic } } }],
        },
      };
    });
    return { body: { content } };
  }
  const paras = [
    { text: 'Organic Social — Instagram', style: 'HEADING_3' },
    { text: 'Visual does the work.', italic: true },
    { text: 'Caption [165]', bold: true },
    { text: '' },
    { text: 'Hook (first 125 chars, before More) [125]', bold: true },
    { text: 'Only this opening runs before “…more.”', italic: true }, // the rendered explainer
    { text: '' }, // draft slot — copy inserts here, below the explainer
    { text: 'Graphic Copy', style: 'HEADING_4' },
    { text: 'Graphic Headline [70]', bold: true },
    { text: '' },
    { text: 'Subhead [40-90]', bold: true },
    { text: '' },
  ];
  const doc = makeDoc(paras);
  const c = doc.body.content;
  const fields = parseDoc(doc).assets[0].fields;
  assert.deepStrictEqual(fields.map((f) => f.fieldName), ['Caption', 'Hook (first 125 chars, before More)', 'Graphic Headline', 'Subhead']);
  const hook = fields.find((f) => f.fieldName === 'Hook (first 125 chars, before More)');
  // The explainer is captured as notes; the draft insert point is BELOW it.
  assert.match(hook.notes, /more/i);
  assert.strictEqual(hook.insertIndex, c[5].endIndex, 'copy inserts below the explainer line');
  assert.strictEqual(hook.deleteEnd, null, 'the explainer is never treated as drafted copy');
});

test('builtInFieldGuidance forces sentence case for Graphic Headline', () => {
  const { builtInFieldGuidance } = require('../src/services/gemini');
  assert.match(builtInFieldGuidance('Graphic Headline'), /sentence case/i);
  assert.match(builtInFieldGuidance('graphic headline'), /sentence case/i); // case-insensitive
  assert.match(builtInFieldGuidance('Subhead'), /supporting line/i);
  assert.strictEqual(builtInFieldGuidance('Headline'), ''); // platform headline untouched
  assert.strictEqual(builtInFieldGuidance('CTA Button'), '');
});

test('db/assets exposes seedTenantAssets + getTenantAssets', () => {
  const a = require('../src/db/assets');
  assert.strictEqual(typeof a.seedTenantAssets, 'function');
  assert.strictEqual(typeof a.getTenantAssets, 'function');
});

test('db/assets degrades gracefully with no database', async () => {
  // No DATABASE_URL in the test env → seed no-ops (false), read misses (null).
  const { seedTenantAssets, getTenantAssets } = require('../src/db/assets');
  assert.strictEqual(await seedTenantAssets('T0B8LPRDKHR'), false);
  assert.strictEqual(await getTenantAssets('T0B8LPRDKHR'), null);
});

test('db exposes getPool', () => {
  const db = require('../src/db');
  assert.strictEqual(typeof db.getPool, 'function');
  // No DATABASE_URL → getPool returns null (no pg connection attempted).
  assert.strictEqual(db.getPool(), null);
});

// --- Week 8: web app backend foundation ---

test('adapters/web exposes runWebBrief + runWebDraft', () => {
  const w = require('../src/adapters/web');
  assert.strictEqual(typeof w.runWebBrief, 'function');
  assert.strictEqual(typeof w.runWebDraft, 'function');
});

test('adapters/web does NOT import the Slack messaging layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'web.js'), 'utf8');
  assert.ok(!/services\/slack/.test(src), 'web.js must not import services/slack');
});

test('routes/app mounts and exposes its routes', () => {
  const router = require('../src/routes/app');
  assert.strictEqual(typeof router, 'function', 'router is an express middleware fn');
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path)
    .sort();
  assert.deepStrictEqual(paths, [
    '/api/brief',
    '/api/brief/:jobId/status',
    '/api/draft',
    '/api/draft/:jobId/status',
    '/api/projects',
    '/api/projects/:id',
    '/api/projects/:id/content',
    '/api/projects/:id/status',
    '/api/review',
    '/api/review/:jobId/status',
    '/api/upload',
    '/app',
  ]);
});

test('routes/app does NOT import the Slack messaging layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  assert.ok(!/services\/slack/.test(src), 'app.js must not import services/slack');
});

// --- Week 9: web app frontend ---

test('public/app.html has the core screens, API wiring, and the v8 design system', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  // The single-page screens are all present (incl. the v8 generating + copy-done).
  for (const id of ['screen-brief', 'screen-progress', 'screen-output', 'screen-generating', 'screen-copydone']) {
    assert.ok(html.includes(id), `app.html should contain #${id}`);
  }
  // It talks to the Week 8 API.
  assert.ok(html.includes('/api/brief'), 'app.html posts to /api/brief');
  assert.ok(html.includes('/api/draft'), 'app.html posts to /api/draft');
  // No JS frameworks / CDNs — all client logic stays inline.
  assert.ok(!/<script\s+[^>]*src=/i.test(html), 'no external scripts');
  // v8 design system (replaces the old "system fonts, no images" rule): the
  // StarCrush display font is loaded via @font-face, IBM Plex is the body font,
  // and the pixel-art assets are referenced from the scoped /assets + /fonts
  // static routes.
  assert.ok(/@font-face[\s\S]*Star_Crush\.otf/.test(html), 'loads the StarCrush font via @font-face');
  assert.ok(/Encode\+Sans\+Semi\+Condensed/.test(html), 'loads Encode Sans Semi Condensed (font experiment)');
  assert.ok(/\/assets\/images\/quillio-quill\.png/.test(html), 'uses the pixel-quill logo');
  assert.ok(/\/assets\/gifs\//.test(html), 'uses the progress/header GIFs');
});

// --- Week 10: project history + project view ---

test('db/projects exposes saveProject + getProjects + getProject', () => {
  const p = require('../src/db/projects');
  assert.strictEqual(typeof p.saveProject, 'function');
  assert.strictEqual(typeof p.getProjects, 'function');
  assert.strictEqual(typeof p.getProject, 'function');
});

test('db/projects degrades gracefully with no database', async () => {
  delete process.env.DATABASE_URL;
  const { saveProject, getProjects, getProject } = require('../src/db/projects');
  assert.strictEqual(await saveProject('T0B8LPRDKHR', { name: 'X' }), null);
  assert.deepStrictEqual(await getProjects('T0B8LPRDKHR'), []);
  assert.strictEqual(await getProject('T0B8LPRDKHR', 1), null);
});

test('pipeline + web adapter expose the project-content readers', () => {
  assert.strictEqual(typeof require('../src/core/pipeline').getProjectContent, 'function');
  assert.strictEqual(typeof require('../src/adapters/web').runWebProjectContent, 'function');
  assert.strictEqual(typeof require('../src/destinations/googleDocs').getDocContent, 'function');
});

test('public/app.html has the history + project-view screens wired to the projects API', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  for (const id of ['screen-history', 'screen-project']) {
    assert.ok(html.includes(id), `app.html should contain #${id}`);
  }
  assert.ok(html.includes('/api/projects'), 'app.html reads /api/projects');
  assert.ok(/\/api\/projects\/.+\/content|\/content/.test(html), 'app.html fetches project content');
  assert.ok(/No projects yet/.test(html), 'history empty state present');
  assert.ok(/Content unavailable/.test(html), 'project-view fallback present');
});

// --- File attachment as reference input (Phase 3 additions) ---

test('pipeline exposes the attachment ingestion helpers', () => {
  const pipeline = require('../src/core/pipeline');
  assert.strictEqual(typeof pipeline.fetchAttachedFiles, 'function');
  assert.strictEqual(typeof pipeline.processAttachedFiles, 'function');
  assert.strictEqual(typeof pipeline.cleanupAttachedFiles, 'function');
});

test('attachment helpers handle empty input without network/fs', async () => {
  const pipeline = require('../src/core/pipeline');
  assert.deepStrictEqual(await pipeline.fetchAttachedFiles([]), []);
  assert.deepStrictEqual(await pipeline.fetchAttachedFiles(undefined), []);
  assert.deepStrictEqual(await pipeline.processAttachedFiles([]), []);
  // cleanup of nothing must not throw
  await pipeline.cleanupAttachedFiles([]);
  await pipeline.cleanupAttachedFiles(undefined);
});

test('gemini.describeImage returns "" gracefully on empty/no-key', async () => {
  const { describeImage } = require('../src/services/gemini');
  assert.strictEqual(typeof describeImage, 'function');
  // No base64 → short-circuits to '' (no API call).
  assert.strictEqual(await describeImage('', 'image/png'), '');
});

test('app.html has the file-attachment UI wired (+ button, picker, upload)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('id="attach-btn"'), 'has the + add-files button');
  assert.ok(/id="file-input"[^>]*accept="\.pdf,\.docx,\.jpg,\.jpeg,\.png"/.test(html), 'file input accepts the supported types');
  assert.ok(html.includes('/api/upload'), 'app.html uploads to /api/upload');
  assert.ok(html.includes('fileRefs'), 'app.html passes fileRefs into the brief job');
});

test('app route exposes POST /api/upload (multipart) and loads', () => {
  // Requiring the route module proves multer wired in cleanly at load time.
  const router = require('../src/routes/app');
  assert.strictEqual(typeof router, 'function');
});

// --- Header-table primitive (doc-header-template work, step 1) ---
// Only the pure request-builders are unit-testable without a live Google Doc;
// the two-phase insert/re-read/fill flow is exercised by the dev harness
// (scripts/genHeaderTableTestDoc.js) against real Docs.

test('docHeaderTable exposes the header-table primitives', () => {
  const h = require('../src/destinations/docHeaderTable');
  for (const fn of ['tableInsertRequests', 'findHeaderTable', 'tableStyleRequests', 'cellFillRequests', 'renderCell']) {
    assert.strictEqual(typeof h[fn], 'function', `exports ${fn}`);
  }
  assert.ok(h.SAMPLE_HEADER_SCHEMA && Array.isArray(h.SAMPLE_HEADER_SCHEMA.rows), 'exports a sample schema');
});

test('tableInsertRequests emits one insertTable matching the schema shape', () => {
  const { tableInsertRequests, SAMPLE_HEADER_SCHEMA } = require('../src/destinations/docHeaderTable');
  const reqs = tableInsertRequests(SAMPLE_HEADER_SCHEMA);
  assert.strictEqual(reqs.length, 1);
  assert.strictEqual(reqs[0].insertTable.rows, SAMPLE_HEADER_SCHEMA.rows.length);
  assert.strictEqual(reqs[0].insertTable.columns, SAMPLE_HEADER_SCHEMA.columns);
  assert.strictEqual(reqs[0].insertTable.location.index, 1);
});

test('renderCell bolds the wordmark and the field values (not the labels)', () => {
  const { renderCell } = require('../src/destinations/docHeaderTable');

  const wm = renderCell({ wordmark: 'MC Creative' });
  assert.strictEqual(wm.text, 'MC Creative');
  assert.strictEqual(wm.styleRuns.length, 1);
  assert.strictEqual(wm.styleRuns[0].textStyle.bold, true);

  const one = renderCell({ fields: [{ label: 'Project', value: 'State of Support 2026' }] });
  assert.strictEqual(one.text, 'Project: State of Support 2026');
  assert.strictEqual(one.styleRuns.length, 1);
  // the bold run covers exactly the value, starting right after "Project: "
  const run = one.styleRuns[0];
  assert.strictEqual(one.text.slice(run.start, run.start + run.len), 'State of Support 2026');
  assert.strictEqual(run.textStyle.bold, true);

  // two fields in one cell (Date + Version) → two bold value runs
  const two = renderCell({ fields: [{ label: 'Date', value: '2026-07-05' }, { label: 'Version', value: 'v1' }] });
  assert.strictEqual(two.styleRuns.length, 2);
  assert.strictEqual(two.text.slice(two.styleRuns[1].start, two.styleRuns[1].start + two.styleRuns[1].len), 'v1');

  // empty cell → nothing
  assert.deepStrictEqual(renderCell({ fields: [] }), { text: '', styleRuns: [] });
});

test('DocBuilder(startIndex) offsets recorded ranges (body-below-table case)', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const b = new DocBuilder(50);
  b.heading('Campaign Summary');
  const reqs = b.buildRequests();
  // first request inserts at the given startIndex, not 1
  assert.strictEqual(reqs[0].insertText.location.index, 50);
  // a recorded paragraph range starts at that offset too
  const para = reqs.find((r) => r.updateParagraphStyle);
  assert.strictEqual(para.updateParagraphStyle.range.startIndex, 50);
});

test('DocBuilder header-table requests are gated on headerTable(schema)', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const { SAMPLE_HEADER_SCHEMA } = require('../src/destinations/docHeaderTable');
  // no schema set → no header requests
  assert.deepStrictEqual(new DocBuilder().headerTableInsertRequests(), []);
  assert.deepStrictEqual(new DocBuilder().headerTableFillRequests({ table: {} }), []);
  // schema set → one insertTable request
  const b = new DocBuilder().headerTable(SAMPLE_HEADER_SCHEMA);
  assert.strictEqual(b.headerTableInsertRequests().length, 1);
  // fill requests need a located table element; null tableEl → []
  assert.deepStrictEqual(b.headerTableFillRequests(null), []);
});

// --- Block-based doc header schema + renderHeader dispatch (step 2) ---

test('docHeaderSchema: validity, table detection, and both seeds', () => {
  const s = require('../src/destinations/docHeaderSchema');
  assert.strictEqual(s.isValidHeaderSchema(null), false);
  assert.strictEqual(s.isValidHeaderSchema({}), false);
  assert.strictEqual(s.isValidHeaderSchema({ blocks: [] }), false);
  assert.strictEqual(s.isValidHeaderSchema({ blocks: [{ type: 'divider' }] }), true);

  assert.strictEqual(s.schemaHasTable(s.SEED_TABLE_HEADER), true);
  assert.strictEqual(s.schemaHasTable(s.SEED_TEXT_HEADER), false);

  assert.strictEqual(s.seedSchema('table'), s.SEED_TABLE_HEADER);
  assert.strictEqual(s.seedSchema('text'), s.SEED_TEXT_HEADER);
  assert.strictEqual(s.seedSchema('nope'), null);

  // Every field/cell carries a fill classification.
  const fills = new Set(Object.values(s.FILL));
  for (const block of s.SEED_TEXT_HEADER.blocks) {
    const fs = block.type === 'field_row' ? block.fields : block.label != null ? [block] : [];
    for (const f of fs) assert.ok(fills.has(f.fill), `text seed fill valid: ${f.fill}`);
  }
});

test('DocBuilder.fieldRow renders label:value with bold values only', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const b = new DocBuilder();
  b.fieldRow([
    { label: 'Date', value: '2026-07-05' },
    { label: 'Version', value: 'v1' },
  ]);
  // One paragraph of text, "Date: 2026-07-05    Version: v1"
  assert.ok(b.text.startsWith('Date: 2026-07-05    Version: v1'));
  // Two bold runs, one per value; each covers exactly the value text.
  const bolds = b.textRequests.filter((r) => r.updateTextStyle && r.updateTextStyle.textStyle.bold);
  assert.strictEqual(bolds.length, 2);
  for (const r of bolds) {
    const { startIndex, endIndex } = r.updateTextStyle.range;
    const slice = b.text.slice(startIndex - b.startIndex, endIndex - b.startIndex);
    assert.ok(slice === '2026-07-05' || slice === 'v1', `bold covers a value, got "${slice}"`);
  }
});

test('DocBuilder.renderHeader dispatches non-table blocks to a single batch', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const { SEED_TEXT_HEADER } = require('../src/destinations/docHeaderSchema');
  const b = new DocBuilder();
  b.renderHeader(SEED_TEXT_HEADER);
  assert.strictEqual(b.hasHeaderTable(), false); // no table → single-batch path
  const reqs = b.buildRequests();
  const inserted = reqs[0].insertText.text;
  assert.ok(inserted.includes('MC Creative'), 'heading text present');
  assert.ok(inserted.includes('Project: State of Support 2026'), 'label:value line present');
  assert.ok(inserted.includes('Date: 2026-07-05    Version: v1'), 'field_row present');
  // heading block → HEADING_2 paragraph style
  const h2 = reqs.find(
    (r) => r.updateParagraphStyle && r.updateParagraphStyle.paragraphStyle.namedStyleType === 'HEADING_2'
  );
  assert.ok(h2, 'heading block rendered as HEADING_2');
});

test('DocBuilder.renderHeader flags a table schema for the two-phase flow', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const { SEED_TABLE_HEADER } = require('../src/destinations/docHeaderSchema');
  const b = new DocBuilder();
  b.renderHeader(SEED_TABLE_HEADER);
  assert.strictEqual(b.hasHeaderTable(), true);
  assert.strictEqual(b.headerTableInsertRequests().length, 1);
  // Table structure isn't inserted as text — no body text accumulated yet.
  assert.strictEqual(b.text, '');
});

test('db exposes getHeaderSchema/saveHeaderSchema; no-DB is a safe no-op', async () => {
  const db = require('../src/db');
  assert.strictEqual(typeof db.getHeaderSchema, 'function');
  assert.strictEqual(typeof db.saveHeaderSchema, 'function');
  // Without DATABASE_URL these must not throw and must degrade to null/false.
  if (!process.env.DATABASE_URL) {
    assert.strictEqual(await db.getHeaderSchema('T0B8LPRDKHR'), null);
    assert.strictEqual(await db.saveHeaderSchema('T0B8LPRDKHR', { blocks: [] }, 'X'), false);
  }
});

test('default header fallback = title (centered 18pt bold) + HR + Campaign Summary', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const { appendBody } = require('../src/destinations/googleDocs');
  // Mirror createDocument's no-schema branch exactly: title + HR, then appendBody.
  const b = new DocBuilder();
  b.title('2026-07-06 — Sample');
  b.horizontalRule();
  appendBody(b, {
    summary: 'S',
    writerPrompt: 'W',
    resolvedLinks: [],
    referenceInsights: [],
    assetSpecs: [],
  });
  const reqs = b.buildRequests();

  // The inserted text opens with the title line, then a blank HR paragraph, then
  // the Campaign Summary heading — today's exact structure, unchanged.
  assert.ok(b.text.startsWith('2026-07-06 — Sample\n\nCampaign Summary\n'), b.text.slice(0, 60));

  // Title styled centered + bold 18pt (the title() primitive), before any heading.
  const centered = reqs.find(
    (r) => r.updateParagraphStyle && r.updateParagraphStyle.paragraphStyle.alignment === 'CENTER'
  );
  assert.ok(centered, 'title paragraph is centered');
  const titleText = reqs.find(
    (r) => r.updateTextStyle && r.updateTextStyle.textStyle.fontSize &&
      r.updateTextStyle.textStyle.fontSize.magnitude === 18
  );
  assert.ok(titleText && titleText.updateTextStyle.textStyle.bold, 'title is bold 18pt');

  // Campaign Summary + Writer Direction headings both present (drafting contract).
  assert.ok(b.text.includes('Campaign Summary'));
  assert.ok(b.text.includes('Writer Direction'));
});

// --- Onboarding header sample doc + boundary marker (step 3) ---

test('docHeaderSample exports the marker, sample appender, and generator', () => {
  const s = require('../src/destinations/docHeaderSample');
  assert.strictEqual(typeof s.generateHeaderSampleDoc, 'function');
  assert.strictEqual(typeof s.appendMarkerAndSample, 'function');
  assert.strictEqual(typeof s.HEADER_BOUNDARY_MARKER, 'string');
  assert.ok(s.HEADER_BOUNDARY_MARKER.length > 0);
  // The marker must be distinctive (contains the fixed sentinel words).
  assert.ok(s.HEADER_BOUNDARY_MARKER.includes('HEADER ENDS'));
});

test('boundaryMarker renders a centered, bold, grey paragraph with the exact text', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const { HEADER_BOUNDARY_MARKER } = require('../src/destinations/docHeaderSample');
  const b = new DocBuilder();
  b.boundaryMarker(HEADER_BOUNDARY_MARKER);
  // Exact marker text is present as its own paragraph.
  assert.ok(b.text.startsWith(HEADER_BOUNDARY_MARKER + '\n'));
  const reqs = b.buildRequests();
  const centered = reqs.find(
    (r) => r.updateParagraphStyle && r.updateParagraphStyle.paragraphStyle.alignment === 'CENTER'
  );
  assert.ok(centered, 'marker paragraph is centered');
  const styled = reqs.find(
    (r) => r.updateTextStyle && r.updateTextStyle.textStyle.bold && r.updateTextStyle.textStyle.foregroundColor
  );
  assert.ok(styled, 'marker text is bold + grey');
});

test('sample doc ordering: header ABOVE the marker, sample body BELOW it', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const { SEED_TEXT_HEADER } = require('../src/destinations/docHeaderSchema');
  const { appendMarkerAndSample, HEADER_BOUNDARY_MARKER } = require('../src/destinations/docHeaderSample');
  // Mirror the text-header path: renderHeader then marker + sample in one builder.
  const b = new DocBuilder();
  b.renderHeader(SEED_TEXT_HEADER);
  appendMarkerAndSample(b);

  const markerAt = b.text.indexOf(HEADER_BOUNDARY_MARKER);
  const headerAt = b.text.indexOf('MC Creative'); // from the header schema
  const bodyAt = b.text.indexOf('Campaign Summary'); // from the sample body
  assert.ok(headerAt >= 0 && markerAt >= 0 && bodyAt >= 0, 'all three regions present');
  assert.ok(headerAt < markerAt, 'header renders above the marker');
  assert.ok(markerAt < bodyAt, 'sample body renders below the marker');
});

// --- Header re-read: Docs JSON -> block schema (step 4, the crux) ---
// Synthetic documents.get() JSON so the parser is exercised without Google.

const reader = require('../src/destinations/docHeaderReader');
const { HEADER_BOUNDARY_MARKER } = require('../src/destinations/docHeaderSample');

function _tr(content, style) {
  return { textRun: { content, textStyle: style || {} } };
}
function _para({ named = 'NORMAL_TEXT', alignment = null, border = false, runs = [] } = {}) {
  const elements = runs.map((r) =>
    _tr(r.content, {
      ...(r.bold ? { bold: true } : {}),
      ...(r.fontSize ? { fontSize: { magnitude: r.fontSize, unit: 'PT' } } : {}),
    })
  );
  elements.push(_tr('\n', {}));
  const paragraphStyle = { namedStyleType: named };
  if (alignment) paragraphStyle.alignment = alignment;
  if (border) paragraphStyle.borderBottom = { width: { magnitude: 1, unit: 'PT' }, dashStyle: 'SOLID' };
  return { paragraph: { paragraphStyle, elements } };
}
function _cell(runs, named) {
  return { content: [_para({ named, runs })] };
}
function _emptyCell() {
  return { content: [_para({ runs: [] })] };
}
function _markerPara() {
  return _para({ alignment: 'CENTER', runs: [{ content: HEADER_BOUNDARY_MARKER, bold: true }] });
}
function _doc(content) {
  return { body: { content } };
}

test('reader: pairsFromRuns pairs regular-label + bold-value runs', () => {
  const pairs = reader.pairsFromRuns([
    { text: 'Date: ', bold: false },
    { text: '2026-07-05', bold: true },
    { text: '    Version: ', bold: false },
    { text: 'v1', bold: true },
  ]);
  assert.deepStrictEqual(pairs, [
    { label: 'Date', value: '2026-07-05' },
    { label: 'Version', value: 'v1' },
  ]);
});

test('reader: pairsFromText fallback when bold was stripped', () => {
  assert.deepStrictEqual(reader.pairsFromText('Date: 2026-07-05    Version: v1'), [
    { label: 'Date', value: '2026-07-05' },
    { label: 'Version', value: 'v1' },
  ]);
  // Prose with a colon is not a clean pair-line.
  assert.strictEqual(reader.pairsFromText('Note this is a long sentence, really'), null);
});

test('reader: text/heading header parses in order, stops at the marker', () => {
  const doc = _doc([
    _para({ named: 'HEADING_2', runs: [{ content: 'MC Creative' }] }),
    _para({ runs: [{ content: 'Project: ' }, { content: 'State of Support 2026', bold: true }] }),
    _para({
      runs: [
        { content: 'Date: ' },
        { content: '2026-07-05', bold: true },
        { content: '    Version: ' },
        { content: 'v1', bold: true },
      ],
    }),
    _para({ runs: [{ content: 'Writer: ' }, { content: 'Kyle Brintnall', bold: true }] }),
    _para({ border: true, runs: [] }),
    _markerPara(),
    // below the marker — must be ignored:
    _para({ named: 'HEADING_2', runs: [{ content: 'Campaign Summary' }] }),
  ]);
  const schema = reader.parseHeaderSchema(doc);
  assert.deepStrictEqual(
    schema.blocks.map((b) => b.type),
    ['heading', 'text', 'field_row', 'text', 'divider']
  );
  assert.deepStrictEqual(schema.blocks[0], { type: 'heading', text: 'MC Creative' });
  assert.strictEqual(schema.blocks[1].label, 'Project');
  assert.strictEqual(schema.blocks[1].value, 'State of Support 2026');
  assert.strictEqual(schema.blocks[2].fields.length, 2);
  assert.strictEqual(schema.blocks[2].fields[1].value, 'v1');
});

test('reader: table header parses cells (wordmark vs fields), no marker needed below', () => {
  const tableEl = {
    table: {
      columns: 2,
      tableStyle: {
        tableColumnProperties: [
          { width: { magnitude: 260, unit: 'PT' } },
          { width: { magnitude: 260, unit: 'PT' } },
        ],
      },
      tableRows: [
        {
          tableCells: [
            _cell([{ content: 'MC Creative', bold: true, fontSize: 32 }]),
            _cell([{ content: 'Product: ' }, { content: 'Agentforce Service', bold: true }]),
          ],
        },
        {
          tableCells: [
            _cell([{ content: 'Project: ' }, { content: 'State of Support 2026', bold: true }]),
            _emptyCell(),
          ],
        },
      ],
    },
  };
  const schema = reader.parseHeaderSchema(_doc([tableEl, _markerPara()]));
  assert.strictEqual(schema.blocks.length, 1);
  const t = schema.blocks[0];
  assert.strictEqual(t.type, 'table');
  assert.deepStrictEqual(t.table.colWidthsPt, [260, 260]);
  assert.strictEqual(t.table.rows[0][0].wordmark, 'MC Creative');
  assert.strictEqual(t.table.rows[0][1].fields[0].label, 'Product');
  assert.strictEqual(t.table.rows[0][1].fields[0].value, 'Agentforce Service');
  assert.strictEqual(t.table.rows[1][0].fields[0].value, 'State of Support 2026');
  assert.deepStrictEqual(t.table.rows[1][1], { fields: [] }); // empty cell
});

test('reader round-trip: parse -> renderHeader reproduces the header text', () => {
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const doc = _doc([
    _para({ named: 'HEADING_2', runs: [{ content: 'MC Creative' }] }),
    _para({ runs: [{ content: 'Project: ' }, { content: 'State of Support 2026', bold: true }] }),
    _para({
      runs: [
        { content: 'Date: ' },
        { content: '2026-07-05', bold: true },
        { content: '    Version: ' },
        { content: 'v1', bold: true },
      ],
    }),
    _markerPara(),
  ]);
  const schema = reader.parseHeaderSchema(doc);
  const b = new DocBuilder();
  b.renderHeader(schema);
  assert.ok(b.text.includes('MC Creative'));
  assert.ok(b.text.includes('Project: State of Support 2026'));
  assert.ok(b.text.includes('Date: 2026-07-05    Version: v1'));
  // No marker leaked into the reconstructed header.
  assert.ok(!b.text.includes('HEADER ENDS'));
});

test('reader: an inserted horizontalRule element becomes a divider block', () => {
  const hrPara = { paragraph: { paragraphStyle: {}, elements: [{ horizontalRule: {} }, _tr('\n', {})] } };
  const schema = reader.parseHeaderSchema(
    _doc([
      _para({ named: 'HEADING_2', runs: [{ content: 'Brand' }] }),
      hrPara,
      _markerPara(),
    ])
  );
  assert.deepStrictEqual(
    schema.blocks.map((b) => b.type),
    ['heading', 'divider']
  );
});

test('reader: an emptied label cell ("Product:") is a field, not a wordmark', () => {
  // Regression: a blank-for-human field whose value the user cleared leaves just
  // "Label:" — must parse as a field with an empty value, not a brand wordmark.
  assert.deepStrictEqual(reader.pairsFromText('Product:'), [{ label: 'Product', value: '' }]);

  const cell = reader.parseCell(_cell([{ content: 'Product:' }]));
  assert.ok(!('wordmark' in cell), 'not misread as a wordmark');
  assert.strictEqual(cell.fields.length, 1);
  assert.strictEqual(cell.fields[0].label, 'Product');
  assert.strictEqual(cell.fields[0].value, '');

  // A colon-less brand string still parses as a wordmark.
  const wm = reader.parseCell(_cell([{ content: 'SVC Creative', bold: true, fontSize: 32 }]));
  assert.strictEqual(wm.wordmark, 'SVC Creative');
});

// --- Gemini header extraction: normalize + best-effort (step 5) ---

test('normalizeHeaderSchema coerces loose Gemini JSON into a safe schema', () => {
  const { normalizeHeaderSchema, isValidHeaderSchema } = require('../src/destinations/docHeaderSchema');

  // Junk in -> empty (invalid) out, never throws.
  assert.deepStrictEqual(normalizeHeaderSchema(null), { version: 1, blocks: [] });
  assert.deepStrictEqual(normalizeHeaderSchema({ blocks: 'nope' }), { version: 1, blocks: [] });
  assert.strictEqual(isValidHeaderSchema(normalizeHeaderSchema({})), false);

  const raw = {
    blocks: [
      { type: 'heading', text: '  MC Creative  ' },
      { type: 'text', label: 'Project', value: 'X', fill: 'AUTO' }, // fill upper-cased
      { type: 'text', label: 'Product', fill: 'weird' }, // no value, bad fill -> blank
      { type: 'field_row', fields: [{ label: 'Date', value: '2026-07-05' }, { label: '', value: 'drop me' }] },
      { type: 'divider' },
      { type: 'bogus', text: 'skip' }, // unknown -> dropped
      { type: 'heading', text: '   ' }, // empty -> dropped
    ],
  };
  const s = normalizeHeaderSchema(raw);
  assert.deepStrictEqual(
    s.blocks.map((b) => b.type),
    ['heading', 'text', 'text', 'field_row', 'divider']
  );
  assert.strictEqual(s.blocks[0].text, 'MC Creative'); // trimmed
  assert.strictEqual(s.blocks[1].fill, 'auto'); // lower-cased
  assert.strictEqual(s.blocks[2].value, ''); // missing value -> ''
  assert.strictEqual(s.blocks[2].fill, 'blank'); // invalid fill -> blank
  assert.strictEqual(s.blocks[3].fields.length, 1); // label-less field dropped
});

test('normalizeHeaderSchema normalizes a table (wordmark, fields, widths, empty cell)', () => {
  const { normalizeHeaderSchema } = require('../src/destinations/docHeaderSchema');
  const s = normalizeHeaderSchema({
    blocks: [
      {
        type: 'table',
        table: {
          columns: 2,
          colWidthsPt: [260, 260],
          rows: [
            [{ wordmark: 'SVC Creative' }, { fields: [{ label: 'Product', value: '', fill: 'blank' }] }],
            [{ fields: [{ label: 'Writer', value: 'K', fill: 'auto' }] }, { fields: [] }],
          ],
        },
      },
    ],
  });
  const t = s.blocks[0];
  assert.strictEqual(t.type, 'table');
  assert.deepStrictEqual(t.table.colWidthsPt, [260, 260]);
  assert.strictEqual(t.table.rows[0][0].wordmark, 'SVC Creative');
  assert.strictEqual(t.table.rows[0][0].fill, 'static'); // wordmark defaults to static
  assert.deepStrictEqual(t.table.rows[1][1], { fields: [] }); // empty cell preserved
});

test('gemini.extractHeaderSchema is exposed and best-effort (null without a key)', async () => {
  const { extractHeaderSchema } = require('../src/services/gemini');
  assert.strictEqual(typeof extractHeaderSchema, 'function');
  assert.strictEqual(await extractHeaderSchema('', 'image/png'), null); // no data -> null
  if (!process.env.GEMINI_API_KEY) {
    assert.strictEqual(await extractHeaderSchema('ZmFrZQ==', 'image/png'), null); // no key -> null, no throw
  }
});

test('normalizeHeaderSchema strips a trailing colon from labels (renderer adds it)', () => {
  const { normalizeHeaderSchema } = require('../src/destinations/docHeaderSchema');
  const s = normalizeHeaderSchema({
    blocks: [
      { type: 'text', label: 'Task:', value: '', fill: 'blank' },
      { type: 'field_row', fields: [{ label: 'Date:', value: '2026-07-05', fill: 'auto' }] },
      { type: 'table', table: { columns: 1, rows: [[{ fields: [{ label: 'Writer :', value: 'K' }] }]] } },
    ],
  });
  assert.strictEqual(s.blocks[0].label, 'Task');
  assert.strictEqual(s.blocks[1].fields[0].label, 'Date');
  assert.strictEqual(s.blocks[2].table.rows[0][0].fields[0].label, 'Writer');
});

// --- Doc-header onboarding API (step 6a) ---

test('routes/headerTemplate loads and mounts as an express router', () => {
  const router = require('../src/routes/headerTemplate');
  assert.strictEqual(typeof router, 'function'); // an express Router is a function
  // The header routes are registered on it.
  const paths = (router.stack || []).map((l) => l.route && l.route.path).filter(Boolean);
  assert.ok(paths.includes('/api/header/extract'), 'extract route present');
  assert.ok(paths.includes('/api/header'), 'get/save route present');
});

test('server mounts the header-template router', () => {
  // Requiring server wiring would boot the app; instead assert the file wires it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(src.includes("require('./routes/headerTemplate')"), 'headerTemplate mounted in server.js');
});

test('settings.html wires the Doc Header setup UI (step 6b)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  assert.ok(html.includes('data-tab="header"'), 'Doc Header tab present');
  assert.ok(html.includes('id="panel-header"'), 'header panel present');
  assert.ok(html.includes('id="hdr-file"') && html.includes('accept=".jpg,.jpeg,.png,.webp"'), 'screenshot file input');
  assert.ok(html.includes("fetch('/api/header/extract'"), 'calls extract endpoint');
  assert.ok(html.includes("fetch('/api/header')"), 'loads current header');
  assert.ok(html.includes('hdrRenderPreview'), 'has a live preview renderer');
  assert.ok(html.includes("body: JSON.stringify({ schema: hdrSchema })"), 'saves the edited schema');
  // The panel is included in the tab-switch set.
  assert.ok(/\['voice', 'header', 'workspace', 'account'\]/.test(html), 'header in tab switch');
});

test('header table: an empty-value field emits NO bold run (no empty Docs range)', () => {
  const { renderCell, cellFillRequests } = require('../src/destinations/docHeaderTable');

  // renderCell: blank value -> label text present, but zero style runs.
  const cell = renderCell({ fields: [{ label: 'Product', value: '' }] });
  assert.strictEqual(cell.text, 'Product: ');
  assert.strictEqual(cell.styleRuns.length, 0);

  // A mixed cell: filled value keeps its bold run, empty one does not.
  const mixed = renderCell({ fields: [{ label: 'Date', value: '6/8/21' }, { label: 'Note', value: '' }] });
  assert.strictEqual(mixed.styleRuns.length, 1);
  assert.strictEqual(mixed.text.slice(mixed.styleRuns[0].start, mixed.styleRuns[0].start + mixed.styleRuns[0].len), '6/8/21');

  // cellFillRequests over a table with empty-value cells must never produce an
  // updateTextStyle whose range is empty (start === end) — the Docs API rejects it.
  const tableEl = { table: { tableRows: [[0, 0].map(function () { return { content: [{ startIndex: 5 }] }; })].map(function () {
    return { tableCells: [{ content: [{ startIndex: 5 }] }, { content: [{ startIndex: 40 }] }] };
  }) } };
  const schema = { columns: 2, rows: [[{ wordmark: 'MC Creative' }, { fields: [{ label: 'Product', value: '' }] }]] };
  const reqs = cellFillRequests(tableEl, schema);
  reqs.filter(function (r) { return r.updateTextStyle; }).forEach(function (r) {
    assert.ok(r.updateTextStyle.range.endIndex > r.updateTextStyle.range.startIndex, 'no empty-range updateTextStyle');
  });
});

// --- File-naming convention (§3, backend / 7a) ---

test('docNaming: segmentsFromSpans turns a selected span into a dynamic token', () => {
  const { segmentsFromSpans } = require('../src/destinations/docNaming');
  const typed = 'SVC: State of Service 2026_ Promo Copy';
  // Select "State of Service 2026" (one span) -> Campaign; rest stays static.
  const segs = segmentsFromSpans(typed, [{ start: 5, end: 26, token: 'campaign' }]);
  assert.deepStrictEqual(segs, [
    { type: 'static', text: 'SVC: ' },
    { type: 'dynamic', token: 'campaign' },
    { type: 'static', text: '_ Promo Copy' },
  ]);
});

test('docNaming: multiple spans, plus span at the very start, are handled', () => {
  const { segmentsFromSpans } = require('../src/destinations/docNaming');
  const typed = 'Campaign 2026 v1';
  const segs = segmentsFromSpans(typed, [
    { start: 0, end: 8, token: 'campaign' },   // "Campaign" at start
    { start: 9, end: 13, token: 'year' },      // "2026"
    { start: 14, end: 16, token: 'version' },  // "v1" at end
  ]);
  assert.deepStrictEqual(segs, [
    { type: 'dynamic', token: 'campaign' },
    { type: 'static', text: ' ' },
    { type: 'dynamic', token: 'year' },
    { type: 'static', text: ' ' },
    { type: 'dynamic', token: 'version' },
  ]);
  // overlapping / zero-length / bad-token spans are ignored
  assert.deepStrictEqual(segmentsFromSpans('abc', [{ start: 2, end: 1, token: 'date' }]), [
    { type: 'static', text: 'abc' },
  ]);
  assert.deepStrictEqual(segmentsFromSpans('abc', [{ start: 0, end: 2, token: 'bogus' }]), [
    { type: 'static', text: 'abc' },
  ]);
});

test('docNaming: applyNamingPattern preserves static verbatim, fills dynamic', () => {
  const { applyNamingPattern, SAMPLE_NAMING_PATTERN } = require('../src/destinations/docNaming');
  const out = applyNamingPattern(SAMPLE_NAMING_PATTERN, { campaign: 'State of Support 2026' });
  assert.strictEqual(out, 'SVC: State of Support 2026_ Promo Copy');
  // a missing token value -> empty, static preserved (no crash)
  assert.strictEqual(applyNamingPattern(SAMPLE_NAMING_PATTERN, {}), 'SVC: _ Promo Copy');
});

test('docNaming: validity + normalize (drop junk, keep whitespace static, merge)', () => {
  const { isValidNamingPattern, normalizeNamingPattern } = require('../src/destinations/docNaming');
  assert.strictEqual(isValidNamingPattern(null), false);
  assert.strictEqual(isValidNamingPattern({ segments: [] }), false);
  assert.strictEqual(isValidNamingPattern({ segments: [{ type: 'static', text: 'x' }] }), true);

  const norm = normalizeNamingPattern({
    segments: [
      { type: 'static', text: 'A' },
      { type: 'static', text: 'B' },          // merges with previous
      { type: 'dynamic', token: 'campaign' },
      { type: 'static', text: '' },           // dropped (empty)
      { type: 'dynamic', token: 'nope' },     // dropped (bad token)
      { type: 'weird' },                       // dropped
      { type: 'static', text: ' _ v' },        // whitespace kept
    ],
  });
  assert.deepStrictEqual(norm.segments, [
    { type: 'static', text: 'AB' },
    { type: 'dynamic', token: 'campaign' },
    { type: 'static', text: ' _ v' },
  ]);
});

test('makeTitle: default naming UNCHANGED when no pattern; pattern used when set', () => {
  // makeTitle isn't exported; exercise it through the pure naming path + assert
  // the default shape is what we still produce with no pattern.
  const { applyNamingPattern, isValidNamingPattern } = require('../src/destinations/docNaming');
  // No pattern -> invalid -> caller falls back to "YYYY-MM-DD — Title Case".
  assert.strictEqual(isValidNamingPattern(null), false);
  // A pattern with only a campaign span yields exactly the campaign value.
  const p = { version: 1, segments: [{ type: 'dynamic', token: 'campaign' }] };
  assert.strictEqual(applyNamingPattern(p, { campaign: 'Spring Launch' }), 'Spring Launch');
});

test('routes/headerTemplate exposes the naming endpoints', () => {
  const router = require('../src/routes/headerTemplate');
  const paths = (router.stack || []).map((l) => l.route && l.route.path).filter(Boolean);
  assert.ok(paths.includes('/api/naming'), 'naming get/save route present');
});

test('db exposes getNamingPattern/saveNamingPattern; no-DB is a safe no-op', async () => {
  const db = require('../src/db');
  assert.strictEqual(typeof db.getNamingPattern, 'function');
  assert.strictEqual(typeof db.saveNamingPattern, 'function');
  if (!process.env.DATABASE_URL) {
    assert.strictEqual(await db.getNamingPattern('T0B8LPRDKHR'), null);
    assert.strictEqual(await db.saveNamingPattern('T0B8LPRDKHR', { segments: [] }), false);
  }
});

test('settings.html wires the file-naming segment builder (step 7b)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  assert.ok(html.includes('id="naming-section"'), 'naming section present');
  assert.ok(html.includes('id="naming-segments"'), 'segment list container');
  assert.ok(html.includes('id="naming-add"'), 'add-segment button');
  assert.ok(html.includes('id="naming-preview"'), 'live preview element');
  assert.ok(html.includes("fetch('/api/naming')"), 'loads current pattern');
  assert.ok(html.includes("fetch('/api/naming', {"), 'saves the pattern');
  assert.ok(html.includes('namingBindDrag') && html.includes('setPointerCapture'), 'pointer-based drag reorder');
  assert.ok(html.includes('namingSyncFromDom'), 'order read from DOM after drag');
  // Save emits the same segment shape 7a consumes.
  assert.ok(/type: 'dynamic', token: s\.token/.test(html), 'dynamic segment shape');
  assert.ok(/type: 'static', text: s\.text \|\| ''/.test(html), 'static segment shape');
});

// --- Copy-review engine (8a) ---

test('copyReview: collects only non-empty copy fields', () => {
  const cr = require('../src/services/copyReview');
  const content = {
    assets: [
      { name: 'Paid Social', fields: [
        { fieldName: 'Headline', charMax: 70, copy: 'Ship faster.' },
        { fieldName: 'Body', charMax: 150, copy: '' },        // undrafted -> skip
        { fieldName: 'CTA', charMax: 20, notes: 'guidance', copy: '   ' }, // whitespace -> skip
      ] },
      { name: 'Email', fields: [{ fieldName: 'Subject', charMax: 50, copy: 'Your report is ready' }] },
    ],
  };
  const out = cr.collectCopyFields(content);
  assert.deepStrictEqual(out.map((f) => `${f.assetType}:${f.fieldName}`), ['Paid Social:Headline', 'Email:Subject']);
});

test('copyReview: qualitative status is supportive, never a grade', () => {
  const { qualitativeStatus } = require('../src/services/copyReview');
  assert.strictEqual(qualitativeStatus(0, 0), 'Nothing to review yet');
  assert.strictEqual(qualitativeStatus(0, 6), 'Looking strong ✨'); // all clean = silence
  assert.strictEqual(qualitativeStatus(1, 8), 'A few things to tighten');
  assert.ok(!/[A-F]\b|\d\/\d|score/i.test(qualitativeStatus(3, 6))); // no letter/number grade
});

test('copyReview: digest describes shape, not individual notes', () => {
  const { buildDigest } = require('../src/services/copyReview');
  assert.match(buildDigest([]), /to review yet/i);
  assert.match(buildDigest([{ assetType: 'A', fieldName: 'H', comment: null }]), /all clean/i);
  const d = buildDigest([
    { assetType: 'A', fieldName: 'H', comment: 'tighten' },
    { assetType: 'A', fieldName: 'B', comment: null },
  ]);
  assert.match(d, /1 clean, 1 with a note/);
});

test('copyReview.reconcileComments: preserve, respect-resolved, fix, add (6 rows)', () => {
  const { reconcileComments, fieldKey } = require('../src/services/copyReview');
  const F = (assetType, fieldName, copy) => ({ assetType, fieldName, copy });
  const k = fieldKey;

  // Six fields, one per decision-table row.
  const fields = [
    F('A', 'unchanged-flagged', 'copy U'),      // row: unchanged + existing unresolved → KEEP
    F('A', 'resolved-unchanged', 'copy R'),     // row: resolved + unchanged → RESPECT (no re-add)
    F('A', 'unchanged-new', 'copy N'),          // row: unchanged + no comment + verdict → ADD
    F('A', 'changed-fixed', 'copy X2'),         // row: changed + verdict null → REMOVE stale
    F('A', 'changed-still', 'copy Y2'),         // row: changed + verdict → REPLACE
    F('A', 'new-field', 'copy Z'),              // row: new field + verdict → ADD
  ];
  const priorFields = {
    [k('A', 'unchanged-flagged')]: { copy: 'copy U', comment: 'tighten U', resolved: false },
    [k('A', 'resolved-unchanged')]: { copy: 'copy R', comment: 'note R', resolved: false },
    [k('A', 'unchanged-new')]: { copy: 'copy N', comment: null, resolved: false },
    [k('A', 'changed-fixed')]: { copy: 'copy X1', comment: 'fix X', resolved: false },
    [k('A', 'changed-still')]: { copy: 'copy Y1', comment: 'fix Y', resolved: false },
    // new-field has no prior entry
  };
  const verdicts = [
    { assetType: 'A', fieldName: 'unchanged-flagged', comment: null }, // no-nag; comment must still be KEPT
    { assetType: 'A', fieldName: 'resolved-unchanged', comment: 'note R again' }, // must be IGNORED (dismissed)
    { assetType: 'A', fieldName: 'unchanged-new', comment: 'new material note' },
    { assetType: 'A', fieldName: 'changed-fixed', comment: null },
    { assetType: 'A', fieldName: 'changed-still', comment: 'still an issue' },
    { assetType: 'A', fieldName: 'new-field', comment: 'brand new' },
  ];
  const liveComments = [
    { id: 'c-U', content: 'tighten U', resolved: false, quote: 'copy U' },
    { id: 'c-R', content: 'note R', resolved: true, quote: 'copy R' },      // user resolved it
    { id: 'c-X', content: 'fix X', resolved: false, quote: 'copy X1' },     // anchored to OLD text
    { id: 'c-Y', content: 'fix Y', resolved: false, quote: 'copy Y1' },     // anchored to OLD text
  ];

  const r = reconcileComments({ fields, priorFields, verdicts, liveComments });

  // KEEP: unchanged flagged comment is neither deleted nor re-added.
  assert.ok(!r.toDelete.includes('c-U'), 'unchanged comment not deleted');
  assert.ok(!r.toAdd.some((a) => a.quote === 'copy U'), 'unchanged comment not re-added');

  // RESPECT RESOLVED: dismissed comment not deleted, not re-added despite a verdict.
  assert.ok(!r.toDelete.includes('c-R'), 'resolved comment not deleted');
  assert.ok(!r.toAdd.some((a) => a.quote === 'copy R'), 'resolved comment not resurrected');

  // ADD new note on unchanged copy.
  assert.ok(r.toAdd.some((a) => a.quote === 'copy N' && a.content === 'new material note'), 'new note added');

  // REMOVE stale on changed+fixed; nothing re-added there.
  assert.ok(r.toDelete.includes('c-X'), 'stale fixed comment removed');
  assert.ok(!r.toAdd.some((a) => a.quote === 'copy X2'), 'fixed field gets no new comment');

  // REPLACE on changed+still: delete old, add new anchored to new copy.
  assert.ok(r.toDelete.includes('c-Y'), 'stale still-issue comment removed');
  assert.ok(r.toAdd.some((a) => a.quote === 'copy Y2' && a.content === 'still an issue'), 're-flag anchored to new copy');

  // ADD on a brand-new field.
  assert.ok(r.toAdd.some((a) => a.quote === 'copy Z' && a.content === 'brand new'), 'new field flagged');

  // State persists resolved flag for the dismissed field.
  assert.strictEqual(r.nextState.fields[k('A', 'resolved-unchanged')].resolved, true);
  // Active results: dismissed + fixed count as clean; the other 4 carry notes.
  const active = r.results.filter((x) => x.comment).length;
  assert.strictEqual(active, 4, 'four active notes (kept U, new N, replaced Y, new Z)');
});

test('copyReview.reconcileComments: fixed field is removed even when the quote no longer matches', () => {
  // Repro of the bug: user fixed the copy, so the live comment's quotedFileContent
  // (read back from Drive) equals NEITHER the new copy nor the stored priorCopy —
  // Google orphaned the anchor. Content-matching must still find + delete it.
  const { reconcileComments, fieldKey } = require('../src/services/copyReview');
  const key = fieldKey('A', 'f');
  const fields = [{ assetType: 'A', fieldName: 'f', copy: 'the fixed, better copy' }];
  const priorFields = { [key]: { copy: 'the old flawed copy', comment: 'tighten this', resolved: false } };
  const verdicts = [{ assetType: 'A', fieldName: 'f', comment: null }]; // Gemini: fixed
  const liveComments = [
    // Quote is stale/garbled (neither cur nor priorCopy); content is intact.
    { id: 'c-stale', content: 'tighten this', resolved: false, quote: 'old fla' },
  ];
  const r = reconcileComments({ fields, priorFields, verdicts, liveComments });
  assert.deepStrictEqual(r.toDelete, ['c-stale'], 'stale comment found via content and deleted');
  assert.strictEqual(r.toAdd.length, 0, 'nothing re-added for a fixed field');
  assert.strictEqual(r.nextState.fields[key].comment, null, 'state cleared for fixed field');
});

test('copyReview.reconcileComments: persisted dismissal survives a vanished comment', () => {
  const { reconcileComments, fieldKey } = require('../src/services/copyReview');
  // Copy unchanged, previously resolved, but the resolved comment is gone from Drive.
  const fields = [{ assetType: 'A', fieldName: 'f', copy: 'same copy' }];
  const priorFields = { [fieldKey('A', 'f')]: { copy: 'same copy', comment: 'old', resolved: true } };
  const verdicts = [{ assetType: 'A', fieldName: 'f', comment: 'would re-flag' }];
  const r = reconcileComments({ fields, priorFields, verdicts, liveComments: [] });
  assert.strictEqual(r.toAdd.length, 0, 'persisted dismissal blocks re-adding');
  assert.strictEqual(r.nextState.fields[fieldKey('A', 'f')].resolved, true);
});

test('siblingContextBlock: context from non-empty siblings, else empty (cohesion recovery)', () => {
  const { siblingContextBlock } = require('../src/services/gemini');
  assert.strictEqual(siblingContextBlock(), '');
  assert.strictEqual(siblingContextBlock([]), '');
  assert.strictEqual(siblingContextBlock([{ fieldName: 'H', copy: '   ' }]), '');
  const b = siblingContextBlock([
    { fieldName: 'Headline', copy: 'Ship faster.' },
    { fieldName: 'CTA', copy: 'Get started' },
  ]);
  assert.match(b, /Headline: Ship faster\./);
  assert.match(b, /CTA: Get started/);
  assert.match(b, /do NOT rewrite/i); // siblings are context only
});

test('selective regen (Phase 1): scopedFields threaded route -> adapter -> pipeline -> destination', () => {
  const rd = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const route = rd('src/routes/app.js');
  assert.ok(/body\.scopedFields/.test(route), 'route reads body.scopedFields');
  assert.ok(/runWebDraft\(docId, tenantContext, direction/.test(route), 'route passes scopedFields to runWebDraft');
  assert.ok(/runWebDraft\(docId, tenantContext = \{\}, direction, scopedFields(, append)?\)/.test(rd('src/adapters/web.js')), 'adapter accepts scopedFields');
  assert.ok(/generateDraft\(docId, direction, clients, tenantId, scopedFields(, append)?\)/.test(rd('src/core/pipeline.js')), 'pipeline accepts scopedFields');
  const gd = rd('src/destinations/googleDocs.js');
  assert.ok(/generateDraft\(id, direction, clients, voiceGuide, lookupDirection, scopedFields(, append)?\)/.test(gd), 'destination accepts scopedFields');
  assert.ok(!/lookupDirection, targets\)/.test(gd), 'no bare `targets` param (avoids assetTargets collision)');
  assert.ok(/scopeKeys/.test(gd) && /generateFieldDraft\(/.test(gd), 'destination scoped branch uses per-field generator');
  // Sibling copy is read BEFORE the delete phase (the getDocContent sibling read
  // precedes generateDraft's "delete existing copy" phase in source order).
  const idxSibling = gd.indexOf('scoped sibling-copy read');
  const idxDelete = gd.indexOf('delete existing copy');
  assert.ok(idxSibling > -1 && idxDelete > -1 && idxSibling < idxDelete, 'siblings read before delete phase');
});

test('structural guard: every gemini function googleDocs calls is actually imported', () => {
  // Regression guard for the class of bug where generateFieldDraft was CALLED in
  // the scoped path but never imported — a missing import throws only at runtime
  // (when the function is called), so the suite (which never drives a scoped op
  // with real Google clients) couldn't catch it. This checks it statically: any
  // gemini export called by name in googleDocs.js must be in its import list.
  const gemini = require('../src/services/gemini');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'destinations', 'googleDocs.js'), 'utf8');

  const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]\.\.\/services\/gemini['"]\)/);
  assert.ok(m, 'googleDocs imports from services/gemini');
  const imported = new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean));

  const geminiFns = Object.keys(gemini).filter((k) => typeof gemini[k] === 'function');
  for (const fn of geminiFns) {
    // Called as `fn(` but not as `x.fn(` and not part of a longer identifier.
    const calledByName = new RegExp('(?<![\\w.])' + fn + '\\s*\\(').test(src);
    const definedLocally = new RegExp('function\\s+' + fn + '\\s*\\(').test(src);
    if (calledByName && !definedLocally) {
      assert.ok(imported.has(fn), `googleDocs calls ${fn}() but does not import it from services/gemini`);
    }
  }

  // Belt-and-suspenders for the generateDraft paths: whole-doc batch, scoped
  // single-field, and scoped variations (Phase 2/3).
  assert.ok(imported.has('generateAssetDrafts'), 'generateAssetDrafts imported (whole-doc path)');
  assert.ok(imported.has('generateFieldDraft'), 'generateFieldDraft imported (scoped path)');
  assert.ok(imported.has('generateFieldVariations'), 'generateFieldVariations imported (variations path)');
  assert.strictEqual(typeof gemini.generateAssetDrafts, 'function', 'gemini exports generateAssetDrafts');
  assert.strictEqual(typeof gemini.generateFieldDraft, 'function', 'gemini exports generateFieldDraft');
  assert.strictEqual(typeof gemini.generateFieldVariations, 'function', 'gemini exports generateFieldVariations');
});

test('selective regen (Phase 1): multi-select + dynamic button in the shared UI', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(/selectedFields/.test(html) && /toggleFieldSelection/.test(html), 'selection state present');
  assert.ok((html.match(/selectable: true/g) || []).length >= 2, 'both project view + Copy Done renderers are selectable');
  assert.ok(/Generate Selected \(/.test(html) && /Regenerate Selected \(/.test(html), 'dynamic scoped button labels');
  assert.ok(/body\.scopedFields = scopedFields/.test(html), 'draftFetch sends scopedFields');
});

// --- Phase 2/3: conceptual variations (doorways) ----------------------------

test('variations (P3): assignDoorways is deterministic, distinct at explore/wide, obvious at close', () => {
  const { assignDoorways } = require('../src/services/gemini');

  // Stay close → the one obvious doorway, repeated (N executions of one angle).
  assert.deepStrictEqual(assignDoorways('Headline', 'close', 3), ['Outcome', 'Outcome', 'Outcome']);
  assert.deepStrictEqual(assignDoorways('Headline', 'close', 1), ['Outcome']);

  // Explore/Roam-wide → N DISTINCT doorways.
  for (const distance of ['explore', 'wide']) {
    for (const count of [2, 3, 4]) {
      const got = assignDoorways('Headline', distance, count);
      assert.strictEqual(got.length, count, `${distance} x${count} returns count`);
      assert.strictEqual(new Set(got).size, count, `${distance} x${count} doorways are distinct`);
    }
  }

  // Distance applies at count=1: explore = nearest non-obvious, wide = far band.
  assert.deepStrictEqual(assignDoorways('Headline', 'explore', 1), ['Pain']); // rank[1]
  assert.deepStrictEqual(assignDoorways('Headline', 'wide', 1), ['Contrast']); // rank[4]

  // Field-type aware: CTA has its own ranking (rank[4] = Proof at wide x1).
  assert.deepStrictEqual(assignDoorways('CTA Text (Offer 1)', 'wide', 1), ['Proof']);

  // Deterministic — same inputs, same output.
  assert.deepStrictEqual(assignDoorways('Body', 'wide', 3), assignDoorways('Body', 'wide', 3));

  // Roam-wide always includes the farthest doorway, Reframe, when count reaches it.
  assert.ok(assignDoorways('Headline', 'wide', 3).includes('Reframe'));
});

test('variations (P3): buildVariationsPrompt assigns each row an explicit doorway', () => {
  const { buildVariationsPrompt } = require('../src/services/gemini');
  const prompt = buildVariationsPrompt({
    assetType: 'Email', fieldName: 'Headline', charMax: 50, summary: 'S', writerPrompt: 'W',
    voiceGuide: '', doorways: ['Pain', 'Proof', 'Reframe'], distance: 'wide',
  });
  // Each numbered row names its exact doorway (never "give me N different versions").
  assert.ok(/\n1\. \(Pain\) —/.test(prompt), 'row 1 assigned Pain');
  assert.ok(/\n2\. \(Proof\) —/.test(prompt), 'row 2 assigned Proof');
  assert.ok(/\n3\. \(Reframe\) —/.test(prompt), 'row 3 assigned Reframe');
  // All seven doorway definitions are present.
  for (const d of ['Pain', 'Outcome', 'Contrast', 'Question', 'Proof', 'Identity', 'Reframe']) {
    assert.ok(prompt.includes('- ' + d + ':'), 'defines doorway ' + d);
  }
  // The value prop from the brief is the reference point.
  assert.ok(/THE VALUE PROP \(from the campaign brief\)/.test(prompt), 'value prop is the reference');
  assert.ok(/JSON array of exactly 3 objects/.test(prompt), 'asks for N JSON objects');

  // Stay close (all one door) adds the "N distinct executions of one angle" line.
  const close = buildVariationsPrompt({
    assetType: 'Email', fieldName: 'Headline', charMax: 50, summary: 'S', writerPrompt: 'W',
    voiceGuide: '', doorways: ['Outcome', 'Outcome'], distance: 'close',
  });
  assert.ok(/DIFFERENT executions of that one angle/.test(close), 'close = same door, distinct executions');

  // Wide regeneration injects the "go somewhere the current copy didn't" line.
  const wideRegen = buildVariationsPrompt({
    assetType: 'Email', fieldName: 'Headline', charMax: 50, summary: 'S', writerPrompt: 'W',
    voiceGuide: '', doorways: ['Reframe'], distance: 'wide', currentCopy: 'Old angle here.',
  });
  assert.ok(/roam wide.*REGENERATION/s.test(wideRegen) && /Old angle here\./.test(wideRegen), 'wide regen avoids current angle');
});

test('variations (P2/P3): buildVariantBlock marks number iff count>1, label iff distance!=close', () => {
  const { buildVariantBlock } = require('../src/destinations/googleDocs');

  // close x1 → bare copy, identical to a Phase-1 draft (no marker at all).
  assert.strictEqual(
    buildVariantBlock([{ doorway: 'Outcome', copy: 'Ship faster.' }], { distance: 'close', charMax: 50 }),
    'Ship faster.'
  );
  // explore/wide x1 → labeled, NO number (already resolved).
  assert.strictEqual(
    buildVariantBlock([{ doorway: 'Reframe', copy: 'What if?' }], { distance: 'wide', charMax: 50 }),
    '(Reframe) What if?'
  );
  // close xN → numbered, NO labels.
  assert.strictEqual(
    buildVariantBlock([{ doorway: 'Outcome', copy: 'A' }, { doorway: 'Outcome', copy: 'B' }], { distance: 'close', charMax: 50 }),
    '1. A\n2. B'
  );
  // explore/wide xN → numbered AND labeled.
  assert.strictEqual(
    buildVariantBlock([{ doorway: 'Pain', copy: 'A' }, { doorway: 'Proof', copy: 'B' }], { distance: 'wide', charMax: 50 }),
    '1. (Pain) A\n2. (Proof) B'
  );
  // Long fields separate stacked options with a blank line.
  assert.strictEqual(
    buildVariantBlock([{ doorway: 'Pain', copy: 'A' }, { doorway: 'Proof', copy: 'B' }], { distance: 'wide', charMax: 400 }),
    '1. (Pain) A\n\n2. (Proof) B'
  );
  // Empty / whitespace variations are dropped (never insert an empty marker line).
  assert.strictEqual(buildVariantBlock([{ doorway: 'Pain', copy: '   ' }], { distance: 'wide' }), '');
});

// --- Variations Matrix, Step 3a: the "Riff N" HEADING_6 batch header ----------
// The header is a structural divider above an appended batch. The parser guard is
// the paragraph's namedStyleType (HEADING_6), NOT its text — so even a header that
// reads like an option can never be parsed as copy. These tests pin: (1) the
// header is never read as a field or a copy option, (2) getDocContent excludes it,
// (3) a re-riff numbers max+1 (gap-safe), (4) a destructive-regen delete range
// spans the headers so the whole stack is wiped.

// Build a synthetic Google-Docs doc: each paragraph carries start/endIndex, a
// namedStyleType, and a textRun with its bold/italic style. Body starts at 1 and
// every paragraph includes its trailing "\n". Shared by the four matrix tests.
function makeMatrixDoc(paras) {
  let idx = 1;
  const content = paras.map((para) => {
    const raw = (para.text || '') + '\n';
    const startIndex = idx;
    const endIndex = idx + raw.length;
    idx = endIndex;
    return {
      startIndex,
      endIndex,
      paragraph: {
        paragraphStyle: para.style ? { namedStyleType: para.style } : {},
        elements: [{ textRun: { content: raw, textStyle: { bold: !!para.bold, italic: !!para.italic } } }],
      },
    };
  });
  return { body: { content } };
}

test('matrix 3a: a "Riff N" HEADING_6 header is never parsed as a field or copy option', () => {
  const { parseDoc, getDocContent } = require('../src/destinations/googleDocs');

  const paras = [
    { text: 'Campaign Summary', style: 'HEADING_2' },
    { text: 'the summary', italic: true },
    { text: 'Writer Direction', style: 'HEADING_2' },
    { text: 'the direction', italic: true },
    { text: 'Email', style: 'HEADING_3' },
    { text: 'Paid · warm', italic: true }, //          asset direction line
    { text: 'Headline [50]', bold: true }, //          field label (para 6)
    { text: 'Original seed line' }, //                 seed copy (para 7)
    { text: 'Riff 1', style: 'HEADING_6' }, //         batch header (para 8) — NOT copy
    { text: '1. (Pain) Drowning in tickets' }, //      option (para 9)
    { text: '2. (Reframe) Not a cost center' }, //     option (para 10, last non-empty)
    { text: '' }, //                                    trailing blank (para 11)
  ];
  const doc = makeMatrixDoc(paras);
  const c = doc.body.content;
  const { assets } = parseDoc(doc);

  // Exactly ONE field recovered — the header did not spawn a phantom "Riff 1" field.
  assert.strictEqual(assets.length, 1);
  assert.strictEqual(assets[0].fields.length, 1, 'header never creates a field');
  const field = assets[0].fields[0];
  assert.strictEqual(field.fieldName, 'Headline');

  // The header did NOT reset the field: options below it still belong to the field,
  // so deleteEnd reaches the LAST option (para 10), spanning the header (para 8).
  assert.strictEqual(field.deleteEnd, c[10].endIndex, 'delete range reaches the last option');
  assert.ok(field.deleteEnd > c[8].endIndex, 'delete range spans the Riff 1 header');

  // getDocContent excludes the header from copy (seed + both options, no "Riff 1").
  const doc2 = makeMatrixDoc(paras);
  // getDocContent is async and reads via a docs client; stub one that returns our doc.
  const clients = { docs: { documents: { get: async () => ({ data: doc2 }) } } };
  return getDocContent('doc-id', clients).then((content) => {
    const cf = content.assets[0].fields[0];
    assert.strictEqual(
      cf.copy,
      'Original seed line\n1. (Pain) Drowning in tickets\n2. (Reframe) Not a cost center',
      'header excluded from copy'
    );
    assert.ok(!/Riff\s*1/.test(cf.copy), '"Riff 1" never appears in field copy');
  });
});

test('matrix 3a: parseDoc records maxRiffN so a re-riff numbers batch max+1', () => {
  const { parseDoc } = require('../src/destinations/googleDocs');

  const paras = [
    { text: 'Email', style: 'HEADING_3' },
    { text: 'Headline [50]', bold: true },
    { text: 'Original seed line' },
    { text: 'Riff 1', style: 'HEADING_6' },
    { text: '1. (Pain) A' },
    { text: 'Riff 2', style: 'HEADING_6' },
    { text: '1. (Reframe) B' },
    { text: '' },
  ];
  const field = parseDoc(makeMatrixDoc(paras)).assets[0].fields[0];
  assert.strictEqual(field.maxRiffN, 2, 'highest existing Riff batch number');
  assert.strictEqual((field.maxRiffN || 0) + 1, 3, 'next riff is 3');
});

test('matrix 3a: max+1 is gap-safe — Riff 1 + Riff 3 (no Riff 2) → next is 4, not 3', () => {
  const { parseDoc } = require('../src/destinations/googleDocs');

  // Simulates a writer manually deleting the Riff 2 block. Counting headers would
  // give 2 → next 3, colliding with the surviving Riff 3. max+1 gives 4.
  const paras = [
    { text: 'Email', style: 'HEADING_3' },
    { text: 'Headline [50]', bold: true },
    { text: 'Original seed line' },
    { text: 'Riff 1', style: 'HEADING_6' },
    { text: '1. (Pain) A' },
    { text: 'Riff 3', style: 'HEADING_6' },
    { text: '1. (Reframe) C' },
    { text: '' },
  ];
  const field = parseDoc(makeMatrixDoc(paras)).assets[0].fields[0];
  assert.strictEqual(field.maxRiffN, 3, 'max of existing Riff numbers');
  assert.strictEqual((field.maxRiffN || 0) + 1, 4, 'next riff avoids colliding with Riff 3');
});

test('matrix 3a: destructive-regen delete range spans every Riff header in the stack', () => {
  const { parseDoc } = require('../src/destinations/googleDocs');

  const paras = [
    { text: 'Email', style: 'HEADING_3' },
    { text: 'Headline [50]', bold: true }, //   field label (para 1)
    { text: 'Original seed line' }, //          seed (para 2)
    { text: 'Riff 1', style: 'HEADING_6' }, //  header (para 3)
    { text: '1. (Pain) A' }, //                 option (para 4)
    { text: '2. (Proof) B' }, //                option (para 5)
    { text: 'Riff 2', style: 'HEADING_6' }, //  header (para 6)
    { text: '1. (Reframe) C' }, //              option (para 7, last non-empty)
    { text: '' }, //                            trailing blank (para 8)
  ];
  const doc = makeMatrixDoc(paras);
  const c = doc.body.content;
  const field = parseDoc(doc).assets[0].fields[0];

  // insertIndex = end of the label; deleteEnd = end of the LAST option. The single
  // [insertIndex, deleteEnd] range therefore covers both Riff headers (para 3 + 6)
  // and every option, so a destructive Regenerate wipes the whole stack cleanly.
  assert.strictEqual(field.insertIndex, c[1].endIndex);
  assert.strictEqual(field.deleteEnd, c[7].endIndex, 'delete range reaches the last option');
  assert.ok(field.deleteEnd > c[3].endIndex && field.deleteEnd > c[6].endIndex, 'range spans both headers');
  assert.ok(field.insertIndex < c[3].startIndex, 'range starts above the first header');
});

test('variant review: singles vs stacks are routed apart; solo label stripped; resolved re-collects', () => {
  const { collectCopyFields, collectVariationStacks } = require('../src/services/copyReview');
  const { isNumberedStack } = require('../src/utils/variants');

  const stack = '1. (Pain) Drowning in tickets\n2. (Proof) 40% faster\n3. (Reframe) Not a cost center';
  const solo = '(Reframe) What if support wasn\'t a cost center?';
  const plain = 'Resolve tickets faster with AI.';
  assert.ok(isNumberedStack(stack) && !isNumberedStack(solo) && !isNumberedStack(plain));

  const content = { assets: [{ name: 'Email', fields: [
    { fieldName: 'H1', charMax: 50, copy: stack },
    { fieldName: 'H2', charMax: 50, copy: solo },
    { fieldName: 'H3', charMax: 50, copy: plain },
  ] }] };

  // collectCopyFields = SINGLE fields only (stacks route to the variant path).
  const singles = collectCopyFields(content).map((f) => f.fieldName);
  assert.deepStrictEqual(singles, ['H2', 'H3'], 'stack routed out; solo + plain are singles');

  // The numbered stack is collected for the variant path with its options parsed.
  const stacks = collectVariationStacks(content);
  assert.strictEqual(stacks.length, 1, 'one stack collected');
  assert.strictEqual(stacks[0].fieldName, 'H1');
  assert.deepStrictEqual(stacks[0].variations.map((v) => v.doorway), ['Pain', 'Proof', 'Reframe']);
  assert.strictEqual(stacks[0].variations[1].copy, '40% faster', 'variation copy = marker stripped');
  assert.strictEqual(stacks[0].variations[1].line, '2. (Proof) 40% faster', 'variation line kept for anchoring');

  // Solo variation reviewed as a single, doorway tag stripped for length/voice.
  assert.strictEqual(collectCopyFields(content)[0].copy, 'What if support wasn\'t a cost center?');

  // Resolved down to one line → it's a single again, no stack.
  const resolved = { assets: [{ name: 'Email', fields: [{ fieldName: 'H1', charMax: 50, copy: 'Drowning in tickets' }] }] };
  assert.deepStrictEqual(collectCopyFields(resolved).map((f) => f.fieldName), ['H1']);
  assert.strictEqual(collectVariationStacks(resolved).length, 0);
});

test('variant review: parseNumberedStack handles labeled, unlabeled, and non-option lines', () => {
  const { parseNumberedStack } = require('../src/utils/variants');
  // Labeled (explore/wide) stack.
  const labeled = parseNumberedStack('1. (Pain) A hurts\n2. (Reframe) B reframed');
  assert.deepStrictEqual(labeled, [
    { index: 1, doorway: 'Pain', copy: 'A hurts', line: '1. (Pain) A hurts' },
    { index: 2, doorway: 'Reframe', copy: 'B reframed', line: '2. (Reframe) B reframed' },
  ]);
  // Stay-close stack: numbered, NO doorway label → doorway null (craft-only later).
  const close = parseNumberedStack('1. First take\n2. Second take');
  assert.deepStrictEqual(close.map((v) => v.doorway), [null, null]);
  assert.strictEqual(close[0].copy, 'First take');
});

test('variant review: prompt names each doorway, includes fit guide + two-axis output', () => {
  const { buildVariantReviewPrompt, DOORWAY_FIT_GUIDE } = require('../src/services/gemini');
  const prompt = buildVariantReviewPrompt({
    assetType: 'Organic Social — LinkedIn', fieldName: 'Graphic Headline', charMax: 70,
    voiceGuide: '', briefContext: { summary: 'Resolve AI for CX leaders', writerDirection: 'Avoid hype' },
    variations: [
      { index: 1, doorway: 'Contrast', copy: 'Support used to mean more tickets.' },
      { index: 2, doorway: 'Question', copy: 'What if 40% never reached a human?' },
    ],
  });
  // Strategy-first, two-axis, no-winner framing.
  assert.ok(/STRATEGY FIRST, THEN CRAFT/.test(prompt), 'assesses strategy then craft');
  assert.ok(/do NOT pick a winner/i.test(prompt), 'does not choose for the writer');
  // Each option's assigned doorway is in the prompt; the fit guide is present.
  assert.ok(/"doorway": "Contrast"/.test(prompt) && /"doorway": "Question"/.test(prompt), 'options carry doorways');
  assert.ok(DOORWAY_FIT_GUIDE.length >= 7 && /Proof \(a number\/claim\).*RISKY top-of-funnel/s.test(prompt), 'doorway-fit guide present');
  // Materiality: most options null; per-axis nullable output.
  assert.ok(/MOST options\s+come back clean/s.test(prompt), 'materiality: most come back clean');
  assert.ok(/"strategy": string\|null, "craft": string\|null/.test(prompt), 'two-axis nullable output');
  // Funnel-stage inference is instructed.
  assert.ok(/Infer the FUNNEL STAGE/.test(prompt), 'infers funnel stage');
});

test('variant review: reconcile exposes claimedIds for the orphan sweep', () => {
  const { reconcileComments } = require('../src/services/copyReview');
  // A live comment bound to no current unit (its stack option was resolved away)
  // must NOT appear in claimedIds → the runner sweeps it.
  const out = reconcileComments({
    fields: [{ assetType: 'Email', fieldName: 'H3', copy: 'Resolve tickets faster.' }],
    priorFields: {},
    verdicts: [],
    liveComments: [{ id: 'orphan1', content: '🪶 Quillio Review — stale', resolved: false, quote: '2. (Proof) gone now' }],
  });
  assert.ok(Array.isArray(out.claimedIds), 'claimedIds returned');
  assert.ok(!out.claimedIds.includes('orphan1'), 'unmatched comment is not claimed (will be swept)');
});

// --- Scoped review -----------------------------------------------------------

test('scoped review: selectReviewTargets picks only selected fields, attaches siblings', () => {
  const { selectReviewTargets, fieldKey } = require('../src/services/copyReview');
  const content = { assets: [{ name: 'Email', fields: [
    { fieldName: 'Headline', charMax: 60, copy: 'Ship faster.' },
    { fieldName: 'Subhead', charMax: 80, copy: '(Reframe) Support is a design problem.' },
    { fieldName: 'CTA', charMax: 20, copy: '1. (Outcome) Get started\n2. (Identity) Join builders' },
  ] }] };

  // Whole-doc: every unit, no siblings, not scoped.
  const whole = selectReviewTargets(content, null);
  assert.strictEqual(whole.scoped, false);
  assert.deepStrictEqual(whole.singles.map((f) => f.fieldName), ['Headline', 'Subhead']);
  assert.deepStrictEqual(whole.stacks.map((s) => s.fieldName), ['CTA']);
  assert.ok(whole.singles.every((f) => !f.siblings), 'whole-doc has no sibling context');

  // Scoped to Headline + CTA: only those; each carries its asset siblings.
  const scopeKeys = new Set([fieldKey('Email', 'Headline'), fieldKey('Email', 'CTA')]);
  const scoped = selectReviewTargets(content, scopeKeys);
  assert.strictEqual(scoped.scoped, true);
  assert.deepStrictEqual(scoped.singles.map((f) => f.fieldName), ['Headline'], 'only selected single');
  assert.deepStrictEqual(scoped.stacks.map((s) => s.fieldName), ['CTA'], 'only selected stack');
  assert.deepStrictEqual(scoped.singles[0].siblings.map((s) => s.fieldName), ['Subhead', 'CTA'], 'Headline sees its siblings');
  // Sibling copy strips a solo doorway label (context = the sentence).
  const subSib = scoped.singles[0].siblings.find((s) => s.fieldName === 'Subhead');
  assert.strictEqual(subSib.copy, 'Support is a design problem.');
});

test('scoped review: orphan sweep never touches an UNSELECTED field\'s prior comment', () => {
  const { orphanSweepIds, keyInScope, fieldKey } = require('../src/services/copyReview');
  const scopeKeys = new Set([fieldKey('Email', 'Headline')]);
  const priorFields = {
    [fieldKey('Email', 'Subhead')]: { copy: 'x', comment: 'Reframe is hypey here.', resolved: false },
    [fieldKey('Email', 'Headline')]: { copy: 'y', comment: 'Weak verb.', resolved: false },
  };
  const live = [
    { id: 'c_subhead', content: 'Reframe is hypey here.', resolved: false, quote: 'x' },
    { id: 'c_headline', content: 'Weak verb.', resolved: false, quote: 'y' },
  ];
  // Scoped run of Headline; Subhead's comment is unclaimed but OUT of scope → kept.
  const scopedSweep = orphanSweepIds({ liveComments: live, claimedIds: ['c_headline'], toDelete: [], scopeKeys, priorFields });
  assert.deepStrictEqual(scopedSweep, [], 'unselected Subhead comment is preserved');
  // Whole-doc would sweep the same unclaimed comment.
  const wholeSweep = orphanSweepIds({ liveComments: live, claimedIds: ['c_headline'], toDelete: [], scopeKeys: null, priorFields });
  assert.deepStrictEqual(wholeSweep, ['c_subhead'], 'whole-doc sweeps a true orphan');
  // A selected field's own variation key IS in scope (its resolved-away comment can be swept).
  assert.ok(keyInScope(fieldKey('Email', 'Headline') + ' · option 2 (proof)', scopeKeys));
  assert.ok(!keyInScope(fieldKey('Email', 'Subhead'), scopeKeys));
});

test('scoped review: field-review prompt gets asset context + tight cross-field flag', () => {
  const { CROSS_FIELD_FLAG_RULE } = require('../src/services/gemini');
  const gemini = require('../src/services/gemini');
  // reviewCopyFields builds its prompt internally; assert the flag rule wording is
  // interaction-only (not general sibling critique), and is exported for reuse.
  const rule = CROSS_FIELD_FLAG_RULE.join('\n');
  assert.ok(/duplication \/ redundancy \(the sibling makes the SAME point\)/.test(rule), 'fires on duplication');
  assert.ok(/Do NOT flag a sibling's STANDALONE craft problem/.test(rule), 'not general sibling critique');
  assert.ok(/Also worth a look:/.test(rule), 'appends the flag clause');
  assert.strictEqual(typeof gemini.reviewCopyFields, 'function');
});

test('scoped review: variant prompt adds sibling context + a flag axis; non-scoped omits it', () => {
  const { buildVariantReviewPrompt } = require('../src/services/gemini');
  const base = { assetType: 'Email', fieldName: 'CTA', charMax: 20, voiceGuide: '', briefContext: {},
    variations: [{ index: 1, doorway: 'Outcome', copy: 'Get started' }, { index: 2, doorway: 'Identity', copy: 'Join builders' }] };

  const plain = buildVariantReviewPrompt(base);
  assert.ok(!/ASSET CONTEXT/.test(plain), 'no sibling block without siblings');
  assert.ok(!/"flag": string\|null/.test(plain), 'no flag axis without siblings');

  const scoped = buildVariantReviewPrompt({ ...base, siblings: [{ fieldName: 'Headline', copy: 'Join the builders shipping faster.' }] });
  assert.ok(/ASSET CONTEXT/.test(scoped) && /Headline: Join the builders/.test(scoped), 'sibling context present');
  assert.ok(/"flag": string\|null/.test(scoped), 'flag axis in scoped output');
  assert.ok(/COMMENT ONLY on the options below, never on a\s+sibling/.test(scoped), 'comment-only rule');
});

test('scoped review: threaded route -> adapter, sent from UI, dynamic Review button', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  assert.ok(/api\/review[\s\S]*?body\.scopedFields/.test(route), 'review route reads scopedFields');
  assert.ok(/runWebReview\(docId, tenantContext, scoped \? scopedFields : undefined\)/.test(route), 'route threads scopedFields');
  const web = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'web.js'), 'utf8');
  assert.ok(/runWebReview\(docId, tenantContext = \{\}, scopedFields\)/.test(web) && /runCopyReview\(docId, tenantId, clients, scopedFields\)/.test(web), 'adapter threads scopedFields');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(/function reviewFetch\(docId, scopedFields\)/.test(html) && /body\.scopedFields = scopedFields/.test(html), 'reviewFetch sends scopedFields');
  assert.ok(/selectedScopedFields\(\); \/\/ scoped review/.test(html), 'review runner reads the selection');
  assert.ok(/Review Selected \(/.test(html), 'dynamic Review Selected (N) label');
});

test('variations (P1 regression): count=1 + close routes to the unchanged per-field generator', () => {
  const gd = fs.readFileSync(path.join(__dirname, '..', 'src', 'destinations', 'googleDocs.js'), 'utf8');
  // The scoped loop branches on count/distance: variations only when count>1 OR distance!=close.
  assert.ok(/meta\.count > 1 \|\| meta\.distance !== 'close'/.test(gd), 'routes to variations only above defaults');
  assert.ok(/generateFieldVariations\(/.test(gd) && /generateFieldDraft\(/.test(gd), 'both generators wired in scoped branch');
  assert.ok(/buildVariantBlock\(/.test(gd), 'variations are stacked via buildVariantBlock');
});

// --- Variations Matrix Step 1: append write path ----------------------------

test('append: buildVariantBlock startIndex force-numbers a batch from 1; omitted = today', () => {
  const { buildVariantBlock } = require('../src/destinations/googleDocs');
  // Omitted → unchanged: bare for a lone close option, numbered for a stack.
  assert.strictEqual(buildVariantBlock([{ doorway: null, copy: 'Ship faster.' }], { distance: 'close', charMax: 60 }), 'Ship faster.');
  assert.strictEqual(buildVariantBlock([{ doorway: null, copy: 'A' }, { doorway: null, copy: 'B' }], { distance: 'close', charMax: 60 }), '1. A\n2. B');
  // Append (startIndex:1) → every batch restarts at 1 and is force-numbered,
  // even a single option, so it reads as a numbered group below existing copy.
  assert.strictEqual(buildVariantBlock([{ doorway: 'Reframe', copy: 'X' }], { distance: 'wide', charMax: 60, startIndex: 1 }), '1. (Reframe) X');
  assert.strictEqual(buildVariantBlock([{ doorway: null, copy: 'Y' }], { distance: 'close', charMax: 60, startIndex: 1 }), '1. Y');
  assert.strictEqual(
    buildVariantBlock([{ doorway: 'Pain', copy: 'A' }, { doorway: 'Proof', copy: 'B' }, { doorway: 'Reframe', copy: 'C' }], { distance: 'wide', charMax: 60, startIndex: 1 }),
    '1. (Pain) A\n2. (Proof) B\n3. (Reframe) C'
  );
});

test('append: additive write inserts below, never deletes (deleteEnd:null guarantee)', () => {
  const gd = fs.readFileSync(path.join(__dirname, '..', 'src', 'destinations', 'googleDocs.js'), 'utf8');
  // append is a run-level, scoped-only mode.
  assert.ok(/async function generateDraft\(id, direction, clients, voiceGuide, lookupDirection, scopedFields, append\)/.test(gd), 'generateDraft takes append');
  assert.ok(/const appendMode = !!\(append && scopeKeys\)/.test(gd), 'append is scoped-only (appendMode guard)');
  // The no-delete guarantee is in the DATA: append fields carry deleteEnd:null and
  // insert at the field's current copy end (deleteEnd, or insertIndex when empty).
  assert.ok(/const insertAt = f\.deleteEnd != null \? f\.deleteEnd : f\.insertIndex;/.test(gd), 'insert index = end of current copy block');
  assert.ok(/drafts\.push\(\{ fieldName: f\.fieldName, copy: block, insertIndex: insertAt, deleteEnd: null, riffN \}\)/.test(gd), 'append pushes deleteEnd:null (+ riffN for the batch header)');
  assert.ok(/startIndex: 1, labeled: true/.test(gd), 'append batch numbered from 1 and always labeled');
  // Step 3: the batch is prefaced by a faint "Riff N" HEADING_6 header; N = max+1.
  assert.ok(/const riffN = \(f\.maxRiffN \|\| 0\) \+ 1;/.test(gd), 'riff batch number is max existing +1');
  // …and the deletions filter keys on deleteEnd != null, so a deleteEnd:null field
  // can NEVER produce a deleteContentRange.
  assert.ok(/\.filter\(\(d\) => d\.deleteEnd != null && d\.deleteEnd > d\.insertIndex\)/.test(gd), 'deletions require deleteEnd != null');
  // The mapping honors an append item's own insertIndex/deleteEnd.
  assert.ok(/hasOwnProperty\.call\(d, 'deleteEnd'\)/.test(gd), 'mapping honors explicit deleteEnd:null');
});

test('append: threaded route -> adapter -> pipeline -> destination; scoped-only; default off', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  assert.ok(/const append = body\.append === true && scoped;/.test(route), 'route reads body.append, scoped-only');
  assert.ok(/runWebDraft\(docId, tenantContext, direction, scoped \? scopedFields : undefined, append\)/.test(route), 'route threads append');
  const web = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'web.js'), 'utf8');
  assert.ok(/runWebDraft\(docId, tenantContext = \{\}, direction, scopedFields, append\)/.test(web), 'adapter takes append');
  assert.ok(/pipeline\.generateDraft\(docId, direction, clients, tenantId, scopedFields, append\)/.test(web), 'adapter threads append');
  const pipe = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'pipeline.js'), 'utf8');
  assert.ok(/async function generateDraft\(docId, direction, clients, tenantId, scopedFields, append\)/.test(pipe), 'pipeline takes append');
  assert.ok(/generateDraft\(docId, direction, clients, voiceGuide, lookupDirection, scopedFields, append\)/.test(pipe), 'pipeline threads append to destination');
});

test('variations (P2/P3): route sanitizes count (1-4) and distance whitelist; payload threads through', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  assert.ok(/Math\.max\(1, Math\.min\(4, parseInt\(f\.count/.test(route), 'count clamped to 1..4');
  assert.ok(/\['close', 'explore', 'wide'\]\.includes\(f\.distance\)/.test(route), 'distance whitelisted');
  // scopedFields (now carrying count/distance) still threads route->adapter->pipeline->destination.
  const gd = fs.readFileSync(path.join(__dirname, '..', 'src', 'destinations', 'googleDocs.js'), 'utf8');
  assert.ok(/scopeMeta/.test(gd) && /distance: t\.distance === 'explore'/.test(gd), 'destination reads per-field count/distance');
});

test('matrix 3b: the add-a-row variations matrix (angles, count 1–10, intensity slide-rule)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(/buildVarControls/.test(html), 'matrix builder present');
  // The 7 angles + the 3 intensity stops (mirror the backend taxonomy).
  assert.ok(/var ANGLES = \['Pain', 'Outcome', 'Proof', 'Question', 'Contrast', 'Identity', 'Reframe'\]/.test(html), '7 angles offered');
  assert.ok(/var INTENSITIES = \['Safe', 'Bold', 'Wild'\]/.test(html), '3 intensity stops');
  // Add-a-row model: opens with "+ Add angle"; the count/distance UI is gone.
  assert.ok(/matrix-add/.test(html) && /\+ Add angle/.test(html), 'add-a-row affordance');
  assert.ok(!/var-distance/.test(html) && !/setFieldMeta/.test(html), 'old count-slider + distance-pills removed');
  // Each configured row = angle trigger (custom dark menu) + 1–10 stepper +
  // Safe/Bold/Wild slide-rule + remove.
  assert.ok(/openAngleMenu\(trigger, r\.angle, function \(angle\)/.test(html) && /updateRow\(aName, fName, i, \{ angle: angle \}\)/.test(html), 'angle picked via the dark menu sets the row angle');
  assert.ok(/var ANGLE_INFO = \[/.test(html) && /The problem they feel/.test(html), 'angle menu carries name + description');
  assert.ok(/matrix-count/.test(html) && /n = Math\.max\(1, Math\.min\(10, n\)\)/.test(html), 'count stepper clamped 1–10');
  assert.ok(/className = 'var-range'/.test(html) && /range\.min = '0'; range\.max = '2'/.test(html), 'intensity is a 3-stop slide-rule');
  assert.ok(/matrix-tick/.test(html), 'Safe/Bold/Wild tick labels present');
  assert.ok(/matrix-x/.test(html) && /removeRow\(aName, fName, i\)/.test(html), 'remove control');
  // iOS: inner controls stop propagation so a tap/drag never toggles the field.
  assert.ok(/function shield\(node\)/.test(html) && /e\.stopPropagation\(\)/.test(html), 'inner controls shielded');
  assert.ok(/Tap any field to select it\./.test(html), 'affordance line present');
  assert.ok(/isNumberedStack/.test(html) && /field-options/.test(html), 'stacked fields show "N options"');
});

test('variations (P2/P3): regen modal copy shifts to craft-notes when variations are set', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  // The copy swap is driven by the selection's count/distance, applied on open.
  assert.ok(/applyRegenModalCopy/.test(html), 'regen modal copy helper present');
  assert.ok(/\(f\.count \|\| 1\) > 1 \|\| \(f\.distance && f\.distance !== 'close'\)/.test(html), 'keys on count>1 OR distance!=close');
  // Variations case: steer toward craft, not angle.
  assert.ok(/Anything else to steer these\?/.test(html), 'craft-notes title');
  assert.ok(/angle is already set by your distance/.test(html), 'placeholder disclaims angle');
  // Plain scoped / whole-doc case keeps the original steering copy.
  assert.ok(/What should change\?/.test(html), 'default title retained');
  // Applied on both the Copy Done and project-view modals.
  assert.ok(/applyRegenModalCopy\('regen-modal-title'/.test(html) && /applyRegenModalCopy\('project-regen-modal-title'/.test(html), 'wired into both modals');
});

test('generation loading: rotating shuffled phrases, no progress bar (one state, all paths)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  // Phrases restored as the draft loading state.
  const m = html.match(/var GEN_PHRASES = \[([\s\S]*?)\];/);
  assert.ok(m, 'GEN_PHRASES array present');
  const count = m[1].split(',').filter((s) => /'/.test(s)).length;
  assert.ok(count >= 40, 'the full phrase set is restored (~50), got ' + count);
  // Cycled in RANDOM order, re-shuffled each run (default phrase set = GEN_PHRASES).
  assert.ok(/function shuffle/.test(html) && /shuffle\(phrases \|\| GEN_PHRASES\)/.test(html), 'phrases are shuffled per generation');
  assert.ok(/function startGenerating/.test(html) && /function stopGenerating/.test(html), 'phrase cycler present');
  assert.ok(/id="gen-message"/.test(html), 'gen-message element present');
  // The GIF + modal stay; the progress bar / asset label / time estimate are gone.
  assert.ok(/class="gen-gif"/.test(html), 'generation GIF kept');
  assert.ok(!/draft-progress/.test(html), 'no draft progress bar/label/estimate');
  assert.ok(!/startDraftBar|estimateDraftSec/.test(html), 'estimate-driven bar code removed');
  // All four draft paths drive the one loading state (2 brief-flow + 2 project).
  assert.ok((html.match(/startGenerating\(\)/g) || []).length >= 4, 'every draft path uses the phrase cycler');
});

test('riff (matrix step 2): progressive-disclosure panel + additive Riff action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  // Riff has its OWN shuffled phrase set (~12-15), reusing the same GIF modal.
  const rm = html.match(/var RIFF_PHRASES = \[([\s\S]*?)\];/);
  assert.ok(rm, 'RIFF_PHRASES array present');
  const nPhrases = (rm[1].match(/…/g) || []).length; // each phrase ends with an ellipsis
  assert.ok(nPhrases >= 12 && nPhrases <= 16, 'roughly 12-15 riff phrases, got ' + nPhrases);
  assert.ok(/function startGenerating\(phrases\)/.test(html), 'startGenerating takes an optional phrase set');
  assert.ok(/startGenerating\(RIFF_PHRASES\)/.test(html), 'riff uses the riff phrases');

  // Progressive disclosure: controls are gated on .expanded (not .selected), and a
  // chevron appears on a selected field.
  assert.ok(/\.asset-field\.expanded \.var-controls \{ display: flex; \}/.test(html), 'controls revealed by expand, not select');
  assert.ok(/\.asset-field\.selected \.field-expand \{ display: inline-flex; \}/.test(html), 'chevron shows on a selected field');
  assert.ok(/fieldEl\.classList\.toggle\('expanded'\)/.test(html), 'chevron toggles the expanded panel');

  // Riff button lives inside the panel and fires the append path for that field,
  // now carrying the variations matrix (Step 3b) rather than count/distance.
  assert.ok(/class="riff-btn"|'riff-btn'/.test(html) && /variations: rows\.map\(function \(r\) \{ return \{ angle: r\.angle, count: r\.count, intensity: r\.intensity \}; \}\)/.test(html), 'Riff button sends the matrix rows');
  assert.ok(/async function runRiff\(docId, scopedField, reload\)/.test(html), 'runRiff present');
  assert.ok(/draftFetch\(docId, '', \[scopedField\], \{ append: true \}\)/.test(html), 'runRiff appends (append:true)');
  assert.ok(/if \(opts && opts\.append\) body\.append = true;/.test(html), 'draftFetch sends append');

  // Both drafted screens supply a riff context (docId + in-place reload).
  assert.ok((html.match(/riff: \{ docId:/g) || []).length >= 2, 'project view + Copy Done both wire riff');

  // Regenerate stays destructive — never sends append.
  assert.ok(!/regenerateProjectDraft[\s\S]*?append: true/.test(html.slice(0, html.indexOf('function runRiff'))), 'regenerate does not append');
});

test('matrix 3b: getDocContent exposes doc-accurate riffMarks for the app dividers', () => {
  const { getDocContent } = require('../src/destinations/googleDocs');

  // A field with a seed + two batches; batch numbers 1 then 3 (Riff 2 was deleted
  // in the doc). riffMarks must carry the DOC's numbers, not a resequenced 1,2.
  const paras = [
    { text: 'Email', style: 'HEADING_3' },
    { text: 'Headline [50]', bold: true },
    { text: 'Original seed line' }, //             copy line 0
    { text: 'Riff 1', style: 'HEADING_6' },
    { text: '1. (Pain) A' }, //                    copy line 1
    { text: '2. (Outcome) B' }, //                 copy line 2
    { text: 'Riff 3', style: 'HEADING_6' }, //     gap: Riff 2 deleted
    { text: '1. (Contrast) C' }, //                copy line 3
    { text: '' },
  ];
  const doc = makeMatrixDoc(paras);
  const clients = { docs: { documents: { get: async () => ({ data: doc }) } } };
  return getDocContent('doc', clients).then((content) => {
    const f = content.assets[0].fields[0];
    // Copy still excludes the headers (unchanged from 3a).
    assert.strictEqual(f.copy, 'Original seed line\n1. (Pain) A\n2. (Outcome) B\n1. (Contrast) C');
    // Doc-accurate batch markers: Riff 1 before copy-line 1, Riff 3 before line 3.
    assert.deepStrictEqual(f.riffMarks, [{ beforeLine: 1, riffN: 1 }, { beforeLine: 3, riffN: 3 }]);
  });
});

test('matrix 3b: Riff sends the matrix; Regenerate stays name-only; dividers render from riffMarks', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  // State carries the matrix rows; the mutators exist.
  assert.ok(/\{ assetType: a, fieldName: f, rows: \[\] \}/.test(html), 'selection carries matrix rows');
  assert.ok(/function addRow/.test(html) && /function updateRow/.test(html) && /function removeRow/.test(html), 'row mutators present');

  // Riff sends variations:[{angle,count,intensity}] — 3a's contract.
  assert.ok(/variations: rows\.map\(function \(r\) \{ return \{ angle: r\.angle, count: r\.count, intensity: r\.intensity \}; \}\)/.test(html), 'Riff payload is the matrix');
  // No separate summary line — the total rides on the generate button as
  // "Generate options (N)", and the button disables with zero rows.
  assert.ok(!/matrix-summary/.test(html) && !/'Generate ' \+ total/.test(html), 'redundant summary line removed');
  assert.ok(/riffBtn\.textContent = total \? 'Generate options \(' \+ total \+ '\)' : 'Generate options'/.test(html), 'total shown on the generate button');
  assert.ok(/riffBtn\.disabled = rows\.length === 0/.test(html), 'Riff disabled with 0 rows');

  // Regenerate path strips to {assetType, fieldName} — never the matrix rows.
  assert.ok(/function selectedScopedFields\(\)/.test(html) && /return \{ assetType: v\.assetType, fieldName: v\.fieldName \};/.test(html), 'Regenerate sends name-only');

  // Riff N dividers render before each batch, from riffMarks, with the doc number.
  assert.ok(/function fieldCopyEl\(copy, riffMarks\)/.test(html), 'copy renderer takes riffMarks');
  assert.ok(/'Riff ' \+ byLine\[i\]/.test(html) && /riff-divider-label/.test(html), 'renders "Riff N" divider before each batch');
});

test('gemini.reviewCopyFields + googleDocs review comment API exposed', () => {
  assert.strictEqual(typeof require('../src/services/gemini').reviewCopyFields, 'function');
  const g = require('../src/destinations/googleDocs');
  assert.strictEqual(typeof g.listReviewComments, 'function');
  assert.strictEqual(typeof g.addReviewComment, 'function');
  assert.strictEqual(typeof g.deleteReviewComment, 'function');
  assert.strictEqual(typeof g.clearReviewComments, 'function');
  assert.strictEqual(typeof g.postReviewComments, 'function');
  assert.strictEqual(g.REVIEW_PREFIX, '🪶 Quillio Review — ');
});

test('db exposes review-state helpers; no-DB is a safe no-op', async () => {
  const db = require('../src/db');
  assert.strictEqual(typeof db.getReviewState, 'function');
  if (!process.env.DATABASE_URL) {
    assert.strictEqual(await db.getReviewState('doc1'), null);
    assert.strictEqual(await db.saveReviewState('doc1', { fields: {} }), false);
  }
});

test('reviewCopyFields returns [] for no fields (no Gemini call)', async () => {
  const { reviewCopyFields } = require('../src/services/gemini');
  assert.deepStrictEqual(await reviewCopyFields({ fields: [] }), []);
});

test('review treats the brief audience as authoritative over voice.md default', () => {
  // The review prompt must separate WHO (brief audience) from HOW (voice.md
  // voice/tone/craft) and NOT flag copy for addressing the brief's audience.
  const gsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'gemini.js'), 'utf8');
  assert.ok(/briefContext/.test(gsrc), 'reviewCopyFields accepts briefContext');
  assert.ok(/CAMPAIGN BRIEF/.test(gsrc), 'prompt has a campaign-brief block');
  assert.ok(/AUDIENCE PRECEDENCE/.test(gsrc), 'prompt states audience precedence');
  assert.ok(/Do NOT flag copy for addressing the brief's audience/.test(gsrc), 'no audience false-flag');
  assert.ok(/brand-universal guidance/.test(gsrc), 'voice.md universals still applied');
  // copyReview must pass the doc's summary + writer direction as the brief context.
  const crsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'copyReview.js'), 'utf8');
  assert.ok(/briefContext[\s\S]*content\.summary[\s\S]*writerDirection/.test(crsrc), 'copyReview wires briefContext');
});

test('web review trigger (8b): adapter + route + project-view button wired', () => {
  assert.strictEqual(typeof require('../src/adapters/web').runWebReview, 'function');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('id="project-review-btn"'), 'Review Copy button present');
  assert.ok(html.includes('id="project-review-modal"'), 'review result overlay present');
  // The brief-flow Copy Done screen must ALSO offer Review Copy (the common path),
  // not just the project view — both go through the shared runReviewIntoModal.
  assert.ok(html.includes('id="copydone-review-btn"'), 'Copy Done Review button present');
  assert.ok(html.includes('reviewCopyDone') && html.includes('runReviewIntoModal'), 'copydone review wired via shared runner');
  assert.ok(html.includes("fetch") && html.includes("'/api/review'"), 'calls /api/review');
  assert.ok(html.includes('quillio-review.gif') && html.includes('quillio-copy-done.gif'), 'both GIF states');
});

test('Slack review trigger (8c): runner, doc-id extract, endpoint, channel lookup', () => {
  const sr = require('../src/adapters/slackReview');
  assert.strictEqual(typeof sr.runSlackReview, 'function');
  // Doc id from a pasted link or a bare id; null when neither.
  assert.strictEqual(sr.docIdFromText('review https://docs.google.com/document/d/ABC123def456GHI789jkl/edit'), 'ABC123def456GHI789jkl');
  assert.strictEqual(sr.docIdFromText(''), null);
  // Slack wraps a pasted URL as <url> / <url|label>, often with ?usp=drivesdk —
  // the parser must unwrap it and extract the id (the pasted-link bug).
  assert.strictEqual(
    sr.docIdFromText('<https://docs.google.com/document/d/ABC123def456GHI789jkl/edit?usp=drivesdk>'),
    'ABC123def456GHI789jkl'
  );
  assert.strictEqual(
    sr.docIdFromText('<https://docs.google.com/document/d/ABC123def456GHI789jkl/edit|https://docs.google.com/document/d/ABC123def456GHI789jkl/edit>'),
    'ABC123def456GHI789jkl'
  );
  // Review messages use an inline custom emoji, not a large image block.
  const srsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'slackReview.js'), 'utf8');
  assert.ok(!/type:\s*'image'/.test(srsrc), 'no image block in slack review');
  assert.ok(/REVIEW_EMOJI|SLACK_REVIEW_EMOJI/.test(srsrc), 'inline emoji shortcode used');
  // Channel lookup helper + the /slack/review endpoint are wired.
  assert.strictEqual(typeof require('../src/db/projects').getProjectByChannel, 'function');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(srv.includes("app.post('/slack/review'"), '/slack/review endpoint present');
  assert.ok(srv.includes('runSlackReview'), 'runner wired into server');
});
