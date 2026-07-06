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
  assert.ok(/IBM\+Plex\+Sans/.test(html), 'loads IBM Plex Sans');
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
  assert.ok(/IBM\+Plex\+Sans/.test(html), 'loads IBM Plex Sans');
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
