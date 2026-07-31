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
  // Default (SLACK_USE_CUSTOM_EMOJI unset): custom emoji OFF, so a fresh
  // workspace gets the standard Unicode fallback rather than a literal ":name:".
  assert.strictEqual(USE_CUSTOM_EMOJI, false);
  assert.strictEqual(emoji('quillio-scroll'), '📜');
  assert.strictEqual(emoji('quillio-folder'), '📁');
  // Unknown names never leak a shortcode.
  assert.strictEqual(emoji('nope'), '');
  // Fallback map is complete and correct (used when USE_CUSTOM_EMOJI is false).
  assert.deepStrictEqual(EMOJI, {
    'quillio-scroll': '📜',
    'quillio-doc-done': '📄',
    'quillio-folder': '📁',
    'quillio-copy-done': '🪶',
    'quillio-review': '🔍',
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
    'postLive',
    'updateLive',
  ];
  for (const fn of expected) {
    assert.strictEqual(typeof s[fn], 'function', `slack.${fn} should be a function`);
  }
});

test('services, destinations, and db load with their APIs', () => {
  const gemini = require('../src/services/gemini');
  assert.strictEqual(typeof gemini.parseBrief, 'function');
  assert.strictEqual(typeof gemini.generateVoiceGuide, 'function');
  assert.strictEqual(typeof require('../src/destinations').getDestination, 'function');
  assert.strictEqual(typeof require('../src/db').saveVoiceGuide, 'function');
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

test('copyCompleteBlocks builds Open in Drive + Regenerate', () => {
  const { copyCompleteBlocks } = require('../src/services/slack');
  const blocks = copyCompleteBlocks('done', 'https://doc', 'DOC1');
  const actions = blocks.find((b) => b.type === 'actions').elements;
  const ids = actions.map((e) => e.action_id);
  assert.ok(ids.includes('open_in_drive'), 'has Open in Drive');
  assert.ok(ids.includes('regenerate_draft'), 'has Regenerate');
  assert.strictEqual(
    actions.find((e) => e.action_id === 'regenerate_draft').value,
    'DOC1',
    'regenerate button carries the doc id'
  );
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
  // The refresh token is the signing-in PERSON's Drive identity, so it is stored
  // per user. It used to go to tenant_tokens, where the second person on a tenant
  // overwrote the first's and every later Drive write ran as them.
  assert.ok(/saveUserToken\([^)]*'google'/.test(src), "stores the token under service='google', per user");
  // The tenant-level write survives ONLY as the pre-migration fallback, reached
  // when saveUserToken reports that user_tokens doesn't exist yet. It must never
  // be the unconditional path again — that was the overwrite bug.
  assert.ok(
    /if \(!saved && userTenantId\) await saveTenantToken\(userTenantId, 'google'/.test(src),
    'the tenant-level Google write is guarded as a pre-migration fallback only'
  );
  assert.ok(/connected=google/.test(src) && /error=google_failed/.test(src), 'redirects back to /app');
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

// --- Week 11: onboarding + sign-in ---

test('oauth.js requests the userinfo scopes for Sign in with Google', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oauth.js'), 'utf8');
  assert.ok(/userinfo\.email/.test(src) && /userinfo\.profile/.test(src), 'requests userinfo scopes');
  assert.ok(/oauth2\/v2\/userinfo/.test(src), 'calls the Google userinfo endpoint');
  assert.ok(/req\.session\.userId/.test(src), 'sets the session userId on sign-in');
});

test('db/users exposes the finder + create API', () => {
  const u = require('../src/db/users');
  for (const fn of ['findUserByGoogleId', 'findUserById', 'createUser']) {
    assert.strictEqual(typeof u[fn], 'function', `users.${fn} should be a function`);
  }
});

test('db/users degrades gracefully with no database', async () => {
  delete process.env.DATABASE_URL;
  const { findUserByGoogleId, findUserById, createUser } = require('../src/db/users');
  assert.strictEqual(await findUserByGoogleId('g1'), null);
  assert.strictEqual(await findUserById(1), null);
  assert.strictEqual(await createUser({ email: 'a@b.co' }), null);
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
    '/api/onboarding/complete',
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
  assert.ok(/Encode\+Sans\+Semi\+Condensed/.test(html), 'loads Encode Sans Semi Condensed');
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
    '/api/settings/library', // asset library (GET)
    '/api/settings/library/active', // asset on/off (POST) — is_active only
    '/api/settings/library/asset', // create a tenant asset type (POST)
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
      // field_type is the UNIT char_min/char_max are counted in. 'text' means
      // characters, and did for every field until the six email body fields moved
      // to word ranges — where a character count measures the wrong thing.
      assert.ok(['text', 'words'].includes(f.field_type), `${a.name}/${f.field_name} field_type`);
      assert.ok(f.char_max >= f.char_min, `field "${f.field_name}" max >= min`);
    }
  }
  // sort_order is 1..30 contiguous
  assert.deepStrictEqual(
    [...seenSortOrders].sort((x, y) => x - y),
    Array.from({ length: 30 }, (_, i) => i + 1)
  );
});

test('spec tiers: the seed equals what the migration chain produces, in both directions', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { ENFORCED } = require('../scripts/migrateAddCopyFieldSpecType');
  const { PROMOTE: PROMOTE_2025 } = require('../scripts/migrateAddCopyFieldSpecTypeFixes');
  const fix = require('../scripts/migrateSpecIntegrityFixes');
  const VALID = new Set(['enforced', 'recommended', 'house_default']);

  // Every field carries a valid tier.
  for (const a of DEFAULT_ASSETS) {
    for (const f of a.fields) {
      assert.ok(VALID.has(f.spec_type), `field "${a.name}/${f.field_name}" has valid spec_type (got ${f.spec_type})`);
    }
  }

  // DERIVE the expected tiers by REPLAYING every migration in order, exactly as a
  // long-lived tenant's rows have been through them. A fresh tenant is seeded
  // instead, so if these two disagree the two populations render different specs
  // for the same field — which is the whole reason CLAUDE.md requires the seed and
  // the migration to stay byte-identical.
  let enforced = new Set([...ENFORCED, ...PROMOTE_2025].map(([a, f]) => `${a}||${f}`));
  assert.strictEqual(enforced.size, 25, 'the 2025 chain left 25 enforced pairs');

  // migrateSpecIntegrityFixes, step by step:
  // 4. RENAME — the Google asset's four pairs move to the new name.
  enforced = new Set([...enforced].map((k) =>
    k.startsWith(`${fix.RENAME.from}||`) ? `${fix.RENAME.to}||${k.split('||')[1]}` : k));
  // 1. RETIER — Meta's ten leave 'enforced' and become the recommended set.
  const recommended = new Set(fix.RETIER.map(([a, f]) => `${a}||${f}`));
  for (const k of recommended) {
    assert.ok(enforced.has(k), `${k} must currently be enforced for the retier to apply`);
    enforced.delete(k);
  }
  // 5. PROMOTE — one uncited house default becomes a real enforced cap.
  for (const [a, f] of fix.PROMOTE) enforced.add(`${a}||${f}`);
  // migrateEmailClassesAndCitedBands: a RESEARCH source, not a platform one — the
  // first recommended field whose citation is a study rather than a spec page.
  for (const [asset, field, , , tier] of require('../scripts/migrateEmailClassesAndCitedBands').CITED_BANDS) {
    if (tier === 'recommended') recommended.add(`${asset}||${field}`);
  }
  // migrateCiteColdEmailBand: the second research citation. The band was already
  // right; only the claim about where it comes from is new.
  {
    const cold = require('../scripts/migrateCiteColdEmailBand');
    recommended.add(`${cold.ASSET}||${cold.FIELD}`);
  }

  assert.strictEqual(enforced.size, 16, '16 enforced pairs after the integrity migration');
  assert.strictEqual(recommended.size, 12, '10 platform recommendations + 2 research citations');

  // FORWARD: everything the migrations produce is in the seed at that tier.
  const seedTier = new Map();
  for (const a of DEFAULT_ASSETS) for (const f of a.fields) seedTier.set(`${a.name}||${f.field_name}`, f.spec_type);
  for (const k of enforced) assert.strictEqual(seedTier.get(k), 'enforced', `${k} seeds enforced`);
  for (const k of recommended) assert.strictEqual(seedTier.get(k), 'recommended', `${k} seeds recommended`);

  // BACKWARD: the seed has NOTHING the migrations did not produce. A one-directional
  // check would miss a tier added to the seed and never migrated — the exact drift
  // that leaves old tenants behind.
  const seedEnforced = new Set(), seedRecommended = new Set();
  for (const [k, t] of seedTier) {
    if (t === 'enforced') seedEnforced.add(k);
    if (t === 'recommended') seedRecommended.add(k);
  }
  assert.deepStrictEqual([...seedEnforced].sort(), [...enforced].sort(), 'seed enforced === migrated enforced');
  assert.deepStrictEqual([...seedRecommended].sort(), [...recommended].sort(), 'seed recommended === migrated recommended');

  // The old Google name is gone from the seed entirely, not merely re-tiered.
  assert.ok(!DEFAULT_ASSETS.some((a) => a.name === fix.RENAME.from), 'the old asset name is gone');
  assert.ok(DEFAULT_ASSETS.some((a) => a.name === fix.RENAME.to), 'the new asset name is present');
});

test('spec sources: every TIERED field cites its own asset\'s page and renders it hyperlinked', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { fieldHint } = require('../src/destinations/googleDocs');
  const { SOURCE_URLS } = require('../scripts/migrateSpecIntegrityFixes');
  const { CITED_BANDS } = require('../scripts/migrateEmailClassesAndCitedBands');
  const cold = require('../scripts/migrateCiteColdEmailBand');
  const FIELD_SOURCES = Object.fromEntries([
    ...CITED_BANDS.map(([asset, field, , , , url]) => [`${asset}||${field}`, url]),
    [`${cold.ASSET}||${cold.FIELD}`, cold.SOURCE_URL],
  ]);

  // The tier sentence each tier is supposed to produce. house_default produces
  // NOTHING — that is what makes an uncited number read as a house convention
  // rather than a rule.
  const SENTENCE = {
    enforced: (p) => `Platform limit (${p}). Stay within this count.`,
    recommended: (p) => `Recommended by ${p}. Not a hard limit — adjust for your brand and goal.`,
  };

  let enforcedSeen = 0;
  let recommendedSeen = 0;
  for (const a of DEFAULT_ASSETS) {
    for (const f of a.fields) {
      if (f.spec_type === 'house_default') {
        // Untiered fields keep the sentinel and render no tier line at all.
        assert.strictEqual(f.spec_source, 'quillio_default', `${a.name}/${f.field_name} stays quillio_default`);
        continue;
      }
      if (f.spec_type === 'enforced') enforcedSeen += 1;
      else recommendedSeen += 1;

      // Seed URL is byte-identical to the migration's URL FOR THAT ASSET — unless
      // the field carries its own. Per-asset is the point (a per-platform map is
      // how LinkedIn Carousel came to cite the single-image page); per-FIELD is the
      // exception for a research citation, which measured one field, not a platform.
      const fieldSource = FIELD_SOURCES[`${a.name}||${f.field_name}`];
      assert.strictEqual(
        f.spec_source,
        fieldSource || SOURCE_URLS[a.name],
        `${a.name}/${f.field_name} seed spec_source === its migration URL`
      );

      const hint = fieldHint({ specType: f.spec_type, specSource: f.spec_source });
      assert.strictEqual(hint.links.length, 1, `${a.name}/${f.field_name} has one link range`);
      assert.strictEqual(hint.links[0].url, f.spec_source, `${a.name}/${f.field_name} link points at spec_source`);
      if (fieldSource) {
        // A research source names its POPULATION and its finding, because
        // "Recommended by Constant Contact" alone would be an appeal to authority.
        assert.match(hint.text, /^Recommended by .+ \(.+\)\. .+\.$/,
          `${a.name}/${f.field_name} names what was measured`);
        assert.ok(!/Not a hard limit — adjust for your brand and goal/.test(hint.text),
          'a research source states its own finding, not the generic hedge');
      } else {
        // Platform sources render exactly the sentence they always have.
        const p = hint.text.match(/^Platform limit \((.+?)\)|^Recommended by (\S+?)\./);
        assert.ok(p, `${a.name}/${f.field_name} names a platform`);
        const name = p[1] || p[2];
        assert.strictEqual(hint.text, SENTENCE[f.spec_type](name), `${a.name}/${f.field_name} renders its tier sentence`);
        assert.strictEqual(
          hint.text.substring(hint.links[0].start, hint.links[0].end), name,
          `${a.name}/${f.field_name} link covers only the platform name`
        );
      }
    }
  }
  assert.strictEqual(enforcedSeen, 16, 'exactly 16 enforced fields carry a real spec_source');
  assert.strictEqual(recommendedSeen, 12, '10 platform recommendations + 2 research citations');

  // The two citations this migration corrected, pinned by value.
  const urlOf = (asset, field) => {
    const f = DEFAULT_ASSETS.find((x) => x.name === asset).fields.find((x) => x.field_name === field);
    return f.spec_source;
  };
  assert.match(urlOf('LinkedIn Carousel Ad', 'Card 1 Headline'), /\/carousel-ads\/specs$/,
    'LinkedIn Carousel cites the CAROUSEL page');
  assert.notStrictEqual(
    urlOf('LinkedIn Carousel Ad', 'Card 1 Headline'),
    urlOf('LinkedIn Single Image Ad', 'Headline'),
    'and no longer shares the single-image URL'
  );
  assert.strictEqual(
    urlOf('Organic Social — Twitter/X', 'Post Copy'),
    urlOf('Twitter/X Ad', 'Ad Copy'),
    'the organic X post cites the same X page as the paid asset'
  );
});

test('LinkedIn Single Image Ad Intro Text seeds char_max 150 + note; Carousel Intro Text untouched', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { NOTE } = require('../scripts/migrateFixLinkedInIntroText');

  const introOf = (assetName) =>
    DEFAULT_ASSETS.find((a) => a.name === assetName).fields.find((f) => f.field_name === 'Intro Text');

  // The targeted field: recommended 150 + the explainer note (byte-identical to migration).
  const sia = introOf('LinkedIn Single Image Ad');
  assert.strictEqual(sia.char_max, 150, 'LinkedIn SIA Intro Text char_max is 150');
  assert.strictEqual(sia.spec_note, NOTE, 'LinkedIn SIA Intro Text spec_note equals the migration NOTE');
  assert.strictEqual(
    sia.spec_note,
    'In-feed preview truncates near 150; 600 is the technical max.',
    'spec_note is the exact expected text'
  );
  // spec_type / spec_source untouched by this change.
  assert.strictEqual(sia.spec_type, 'enforced', 'spec_type unchanged (enforced)');
  assert.ok(/linkedin/i.test(sia.spec_source), 'spec_source unchanged (LinkedIn URL)');

  // The collision neighbour must NOT be touched: Carousel Intro Text stays 600 / null.
  const carousel = introOf('LinkedIn Carousel Ad');
  assert.strictEqual(carousel.char_max, 600, 'LinkedIn Carousel Intro Text char_max stays 600');
  assert.strictEqual(carousel.spec_note, null, 'LinkedIn Carousel Intro Text has no note');
});

test('email Subject Line + Preheader seed mobile-truncation notes; reused names on non-email assets untouched', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { SUBJECT_NOTE, PREHEADER_NOTE, EMAIL_ASSETS, FIELD_NOTES } = require('../scripts/migrateAddEmailSubjectPreheaderNotes');

  const fieldOf = (assetName, fieldName) => {
    const a = DEFAULT_ASSETS.find((x) => x.name === assetName);
    assert.ok(a, `asset "${assetName}" exists`);
    const f = a.fields.find((x) => x.field_name === fieldName);
    assert.ok(f, `field "${assetName}/${fieldName}" exists`);
    return f;
  };

  // Note text is byte-identical to the exact strings the user specified.
  assert.strictEqual(SUBJECT_NOTE, 'Mobile inboxes cut around 40 characters — front-load the first 40. (Litmus)');
  assert.strictEqual(PREHEADER_NOTE, 'Mobile shows ~35–40 characters of preheader — keep the key part first. (Litmus)');

  // All 15 (asset, field) pairs the migration targets seed the matching note.
  //
  // The BANDS moved in the July 2026 integrity pass and are asserted from the new
  // migration's own tables rather than from literals here, so this test cannot
  // drift from the numbers that ship. The NOTE text did not move: ~40 characters of
  // subject and ~35–40 of preheader is what the inbox shows regardless of the band.
  const { SUBJECT_BANDS, PREHEADER_BAND } = require('../scripts/migrateSpecIntegrityFixes');
  const subjectMaxFor = new Map(SUBJECT_BANDS);
  let count = 0;
  for (const assetName of EMAIL_ASSETS) {
    for (const [fieldName, note] of FIELD_NOTES) {
      const f = fieldOf(assetName, fieldName);
      assert.strictEqual(f.spec_note, note, `${assetName}/${fieldName} seeds the migration note byte-for-byte`);
      if (fieldName === 'Preheader') {
        assert.strictEqual(f.char_min, PREHEADER_BAND[0], `${assetName}/Preheader char_min`);
        assert.strictEqual(f.char_max, PREHEADER_BAND[1], `${assetName}/Preheader char_max is 100, not 120`);
      } else {
        // NO minimum on a subject line. `[50-75]` told a writer they had to REACH
        // 50 characters, which is actively wrong for cold outreach.
        assert.strictEqual(f.char_min, 0, `${assetName}/${fieldName} has no char_min floor`);
        assert.strictEqual(f.char_max, subjectMaxFor.get(assetName), `${assetName}/${fieldName} char_max by email type`);
      }
      assert.strictEqual(f.spec_type, 'house_default', `${assetName}/${fieldName} spec_type stays house_default`);
      assert.strictEqual(f.spec_source, 'quillio_default', `${assetName}/${fieldName} spec_source stays quillio_default`);
      count++;
    }
  }
  // The bands really do differ by email type — a single shared band was the bug.
  assert.strictEqual(fieldOf('Sales Basho Email', 'Subject Line 1').char_max, 40, 'cold outreach caps at 40');
  assert.strictEqual(fieldOf('Demand Gen Nurture Email', 'Subject Line 1').char_max, 130, 'opt-in nurture caps at 130');
  assert.strictEqual(count, 15, 'exactly 15 email field defs (3 × 5) carry the notes');

  // Reused field names on NON-email assets must stay noteless — per-pair match,
  // never a global field_name sweep. "Body Copy" lives on Event Reminder (email)
  // but ALSO on Display Banner / Direct Mail Insert (non-email); "Headline" is
  // everywhere. None of these should have picked up an email note.
  assert.strictEqual(
    fieldOf('Display Banner — Standard', 'Body Copy').spec_note, null,
    'non-email "Body Copy" (Display Banner) is untouched'
  );
  assert.strictEqual(
    fieldOf('Direct Mail — Insert', 'Body Copy').spec_note, null,
    'non-email "Body Copy" (Direct Mail Insert) is untouched'
  );
  assert.strictEqual(
    fieldOf('Direct Mail — Insert', 'Headline').spec_note, null,
    'non-email "Headline" (Direct Mail Insert) is untouched'
  );

  // Existing notes are undisturbed: Hook fields keep the "…more" explainer and
  // LinkedIn SIA Intro Text keeps its own note (neither is an email field).
  assert.ok(
    /collapses the rest behind/.test(
      fieldOf('Organic Social — Instagram', 'Hook (first 125 chars, before More)').spec_note || ''
    ),
    'Instagram Hook note is preserved'
  );
  assert.strictEqual(
    fieldOf('LinkedIn Single Image Ad', 'Intro Text').spec_note,
    'In-feed preview truncates near 150; 600 is the technical max.',
    'LinkedIn SIA Intro Text note is preserved'
  );

  // And a non-Subject/Preheader email field (e.g. a CTA) did NOT get a note —
  // this pass is Subject Lines + Preheader ONLY.
  assert.strictEqual(
    fieldOf('Demand Gen Nurture Email', 'CTA Text (Offer 1)').spec_note, null,
    'other email fields (CTA) are not touched this pass'
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

test('fieldHint returns a field-level note only when the field carries a specNote', () => {
  const { fieldHint } = require('../src/destinations/googleDocs');
  const note =
    'Only this opening runs before the app collapses the rest behind “…more.” ' +
    'Land the hook within the character limit; the full caption/post can keep going — it just shows after the fold.';
  // A field with a specNote renders it verbatim (DB-driven, no longer hardcoded).
  const only = fieldHint({ fieldName: 'Hook (first 125 chars, before More)', specNote: note });
  assert.strictEqual(only.text, note, 'a field carrying specNote renders it as the note');
  assert.strictEqual(only.links.length, 0, 'a plain specNote has no link');
  // The Hook name alone no longer produces a note — nothing is hardwired now.
  assert.strictEqual(
    fieldHint({ fieldName: 'Hook (first 125 chars, before More)' }),
    null,
    'a Hook field with no specNote gets no note'
  );
  assert.strictEqual(fieldHint({ fieldName: 'Headline', specNote: null }), null);
  assert.strictEqual(fieldHint({ fieldName: 'Subhead' }), null);
});

test('fieldHint returns { text, links } and hyperlinks only the platform name (Phase B)', () => {
  const { fieldHint } = require('../src/destinations/googleDocs');

  // 1. enforced + quillio_default → no-source form, NO link range.
  const a1 = fieldHint({ specType: 'enforced', specSource: 'quillio_default' });
  assert.strictEqual(a1.text, 'Platform limit. Stay within this count.');
  assert.strictEqual(a1.links.length, 0);

  // 2. recommended + quillio_default → no "by SOURCE" clause, NO link.
  const a2 = fieldHint({ specType: 'recommended', specSource: 'quillio_default' });
  assert.strictEqual(a2.text, 'Recommended. Not a hard limit — adjust for your brand and goal.');
  assert.strictEqual(a2.links.length, 0);

  // 3. house_default → no tier line (null), or specNote-only (no link) when present.
  assert.strictEqual(fieldHint({ specType: 'house_default', specSource: 'quillio_default' }), null);
  const a3 = fieldHint({ specType: 'house_default', specSource: 'quillio_default', specNote: 'Keep it short.' });
  assert.strictEqual(a3.text, 'Keep it short.');
  assert.strictEqual(a3.links.length, 0);

  // 4. enforced + a REAL source → named form, with ONLY the name hyperlinked.
  const url = 'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs';
  const a4 = fieldHint({ specType: 'enforced', specSource: url });
  assert.strictEqual(a4.text, 'Platform limit (LinkedIn). Stay within this count.');
  assert.strictEqual(a4.links.length, 1);
  assert.strictEqual(
    a4.text.substring(a4.links[0].start, a4.links[0].end),
    'LinkedIn',
    'link covers only "LinkedIn", not the surrounding parens'
  );
  assert.strictEqual(a4.links[0].url, url);

  // 5. STACKING: specNote FIRST, then enforced-with-source. Space-joined ONE
  //    paragraph; the link range accounts for the specNote prefix + joining space.
  const a5 = fieldHint({ specType: 'enforced', specSource: url, specNote: 'Keep it short.' });
  assert.strictEqual(a5.text, 'Keep it short. Platform limit (LinkedIn). Stay within this count.');
  assert.ok(!a5.text.includes('\n'), 'stacked guidance stays one paragraph (no newline)');
  assert.strictEqual(a5.links.length, 1);
  assert.strictEqual(
    a5.text.substring(a5.links[0].start, a5.links[0].end),
    'LinkedIn',
    'link lands on the name despite the specNote prefix'
  );
  assert.strictEqual(a5.links[0].url, url);

  // 6. GUARANTEE: no combination ever emits the literal "quillio_default".
  for (const specType of ['enforced', 'recommended', 'house_default', null]) {
    for (const specNote of [null, 'Some note.']) {
      const out = fieldHint({ specType, specSource: 'quillio_default', specNote });
      if (out) assert.ok(!out.text.includes('quillio_default'), `spec_type=${specType} note=${!!specNote} leaked quillio_default`);
    }
  }
});

test('fieldHint hyperlinks a note-embedded "(Litmus)" citation to the right page (render-only)', () => {
  const { fieldHint } = require('../src/destinations/googleDocs');

  const SUBJECT_NOTE = 'Mobile inboxes cut around 40 characters — front-load the first 40. (Litmus)';
  const PREHEADER_NOTE = 'Mobile shows ~35–40 characters of preheader — keep the key part first. (Litmus)';
  const SUBJECT_URL = 'https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic';
  const PREHEADER_URL = 'https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support';

  // These are house_default fields (no tier line) → the ONLY link is the Litmus
  // citation, and it lands on exactly the word "Litmus" (not the parens).
  const subj = fieldHint({ specType: 'house_default', specSource: 'quillio_default', specNote: SUBJECT_NOTE });
  assert.strictEqual(subj.text, SUBJECT_NOTE, 'subject note text is verbatim');
  assert.strictEqual(subj.links.length, 1, 'exactly one link (the citation)');
  assert.strictEqual(subj.text.substring(subj.links[0].start, subj.links[0].end), 'Litmus', 'links only "Litmus"');
  assert.strictEqual(subj.links[0].url, SUBJECT_URL, 'subject note → subject-line Litmus page');

  const pre = fieldHint({ specType: 'house_default', specSource: 'quillio_default', specNote: PREHEADER_NOTE });
  assert.strictEqual(pre.links.length, 1, 'exactly one link');
  assert.strictEqual(pre.text.substring(pre.links[0].start, pre.links[0].end), 'Litmus', 'links only "Litmus"');
  assert.strictEqual(pre.links[0].url, PREHEADER_URL, 'preheader note → preheader Litmus page');
  // Disambiguation: the two notes resolve to DIFFERENT pages.
  assert.notStrictEqual(subj.links[0].url, pre.links[0].url, 'subject vs preheader link to different pages');

  // A house_default note WITHOUT a known citation (e.g. the Hook explainer) gets
  // NO link — keyed on the match list, not any parenthesized word.
  const hookNote =
    'Only this opening runs before the app collapses the rest behind “…more.” ' +
    'Land the hook within the character limit; the full caption/post can keep going — it just shows after the fold.';
  const hook = fieldHint({ specType: 'house_default', specSource: 'quillio_default', specNote: hookNote });
  assert.strictEqual(hook.links.length, 0, 'a note with no known citation produces no link');

  // A stray parenthesized word that is NOT in the match list is never linked.
  const stray = fieldHint({ specType: 'house_default', specSource: 'quillio_default', specNote: 'Keep it tight. (TBD)' });
  assert.strictEqual(stray.links.length, 0, 'unknown "(TBD)" is not linked');

  // The enforced tier-link path is UNCHANGED: platform name still links to spec_source.
  const url = 'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs';
  const enf = fieldHint({ specType: 'enforced', specSource: url });
  assert.strictEqual(enf.text, 'Platform limit (LinkedIn). Stay within this count.');
  assert.strictEqual(enf.links.length, 1, 'enforced field still has its one tier link');
  assert.strictEqual(enf.text.substring(enf.links[0].start, enf.links[0].end), 'LinkedIn', 'tier link covers the platform name');
  assert.strictEqual(enf.links[0].url, url, 'tier link still points at spec_source');
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
    '/api/brief/confirm',
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

// --- Job-status auth + tenant scoping ---
//
// The three /status polls are gated by requireAuth and only resolve for the
// tenant that STARTED the job. The rest of this suite runs in demo mode (no
// DATABASE_URL), where requireAuth short-circuits to one fixed demo tenant — so
// it can neither reach the 401 branch nor produce two distinct tenants, and the
// check would sit untested. This block swaps the DB layer for stubs so
// requireAuth takes its authenticated path, then drives the real router over a
// real (ephemeral, loopback-only) HTTP listener.
//
// Everything it touches in require.cache is restored afterwards, so the modules
// the other tests see are unchanged regardless of ordering.
function withStubbedDb(fn, webStub) {
  const saved = new Map();
  const remember = (p) => {
    if (!saved.has(p)) saved.set(p, require.cache[p]); // may be undefined = wasn't loaded
  };
  const resolve = (rel) => require.resolve(path.join(__dirname, '..', rel));
  // Replace a module's exports wholesale.
  const stub = (rel, exports) => {
    const p = resolve(rel);
    remember(p);
    require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true, exports, children: [], paths: [] };
  };
  // Drop a cached module so it re-loads (and re-binds) against the stubs above.
  // Needed because middleware/auth destructures getPool at require time.
  const reload = (rel) => {
    const p = resolve(rel);
    remember(p);
    delete require.cache[p];
    return require(p);
  };

  // u1 → TENANT_A, anyone else → TENANT_B. A truthy getPool is what takes
  // requireAuth off its demo-mode path.
  stub('src/db', { getPool: () => ({}), resolveTenant: async (id) => ({ tenant: { id } }) });
  stub('src/db/users', {
    findUserById: async (id) => ({ id, email: `${id}@example.test`, tenant_id: id === 'u1' ? 'TENANT_A' : 'TENANT_B', role: 'owner' }),
  });
  stub('src/db/projects', { getProjects: async () => [], getProject: async () => null, setProjectStatus: async () => {} });
  // A small asset library so /api/brief/confirm can validate a plan against real
  // names without a database.
  stub('src/db/assets', {
    getTenantAssets: async () => [
      { name: 'Battle Card', fields: [] },
      { name: 'One-Pager', fields: [] },
      { name: 'Demand Gen Nurture Email', fields: [] },
    ],
    getAssetDirections: async () => () => null,
    seedTenantAssets: async () => {},
  });
  // No Gemini / Docs / Drive: the job body resolves instantly with a marker the
  // owner's poll must see (and nobody else's). /api/brief now calls the two HALVES
  // (parse, then generate) rather than runWebBrief, so both are stubbed; a caller
  // can pass `webStub` to override them and drive the confirm path.
  const DOC = 'https://docs.google.com/document/d/TENANT_A_ONLY/edit';
  stub('src/adapters/web', Object.assign({
    runWebBrief: async () => ({ docUrl: DOC }),
    // Default: a one-of-each plan, i.e. nothing to confirm — the dormant path.
    runWebBriefParse: async () => ({ campaignTitle: 'C', summary: 'S', writerPrompt: 'W',
      referenceInsights: [], plan: [{ asset: 'Battle Card', count: 1, labels: [] }] }),
    runWebBriefGenerate: async () => ({ docUrl: DOC }),
    runWebDraft: async () => ({}),
    runWebReview: async () => ({}),
    runWebProjectContent: async () => ({}),
  }, webStub || {}));
  reload('src/middleware/auth');
  const router = reload('src/routes/app');

  return Promise.resolve(fn(router)).finally(() => {
    for (const [p, mod] of saved) {
      if (mod === undefined) delete require.cache[p];
      else require.cache[p] = mod;
    }
  });
}

test('job-status polls are gated by auth and scoped to the starting tenant', async () => {
  await withStubbedDb(async (router) => {
    const express = require('express');
    const app = express();
    app.use(express.json());
    // Stand-in for express-session: the X-User header names the signed-in user;
    // absent header = no session at all.
    app.use((req, res, next) => {
      const u = req.get('x-user');
      req.session = u ? { userId: u } : {};
      next();
    });
    app.use(router);

    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    // Returns the RAW body text too — the cross-tenant / unknown-job responses
    // have to be indistinguishable byte for byte, not merely both 404s.
    const call = async (method, p, user, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(user ? { 'X-User': user } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { code: res.status, text, json: JSON.parse(text) };
    };

    try {
      const start = await call('POST', '/api/brief', 'u1', { briefText: 'launch the spring sale' });
      assert.strictEqual(start.code, 202, 'u1 starts a brief job');
      const jobId = start.json.jobId;
      assert.ok(jobId, 'POST /api/brief returns a jobId');

      // The job settles on its own microtask chain; poll (as its owner) rather
      // than sleeping a fixed amount.
      let owner;
      for (let i = 0; i < 100; i++) {
        owner = await call('GET', `/api/brief/${jobId}/status`, 'u1');
        if (owner.code !== 200 || owner.json.status !== 'pending') break;
        await new Promise((r) => setTimeout(r, 20));
      }

      // 1. The owning tenant sees its own job and its result.
      assert.strictEqual(owner.code, 200, 'owner polls its own job → 200');
      assert.strictEqual(owner.json.success, true);
      assert.strictEqual(owner.json.status, 'complete');
      assert.strictEqual(owner.json.result.docUrl, 'https://docs.google.com/document/d/TENANT_A_ONLY/edit');

      // 2. Another tenant holding the same (valid) id gets nothing back.
      const other = await call('GET', `/api/brief/${jobId}/status`, 'u2');
      assert.strictEqual(other.code, 404, "another tenant's poll → 404, not 403");
      assert.ok(!other.text.includes('TENANT_A_ONLY'), 'no result leaks across tenants');

      // 3. No session at all → 401 on all three status routes, matching the
      //    gate their POST counterparts already had.
      for (const route of ['brief', 'draft', 'review']) {
        const anon = await call('GET', `/api/${route}/${jobId}/status`);
        assert.strictEqual(anon.code, 401, `/api/${route}/:jobId/status requires a session`);
        assert.strictEqual(anon.json.success, false);
      }

      // 4. Cross-tenant is byte-identical to a job that never existed — a 403
      //    (or any distinguishable body) would confirm the id and make the
      //    endpoint an oracle for probing other tenants' job ids.
      const unknown = await call('GET', '/api/brief/00000000-0000-4000-8000-000000000000/status', 'u1');
      assert.strictEqual(unknown.code, other.code, 'same status code');
      assert.strictEqual(unknown.text, other.text, 'same response body, byte for byte');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
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
  assert.ok(/Encode\+Sans\+Semi\+Condensed/.test(html), 'loads Encode Sans Semi Condensed');
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
  // (aInst — the asset's instance ordinal — joined every one of these signatures
  // when selection became instance-aware; `i` here is still the ROW index.)
  assert.ok(/openAngleMenu\(trigger, r\.angle, function \(angle\)/.test(html) && /updateRow\(aName, aInst, fName, i, \{ angle: angle \}\)/.test(html), 'angle picked via the dark menu sets the row angle');
  assert.ok(/var ANGLE_INFO = \[/.test(html) && /The problem they feel/.test(html), 'angle menu carries name + description');
  assert.ok(/matrix-count/.test(html) && /n = Math\.max\(1, Math\.min\(10, n\)\)/.test(html), 'count stepper clamped 1–10');
  assert.ok(/className = 'var-range'/.test(html) && /range\.min = '0'; range\.max = '2'/.test(html), 'intensity is a 3-stop slide-rule');
  assert.ok(/matrix-tick/.test(html), 'Safe/Bold/Wild tick labels present');
  assert.ok(/matrix-x/.test(html) && /removeRow\(aName, aInst, fName, i\)/.test(html), 'remove control');
  // iOS: inner controls stop propagation so a tap/drag never toggles the field.
  assert.ok(/function shield\(node\)/.test(html) && /e\.stopPropagation\(\)/.test(html), 'inner controls shielded');
  assert.ok(/riff on new variations/.test(html) && /generate just those/.test(html), 'affordance line present (context-aware: generate vs riff)');
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
  assert.ok(/\{ assetType: a, instance: i, fieldName: f, rows: \[\] \}/.test(html), 'selection carries matrix rows');
  assert.ok(/function addRow/.test(html) && /function updateRow/.test(html) && /function removeRow/.test(html), 'row mutators present');

  // Riff sends variations:[{angle,count,intensity}] — 3a's contract.
  assert.ok(/variations: rows\.map\(function \(r\) \{ return \{ angle: r\.angle, count: r\.count, intensity: r\.intensity \}; \}\)/.test(html), 'Riff payload is the matrix');
  // No separate summary line — the total rides on the generate button as
  // "Generate options (N)", and the button disables with zero rows.
  assert.ok(!/matrix-summary/.test(html) && !/'Generate ' \+ total/.test(html), 'redundant summary line removed');
  assert.ok(/riffBtn\.textContent = total \? 'Generate options \(' \+ total \+ '\)' : 'Generate options'/.test(html), 'total shown on the generate button');
  assert.ok(/riffBtn\.disabled = rows\.length === 0/.test(html), 'Riff disabled with 0 rows');

  // Regenerate path strips to the field's IDENTITY — never the matrix rows. That
  // identity gained `instance` so the server can target one of several same-named
  // assets; it is still name-only in the sense that matters here (no variations).
  assert.ok(/function selectedScopedFields\(\)/.test(html) && /return \{ assetType: v\.assetType, instance: v\.instance, fieldName: v\.fieldName \};/.test(html), 'Regenerate sends identity-only');
  assert.ok(!/function selectedScopedFields\(\)[\s\S]{0,220}variations/.test(html), 'and never the matrix rows');

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
  // The /slack/review endpoint is wired.
  const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(srv.includes("app.post('/slack/review'"), '/slack/review endpoint present');
  assert.ok(srv.includes('runSlackReview'), 'runner wired into server');
});

test('Slack HTTP surface: signature check runs before the challenge echo', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const handler = srv.slice(srv.indexOf("app.post('/slack/interactions'"));
  const verifyAt = handler.indexOf('verifySlack(req)');
  const challengeAt = handler.indexOf('extractChallenge(req.body)');
  assert.ok(verifyAt > -1 && challengeAt > -1, 'both the verify and challenge steps are present');
  assert.ok(
    verifyAt < challengeAt,
    'verifySlack must run BEFORE extractChallenge — echoing the challenge first reflects ' +
      'attacker-supplied text to any unauthenticated POST'
  );
  // extractChallenge still unwraps a challenge out of the form-encoded `payload`.
  const ec = srv.slice(srv.indexOf('function extractChallenge'), srv.indexOf('// GET / —'));
  assert.ok(/JSON\.parse\(body\.payload\)/.test(ec), 'form-encoded payload unwrapping kept');
});

test('verifySlack fails closed when SLACK_SIGNING_SECRET is unset', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const fn = srv.slice(srv.indexOf('function verifySlack'), srv.indexOf('function parseSlackFiles'));
  assert.ok(
    /if\s*\(!config\.SLACK_SIGNING_SECRET\)[\s\S]{0,200}?return false;/.test(fn),
    'no signing secret => reject, never allow'
  );
});

test('all three Slack routes are rate limited', () => {
  const { slackLimiter } = require('../src/middleware/rateLimit');
  assert.strictEqual(typeof slackLimiter, 'function', 'slackLimiter middleware exists');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  for (const route of ['/slack/command', '/slack/review', '/slack/interactions']) {
    assert.ok(
      srv.includes(`app.post('${route}', slackLimiter,`),
      `${route} is mounted behind slackLimiter`
    );
  }
  // Generous on purpose: Slack retries failed deliveries and all workspaces
  // share Slack's egress IPs, so the cap must not throttle legitimate bursts.
  const rl = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'rateLimit.js'), 'utf8');
  const m = rl.match(/slackLimiter:\s*perHour\((\d+)\)/);
  assert.ok(m, 'slackLimiter is a perHour limiter');
  assert.ok(Number(m[1]) >= 300, `slack limit should be generous, got ${m[1]}`);
});

test('review emoji goes through emoji() and has a Unicode fallback', () => {
  const config = require('../src/config');
  const { emoji, EMOJI } = require('../src/emoji');
  // Config carries a bare NAME (no colons), so emoji() can resolve it.
  assert.strictEqual(config.SLACK_REVIEW_EMOJI, 'quillio-review');
  assert.ok(!config.SLACK_REVIEW_EMOJI.includes(':'), 'no literal shortcode in config');
  // Default (custom emoji off) renders the Unicode fallback, not ":quillio-review:".
  assert.strictEqual(EMOJI['quillio-review'], '🔍');
  assert.strictEqual(emoji(config.SLACK_REVIEW_EMOJI), '🔍');
  // The adapter resolves it through emoji() rather than injecting config directly.
  const srsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'slackReview.js'), 'utf8');
  assert.ok(
    /const REVIEW_EMOJI = emoji\(config\.SLACK_REVIEW_EMOJI\);/.test(srsrc),
    'slackReview routes the review emoji through emoji()'
  );
});

// --- craft.md / voice.md split: craft always loads, brand is replaceable ---

test('craft/brand split: craft.md holds the mediums, voice.md holds brand only', () => {
  const root = path.join(__dirname, '..');
  // Read what actually reaches a prompt: loadGuide() strips HTML comments, so
  // the maintainer notes at the top of each file are not part of the content.
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const craft = read('craft.md');
  const voice = read('voice.md');
  // The medium-slicing parser keys off this exact level-2 heading text.
  assert.ok(/^##\s.*Writing Across Mediums/mi.test(craft), 'craft.md carries the mediums section');
  assert.ok(!/Writing Across Mediums/i.test(voice), 'voice.md no longer carries the mediums');
  // Craft content that a tenant guide must never be able to displace.
  assert.ok(/Approved CTA Library/i.test(craft), 'CTA library lives in craft.md');
  assert.ok(/Character Count Discipline/i.test(craft), 'character discipline lives in craft.md');
  assert.ok(/##\s.*Headlines/i.test(craft) && /##\s.*Body Copy/i.test(craft), 'headline/body craft in craft.md');
  assert.ok(!/Approved CTA Library/i.test(voice), 'CTA library is not duplicated in voice.md');
  // Universally weak phrasing is craft — a tenant guide must not be able to drop it.
  assert.ok(/Generic filler — delete or replace/.test(craft), 'the filler list lives in craft.md');
  assert.ok(/synergy/.test(craft) && /Throat-clears/.test(craft), 'filler + throat-clears in craft.md');
  assert.ok(!/synergy/i.test(voice), 'generic filler is not left in voice.md');
  assert.ok(!/Generic filler/i.test(voice), 'no filler list left in voice.md (a cross-reference is fine)');
  // Brand placeholder sections stay put as the no-tenant-guide fallback.
  assert.ok(/Brand Voice \(CUSTOMIZE THIS SECTION\)/.test(voice), 'brand placeholder stays in voice.md');
  assert.ok(/Mechanics & Formatting/.test(voice), 'mechanics stay in voice.md');
  // voice.md's words list keeps the questionnaire's BRAND-specific shape.
  assert.ok(/Brand Vocabulary/.test(voice), 'brand vocabulary section stays in voice.md');
  assert.ok(/Words That Work/.test(voice) && /Do Not Use/.test(voice), 'questionnaire word shape kept');
});

test('craft.md is injected for BOTH a tenant with a saved guide and one without', () => {
  const { brandVoiceLines } = require('../src/services/gemini');
  const tenantGuide = [
    '# Acme Voice Guide',
    '## Brand Personality',
    'Bold, irreverent, allergic to corporate speak.',
    '## Do Not Use',
    'synergy, best-in-class',
  ].join('\n');

  const withGuide = brandVoiceLines('LinkedIn Paid Social', tenantGuide).join('\n');
  const noGuide = brandVoiceLines('LinkedIn Paid Social', '').join('\n');

  for (const [label, block] of [['tenant guide', withGuide], ['no guide', noGuide]]) {
    // This is the regression the split exists to prevent: a tenant who
    // completes onboarding must NOT lose the craft playbook.
    assert.ok(/COPY CRAFT PLAYBOOK/.test(block), `${label}: craft block is labeled`);
    assert.ok(/BRAND VOICE —/.test(block), `${label}: brand block is labeled`);
    assert.ok(/Approved CTA Library/.test(block), `${label}: CTA library present`);
    assert.ok(/Character Count Discipline/.test(block), `${label}: character discipline present`);
    assert.ok(/Generic filler — delete or replace/.test(block), `${label}: universal filler list present`);
    assert.ok(/Lead with the benefit/.test(block), `${label}: universal craft principles present`);
    assert.ok(/LinkedIn \(paid\)/.test(block), `${label}: the asset's medium section present`);
    assert.ok(/PROMPT HIERARCHY/.test(block), `${label}: hierarchy stated`);
    assert.ok(/BRAND VOICE wins/.test(block), `${label}: brand wins voice conflicts`);
    assert.ok(/Character limits = HARD constraints that ALWAYS win/.test(block), `${label}: limits win`);
  }
  // The tenant's guide is the brand half; the repo placeholder is not used.
  assert.ok(/allergic to corporate speak/.test(withGuide), 'tenant brand content injected');
  assert.ok(!/CUSTOMIZE THIS SECTION/.test(withGuide), 'tenant guide replaces the brand placeholder');
  assert.ok(/CUSTOMIZE THIS SECTION/.test(noGuide), 'no tenant guide → repo voice.md is the brand half');
});

test('medium slicing still picks the right craft section per asset type', () => {
  const { buildCraftContext, mediumKeywordsForAsset } = require('../src/services/gemini');
  const cases = [
    ['LinkedIn Paid Social', 'Paid Social', ['Organic Social', 'Email', 'Google Display']],
    ['Organic Social Post', 'Organic Social', ['Google Display', 'Email']],
    ['Display Banner', 'Google Display', ['Organic Social', 'Email']],
    ['Dynamic Email', 'Email', ['Organic Social', 'Google Display']],
    ['Basho Email Outbound', 'Sales / 1:1 Outreach', ['Organic Social', 'Google Display']],
    ['Form Confirmation', 'Confirmation / Post-Conversion', ['Organic Social', 'Google Display']],
  ];
  for (const [assetType, want, absent] of cases) {
    const ctx = buildCraftContext(assetType);
    assert.ok(ctx.includes(`### ${want}`), `${assetType} → keeps "${want}"`);
    for (const other of absent) {
      assert.ok(!ctx.includes(`### ${other}`), `${assetType} → drops "${other}"`);
    }
    // Universal craft rides along with every slice.
    assert.ok(/Approved CTA Library/.test(ctx), `${assetType} → keeps the CTA library`);
  }
  // Unknown medium → keep every section rather than drop guidance.
  assert.strictEqual(mediumKeywordsForAsset('Billboard'), null);
  const all = buildCraftContext('Billboard');
  for (const s of ['Paid Social', 'Organic Social', 'Google Display', 'Email']) {
    assert.ok(all.includes(`### ${s}`), `unknown medium keeps "${s}"`);
  }
  // An array of asset types (copy review) → the UNION of their mediums.
  const union = buildCraftContext(['LinkedIn Paid Social', 'Dynamic Email']);
  assert.ok(union.includes('### Paid Social') && union.includes('### Email'), 'union keeps both');
  assert.ok(!union.includes('### Google Display'), 'union drops unrelated mediums');
});

test('copy review judges against BOTH craft and brand', () => {
  const gsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'gemini.js'), 'utf8');
  // Both review prompts (single fields + variation stacks) build a craft block.
  assert.strictEqual((gsrc.match(/COPY CRAFT PLAYBOOK — AUTHORITATIVE/g) || []).length, 2,
    'field review and variant review each label a craft block');
  assert.ok(/buildCraftContext\(list\.map\(\(f\) => f\.assetType\)\)/.test(gsrc),
    'field review scopes craft to the assets under review');
  assert.ok(/It SUPPLEMENTS the craft playbook above — it never replaces it/.test(gsrc),
    'review states craft is not replaced by the brand guide');
  // The variant prompt carries both blocks.
  const { buildVariantReviewPrompt } = require('../src/services/gemini');
  const prompt = buildVariantReviewPrompt({
    assetType: 'LinkedIn Paid Social', fieldName: 'Headline', charMax: 70,
    variations: [{ index: 1, doorway: 'Pain', copy: 'Ticket queues never end.' }],
    voiceGuide: '# Acme\nBold and irreverent.', briefContext: {}, siblings: [],
  });
  assert.ok(/COPY CRAFT PLAYBOOK/.test(prompt), 'variant review gets craft');
  assert.ok(/Approved CTA Library/.test(prompt), 'variant review gets the CTA library');
  assert.ok(/LinkedIn \(paid\)/.test(prompt), 'variant review gets the asset medium');
  assert.ok(/Bold and irreverent/.test(prompt), 'variant review gets the tenant brand guide');
});

// --- cleanDraft: balanced wrappers only ------------------------------------
//
// Regression guard. The original implementation was a blanket
// /^[*_"'“”‘’\s]+|[*_"'“”‘’\s]+$/ strip, which ate the opening quote of any
// copy that legitimately BEGAN with a quoted phrase. A wrapper now comes off
// only when it is balanced and encloses the entire string.

test('cleanDraft leaves a legitimate opening quote alone', () => {
  const { cleanDraft } = require('../src/services/gemini');
  // The reported bug: opens with a quoted phrase, ends with a period. Not a
  // wrapper, so nothing should be stripped.
  assert.strictEqual(
    cleanDraft(`"Make it pop" isn't a brief. Stop endless review rounds.`),
    `"Make it pop" isn't a brief. Stop endless review rounds.`
  );
});

test('cleanDraft strips a balanced wrapper that encloses the whole string', () => {
  const { cleanDraft } = require('../src/services/gemini');
  assert.strictEqual(cleanDraft('"Just do it."'), 'Just do it.');
  assert.strictEqual(cleanDraft('**Bold headline**'), 'Bold headline');
  assert.strictEqual(cleanDraft('“Curly wrapped”'), 'Curly wrapped');
  // Single quotes, single asterisk, underscores and curly singles too.
  assert.strictEqual(cleanDraft("'Single wrapped'"), 'Single wrapped');
  assert.strictEqual(cleanDraft('*Italic headline*'), 'Italic headline');
  assert.strictEqual(cleanDraft('_Underscored_'), 'Underscored');
  assert.strictEqual(cleanDraft('‘Curly single’'), 'Curly single');
});

test('cleanDraft leaves mixed, unbalanced, and mid-string quotes alone', () => {
  const { cleanDraft } = require('../src/services/gemini');
  // Opening double, no matching close -> not a wrapper.
  assert.strictEqual(cleanDraft(`"Mixed' wrapper`), `"Mixed' wrapper`);
  // Quotes entirely mid-string.
  assert.strictEqual(cleanDraft('She said "hello" to him'), 'She said "hello" to him');
  // First/last chars match but the inner text holds an ODD count -> peeling
  // would leave a dangling quote, so it stays put.
  assert.strictEqual(cleanDraft('"He said "hi"'), '"He said "hi"');
  // Curly open with a straight close is not a matching pair.
  assert.strictEqual(cleanDraft('“Mismatched"'), '“Mismatched"');
});

test('cleanDraft leaves two quoted phrases that merely bookend the string', () => {
  const { cleanDraft } = require('../src/services/gemini');
  // First/last chars match and the inner count is even, but the opening quote
  // CLOSES at "pop" — it never enclosed the whole string, so it is not a wrapper.
  assert.strictEqual(
    cleanDraft(`"Make it pop" isn't a brief. "Stop endless review rounds."`),
    `"Make it pop" isn't a brief. "Stop endless review rounds."`
  );
  assert.strictEqual(
    cleanDraft('"Hello," she said, "goodbye."'),
    '"Hello," she said, "goodbye."'
  );
  // Same shape with markdown emphasis: two italic runs, not one wrapper.
  assert.strictEqual(cleanDraft('*Hello* and *world*'), '*Hello* and *world*');
});

test('cleanDraft strips only the OUTER wrapper when quotes nest', () => {
  const { cleanDraft } = require('../src/services/gemini');
  assert.strictEqual(cleanDraft('"He said "hi" loudly"'), 'He said "hi" loudly');
  assert.strictEqual(cleanDraft('“He said “hi” loudly”'), 'He said “hi” loudly');
});

test('cleanDraft still trims whitespace and handles empty input', () => {
  const { cleanDraft } = require('../src/services/gemini');
  assert.strictEqual(cleanDraft('   padded copy   '), 'padded copy');
  assert.strictEqual(cleanDraft('"  padded inside  "'), 'padded inside');
  assert.strictEqual(cleanDraft(''), '');
  assert.strictEqual(cleanDraft('"'), '"'); // lone quote is not a pair
});

test('cleanCampaignTitle shares cleanDraft, so the two cannot drift', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'destinations', 'googleDocs.js'), 'utf8'
  );
  assert.ok(/cleanDraft/.test(src), 'googleDocs imports cleanDraft');
  assert.ok(
    !/\^\[\*_"'“”‘’\\s\]\+/.test(src),
    'the old blanket quote-strip regex is gone from googleDocs.js'
  );
  const gsrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'gemini.js'), 'utf8'
  );
  assert.ok(
    !/\^\[\*_"'“”‘’\\s\]\+/.test(gsrc),
    'the old blanket quote-strip regex is gone from gemini.js'
  );
});

// --- Per-user credentials: user_tokens + user_slack_links ------------------
//
// The regression these cover: Google tokens lived on tenant_tokens keyed
// (tenant_id, service) and the Slack link was a single (slack_team_id,
// slack_user_id) pair on the tenants ROW. Two people on one tenant therefore
// overwrote each other — the second signer's Google token became the whole
// team's writing identity, and the second person to connect Slack unlinked the
// first, whose /quillio then hit the unlinked refusal.
//
// These drive the REAL src/db.js and src/db/users.js SQL against an in-memory
// pool stubbed in for `pg`, so the accessors' actual queries are exercised. The
// fake THROWS on any query it doesn't recognize, so it cannot silently drift
// away from the SQL the modules really issue.

function makeFakePool(seed) {
  const db = {
    tenants: JSON.parse(JSON.stringify(seed.tenants || [])),
    users: JSON.parse(JSON.stringify(seed.users || [])),
    tenant_tokens: JSON.parse(JSON.stringify(seed.tenant_tokens || [])),
    user_tokens: JSON.parse(JSON.stringify(seed.user_tokens || [])),
    user_slack_links: JSON.parse(JSON.stringify(seed.user_slack_links || [])),
  };
  const same = (a, b) => String(a) === String(b);
  const rows = (r) => ({ rows: r, rowCount: r.length });
  // Tables/columns that do not exist yet, to model a deploy that lands before
  // the migration runs. Raises the same SQLSTATEs Postgres does.
  const missingTables = new Set(seed.missingTables || []);
  const missingColumns = new Set(seed.missingColumns || []);

  async function query(text, params = []) {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    const has = (...frags) => frags.every((f) => sql.includes(f));

    for (const t of missingTables) {
      if (new RegExp('\\b' + t + '\\b').test(sql)) {
        const err = new Error(`relation "${t}" does not exist`);
        err.code = '42P01'; // undefined_table
        throw err;
      }
    }
    for (const c of missingColumns) {
      if (new RegExp('\\b' + c + '\\b').test(sql)) {
        const err = new Error(`column "${c}" of relation "projects" does not exist`);
        err.code = '42703'; // undefined_column
        throw err;
      }
    }

    if (has('FROM users', 'WHERE id = $1')) {
      return rows(db.users.filter((u) => same(u.id, params[0])));
    }
    if (has('FROM users', 'WHERE google_id = $1')) {
      return rows(db.users.filter((u) => u.google_id === params[0]));
    }
    if (has('SELECT access_token FROM user_tokens')) {
      return rows(
        db.user_tokens
          .filter((t) => same(t.user_id, params[0]) && t.service === params[1])
          .map((t) => ({ access_token: t.access_token }))
      );
    }
    if (has('INSERT INTO user_tokens')) {
      const [userId, service, token] = params;
      const existing = db.user_tokens.find((t) => same(t.user_id, userId) && t.service === service);
      if (existing) existing.access_token = token;
      else db.user_tokens.push({ user_id: userId, service, access_token: token });
      return rows([]);
    }
    if (has('FROM user_slack_links l', 'JOIN users u')) {
      const link = db.user_slack_links.find(
        (l) => l.slack_team_id === params[0] && l.slack_user_id === params[1]
      );
      const user = link ? db.users.find((u) => same(u.id, link.user_id)) : null;
      return rows(user ? [user] : []);
    }
    if (has('SELECT slack_team_id, slack_user_id FROM user_slack_links')) {
      return rows(db.user_slack_links.filter((l) => same(l.user_id, params[0])));
    }
    if (has('INSERT INTO user_slack_links')) {
      const [userId, teamId, slackUserId] = params;
      const existing = db.user_slack_links.find(
        (l) => l.slack_team_id === teamId && l.slack_user_id === slackUserId
      );
      // Mirrors the conditional ON CONFLICT: a fresh identity inserts, the same
      // user re-linking is an idempotent no-op success, and another user's claim
      // matches the guarded WHERE zero times.
      if (!existing) {
        db.user_slack_links.push({ user_id: userId, slack_team_id: teamId, slack_user_id: slackUserId });
        return rows([{ user_id: userId }]);
      }
      if (same(existing.user_id, userId)) return rows([{ user_id: userId }]);
      return rows([]);
    }
    if (has('UPDATE tenants SET slack_team_id')) {
      const [tenantId, teamId, slackUserId] = params;
      // uq_tenants_slack_link: the pair may be held by exactly one tenant.
      const holder = db.tenants.find(
        (t) => t.slack_team_id === teamId && t.slack_user_id === slackUserId && !same(t.id, tenantId)
      );
      if (holder) {
        const err = new Error('duplicate key value violates unique constraint "uq_tenants_slack_link"');
        err.code = '23505';
        throw err;
      }
      const target = db.tenants.find((t) => same(t.id, tenantId));
      if (target) {
        target.slack_team_id = teamId;
        target.slack_user_id = slackUserId;
      }
      return rows([]);
    }
    if (has('FROM tenants', 'WHERE id = $1 OR workspace_id = $1')) {
      return rows(db.tenants.filter((t) => same(t.id, params[0]) || same(t.workspace_id, params[0])));
    }
    if (has('FROM tenants', 'WHERE slack_team_id = $1 AND slack_user_id = $2')) {
      return rows(
        db.tenants.filter((t) => t.slack_team_id === params[0] && t.slack_user_id === params[1])
      );
    }
    if (has('SELECT access_token FROM tenant_tokens')) {
      return rows(
        db.tenant_tokens
          .filter((t) => same(t.tenant_id, params[0]) && t.service === params[1])
          .map((t) => ({ access_token: t.access_token }))
      );
    }
    throw new Error('fake pool: unhandled query → ' + sql);
  }

  return { pool: { query, connect: async () => ({ query, release() {} }) }, db };
}

// Install the fake pool as `pg`, reload the DB modules against it, run `fn`, and
// restore require.cache + the environment exactly as they were.
function withFakeDb(seed, fn) {
  const saved = new Map();
  const remember = (p) => {
    if (!saved.has(p)) saved.set(p, require.cache[p]);
  };
  const rel = (r) => require.resolve(path.join(__dirname, '..', r));
  const savedUrl = process.env.DATABASE_URL;
  const fake = makeFakePool(seed);

  // db.js lazy-requires 'pg' inside getPool(), so stubbing the module is enough.
  const pgPath = require.resolve('pg');
  remember(pgPath);
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    path: path.dirname(pgPath),
    loaded: true,
    exports: { Pool: function () { return fake.pool; } },
    children: [],
    paths: [],
  };

  process.env.DATABASE_URL = 'postgres://fake/quillio';
  // Reload so db.js memoizes the stubbed pool and db/users re-binds getPool.
  const reloaded = {};
  for (const [key, r] of [['db', 'src/db'], ['users', 'src/db/users']]) {
    const p = rel(r);
    remember(p);
    delete require.cache[p];
    reloaded[key] = require(p);
  }

  return Promise.resolve(fn(reloaded, fake)).finally(() => {
    for (const [p, mod] of saved) {
      if (mod === undefined) delete require.cache[p];
      else require.cache[p] = mod;
    }
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });
}

// Alice (#1) and Bob (#2) share tenant T_SHARED. The tenant also still carries a
// legacy tenant_tokens google row — the pre-split credential — so the fallback
// order is exercised alongside the per-user tokens.
const TWO_USER_TENANT = {
  tenants: [{ id: 'T_SHARED', workspace_id: 'T_SHARED', workspace_name: 'Shared Co.' }],
  users: [
    { id: 1, email: 'alice@example.test', tenant_id: 'T_SHARED', role: 'owner' },
    { id: 2, email: 'bob@example.test', tenant_id: 'T_SHARED', role: 'owner' },
  ],
  tenant_tokens: [{ tenant_id: 'T_SHARED', service: 'google', access_token: 'goog-LEGACY-tenant' }],
};

test('two users on one tenant each hold their OWN Google token', async () => {
  await withFakeDb(TWO_USER_TENANT, async ({ db, users }, fake) => {
    // Both sign in with Google. Under the old scheme these were two upserts on
    // the same (tenant_id, 'google') row and Bob's clobbered Alice's.
    assert.strictEqual(await users.saveUserToken(1, 'google', 'goog-alice'), true);
    assert.strictEqual(await users.saveUserToken(2, 'google', 'goog-bob'), true);

    // Both survive, independently.
    assert.strictEqual(await users.getUserToken(1, 'google'), 'goog-alice');
    assert.strictEqual(await users.getUserToken(2, 'google'), 'goog-bob');

    // Bob re-connecting (a token refresh) still does not touch Alice's.
    await users.saveUserToken(2, 'google', 'goog-bob-v2');
    assert.strictEqual(await users.getUserToken(2, 'google'), 'goog-bob-v2');
    assert.strictEqual(await users.getUserToken(1, 'google'), 'goog-alice', "Alice's token survives Bob's write");

    // …and resolveTenant hands each of them their own, on the SAME tenant.
    const alice = await db.resolveTenant('T_SHARED', null, 1);
    const bob = await db.resolveTenant('T_SHARED', null, 2);
    assert.strictEqual(alice.tenant.id, 'T_SHARED');
    assert.strictEqual(bob.tenant.id, 'T_SHARED', 'same tenant for both');
    assert.strictEqual(alice.tokens.google, 'goog-alice');
    assert.strictEqual(bob.tokens.google, 'goog-bob-v2');
    assert.strictEqual(alice.user.id, 1, 'the acting user comes back on the context');
    assert.strictEqual(bob.user.id, 2);

    // With no acting user, the deprecated tenant-level token is still the
    // fallback, so credentials that predate the split keep working.
    const anonymous = await db.resolveTenant('T_SHARED');
    assert.strictEqual(anonymous.tokens.google, 'goog-LEGACY-tenant');
    assert.strictEqual(anonymous.user, null);

    // Two distinct per-user rows exist; the tenant row was never rewritten.
    assert.strictEqual(fake.db.user_tokens.filter((t) => t.service === 'google').length, 2);
    assert.strictEqual(fake.db.tenant_tokens[0].access_token, 'goog-LEGACY-tenant');
  });
});

test('two users on one tenant can EACH be Slack-linked', async () => {
  await withFakeDb(TWO_USER_TENANT, async ({ db, users }, fake) => {
    // The pair that was impossible before: one tenant row held one link, so the
    // second of these overwrote the first.
    assert.deepStrictEqual(await users.linkSlackIdentityToUser(1, 'T_TEAM', 'U_ALICE'), {
      ok: true,
      conflict: false,
    });
    assert.deepStrictEqual(await users.linkSlackIdentityToUser(2, 'T_TEAM', 'U_BOB'), {
      ok: true,
      conflict: false,
    });
    assert.strictEqual(fake.db.user_slack_links.length, 2, 'both links coexist');

    // Each Slack identity resolves to its own user, and both land on the tenant.
    const alice = await db.resolveTenant('T_TEAM', 'U_ALICE');
    const bob = await db.resolveTenant('T_TEAM', 'U_BOB');
    for (const [who, ctx, id] of [['alice', alice, 1], ['bob', bob, 2]]) {
      assert.ok(!ctx.unlinked, `${who} is NOT refused as unlinked`);
      assert.strictEqual(ctx.user.id, id, `${who} resolves to their own user`);
      assert.strictEqual(ctx.tenant.id, 'T_SHARED', `${who} resolves to the shared tenant`);
    }

    // Re-connecting the same Slack account is an idempotent success, not a clash.
    assert.deepStrictEqual(await users.linkSlackIdentityToUser(1, 'T_TEAM', 'U_ALICE'), {
      ok: true,
      conflict: false,
    });

    // Someone else claiming Alice's Slack identity is REFUSED and reported —
    // this is the case that used to be swallowed as a logged 23505 while the
    // install still told the person "Slack connected".
    assert.deepStrictEqual(await users.linkSlackIdentityToUser(2, 'T_TEAM', 'U_ALICE'), {
      ok: false,
      conflict: true,
    });
    const stillAlice = await db.resolveTenant('T_TEAM', 'U_ALICE');
    assert.strictEqual(stillAlice.user.id, 1, "Alice's link is untouched by the refused claim");

    // An unknown Slack identity still gets the unlinked refusal, unchanged.
    const stranger = await db.resolveTenant('T_TEAM', 'U_NOBODY');
    assert.strictEqual(stranger.unlinked, true);
    assert.strictEqual(stranger.tenant, null);
    assert.strictEqual(stranger.tokens, null);
  });
});

test('the legacy tenants.slack_* link still resolves (deprecated fallback)', async () => {
  // A deploy can land before the backfill migration runs; existing Slack users
  // must not all start hitting the unlinked refusal.
  await withFakeDb(
    {
      tenants: [
        { id: 'T_OLD', workspace_id: 'T_OLD', slack_team_id: 'T_TEAM', slack_user_id: 'U_LEGACY' },
      ],
      users: [],
      tenant_tokens: [{ tenant_id: 'T_OLD', service: 'google', access_token: 'goog-legacy' }],
    },
    async ({ db }) => {
      const ctx = await db.resolveTenant('T_TEAM', 'U_LEGACY');
      assert.ok(!ctx.unlinked, 'a pre-migration link is not refused');
      assert.strictEqual(ctx.tenant.id, 'T_OLD');
      assert.strictEqual(ctx.tokens.google, 'goog-legacy');
      assert.strictEqual(ctx.user, null, 'no user record behind a legacy tenant link');
    }
  );
});

// --- The acting user's token is the one that performs the write -------------

// Same idea as withFakeDb, plus a stubbed `googleapis` so we can capture exactly
// which refresh token reaches the OAuth2 client that Drive/Docs are built on.
function withFakeGoogle(seed, fn) {
  const saved = new Map();
  const remember = (p) => {
    if (!saved.has(p)) saved.set(p, require.cache[p]);
  };
  const rel = (r) => require.resolve(path.join(__dirname, '..', r));
  const savedEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  };
  const fake = makeFakePool(seed);
  const captured = { credentials: [], driveAuth: [] };

  const pgPath = require.resolve('pg');
  remember(pgPath);
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, path: path.dirname(pgPath), loaded: true,
    exports: { Pool: function () { return fake.pool; } }, children: [], paths: [],
  };

  // Minimal googleapis stand-in: enough surface for src/google.js, and it records
  // the credentials each client is built with.
  function OAuth2() {
    this.kind = 'oauth2';
    this.setCredentials = (creds) => {
      this.credentials = creds;
      captured.credentials.push(creds);
    };
  }
  const fakeGoogle = {
    options: () => {},
    auth: {
      OAuth2,
      GoogleAuth: function () {
        this.getClient = async () => ({ kind: 'service-account' });
      },
    },
    drive: ({ auth }) => {
      captured.driveAuth.push(auth);
      return { kind: 'drive', auth };
    },
    docs: ({ auth }) => ({ kind: 'docs', auth }),
  };
  const gapiPath = require.resolve('googleapis');
  remember(gapiPath);
  require.cache[gapiPath] = {
    id: gapiPath, filename: gapiPath, path: path.dirname(gapiPath), loaded: true,
    exports: { google: fakeGoogle }, children: [], paths: [],
  };

  process.env.DATABASE_URL = 'postgres://fake/quillio';
  process.env.GOOGLE_CLIENT_ID = 'fake-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret';
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@example.test' });

  const reloaded = {};
  for (const [key, r] of [['config', 'src/config'], ['db', 'src/db'], ['users', 'src/db/users'], ['google', 'src/google']]) {
    const p = rel(r);
    remember(p);
    delete require.cache[p];
    reloaded[key] = require(p);
  }

  return Promise.resolve(fn(reloaded, captured, fake)).finally(() => {
    for (const [p, mod] of saved) {
      if (mod === undefined) delete require.cache[p];
      else require.cache[p] = mod;
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("Drive/Docs write as the ACTING user's Google identity, not the tenant's", async () => {
  const seed = {
    ...TWO_USER_TENANT,
    user_tokens: [
      { user_id: 1, service: 'google', access_token: 'goog-alice' },
      { user_id: 2, service: 'google', access_token: 'goog-bob' },
    ],
  };
  await withFakeGoogle(seed, async ({ google }, captured) => {
    // 1. Token SELECTION, in priority order.
    assert.deepStrictEqual(
      await google.resolveGoogleRefreshToken({ tenantId: 'T_SHARED', userId: 1 }),
      { token: 'goog-alice', source: 'user' }
    );
    assert.deepStrictEqual(
      await google.resolveGoogleRefreshToken({ tenantId: 'T_SHARED', userId: 2 }),
      { token: 'goog-bob', source: 'user' }
    );
    // No acting user → the deprecated tenant token, so pre-split data still works.
    assert.deepStrictEqual(
      await google.resolveGoogleRefreshToken({ tenantId: 'T_SHARED' }),
      { token: 'goog-LEGACY-tenant', source: 'tenant' }
    );
    // A user with no token of their own falls back rather than failing.
    assert.deepStrictEqual(
      await google.resolveGoogleRefreshToken({ tenantId: 'T_SHARED', userId: 99 }),
      { token: 'goog-LEGACY-tenant', source: 'tenant' }
    );

    // 2. The client that actually performs the write carries that token.
    captured.credentials.length = 0;
    const aliceClients = await google.getClientsForTenant({ tenantId: 'T_SHARED', userId: 1 });
    assert.deepStrictEqual(captured.credentials.at(-1), { refresh_token: 'goog-alice' });
    assert.strictEqual(aliceClients.usingOAuth, true);
    assert.strictEqual(aliceClients.drive.auth.credentials.refresh_token, 'goog-alice');
    assert.strictEqual(aliceClients.docs.auth.credentials.refresh_token, 'goog-alice');

    const bobClients = await google.getClientsForTenant({ tenantId: 'T_SHARED', userId: 2 });
    assert.strictEqual(bobClients.drive.auth.credentials.refresh_token, 'goog-bob');

    // The two writers on one tenant are genuinely different Drive identities.
    assert.notStrictEqual(
      aliceClients.drive.auth.credentials.refresh_token,
      bobClients.drive.auth.credentials.refresh_token
    );

    // 3. The legacy positional call (a bare tenant id) still works unchanged.
    const legacy = await google.getClientsForTenant('T_SHARED');
    assert.strictEqual(legacy.drive.auth.credentials.refresh_token, 'goog-LEGACY-tenant');
  });
});

// --- Wiring: the acting user reaches the write + authorship paths -----------

test('both adapters thread the acting user into Drive writes and project authorship', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  const web = read('src/adapters/web.js');
  assert.ok(/actingUserId\(tenantContext\)/.test(web), 'web adapter derives the acting user');
  assert.ok(/getClientsForTenant\(\{ tenantId, userId/.test(web), 'web passes the user into the Google clients');
  assert.ok(/createdBy: userId/.test(web), 'web records the session user as the author');

  const slack = read('src/adapters/slackWorkflow.js');
  assert.ok(/const actingUserId = \(user && user\.id\) \|\| null/.test(slack), 'slack derives the acting user from the resolved link');
  assert.ok(/getClientsForTenant\(\{ tenantId, userId: actingUserId \}\)/.test(slack), 'slack passes the user into the Google clients');
  assert.ok(/createdBy: actingUserId/.test(slack), 'slack records the commanding user as the author');

  const review = read('src/adapters/slackReview.js');
  assert.ok(/getClientsForTenant\(\{ tenantId, userId: actingUserId \}\)/.test(review), 'review runs as the acting user');

  // The web routes must pass the session user into resolveTenant, or the adapter
  // would see user:null and silently fall back to the tenant's credentials.
  const routes = read('src/routes/app.js');
  assert.ok(/resolveTenant\(sessionTenant, null, sessionUserId\)/.test(routes), 'brief/draft/review resolve for the session user');

  // created_by must actually reach the INSERT.
  const projects = read('src/db/projects.js');
  assert.ok(/created_by/.test(projects) && /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10\)/.test(projects), 'saveProject inserts created_by');
  const pipeline = read('src/core/pipeline.js');
  assert.ok(/created_by: projectMeta\.createdBy/.test(pipeline), 'pipeline passes createdBy through to saveProject');
});

test('a Slack link conflict is surfaced to the user, never swallowed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oauth.js'), 'utf8');
  // The old code caught 23505, logged a warning and fell through to the success
  // redirect — so the person saw "Slack connected" while their commands kept
  // resolving to another tenant.
  assert.ok(!/e\.code === '23505'/.test(src), 'no longer swallows the unique-violation');
  assert.ok(/linkSlackIdentityToUser/.test(src), 'links the Slack identity to the user');
  assert.ok(/slackLinkFailure = 'already_linked'/.test(src), 'a conflict is recorded as a failure');
  assert.ok(/if \(slackLinkFailure\) \{/.test(src), 'and branched on before any success response');
  assert.ok(/slackPopupResult\('conflict'\)/.test(src) || /'conflict' : 'failed'/.test(src), 'popup installs report the conflict');
  assert.ok(/slack=error&reason=\$\{slackLinkFailure\}/.test(src), 'redirect installs report the conflict');

  // …and the Settings UI renders that state instead of a success banner.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  assert.ok(/params\.get\('slack'\) === 'error'/.test(html), 'settings handles ?slack=error');
  assert.ok(/already_linked/.test(html), 'settings explains the already-linked case');
});

// --- Deploy-before-migration safety ----------------------------------------
//
// Railway auto-deploys main on merge, so this code CAN and WILL run against a
// database that has not had scripts/migrateAddUserCredentials.js applied yet.
// Every read and write against the new schema must degrade to the pre-migration
// behavior instead of throwing — otherwise the merge takes the product down
// until someone opens the Railway console.
//
// Unmigrated shape: a legacy tenant-row Slack link and a tenant-level Google
// token, with none of the new schema present.
const UNMIGRATED = {
  missingTables: ['user_tokens', 'user_slack_links'],
  missingColumns: ['created_by'],
  tenants: [
    {
      id: 'T_LEGACY',
      workspace_id: 'T_LEGACY',
      workspace_name: 'Legacy Co.',
      slack_team_id: 'T_TEAM',
      slack_user_id: 'U_KYLE',
    },
    { id: 'T_RIVAL', workspace_id: 'T_RIVAL', workspace_name: 'Rival Co.' },
  ],
  users: [
    { id: 1, email: 'kyle@example.test', tenant_id: 'T_LEGACY', role: 'owner' },
    { id: 9, email: 'rival@example.test', tenant_id: 'T_RIVAL', role: 'owner' },
  ],
  tenant_tokens: [{ tenant_id: 'T_LEGACY', service: 'google', access_token: 'goog-legacy' }],
};

test('resolveTenant survives a deploy that lands BEFORE the migration', async () => {
  await withFakeDb(UNMIGRATED, async ({ db }) => {
    // The Slack path used to throw 42P01 straight out of resolveTenant, so every
    // /quillio failed. It must fall through to the legacy tenants.slack_* read.
    const ctx = await db.resolveTenant('T_TEAM', 'U_KYLE');
    assert.ok(!ctx.unlinked, 'an existing Slack user is NOT refused pre-migration');
    assert.strictEqual(ctx.tenant.id, 'T_LEGACY');
    assert.strictEqual(ctx.tokens.google, 'goog-legacy', 'falls back to the tenant-level token');

    // The unlinked refusal still works for a genuinely unknown identity.
    const stranger = await db.resolveTenant('T_TEAM', 'U_NOBODY');
    assert.strictEqual(stranger.unlinked, true);

    // The web path also resolves, falling back to the tenant token.
    const web = await db.resolveTenant('T_LEGACY', null, 1);
    assert.strictEqual(web.tenant.id, 'T_LEGACY');
    assert.strictEqual(web.tokens.google, 'goog-legacy');
  });
});

test('per-user credential writes degrade (not throw) before the migration', async () => {
  await withFakeDb(UNMIGRATED, async ({ users }) => {
    // Google sign-in: a throw here aborts the OAuth callback and sends the user
    // to /app?error=google_failed, i.e. sign-in breaks entirely.
    assert.strictEqual(await users.saveUserToken(1, 'google', 'x'), false, 'reports "not stored" instead of throwing');
    assert.strictEqual(await users.getUserToken(1, 'google'), null);

    // Settings reads the user's links; [] lets it fall back to the tenant row.
    assert.deepStrictEqual(await users.getSlackLinksForUser(1), []);

    // Connecting Slack still works, via the legacy one-per-tenant write.
    const linked = await users.linkSlackIdentityToUser(1, 'T_TEAM', 'U_KYLE');
    assert.deepStrictEqual(linked, { ok: true, conflict: false, legacy: true });

    // …and a taken identity is STILL refused rather than reported as connected —
    // the whole point of the fix must hold in the unmigrated window too.
    const stolen = await users.linkSlackIdentityToUser(9, 'T_TEAM', 'U_KYLE');
    assert.deepStrictEqual(stolen, { ok: false, conflict: true, legacy: true });
  });
});

test('a project is still recorded when projects.created_by is missing', async () => {
  // Losing the row entirely would be far worse than a NULL author for a few
  // minutes, so the INSERT retries without the column.
  const inserts = [];
  await withFakeDb(UNMIGRATED, async (_mods, fake) => {
    const origQuery = fake.pool.query;
    fake.pool.query = async (text, params) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (sql.startsWith('INSERT INTO projects')) {
        inserts.push(sql);
        if (sql.includes('created_by')) {
          const err = new Error('column "created_by" of relation "projects" does not exist');
          err.code = '42703';
          throw err;
        }
        return { rows: [{ id: 7, tenant_id: params[0], created_by: null }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT * FROM projects')) return { rows: [], rowCount: 0 };
      return origQuery(text, params);
    };
    const rel = require.resolve(path.join(__dirname, '..', 'src/db/projects'));
    delete require.cache[rel];
    const { saveProject } = require(rel);
    const saved = await saveProject('T_LEGACY', { name: 'X', copy_doc_id: 'D1', created_by: 1 });
    assert.ok(saved, 'the project row is still persisted');
    assert.strictEqual(saved.id, 7);
  });
  assert.strictEqual(inserts.length, 2, 'tried with created_by, then retried without');
  assert.ok(inserts[0].includes('created_by'));
  assert.ok(!inserts[1].includes('created_by'));
});

test('the missing-schema catch is narrow — real errors still throw', async () => {
  // Only 42P01 / 42703 are treated as "not migrated yet". A permissions problem,
  // a bad connection or a constraint violation must NOT be silently swallowed.
  await withFakeDb(UNMIGRATED, async ({ users }, fake) => {
    fake.pool.query = async () => {
      const err = new Error('permission denied for table user_tokens');
      err.code = '42501'; // insufficient_privilege
      throw err;
    };
    await assert.rejects(() => users.getUserToken(1, 'google'), /permission denied/);
    await assert.rejects(() => users.saveUserToken(1, 'google', 'x'), /permission denied/);
    await assert.rejects(() => users.getSlackLinksForUser(1), /permission denied/);
  });
});

// --- Instance ordinals: widening the two composite identity keys -------------
// Asset identity is the asset NAME, used as half of ctxKey (googleDocs) and
// fieldKey (copyReview). Both now take an optional 0-based instance ordinal so a
// doc carrying the same asset twice can be told apart. Nothing produces a second
// instance yet — these lock the default and the new slot.

test('instance keys: the DEFAULT ordinal serializes BYTE-IDENTICALLY', () => {
  const { ctxKey } = require('../src/destinations/googleDocs');
  const { fieldKey } = require('../src/services/copyReview');
  const { instanceTag } = require('../src/utils/instanceKey');

  // These literals are what the pre-instance implementations produced:
  //   ctxKey   = `${asset.trim().toLowerCase()}|${field.trim().toLowerCase()}`
  //   fieldKey = `${asset.trim().toLowerCase()}||${field.trim().toLowerCase()}`
  // fieldKey's output is persisted verbatim as jsonb object keys in
  // doc_reviews.state, so a changed default orphans live review state.
  assert.strictEqual(ctxKey('Demand Gen Nurture Email', 'Subject Line 1'), 'demand gen nurture email|subject line 1');
  assert.strictEqual(fieldKey('Demand Gen Nurture Email', 'Subject Line 1'), 'demand gen nurture email||subject line 1');

  // Absent, 0, and every other default-ish value all serialize to the same string.
  for (const d of [undefined, null, 0, '', '0', NaN, -1, false]) {
    assert.strictEqual(ctxKey('Email', 'H', d), ctxKey('Email', 'H'), `ctxKey default for ${String(d)}`);
    assert.strictEqual(fieldKey('Email', 'H', d), fieldKey('Email', 'H'), `fieldKey default for ${String(d)}`);
  }
  assert.strictEqual(instanceTag(0), '');
  assert.strictEqual(instanceTag(undefined), '');

  // Trim + lowercase normalization is untouched by the widening.
  assert.strictEqual(ctxKey('  Email  ', '  Headline  '), 'email|headline');
  assert.strictEqual(fieldKey('  Email  ', '  Headline  '), 'email||headline');
  // fieldKey tolerates a null asset (''), ctxKey stringifies it — preserved as-is.
  assert.strictEqual(fieldKey(null, 'H'), '||h');
  assert.strictEqual(ctxKey(null, 'H'), 'null|h');
});

test('instance keys: distinct ordinals produce distinct keys, tagged on the ASSET half', () => {
  const { ctxKey } = require('../src/destinations/googleDocs');
  const { fieldKey, keyInScope } = require('../src/services/copyReview');

  assert.strictEqual(ctxKey('Email', 'Headline', 1), 'email#i1|headline');
  assert.strictEqual(ctxKey('Email', 'Headline', 2), 'email#i2|headline');
  assert.strictEqual(fieldKey('Email', 'Headline', 1), 'email#i1||headline');
  assert.strictEqual(fieldKey('Email', 'Headline', 2), 'email#i2||headline');

  const ctx = new Set([0, 1, 2, 3].map((n) => ctxKey('Email', 'Headline', n)));
  const fld = new Set([0, 1, 2, 3].map((n) => fieldKey('Email', 'Headline', n)));
  assert.strictEqual(ctx.size, 4, 'four ordinals → four ctxKeys');
  assert.strictEqual(fld.size, 4, 'four ordinals → four fieldKeys');

  // The tag sits on the asset half specifically so keyInScope's variation SUFFIX
  // match (`${fieldKey} · option N (Doorway)`) keeps working per instance.
  const scope = new Set([fieldKey('Email', 'CTA', 1)]);
  assert.ok(keyInScope(fieldKey('Email', 'CTA', 1) + ' · option 2 (proof)', scope), 'own variation in scope');
  assert.ok(!keyInScope(fieldKey('Email', 'CTA', 2) + ' · option 2 (proof)', scope), 'another instance is not');
  assert.ok(!keyInScope(fieldKey('Email', 'CTA'), scope), 'the default instance is not in instance 1 scope');
});

test('instanceCounter: 0-based per-name ordinals in document order', () => {
  const { instanceCounter } = require('../src/utils/instanceKey');
  const next = instanceCounter();
  assert.strictEqual(next('Email'), 0, 'first occurrence is the unmarked default');
  assert.strictEqual(next('Landing Page'), 0, 'per-name, not global');
  assert.strictEqual(next('Email'), 1);
  assert.strictEqual(next(' email '), 2, 'trim + case-insensitive: the same asset');
  assert.strictEqual(next('EMAIL'), 3);
  assert.strictEqual(instanceCounter()('Email'), 0, 'counters are independent');
});

test('duplicate asset heading: each instance gets its OWN siblings (byAsset fix)', () => {
  const { selectReviewTargets, fieldKey } = require('../src/services/copyReview');
  // What a hand-edited doc with a pasted asset section parses to: one name, twice.
  const content = {
    assets: [
      { name: 'Email', fields: [
        { fieldName: 'Headline', charMax: 60, copy: 'A-headline' },
        { fieldName: 'Subhead', charMax: 80, copy: 'A-subhead' },
      ] },
      { name: 'Email', fields: [
        { fieldName: 'Headline', charMax: 60, copy: 'B-headline' },
        { fieldName: 'Subhead', charMax: 80, copy: 'B-subhead' },
      ] },
    ],
  };

  // The collectors attach the ordinal, in document order.
  const whole = selectReviewTargets(content, null);
  assert.deepStrictEqual(
    whole.singles.map((f) => [f.assetType, f.instance, f.copy]),
    [['Email', 0, 'A-headline'], ['Email', 0, 'A-subhead'], ['Email', 1, 'B-headline'], ['Email', 1, 'B-subhead']]
  );

  // Scoping instance 1's Headline selects ONLY it — instance 0's identically
  // named field is a different key now.
  const s1 = selectReviewTargets(content, new Set([fieldKey('Email', 'Headline', 1)]));
  assert.strictEqual(s1.singles.length, 1);
  assert.strictEqual(s1.singles[0].copy, 'B-headline');
  // THE FIX: siblings come from instance 1 — not from whichever instance the
  // byAsset Map happened to see last (which used to be instance 1 for BOTH).
  assert.deepStrictEqual(s1.singles[0].siblings, [{ fieldName: 'Subhead', copy: 'B-subhead' }]);

  const s0 = selectReviewTargets(content, new Set([fieldKey('Email', 'Headline', 0)]));
  assert.strictEqual(s0.singles[0].copy, 'A-headline');
  assert.deepStrictEqual(s0.singles[0].siblings, [{ fieldName: 'Subhead', copy: 'A-subhead' }]);
});

test('duplicate asset heading: reconcileComments keeps the two instances apart', () => {
  const { reconcileComments, fieldKey } = require('../src/services/copyReview');
  const fields = [
    { assetType: 'Email', instance: 0, fieldName: 'Headline', copy: 'A-copy' },
    { assetType: 'Email', instance: 1, fieldName: 'Headline', copy: 'B-copy' },
  ];
  const verdicts = [
    { assetType: 'Email', instance: 0, fieldName: 'Headline', comment: 'note A' },
    { assetType: 'Email', instance: 1, fieldName: 'Headline', comment: 'note B' },
  ];
  const r = reconcileComments({ fields, priorFields: {}, verdicts, liveComments: [] });

  // Two state keys, each with its own verdict (pre-widening: one key, one note).
  assert.deepStrictEqual(
    Object.keys(r.nextState.fields).sort(),
    [fieldKey('Email', 'Headline', 0), fieldKey('Email', 'Headline', 1)].sort()
  );
  assert.strictEqual(r.nextState.fields[fieldKey('Email', 'Headline', 0)].comment, 'note A');
  assert.strictEqual(r.nextState.fields[fieldKey('Email', 'Headline', 1)].comment, 'note B');
  assert.strictEqual(r.toAdd.length, 2, 'distinct copy → both comments anchorable');

  // KNOWN LIMIT, deliberately unchanged here: when both instances hold IDENTICAL
  // copy the collision is in Drive's comment ANCHOR (quoted text), not in the key.
  // State stays correctly separated; the second comment is still skipped.
  const same = reconcileComments({
    fields: [
      { assetType: 'Email', instance: 0, fieldName: 'Headline', copy: 'identical' },
      { assetType: 'Email', instance: 1, fieldName: 'Headline', copy: 'identical' },
    ],
    priorFields: {},
    verdicts: [
      { assetType: 'Email', instance: 0, fieldName: 'Headline', comment: 'note A' },
      { assetType: 'Email', instance: 1, fieldName: 'Headline', comment: 'note B' },
    ],
    liveComments: [],
  });
  assert.strictEqual(Object.keys(same.nextState.fields).length, 2, 'state keys still distinct');
  assert.strictEqual(same.toAdd.length, 1, 'anchor-level dedupe unchanged by this refactor');
});

test('duplicate asset heading: insert indices stay per-instance (insertIndexByField fix)', () => {
  const { parseDoc, ctxKey } = require('../src/destinations/googleDocs');
  const { instanceCounter } = require('../src/utils/instanceKey');

  function makeDoc(paras) {
    let startIndex = 1;
    const content = paras.map((para) => {
      const raw = (para.text || '') + '\n';
      const endIndex = startIndex + raw.length;
      const item = {
        startIndex,
        endIndex,
        paragraph: {
          paragraphStyle: para.style ? { namedStyleType: para.style } : {},
          elements: [{ textRun: { content: raw, textStyle: { bold: !!para.bold, italic: !!para.italic } } }],
        },
      };
      startIndex = endIndex;
      return item;
    });
    return { body: { content } };
  }

  // Two sections with the SAME heading text and the SAME field name.
  const doc = makeDoc([
    { text: 'Campaign Summary', style: 'HEADING_2' },
    { text: 'sum', italic: true },
    { text: 'Writer Direction', style: 'HEADING_2' },
    { text: 'dir', italic: true },
    { text: 'Email', style: 'HEADING_3' },
    { text: 'Headline [50]', bold: true },
    { text: '' },
    { text: 'Email', style: 'HEADING_3' },
    { text: 'Headline [50]', bold: true },
    { text: '' },
  ]);

  // parseDoc is positional and already instance-safe (untouched by this step).
  const { assets } = parseDoc(doc);
  assert.strictEqual(assets.length, 2, 'both headings parsed');
  assert.strictEqual(assets[0].assetType, 'Email');
  assert.strictEqual(assets[1].assetType, 'Email');
  const idx0 = assets[0].fields[0].insertIndex;
  const idx1 = assets[1].fields[0].insertIndex;
  assert.ok(idx0 !== idx1 && idx0 != null && idx1 != null, 'the two instances sit at different positions');

  // The mapping generateDraft's post-delete re-parse performs. Pre-fix this was
  // keyed on ctxKey(assetType, fieldName) with no ordinal, so the second entry
  // OVERWROTE the first and both instances' copy resolved to idx1.
  const ordinal = instanceCounter();
  const insertIndexByField = new Map();
  for (const asset of assets) {
    const instance = ordinal(asset.assetType);
    for (const f of asset.fields) {
      insertIndexByField.set(ctxKey(asset.assetType, f.fieldName, instance), f.insertIndex);
    }
  }
  assert.strictEqual(insertIndexByField.size, 2, 'two entries, not one collapsed entry');
  assert.strictEqual(insertIndexByField.get(ctxKey('Email', 'Headline', 0)), idx0);
  assert.strictEqual(insertIndexByField.get(ctxKey('Email', 'Headline', 1)), idx1);

  // Without the ordinal, one key — the collapse this fixes.
  const collapsed = new Map();
  for (const asset of assets) {
    for (const f of asset.fields) collapsed.set(ctxKey(asset.assetType, f.fieldName), f.insertIndex);
  }
  assert.strictEqual(collapsed.size, 1, 'un-widened key collapses both instances');
  assert.strictEqual(collapsed.get(ctxKey('Email', 'Headline')), idx1, 'and the LAST one wins');
});

test('structural guard: generateDraft threads the instance ordinal through ctxKey', () => {
  const gd = fs.readFileSync(path.join(__dirname, '..', 'src', 'destinations', 'googleDocs.js'), 'utf8');
  // Every ctxKey CALL in generateDraft must pass a third argument, or a duplicate
  // heading silently collapses again. Definition + comments are excluded.
  const calls = gd
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /(?<![\w.])ctxKey\(/.test(line))
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line))
    .filter(({ line }) => !/function ctxKey\(/.test(line));
  assert.ok(calls.length >= 10, `expected the known ctxKey call sites, found ${calls.length}`);
  for (const { line, n } of calls) {
    for (const call of line.match(/(?<![\w.])ctxKey\([^)]*\)/g) || []) {
      const args = call.slice('ctxKey('.length, -1).split(',');
      assert.strictEqual(args.length, 3, `googleDocs.js:${n} — ctxKey call needs an instance arg: ${call.trim()}`);
    }
  }
  // Ordinals are assigned by the two READERS (one counter each) and read from the
  // stamped entry everywhere else — so no two loops can disagree about them.
  // (This replaced an earlier pair of assertions that pinned generateDraft's own
  // freshOrdinal/draftOrdinal counters, which the reader-stamped ordinal removed.)
  assert.strictEqual(
    (gd.match(/const assetOrdinal = instanceCounter\(\)/g) || []).length,
    2,
    'exactly two counters: one in parseDoc, one in getDocContent'
  );
  assert.ok(/instance: assetOrdinal\(text\)/.test(gd), 'readers stamp the ordinal onto each asset entry');
  // Those two declarations are the ONLY places a counter is created in this file,
  // so nothing (generateDraft included) re-derives an ordinal for itself.
  assert.strictEqual((gd.match(/instanceCounter\(\)/g) || []).length, 2, 'no third counter anywhere in the file');
  assert.ok(/instance: asset\.instance/.test(gd), 'assetTargets reads the stamped ordinal');
  assert.ok(/ctxKey\(asset\.assetType, f\.fieldName, asset\.instance\)/.test(gd), 're-parse keys off the stamped ordinal');
});

// --- Instance ordinals, step 2: the READ path -------------------------------
// parseDoc and getDocContent now stamp a 0-based per-heading-text ordinal on each
// asset entry, so a doc carrying one asset twice reads back distinguishably.
// Still nothing can PRODUCE a second instance — appendBody is untouched.

// Builds a Google Docs `documents.get` payload from a flat paragraph list.
function instDoc(paras) {
  let startIndex = 1;
  const content = paras.map((para) => {
    const raw = (para.text || '') + '\n';
    const endIndex = startIndex + raw.length;
    const item = {
      startIndex,
      endIndex,
      paragraph: {
        paragraphStyle: para.style ? { namedStyleType: para.style } : {},
        elements: [{ textRun: { content: raw, textStyle: { bold: !!para.bold, italic: !!para.italic } } }],
      },
    };
    startIndex = endIndex;
    return item;
  });
  return { title: 'T', body: { content } };
}

// One asset heading, twice, each with identically-named fields and its own copy.
const TWO_INSTANCE_PARAS = [
  { text: 'Campaign Summary', style: 'HEADING_2' },
  { text: 'sum', italic: true },
  { text: 'Writer Direction', style: 'HEADING_2' },
  { text: 'dir', italic: true },
  { text: 'Demand Gen Nurture Email', style: 'HEADING_3' },
  { text: 'Subject Line 1 [50-75]', bold: true },
  { text: 'A-subject' },
  { text: 'Preheader [85-120]', bold: true },
  { text: 'A-preheader' },
  { text: 'Demand Gen Nurture Email', style: 'HEADING_3' },
  { text: 'Subject Line 1 [50-75]', bold: true },
  { text: 'B-subject' },
  { text: 'Preheader [85-120]', bold: true },
  { text: 'B-preheader' },
];

test('read path: parseDoc stamps 0/1 ordinals on a repeated asset heading', () => {
  const { parseDoc, ctxKey } = require('../src/destinations/googleDocs');
  const { assets } = parseDoc(instDoc(TWO_INSTANCE_PARAS));

  assert.strictEqual(assets.length, 2, 'both headings kept (positional, no dedupe)');
  assert.deepStrictEqual(
    assets.map((a) => [a.assetType, a.instance]),
    [['Demand Gen Nurture Email', 0], ['Demand Gen Nurture Email', 1]]
  );

  // Identically-named fields across the two instances get DISTINCT keys.
  const keys = [];
  for (const a of assets) for (const f of a.fields) keys.push(ctxKey(a.assetType, f.fieldName, a.instance));
  assert.deepStrictEqual(keys, [
    'demand gen nurture email|subject line 1',
    'demand gen nurture email|preheader',
    'demand gen nurture email#i1|subject line 1',
    'demand gen nurture email#i1|preheader',
  ]);
  assert.strictEqual(new Set(keys).size, 4, 'four fields, four keys — no collapse');
});

test('read path: getDocContent stamps the same ordinals and keeps copy per instance', async () => {
  const { getDocContent } = require('../src/destinations/googleDocs');
  const { fieldKey } = require('../src/services/copyReview');
  const doc = instDoc(TWO_INSTANCE_PARAS);
  const clients = { docs: { documents: { get: async () => ({ data: doc }) } } };

  const content = await getDocContent('doc-1', clients);
  assert.deepStrictEqual(
    content.assets.map((a) => [a.name, a.instance]),
    [['Demand Gen Nurture Email', 0], ['Demand Gen Nurture Email', 1]]
  );
  // Each instance keeps its OWN copy — the read-back never merges them.
  assert.deepStrictEqual(
    content.assets.map((a) => a.fields.map((f) => f.copy.trim())),
    [['A-subject', 'A-preheader'], ['B-subject', 'B-preheader']]
  );

  const keys = [];
  for (const a of content.assets) for (const f of a.fields) keys.push(fieldKey(a.name, f.fieldName, a.instance));
  assert.deepStrictEqual(keys, [
    'demand gen nurture email||subject line 1',
    'demand gen nurture email||preheader',
    'demand gen nurture email#i1||subject line 1',
    'demand gen nurture email#i1||preheader',
  ]);
  assert.strictEqual(new Set(keys).size, 4);

  // parseDoc and getDocContent agree on the ordinals for the same doc.
  const { parseDoc } = require('../src/destinations/googleDocs');
  assert.deepStrictEqual(
    parseDoc(doc).assets.map((a) => a.instance),
    content.assets.map((a) => a.instance)
  );
});

test('read path: a SINGLE-instance doc stamps 0 everywhere and keys unchanged', async () => {
  const { parseDoc, getDocContent, ctxKey } = require('../src/destinations/googleDocs');
  const { fieldKey } = require('../src/services/copyReview');
  const doc = instDoc([
    { text: 'Campaign Summary', style: 'HEADING_2' },
    { text: 'sum', italic: true },
    { text: 'Writer Direction', style: 'HEADING_2' },
    { text: 'dir', italic: true },
    { text: 'Demand Gen Nurture Email', style: 'HEADING_3' },
    { text: 'Subject Line 1 [50-75]', bold: true },
    { text: 'the subject' },
    { text: 'Sales Basho Email', style: 'HEADING_3' },
    { text: 'Opening Line [100]', bold: true },
    { text: 'the opening' },
  ]);

  // Distinct names → every ordinal is 0 → every key is the pre-instance string.
  const parsed = parseDoc(doc);
  assert.deepStrictEqual(parsed.assets.map((a) => a.instance), [0, 0]);
  assert.deepStrictEqual(
    parsed.assets.flatMap((a) => a.fields.map((f) => ctxKey(a.assetType, f.fieldName, a.instance))),
    ['demand gen nurture email|subject line 1', 'sales basho email|opening line']
  );

  const content = await getDocContent('d', { docs: { documents: { get: async () => ({ data: doc }) } } });
  assert.deepStrictEqual(content.assets.map((a) => a.instance), [0, 0]);
  assert.deepStrictEqual(
    content.assets.flatMap((a) => a.fields.map((f) => fieldKey(a.name, f.fieldName, a.instance))),
    ['demand gen nurture email||subject line 1', 'sales basho email||opening line']
  );
  // And the stamped ordinal is indistinguishable from passing nothing at all.
  for (const a of content.assets) {
    for (const f of a.fields) {
      assert.strictEqual(fieldKey(a.name, f.fieldName, a.instance), fieldKey(a.name, f.fieldName));
      assert.strictEqual(ctxKey(a.name, f.fieldName, a.instance), ctxKey(a.name, f.fieldName));
    }
  }
});

test('read path: review collectors thread the READER ordinal end to end', async () => {
  const { getDocContent } = require('../src/destinations/googleDocs');
  const { collectCopyFields, selectReviewTargets, fieldKey } = require('../src/services/copyReview');
  const doc = instDoc(TWO_INSTANCE_PARAS);
  const content = await getDocContent('d', { docs: { documents: { get: async () => ({ data: doc }) } } });

  // Ordinals come off the stamped entry, not a recount inside the collector.
  assert.deepStrictEqual(
    collectCopyFields(content).map((f) => [f.instance, f.fieldName, f.copy]),
    [[0, 'Subject Line 1', 'A-subject'], [0, 'Preheader', 'A-preheader'],
     [1, 'Subject Line 1', 'B-subject'], [1, 'Preheader', 'B-preheader']]
  );

  // Scoping instance 1 selects only it, with instance 1's siblings.
  const s = selectReviewTargets(content, new Set([fieldKey('Demand Gen Nurture Email', 'Subject Line 1', 1)]));
  assert.strictEqual(s.singles.length, 1);
  assert.strictEqual(s.singles[0].copy, 'B-subject');
  assert.deepStrictEqual(s.singles[0].siblings, [{ fieldName: 'Preheader', copy: 'B-preheader' }]);
});

test('read path: collectors still count when content carries no stamped ordinal', () => {
  // A hand-built content object (a fixture, or any non-getDocContent producer) has
  // no `instance`. Repeated names must still be distinguished, not collapsed to 0.
  const { collectCopyFields } = require('../src/services/copyReview');
  const out = collectCopyFields({
    assets: [
      { name: 'Email', fields: [{ fieldName: 'H', copy: 'a' }] },
      { name: 'Email', fields: [{ fieldName: 'H', copy: 'b' }] },
    ],
  });
  assert.deepStrictEqual(out.map((f) => [f.instance, f.copy]), [[0, 'a'], [1, 'b']]);
});

test('reviewCopyFields result matching: duplicate (asset, field) binds by OCCURRENCE', () => {
  // The bug: byKey was last-wins per (assetType, fieldName) AND was consulted
  // BEFORE the positional fallback, so with two instances of one asset input #0
  // received input #1's comment instead of falling through to position.
  const { matchReviewResults } = require('../src/services/gemini');

  const list = [
    { assetType: 'Email', instance: 0, fieldName: 'Subject Line 1' },
    { assetType: 'Email', instance: 1, fieldName: 'Subject Line 1' },
  ];
  // What the model returns: same names twice (it is never told about instances),
  // in input order, as the prompt requires.
  const parsed = [
    { assetType: 'Email', fieldName: 'Subject Line 1', comment: 'note for A' },
    { assetType: 'Email', fieldName: 'Subject Line 1', comment: 'note for B' },
  ];

  const out = matchReviewResults(list, parsed);
  assert.deepStrictEqual(out, [
    { assetType: 'Email', instance: 0, fieldName: 'Subject Line 1', comment: 'note for A' },
    { assetType: 'Email', instance: 1, fieldName: 'Subject Line 1', comment: 'note for B' },
  ]);
  // The old last-wins map would have given BOTH inputs 'note for B'.
  assert.notStrictEqual(out[0].comment, out[1].comment, 'the two instances got different comments');
});

test('reviewCopyFields result matching: unique keys, reordering, and gaps unchanged', () => {
  const { matchReviewResults } = require('../src/services/gemini');

  // Distinct fields returned OUT OF ORDER — name matching still repairs it.
  const list = [
    { assetType: 'Email', fieldName: 'Subject Line 1' },
    { assetType: 'Email', fieldName: 'Preheader' },
  ];
  assert.deepStrictEqual(
    matchReviewResults(list, [
      { assetType: 'Email', fieldName: 'Preheader', comment: 'pre note' },
      { assetType: 'Email', fieldName: 'Subject Line 1', comment: 'subj note' },
    ]).map((r) => r.comment),
    ['subj note', 'pre note']
  );

  // Case/whitespace drift in the model's echo still matches.
  assert.deepStrictEqual(
    matchReviewResults(list, [
      { assetType: '  EMAIL ', fieldName: 'subject line 1', comment: 'subj note' },
      { assetType: 'Email', fieldName: 'PREHEADER', comment: 'pre note' },
    ]).map((r) => r.comment),
    ['subj note', 'pre note']
  );

  // Unmatchable name → positional fallback; null/blank comment → null.
  assert.deepStrictEqual(
    matchReviewResults(list, [
      { assetType: 'Wrong', fieldName: 'Nope', comment: 'by position' },
      { assetType: 'Email', fieldName: 'Preheader', comment: '   ' },
    ]).map((r) => r.comment),
    ['by position', null]
  );

  // Short/empty parsed array → no comment rather than a throw.
  assert.deepStrictEqual(matchReviewResults(list, []).map((r) => r.comment), [null, null]);
  assert.deepStrictEqual(matchReviewResults(list, [null, null]).map((r) => r.comment), [null, null]);
});

test('reviewUnitKey is the single definition of the review key template', () => {
  const { reviewUnitKey } = require('../src/utils/instanceKey');
  const { fieldKey } = require('../src/services/copyReview');
  // copyReview.fieldKey IS the shared helper — not a same-looking reimplementation.
  assert.strictEqual(fieldKey, reviewUnitKey);
  // And no file carries its own inline copy of the `asset||field` template.
  for (const rel of ['src/services/gemini.js', 'src/services/copyReview.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(!/trim\(\)\.toLowerCase\(\)\}\|\|/.test(src), `${rel} must use reviewUnitKey, not an inline template`);
  }
});

// --- Asset PLAN expansion (tenantAssetsToSpecs) ------------------------------
// Was a filter over library rows (≤1 group per row, library sort_order). Now an
// expansion of an ordered plan into instances, in REQUEST order. Nothing
// user-facing can ask for count > 1 yet — only a direct pipeline call can.

// Library rows in the shape db/assets.getTenantAssets returns. The bundled
// default library already has exactly that shape, so use a real slice of it.
function libRows(names) {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  return names.map((n) => {
    const a = DEFAULT_ASSETS.find((x) => x.name === n);
    assert.ok(a, `fixture asset ${n} exists in the default library`);
    return a;
  });
}
const PLAN_ROWS = () => libRows(['Demand Gen Nurture Email', 'Campaign Landing Page', 'Battle Card']);

test('asset plan: expands counts into instances, in REQUEST order', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  // Battle Card is LAST in library sort_order (30) and Email is 12th — asking for
  // Battle Card first must put it first.
  const specs = tenantAssetsToSpecs(PLAN_ROWS(), [
    { asset: 'Battle Card', count: 1 },
    { asset: 'Demand Gen Nurture Email', count: 3 },
    { asset: 'Campaign Landing Page', count: 2 },
  ]);

  assert.deepStrictEqual(
    specs.map((s) => [s.assetType, s.instance]),
    [
      ['Battle Card', 0],
      ['Demand Gen Nurture Email', 0],
      ['Demand Gen Nurture Email', 1],
      ['Demand Gen Nurture Email', 2],
      ['Campaign Landing Page', 0],
      ['Campaign Landing Page', 1],
    ]
  );
  // Field order WITHIN an asset is still the library's, and identical per instance.
  const emails = specs.filter((s) => s.assetType === 'Demand Gen Nurture Email');
  assert.deepStrictEqual(emails[0].fields.map((f) => f.fieldName).slice(0, 3), [
    'Subject Line 1', 'Subject Line 2', 'Preheader',
  ]);
  for (const e of emails.slice(1)) {
    assert.deepStrictEqual(e.fields.map((f) => f.fieldName), emails[0].fields.map((f) => f.fieldName));
  }
});

test('asset plan: ordinals count across the WHOLE plan, not per entry', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  // Same asset named by two separate entries — ordinals must continue, not restart.
  const specs = tenantAssetsToSpecs(PLAN_ROWS(), [
    { asset: 'Demand Gen Nurture Email', count: 2 },
    { asset: 'Battle Card', count: 1 },
    { asset: 'Demand Gen Nurture Email', count: 2 },
  ]);
  assert.deepStrictEqual(
    specs.map((s) => [s.assetType, s.instance]),
    [
      ['Demand Gen Nurture Email', 0],
      ['Demand Gen Nurture Email', 1],
      ['Battle Card', 0],
      ['Demand Gen Nurture Email', 2],
      ['Demand Gen Nurture Email', 3],
    ]
  );
});

test('asset plan: every instance is an INDEPENDENT object (no aliasing)', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const specs = tenantAssetsToSpecs(PLAN_ROWS(), [{ asset: 'Battle Card', count: 2 }]);
  assert.notStrictEqual(specs[0], specs[1], 'distinct group objects');
  assert.notStrictEqual(specs[0].fields, specs[1].fields, 'distinct field arrays');
  assert.notStrictEqual(specs[0].fields[0], specs[1].fields[0], 'distinct field objects');
  // generateDoc writes asset_direction onto each group in place — must not leak.
  specs[0].asset_direction = 'only instance 0';
  specs[0].fields[0].charMax = 1;
  assert.notStrictEqual(specs[1].asset_direction, 'only instance 0');
  assert.notStrictEqual(specs[1].fields[0].charMax, 1);
});

test('asset plan: a bare string[] is still accepted, count 1 each', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const specs = tenantAssetsToSpecs(PLAN_ROWS(), ['Battle Card', 'Demand Gen Nurture Email']);
  assert.deepStrictEqual(
    specs.map((s) => [s.assetType, s.instance]),
    [['Battle Card', 0], ['Demand Gen Nurture Email', 0]]
  );
  // Name matching stays case- and dash-insensitive (utils/normalize).
  assert.deepStrictEqual(
    tenantAssetsToSpecs(PLAN_ROWS(), ['  battle card  ']).map((s) => s.assetType),
    ['Battle Card']
  );
  // Mixed shapes in one array.
  assert.deepStrictEqual(
    tenantAssetsToSpecs(PLAN_ROWS(), ['Battle Card', { asset: 'Battle Card', count: 2 }]).map((s) => s.instance),
    [0, 1, 2]
  );
});

test('asset plan: an EMPTY plan still returns the whole library, in library order', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  // This is the path both adapters rely on for a vague brief with no assets —
  // NOT the silent fallback removed below.
  for (const empty of [[], undefined, null, 'nonsense', 42]) {
    const specs = tenantAssetsToSpecs(DEFAULT_ASSETS, empty);
    assert.strictEqual(specs.length, 30, `empty plan (${JSON.stringify(empty)}) → whole library`);
    assert.deepStrictEqual(
      specs.map((s) => s.assetType),
      DEFAULT_ASSETS.map((a) => a.name),
      'library sort_order preserved for the empty plan'
    );
    assert.ok(specs.every((s) => s.instance === 0), 'unique library names → all ordinal 0');
  }
});

test('asset plan: an unmatched asset FAILS LOUDLY instead of rendering the library', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const rows = PLAN_ROWS();

  // All unmatched — this is the case that used to return all 3 rows silently.
  assert.throws(
    () => tenantAssetsToSpecs(rows, ['TikTok Ad', 'Billboard']),
    (err) => {
      assert.match(err.message, /not in this tenant's library/);
      assert.match(err.message, /TikTok Ad/);
      assert.match(err.message, /Billboard/);
      assert.match(err.message, /has 3 asset type\(s\)/);
      return true;
    }
  );

  // PARTIALLY unmatched — used to silently drop the miss and build the rest.
  assert.throws(
    () => tenantAssetsToSpecs(rows, ['Battle Card', 'TikTok Ad']),
    /not in this tenant's library: TikTok Ad/
  );

  // A plan of only matched names is unaffected.
  assert.strictEqual(tenantAssetsToSpecs(rows, ['Battle Card']).length, 1);
});

test('asset plan: counts are clamped and the total is capped', () => {
  const { tenantAssetsToSpecs, normalizeAssetPlan, MAX_INSTANCES_PER_ASSET, MAX_TOTAL_INSTANCES } =
    require('../src/core/pipeline');
  assert.strictEqual(MAX_INSTANCES_PER_ASSET, 10);
  assert.strictEqual(MAX_TOTAL_INSTANCES, 40);

  // Per-asset clamp: never trust the caller's number.
  const cases = [
    [999, MAX_INSTANCES_PER_ASSET], [11, MAX_INSTANCES_PER_ASSET], [10, 10], [1, 1],
    [0, 1], [-5, 1], [null, 1], [undefined, 1], ['3', 3], ['abc', 1], [2.9, 2],
    // parseInt('Infinity') is NaN, so a non-finite count degrades to 1 rather than
    // to the ceiling — the safe direction for junk input.
    [Infinity, 1], [NaN, 1],
  ];
  for (const [input, want] of cases) {
    assert.deepStrictEqual(
      normalizeAssetPlan([{ asset: 'A', count: input }]),
      [{ asset: 'A', count: want }],
      `count ${String(input)} → ${want}`
    );
  }
  // The clamp is enforced in the expansion too, not just the normalizer.
  assert.strictEqual(
    tenantAssetsToSpecs(PLAN_ROWS(), [{ asset: 'Battle Card', count: 999 }]).length,
    MAX_INSTANCES_PER_ASSET
  );

  // Whole-plan ceiling THROWS (never truncates silently).
  const rows = PLAN_ROWS();
  const four = [
    { asset: 'Battle Card', count: 10 },
    { asset: 'Demand Gen Nurture Email', count: 10 },
    { asset: 'Campaign Landing Page', count: 10 },
    { asset: 'Battle Card', count: 10 },
  ];
  assert.strictEqual(tenantAssetsToSpecs(rows, four).length, 40, 'exactly at the ceiling is allowed');
  assert.throws(
    () => tenantAssetsToSpecs(rows, [...four, { asset: 'Battle Card', count: 1 }]),
    /asks for 41 asset instances, above the 40-instance ceiling/
  );

  // Junk entries are dropped, not guessed at.
  assert.deepStrictEqual(normalizeAssetPlan([null, '', '   ', {}, { asset: '  ' }, 7, ['x']]), []);
  // `assetType` is honored as an alias for `asset`.
  assert.deepStrictEqual(normalizeAssetPlan([{ assetType: 'A', count: 2 }]), [{ asset: 'A', count: 2 }]);
});

test('asset plan: request order becomes DOCUMENT order, so read-back ordinals agree', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const { parseDoc } = require('../src/destinations/googleDocs');

  const specs = tenantAssetsToSpecs(PLAN_ROWS(), [
    { asset: 'Battle Card', count: 1 },
    { asset: 'Demand Gen Nurture Email', count: 2 },
  ]);

  // The writer renders groups in assetSpecs order, so headings come out in request
  // order. The repeated asset is disambiguated with a 1-based ordinal; the single
  // one stays bare. (Before instance headings existed this asserted three bare
  // headings with a duplicate — same intent, now spelled the way the doc reads.)
  const doc = renderToDoc(specs);
  const headingOrder = doc.body.content
    .filter((i) => i.paragraph.paragraphStyle.namedStyleType === 'HEADING_3')
    .map((i) => i.paragraph.elements[0].textRun.content.replace(/\n$/, ''));
  assert.deepStrictEqual(headingOrder, [
    'Battle Card',
    'Demand Gen Nurture Email 1',
    'Demand Gen Nurture Email 2',
  ]);

  // Reading that doc back recovers the SAME (library name, ordinal) pairs the plan
  // assigned — the write and read sides agree without either knowing the other.
  assert.deepStrictEqual(
    parseDoc(doc).assets.map((a) => [a.assetType, a.instance]),
    specs.map((s) => [s.assetType, s.instance])
  );
});

test('asset plan: counts are bounded at every layer', () => {
  // This replaced a guard asserting that NOTHING user-facing could request
  // count > 1 — which was true only while parseBrief deduped. It now can, so the
  // invariant that matters is that no layer trusts the number it is handed.
  const rd = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const gem = rd('src/services/gemini.js');
  const core = rd('src/core/pipeline.js');
  const route = rd('src/routes/app.js');

  // 1. parseBrief clamps the MODEL's number on arrival.
  assert.ok(/Math\.min\(PARSE_MAX_COUNT_PER_ASSET, requested \|\| 1\)/.test(gem), 'parse clamps per asset');
  assert.ok(/planTotal \+ count > PARSE_MAX_TOTAL/.test(gem), 'parse caps the whole plan');
  // 2. The expansion clamps again, per surface, and is the authority.
  assert.ok(/Math\.min\(maxPerAsset, requested \|\| 1\)/.test(core), 'expansion clamps per surface');
  assert.ok(/requestedTotal > maxTotal/.test(core), 'expansion refuses an over-total ask');
  // 3. The shared plan validator clamps a USER-supplied number — a browser POST
  //    body or a Slack modal submission. (This assertion used to point at
  //    routes/app.js; the validator moved to src/pendingBriefs.js when the Slack
  //    confirmation flow needed the same one. Same code, same clamp, one copy.)
  const pending = rd('src/pendingBriefs.js');
  assert.ok(/Math\.min\(MAX_INSTANCES_PER_ASSET, parseInt\(entry\.count, 10\) \|\| 1\)/.test(pending),
    'the shared validator clamps a user count');
  assert.ok(/require\('\.\.\/pendingBriefs'\)/.test(route), 'the web route uses the shared validator');
  // No layer hard-codes a count above 1 of its own accord. Comments are stripped
  // first — the docs and clamp explanations legitimately quote counts like
  // "count: 5" and "count: 400" as examples.
  const stripComments = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const [name, src] of [['gemini', gem], ['pipeline', core], ['route', route]]) {
    assert.ok(!/count:\s*(?!1\b)\d/.test(stripComments(src)), `${name} does not hard-code count > 1`);
  }
});

test('asset plan: a one-of-each brief is byte-identical to the pre-instance behavior', () => {
  // REQUIREMENT 8, the regression that matters most: every brief anyone has run so
  // far is one of each. A plan of count-1 entries must expand exactly the way the
  // old bare string[] did — same groups, same order, same ordinals, no labels.
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const { SLACK_ASSET_LIMITS } = require('../src/adapters/slackWorkflow');
  const rows = PLAN_ROWS();
  const names = ['Battle Card', 'Demand Gen Nurture Email', 'Campaign Landing Page'];

  const asStrings = tenantAssetsToSpecs(rows, names);
  const asPlan = tenantAssetsToSpecs(rows, names.map((asset) => ({ asset, count: 1, labels: [] })));
  assert.deepStrictEqual(
    asPlan.map((s) => [s.assetType, s.instance, s.instanceLabel]),
    asStrings.map((s) => [s.assetType, s.instance, s.instanceLabel]),
    'plan entries at count 1 == bare names'
  );
  assert.ok(asPlan.every((s) => s.instance === 0 && s.instanceLabel === null), 'no ordinals, no labels');
  assert.strictEqual(JSON.stringify(asPlan), JSON.stringify(asStrings), 'identical down to the field specs');

  // Identical on Slack's tighter ceiling too — count 1 is under every ceiling.
  assert.strictEqual(
    JSON.stringify(tenantAssetsToSpecs(rows, names, SLACK_ASSET_LIMITS)),
    JSON.stringify(asStrings)
  );
  // And the doc renders bare headings, exactly as before instances existed.
  const { appendBody } = require('../src/destinations/googleDocs');
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const b = new DocBuilder();
  appendBody(b, { summary: 'S', writerPrompt: 'W', resolvedLinks: [], referenceInsights: [], assetSpecs: asPlan });
  for (const n of names) assert.ok(b.text.includes('\n' + n + '\n'), `bare heading for ${n}`);
  assert.ok(!/ \d+\n/.test(b.text.split('Battle Card')[1] || ''), 'no ordinal suffix anywhere');
});

// --- Instance headings: the writer renders them, the readers decompose them ----
// A lone instance renders its bare library name (unchanged for every doc written
// before instances); a repeat gets a 1-based ordinal and its label. The readers
// report the LIBRARY name so downstream library lookups keep matching.

function headingDoc(paras) {
  let startIndex = 1;
  return { title: 'T', body: { content: paras.map((p) => {
    const raw = (p.text || '') + '\n';
    const endIndex = startIndex + raw.length;
    const item = { startIndex, endIndex, paragraph: {
      paragraphStyle: p.style ? { namedStyleType: p.style } : {},
      elements: [{ textRun: { content: raw, textStyle: { bold: !!p.bold, italic: !!p.italic } } }] } };
    startIndex = endIndex;
    return item;
  }) } };
}
// Render assetSpecs through the real writer and return the doc it would produce,
// re-tagged so the readers can parse it (DocBuilder emits text + style ranges;
// this rebuilds the equivalent documents.get payload).
function renderToDoc(assetSpecs) {
  const { appendBody } = require('../src/destinations/googleDocs');
  const { DocBuilder } = require('../src/destinations/docBuilder');
  const b = new DocBuilder();
  appendBody(b, { summary: 'S', writerPrompt: 'W', resolvedLinks: [], referenceInsights: [], assetSpecs });
  const reqs = b.buildRequests();
  // Map each paragraph's style from the recorded updateParagraphStyle ranges.
  const styleAt = [];
  for (const r of reqs) {
    if (!r.updateParagraphStyle) continue;
    styleAt.push({ start: r.updateParagraphStyle.range.startIndex, style: r.updateParagraphStyle.paragraphStyle.namedStyleType });
  }
  const boldAt = new Set();
  for (const r of reqs) {
    if (r.updateTextStyle && r.updateTextStyle.textStyle.bold) boldAt.add(r.updateTextStyle.range.startIndex);
  }
  let idx = 1;
  const paras = b.text.split('\n').slice(0, -1).map((line) => {
    const start = idx;
    idx += line.length + 1;
    const st = styleAt.find((s) => s.start === start);
    return { text: line, style: st ? st.style : undefined, bold: boldAt.has(start) };
  });
  return headingDoc(paras);
}
function specGroup(assetType, instance, instanceLabel, fields) {
  return {
    assetType, instance, instanceLabel, channel: '', toneNotes: '', asset_direction: '',
    fields: (fields || ['Subject Line 1']).map((fieldName) => ({
      fieldName, charMin: 0, charMax: 50, groupLabel: null, specNote: null, specType: null, specSource: null,
    })),
  };
}

test('instance headings: format is bare for one, 1-based ordinal for many', () => {
  const { assetHeadingText } = require('../src/destinations/googleDocs');
  // total <= 1 → no suffix at all, whatever the ordinal says.
  assert.strictEqual(assetHeadingText('Demand Gen Nurture Email', 0, null, 1), 'Demand Gen Nurture Email');
  assert.strictEqual(assetHeadingText('Demand Gen Nurture Email', 0, 'ignored', 1), 'Demand Gen Nurture Email');
  assert.strictEqual(assetHeadingText('Demand Gen Nurture Email', 3, 'ignored', 1), 'Demand Gen Nurture Email');
  assert.strictEqual(assetHeadingText('Demand Gen Nurture Email', 0, null, undefined), 'Demand Gen Nurture Email');
  // total > 1 → ordinal is instance + 1 (writers count from 1), label when present.
  assert.strictEqual(assetHeadingText('Demand Gen Nurture Email', 0, null, 3), 'Demand Gen Nurture Email 1');
  assert.strictEqual(assetHeadingText('Demand Gen Nurture Email', 2, null, 3), 'Demand Gen Nurture Email 3');
  assert.strictEqual(
    assetHeadingText('Demand Gen Nurture Email', 1, 'Downtown residents', 3),
    'Demand Gen Nurture Email 2 — Downtown residents'
  );
  // A blank label is the same as none.
  assert.strictEqual(assetHeadingText('Email', 0, '   ', 2), 'Email 1');
});

test('instance headings: decomposition never shreds a real asset name', () => {
  const { decomposeAssetHeading } = require('../src/destinations/googleDocs');
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

  // THE HAZARD: 14 of 30 bundled names contain ' — '. None may decompose.
  const dashNames = DEFAULT_ASSETS.map((a) => a.name).filter((n) => n.includes('—'));
  assert.ok(dashNames.length >= 14, `expected the em-dash names, got ${dashNames.length}`);
  for (const name of DEFAULT_ASSETS.map((a) => a.name)) {
    assert.strictEqual(decomposeAssetHeading(name), null, `bare library name must not decompose: ${name}`);
  }

  // Those same names DO decompose once suffixed — the ordinal is the anchor.
  assert.deepStrictEqual(decomposeAssetHeading('Direct Mail — Box / Mailer 2'), {
    assetType: 'Direct Mail — Box / Mailer', instance: 1, instanceLabel: null,
  });
  assert.deepStrictEqual(decomposeAssetHeading('Direct Mail — Box / Mailer 2 — Q3 drop'), {
    assetType: 'Direct Mail — Box / Mailer', instance: 1, instanceLabel: 'Q3 drop',
  });
  assert.deepStrictEqual(decomposeAssetHeading('Organic Social — LinkedIn 1'), {
    assetType: 'Organic Social — LinkedIn', instance: 0, instanceLabel: null,
  });
  // An ordinal this writer never emits is not a suffix.
  assert.strictEqual(decomposeAssetHeading('Email 0'), null);
  assert.strictEqual(decomposeAssetHeading('Email'), null);
  assert.strictEqual(decomposeAssetHeading(''), null);
  assert.strictEqual(decomposeAssetHeading(undefined), null);
});

test('instance headings: a LONE suffix is not treated as an instance (sibling rule)', () => {
  const { instanceHeadingMap } = require('../src/destinations/googleDocs');
  // A tenant asset legitimately called 'Concept 2', alone → literal name.
  assert.strictEqual(instanceHeadingMap(['Concept 2', 'Battle Card']).size, 0);
  // Two siblings → both accepted.
  const m = instanceHeadingMap(['Concept 1', 'Concept 2', 'Battle Card']);
  assert.strictEqual(m.size, 2);
  assert.strictEqual(m.get('Concept 1').instance, 0);
  assert.strictEqual(m.get('Concept 2').instance, 1);
  assert.ok(!m.has('Battle Card'));
  // Siblings are grouped with the same name folding the library lookup uses.
  assert.strictEqual(instanceHeadingMap(['Organic Social — LinkedIn 1', 'Organic Social - LinkedIn 2']).size, 2);
});

test('instance headings: a SINGLE-instance doc renders the bare name', () => {
  const specs = [specGroup('Demand Gen Nurture Email', 0, null), specGroup('Battle Card', 0, null)];
  const doc = renderToDoc(specs);
  const { parseDoc } = require('../src/destinations/googleDocs');
  const headings = doc.body.content
    .filter((i) => i.paragraph.paragraphStyle.namedStyleType === 'HEADING_3')
    .map((i) => i.paragraph.elements[0].textRun.content.replace(/\n$/, ''));
  assert.deepStrictEqual(headings, ['Demand Gen Nurture Email', 'Battle Card'], 'no suffix anywhere');
  // A label on a lone instance is ignored, so it cannot change an existing doc.
  const labeled = renderToDoc([specGroup('Demand Gen Nurture Email', 0, 'ignored me')]);
  assert.ok(labeled.body.content.some((i) => /Demand Gen Nurture Email\n/.test(i.paragraph.elements[0].textRun.content)));
  assert.deepStrictEqual(parseDoc(doc).assets.map((a) => [a.assetType, a.instance, a.instanceLabel]), [
    ['Demand Gen Nurture Email', 0, null], ['Battle Card', 0, null],
  ]);
});

test('instance headings: THREE instances render ordinals, with and without labels', () => {
  const specs = [
    specGroup('Demand Gen Nurture Email', 0, null),
    specGroup('Demand Gen Nurture Email', 1, 'Downtown residents'),
    specGroup('Demand Gen Nurture Email', 2, 'Suburban families'),
    specGroup('Battle Card', 0, null), // single → stays bare in the same doc
  ];
  const doc = renderToDoc(specs);
  const headings = doc.body.content
    .filter((i) => i.paragraph.paragraphStyle.namedStyleType === 'HEADING_3')
    .map((i) => i.paragraph.elements[0].textRun.content.replace(/\n$/, ''));
  assert.deepStrictEqual(headings, [
    'Demand Gen Nurture Email 1',
    'Demand Gen Nurture Email 2 — Downtown residents',
    'Demand Gen Nurture Email 3 — Suburban families',
    'Battle Card',
  ]);
});

test('instance headings: full ROUND TRIP — render, read, key', () => {
  const { parseDoc, ctxKey } = require('../src/destinations/googleDocs');
  const specs = [
    specGroup('Demand Gen Nurture Email', 0, null, ['Subject Line 1', 'Preheader']),
    specGroup('Demand Gen Nurture Email', 1, 'Downtown residents', ['Subject Line 1', 'Preheader']),
    specGroup('Demand Gen Nurture Email', 2, null, ['Subject Line 1', 'Preheader']),
  ];
  const readBack = parseDoc(renderToDoc(specs)).assets;

  // Read-back names are LIBRARY names, not the suffixed heading text.
  assert.deepStrictEqual(readBack.map((a) => [a.assetType, a.instance, a.instanceLabel]), [
    ['Demand Gen Nurture Email', 0, null],
    ['Demand Gen Nurture Email', 1, 'Downtown residents'],
    ['Demand Gen Nurture Email', 2, null],
  ]);
  // The keys the READER derives equal the keys the WRITER's specs would derive.
  const writerKeys = specs.flatMap((s) => s.fields.map((f) => ctxKey(s.assetType, f.fieldName, s.instance)));
  const readerKeys = readBack.flatMap((a) => a.fields.map((f) => ctxKey(a.assetType, f.fieldName, a.instance)));
  assert.deepStrictEqual(readerKeys, writerKeys);
  assert.strictEqual(new Set(readerKeys).size, 6, 'six fields, six distinct keys');
});

test('instance headings: round trip survives a library name containing an em dash', () => {
  const { parseDoc, ctxKey } = require('../src/destinations/googleDocs');
  // The dangerous case: the asset name itself has ' — ' AND it is instanced AND
  // labeled, so the heading contains TWO em dashes.
  const specs = [
    specGroup('Direct Mail — Box / Mailer', 0, 'Wave A', ['Flap Copy']),
    specGroup('Direct Mail — Box / Mailer', 1, 'Wave B', ['Flap Copy']),
  ];
  const doc = renderToDoc(specs);
  const headings = doc.body.content
    .filter((i) => i.paragraph.paragraphStyle.namedStyleType === 'HEADING_3')
    .map((i) => i.paragraph.elements[0].textRun.content.replace(/\n$/, ''));
  assert.deepStrictEqual(headings, [
    'Direct Mail — Box / Mailer 1 — Wave A',
    'Direct Mail — Box / Mailer 2 — Wave B',
  ]);
  assert.deepStrictEqual(parseDoc(doc).assets.map((a) => [a.assetType, a.instance, a.instanceLabel]), [
    ['Direct Mail — Box / Mailer', 0, 'Wave A'],
    ['Direct Mail — Box / Mailer', 1, 'Wave B'],
  ]);
  assert.deepStrictEqual(
    parseDoc(doc).assets.map((a) => ctxKey(a.assetType, 'Flap Copy', a.instance)),
    specs.map((s) => ctxKey(s.assetType, 'Flap Copy', s.instance))
  );
});

test('instance headings: getDocContent decomposes them too', async () => {
  const { getDocContent } = require('../src/destinations/googleDocs');
  const { fieldKey } = require('../src/services/copyReview');
  const doc = renderToDoc([
    specGroup('Demand Gen Nurture Email', 0, 'A', ['Subject Line 1']),
    specGroup('Demand Gen Nurture Email', 1, 'B', ['Subject Line 1']),
  ]);
  const content = await getDocContent('d', { docs: { documents: { get: async () => ({ data: doc }) } } });
  assert.deepStrictEqual(content.assets.map((a) => [a.name, a.instance, a.instanceLabel]), [
    ['Demand Gen Nurture Email', 0, 'A'],
    ['Demand Gen Nurture Email', 1, 'B'],
  ]);
  assert.deepStrictEqual(
    content.assets.map((a) => fieldKey(a.name, 'Subject Line 1', a.instance)),
    ['demand gen nurture email||subject line 1', 'demand gen nurture email#i1||subject line 1']
  );
});

test('instance labels: threaded through the plan, populated by nothing', () => {
  const { tenantAssetsToSpecs, normalizeAssetPlan } = require('../src/core/pipeline');
  const rows = PLAN_ROWS();

  // Absent by default.
  assert.ok(tenantAssetsToSpecs(rows, ['Battle Card']).every((s) => s.instanceLabel === null));
  assert.ok(tenantAssetsToSpecs(rows, []).every((s) => s.instanceLabel === null));
  assert.deepStrictEqual(normalizeAssetPlan([{ asset: 'A', count: 2 }]), [{ asset: 'A', count: 2 }]);

  // Supplied positionally by a direct caller; blanks and overflow are dropped.
  const specs = tenantAssetsToSpecs(rows, [
    { asset: 'Demand Gen Nurture Email', count: 3, labels: ['Downtown residents', '  ', 'Suburban families', 'extra'] },
  ]);
  assert.deepStrictEqual(specs.map((s) => s.instanceLabel), ['Downtown residents', null, 'Suburban families']);
  // Labels are positional WITHIN an entry, so a second entry uses its own list.
  const two = tenantAssetsToSpecs(rows, [
    { asset: 'Battle Card', count: 1, labels: ['first'] },
    { asset: 'Battle Card', count: 1, labels: ['second'] },
  ]);
  assert.deepStrictEqual(two.map((s) => [s.instance, s.instanceLabel]), [[0, 'first'], [1, 'second']]);

  // NOTHING user-facing supplies a label.
  const rd = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // Match the plan-entry PROPERTY, not the English word — gemini.js prompts
  // legitimately say "no labels, quotes, options" and "Reproduce labels ... VERBATIM".
  for (const p of ['src/adapters/slackWorkflow.js', 'src/adapters/web.js', 'src/routes/app.js', 'src/services/gemini.js']) {
    // A NON-EMPTY label literal. `labels: []` (the web parse half's empty default,
    // which keeps the returned plan shape uniform) supplies no label content.
    assert.ok(!/labels\s*:\s*\[\s*[^\]\s]/.test(rd(p)), `${p} must not supply instance labels`);
  }
});

// --- Parse-then-confirm on the web brief flow --------------------------------
// /api/brief pauses ONLY when the parsed plan has something to correct: a count
// above 1, or a label. A one-of-each brief — every brief run before instances
// existed — takes the straight path: one POST, one poll, a doc.

// Drive the real router over a loopback listener with the DB + web adapter
// stubbed. `webStub` overrides the adapter halves so a test can force a
// multi-instance plan that parseBrief itself cannot produce.
function withBriefServer(webStub, fn) {
  return withStubbedDb(async (router) => {
    const express = require('express');
    const http = require('node:http');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: req.headers['x-user'] || 'u1' }; next(); });
    app.use(router);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    let calls = 0;
    const call = async (method, url, user, body) => {
      calls += 1;
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-User': user },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    // Poll a job to completion (the stubs settle immediately).
    const finish = async (jobId, user) => {
      for (let i = 0; i < 40; i += 1) {
        const s = await call('GET', `/api/brief/${jobId}/status`, user);
        if (s.body.status !== 'pending') return s.body;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('job never settled');
    };
    try {
      return await fn({ call, finish, callCount: () => calls });
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, webStub);
}

test('confirm: the DORMANT path builds a doc with no confirmation and no extra request', async () => {
  let generateCalls = 0;
  await withBriefServer(
    {
      // A one-of-each plan — exactly what parseBrief produces today.
      runWebBriefParse: async () => ({
        campaignTitle: 'Spring Sale', summary: 'S', writerPrompt: 'W', referenceInsights: [],
        plan: [{ asset: 'Battle Card', count: 1, labels: [] }, { asset: 'One-Pager', count: 1, labels: [] }],
      }),
      runWebBriefGenerate: async () => { generateCalls += 1; return { docUrl: 'https://docs.google.com/document/d/DOC/edit' }; },
    },
    async ({ call, finish, callCount }) => {
      const before = callCount();
      const start = await call('POST', '/api/brief', 'u1', { briefText: 'spring sale' });
      assert.strictEqual(start.status, 202);
      const done = await finish(start.body.jobId, 'u1');

      assert.strictEqual(done.status, 'complete');
      // The doc came back from the FIRST job — no confirmation, no pendingId.
      assert.strictEqual(done.result.docUrl, 'https://docs.google.com/document/d/DOC/edit');
      assert.ok(!done.result.needsConfirmation, 'no confirmation for a one-of-each plan');
      assert.strictEqual(done.result.pendingId, undefined);
      assert.strictEqual(generateCalls, 1, 'generation ran inside the brief job');
      // Exactly ONE POST — the rest are status polls. No extra round trip.
      const posts = callCount() - before;
      assert.ok(posts >= 2, 'at least the POST plus one poll happened');
      assert.strictEqual(done.result.needsConfirmation, undefined);
    }
  );
});

test('confirm: a multi-instance plan PAUSES, is edited, and generates from the edit', async () => {
  let seenPlan = null;
  await withBriefServer(
    {
      runWebBriefParse: async () => ({
        campaignTitle: 'Nurture Wave', summary: 'Two audiences', writerPrompt: 'Direct', referenceInsights: [],
        plan: [{ asset: 'Demand Gen Nurture Email', count: 5, labels: [] }, { asset: 'Battle Card', count: 1, labels: [] }],
      }),
      runWebBriefGenerate: async (_parsed, plan) => { seenPlan = plan; return { docUrl: 'https://docs.google.com/document/d/DOC2/edit' }; },
    },
    async ({ call, finish }) => {
      // 1. The brief job stops WITHOUT building anything.
      const start = await call('POST', '/api/brief', 'u1', { briefText: '5 nurture emails' });
      const paused = await finish(start.body.jobId, 'u1');
      assert.strictEqual(paused.status, 'complete');
      assert.strictEqual(paused.result.needsConfirmation, true);
      assert.ok(paused.result.pendingId, 'a pendingId to resume from');
      assert.strictEqual(paused.result.docUrl, undefined, 'no doc was created');
      assert.strictEqual(seenPlan, null, 'generate never ran');
      // The interpretation carries everything the screen renders.
      assert.strictEqual(paused.result.interpretation.campaignTitle, 'Nurture Wave');
      assert.strictEqual(paused.result.interpretation.summary, 'Two audiences');
      assert.strictEqual(paused.result.interpretation.writerDirection, 'Direct');
      assert.deepStrictEqual(paused.result.interpretation.plan.map((e) => [e.asset, e.count]), [
        ['Demand Gen Nurture Email', 5], ['Battle Card', 1],
      ]);

      // 2. The user corrects 5 → 2 and builds.
      const confirm = await call('POST', '/api/brief/confirm', 'u1', {
        pendingId: paused.result.pendingId,
        plan: [{ asset: 'Demand Gen Nurture Email', count: 2 }, { asset: 'Battle Card', count: 1 }],
      });
      assert.strictEqual(confirm.status, 202);
      const built = await finish(confirm.body.jobId, 'u1');
      assert.strictEqual(built.status, 'complete');
      assert.strictEqual(built.result.docUrl, 'https://docs.google.com/document/d/DOC2/edit');
      // Generation used the EDITED plan, not the parsed one.
      assert.deepStrictEqual(seenPlan, [
        { asset: 'Demand Gen Nurture Email', count: 2 }, { asset: 'Battle Card', count: 1 },
      ]);
    }
  );
});

test('confirm: a client-supplied plan is validated and clamped server-side', async () => {
  let seenPlan = null;
  const PAUSED = {
    runWebBriefParse: async () => ({
      campaignTitle: 'C', summary: 'S', writerPrompt: 'W', referenceInsights: [],
      plan: [{ asset: 'Battle Card', count: 3, labels: [] }],
    }),
    runWebBriefGenerate: async (_p, plan) => { seenPlan = plan; return { docUrl: 'd' }; },
  };
  await withBriefServer(PAUSED, async ({ call, finish }) => {
    const start = await call('POST', '/api/brief', 'u1', { briefText: 'x' });
    const pendingId = (await finish(start.body.jobId, 'u1')).result.pendingId;

    // An asset the tenant's library does not have → 400, named, no job started.
    const bogus = await call('POST', '/api/brief/confirm', 'u1', {
      pendingId, plan: [{ asset: 'TikTok Ad', count: 1 }],
    });
    assert.strictEqual(bogus.status, 400);
    assert.match(bogus.body.error, /not in your library: TikTok Ad/);
    assert.strictEqual(bogus.body.jobId, undefined);
    assert.strictEqual(seenPlan, null, 'nothing generated');

    // An absurd per-asset count is CLAMPED to the ceiling, not obeyed.
    const huge = await call('POST', '/api/brief/confirm', 'u1', {
      pendingId, plan: [{ asset: 'Battle Card', count: 9999 }],
    });
    assert.strictEqual(huge.status, 202);
    await finish(huge.body.jobId, 'u1');
    assert.deepStrictEqual(seenPlan, [{ asset: 'Battle Card', count: 10 }], 'clamped to MAX_INSTANCES_PER_ASSET');

    // A total above the whole-plan ceiling → 400 rather than a 400-section doc.
    seenPlan = null;
    const over = await call('POST', '/api/brief/confirm', 'u1', {
      pendingId,
      plan: Array.from({ length: 6 }, () => ({ asset: 'Battle Card', count: 10 })), // 60 > 40
    });
    assert.strictEqual(over.status, 400);
    assert.match(over.body.error, /above the limit of 40/);
    assert.strictEqual(seenPlan, null);

    // An empty plan is refused rather than silently rendering the whole library.
    const empty = await call('POST', '/api/brief/confirm', 'u1', { pendingId, plan: [] });
    assert.strictEqual(empty.status, 400);
    assert.match(empty.body.error, /at least one asset/);
    // A non-array plan is refused too.
    const bad = await call('POST', '/api/brief/confirm', 'u1', { pendingId, plan: 'lots' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /must be an array/);
  });
});

test('confirm: a pending parse is tenant-scoped — cross-tenant and unknown both 404', async () => {
  await withBriefServer(
    {
      runWebBriefParse: async () => ({
        campaignTitle: 'C', summary: 'S', writerPrompt: 'W', referenceInsights: [],
        plan: [{ asset: 'Battle Card', count: 2, labels: [] }],
      }),
      runWebBriefGenerate: async () => ({ docUrl: 'd' }),
    },
    async ({ call, finish }) => {
      // u1 → TENANT_A starts and pauses a brief.
      const start = await call('POST', '/api/brief', 'u1', { briefText: 'x' });
      const pendingId = (await finish(start.body.jobId, 'u1')).result.pendingId;
      assert.ok(pendingId);

      // u2 → TENANT_B knows the id and cannot use it. 404, never 403 — a 403 would
      // confirm the id exists and make this an oracle for probing other tenants.
      const cross = await call('POST', '/api/brief/confirm', 'u2', { pendingId, plan: [{ asset: 'Battle Card', count: 1 }] });
      assert.strictEqual(cross.status, 404);
      assert.match(cross.body.error, /Unknown or expired/);

      // An id that never existed is indistinguishable from another tenant's.
      const unknown = await call('POST', '/api/brief/confirm', 'u1', {
        pendingId: '00000000-0000-4000-8000-000000000000', plan: [{ asset: 'Battle Card', count: 1 }],
      });
      assert.strictEqual(unknown.status, 404);
      assert.deepStrictEqual(unknown.body.error, cross.body.error, 'same message either way');

      // The owner still works.
      const ok = await call('POST', '/api/brief/confirm', 'u1', { pendingId, plan: [{ asset: 'Battle Card', count: 1 }] });
      assert.strictEqual(ok.status, 202);
    }
  );
});

test('confirm: planNeedsConfirmation only fires on a repeat or a label', () => {
  // The predicate is now EXECUTED, not grepped. It moved from routes/app.js to
  // src/pendingBriefs.js when Slack needed the same pause rule, and being exported
  // means it can be called directly — a better test than the source match this
  // replaced, and the same rule for both surfaces by construction.
  const { planNeedsConfirmation } = require('../src/pendingBriefs');

  // The one-of-each case — every brief run before instances existed — must NOT pause.
  assert.strictEqual(planNeedsConfirmation([{ asset: 'A', count: 1 }, { asset: 'B', count: 1 }]), false);
  assert.strictEqual(planNeedsConfirmation([{ asset: 'A' }]), false, 'a missing count means 1');
  assert.strictEqual(planNeedsConfirmation([{ asset: 'A', count: 1, labels: [] }]), false);
  assert.strictEqual(planNeedsConfirmation([{ asset: 'A', count: 1, labels: [null, ''] }]), false, 'blank labels are no labels');
  // The empty plan a vague brief produces renders the whole library — no pause.
  assert.strictEqual(planNeedsConfirmation([]), false);
  for (const junk of [undefined, null, 'x', 7, {}]) {
    assert.strictEqual(planNeedsConfirmation(junk), false, `${String(junk)} → false`);
  }
  // A repeat pauses.
  assert.strictEqual(planNeedsConfirmation([{ asset: 'A', count: 2 }]), true);
  assert.strictEqual(planNeedsConfirmation([{ asset: 'A', count: 1 }, { asset: 'B', count: 3 }]), true);
  // A label pauses even at count 1 — the user named a group and should see it.
  assert.strictEqual(planNeedsConfirmation([{ asset: 'A', count: 1, labels: ['Austin'] }]), true);
});

test('confirm: the client only branches when the server says to', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('/api/brief/confirm'), 'client posts to the confirm endpoint');
  assert.ok(/screen-confirm/.test(html), 'confirm screen exists');
  assert.ok(/confirm:\s*document\.getElementById\('screen-confirm'\)/.test(html), 'registered in the screens map');
  // The branch is gated on the server's flag, so the dormant path is untouched.
  assert.ok(/if \(data && data\.needsConfirmation\)/.test(html), 'client branches on needsConfirmation');
  // Both buttons are wired, or the screen would be a dead end.
  assert.ok(/getElementById\('confirm-build-btn'\)\.addEventListener/.test(html), 'Build is wired');
  assert.ok(/getElementById\('confirm-back-btn'\)\.addEventListener/.test(html), 'Back is wired');
  // The confirm job is polled at the SAME status endpoint, so the contract is one.
  assert.ok(/'\/api\/brief\/confirm',\s*\n?\s*\{ pendingId: pendingBrief\.pendingId, plan: plan \},\s*\n?\s*'\/api\/brief'/.test(html),
    'confirm job polls /api/brief/:jobId/status');
});

// --- Per-surface instance ceilings -------------------------------------------
// Both surfaces now pause to confirm a multi-instance plan, and both build under
// 10-per-asset / 40-total. The per-surface mechanism stays so one CAN be made
// stricter; nothing uses it today.

test('surface ceilings: Slack builds under the DEFAULTS, and the mechanism remains', () => {
  const { SLACK_ASSET_LIMITS } = require('../src/adapters/slackWorkflow');
  const { MAX_INSTANCES_PER_ASSET, MAX_TOTAL_INSTANCES, DEFAULT_ASSET_LIMITS } = require('../src/core/pipeline');

  // Slack was briefly 3 / 6, on the reasoning that it has no confirmation step.
  // That over-weighted the cost of a misread: building a doc is a Drive write,
  // while the expensive part — Gemini drafting, one call per asset group — is a
  // separate deliberate button press on BOTH surfaces. So the surfaces are equal.
  assert.strictEqual(SLACK_ASSET_LIMITS.maxPerAsset, MAX_INSTANCES_PER_ASSET);
  assert.strictEqual(SLACK_ASSET_LIMITS.maxTotal, MAX_TOTAL_INSTANCES);
  assert.deepStrictEqual(SLACK_ASSET_LIMITS, DEFAULT_ASSET_LIMITS, 'Slack takes the defaults verbatim');
  assert.strictEqual(DEFAULT_ASSET_LIMITS.maxPerAsset, 10);
  assert.strictEqual(DEFAULT_ASSET_LIMITS.maxTotal, 40);

  // The MECHANISM is deliberately kept so a surface can be made stricter later:
  // core still takes a limits argument and still honours a tighter pair.
  const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'pipeline.js'), 'utf8');
  assert.ok(/function tenantAssetsToSpecs\(rows, assetsOrPlan = \[\], limits\)/.test(core), 'expansion still takes limits');
  assert.ok(/function resolveAssetLimits/.test(core), 'the resolver is still there');
  assert.ok(/projectMeta = \{\}, assetLimits\)/.test(core), 'generateDoc still takes assetLimits');
  // And core still names no surface.
  assert.ok(!/SLACK_ASSET_LIMITS/.test(core), 'core hardcodes no surface pair');
  assert.strictEqual(require('../src/core/pipeline').SLACK_ASSET_LIMITS, undefined);
  // Pointing the adapter's one constant at a tighter pair is the whole change.
  const adapter = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'slackWorkflow.js'), 'utf8');
  assert.ok(/const SLACK_ASSET_LIMITS = pipeline\.DEFAULT_ASSET_LIMITS;/.test(adapter), 'one constant to change');
});

test('surface ceilings: a surface can be stricter than the defaults, never looser', () => {
  const { resolveAssetLimits, MAX_INSTANCES_PER_ASSET, MAX_TOTAL_INSTANCES } = require('../src/core/pipeline');
  // Omitted / junk → the defaults.
  for (const l of [undefined, null, {}, { maxPerAsset: 'x', maxTotal: null }]) {
    assert.deepStrictEqual(
      { p: resolveAssetLimits(l).maxPerAsset, t: resolveAssetLimits(l).maxTotal },
      { p: MAX_INSTANCES_PER_ASSET, t: MAX_TOTAL_INSTANCES },
      `${JSON.stringify(l)} → defaults`
    );
  }
  // Stricter is honored.
  assert.strictEqual(resolveAssetLimits({ maxPerAsset: 3 }).maxPerAsset, 3);
  assert.strictEqual(resolveAssetLimits({ maxTotal: 6 }).maxTotal, 6);
  // Looser is REFUSED — a caller cannot raise its own ceiling past the absolute one.
  assert.strictEqual(resolveAssetLimits({ maxPerAsset: 999 }).maxPerAsset, MAX_INSTANCES_PER_ASSET);
  assert.strictEqual(resolveAssetLimits({ maxTotal: 999 }).maxTotal, MAX_TOTAL_INSTANCES);
  // Never below 1.
  assert.strictEqual(resolveAssetLimits({ maxPerAsset: 0, maxTotal: -5 }).maxPerAsset, MAX_INSTANCES_PER_ASSET);
  // A blank hint is dropped so the generic sentence is used.
  assert.strictEqual(resolveAssetLimits({ hint: '   ' }).hint, null);
});

// A surface that IS stricter than the defaults. Nothing ships with these today —
// Slack and the web are both 10 / 40 — but the mechanism that would honour them is
// live, so it stays tested against an explicit pair rather than against whatever
// Slack happens to be set to.
const STRICT_LIMITS = { maxPerAsset: 3, maxTotal: 6, hint: 'Split it across briefs.' };

test('surface ceilings: Slack and the web now expand a plan identically', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const { SLACK_ASSET_LIMITS } = require('../src/adapters/slackWorkflow');
  const rows = PLAN_ROWS();
  for (const plan of [
    ['Battle Card', 'Demand Gen Nurture Email'],
    [{ asset: 'Demand Gen Nurture Email', count: 5 }],
    [{ asset: 'Demand Gen Nurture Email', count: 10, labels: ['A'] }],
    [{ asset: 'Demand Gen Nurture Email', count: 3 }, { asset: 'Campaign Landing Page', count: 3 }],
    [],
  ]) {
    assert.strictEqual(
      JSON.stringify(tenantAssetsToSpecs(rows, plan, SLACK_ASSET_LIMITS)),
      JSON.stringify(tenantAssetsToSpecs(rows, plan)),
      `same expansion on both surfaces: ${JSON.stringify(plan)}`
    );
  }
  // The multiply case — 5 emails x 2 audiences — now BUILDS on Slack.
  const ten = [{ asset: 'Demand Gen Nurture Email', count: 10 }];
  assert.strictEqual(tenantAssetsToSpecs(rows, ten, SLACK_ASSET_LIMITS).length, 10, 'count 10 builds on Slack');
});

test('surface ceilings: a stricter surface would still be honoured', () => {
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const rows = PLAN_ROWS();
  // Per-asset clamp.
  assert.strictEqual(tenantAssetsToSpecs(rows, [{ asset: 'Demand Gen Nurture Email', count: 5 }], STRICT_LIMITS).length, 3);
  assert.deepStrictEqual(
    tenantAssetsToSpecs(rows, [{ asset: 'Demand Gen Nurture Email', count: 5 }], STRICT_LIMITS).map((s) => s.instance),
    [0, 1, 2],
    'ordinals still run 0..n-1 after a clamp'
  );
  // Over-total refusal, with that surface's own hint.
  assert.throws(
    () => tenantAssetsToSpecs(rows, [
      { asset: 'Demand Gen Nurture Email', count: 3 },
      { asset: 'Campaign Landing Page', count: 3 },
      { asset: 'Battle Card', count: 3 },
    ], STRICT_LIMITS),
    (err) => {
      assert.match(err.message, /asks for 9 asset instances, above the 6-instance ceiling/);
      assert.match(err.message, /Split it across briefs/);
      return true;
    }
  );
  // Exactly at the ceiling builds.
  assert.strictEqual(
    tenantAssetsToSpecs(rows, [{ asset: 'Battle Card', count: 3 }, { asset: 'Campaign Landing Page', count: 3 }], STRICT_LIMITS).length,
    6
  );
  // A vague brief still renders the whole library — 30 assets is not 30 instances.
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  assert.strictEqual(tenantAssetsToSpecs(DEFAULT_ASSETS, [], STRICT_LIMITS).length, 30);
});

test('surface ceilings: the Slack adapter passes its limits to generateDoc', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'slackWorkflow.js'), 'utf8');
  // The 6th argument of the generateDoc call, or the ceiling silently reverts to
  // the web's on the surface that can least afford it.
  assert.ok(/SLACK_ASSET_LIMITS\s*\n?\s*\);/.test(src), 'passed as the last generateDoc argument');
  assert.ok(/async function generateDoc\(spec, folderId, clients, tenantId, projectMeta = \{\}, assetLimits\)/.test(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'pipeline.js'), 'utf8')
  ), 'generateDoc accepts assetLimits');
  // The WEB adapter passes none, so it gets the defaults.
  const web = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'web.js'), 'utf8');
  assert.ok(!/assetLimits|maxPerAsset|maxTotal/.test(web), 'web adapter takes the defaults');
});

test('surface ceilings: the per-asset clamp cannot launder an over-total ask', () => {
  // Uses the hypothetical strict pair — the property belongs to the MECHANISM, not
  // to whatever Slack is currently set to (it is 10 / 40 now, same as the web).
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const SLACK_ASSET_LIMITS = STRICT_LIMITS;
  const rows = PLAN_ROWS();

  // 5 + 5 = 10 requested. Clamping each to Slack's 3 first would give 6, which is
  // EXACTLY the total ceiling — so a post-clamp check would let it through and
  // quietly build 6 of the 10 asked for, on the surface with no confirmation.
  // The total is measured on the REQUEST, so it is refused instead.
  const tenAsked = [
    { asset: 'Demand Gen Nurture Email', count: 5 },
    { asset: 'Campaign Landing Page', count: 5 },
  ];
  const clampedTotal = tenAsked.reduce((n, e) => n + Math.min(SLACK_ASSET_LIMITS.maxPerAsset, e.count), 0);
  assert.strictEqual(clampedTotal, SLACK_ASSET_LIMITS.maxTotal, 'the clamp really would land exactly on the ceiling');
  assert.throws(
    () => tenantAssetsToSpecs(rows, tenAsked, SLACK_ASSET_LIMITS),
    /asks for 10 asset instances, above the 6-instance ceiling/,
    'refused on what was asked for, not on what the clamp would leave'
  );

  // A plan genuinely at the ceiling still builds.
  assert.strictEqual(
    tenantAssetsToSpecs(
      rows,
      [{ asset: 'Demand Gen Nurture Email', count: 3 }, { asset: 'Campaign Landing Page', count: 3 }],
      SLACK_ASSET_LIMITS
    ).length,
    6
  );
  // A junk count can't inflate the message past the absolute per-asset maximum.
  assert.throws(
    () => tenantAssetsToSpecs(rows, [{ asset: 'Battle Card', count: 1e9 }], SLACK_ASSET_LIMITS),
    /asks for 10 asset instances/,
    'a garbage count counts as the absolute max (10), not 1e9'
  );
  // Web is unaffected: 10 requested is under its 40.
  assert.strictEqual(tenantAssetsToSpecs(rows, tenAsked).length, 10);
});

// --- parseBrief emits an asset PLAN ------------------------------------------
// The last step of the instance work: a brief can now ask for more than one of an
// asset. These drive the REAL parseBrief — prompt build, JSON parse, canonical
// matching, clamping — with the network stubbed, so everything except the model's
// judgement is exercised.

// Run parseBrief against a canned model response. Returns { result, prompt } so
// the prompt the model would have seen is assertable too.
async function parseBriefWith(modelJson, briefText, allowedAssets) {
  const configPath = require.resolve('../src/config');
  const cfg = require('../src/config');
  const hadKey = cfg.GEMINI_API_KEY;
  const realFetch = global.fetch;
  let sentPrompt = '';
  cfg.GEMINI_API_KEY = 'test-key';
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sentPrompt = body.contents[0].parts[0].text;
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: typeof modelJson === 'string' ? modelJson : JSON.stringify(modelJson) }] } }],
      }),
    };
  };
  try {
    const { parseBrief } = require('../src/services/gemini');
    const result = await parseBrief(briefText || 'a brief', allowedAssets);
    return { result, prompt: sentPrompt };
  } finally {
    global.fetch = realFetch;
    cfg.GEMINI_API_KEY = hadKey;
    void configPath;
  }
}
const MODEL_BASE = { campaignTitle: 'T', summary: 'S', writerPrompt: 'W', unmatchedAssets: [], folderId: null, referenceLinks: [] };

test('parseBrief: repeats survive — the dedupe is gone', async () => {
  // Two entries naming one asset are two separate asks; one entry with count 5 is
  // five versions. Neither used to be expressible.
  const { result } = await parseBriefWith({
    ...MODEL_BASE,
    assets: [
      { asset: 'Demand Gen Nurture Email', count: 5, labels: [] },
      { asset: 'Battle Card', count: 1, labels: [] },
      { asset: 'Demand Gen Nurture Email', count: 2, labels: [] },
    ],
  });
  assert.deepStrictEqual(result.assets, [
    { asset: 'Demand Gen Nurture Email', count: 5 },
    { asset: 'Battle Card', count: 1 },
    { asset: 'Demand Gen Nurture Email', count: 2 },
  ]);
});

test('parseBrief: a one-of-each brief is unchanged in substance', async () => {
  // The backward-compat case. Names still canonicalize case- and dash-insensitively,
  // order is still the brief's, and every count is 1 with no labels — so everything
  // downstream expands exactly as it did before counts existed.
  const { result } = await parseBriefWith({
    ...MODEL_BASE,
    assets: [
      { asset: 'campaign landing page', count: 1, labels: [] },
      { asset: 'Organic Social - LinkedIn', count: 1, labels: [] }, // hyphen, not em dash
      'Battle Card', // a bare string still works
    ],
  });
  assert.deepStrictEqual(result.assets, [
    { asset: 'Campaign Landing Page', count: 1 },
    { asset: 'Organic Social — LinkedIn', count: 1 },
    { asset: 'Battle Card', count: 1 },
  ]);
  assert.ok(result.assets.every((e) => e.labels === undefined), 'no labels key when there are none');
  assert.deepStrictEqual(result.unmatchedAssets, []);
});

test("parseBrief: the model's numbers are never trusted", async () => {
  // Per-asset clamp.
  const big = await parseBriefWith({ ...MODEL_BASE, assets: [{ asset: 'Battle Card', count: 400 }] });
  assert.deepStrictEqual(big.result.assets, [{ asset: 'Battle Card', count: 10 }]);
  // Junk / missing / zero / negative all floor to 1.
  for (const bad of [0, -3, null, undefined, 'five', NaN, {}]) {
    const r = await parseBriefWith({ ...MODEL_BASE, assets: [{ asset: 'Battle Card', count: bad }] });
    assert.deepStrictEqual(r.result.assets, [{ asset: 'Battle Card', count: 1 }], `count ${String(bad)} → 1`);
  }
  // Whole-plan cap: the entry that crosses it is trimmed, later ones dropped.
  const flood = await parseBriefWith({
    ...MODEL_BASE,
    assets: Array.from({ length: 8 }, () => ({ asset: 'Battle Card', count: 10 })), // 80 asked
  });
  const total = flood.result.assets.reduce((n, e) => n + e.count, 0);
  assert.strictEqual(total, 40, 'plan capped at PARSE_MAX_TOTAL');
  assert.ok(flood.result.assets.length < 8, 'entries past the cap are dropped, not kept at 0');
  assert.ok(flood.result.assets.every((e) => e.count >= 1));
});

test('parseBrief: unmatched names are still surfaced, never coerced', async () => {
  const { result } = await parseBriefWith({
    ...MODEL_BASE,
    assets: [{ asset: 'TikTok Ad', count: 3 }, { asset: 'Battle Card', count: 1 }],
    unmatchedAssets: ['Podcast spot'],
  });
  assert.deepStrictEqual(result.assets, [{ asset: 'Battle Card', count: 1 }]);
  assert.deepStrictEqual(result.unmatchedAssets, ['Podcast spot', 'TikTok Ad']);
  // Entries with no usable name are dropped rather than becoming empty assets.
  const junk = await parseBriefWith({ ...MODEL_BASE, assets: [null, 7, {}, { asset: '   ' }, 'Battle Card'] });
  assert.deepStrictEqual(junk.result.assets, [{ asset: 'Battle Card', count: 1 }]);
});

test('parseBrief: labels are positional, trimmed, and bounded by count', async () => {
  const { result } = await parseBriefWith({
    ...MODEL_BASE,
    assets: [{ asset: 'Demand Gen Nurture Email', count: 3, labels: ['  Downtown  ', '', 'Suburban', 'extra'] }],
  });
  assert.deepStrictEqual(result.assets, [
    { asset: 'Demand Gen Nurture Email', count: 3, labels: ['Downtown', null, 'Suburban'] },
  ]);
  // An all-blank label list is dropped entirely, so the entry stays label-free.
  const blank = await parseBriefWith({
    ...MODEL_BASE,
    assets: [{ asset: 'Battle Card', count: 2, labels: ['', '   '] }],
  });
  assert.deepStrictEqual(blank.result.assets, [{ asset: 'Battle Card', count: 2 }]);
});

test('parseBrief: the prompt asks for a plan and routes A/B tests to counts', async () => {
  const { prompt } = await parseBriefWith({ ...MODEL_BASE, assets: [] }, 'anything');
  // The declared shape is a plan, not a string[].
  assert.ok(/"assets": \[\{"asset": string, "count": number, "labels": string\[\]\}\]/.test(prompt),
    'schema declares the plan shape');
  assert.ok(!/"assets": string\[\]/.test(prompt), 'the old string[] schema is gone');
  // A/B phrasing must produce counts, NOT the standalone Variant asset types.
  assert.ok(/"ab test".*→ the BASE asset, count 2/.test(prompt), 'A/B routes to a count');
  // No mapping arrow anywhere points AT a Variant asset type.
  assert.ok(!/→[^\n]*Variant [A-D]/.test(prompt), 'nothing routes to Variant A-D any more');
  assert.ok(/never as a way of expressing "two versions"/.test(prompt), 'and the model is told why');
  // The Variant A-D types still EXIST — they were not deleted from the taxonomy.
  const { ALLOWED_ASSETS } = require('../src/config');
  assert.strictEqual(ALLOWED_ASSETS.length, 30);
  assert.ok(ALLOWED_ASSETS.includes('LinkedIn Single Image Ad — Variant A'));
  assert.ok(prompt.includes('LinkedIn Single Image Ad — Variant A'), 'still offered in the allowed list');
  // The cap is on TOTAL VERSIONS now, not distinct names, and it only binds when
  // the brief gave no numbers of its own.
  assert.ok(/when the brief gives NO numbers, keep the total number of versions to 5 or\nfewer/.test(prompt),
    'cap is on versions, and only when the brief is silent');
  assert.ok(/Numbers the brief actually states always win/.test(prompt));
  // A vague plural must not become a guessed number.
  assert.ok(/A vague plural is NOT a number/.test(prompt));

  // MULTIPLICATION across groups — the reading is N x M, stated as the default,
  // with the "shared total" phrasing called out as the only exception.
  assert.ok(/A NUMBER CROSSED WITH GROUPS MULTIPLIES/.test(prompt), 'the rule has its own heading');
  assert.ok(/"five nurture emails for two audiences" = 5 emails FOR EACH audience =\n  count 10/.test(prompt),
    'the worked example says 10, not 5');
  assert.ok(/ALWAYS N x M, not N shared between the groups/.test(prompt), 'the default reading is explicit');
  assert.ok(/ONLY treat the number as a shared total when the brief says so outright/.test(prompt),
    'the counter-case is explicit too');
  assert.ok(/count 5, not 10/.test(prompt), 'and it names the number the counter-case produces');
  assert.ok(/Never shrink 10 back to 5 to look tidier/.test(prompt), 'the size cap cannot undo a multiply');
  // Labels must match the multiplied count, grouped — 10 labels for count 10.
  assert.ok(/labels must have EXACTLY `count` entries, GROUPED/.test(prompt));
  assert.ok(/NOT five labels for ten versions, and NOT\n  two labels/.test(prompt),
    'the two wrong label shapes are named');
  assert.strictEqual(
    (prompt.match(/"Downtown"/g) || []).length + (prompt.match(/"Suburban"/g) || []).length,
    10,
    'the worked label example really does list ten entries'
  );
});

test('Slack clamp notice: says what was built, without failing the card', () => {
  const { clampNotice, SLACK_ASSET_LIMITS } = require('../src/adapters/slackWorkflow');
  const { buildResultBlocks } = require('../src/services/slack');

  // Nothing over the ceiling → no notice at all. Slack's ceiling is 10 per asset
  // now, and parseBrief caps a count at 10 too, so no BRIEF can currently trigger
  // this — the notice is retained (and tested) for a stricter surface or a direct
  // pipeline call, and it is what would tell a writer the doc holds fewer versions
  // than they asked for.
  assert.strictEqual(clampNotice([{ asset: 'Battle Card', count: 1 }], SLACK_ASSET_LIMITS), null);
  assert.strictEqual(clampNotice([{ asset: 'Battle Card', count: 10 }], SLACK_ASSET_LIMITS), null, 'at the ceiling is fine');
  assert.strictEqual(clampNotice([{ asset: 'Battle Card', count: 5 }], SLACK_ASSET_LIMITS), null, 'well under it, too');
  assert.strictEqual(clampNotice([], SLACK_ASSET_LIMITS), null);
  assert.strictEqual(clampNotice(['Battle Card'], SLACK_ASSET_LIMITS), null, 'bare names carry no count');

  // Over the ceiling → advisory text naming what was built vs asked.
  const notice = clampNotice([{ asset: 'Demand Gen Nurture Email', count: 12 }], SLACK_ASSET_LIMITS);
  assert.match(notice, /Built 10 of 12 Demand Gen Nurture Emails/);
  assert.match(notice, /ceiling here is 10 per asset/);
  assert.match(notice, /web app for larger plans/);
  // And on a stricter surface it reports that surface's number.
  assert.match(
    clampNotice([{ asset: 'Battle Card', count: 5 }], STRICT_LIMITS),
    /Built 3 of 5 Battle Cards — the ceiling here is 3 per asset/
  );

  // The card still reads as a SUCCESS — the notice is a context line, and the
  // header, links and draft button are all untouched.
  const { blocks } = buildResultBlocks({
    title: 'T', webViewLink: 'https://d/1', assets: ['Demand Gen Nurture Email'], docId: '1',
    folderUrl: null, folderName: null, notice,
  });
  const ctx = blocks.filter((b) => b.type === 'context');
  assert.strictEqual(ctx.length, 1, 'exactly one context line');
  assert.strictEqual(ctx[0].elements[0].text, notice);
  assert.ok(blocks.some((b) => b.type === 'header' && /doc is ready/.test(b.text.text)), 'still the ready card');
  assert.ok(blocks.some((b) => b.type === 'actions'), 'draft button intact');

  // With no notice the card is byte-identical to before this change.
  const without = buildResultBlocks({
    title: 'T', webViewLink: 'https://d/1', assets: ['Demand Gen Nurture Email'], docId: '1',
    folderUrl: null, folderName: null,
  });
  assert.strictEqual(without.blocks.filter((b) => b.type === 'context').length, 0, 'no stray context block');
});

test('Slack card: repeated instances collapse to "Name xN"', () => {
  const { buildResultBlocks } = require('../src/services/slack');
  const listOf = (assets, notice) => {
    const { blocks } = buildResultBlocks({
      title: 'T', webViewLink: 'https://d/1', assets, docId: '1', folderUrl: null, folderName: null, notice,
    });
    return blocks.find((b) => b.type === 'section' && /^\*Assets:\*/.test(b.text.text)).text.text;
  };

  // Single instances are untouched — every card written before instances existed.
  assert.strictEqual(
    listOf(['Demand Gen Nurture Email', 'Battle Card']),
    '*Assets:*\n• Demand Gen Nurture Email\n• Battle Card'
  );
  // Repeats collapse; the single one alongside them keeps its bare name.
  assert.strictEqual(
    listOf(['Demand Gen Nurture Email', 'Demand Gen Nurture Email', 'Demand Gen Nurture Email', 'Battle Card']),
    '*Assets:*\n• Demand Gen Nurture Email ×3\n• Battle Card'
  );
  // Grouped by name in FIRST-APPEARANCE order, even when not contiguous.
  assert.strictEqual(
    listOf(['Battle Card', 'Demand Gen Nurture Email', 'Battle Card']),
    '*Assets:*\n• Battle Card ×2\n• Demand Gen Nurture Email'
  );
  // The empty fallback is unchanged.
  assert.match(listOf([]), /No assets matched/);

  // THE LIST AND THE CLAMP NOTICE ARE INDEPENDENT and appear together: the list
  // says what the doc holds (3), the notice says what was cut (3 of 5).
  const { clampNotice, SLACK_ASSET_LIMITS } = require('../src/adapters/slackWorkflow');
  const notice = clampNotice([{ asset: 'Demand Gen Nurture Email', count: 12 }], SLACK_ASSET_LIMITS);
  const built = ['Demand Gen Nurture Email', 'Demand Gen Nurture Email', 'Demand Gen Nurture Email', 'Battle Card'];
  const { blocks } = buildResultBlocks({
    title: 'T', webViewLink: 'https://d/1', assets: built, docId: '1', folderUrl: null, folderName: null, notice,
  });
  assert.strictEqual(
    blocks.find((b) => b.type === 'section' && /^\*Assets:\*/.test(b.text.text)).text.text,
    '*Assets:*\n• Demand Gen Nurture Email ×3\n• Battle Card'
  );
  assert.match(blocks.find((b) => b.type === 'context').elements[0].text, /Built 10 of 12/);
});

// --- Slack parse-then-confirm -------------------------------------------------
// Slack used to ack, parse, and build in one shot: a brief asking for 10 emails got
// a 10-section doc with no chance to correct it. It now pauses on the same rule the
// web uses (pendingBriefs.planNeedsConfirmation) and posts a Block Kit CARD.
//
// It has to be a card, not a modal: a modal needs a trigger_id valid ~3s and parse
// is a multi-second Gemini round-trip, so by the time there is a plan to show there
// is no usable trigger_id left. chat.update/postMessage need none.

// Drive the REAL adapter with transport, DB, Google and the two heavy pipeline steps
// stubbed. Every Slack write lands in `sent` in order, and each build records the
// plan it was handed. buildPlanCardBlocks / buildPlanEditModalView / buildResultBlocks
// are the REAL ones, so what these tests read is what a user would see.
function withSlackBrief(overrides, fn) {
  const saved = new Map();
  const remember = (p) => { if (!saved.has(p)) saved.set(p, require.cache[p]); };
  const resolvePath = (rel) => require.resolve(path.join(__dirname, '..', rel));
  const stub = (rel, exports) => {
    const p = resolvePath(rel);
    remember(p);
    require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true, exports, children: [], paths: [] };
  };
  const reload = (rel) => { const p = resolvePath(rel); remember(p); delete require.cache[p]; return require(p); };

  const sent = [];
  const builds = [];
  // Stands in for config.SLACK_BOT_TOKEN. Defaults to SET, because that is the
  // deployment the "Building…" orphan showed up on: an env-configured workspace has
  // a working bot token the whole time even when Postgres holds no slack_bot row.
  const envBotToken = 'envBotToken' in overrides ? overrides.envBotToken : 'xoxb-env';
  // A tenant with NO slack_bot row is the DEFAULT here for the same reason.
  const tenantTokens = overrides.tokens || {};
  const realSlack = require('../src/services/slack');
  stub('src/services/slack', Object.assign({}, realSlack, {
    // slackApi's real rule: a caller's token, else the env one, else throw. Modelling
    // it is the point — the bug was a caller deciding chat.update was impossible
    // while this rule said otherwise.
    canUseBotToken: (token) => !!(token || envBotToken),
    updateMessage: async (text, url, opts = {}) => {
      sent.push({ api: 'response_url', ts: null, text, blocks: (opts && opts.blocks) || null, newMessage: !!(opts && opts.newMessage) });
    },
    updateLive: async (channel, ts, text, blocks, token) => {
      if (!(token || envBotToken)) throw new Error('SLACK_BOT_TOKEN is not set.');
      sent.push({ api: 'chat.update', channel, ts, text, blocks: blocks || null });
    },
    postLive: async (channel, text, blocks, token) => {
      if (!(token || envBotToken)) throw new Error('SLACK_BOT_TOKEN is not set.');
      sent.push({ api: 'chat.postMessage', channel, ts: 'TS1', text, blocks: blocks || null });
      return { channel, ts: 'TS1' };
    },
    postResult: async (result) => { sent.push({ api: 'postResult', ts: null, text: result.title, result }); },
    postChatMessage: async () => {},
    postFolderAccessHelp: async () => {},
    refuseUnlinkedSlack: async (o) => { sent.push({ api: 'refuseUnlinked', ts: null, slackUserId: o.slackUserId }); },
  }));
  stub('src/db', {
    resolveTenant: overrides.resolveTenant || (async () => ({
      tenant: { id: 'T1' }, tokens: tenantTokens, source: 'db', user: { id: 'U-DB' },
    })),
  });
  stub('src/google', { getClientsForTenant: async () => ({}) });
  stub('src/db/assets', { getTenantAssets: overrides.getTenantAssets || (async () => PLAN_ROWS()) });

  // The adapter uses core/pipeline as a NAMESPACE, so patch only the steps that
  // would touch the network. tenantAssetsToSpecs stays real — the expansion these
  // tests read headings out of is the shipping one.
  const pipeline = require('../src/core/pipeline');
  const savedPipeline = {};
  const patch = (k, v) => { savedPipeline[k] = pipeline[k]; pipeline[k] = v; };
  patch('parseBrief', overrides.parseBrief || (async () => ({
    campaignTitle: 'C', summary: 'S', writerPrompt: 'W', assets: [], unmatchedAssets: [], referenceLinks: [],
  })));
  patch('fetchAllReferences', async () => ({ refs: [], counts: { drive: 0, external: 0, pdf: 0, canvas: 0, upload: 0 } }));
  patch('generateDoc', async (spec, folderId, clients, tenantId, meta, limits) => {
    const specs = pipeline.tenantAssetsToSpecs(PLAN_ROWS(), spec.assets, limits);
    builds.push({ plan: spec.assets, limits, specs, createdBy: meta && meta.createdBy, folderId });
    return {
      doc: { id: 'DOC1', url: 'https://docs.google.com/document/d/DOC1/edit', title: `${spec.campaignTitle} — Copy` },
      assetSpecs: specs,
      projectFolderUrl: null,
    };
  });

  // Fresh store per test, shared with the adapter (reloaded after it).
  const pendingBriefs = reload('src/pendingBriefs');
  const adapter = reload('src/adapters/slackWorkflow');
  const slack = require('../src/services/slack');

  const headings = (specs) => {
    const { assetHeadingText } = require('../src/destinations/googleDocs');
    const totals = new Map();
    for (const s of specs) totals.set(s.assetType, (totals.get(s.assetType) || 0) + 1);
    return specs.map((s) => assetHeadingText(s.assetType, s.instance, s.instanceLabel, totals.get(s.assetType)));
  };

  return Promise.resolve(
    fn({ adapter, sent, builds, pendingBriefs, slack, headings, last: () => sent[sent.length - 1] })
  ).finally(() => {
    for (const [k, v] of Object.entries(savedPipeline)) pipeline[k] = v;
    for (const [p, mod] of saved) {
      if (mod === undefined) delete require.cache[p];
      else require.cache[p] = mod;
    }
  });
}

// The plan every "pause" test below starts from: 2 invitation emails labelled by
// city plus one landing page. Repeats AND labels, so it trips both halves of the
// confirmation rule.
const SLACK_PAUSE_PLAN = [
  { asset: 'Demand Gen Nurture Email', count: 3, labels: ['Austin', 'Denver', 'Chicago'] },
  { asset: 'Campaign Landing Page', count: 1, labels: [] },
];
const pauseParse = async () => ({
  campaignTitle: 'City Dinners', summary: 'Three city dinners', writerPrompt: 'Direct',
  assets: SLACK_PAUSE_PLAN, unmatchedAssets: [], referenceLinks: [],
});
const SLACK_OPTS = { workspaceId: 'TEAM1', slackUserId: 'USER1', channelId: 'C1' };

test('slack confirm: a ONE-OF-EACH brief does not pause — unchanged from today', async () => {
  await withSlackBrief(
    {
      parseBrief: async () => ({
        campaignTitle: 'Spring Sale', summary: 'S', writerPrompt: 'W',
        assets: [{ asset: 'Battle Card', count: 1, labels: [] }, { asset: 'Campaign Landing Page', count: 1, labels: [] }],
        unmatchedAssets: [], referenceLinks: [],
      }),
    },
    async ({ adapter, sent, builds, pendingBriefs, headings }) => {
      await adapter.runBriefWorkflow('spring sale brief', 'https://hooks.slack.test/r', SLACK_OPTS);

      // It BUILT, and no confirmation card was ever written.
      assert.strictEqual(builds.length, 1, 'the doc was built in one shot');
      assert.deepStrictEqual(builds[0].plan, [
        { asset: 'Battle Card', count: 1, labels: [] },
        { asset: 'Campaign Landing Page', count: 1, labels: [] },
      ]);
      assert.ok(!sent.some((s) => (s.blocks || []).some((b) => b.type === 'actions'
        && b.elements.some((e) => e.action_id === 'plan_build'))), 'no plan card');
      // Nothing was parked in the store, so nothing can leak or expire.
      assert.strictEqual(pendingBriefs.planNeedsConfirmation(builds[0].plan), false);

      // Exactly today's message shape: a building message, then the doc-ready card.
      assert.deepStrictEqual(sent.map((s) => s.api), ['chat.postMessage', 'chat.update']);
      assert.match(sent[0].text, /Building your document/);
      assert.match(sent[1].text, /Your doc is ready — Spring Sale — Copy/);
      assert.ok(sent[1].blocks.some((b) => b.type === 'actions'
        && b.elements.some((e) => e.action_id === 'generate_first_draft')), 'the draft button');
      // One section per asset, with no ordinal suffix — nothing repeats.
      assert.deepStrictEqual(headings(builds[0].specs), ['Battle Card', 'Campaign Landing Page']);
    }
  );
});

test('slack confirm: a MULTI-INSTANCE brief pauses on a card and builds nothing', async () => {
  await withSlackBrief({ parseBrief: pauseParse }, async ({ adapter, sent, builds, pendingBriefs }) => {
    await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);

    assert.strictEqual(builds.length, 0, 'NOTHING was created');
    assert.deepStrictEqual(sent.map((s) => s.api), ['chat.postMessage', 'chat.update']);
    const card = sent[1];
    assert.match(card.text, /Here's how I read that brief — City Dinners/);

    // The rendered card, block by block.
    assert.deepStrictEqual(card.blocks.map((b) => b.type), ['header', 'section', 'section', 'context', 'actions']);
    assert.strictEqual(card.blocks[0].text.text, "Here's how I read that brief");
    assert.strictEqual(card.blocks[1].text.text, '*City Dinners*');
    assert.strictEqual(
      card.blocks[2].text.text,
      '*4 versions to write:*\n• *3 ×* Demand Gen Nurture Email — Austin, Denver, Chicago\n• *1 ×* Campaign Landing Page'
    );
    assert.match(card.blocks[3].elements[0].text, /Nothing has been created yet/);

    // Three buttons, and each carries ONLY the pendingId — Slack caps an action
    // value near 2000 chars and a labelled plan blows through that easily.
    const buttons = card.blocks[4].elements;
    assert.deepStrictEqual(buttons.map((b) => b.action_id), ['plan_build', 'plan_edit', 'plan_cancel']);
    const pendingId = buttons[0].value;
    assert.ok(buttons.every((b) => b.value === pendingId), 'one id across all three');
    assert.ok(pendingId.length < 100, `the value is just an id (${pendingId.length} chars)`);
    assert.strictEqual(JSON.stringify(SLACK_PAUSE_PLAN).length > pendingId.length, true);

    // And the plan really is in the shared store, scoped to the workspace.
    const stored = pendingBriefs.getPending(pendingId, pendingBriefs.slackOwner('TEAM1'));
    assert.deepStrictEqual(stored.plan, SLACK_PAUSE_PLAN);
    assert.strictEqual(stored.surface, 'slack');
  });
});

test('slack confirm: Build generates the STORED plan, from the store not the button', async () => {
  await withSlackBrief({ parseBrief: pauseParse }, async ({ adapter, sent, builds, headings }) => {
    await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
    const pendingId = sent[1].blocks[4].elements[0].value;

    // What server.js does on a plan_build click: pass the id, and nothing else.
    await adapter.resumeBriefWorkflow(pendingId, null, {
      workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C1', messageTs: 'TS1',
      responseUrl: 'https://hooks.slack.test/r',
    });

    assert.strictEqual(builds.length, 1);
    assert.deepStrictEqual(builds[0].plan, SLACK_PAUSE_PLAN, 'the parsed plan, unchanged');
    assert.strictEqual(builds[0].createdBy, 'U-DB', 'written as the acting user');
    // Four sections, ordinal-disambiguated only where something repeats.
    assert.deepStrictEqual(headings(builds[0].specs), [
      'Demand Gen Nurture Email 1 — Austin',
      'Demand Gen Nurture Email 2 — Denver',
      'Demand Gen Nurture Email 3 — Chicago',
      'Campaign Landing Page',
    ]);
    // The card it clicked from became "Building…", then the doc-ready card.
    assert.deepStrictEqual(sent.slice(2).map((s) => s.api), ['chat.update', 'chat.update']);
    assert.match(sent[2].text, /Building your document/);
    assert.match(sent[3].text, /Your doc is ready/);
  });
});

test('slack confirm: Edit opens a modal whose submission changes only counts', async () => {
  await withSlackBrief({ parseBrief: pauseParse }, async ({ adapter, sent, builds, slack, headings }) => {
    await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
    const pendingId = sent[1].blocks[4].elements[0].value;

    // 1. The plan_edit click: peek synchronously (a click has ~3s to open a modal,
    //    so this cannot afford a resolveTenant round-trip) and build the view.
    const plan = adapter.peekPendingPlan(pendingId, 'TEAM1');
    assert.deepStrictEqual(plan, SLACK_PAUSE_PLAN);
    const meta = JSON.stringify({ pendingId, channel: 'C1', messageTs: 'TS1' });
    const view = slack.buildPlanEditModalView(meta, plan);

    assert.strictEqual(view.type, 'modal');
    assert.strictEqual(view.callback_id, 'plan_modal');
    assert.strictEqual(view.private_metadata, meta);
    assert.strictEqual(view.submit.text, 'Build the doc');
    const inputs = view.blocks.filter((b) => b.type === 'input');
    assert.deepStrictEqual(inputs.map((b) => b.block_id), ['count_0', 'count_1'], 'POSITIONAL block ids');
    assert.deepStrictEqual(inputs.map((b) => b.label.text), ['Demand Gen Nurture Email', 'Campaign Landing Page']);
    assert.deepStrictEqual(inputs.map((b) => b.element.initial_value), ['3', '1'], 'pre-filled with the parse');
    assert.ok(inputs.every((b) => b.element.action_id === 'count_input'));
    assert.strictEqual(inputs[0].hint.text, 'Austin, Denver, Chicago');
    // The asset NAME is nowhere in the submission surface — only counts can change.
    assert.ok(!JSON.stringify(inputs.map((b) => b.element)).includes('Demand Gen'), 'names are labels, not values');

    // 2. The submission: 3 → 2, mapped positionally the way server.js maps it.
    const values = { count_0: { count_input: { value: '2' } }, count_1: { count_input: { value: '1' } } };
    const edited = plan.map((entry, i) => {
      const raw = values[`count_${i}`].count_input.value;
      const n = parseInt(raw, 10);
      return { asset: entry.asset, count: Number.isFinite(n) ? n : entry.count, labels: entry.labels || [] };
    });
    await adapter.resumeBriefWorkflow(pendingId, edited, {
      workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C1', messageTs: 'TS1',
    });

    assert.strictEqual(builds.length, 1);
    assert.deepStrictEqual(builds[0].plan, [
      { asset: 'Demand Gen Nurture Email', count: 2, labels: ['Austin', 'Denver'] },
      { asset: 'Campaign Landing Page', count: 1 },
    ], 'the EDITED plan — labels trimmed to the new count');
    assert.deepStrictEqual(headings(builds[0].specs), [
      'Demand Gen Nurture Email 1 — Austin',
      'Demand Gen Nurture Email 2 — Denver',
      'Campaign Landing Page',
    ]);
  });
});

test('slack confirm: a submitted plan is validated and clamped server-side', async () => {
  await withSlackBrief({ parseBrief: pauseParse }, async ({ adapter, sent, builds, last }) => {
    await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
    const pendingId = sent[1].blocks[4].elements[0].value;
    const resume = (raw) => adapter.resumeBriefWorkflow(pendingId, raw, {
      workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C1', messageTs: 'TS1',
    });

    // An asset outside the library is REFUSED BY NAME, not silently dropped —
    // dropping is exactly the silent narrowing the expansion was changed to stop.
    await resume([{ asset: 'Demand Gen Nurture Email', count: 1 }, { asset: 'Skywriting', count: 1 }]);
    assert.strictEqual(builds.length, 0, 'nothing built on a bad plan');
    assert.match(last().text, /not in your library: Skywriting/);

    // Over-total is refused with the number asked for.
    await resume([
      { asset: 'Demand Gen Nurture Email', count: 10 }, { asset: 'Campaign Landing Page', count: 10 },
      { asset: 'Battle Card', count: 10 }, { asset: 'Demand Gen Nurture Email', count: 10 },
      { asset: 'Battle Card', count: 10 },
    ]);
    assert.strictEqual(builds.length, 0);
    assert.match(last().text, /asks for 50 assets, above the limit of 40/);

    // A junk count clamps rather than failing: 99 → 10, 'abc'/0/-1 → 1.
    await resume([{ asset: 'Demand Gen Nurture Email', count: 99 }, { asset: 'Battle Card', count: 'abc' },
      { asset: 'Campaign Landing Page', count: -1 }]);
    assert.strictEqual(builds.length, 1, 'clamping builds, it does not refuse');
    assert.deepStrictEqual(builds[0].plan.map((e) => [e.asset, e.count]), [
      ['Demand Gen Nurture Email', 10], ['Battle Card', 1], ['Campaign Landing Page', 1],
    ]);
    // The record survives a REFUSAL so Build can be retried without re-parsing,
    // and is dropped once a build succeeds.
    assert.strictEqual(adapter.peekPendingPlan(pendingId, 'TEAM1'), null, 'dropped after a successful build');
  });
});

test('slack confirm: an expired or foreign pendingId builds nothing and says so', async () => {
  await withSlackBrief({ parseBrief: pauseParse }, async ({ adapter, sent, builds, last }) => {
    await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
    const pendingId = sent[1].blocks[4].elements[0].value;

    // 1. An id that never existed (or was lost to a Railway restart — the store is
    //    in-memory, so that is a REAL path, and the user must see it).
    await adapter.resumeBriefWorkflow('no-such-id', null, {
      workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C1', messageTs: 'TS1',
    });
    assert.strictEqual(builds.length, 0);
    assert.match(last().text, /no longer available — Quillio restarted or it sat for more than 30 minutes/);
    assert.match(last().text, /Nothing was created/);
    assert.match(last().text, /Run `\/quillio` again/);

    // 2. ANOTHER workspace presenting a real id gets the identical message — the
    //    same-for-everything answer that keeps the store from being an id oracle.
    await adapter.resumeBriefWorkflow(pendingId, null, {
      workspaceId: 'TEAM2', slackUserId: 'USER9', channel: 'C9', messageTs: 'TS9',
    });
    assert.strictEqual(builds.length, 0, 'a foreign workspace cannot build it');
    assert.match(last().text, /no longer available/);
    assert.strictEqual(adapter.peekPendingPlan(pendingId, 'TEAM2'), null, 'and cannot read it either');
    // The owner's plan is untouched by the attempt.
    assert.deepStrictEqual(adapter.peekPendingPlan(pendingId, 'TEAM1'), SLACK_PAUSE_PLAN);
  });
});

test('slack confirm: Cancel discards the plan without building', async () => {
  await withSlackBrief({ parseBrief: pauseParse }, async ({ adapter, sent, builds, last }) => {
    await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
    const pendingId = sent[1].blocks[4].elements[0].value;

    await adapter.cancelBriefWorkflow(pendingId, { workspaceId: 'TEAM1', channel: 'C1', messageTs: 'TS1' });
    assert.strictEqual(builds.length, 0);
    assert.match(last().text, /Cancelled — nothing was created/);
    assert.strictEqual(adapter.peekPendingPlan(pendingId, 'TEAM1'), null, 'the plan is gone');

    // Clicking Build afterwards is the expired path, not a second doc.
    await adapter.resumeBriefWorkflow(pendingId, null, { workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C1', messageTs: 'TS1' });
    assert.strictEqual(builds.length, 0);
    assert.match(last().text, /no longer available/);
  });
});

test('slack confirm: an unlinked user is refused at Build, not just at parse', async () => {
  await withSlackBrief(
    { parseBrief: pauseParse, resolveTenant: async () => ({ unlinked: true, tokens: {}, tenant: null }) },
    async ({ adapter, sent, builds }) => {
      await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
      assert.deepStrictEqual(sent.map((s) => s.api), ['refuseUnlinked'], 'refused before parsing');
      // And a pendingId minted before a token was revoked cannot be built either:
      // resume re-resolves the tenant rather than trusting the stored record.
      await adapter.resumeBriefWorkflow('anything', null, { workspaceId: 'TEAM1', slackUserId: 'USER1' });
      assert.strictEqual(builds.length, 0);
    }
  );
});

test('slack confirm: server.js wires all four interaction ids', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  // The three buttons and the modal, each reachable.
  for (const id of ['plan_build', 'plan_edit', 'plan_cancel']) {
    assert.ok(new RegExp(`action\\.action_id === '${id}'`).test(src), `${id} handled`);
  }
  assert.ok(/view\.callback_id === 'plan_modal'/.test(src), 'plan_modal handled');
  // plan_modal must be checked BEFORE the regenerate_modal early return, or a plan
  // submission would fall through it and silently do nothing.
  assert.ok(src.indexOf("view.callback_id === 'plan_modal'") < src.indexOf("view.callback_id !== 'regenerate_modal'"),
    'plan_modal precedes the regenerate_modal guard');
  // The three action ids must precede generate_first_draft's branch in the same chain.
  assert.ok(src.indexOf("action.action_id === 'plan_build'") < src.indexOf("action.action_id === 'generate_first_draft'"));
  // Everything the new branches call is actually imported.
  for (const name of ['resumeBriefWorkflow', 'cancelBriefWorkflow', 'peekPendingPlan']) {
    assert.ok(new RegExp(`^\\s*${name},$`, 'm').test(src), `${name} imported`);
  }
  assert.ok(/buildPlanEditModalView,/.test(src), 'buildPlanEditModalView imported');
  assert.ok(/const \{ emoji \} = require\('\.\/emoji'\);/.test(src), 'emoji imported');
  // The block_actions ack still comes first — a button click has its own 3s window.
  assert.ok(src.indexOf("res.status(200).send('')") < src.indexOf("action.action_id === 'plan_build'"));
});

test('slack confirm: the store is ONE store, shared with the web', () => {
  const web = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  const slackAdapter = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'slackWorkflow.js'), 'utf8');
  assert.ok(/require\('\.\.\/pendingBriefs'\)/.test(web), 'web reads the shared store');
  assert.ok(/require\('\.\.\/pendingBriefs'\)/.test(slackAdapter), 'Slack reads the shared store');
  // Neither surface keeps its own Map, TTL or validator — that is the drift this
  // extraction exists to prevent.
  assert.ok(!/const PENDING = new Map/.test(web), 'no second store in the web router');
  assert.ok(!/const PENDING = new Map/.test(slackAdapter), 'no second store in the Slack adapter');
  assert.ok(!/function sanitizeAssetPlan/.test(web) && !/function sanitizeAssetPlan/.test(slackAdapter),
    'one validator, in pendingBriefs');
  // And the Slack adapter still owns no express dependency by reaching for it.
  assert.ok(!/require\('\.\.\/routes\//.test(slackAdapter), 'the adapter does not depend on the web router');
});

// The plan card IS the live message. Build must chat.update THAT message through
// Building → doc-ready, because anything else leaves a dead "Building your
// document…" card sitting above a doc announced separately below it.
//
// This regressed because resumeBriefWorkflow had TWO writers that disagreed about
// whether chat.update was possible: `say` passed no token (so slackApi's env
// fallback made it work) while buildAndPost's emit tested `!!tokens.slack_bot` (so
// on an env-configured workspace — no slack_bot row in Postgres, a real
// SLACK_BOT_TOKEN in the environment — it gave up and called postResult).
test('slack confirm: ONE message from plan card through doc-ready', async () => {
  await withSlackBrief(
    // The reproduction: no per-tenant bot token, a working env one.
    { parseBrief: pauseParse, tokens: {}, envBotToken: 'xoxb-env' },
    async ({ adapter, sent, builds }) => {
      await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
      const pendingId = sent[1].blocks[4].elements[0].value;
      await adapter.resumeBriefWorkflow(pendingId, null, {
        workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C1', messageTs: 'TS1',
        responseUrl: 'https://hooks.slack.test/r',
      });
      assert.strictEqual(builds.length, 1, 'the doc was built');

      // THE SEQUENCE. One postMessage, then every subsequent write is a chat.update
      // against that one ts.
      assert.deepStrictEqual(
        sent.map((s) => [s.api, s.ts]),
        [
          ['chat.postMessage', 'TS1'], // /quillio → "Building your document…"
          ['chat.update', 'TS1'],      // parse done → the plan card
          ['chat.update', 'TS1'],      // Build clicked → "Building your document…"
          ['chat.update', 'TS1'],      // doc created → the doc-ready card
        ]
      );
      // Exactly ONE message was ever created.
      assert.strictEqual(sent.filter((s) => s.api === 'chat.postMessage').length, 1);
      // And nothing was posted BESIDE it — postResult and a fresh response_url post
      // are the two ways the orphan appeared.
      assert.strictEqual(sent.filter((s) => s.api === 'postResult').length, 0, 'no postResult beside the card');
      assert.strictEqual(sent.filter((s) => s.api === 'response_url').length, 0, 'no response_url post beside the card');

      // The last state of that one message is the doc, not "Building…".
      assert.match(sent[3].text, /Your doc is ready/);
      assert.ok(sent[3].blocks.some((b) => b.type === 'actions'
        && b.elements.some((e) => e.action_id === 'generate_first_draft')), 'with its draft button');
      // No "Building…" survives as the final state of any message.
      const finalPerTs = new Map();
      for (const s of sent) finalPerTs.set(s.ts, s.text);
      for (const [ts, text] of finalPerTs) {
        assert.ok(!/Building your document/.test(text), `no orphan "Building…" left at ts=${ts}`);
      }
    }
  );
});

test('slack confirm: Build takes its channel and ts from the CLICKED message', async () => {
  await withSlackBrief({ parseBrief: pauseParse, tokens: {} }, async ({ adapter, sent, builds }) => {
    await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
    const pendingId = sent[1].blocks[4].elements[0].value;
    const before = sent.length;

    // server.js reads payload.channel.id / payload.message.ts. Feed DIFFERENT
    // coordinates than the parse used, and every write must follow the CLICK — that
    // is what proves resume edits the clicked card rather than re-posting.
    await adapter.resumeBriefWorkflow(pendingId, null, {
      workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C-CLICK', messageTs: 'TS-CLICK',
      responseUrl: 'https://hooks.slack.test/r',
    });

    assert.strictEqual(builds.length, 1);
    const after = sent.slice(before);
    assert.deepStrictEqual(after.map((s) => [s.api, s.channel, s.ts]), [
      ['chat.update', 'C-CLICK', 'TS-CLICK'],
      ['chat.update', 'C-CLICK', 'TS-CLICK'],
    ], 'both writes hit the clicked message');
    // The project's thread linkage records the clicked message too, so a future
    // in-thread action resolves to the doc the user is actually looking at.
    assert.strictEqual(builds[0].plan.length, 2);

    // The modal path carries the same coordinates through private_metadata, so it
    // lands on the same message.
    assert.ok(!after.some((s) => s.api === 'postResult'));
  });
});

test('slack confirm: with NO bot token anywhere it degrades instead of crashing', async () => {
  await withSlackBrief(
    { parseBrief: pauseParse, tokens: {}, envBotToken: null },
    async ({ adapter, sent, builds }) => {
      // No token at all: postLive/updateLive throw the way slackApi really does, so
      // everything goes out over response_url. Two messages here is unavoidable —
      // response_url cannot edit a message it did not create — but nothing crashes
      // and the doc still gets announced.
      await adapter.runBriefWorkflow('three city dinners', 'https://hooks.slack.test/r', SLACK_OPTS);
      assert.deepStrictEqual(sent.map((s) => s.api), ['response_url', 'response_url']);
      const pendingId = sent[1].blocks[4].elements[0].value;
      assert.ok(pendingId, 'the card still carries a working pendingId over response_url');

      await adapter.resumeBriefWorkflow(pendingId, null, {
        workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C1', messageTs: 'TS1',
        responseUrl: 'https://hooks.slack.test/r',
      });
      assert.strictEqual(builds.length, 1, 'it still builds');
      // emit TRIED chat.update (it had coordinates), caught the throw, and fell back.
      assert.deepStrictEqual(sent.slice(2).map((s) => s.api), ['response_url', 'postResult']);
    }
  );
});

test('slack confirm: Cancel is not styled danger', () => {
  const { buildPlanCardBlocks } = require('../src/services/slack');
  const { blocks } = buildPlanCardBlocks({
    pendingId: 'p', campaignTitle: 'C',
    plan: [{ asset: 'Battle Card', count: 2 }],
  });
  const buttons = blocks.find((b) => b.type === 'actions').elements;
  const byId = Object.fromEntries(buttons.map((b) => [b.action_id, b]));

  // Nothing has been created when this card is shown — the context line says so —
  // so cancelling destroys nothing and must not render as a red danger button.
  assert.strictEqual(byId.plan_cancel.style, undefined, 'Cancel renders plain');
  assert.strictEqual(byId.plan_edit.style, undefined, 'Edit renders plain');
  // Build stays the primary action.
  assert.strictEqual(byId.plan_build.style, 'primary');
  // Exactly one styled button on the card.
  assert.strictEqual(buttons.filter((b) => b.style).length, 1);
});

test('slack confirm: nobody tests tokens.slack_bot to decide if chat.update works', () => {
  const adapter = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'slackWorkflow.js'), 'utf8');
  // Comments are stripped first: the explanations of this bug legitimately QUOTE the
  // expression being banned, and a guard that trips over its own rationale is worse
  // than no guard.
  const code = adapter.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // The exact expression that stranded the "Building…" card. slackApi falls back to
  // the env token, so this test answers "no" while chat.update would have worked.
  assert.ok(!/!!tokens\.slack_bot/.test(code), 'must ask canUseBotToken, not the row');
  // BOTH flows ask the service: the brief flow and the draft flow had the same gate.
  assert.strictEqual((code.match(/canUseBotToken\(tokens\.slack_bot\)/g) || []).length, 2,
    'runBriefWorkflow and runGenerateDraft both ask the Slack service');
  // And the rule lives with slackApi's fallback, so the two cannot drift again.
  const slack = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'slack.js'), 'utf8');
  assert.ok(/function canUseBotToken\(token\) \{\s*\n\s*return !!\(token \|\| config\.SLACK_BOT_TOKEN\);/.test(slack),
    'canUseBotToken mirrors slackApi exactly');
  assert.ok(/const botToken = token \|\| config\.SLACK_BOT_TOKEN;/.test(slack), 'slackApi still has that fallback');
  // resume has ONE writer, not two that can disagree.
  const resume = adapter.slice(adapter.indexOf('async function resumeBriefWorkflow'));
  const body = resume.slice(0, resume.indexOf('async function cancelBriefWorkflow'));
  assert.strictEqual((body.match(/const emit = /g) || []).length, 1, 'one emit in resume');
  assert.ok(/const say = \(text, blocks\) =>\s*\n?\s*emit\(/.test(body), 'say routes through emit');
});

// --- Instance-aware field selection in public/app.html ------------------------
// The app keyed its selection Map on (assetType, fieldName) alone. Two instances
// of one asset have identically-named fields, so one Map entry stood for all of
// them: tapping "Subject Line 1" on the Denver email also selected it on Austin
// and Chicago, and one scoped request went out where three were meant.
//
// The suite normally reads app.html as a STRING (no jsdom, no execution — see
// CLAUDE.md). These key functions are pure, so here they are EXTRACTED AND RUN.
// That matters more than usual: the whole point of the instance tag is that it
// agrees byte-for-byte with the server's key, and only running both can show that.
function appFns(names) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  const src = names
    .map((n) => {
      // Match `function n(...) { … }` up to the closing brace at its own indent.
      const re = new RegExp(`^(\\s*)function ${n}\\([^)]*\\) \\{[\\s\\S]*?\\n\\1\\}`, 'm');
      const m = html.match(re);
      assert.ok(m, `found ${n}() in app.html`);
      return m[0];
    })
    .join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}

test('app selection key: instance-aware, and identical to the server\'s ctxKey', () => {
  const { instTag, selKey } = appFns(['instTag', 'selKey']);
  const { instanceTag } = require('../src/utils/instanceKey');
  const { ctxKey } = require('../src/destinations/googleDocs');

  // 1. The tag is the SAME serialization the server uses — including the part that
  //    carries the whole backward-compatibility guarantee: 0 → ''.
  for (const v of [undefined, null, 0, -1, 1, 2, 9, 10, 2.7, 'x', NaN, Infinity]) {
    assert.strictEqual(instTag(v), instanceTag(v), `instTag(${String(v)}) matches instanceTag`);
  }
  assert.strictEqual(instTag(0), '', 'the first instance serializes to nothing');
  assert.strictEqual(instTag(1), '#i1');

  // 2. A single-instance doc's key is BYTE-IDENTICAL to the pre-instance key, so
  //    nothing about a one-of-each doc can behave differently. This is the item
  //    that must not regress: it is every doc anyone has selected fields in.
  const legacy = (a, f) => String(a || '').trim().toLowerCase() + '|' + String(f || '').trim().toLowerCase();
  for (const [a, f] of [
    ['Battle Card', 'Headline'],
    ['Demand Gen Nurture Email', 'Subject Line 1'],
    ['  Spacey  ', '  Field  '],
    ['MiXeD Case', 'FiElD nAmE'],
  ]) {
    assert.strictEqual(selKey(a, 0, f), legacy(a, f), `instance 0 is the legacy key: ${a}/${f}`);
    assert.strictEqual(selKey(a, undefined, f), legacy(a, f), 'absent instance too');
    assert.strictEqual(selKey(a, null, f), legacy(a, f), 'null instance too');
  }

  // 3. Instances DO NOT collide — the bug.
  const k0 = selKey('Event Invitation Email', 0, 'Subject Line 1');
  const k1 = selKey('Event Invitation Email', 1, 'Subject Line 1');
  const k2 = selKey('Event Invitation Email', 2, 'Subject Line 1');
  assert.strictEqual(new Set([k0, k1, k2]).size, 3, 'three instances, three keys');
  // ...while a different FIELD on the same instance is still its own key, and the
  // same field on the same instance is still one key (selection stays idempotent).
  assert.notStrictEqual(k1, selKey('Event Invitation Email', 1, 'Subject Line 2'));
  assert.strictEqual(k1, selKey('event invitation email', 1, 'subject line 1'), 'still case-insensitive');

  // 4. And the key the app computes IS the key the server scopes on. googleDocs
  //    builds scopeKeys from ctxKey(t.assetType, t.fieldName, t.instance); if these
  //    two ever disagreed, a scoped draft would silently target nothing.
  for (const [a, i, f] of [
    ['Battle Card', 0, 'Headline'],
    ['Event Invitation Email', 1, 'Subject Line 1'],
    ['Event Invitation Email', 2, 'Preheader'],
    ['  Padded Name ', 3, ' Padded Field '],
  ]) {
    assert.strictEqual(selKey(a, i, f), ctxKey(a, f, i), `app key === server ctxKey: ${a}#${i}/${f}`);
  }
});

test('app asset heading: shows the instance only when there IS more than one', () => {
  const { instanceTotals, instanceTotalFor, assetDisplayName } = appFns([
    'instanceTotals', 'instanceTotalFor', 'assetDisplayName',
  ]);
  const { assetHeadingText } = require('../src/destinations/googleDocs');

  // A two-instance doc as getDocContent returns it: `name` is the LIBRARY name on
  // both, with `instance` and `instanceLabel` telling them apart.
  const assets = [
    { name: 'Event Invitation Email', instance: 0, instanceLabel: 'Austin' },
    { name: 'Event Invitation Email', instance: 1, instanceLabel: 'Denver' },
    { name: 'Campaign Landing Page', instance: 0, instanceLabel: null },
  ];
  const totals = instanceTotals(assets);
  assert.strictEqual(instanceTotalFor(totals, assets[0]), 2);
  assert.strictEqual(instanceTotalFor(totals, assets[2]), 1);

  const shown = assets.map((a) => assetDisplayName(a, instanceTotalFor(totals, a)));
  assert.deepStrictEqual(shown, [
    'Event Invitation Email 1 — Austin',
    'Event Invitation Email 2 — Denver',
    'Campaign Landing Page', // one instance → the bare name, exactly as today
  ]);

  // The card and the DOC agree: this is the same string googleDocs wrote into the
  // HEADING_3, so a user reading the card and a user reading the doc see one name.
  for (const a of assets) {
    assert.strictEqual(
      assetDisplayName(a, instanceTotalFor(totals, a)),
      assetHeadingText(a.name, a.instance, a.instanceLabel, instanceTotalFor(totals, a)),
      `card heading === doc heading for ${a.name}#${a.instance}`
    );
  }

  // Unlabelled instances still get an ordinal — the ordinal is what disambiguates;
  // the label is a nicety.
  const bare = [{ name: 'Battle Card', instance: 0, instanceLabel: null }, { name: 'Battle Card', instance: 1, instanceLabel: null }];
  const bt = instanceTotals(bare);
  assert.deepStrictEqual(bare.map((a) => assetDisplayName(a, instanceTotalFor(bt, a))), ['Battle Card 1', 'Battle Card 2']);

  // A single-instance doc is untouched no matter what else is on the asset.
  assert.strictEqual(assetDisplayName({ name: 'Battle Card', instance: 0, instanceLabel: 'ignored' }, 1), 'Battle Card');
  assert.strictEqual(assetDisplayName({ name: 'Battle Card' }, undefined), 'Battle Card', 'no totals → bare name');
  assert.strictEqual(assetDisplayName({}, 5), '', 'a nameless asset renders empty, not "undefined"');
});

test('app selection: every consumer of the key is instance-aware', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  // No two-argument selKey call can survive — that signature IS the bug.
  assert.ok(!/selKey\([^,)]+,\s*[^,)]+\)/.test(html), 'no 2-arg selKey call remains');
  assert.ok(/function selKey\(a, i, f\)/.test(html), 'selKey takes the instance');
  // The selection API and the matrix mutators all thread it.
  for (const fn of ['isFieldSelected', 'toggleFieldSelection', 'fieldRows', 'addRow']) {
    assert.ok(new RegExp(`function ${fn}\\(a, i, f\\)`).test(html), `${fn} takes the instance`);
  }
  for (const fn of ['updateRow', 'removeRow']) {
    assert.ok(new RegExp(`function ${fn}\\(a, i, f, r`).test(html), `${fn} takes the instance ahead of the row index`);
  }
  // The blank-field checks — the other pair that matched on assetType + fieldName.
  // They now route through selKey, so they cannot disagree with the selection Map
  // about what "the same field" is.
  for (const fn of ['isBlankProjectField', 'isBlankCopyDoneField']) {
    assert.ok(new RegExp(`function ${fn}\\(a, i, f\\)`).test(html), `${fn} takes the instance`);
  }
  assert.strictEqual(
    (html.match(/return selKey\(x\.assetType, x\.instance, x\.fieldName\) === k;/g) || []).length, 2,
    'both blank checks compare through selKey'
  );
  assert.ok(!/x\.assetType === a && x\.fieldName === f/.test(html), 'no name-only blank comparison remains');
  // computeBlankFields must record the instance or the checks above have nothing
  // to compare against.
  assert.ok(/out\.push\(\{ assetType: a\.name, instance: a\.instance, fieldName: f\.fieldName \}\)/.test(html),
    'blank fields record their instance');

  // Both outbound payloads carry it: scoped regenerate/generate, and Riff.
  assert.ok(/return \{ assetType: v\.assetType, instance: v\.instance, fieldName: v\.fieldName \};/.test(html),
    'scoped payload carries the instance');
  assert.ok(/onRiff\(\{\s*\n\s*assetType: aName,\s*\n\s*instance: aInst,/.test(html), 'Riff payload carries the instance');

  // And every card renderer passes a total, or a multi-instance doc would render
  // three identically-titled cards.
  assert.strictEqual((html.match(/instanceTotalFor\(/g) || []).length, 4, 'three renderers + the helper itself');
  assert.ok(/assetDisplayName\(asset, opts\.instanceTotal\)/.test(html), 'the card heading uses it');
});

// --- End-to-end scoped targeting: the route → googleDocs → the right instance ---
// The two halves were each correct and the middle threw the ordinal away.
// googleDocs.generateDraft has keyed its scopeKeys on
// ctxKey(assetType, fieldName, instance) since the instance work landed, but the
// /api/draft and /api/review sanitizers rebuilt each entry as {assetType,
// fieldName, …} and dropped `instance` — and dropping it does not fail loudly,
// because an absent ordinal and ordinal 0 serialize identically. A request naming
// instance 2 quietly rewrote instance 0.
//
// Three same-named assets, each with its own copy. Drive the REAL generateDraft
// with a stubbed docs client and a stubbed drafter, and read the batchUpdate it
// produces: which ranges it deletes and where it inserts is the whole answer.
const THREE_INSTANCE_PARAS = [
  { text: 'Campaign Summary', style: 'HEADING_2' },
  { text: 'sum', italic: true },
  { text: 'Writer Direction', style: 'HEADING_2' },
  { text: 'dir', italic: true },
  { text: 'Event Invitation Email 1 — Austin', style: 'HEADING_3' },
  { text: 'Subject Line 1 [70]', bold: true },
  { text: 'AUSTIN-subject' },
  { text: 'Event Invitation Email 2 — Denver', style: 'HEADING_3' },
  { text: 'Subject Line 1 [70]', bold: true },
  { text: 'DENVER-subject' },
  { text: 'Event Invitation Email 3 — Chicago', style: 'HEADING_3' },
  { text: 'Subject Line 1 [70]', bold: true },
  { text: 'CHICAGO-subject' },
];

// Run generateDraft against the three-instance doc and report what each instance's
// Subject Line 1 holds afterwards. `scopedFields` goes in exactly as a route would
// hand it over. Returns { before, after, deletes, inserts }.
async function runScopedDraft(scopedFields) {
  const savedGemini = require.cache[require.resolve('../src/services/gemini')];
  const savedDocs = require.cache[require.resolve('../src/destinations/googleDocs')];
  const gp = require.resolve('../src/services/gemini');
  const realGemini = require('../src/services/gemini');
  require.cache[gp] = {
    id: gp, filename: gp, path: path.dirname(gp), loaded: true, children: [], paths: [],
    exports: Object.assign({}, realGemini, {
      // Whatever asset/instance this is called for, return a marker naming it, so
      // the copy that lands proves WHICH target was drafted.
      generateFieldDraft: async ({ assetType, fieldName, siblings }) =>
        `NEW(${assetType}/${fieldName}/siblings=${(siblings || []).length})`,
      generateAssetDrafts: async () => { throw new Error('whole-doc path must not run on a scoped call'); },
    }),
  };
  delete require.cache[require.resolve('../src/destinations/googleDocs')];
  try {
    const g = require('../src/destinations/googleDocs');
    const doc = instDoc(THREE_INSTANCE_PARAS);
    const requests = [];
    const clients = {
      docs: {
        documents: {
          get: async () => ({ data: doc }),
          batchUpdate: async ({ requestBody }) => { requests.push(...(requestBody.requests || [])); return { data: {} }; },
        },
      },
    };
    const subjectsOf = (d) => {
      const out = [];
      let current = null;
      let label = null;
      for (const it of d.body.content) {
        const p = it.paragraph;
        if (!p) continue;
        const text = (p.elements || []).map((e) => (e.textRun && e.textRun.content) || '').join('').replace(/\n$/, '');
        const style = p.paragraphStyle && p.paragraphStyle.namedStyleType;
        if (style === 'HEADING_3') { current = text; label = null; continue; }
        if ((p.elements || [])[0] && p.elements[0].textRun.textStyle.bold) { label = text; continue; }
        if (current && label === 'Subject Line 1 [70]') { out.push([current, text]); label = null; }
      }
      return out;
    };
    const before = subjectsOf(doc);

    // The doc is edited by the SAME index arithmetic the Docs API applies: apply
    // each request to the fixture in the order generateDraft emitted it, so "after"
    // is what the document would really contain — not an assumption about it.
    const flat = doc.body.content
      .filter((it) => it.paragraph)
      .map((it) => ({
        start: it.startIndex,
        end: it.endIndex,
        item: it,
        text: (it.paragraph.elements || []).map((e) => (e.textRun && e.textRun.content) || '').join(''),
      }));

    await g.generateDraft('doc-1', undefined, clients, null, null, scopedFields, false);

    // Replay: an insertText at index I lands in the paragraph whose range covers I.
    const deletes = requests.filter((r) => r.deleteContentRange).map((r) => r.deleteContentRange.range);
    const inserts = requests.filter((r) => r.insertText).map((r) => ({ index: r.insertText.location.index, text: r.insertText.text }));
    const after = before.map(([heading, text]) => [heading, text]);
    for (const ins of inserts) {
      const hit = flat.find((p) => ins.index >= p.start && ins.index < p.end);
      assert.ok(hit, `insert at ${ins.index} lands inside a known paragraph`);
      // Which asset heading precedes it?
      const idx = flat.indexOf(hit);
      let heading = null;
      for (let i = idx; i >= 0; i -= 1) {
        const st = flat[i].item.paragraph.paragraphStyle;
        if (st && st.namedStyleType === 'HEADING_3') { heading = flat[i].text.replace(/\n$/, ''); break; }
      }
      const row = after.find((r) => r[0] === heading);
      assert.ok(row, `insert resolved to a known asset heading (got ${heading})`);
      row[1] = ins.text.replace(/\n/g, '');
    }
    return { before, after, deletes, inserts, requests };
  } finally {
    if (savedGemini === undefined) delete require.cache[gp]; else require.cache[gp] = savedGemini;
    const dp = require.resolve('../src/destinations/googleDocs');
    if (savedDocs === undefined) delete require.cache[dp]; else require.cache[dp] = savedDocs;
  }
}

test('scoped targeting: instance 2 is rewritten; instances 0 and 1 are untouched', async () => {
  // Exactly what /api/draft now hands to the adapter for a click on the third card.
  const r = await runScopedDraft([
    { assetType: 'Event Invitation Email', instance: 2, fieldName: 'Subject Line 1', count: 1, distance: 'close' },
  ]);

  assert.deepStrictEqual(r.before, [
    ['Event Invitation Email 1 — Austin', 'AUSTIN-subject'],
    ['Event Invitation Email 2 — Denver', 'DENVER-subject'],
    ['Event Invitation Email 3 — Chicago', 'CHICAGO-subject'],
  ]);

  // ONE field drafted, ONE range deleted, ONE insert — the two unselected
  // instances never enter the request list at all, so they are byte-identical.
  assert.strictEqual(r.inserts.length, 1, 'exactly one insert');
  assert.strictEqual(r.deletes.length, 1, 'exactly one delete');

  assert.deepStrictEqual(r.after, [
    ['Event Invitation Email 1 — Austin', 'AUSTIN-subject'],   // untouched
    ['Event Invitation Email 2 — Denver', 'DENVER-subject'],   // untouched
    ['Event Invitation Email 3 — Chicago', 'NEW(Event Invitation Email/Subject Line 1/siblings=0)'],
  ]);

  // The deleted range is CHICAGO's copy paragraph, not Austin's. Proven against
  // the fixture's own indices rather than by eyeballing the numbers.
  const doc = instDoc(THREE_INSTANCE_PARAS);
  const paraNamed = (t) => doc.body.content.find((it) =>
    it.paragraph && (it.paragraph.elements || []).map((e) => e.textRun.content).join('') === t + '\n');
  const chicago = paraNamed('CHICAGO-subject');
  const austin = paraNamed('AUSTIN-subject');
  assert.ok(r.deletes[0].startIndex >= chicago.startIndex && r.deletes[0].startIndex < chicago.endIndex,
    `the delete falls inside CHICAGO-subject (${chicago.startIndex}..${chicago.endIndex}), got ${r.deletes[0].startIndex}`);
  assert.ok(r.deletes[0].startIndex >= austin.endIndex, 'and is nowhere near AUSTIN-subject');
});

test('scoped targeting: no `instance` still means instance 0 — older clients keep working', async () => {
  // A client built before this change sends no ordinal. That must behave exactly
  // as it always did: target the FIRST instance. This is the compatibility
  // guarantee the whole 0-serializes-to-nothing rule exists for.
  const bare = await runScopedDraft([{ assetType: 'Event Invitation Email', fieldName: 'Subject Line 1' }]);
  assert.deepStrictEqual(bare.after, [
    ['Event Invitation Email 1 — Austin', 'NEW(Event Invitation Email/Subject Line 1/siblings=0)'],
    ['Event Invitation Email 2 — Denver', 'DENVER-subject'],
    ['Event Invitation Email 3 — Chicago', 'CHICAGO-subject'],
  ]);

  // ...and an EXPLICIT 0 is indistinguishable from omitting it.
  const zero = await runScopedDraft([{ assetType: 'Event Invitation Email', instance: 0, fieldName: 'Subject Line 1' }]);
  assert.deepStrictEqual(zero.after, bare.after, 'instance 0 === absent instance');
  assert.deepStrictEqual(zero.deletes, bare.deletes, 'down to the same deleted range');

  // The middle instance, for completeness — all three ordinals are reachable and
  // each hits exactly one.
  const one = await runScopedDraft([{ assetType: 'Event Invitation Email', instance: 1, fieldName: 'Subject Line 1' }]);
  assert.deepStrictEqual(one.after, [
    ['Event Invitation Email 1 — Austin', 'AUSTIN-subject'],
    ['Event Invitation Email 2 — Denver', 'NEW(Event Invitation Email/Subject Line 1/siblings=0)'],
    ['Event Invitation Email 3 — Chicago', 'CHICAGO-subject'],
  ]);

  // An out-of-range ordinal matches NOTHING rather than falling back to 0. That is
  // the failure the clamp is designed to produce: nothing is written.
  const none = await runScopedDraft([{ assetType: 'Event Invitation Email', instance: 7, fieldName: 'Subject Line 1' }]);
  assert.deepStrictEqual(none.after, none.before, 'nothing changed');
  assert.strictEqual(none.requests.length, 0, 'no batchUpdate request at all');
});

test('scoped instance clamp: a client number is bounded, and junk means 0', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  const { MAX_TOTAL_INSTANCES } = require('../src/core/pipeline');

  // Re-derive the route's clamp and check it, rather than trusting the source read.
  // eslint-disable-next-line no-new-func
  const scopedInstance = new Function('MAX_TOTAL_INSTANCES',
    src.match(/^function scopedInstance\(raw\) \{[\s\S]*?\n\}/m)[0] + '\nreturn scopedInstance;')(MAX_TOTAL_INSTANCES);

  // Junk → 0, which is the pre-instance behavior.
  for (const v of [undefined, null, '', 'abc', NaN, {}, [], true, Infinity, -Infinity]) {
    assert.strictEqual(scopedInstance(v), 0, `${JSON.stringify(v) || String(v)} → 0`);
  }
  // Negatives → 0. A doc has no instance -1.
  assert.strictEqual(scopedInstance(-1), 0);
  assert.strictEqual(scopedInstance(-999), 0);
  // In range, passed through — including from a string, since JSON can carry one.
  assert.strictEqual(scopedInstance(0), 0);
  assert.strictEqual(scopedInstance(2), 2);
  assert.strictEqual(scopedInstance('2'), 2);
  assert.strictEqual(scopedInstance(2.9), 2, 'truncated, not rounded');
  assert.strictEqual(scopedInstance(MAX_TOTAL_INSTANCES - 1), MAX_TOTAL_INSTANCES - 1);
  // Above the ceiling → clamped to the top, which matches no asset in any real
  // doc, so the field is skipped rather than silently hitting instance 0.
  assert.strictEqual(scopedInstance(MAX_TOTAL_INSTANCES), MAX_TOTAL_INSTANCES - 1);
  assert.strictEqual(scopedInstance(999999), MAX_TOTAL_INSTANCES - 1);

  // BOTH sanitizers use it — /api/draft and /api/review. copyReview keys on the
  // instance exactly as generateDraft does, so review had the same silent
  // mistargeting until this landed.
  assert.strictEqual((src.match(/instance: scopedInstance\(f\.instance\)/g) || []).length, 2,
    'the draft AND review sanitizers both carry the instance');
});

test('scoped targeting: the instance survives the /api/draft and /api/review routes', async () => {
  // The missing link. The two tests above prove googleDocs targets the right
  // instance GIVEN one, and that the clamp is sane. This drives the real routers
  // over a loopback listener and reads what the adapter was actually handed —
  // which is the step that used to lose the ordinal.
  let sawDraft = null;
  let sawReview = null;
  await withStubbedDb(async (router) => {
    const express = require('express');
    const http = require('node:http');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: 'u1' }; next(); });
    app.use(router);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const post = async (url, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      const scoped = [
        { assetType: 'Event Invitation Email', instance: 2, fieldName: 'Subject Line 1' },
        { assetType: 'Event Invitation Email', fieldName: 'Preheader' },        // no ordinal → 0
        { assetType: 'Event Invitation Email', instance: '1', fieldName: 'Headline' }, // JSON string
        { assetType: 'Event Invitation Email', instance: 999, fieldName: 'CTA' },      // clamped
      ];
      const d = await post('/api/draft', { docId: 'DOC1', scopedFields: scoped });
      assert.strictEqual(d.status, 202);
      const rv = await post('/api/review', { docId: 'DOC1', scopedFields: scoped });
      assert.strictEqual(rv.status, 202);
      // Both jobs are fire-and-forget; give them a tick to invoke the adapter.
      for (let i = 0; i < 40 && !(sawDraft && sawReview); i += 1) await new Promise((r) => setTimeout(r, 10));
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, {
    runWebDraft: async (_docId, _ctx, _direction, scopedFields) => { sawDraft = scopedFields; return {}; },
    runWebReview: async (_docId, _ctx, scopedFields) => { sawReview = scopedFields; return {}; },
  });

  const { MAX_TOTAL_INSTANCES } = require('../src/core/pipeline');
  assert.ok(sawDraft, 'the draft adapter ran');
  assert.ok(sawReview, 'the review adapter ran');

  // /api/draft: the ordinal arrives, clamped, alongside the variation controls.
  assert.deepStrictEqual(
    sawDraft.map((f) => [f.fieldName, f.instance]),
    [['Subject Line 1', 2], ['Preheader', 0], ['Headline', 1], ['CTA', MAX_TOTAL_INSTANCES - 1]]
  );
  assert.strictEqual(sawDraft[0].count, 1, 'the existing count default is untouched');
  assert.strictEqual(sawDraft[0].distance, 'close', 'and the distance default');

  // /api/review: the same ordinals, and still only the three identity fields.
  assert.deepStrictEqual(
    sawReview.map((f) => [f.fieldName, f.instance]),
    [['Subject Line 1', 2], ['Preheader', 0], ['Headline', 1], ['CTA', MAX_TOTAL_INSTANCES - 1]]
  );
  assert.deepStrictEqual(Object.keys(sawReview[0]).sort(), ['assetType', 'fieldName', 'instance']);
});

// --- Stale-shell check: hooked into the fetch funnel, cached ------------------
// This check existed but was called from exactly two hand-picked places — page
// load, and the top of runBrief. Every other screen rendered server data with no
// warning, which produced three bug reports against code that was correct.
//
// It is now called from fetchWithTimeout, which every server read in the app goes
// through, so a screen added later inherits it. These tests EXECUTE the real
// function (extracted from app.html) against a fake fetch rather than matching
// source strings, because the parts that matter are the caching and the
// fail-open behavior.

// Extract the stale-shell block and run it with a controllable fetch + clock.
function shellChecker({ build, liveSeq, failSeq }) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  const body = html.match(/^(\s*)function checkShellFresh\(\) \{[\s\S]*?\n\1\}/m);
  assert.ok(body, 'found checkShellFresh() in app.html');
  const state = html.match(/var shellStale = null;[\s\S]*?var SHELL_TTL_MS = \d+;/);
  assert.ok(state, 'found the cache state + TTL');

  const calls = { health: 0 };
  let i = 0;
  const fakeFetch = () => {
    calls.health += 1;
    const n = i; i += 1;
    if ((failSeq || [])[n]) return Promise.reject(new Error('offline'));
    return Promise.resolve({ json: async () => ({ ok: true, commit: (liveSeq || [])[n] }) });
  };
  const banner = { style: { display: 'none' } };
  const sandbox = {
    fetch: fakeFetch,
    window: {},
    console: { log() {} },
    document: { getElementById: (id) => (id === 'stale-shell-banner' ? banner : null) },
    Date: { now: () => sandbox.__now },
    __now: 1000,
  };
  // The real source, with APP_BUILD supplied by the test instead of the server's
  // __BUILD__ substitution.
  // eslint-disable-next-line no-new-func
  const make = new Function(
    'fetch', 'window', 'console', 'document', 'Date', 'APP_BUILD',
    `${state[0]}\n${body[0]}\nreturn checkShellFresh;`
  );
  const fn = make(sandbox.fetch, sandbox.window, sandbox.console, sandbox.document, sandbox.Date, build);
  return {
    check: fn,
    calls,
    banner,
    advance: (ms) => { sandbox.__now += ms; },
    ttl: Number(state[0].match(/SHELL_TTL_MS = (\d+)/)[1]),
  };
}

test('stale shell: a matching build is fresh, a different one is stale and banners', async () => {
  const same = shellChecker({ build: 'abc1234', liveSeq: ['abc1234'] });
  assert.strictEqual(await same.check(), false, 'same commit → fresh');
  assert.strictEqual(same.banner.style.display, 'none', 'no banner');

  const diff = shellChecker({ build: 'abc1234', liveSeq: ['def5678'] });
  assert.strictEqual(await diff.check(), true, 'different commit → stale');
  assert.strictEqual(diff.banner.style.display, 'block', 'the reload banner is shown');

  // The two cases that must NOT raise a banner: a server that does not know its
  // own commit, and a shell whose placeholder was never substituted (local dev).
  const unknown = shellChecker({ build: 'abc1234', liveSeq: ['unknown'] });
  assert.strictEqual(await unknown.check(), false, "live 'unknown' → inconclusive");
  assert.strictEqual(unknown.banner.style.display, 'none');
  const unstamped = shellChecker({ build: '__BUILD__', liveSeq: ['abc1234'] });
  assert.strictEqual(await unstamped.check(), false, 'unsubstituted placeholder → inconclusive');
  assert.strictEqual(unstamped.banner.style.display, 'none');
});

test('stale shell: a failed check resolves FALSE and never banners', async () => {
  // The whole contract on uncertainty: let the user work. A blip must not block a
  // brief and must not raise a banner the user cannot act on.
  const s = shellChecker({ build: 'abc1234', failSeq: [true] });
  assert.strictEqual(await s.check(), false, 'a rejected /health resolves false');
  assert.strictEqual(s.banner.style.display, 'none');

  // A failure is not remembered as a VERDICT — only as an attempt. Once the TTL
  // expires the next call re-probes and can still discover staleness.
  const s2 = shellChecker({ build: 'abc1234', failSeq: [true, false], liveSeq: [undefined, 'def5678'] });
  assert.strictEqual(await s2.check(), false);
  s2.advance(s2.ttl + 1);
  assert.strictEqual(await s2.check(), true, 'recovers and reports stale');
  assert.strictEqual(s2.calls.health, 2);
});

test('stale shell: cached, so hooking it into every fetch costs no round trip', async () => {
  const s = shellChecker({ build: 'abc1234', liveSeq: ['abc1234', 'abc1234'] });

  // A burst of renders — this is runJob's 3s status poll, the projects list, the
  // project view — shares ONE /health.
  for (let i = 0; i < 25; i += 1) assert.strictEqual(await s.check(), false);
  assert.strictEqual(s.calls.health, 1, '25 fetches, one /health');

  // Still cached just under the TTL; re-probed just past it, because a deploy can
  // land while the tab sits open. A verdict that never expired would be the
  // original bug.
  s.advance(s.ttl - 1);
  await s.check();
  assert.strictEqual(s.calls.health, 1, 'inside the TTL → still cached');
  s.advance(2);
  await s.check();
  assert.strictEqual(s.calls.health, 2, 'past the TTL → re-probed');

  // Concurrent callers share one in-flight probe rather than racing.
  const c = shellChecker({ build: 'abc1234', liveSeq: ['abc1234'] });
  const all = await Promise.all([c.check(), c.check(), c.check(), c.check()]);
  assert.deepStrictEqual(all, [false, false, false, false]);
  assert.strictEqual(c.calls.health, 1, 'four concurrent calls, one /health');
});

test('stale shell: once stale, it stops asking — a shell cannot un-stale itself', async () => {
  const s = shellChecker({ build: 'abc1234', liveSeq: ['def5678', 'abc1234'] });
  assert.strictEqual(await s.check(), true);
  assert.strictEqual(s.calls.health, 1);

  // Even far past the TTL, and even though the next canned answer would say
  // "fresh", the verdict is terminal: a loaded shell cannot update itself, so yes
  // can never become no. This also means a stale tab makes no further requests.
  s.advance(s.ttl * 100);
  for (let i = 0; i < 10; i += 1) assert.strictEqual(await s.check(), true);
  assert.strictEqual(s.calls.health, 1, 'no further /health once stale');
  assert.strictEqual(s.banner.style.display, 'block', 'and the banner stays up');
});

test('stale shell: the check is wired to the fetch funnel, not a hand-picked list', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  // THE hook: inside fetchWithTimeout, which is the single funnel for every server
  // read. This is what makes a future screen inherit the check.
  assert.ok(/function fetchWithTimeout\(url, opts, timeoutMs\) \{[\s\S]{0,900}?\n      checkShellFresh\(\);/.test(html),
    'checkShellFresh is called inside fetchWithTimeout');
  // NOT awaited there — it only drives a banner, so it must add no latency and must
  // never delay or block a render.
  assert.ok(!/await checkShellFresh\(\);\s*\n\s*var ctrl = new AbortController/.test(html),
    'the funnel does not await it');

  // Every server READ in the app goes through that funnel. If a new call site
  // appears here, it needs the check (or needs to use fetchWithTimeout).
  const rawFetches = (html.match(/[^.\w]fetch\(/g) || []).length;
  assert.strictEqual(rawFetches, 4, 'exactly four raw fetch() call sites — see below');
  // 1. fetchWithTimeout itself (the funnel)
  assert.ok(/merged\.signal = ctrl\.signal;\s*\n\s*return fetch\(url, merged\)/.test(html));
  // 2. /health inside checkShellFresh — MUST stay a raw fetch or it recurses.
  assert.ok(/fetch\('\/health', \{ cache: 'no-store' \}\)/.test(html), '/health probe');
  assert.ok(!/fetchWithTimeout\('\/health'/.test(html), '/health must not route through the funnel');
  // 3-4. Two WRITES (upload, status PATCH), each reached from a screen that already
  //      fetched through the funnel, so both are covered by a preceding check.
  assert.ok(/await fetch\('\/api\/upload'/.test(html), 'upload is a write');
  assert.ok(/await fetch\('\/api\/projects\/' \+ encodeURIComponent\(projectId\) \+\s*\n\s*'\/status/.test(html),
    'status PATCH is a write');

  // The reads that used to be unguarded, all now funnelled: the job start + status
  // poll, doc content, the projects list, and the project view.
  assert.strictEqual((html.match(/fetchWithTimeout\(/g) || []).length, 6,
    'the definition plus five call sites');

  // runBrief keeps its HARD block — the one place where proceeding is expensive
  // enough to be worth stopping for. Everywhere else the banner is the warning.
  assert.ok(/if \(await checkShellFresh\(\)\) \{ showError\(briefError, STALE_MSG\); return; \}/.test(html),
    'runBrief still blocks outright');

  // And the load-time probe survives, so a tab opened onto an already-stale shell
  // warns before the user touches anything.
  assert.ok(/\n    checkShellFresh\(\);\n  <\/script>/.test(html), 'load-time probe at the end of the script');

  // The ordering hazard: APP_BUILD's assignment must precede fetchWithTimeout, or a
  // hoisted `undefined` would compare unequal to the live commit and banner falsely.
  assert.ok(html.indexOf("var APP_BUILD = '__BUILD__';") < html.indexOf('function fetchWithTimeout'),
    'APP_BUILD is assigned before the funnel that reads it');
});

// --- July 2026 spec-integrity pass -------------------------------------------
// The library shipped numbers that were wrong, tiers that overstated what the
// platform actually requires, and citations pointing at pages that do not contain
// the number being cited. All three are USER-VISIBLE: spec_type becomes the italic
// sentence under the field label and spec_source is the link behind the platform
// name (see "Spec metadata renders" in CLAUDE.md).

test('spec integrity: the three tier sentences, rendered', () => {
  const { fieldHint } = require('../src/destinations/googleDocs');
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const field = (asset, name) =>
    DEFAULT_ASSETS.find((a) => a.name === asset).fields.find((f) => f.field_name === name);
  const hintOf = (asset, name) => {
    const f = field(asset, name);
    return fieldHint({ specType: f.spec_type, specSource: f.spec_source, specNote: f.spec_note });
  };

  // ENFORCED — a real cap, stated as one.
  const enf = hintOf('LinkedIn Single Image Ad', 'Headline');
  assert.strictEqual(enf.text, 'Platform limit (LinkedIn). Stay within this count.');
  assert.strictEqual(enf.text.substring(enf.links[0].start, enf.links[0].end), 'LinkedIn');
  assert.strictEqual(enf.links[0].url,
    'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs');

  // RECOMMENDED — the branch that existed in the renderer but had no data. It says
  // "not a hard limit", and it still hyperlinks the platform name.
  const rec = hintOf('Meta Single Image Ad', 'Primary Text');
  assert.strictEqual(rec.text, 'Recommended by Meta. Not a hard limit — adjust for your brand and goal.');
  assert.strictEqual(rec.links.length, 1, 'the platform name is still a link');
  assert.strictEqual(rec.text.substring(rec.links[0].start, rec.links[0].end), 'Meta');
  assert.strictEqual(rec.links[0].url, 'https://www.facebook.com/business/ads-guide/update');

  // HOUSE_DEFAULT with no note — renders NOTHING. An unsourced number must not
  // claim any authority at all.
  assert.strictEqual(hintOf('Event Landing Page', 'Hero Headline'), null);

  // HOUSE_DEFAULT with a note — the note alone, no tier sentence appended.
  const note = hintOf('Demand Gen Nurture Email', 'Subject Line 1');
  assert.strictEqual(note.text, 'Mobile inboxes cut around 40 characters — front-load the first 40. (Litmus)');
  assert.ok(!/Platform limit|Recommended by/.test(note.text), 'no tier sentence on a house default');
  assert.strictEqual(note.text.substring(note.links[0].start, note.links[0].end), 'Litmus',
    'the hand-written note credit is still hyperlinked');

  // And a field carrying BOTH: the note first, then the tier line, one paragraph,
  // with two independent link ranges that do not overlap.
  const both = hintOf('LinkedIn Single Image Ad', 'Intro Text');
  assert.strictEqual(both.text,
    'In-feed preview truncates near 150; 600 is the technical max. Platform limit (LinkedIn). Stay within this count.');
  assert.strictEqual(both.links.length, 1, 'only the tier line has a link here (the note has no known credit)');
  assert.strictEqual(both.text.substring(both.links[0].start, both.links[0].end), 'LinkedIn');
});

test('spec integrity: the corrected numbers, and what was deliberately NOT changed', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const f = (asset, name) => {
    const a = DEFAULT_ASSETS.find((x) => x.name === asset);
    assert.ok(a, `asset ${asset} exists`);
    const fl = a.fields.find((x) => x.field_name === name);
    assert.ok(fl, `field ${asset}/${name} exists`);
    return fl;
  };

  // 2. Meta Carousel: 45 was LinkedIn's carousel number, 18 matched nothing published.
  for (let i = 1; i <= 5; i += 1) assert.strictEqual(f('Meta Carousel Ad', `Card ${i} Headline`).char_max, 40);
  assert.strictEqual(f('Meta Carousel Ad', 'Card Description').char_max, 20);
  // LinkedIn keeps 45 — that IS LinkedIn's number, and it stays enforced.
  for (let i = 1; i <= 5; i += 1) {
    assert.strictEqual(f('LinkedIn Carousel Ad', `Card ${i} Headline`).char_max, 45);
    assert.strictEqual(f('LinkedIn Carousel Ad', `Card ${i} Headline`).spec_type, 'enforced');
  }

  // 1. The numbers that stay ENFORCED because the platform's own page states them
  //    as limits — untouched in value as well as tier.
  assert.strictEqual(f('LinkedIn Single Image Ad', 'Headline').char_max, 70);
  assert.strictEqual(f('LinkedIn Single Image Ad', 'Intro Text').char_max, 150);
  assert.strictEqual(f('LinkedIn Single Image Ad', 'LAN Description').char_max, 70);
  assert.strictEqual(f('Twitter/X Ad', 'Ad Copy').char_max, 280);
  for (const [a, n] of [['LinkedIn Single Image Ad', 'Headline'], ['LinkedIn Single Image Ad', 'Intro Text'],
    ['LinkedIn Single Image Ad', 'LAN Description'], ['Twitter/X Ad', 'Ad Copy']]) {
    assert.strictEqual(f(a, n).spec_type, 'enforced', `${a}/${n} stays enforced`);
  }

  // 1. Meta's values are unchanged in NUMBER — only the claim about them changed.
  assert.strictEqual(f('Meta Single Image Ad', 'Primary Text').char_max, 125);
  assert.strictEqual(f('Meta Single Image Ad', 'Headline').char_max, 40);
  assert.strictEqual(f('Meta Single Image Ad', 'Description').char_max, 30);

  // 4. Organic X: a genuine hard cap that was an uncited house default.
  const x = f('Organic Social — Twitter/X', 'Post Copy');
  assert.strictEqual(x.char_max, 280, 'the number was already right');
  assert.strictEqual(x.spec_type, 'enforced', 'now tiered as the cap it is');
  assert.match(x.spec_source, /^https:\/\/business\.x\.com\//, 'and cited');

  // 5 + 6. Email bands.
  const EMAILS = ['Demand Gen Nurture Email', 'Event Invitation Email', 'Event Reminder Email',
    'Event Follow-Up / Recap Email', 'Sales Basho Email'];
  for (const e of EMAILS) {
    assert.deepStrictEqual([f(e, 'Preheader').char_min, f(e, 'Preheader').char_max], [85, 100], `${e} preheader`);
    for (const sl of ['Subject Line 1', 'Subject Line 2']) {
      assert.strictEqual(f(e, sl).char_min, 0, `${e}/${sl} has no floor`);
      assert.strictEqual(f(e, sl).char_max, e === 'Sales Basho Email' ? 40 : 130, `${e}/${sl} ceiling`);
    }
  }

  // The dropped floor is visible in the LABEL, which is what a writer actually
  // reads: `[50-75]` became `[130]`. That instruction — "reach 50 characters" —
  // was the wrong one to give, and it is now simply absent.
  const { fieldLabel } = require('../src/destinations/googleDocs');
  const label = (asset, name) => {
    const fl = f(asset, name);
    return fieldLabel({ fieldName: fl.field_name, charMin: fl.char_min, charMax: fl.char_max });
  };
  assert.strictEqual(label('Demand Gen Nurture Email', 'Subject Line 1'), 'Subject Line 1 [130]');
  assert.strictEqual(label('Sales Basho Email', 'Subject Line 1'), 'Subject Line 1 [40]');
  assert.strictEqual(label('Demand Gen Nurture Email', 'Preheader'), 'Preheader [85-100]');
});

test('spec integrity: the Google asset was renamed to match its source, everywhere', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { RENAME } = require('../scripts/migrateSpecIntegrityFixes');
  const config = require('../src/config');

  assert.strictEqual(RENAME.from, 'Google DV360 / Responsive Display');
  assert.strictEqual(RENAME.to, 'Google Responsive Display Ad');

  const asset = DEFAULT_ASSETS.find((a) => a.name === RENAME.to);
  assert.ok(asset, 'the renamed asset is in the seed');
  // The NUMBERS were right and are untouched — Google Ads Responsive Display
  // values. The name was what disagreed with the source, so the name changed.
  assert.deepStrictEqual(
    asset.fields.filter((f) => f.spec_type === 'enforced').map((f) => [f.field_name, f.char_max]),
    [['Short Headline', 30], ['Long Headline', 90], ['Description', 90], ['Business Name', 25]]
  );
  assert.ok(asset.fields.every((f) => f.spec_type === 'house_default'
    || f.spec_source === 'https://support.google.com/google-ads/answer/17090561'));

  // ALLOWED_ASSETS is the single source of truth Gemini output is filtered against
  // (config.js). A rename that missed it would make every brief naming this asset
  // silently unmatched.
  assert.ok(config.ALLOWED_ASSETS.includes(RENAME.to), 'ALLOWED_ASSETS carries the new name');
  assert.ok(!config.ALLOWED_ASSETS.includes(RENAME.from), 'and not the old one');
  // Every seeded asset name must be allowed, or generateDoc drops it.
  for (const a of DEFAULT_ASSETS) {
    assert.ok(config.ALLOWED_ASSETS.includes(a.name), `${a.name} is in ALLOWED_ASSETS`);
  }
  // The parse prompt's taxonomy hint routes to the new name too, and still accepts
  // "dv360" as a phrase a user would type.
  const gem = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'gemini.js'), 'utf8');
  assert.ok(gem.includes(`→ ${RENAME.to}`), 'the prompt maps to the new name');
  assert.ok(!gem.includes(RENAME.from), 'the old name is gone from the prompt');
  assert.ok(/"dv360"/.test(gem), 'but "dv360" is still a recognised phrase');

  // The instance-heading parser reasons about digits in asset names. Before the
  // rename, "DV360" was the one name containing a digit; now none does. The comment
  // in googleDocs.js asserts that, so verify it against the real library rather
  // than trusting the comment.
  const withDigits = DEFAULT_ASSETS.map((a) => a.name).filter((n) => /\d/.test(n));
  assert.deepStrictEqual(withDigits, [], 'no bundled asset name contains a digit');
  for (const a of DEFAULT_ASSETS) {
    assert.ok(!/ \d+$/.test(a.name), `${a.name} does not end in an ordinal`);
    assert.ok(!/ \d+ — /.test(a.name), `${a.name} does not contain " N — "`);
  }
});

test('spec integrity: the migration is idempotent-by-construction and dry-run by default', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrateSpecIntegrityFixes.js'), 'utf8');
  const fix = require('../scripts/migrateSpecIntegrityFixes');

  // Dry run unless --commit, and it really rolls back rather than just printing.
  assert.ok(/const COMMIT = process\.argv\.includes\('--commit'\);/.test(src), 'reads --commit');
  assert.ok(/await client\.query\('BEGIN'\)/.test(src), 'opens a transaction');
  assert.ok(/await client\.query\('ROLLBACK'\);\s*\n\s*console\.log\(`\$\{TAG\} ROLLED BACK \(dry run\)/.test(src),
    'rolls back when not committing');
  assert.ok(/if \(COMMIT\) \{\s*\n\s*await client\.query\('COMMIT'\)/.test(src), 'commits only with the flag');
  assert.ok(/DATABASE_URL/.test(src) && /process\.exit\(1\)/.test(src), 'requires DATABASE_URL');

  // Every UPDATE is conditioned so a re-run writes nothing — that is what makes it
  // idempotent, rather than a claim in a comment.
  const updates = src.match(/UPDATE copy_fields cf[\s\S]*?`/g) || [];
  assert.strictEqual(updates.length, 5, 'five copy_fields updates: retier, promote, bands, sources, notes');
  for (const u of updates) {
    assert.ok(/IS DISTINCT FROM|spec_type = 'house_default'|spec_note IS NULL/.test(u),
      `each update is guarded against re-writing the same value:\n${u.slice(0, 120)}`);
  }
  // It matches by NAME across all tenants, never by id — the specReview.js pattern.
  assert.ok(/at\.name = \$1 AND cf\.field_name = \$2/.test(src), 'matched by (asset name, field name)');
  assert.ok(!/tenant_id = \$/.test(src), 'not scoped to one tenant');
  // Requiring it must not connect to a database (the tests above do exactly that).
  assert.ok(/if \(require\.main === module\) \{\s*\n\s*main\(\);/.test(src), 'main() is gated on require.main');

  // The rename runs BEFORE the lookups that use the new name, and refuses to
  // collide with an existing row of the target name.
  assert.ok(src.indexOf("UPDATE asset_types SET name") < src.indexOf('UPDATE copy_fields cf'),
    'rename precedes the copy_fields updates');
  assert.ok(/already have an asset named/.test(src), 'guards against a rename collision');

  // The tables the seed is compared against are exported, and non-empty.
  assert.strictEqual(fix.RETIER.length, 10);
  assert.strictEqual(fix.PROMOTE.length, 1);
  assert.strictEqual(fix.CHAR_FIXES.length, 6 + 5 * 3, '6 Meta carousel + 15 email fields');
  assert.strictEqual(Object.keys(fix.SOURCE_URLS).length, 7);
});

test('spec integrity: the seed and the migration agree on every band, both directions', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { CHAR_FIXES, SOURCE_URLS } = require('../scripts/migrateSpecIntegrityFixes');
  const { CITED_BANDS: CITED_BANDS_259 } = require('../scripts/migrateEmailClassesAndCitedBands');
  const f = (asset, name) =>
    DEFAULT_ASSETS.find((x) => x.name === asset).fields.find((x) => x.field_name === name);

  // FORWARD: every band the migration writes is the band the seed carries. If these
  // drift, a migrated tenant and a freshly seeded one render different limits for
  // the same field.
  // Skip any field a LATER migration moved again — the seed must match the END of
  // the chain, not an intermediate step. (Subject lines and preheaders are now
  // derived from EMAIL_CLASSES, which writes the same numbers this pass set.)
  const supersededBy259 = new Set(CITED_BANDS_259.map(([as, fi]) => `${as}||${fi}`));
  for (const [asset, field, min, max] of CHAR_FIXES) {
    if (supersededBy259.has(`${asset}||${field}`)) continue;
    const fl = f(asset, field);
    assert.ok(fl, `${asset}/${field} exists in the seed`);
    assert.strictEqual(fl.char_min, min, `${asset}/${field} char_min`);
    assert.strictEqual(fl.char_max, max, `${asset}/${field} char_max`);
  }
  // ...and every source URL.
  for (const [asset, url] of Object.entries(SOURCE_URLS)) {
    const a = DEFAULT_ASSETS.find((x) => x.name === asset);
    assert.ok(a, `${asset} exists in the seed`);
    const own = new Set(CITED_BANDS_259.map(([as, fi]) => `${as}||${fi}`));
    const tiered = a.fields.filter((x) => x.spec_type !== 'house_default' && !own.has(`${asset}||${x.field_name}`));
    assert.ok(tiered.length > 0, `${asset} has at least one tiered field`);
    for (const fl of tiered) assert.strictEqual(fl.spec_source, url, `${asset}/${fl.field_name} cites ${url}`);
  }

  // BACKWARD: every asset the SEED cites a real URL for is one the migration knows
  // about. A one-directional check would let the seed gain a citation the migration
  // never applies, leaving existing tenants behind — the exact drift CLAUDE.md's
  // byte-identical rule exists to prevent.
  const seedCiting = new Set();
  for (const a of DEFAULT_ASSETS) {
    for (const fl of a.fields) if (fl.spec_source !== 'quillio_default') seedCiting.add(a.name);
  }
  // Plus the assets whose citation is per-FIELD rather than per-asset (a research
  // source measured one field, not a platform's whole surface).
  const { CITED_BANDS } = require('../scripts/migrateEmailClassesAndCitedBands');
  const expectCiting = new Set([
    ...Object.keys(SOURCE_URLS),
    ...CITED_BANDS.map(([asset]) => asset),
    require('../scripts/migrateCiteColdEmailBand').ASSET,
  ]);
  assert.deepStrictEqual([...seedCiting].sort(), [...expectCiting].sort(),
    'the seed cites exactly the assets some migration repoints');
});

test('spec integrity: the LinkedIn carousel note renders BESIDE the tier line, not instead of it', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { fieldHint, fieldLabel } = require('../src/destinations/googleDocs');
  const { CARD_HEADLINE_NOTE, FIELD_NOTES, SOURCE_URLS } = require('../scripts/migrateSpecIntegrityFixes');

  const CAROUSEL_URL = 'https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs';
  assert.strictEqual(SOURCE_URLS['LinkedIn Carousel Ad'], CAROUSEL_URL, 'the corrected carousel URL');

  const carousel = DEFAULT_ASSETS.find((a) => a.name === 'LinkedIn Carousel Ad');
  const cards = carousel.fields.filter((f) => /^Card \d Headline$/.test(f.field_name));
  assert.strictEqual(cards.length, 5, 'five card headlines');

  for (const f of cards) {
    // Seed note is byte-identical to the migration's.
    assert.strictEqual(f.spec_note, CARD_HEADLINE_NOTE, `${f.field_name} seeds the migration note byte-for-byte`);
    // The tier and the number are untouched by adding a note.
    assert.strictEqual(f.spec_type, 'enforced');
    assert.strictEqual(f.char_max, 45);
    assert.strictEqual(f.spec_source, CAROUSEL_URL);

    // THE POINT: the note does not REPLACE the tier sentence. fieldHint composes
    // both into ONE paragraph — note first, tier second — because b.fieldNote()
    // emits one paragraph and parseDoc reads a SECOND paragraph after a label as
    // drafted copy. Two paragraphs here would make the tier line get deleted on the
    // first "Generate Draft".
    const hint = fieldHint({ specType: f.spec_type, specSource: f.spec_source, specNote: f.spec_note });
    assert.strictEqual(
      hint.text,
      'Applies to carousels driving to a destination URL; with a Lead Gen Form CTA the cap is 30. ' +
        'Platform limit (LinkedIn). Stay within this count.'
    );
    assert.ok(hint.text.includes(CARD_HEADLINE_NOTE), 'the note survives');
    assert.ok(hint.text.includes('Platform limit (LinkedIn). Stay within this count.'), 'the tier line survives');
    assert.ok(!hint.text.includes('\n'), 'ONE paragraph — a second one would be read as drafted copy');

    // The hyperlink still lands on the platform name, whose offset moved by the
    // note's length. It is computed structurally (specTypeLine reports nameStart,
    // fieldHint adds the note prefix), never re-searched in the flat text — so the
    // word "LinkedIn" appearing in a note could not steal the link.
    assert.strictEqual(hint.links.length, 1, 'exactly one link');
    assert.strictEqual(hint.text.substring(hint.links[0].start, hint.links[0].end), 'LinkedIn');
    assert.strictEqual(hint.links[0].url, CAROUSEL_URL);
    assert.strictEqual(hint.links[0].start, CARD_HEADLINE_NOTE.length + 1 + 'Platform limit ('.length,
      'offset = note + joining space + the tier prefix');
  }

  // The label still shows the unconditional number; the note carries the other one.
  const c1 = cards[0];
  assert.strictEqual(fieldLabel({ fieldName: c1.field_name, charMin: c1.char_min, charMax: c1.char_max }),
    'Card 1 Headline [45]');

  // Per-asset-pair, never a bare field_name sweep: Meta Carousel has identically
  // named fields where this caveat is false, and they must stay noteless.
  const meta = DEFAULT_ASSETS.find((a) => a.name === 'Meta Carousel Ad');
  for (const f of meta.fields.filter((x) => /^Card \d Headline$/.test(x.field_name))) {
    assert.strictEqual(f.spec_note, null, `Meta ${f.field_name} must not pick up LinkedIn's caveat`);
  }
  // LinkedIn Carousel's OTHER fields are untouched too — this is the card headlines
  // only, not the whole asset.
  assert.strictEqual(carousel.fields.find((f) => f.field_name === 'Intro Text').spec_note, null);

  // FORWARD + BACKWARD on the note table itself: every pair the migration writes is
  // in the seed with that note, and the seed carries the note on exactly those pairs.
  const seedNoted = [];
  for (const a of DEFAULT_ASSETS) {
    for (const f of a.fields) if (f.spec_note === CARD_HEADLINE_NOTE) seedNoted.push(`${a.name}||${f.field_name}`);
  }
  assert.deepStrictEqual(
    seedNoted.sort(),
    FIELD_NOTES.map(([a, f]) => `${a}||${f}`).sort(),
    'seed and migration agree on exactly which fields carry the note'
  );
});

// --- Email body copy in WORDS ------------------------------------------------
// Characters are the right unit where truncation is literal — a subject line, an ad
// headline, a preheader are all cut at a real character position. Body copy has no
// truncation point, only an attention budget, and that budget is measured in words.
// copy_fields.field_type carries the unit; these prove it survives every hop.

test('word units: the seed and the migration agree, both directions', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { WORD_FIELDS, DIRECTIONS } = require('../scripts/migrateEmailBodyWordCounts');

  const f = (asset, name) => {
    const a = DEFAULT_ASSETS.find((x) => x.name === asset);
    assert.ok(a, `asset ${asset} exists`);
    const fl = a.fields.find((x) => x.field_name === name);
    assert.ok(fl, `field ${asset}/${name} exists`);
    return fl;
  };

  // FORWARD: every field the migration converts is a word field in the seed, with
  // the same range — EXCEPT where a later migration moved the band again. The seed
  // must match the END of the chain, so a superseded row is checked against the
  // migration that superseded it, not against this one.
  const { CITED_BANDS } = require('../scripts/migrateEmailClassesAndCitedBands');
  const superseded = new Map(CITED_BANDS.map(([a2, f2, mn, mx]) => [`${a2}||${f2}`, [mn, mx]]));
  for (const [asset, field, min, max] of WORD_FIELDS) {
    const fl = f(asset, field);
    assert.strictEqual(fl.field_type, 'words', `${asset}/${field} is a word field`);
    const [expMin, expMax] = superseded.get(`${asset}||${field}`) || [min, max];
    assert.strictEqual(fl.char_min, expMin, `${asset}/${field} min`);
    assert.strictEqual(fl.char_max, expMax, `${asset}/${field} max`);
  }
  // The one superseded band, pinned by value so the indirection above cannot hide a
  // change: the cited Constant Contact ceiling replaced the uncited 125.
  assert.deepStrictEqual(superseded.get('Demand Gen Nurture Email||Offer Body 1'), [50, 140]);
  // BACKWARD: the seed has no word field the migration does not convert. Without
  // this, a field could go to words in the seed and stay in characters for every
  // existing tenant — rendering two different specs for the same field.
  const seedWords = [];
  for (const a of DEFAULT_ASSETS) {
    for (const fl of a.fields) if (fl.field_type === 'words') seedWords.push(`${a.name}||${fl.field_name}`);
  }
  assert.deepStrictEqual(seedWords.sort(), WORD_FIELDS.map(([a, x]) => `${a}||${x}`).sort());
  assert.strictEqual(seedWords.length, 6, 'six email body fields, and only those');

  // The bands really do differ by email type — one band for all five was the bug
  // the subject-line pass fixed, and repeating it here would be the same mistake.
  assert.deepStrictEqual([f('Demand Gen Nurture Email', 'Offer Body 1').char_min,
    f('Demand Gen Nurture Email', 'Offer Body 1').char_max], [50, 140], 'marketing/nurture, cited');
  assert.deepStrictEqual([f('Sales Basho Email', 'Body Copy').char_min,
    f('Sales Basho Email', 'Body Copy').char_max], [50, 100], 'cold outreach');
  assert.deepStrictEqual([f('Event Follow-Up / Recap Email', 'Body Copy').char_min,
    f('Event Follow-Up / Recap Email', 'Body Copy').char_max], [25, 75], 'follow-up');
  // The lighter SECOND offer gets its own smaller band, not the nurture one.
  assert.deepStrictEqual([f('Demand Gen Nurture Email', 'Offer Body 2').char_min,
    f('Demand Gen Nurture Email', 'Offer Body 2').char_max], [25, 60], 'secondary offer');

  // A band has to clear the bar for the EMAIL, not just for its own field. Demand
  // Gen carries two offer bodies, so their ceilings ADD: at 125 + 125 the doc would
  // have sanctioned a 250-word nurture email while every individual number looked
  // defensible, and the research these bands come from puts response below 40% past
  // 200 words. Asserted per asset rather than for this one pair, so a body field
  // added to any email later cannot quietly push it over.
  // WHOLE-EMAIL WORD BUDGET. This is the constraint the citation actually states.
  //
  // Constant Contact measured whole EMAILS — ~20 lines, about 200 words, as the
  // highest-click-through length for a newsletter. Demand Gen has TWO body fields
  // and they STACK (craft.md § Email: "Secondary offers come after and read as
  // lighter"), so the cited 200 is the budget for the PAIR, not for either one.
  // 140 + 60 = 200.
  //
  // The number nearly went in as 200 on Offer Body 1 alone, which would have put
  // the email at 260 — over the figure its own citation reports. That is the same
  // error this library has been correcting throughout: a number measured for one
  // unit applied to another. Asserting the SUM rather than each field is what makes
  // the unit explicit, so a future band change fails here instead of shipping.
  const WORD_CLIFF = 200;
  const bodyTotals = new Map();
  for (const a2 of DEFAULT_ASSETS) {
    const bodies = a2.fields.filter((x) => x.field_type === 'words');
    if (bodies.length < 2) continue;
    bodyTotals.set(a2.name, bodies.reduce((n, x) => n + x.char_max, 0));
  }
  for (const [name, total] of bodyTotals) {
    assert.ok(total <= WORD_CLIFF,
      `${name}: its word bodies total ${total}, over the ${WORD_CLIFF}-word whole-email figure`);
  }
  // Pinned exactly, so a change that stays under the cliff by shrinking a band is
  // still noticed — and so the arithmetic behind 140 is recorded, not inferred.
  assert.deepStrictEqual([...bodyTotals], [['Demand Gen Nurture Email', 200]],
    'Demand Gen is the only multi-body email, and 140 + 60 lands exactly on the cited figure');

  // ONLY email body converts. Subject lines, preheaders, headlines, CTAs and every
  // ad field keep characters, because their limits ARE truncation points.
  for (const [asset, field] of [
    ['Demand Gen Nurture Email', 'Subject Line 1'], ['Demand Gen Nurture Email', 'Preheader'],
    ['Demand Gen Nurture Email', 'CTA Text (Offer 1)'], ['Sales Basho Email', 'Opening Line'],
    ['Meta Single Image Ad', 'Primary Text'], ['LinkedIn Single Image Ad', 'Intro Text'],
    ['Organic Social — Twitter/X', 'Post Copy'],
  ]) {
    assert.strictEqual(f(asset, field).field_type, 'text', `${asset}/${field} stays in characters`);
  }
  // Non-email long-form stays in characters for now (flagged in the migration as
  // the open question this pass deliberately does not answer).
  for (const [asset, field] of [
    ['Event Landing Page', 'About Section Body'],
    ['One-Pager', 'Solution Description'],
    ['Direct Mail — Insert', 'Body Copy'],
  ]) {
    assert.strictEqual(f(asset, field).field_type, 'text', `${asset}/${field} stays in characters for now`);
  }

  // Trimmed directions agree with the migration byte-for-byte.
  for (const [asset, direction] of DIRECTIONS) {
    assert.strictEqual(DEFAULT_ASSETS.find((a) => a.name === asset).asset_direction, direction,
      `${asset} direction`);
  }
});

test('word units: the label carries the unit, and both readers get it back', () => {
  const { fieldLabel, parseDoc, getDocContent } = require('../src/destinations/googleDocs');

  // A word field and a character field, side by side.
  assert.strictEqual(fieldLabel({ fieldName: 'Offer Body 1', charMin: 50, charMax: 125, fieldType: 'words' }),
    'Offer Body 1 [50-125 words]');
  assert.strictEqual(fieldLabel({ fieldName: 'Subject Line 1', charMin: 0, charMax: 130, fieldType: 'text' }),
    'Subject Line 1 [130]');
  assert.strictEqual(fieldLabel({ fieldName: 'Body Copy', charMin: 0, charMax: 100, fieldType: 'words' }),
    'Body Copy [100 words]', 'a word field with no floor still says words');
  // Absent fieldType is characters — every field before this change.
  assert.strictEqual(fieldLabel({ fieldName: 'Headline', charMin: 0, charMax: 70 }), 'Headline [70]');
  assert.strictEqual(fieldLabel({ fieldName: 'Bare', charMin: 0, charMax: 0, fieldType: 'words' }), 'Bare',
    'no range → no bracket → nothing to carry the unit');

  // THE ROUND TRIP. There is no persisted doc state: the draft, regenerate and
  // review paths all reconstruct fields by re-parsing the Doc. If the label did not
  // say "words", the unit would die the moment the doc was written.
  const paras = [
    { text: 'Campaign Summary', style: 'HEADING_2' }, { text: 's', italic: true },
    { text: 'Writer Direction', style: 'HEADING_2' }, { text: 'd', italic: true },
    { text: 'Demand Gen Nurture Email', style: 'HEADING_3' },
    { text: 'Subject Line 1 [130]', bold: true }, { text: 'a subject' },
    { text: 'Offer Body 1 [50-125 words]', bold: true }, { text: 'some body copy' },
  ];
  const doc = instDoc(paras);
  const { assets } = parseDoc(doc);
  const fields = assets[0].fields;
  assert.deepStrictEqual(
    fields.map((f) => [f.fieldName, f.charMin, f.charMax, f.fieldType]),
    [['Subject Line 1', 0, 130, 'text'], ['Offer Body 1', 50, 125, 'words']]
  );
  // The unit survives the NAME too — "words" must not be swallowed into the field
  // name or left in it.
  assert.strictEqual(fields[1].fieldName, 'Offer Body 1');

  // getDocContent (the web app's reader) recovers it identically — two readers, one
  // format, or the app and the doc would disagree about what the number means.
  return getDocContent('d', { docs: { documents: { get: async () => ({ data: doc }) } } }).then((content) => {
    assert.deepStrictEqual(
      content.assets[0].fields.map((f) => [f.fieldName, f.charMin, f.charMax, f.fieldType]),
      [['Subject Line 1', 0, 130, 'text'], ['Offer Body 1', 50, 125, 'words']]
    );
  });
});

test('word units: the Gemini prompt states the constraint in words, not characters', () => {
  const gem = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'gemini.js'), 'utf8');

  // ONE helper, so the drafter, the variations generator and the two reviewers
  // cannot drift on how a length is phrased.
  assert.ok(/function lengthClause\(charMax, fieldType, charMin\)/.test(gem), 'the shared clause exists');
  const clause = new Function(`${gem.match(/^function lengthClause[\s\S]*?\n\}/m)[0]}\nreturn lengthClause;`)();

  // A word field says WORDS, says it is not characters, and carries the floor.
  const w = clause(125, 'words', 50);
  assert.match(w, /50-125 words/);
  assert.match(w, /WORD count, not characters/);
  assert.match(w, /Structure matters more than hitting a number/);
  assert.match(w, /context in one or two sentences, the ask in one, the next step in one/);
  assert.ok(!/Character limit/.test(w), 'a word field never says "Character limit"');
  // No floor → "up to N words", never a bare number that reads as characters.
  assert.match(clause(100, 'words', 0), /up to 100 words/);

  // A character field is UNCHANGED — this is every field but six, and the wording
  // it produces must still be the wording it produced before.
  assert.strictEqual(
    clause(70, 'text', 0),
    'Character limit: 70. Stay within this limit — write a COMPLETE, self-contained thought and finish it, ' +
      'even a few characters short; never run up to the limit and get cut off mid-sentence.'
  );
  assert.strictEqual(clause(70), clause(70, 'text', 0), 'absent fieldType === characters');
  assert.strictEqual(clause(0, 'words', 50), null, 'no ceiling → no clause, caller falls back');

  // All four prompt sites branch on the unit — none still hard-codes characters.
  assert.strictEqual((gem.match(/fieldType === 'words'/g) || []).length, 4,
    'per-field draft line, variations, variant review, and the review payload');
  assert.ok(/lengthUnit: f\.fieldType === 'words' \? 'words' : 'characters'/.test(gem),
    'the copy-review payload names the unit rather than implying characters');
});

test('word units: the client counts words, and the layout heuristic is not fooled', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  const grab = (n) => html.match(new RegExp(`^(\\s*)function ${n}\\([^)]*\\) \\{[\\s\\S]*?\\n\\1\\}`, 'm'))[0];
  const c = new Function(`${grab('isWordField')}${grab('countUnits')}${grab('charLimit')}
    return { isWordField, countUnits, charLimit };`)();

  // The bracket, in the app, matches the bracket in the doc.
  assert.strictEqual(c.charLimit({ charMin: 50, charMax: 125, fieldType: 'words' }), '[50–125 words]');
  assert.strictEqual(c.charLimit({ charMin: 0, charMax: 130, fieldType: 'text' }), '[130]');
  assert.strictEqual(c.charLimit({ charMax: 0 }), '');

  // Counting in the field's own unit. A 90-word body is ~550 characters; showing
  // "550 / 125" reads as four times over when it is comfortably inside the band.
  const body = new Array(90).fill('word').join(' ');
  assert.strictEqual(c.countUnits(body, { fieldType: 'words' }), 90);
  assert.strictEqual(c.countUnits(body, { fieldType: 'text' }), body.length);
  assert.strictEqual(c.countUnits('  spaced   out  ', { fieldType: 'words' }), 2, 'whitespace runs, not splits');
  assert.strictEqual(c.countUnits('', { fieldType: 'words' }), 0);
  assert.strictEqual(c.countUnits(null, { fieldType: 'words' }), 0);

  // A word field is flagged UNDER the floor as well as over the ceiling — 50-125
  // says "structured email", not "up to 125".
  assert.ok(/isWordField\(f\) && f\.charMin && n > 0 && n < f\.charMin/.test(html), 'under-range is flagged too');

  // The doc's short/long layout heuristic is a CHARACTER threshold (<=120). A
  // 125-WORD field would sail under it and be laid out as a headline.
  const docs = fs.readFileSync(path.join(__dirname, '..', 'src', 'destinations', 'googleDocs.js'), 'utf8');
  assert.ok(/const longField = fieldType === 'words' \|\| !\(Number\(charMax\) > 0 && Number\(charMax\) <= 120\);/.test(docs),
    'a word field is always laid out long');
});

// --- Email classes -----------------------------------------------------------
// The five email assets used to carry their own copies of the same subject and
// preheader bands, which is why one wrong preheader ceiling took five edits in the
// seed plus five rows in a migration. EMAIL_CLASSES is now the only place those
// numbers appear.

test('email classes: the constant is the SINGLE source of the inbox-facing bands', () => {
  const seedSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'defaultAssets.js'), 'utf8');
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { EMAIL_CLASSES: MIG } = require('../scripts/migrateEmailClassesAndCitedBands');

  const EMAILS = ['Demand Gen Nurture Email', 'Event Invitation Email', 'Event Reminder Email',
    'Event Follow-Up / Recap Email', 'Sales Basho Email'];
  const band = (asset, field) => {
    const f = DEFAULT_ASSETS.find((a) => a.name === asset).fields.find((x) => x.field_name === field);
    return [f.char_min, f.char_max];
  };

  // What the seed actually produces.
  for (const asset of MIG.marketing.assets) {
    assert.deepStrictEqual(band(asset, 'Subject Line 1'), MIG.marketing.subject, `${asset} subject`);
    assert.deepStrictEqual(band(asset, 'Subject Line 2'), MIG.marketing.subject, `${asset} subject 2`);
    assert.deepStrictEqual(band(asset, 'Preheader'), MIG.marketing.preheader, `${asset} preheader`);
  }
  for (const asset of MIG.cold.assets) {
    assert.deepStrictEqual(band(asset, 'Subject Line 1'), MIG.cold.subject, `${asset} subject`);
    assert.deepStrictEqual(band(asset, 'Preheader'), MIG.cold.preheader, `${asset} preheader`);
  }
  // Every email asset belongs to exactly one class — no asset silently outside.
  const claimed = [...MIG.marketing.assets, ...MIG.cold.assets];
  assert.deepStrictEqual(claimed.slice().sort(), EMAILS.slice().sort(), 'all five emails are classed');
  assert.strictEqual(new Set(claimed).size, claimed.length, 'no asset is in two classes');

  // SINGLE SOURCE, proven structurally: no email asset's RAW row carries a literal
  // subject or preheader band. They all say FROM_CLASS. This is the assertion that
  // would have caught the five-places problem.
  const rawBlock = seedSrc.slice(seedSrc.indexOf('const RAW = ['), seedSrc.indexOf('const DIRECTIONS'));
  for (const asset of EMAILS) {
    const i = rawBlock.indexOf(`['${asset}', 'Email', [`);
    assert.ok(i >= 0, `${asset} is in RAW`);
    const rows = rawBlock.slice(i, rawBlock.indexOf('  ]],', i));
    for (const field of ['Subject Line 1', 'Subject Line 2', 'Preheader']) {
      const start = rows.indexOf(`['${field}',`);
      assert.ok(start >= 0, `${asset} has a ${field} row`);
      const row = rows.slice(start, rows.indexOf(']', start) + 1);
      assert.strictEqual(row, `['${field}', FROM_CLASS, FROM_CLASS]`,
        `${asset}/${field} must read FROM_CLASS, not a literal (got ${row})`);
    }
  }
  // And the numbers appear ONCE each in the whole seed file.
  for (const literal of ['[0, 130]', '[0, 40]', '[85, 100]']) {
    const n = (seedSrc.match(new RegExp(literal.replace(/[[\]]/g, '\\$&'), 'g')) || []).length;
    assert.strictEqual(n, 1, `${literal} appears once in the seed (in EMAIL_CLASSES), found ${n}`);
  }
});

test('email classes: changing ONE value in the constant moves all four marketing assets', () => {
  // Load the seed twice from source, once with the marketing subject ceiling
  // rewritten, and diff. This is the actual claim — "single source of truth" means
  // one edit propagates — and only executing it proves it.
  const p = path.join(__dirname, '..', 'src', 'data', 'defaultAssets.js');
  const src = fs.readFileSync(p, 'utf8');
  const load = (text) => {
    const m = new (require('module')).Module();
    m._compile(text, p);
    return m.exports.DEFAULT_ASSETS;
  };
  const subjectOf = (assets, name) =>
    assets.find((a) => a.name === name).fields.find((f) => f.field_name === 'Subject Line 1').char_max;

  const before = load(src);
  // ONE edit, inside EMAIL_CLASSES only.
  const patched = src.replace('    subject: [0, 130],', '    subject: [0, 999],');
  assert.notStrictEqual(patched, src, 'the marketing subject band was found and rewritten');
  assert.strictEqual((src.match(/subject: \[0, 130\],/g) || []).length, 1, 'and it appears exactly once');
  const after = load(patched);

  const MARKETING = ['Demand Gen Nurture Email', 'Event Invitation Email', 'Event Reminder Email',
    'Event Follow-Up / Recap Email'];
  for (const a of MARKETING) {
    assert.strictEqual(subjectOf(before, a), 130, `${a} before`);
    assert.strictEqual(subjectOf(after, a), 999, `${a} after ONE edit`);
  }
  // Cold is a different class and must NOT move.
  assert.strictEqual(subjectOf(before, 'Sales Basho Email'), 40);
  assert.strictEqual(subjectOf(after, 'Sales Basho Email'), 40, 'cold outreach is unaffected');
  // Neither is anything outside email.
  assert.strictEqual(subjectOf(before, 'Demand Gen Nurture Email'), 130);
  const headline = (assets) =>
    assets.find((a) => a.name === 'Meta Single Image Ad').fields.find((f) => f.field_name === 'Headline').char_max;
  assert.strictEqual(headline(after), headline(before), 'no ad field moved');
});

test('email classes: BODY length is deliberately NOT derived from the class', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const seedSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'defaultAssets.js'), 'utf8');
  const body = (asset, field) => {
    const f = DEFAULT_ASSETS.find((a) => a.name === asset).fields.find((x) => x.field_name === field);
    return [f.char_min, f.char_max];
  };

  // The four MARKETING assets share a class and therefore share an inbox, but their
  // bodies differ — and that inconsistency is the correct answer, not an oversight.
  // A reminder to someone who already registered has a different job than a nurture
  // email trying to earn a click.
  assert.deepStrictEqual(body('Demand Gen Nurture Email', 'Offer Body 1'), [50, 140]);
  assert.deepStrictEqual(body('Event Invitation Email', 'Event Description'), [50, 125]);
  assert.deepStrictEqual(body('Event Reminder Email', 'Body Copy'), [25, 75]);
  assert.deepStrictEqual(body('Event Follow-Up / Recap Email', 'Body Copy'), [25, 75]);
  const marketingBodies = [[50, 140], [50, 125], [25, 75], [25, 75]];
  assert.ok(new Set(marketingBodies.map(String)).size > 1,
    'one class, several body bands — unifying them would make three of four wrong');

  // The class object itself must not carry a body key, or a future session will
  // wire it. The reason is stated in the constant; this makes it structural.
  const cls = seedSrc.slice(seedSrc.indexOf('const EMAIL_CLASSES = {'), seedSrc.indexOf('const CLASS_GOVERNED_FIELDS'));
  assert.ok(!/\bbody\b\s*:/.test(cls), 'EMAIL_CLASSES has no body key');
  assert.ok(/WHAT A CLASS DOES NOT GOVERN — BODY LENGTH/.test(seedSrc), 'and says why, in the constant');
  // Only the three inbox-facing fields are class-governed.
  const governed = seedSrc.slice(seedSrc.indexOf('const CLASS_GOVERNED_FIELDS'), seedSrc.indexOf('// assetName → its class entry'));
  assert.deepStrictEqual(
    (governed.match(/: '(subject|preheader)'/g) || []).sort(),
    [": 'preheader'", ": 'subject'", ": 'subject'"],
    'exactly three governed fields: two subject lines and the preheader'
  );

  // NOT a column on asset_types — custom assets do not exist, so a column would be
  // written at seed and read by nothing.
  const assetsDb = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'assets.js'), 'utf8');
  assert.ok(!/email_class|\bclass\b\s*,/.test(assetsDb), 'no class column is read or written');
  assert.ok(!DEFAULT_ASSETS.some((a) => 'email_class' in a || 'class' in a), 'and none is seeded');
});

test('email classes: a class-governed field on an unclassed asset FAILS LOUDLY', () => {
  // classBand throws rather than returning nulls. [0, 0] renders as a field with NO
  // bracket at all — a silently unlimited subject line, which is worse than a build
  // that stops.
  const p = path.join(__dirname, '..', 'src', 'data', 'defaultAssets.js');
  const src = fs.readFileSync(p, 'utf8');
  const load = (text) => {
    const m = new (require('module')).Module();
    m._compile(text, p);
    return m.exports;
  };
  // Drop one asset out of its class and rebuild.
  const orphaned = src.replace("      'Event Reminder Email',\n", '');
  assert.notStrictEqual(orphaned, src);
  assert.throws(() => load(orphaned), /is class-governed but "Event Reminder Email" is in no EMAIL_CLASSES member list/);

  // Two classes claiming one asset is also a build error.
  const doubled = src.replace("    assets: ['Sales Basho Email'],", "    assets: ['Sales Basho Email', 'Event Reminder Email'],");
  assert.throws(() => load(doubled), /is in two email classes/);
});

test('cited bands: the research tier line says what was measured, and what stayed uncited', () => {
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
  const { fieldHint } = require('../src/destinations/googleDocs');
  const { CITED_BANDS } = require('../scripts/migrateEmailClassesAndCitedBands');
  const f = (asset, name) =>
    DEFAULT_ASSETS.find((a) => a.name === asset).fields.find((x) => x.field_name === name);

  // Seed and migration agree on the citation, both directions.
  assert.strictEqual(CITED_BANDS.length, 1, 'exactly one cited body band');
  const [asset, field, min, max, tier, url, note] = CITED_BANDS[0];
  const fl = f(asset, field);
  assert.deepStrictEqual(
    [fl.char_min, fl.char_max, fl.spec_type, fl.spec_source, fl.spec_note],
    [min, max, tier, url, note],
    'seed and migration agree on band, tier, source AND note'
  );
  assert.strictEqual(url, 'https://www.constantcontact.com/blog/best-length-email-newsletter/');
  assert.deepStrictEqual([min, max], [50, 140], 'the FIELD band, not the cited whole-email figure');

  // THE HINT, as one paragraph: the note first, then the tier line.
  //
  // The note exists because the two numbers DIFFER — the label says [50-140 words]
  // and the citation says ~200 — and without it a writer has no way to reconcile
  // them. The cited figure is for a whole email; this is one of its two body blocks.
  const hint = fieldHint({ specType: fl.spec_type, specSource: fl.spec_source, specNote: fl.spec_note });
  assert.strictEqual(
    hint.text,
    'The cited ~200 words is a WHOLE-EMAIL figure; this is one of two body blocks, so 140 here leaves 60 for Offer Body 2. ' +
      'Recommended by Constant Contact (2.1M customers, small-business campaigns). Longer bodies click less.'
  );
  assert.match(hint.text, /WHOLE-EMAIL figure/, 'the unit of the cited number is stated');
  assert.match(hint.text, /140 here leaves 60 for Offer Body 2/, 'and the arithmetic is shown');
  assert.ok(!hint.text.includes('\n'), 'ONE paragraph — a second would be read as drafted copy');

  // The TIER LINE still names the population and states the finding, because
  // "Recommended by Constant Contact" with no scope would be an appeal to
  // authority, and small-business campaign data is not B2B nurture data.
  assert.match(hint.text, /Recommended by Constant Contact \(2\.1M customers, small-business campaigns\)\./);
  assert.match(hint.text, /2\.1M customers/, 'CUSTOMERS, not emails — the distinction is load-bearing');
  assert.ok(!/2\.1M emails/.test(hint.text));

  // The link still lands on the source name, at an offset the note shifted by.
  assert.strictEqual(hint.links.length, 1);
  assert.strictEqual(hint.text.substring(hint.links[0].start, hint.links[0].end), 'Constant Contact');
  assert.strictEqual(hint.links[0].url, url);
  assert.strictEqual(hint.links[0].start, note.length + 1 + 'Recommended by '.length,
    'offset = note + joining space + the tier prefix');

  // And the label a writer reads carries the FIELD's number, in words.
  const { fieldLabel } = require('../src/destinations/googleDocs');
  assert.strictEqual(
    fieldLabel({ fieldName: fl.field_name, charMin: fl.char_min, charMax: fl.char_max, fieldType: fl.field_type }),
    'Offer Body 1 [50-140 words]'
  );

  // A PLATFORM recommendation is untouched by adding the research branch.
  const meta = f('Meta Single Image Ad', 'Primary Text');
  assert.strictEqual(
    fieldHint({ specType: meta.spec_type, specSource: meta.spec_source }).text,
    'Recommended by Meta. Not a hard limit — adjust for your brand and goal.'
  );

  // WHAT STAYED UNCITED — nobody measured these, so they claim nothing. An uncited
  // house default renders NO tier line at all, which is the honest output.
  for (const [a, n] of [
    ['Demand Gen Nurture Email', 'Offer Body 2'],   // no source measured a secondary offer
    ['Event Invitation Email', 'Event Description'],
    ['Event Reminder Email', 'Body Copy'],
    ['Event Follow-Up / Recap Email', 'Body Copy'],
  ]) {
    const u = f(a, n);
    assert.strictEqual(u.spec_type, 'house_default', `${a}/${n} stays house_default`);
    assert.strictEqual(u.spec_source, 'quillio_default', `${a}/${n} stays uncited`);
    const h = fieldHint({ specType: u.spec_type, specSource: u.spec_source, specNote: u.spec_note });
    if (h) assert.ok(!/Recommended by|Platform limit/.test(h.text), `${a}/${n} claims no authority`);
  }
  // Sales Basho is now CITED, and its number is unchanged by the citation — the
  // band was always 50-100; only the claim about where it comes from is new.
  const cold = require('../scripts/migrateCiteColdEmailBand');
  const basho = f(cold.ASSET, cold.FIELD);
  assert.deepStrictEqual([basho.char_min, basho.char_max], [50, 100], 'the band did not move');
  assert.deepStrictEqual(cold.BAND, [50, 100], 'and the migration restates it unchanged');
  assert.strictEqual(basho.spec_type, 'recommended');
  assert.strictEqual(basho.spec_source, cold.SOURCE_URL);
  assert.strictEqual(basho.spec_note, cold.BASHO_BODY_NOTE, 'seed and migration agree on the note');

  const bh = fieldHint({ specType: basho.spec_type, specSource: basho.spec_source, specNote: basho.spec_note });
  assert.strictEqual(
    bh.text,
    "Applies to the FIRST touch; Gong's guidance for follow-ups in the same sequence runs longer. " +
      'Recommended by Gong (cold outreach reply rates, not marketing clicks). Drops sharply past 100 words.'
  );
  assert.strictEqual(bh.links.length, 1);
  assert.strictEqual(bh.text.substring(bh.links[0].start, bh.links[0].end), 'Gong');
  assert.strictEqual(bh.links[0].url, cold.SOURCE_URL);

  // NO SAMPLE SIZE. The cited page does not state one, and the figures in
  // circulation attach to different Gong studies — quoting any would attribute a
  // number to a page that does not contain it.
  assert.ok(!/\d+\s*M\b|million|\d{2,}(,\d{3})+/.test(bh.text), `no sample size in: ${bh.text}`);

  // THE TWO RESEARCH CITATIONS MEASURE DIFFERENT OUTCOMES, and each says which.
  // A writer who carries one across to the other's asset has applied a real number
  // to the wrong job; naming the outcome is what makes that visible.
  const cc = fieldHint({ specType: fl.spec_type, specSource: fl.spec_source, specNote: fl.spec_note });
  assert.match(bh.text, /reply rates, not marketing clicks/, 'cold: a REPLY rate');
  assert.match(cc.text, /Longer bodies click less/, 'marketing: a CLICK rate');
  assert.ok(!/click/i.test(bh.text.replace('not marketing clicks', '')), 'the cold line claims nothing about clicks');

  // The note scopes it to the FIRST touch — Gong's follow-up guidance runs longer,
  // so the band is not a rule for every email in the sequence.
  assert.match(bh.text, /Applies to the FIRST touch/);
  assert.match(bh.text, /follow-ups in the same sequence runs longer/);
  assert.ok(!bh.text.includes('\n'), 'ONE paragraph');
});

test('watch list: the rule against watching research citations is written down', () => {
  const claude = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.ok(/## What goes on the LiveSpecs watch list/.test(claude), 'the rule has its own section');
  assert.ok(/Research citations do not go on the watch list/.test(claude));
  assert.ok(/Constant Contact.*Gong.*academic papers|Gong.*academic/.test(claude), 'names the sources it excludes');
  assert.ok(/fetch-hash-compare/.test(claude), 'and gives the mechanical reason');

  // craft.md carries the length finding as CRAFT — uncited, in the Email section,
  // not as a spec with a source URL.
  const craft = fs.readFileSync(path.join(__dirname, '..', 'craft.md'), 'utf8');
  const email = craft.slice(craft.indexOf('### Email'), craft.indexOf('### Print / Out-of-Home'));
  assert.ok(/Longer bodies click less/.test(email), 'the finding is in the Email section');
  assert.ok(/1,679 promotional campaigns across 50 countries/.test(email), 'with its evidence named');
  assert.ok(!/http/.test(email.slice(email.indexOf('Longer bodies click less'), email.indexOf('Proof before pitch'))),
    'stated as craft, with no URL — a spec_source is for a field, not a paragraph');
});

// --- Silent failure 1: a PARTIAL asset match ---------------------------------
// parseBrief filters the model's asset names against config.ALLOWED_ASSETS and
// puts the misses in `unmatchedAssets`. Both adapters refused when EVERY name
// missed, and said nothing at all when only SOME did — so a brief naming three
// assets where one missed built a doc quietly short an asset. These tests pin
// the partial path down on both surfaces and keep the total-miss refusal intact.

test('assetMatch: the wording names what is actually checked, not "your library"', () => {
  const { totalMissMessage, partialMissNotice, dedupeAssetNames } = require('../src/utils/assetMatch');

  // The filter runs against config.ALLOWED_ASSETS — a GLOBAL list — so the old
  // sentence ("Couldn't match these to your asset library … Add them to your
  // library") named the wrong thing AND gave advice that does not work: adding a
  // row to the tenant's library does not change what the filter accepts.
  const total = totalMissMessage(['TikTok Ad', 'Billboard']);
  assert.match(total, /any asset type Quillio supports/);
  assert.ok(!/your asset library/i.test(total), 'no longer blames the tenant library');
  assert.ok(!/Add them to your library/i.test(total), 'and drops the advice that would not have worked');
  assert.match(total, /TikTok Ad, Billboard/);
  assert.match(total, /Nothing was built/, 'a total miss says nothing was built');

  // The partial notice is ADVISORY: the doc exists, so it must not read as a failure.
  const partial = partialMissNotice(['TikTok Ad']);
  assert.match(partial, /any asset type Quillio supports: TikTok Ad\./);
  assert.match(partial, /It was left out — everything else was built/);
  assert.ok(!/Nothing was built/.test(partial), 'a partial miss must never claim nothing was built');
  assert.match(partialMissNotice(['A', 'B']), /They were left out/, 'plural agrees');

  // Nothing unmatched → null, which is how every caller decides to render nothing.
  assert.strictEqual(partialMissNotice([]), null);
  assert.strictEqual(partialMissNotice(undefined), null);
  assert.strictEqual(totalMissMessage([]), null);

  // parseBrief merges the model's own unmatchedAssets with the names its filter
  // rejected, so one name can arrive twice — repeating it reads like two failures.
  assert.deepStrictEqual(dedupeAssetNames(['TikTok Ad', 'tiktok ad', ' ', null, 'SMS']), ['TikTok Ad', 'SMS']);
  assert.strictEqual(partialMissNotice(['TikTok Ad', 'TikTok Ad']).match(/TikTok Ad/g).length, 1);
});

test('slack partial miss: the doc IS built, and the card says what was left out', async () => {
  await withSlackBrief(
    {
      parseBrief: async () => ({
        campaignTitle: 'Spring Sale', summary: 'S', writerPrompt: 'W',
        assets: [{ asset: 'Battle Card', count: 1, labels: [] }, { asset: 'Campaign Landing Page', count: 1, labels: [] }],
        unmatchedAssets: ['TikTok Ad'],
        referenceLinks: [],
      }),
    },
    async ({ adapter, sent, builds, last }) => {
      await adapter.runBriefWorkflow('battle card, landing page, tiktok ad', 'https://hooks.slack.test/r', SLACK_OPTS);

      // It BUILT — a partial miss must never block. Two assets, not three.
      assert.strictEqual(builds.length, 1, 'the partial miss did not stop the build');
      assert.deepStrictEqual(builds[0].plan.map((e) => e.asset), ['Battle Card', 'Campaign Landing Page']);

      // And the doc-ready card carries the notice as CONTEXT, not as an error.
      const card = last();
      assert.strictEqual(card.api, 'chat.update');
      assert.match(card.text, /Your doc is ready/, 'still a success card');
      const contexts = card.blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text);
      const unmatched = contexts.find((t) => /TikTok Ad/.test(t));
      assert.ok(unmatched, 'the card names the asset that did not match');
      assert.match(unmatched, /any asset type Quillio supports/);
      assert.match(unmatched, /everything else was built/);
    }
  );
});

test('slack total miss: the refusal is unchanged — nothing is built', async () => {
  await withSlackBrief(
    {
      parseBrief: async () => ({
        campaignTitle: 'C', summary: 'S', writerPrompt: 'W',
        assets: [], unmatchedAssets: ['TikTok Ad', 'Podcast Ad'], referenceLinks: [],
      }),
    },
    async ({ adapter, builds, last }) => {
      await adapter.runBriefWorkflow('tiktok ad and a podcast ad', 'https://hooks.slack.test/r', SLACK_OPTS);

      assert.strictEqual(builds.length, 0, 'a total miss still builds nothing');
      const msg = last();
      assert.match(msg.text, /TikTok Ad, Podcast Ad/);
      assert.match(msg.text, /Nothing was built/);
      assert.strictEqual(msg.blocks, null, 'still a plain message, not a result card');
    }
  );
});

test('slack partial miss + pause: the notice rides the plan card AND survives Build', async () => {
  await withSlackBrief(
    {
      parseBrief: async () => ({
        campaignTitle: 'City Dinners', summary: 'S', writerPrompt: 'W',
        assets: SLACK_PAUSE_PLAN, unmatchedAssets: ['SMS Blast'], referenceLinks: [],
      }),
    },
    async ({ adapter, sent, builds, last }) => {
      await adapter.runBriefWorkflow('3 emails, a landing page, an sms blast', 'https://hooks.slack.test/r', SLACK_OPTS);

      // 1. It PAUSED, and the plan card names what missed — before anything exists,
      //    which is the point at which cancelling and rewording is still free.
      assert.strictEqual(builds.length, 0, 'nothing built yet');
      const planCard = last();
      const planCtx = planCard.blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text);
      assert.ok(planCtx.some((t) => /SMS Blast/.test(t)), 'the plan card names the unmatched asset');
      assert.ok(planCtx.some((t) => /Nothing has been created yet/.test(t)), 'and still says nothing exists yet');

      // 2. Click Build. The brief is NOT re-parsed here, so the notice can only
      //    survive via the pending record — which is exactly what regressed before.
      const pendingId = planCard.blocks
        .find((b) => b.type === 'actions')
        .elements.find((e) => e.action_id === 'plan_build').value;
      await adapter.resumeBriefWorkflow(pendingId, null, {
        workspaceId: 'TEAM1', slackUserId: 'USER1', channel: 'C1', messageTs: 'TS1',
        responseUrl: 'https://hooks.slack.test/r',
      });

      assert.strictEqual(builds.length, 1, 'the build ran from the confirmed plan');
      const doneCtx = last().blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text);
      assert.ok(doneCtx.some((t) => /SMS Blast/.test(t)), 'the doc-ready card still names it after Build');
    }
  );
});

test('slack: a fully-matched brief produces a card with no unmatched notice at all', async () => {
  await withSlackBrief(
    {
      parseBrief: async () => ({
        campaignTitle: 'Spring Sale', summary: 'S', writerPrompt: 'W',
        assets: [{ asset: 'Battle Card', count: 1, labels: [] }],
        unmatchedAssets: [], referenceLinks: [],
      }),
    },
    async ({ adapter, last }) => {
      await adapter.runBriefWorkflow('battle card', 'https://hooks.slack.test/r', SLACK_OPTS);
      const contexts = last().blocks.filter((b) => b.type === 'context');
      assert.strictEqual(contexts.length, 0, 'no advisory blocks when everything matched');
    }
  );
});

test('web adapter: the parse payload carries unmatchedAssets + the rendered notice', async () => {
  const pipeline = require('../src/core/pipeline');
  const saved = { parseBrief: pipeline.parseBrief, fetchAllReferences: pipeline.fetchAllReferences };
  try {
    pipeline.fetchAllReferences = async () => ({ refs: [], counts: { drive: 0, external: 0, pdf: 0, canvas: 0 } });

    // PARTIAL miss: it does NOT throw, and the payload the confirmation screen
    // and the result screen are both built from finally carries the miss. This
    // return value stopping short of unmatchedAssets is what made the web
    // surface structurally unable to show a partial miss.
    pipeline.parseBrief = async () => ({
      campaignTitle: 'C', summary: 'S', writerPrompt: 'W',
      assets: [{ asset: 'Battle Card', count: 1, labels: [] }],
      unmatchedAssets: ['TikTok Ad'], referenceLinks: [],
    });
    const { runWebBriefParse } = require('../src/adapters/web');
    const parsed = await runWebBriefParse('battle card and a tiktok ad');
    assert.deepStrictEqual(parsed.unmatchedAssets, ['TikTok Ad']);
    assert.match(parsed.unmatchedNotice, /TikTok Ad/);
    assert.match(parsed.unmatchedNotice, /everything else was built/);
    assert.strictEqual(parsed.plan.length, 1, 'and the matched asset still builds');

    // Fully matched → no notice, so the screens render nothing.
    pipeline.parseBrief = async () => ({
      campaignTitle: 'C', summary: 'S', writerPrompt: 'W',
      assets: [{ asset: 'Battle Card', count: 1, labels: [] }],
      unmatchedAssets: [], referenceLinks: [],
    });
    assert.strictEqual((await runWebBriefParse('battle card')).unmatchedNotice, null);

    // TOTAL miss → still throws, with the corrected wording.
    pipeline.parseBrief = async () => ({
      campaignTitle: 'C', summary: 'S', writerPrompt: 'W',
      assets: [], unmatchedAssets: ['TikTok Ad'], referenceLinks: [],
    });
    await assert.rejects(() => runWebBriefParse('tiktok ad'), /any asset type Quillio supports: TikTok Ad/);
    await assert.rejects(() => runWebBriefParse('tiktok ad'), /Nothing was built/);
  } finally {
    Object.assign(pipeline, saved);
  }
});

test('web route: the confirmation payload carries the unmatched notice', async () => {
  await withBriefServer(
    {
      runWebBriefParse: async () => ({
        campaignTitle: 'Nurture Wave', summary: 'S', writerPrompt: 'W', referenceInsights: [],
        plan: [{ asset: 'Demand Gen Nurture Email', count: 5, labels: [] }],
        unmatchedAssets: ['TikTok Ad'],
        unmatchedNotice: "Couldn't match these to any asset type Quillio supports: TikTok Ad. It was left out — everything else was built.",
      }),
      runWebBriefGenerate: async () => ({ docUrl: 'https://docs.google.com/document/d/DOC/edit' }),
    },
    async ({ call, finish }) => {
      const start = await call('POST', '/api/brief', 'u1', { briefText: '5 nurture emails and a tiktok ad' });
      const paused = await finish(start.body.jobId, 'u1');
      assert.strictEqual(paused.result.needsConfirmation, true);
      // The confirm screen is the last point before anything is built — it must
      // be able to say what will be missing from the doc it is about to create.
      assert.deepStrictEqual(paused.result.interpretation.unmatchedAssets, ['TikTok Ad']);
      assert.match(paused.result.interpretation.unmatchedNotice, /TikTok Ad/);
    }
  );
});

test('app.html renders the unmatched notice on both the confirm and output screens', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('id="confirm-unmatched"'), 'the confirm screen has a notice host');
  assert.ok(html.includes('id="out-unmatched"'), 'the output screen has one too');
  assert.match(html, /renderNotice\('confirm-unmatched', interp\.unmatchedNotice\)/);
  assert.match(html, /renderNotice\('out-unmatched', data\.unmatchedNotice\)/);
  // Amber, not red: the run SUCCEEDED, so it must not be styled as an error.
  assert.match(html, /\.notice\s*\{[^}]*background:\s*#fdf8ec/);
  assert.ok(!/id="confirm-unmatched"[^>]*class="error/.test(html), 'not styled as an error');
});

// --- Silent failure 2: specReview overwrites tenant divergence ----------------
// commitReview updates copy_fields by asset name + field name with NO tenant
// predicate, so one approval rewrites every tenant's row. distinctValue already
// knew when tenants disagreed — it joins them into "150 | 200" — but a joined
// string says nothing about how many tenants hold each value or which ones, so
// a write that reverted a tenant looked exactly like one that changed nothing.

test('specReview divergence: the breakdown names the value, the count and the tenants', () => {
  const { tenantValueBreakdown } = require('../src/services/specReview');

  // Three tenants on the curated 150, one that has moved to 200.
  const rows = [
    { tenant_id: 'T1', char_max: 150, spec_note: 'n' },
    { tenant_id: 'T2', char_max: 150, spec_note: 'n' },
    { tenant_id: 'T3', char_max: 200, spec_note: 'n' },
    { tenant_id: 'T4', char_max: 150, spec_note: 'n' },
  ];
  const d = tenantValueBreakdown(rows, 'char_max');
  assert.strictEqual(d.diverged, true);
  assert.strictEqual(d.expected, '150', 'the value the most rows hold is the expected one');
  assert.strictEqual(d.expected_row_count, 3);
  assert.strictEqual(d.divergent_row_count, 1);
  assert.deepStrictEqual(d.divergent, [{ value: '200', tenants: ['T3'], row_count: 1 }]);

  // All agreeing → not diverged, so the UI renders nothing on the normal path.
  const same = tenantValueBreakdown(rows, 'spec_note');
  assert.strictEqual(same.diverged, false);
  assert.deepStrictEqual(same.divergent, []);
  assert.strictEqual(same.expected_row_count, 4);

  // null and '' are the SAME value — an unset spec_note and an empty one are not
  // two different tenant opinions.
  const nulls = tenantValueBreakdown(
    [{ tenant_id: 'T1', spec_note: null }, { tenant_id: 'T2', spec_note: '' }],
    'spec_note'
  );
  assert.strictEqual(nulls.diverged, false);

  // No rows at all (a renamed asset nobody matches) → empty, never a crash.
  assert.deepStrictEqual(tenantValueBreakdown([], 'char_max').divergent, []);
  assert.strictEqual(tenantValueBreakdown([], 'char_max').diverged, false);
});

test('specReview overwrite log: only rows whose VALUE changes are reported', () => {
  const { changedRows } = require('../src/services/specReview');

  const before = [
    { tenant_id: 'T1', char_max: 150 },
    { tenant_id: 'T2', char_max: 200 },
    { tenant_id: 'T3', char_max: 150 },
  ];
  // Writing 150: T2 loses its 200, the others are only re-stamped. The write
  // always sets spec_verified_at on every matched row, so counting a re-stamp as
  // an overwrite would bury the one row that actually lost data.
  const changed = changedRows(before, 'char_max', 150);
  assert.deepStrictEqual(changed, [
    { tenant_id: 'T2', attr: 'char_max', old_value: '200', new_value: '150', diverged: true },
  ]);

  // Writing something new overwrites everyone, and each entry carries what that
  // tenant held — the audit trail the commit log had no way to print before.
  const all = changedRows(before, 'char_max', 400);
  assert.strictEqual(all.length, 3);
  assert.deepStrictEqual(all.map((r) => [r.tenant_id, r.old_value]), [['T1', '150'], ['T2', '200'], ['T3', '150']]);

  // `diverged` separates the two kinds of overwrite. T1 and T3 held what everyone
  // else held — a routine update. T2 held its OWN value and that value is now
  // gone, which is the only one of the three that reverts a tenant.
  assert.deepStrictEqual(all.map((r) => r.diverged), [false, true, false]);

  assert.deepStrictEqual(changedRows([], 'char_max', 1), []);
});

test('admin.html surfaces divergence in the preview and the overwrite list after commit', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  // The preview roll-up says the write has no tenant filter, in the UI, not just
  // in a server log the admin will never read.
  assert.match(html, /pv\.diverged/);
  assert.match(html, /divergent_field_count/);
  assert.match(html, /no tenant filter/);
  // Per-field detail: which value, how many rows, which tenants.
  assert.match(html, /function divergenceNode/);
  assert.match(html, /row\(s\) hold something else and will be overwritten/);
  assert.match(html, /g\.tenants\.join/);
  // And after the write, what was actually reverted.
  assert.match(html, /w\.overwritten/);
  assert.match(html, /held a different value and were overwritten/);
  assert.match(html, /diverged_overwritten_count/);
  assert.match(html, /this tenant/, 'and names the rows whose own value is gone');
  // Amber — a fact to weigh, not an error that blocked the write.
  assert.match(html, /\.msg\.warn\s*\{[^}]*--warn/);
});

// --- Asset-library uniqueness (scripts/migrateAddAssetUniqueness.js) ---------
// There is no UNIQUE constraint on asset_types (tenant_id, name) or copy_fields
// (asset_type_id, field_name), and duplicates do not fail loudly — they resolve
// four different ways (pipeline takes the FIRST row, getAssetDirections the LAST,
// copyReview's fieldKey and googleDocs' ctxKey collapse a repeated field name
// onto one key). The migration adds the constraint; these tests pin the parts of
// it that can be checked without a database.

test('normalizer convergence: one definition, not three', () => {
  const assets = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'assets.js'), 'utf8');
  const gemini = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'gemini.js'), 'utf8');

  // Neither file may re-declare a normalizer of its own any more.
  assert.ok(!/function normName\s*\(/.test(assets), 'db/assets.js no longer defines its own normName');
  assert.match(assets, /require\('\.\.\/utils\/normalize'\)/, 'db/assets.js takes the shared one');
  assert.ok(
    !/const normalize = \(s\) =>/.test(gemini),
    'gemini.js no longer defines a local normalize inside parseBrief'
  );
  assert.match(gemini, /require\('\.\.\/utils\/normalize'\)/, 'gemini.js takes the shared one');
});

test('normalizer convergence: no allowed asset name collides under the shared fold', () => {
  const { normalize } = require('../src/utils/normalize');
  const { ALLOWED_ASSETS } = require('../src/config');
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

  // If two allowed names folded together, parseBrief's canonicalByNorm would
  // silently drop one — and the unique index would refuse to build at all.
  const seen = new Map();
  for (const n of ALLOWED_ASSETS) {
    const k = normalize(n);
    assert.ok(!seen.has(k), `"${n}" and "${seen.get(k)}" both normalize to "${k}"`);
    seen.set(k, n);
  }
  assert.strictEqual(seen.size, ALLOWED_ASSETS.length);
});

test('the bundled library can actually satisfy the unique index', () => {
  // The precondition for the migration: seedTenantAssets must not itself create
  // a conflict. A duplicate introduced into defaultAssets.js would make the
  // migration refuse for EVERY tenant, so this fails CI instead.
  const { normalize } = require('../src/utils/normalize');
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

  const names = new Map();
  for (const a of DEFAULT_ASSETS) {
    const k = normalize(a.name);
    assert.ok(!names.has(k), `asset "${a.name}" and "${names.get(k)}" both normalize to "${k}"`);
    names.set(k, a.name);
  }
  // And no asset may carry two fields whose names fold together.
  for (const a of DEFAULT_ASSETS) {
    const fields = new Map();
    for (const f of a.fields) {
      const k = normalize(f.field_name);
      assert.ok(
        !fields.has(k),
        `${a.name}: fields "${f.field_name}" and "${fields.get(k)}" both normalize to "${k}"`
      );
      fields.set(k, f.field_name);
    }
  }
});

test('gemini parse matching got MORE tolerant, and stayed collision-free', () => {
  const { normalize } = require('../src/utils/normalize');
  // The local normalizer folded dashes but kept the spaces around them, so an
  // em dash written WITHOUT spaces missed. The shared one matches it.
  assert.strictEqual(normalize('Direct Mail—Box / Mailer'), normalize('Direct Mail — Box / Mailer'));
  assert.strictEqual(normalize('Direct Mail - Box / Mailer'), normalize('Direct Mail — Box / Mailer'));
  assert.strictEqual(normalize('direct mail  —  box / mailer'), normalize('Direct Mail — Box / Mailer'));
  // Still distinguishes genuinely different assets.
  assert.notStrictEqual(normalize('One-Pager'), normalize('Battle Card'));
  assert.notStrictEqual(
    normalize('LinkedIn Single Image Ad — Variant A'),
    normalize('LinkedIn Single Image Ad — Variant B')
  );
});

test('migration SQL character classes are DERIVED from the JS regexes, not retyped', () => {
  // The drift guard. The index must fold exactly what utils/normalize folds; if
  // a future edit changes either JS class, these recomputed strings stop
  // matching the migration's constants and CI fails instead of the index
  // quietly disagreeing with the pipeline.
  const { WS, DASH } = require('../scripts/migrateAddAssetUniqueness');

  const esc = (c) => '\\u' + c.toString(16).toLowerCase().padStart(4, '0');
  const classFor = (re) => {
    const cps = [];
    for (let c = 0; c <= 0xffff; c += 1) if (re.test(String.fromCodePoint(c))) cps.push(c);
    const parts = [];
    let i = 0;
    while (i < cps.length) {
      let j = i;
      while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j += 1;
      parts.push(j - i >= 2 ? `${esc(cps[i])}-${esc(cps[j])}` : cps.slice(i, j + 1).map(esc).join(''));
      i = j + 1;
    }
    return parts.join('');
  };

  assert.strictEqual(WS, classFor(/\s/), 'WS class still equals every character JS \\s matches');
  assert.strictEqual(DASH, classFor(/[‐-―−]/), 'DASH class still equals the normalize() dash set');

  // Postgres \s is locale-dependent and does NOT match U+00A0, so using it would
  // make the index LAXER than the pipeline. The class must stay spelled out.
  assert.ok(WS.includes('\\u00a0'), 'the whitespace class covers NBSP explicitly');
  const { NORMALIZE_SQL } = require('../scripts/migrateAddAssetUniqueness');
  assert.ok(!/\\\\s/.test(NORMALIZE_SQL), 'the SQL never falls back to Postgres \\s');
});

test('migration SQL mirrors normalize() step for step, in order', () => {
  const { NORMALIZE_SQL, CREATE_FUNCTION_SQL } = require('../scripts/migrateAddAssetUniqueness');
  // lower → fold dashes → drop spaces around hyphens → collapse runs → trim.
  // The order is load-bearing: dropping spaces around hyphens BEFORE collapsing
  // runs is what turns 'A  —  B' into 'a-b' rather than 'a - b'.
  const dashAt = NORMALIZE_SQL.indexOf("'-', 'g'");
  const collapseAt = NORMALIZE_SQL.indexOf("' ', 'g'");
  assert.ok(NORMALIZE_SQL.includes('lower(coalesce($1'), 'lowercases first, null-safe like String(s || "")');
  assert.ok(dashAt > 0 && collapseAt > dashAt, 'dash/hyphen folding happens before whitespace collapsing');
  assert.ok(NORMALIZE_SQL.includes("btrim("), 'and trims last');
  // The index expression needs an IMMUTABLE function or Postgres refuses it.
  assert.match(CREATE_FUNCTION_SQL, /IMMUTABLE/);
  assert.match(CREATE_FUNCTION_SQL, /quillio_normalize_name/);
});

test('migration is dry-run by default, refuses on conflict, and never auto-resolves', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'migrateAddAssetUniqueness.js'),
    'utf8'
  );
  assert.match(src, /const COMMIT = process\.argv\.includes\('--commit'\)/, 'writes are opt-in');
  assert.match(src, /REFUSING TO CREATE THE INDEXES/, 'a conflict stops the run');
  assert.match(src, /process\.exit\(refused \? 2 : 0\)/, 'and exits non-zero so a pipeline notices');
  // Everything is one transaction, so a refusal leaves no function and no index.
  assert.match(src, /await client\.query\('BEGIN'\)/);
  // It must not delete, rename or otherwise pick a winner among duplicates.
  assert.ok(!/DELETE FROM asset_types|UPDATE asset_types SET name/.test(src), 'never resolves a conflict itself');

  const { INDEXES } = require('../scripts/migrateAddAssetUniqueness');
  assert.strictEqual(INDEXES.length, 2);
  assert.ok(INDEXES.every((i) => /CREATE UNIQUE INDEX IF NOT EXISTS/.test(i.sql)), 're-runnable');
  // Both nullable owner columns are coalesced — a unique index treats NULLs as
  // distinct, so two orphan rows sharing a name would otherwise slip through.
  assert.match(INDEXES[0].sql, /coalesce\(tenant_id, ''\)/);
  assert.match(INDEXES[1].sql, /coalesce\(asset_type_id, -1\)/);
});

// --- The parse allow-list is the TENANT's library, not a global constant ------
// config.ALLOWED_ASSETS gated gemini.parseBrief unconditionally, which meant an
// asset sitting in a tenant's asset_types but missing from the bundled 30 was
// filtered out of the plan — a tenant could not ask for an asset they owned.
// Three of the four gates downstream were already per-tenant; this was the one
// global one, upstream of all of them.

test('parseBrief is gated on the vocabulary it is GIVEN, not on ALLOWED_ASSETS', async () => {
  const { ALLOWED_ASSETS } = require('../src/config');
  const custom = 'Podcast Read Ad';
  assert.ok(!ALLOWED_ASSETS.includes(custom), 'the fixture name is genuinely not in the bundled list');

  const model = { ...MODEL_BASE, assets: [{ asset: custom, count: 2 }, { asset: 'Battle Card', count: 1 }] };

  // Given a tenant vocabulary that HAS it, it survives the filter.
  const withTenant = await parseBriefWith(model, 'brief', [custom, 'Battle Card']);
  assert.deepStrictEqual(withTenant.result.assets, [
    { asset: custom, count: 2 },
    { asset: 'Battle Card', count: 1 },
  ]);
  assert.deepStrictEqual(withTenant.result.unmatchedAssets, []);
  assert.ok(withTenant.prompt.includes(custom), 'and the model was actually offered it');

  // Given the bundled list (the old behavior), it is filtered out and surfaced.
  const withDefault = await parseBriefWith(model, 'brief');
  assert.deepStrictEqual(withDefault.result.assets, [{ asset: 'Battle Card', count: 1 }]);
  assert.deepStrictEqual(withDefault.result.unmatchedAssets, [custom]);
});

test('a name the TENANT lacks is caught at parse, not thrown downstream', async () => {
  // Before, a name in ALLOWED_ASSETS but absent from the tenant's library parsed
  // clean and then threw inside tenantAssetsToSpecs. Now the parse gate is the
  // same list the expansion checks, so it is reported instead of exploding.
  const narrow = require('../src/config').ALLOWED_ASSETS.filter((n) => n !== 'Battle Card');
  const { result } = await parseBriefWith(
    { ...MODEL_BASE, assets: [{ asset: 'Battle Card', count: 1 }, { asset: 'One-Pager', count: 1 }] },
    'brief',
    narrow
  );
  assert.deepStrictEqual(result.assets, [{ asset: 'One-Pager', count: 1 }]);
  assert.deepStrictEqual(result.unmatchedAssets, ['Battle Card']);

  // And what survived really does clear the downstream gate.
  const { tenantAssetsToSpecs } = require('../src/core/pipeline');
  const rows = narrow.map((name, i) => ({
    id: i + 1, name, group: 'g', sort_order: i,
    fields: [{ field_name: 'H', char_min: 0, char_max: 10, field_type: 'text', sort_order: 0 }],
  }));
  assert.strictEqual(tenantAssetsToSpecs(rows, result.assets).length, 1);
});

test('no-DB / demo falls back to the 30-name constant, unchanged', async () => {
  const { resolveAssetVocabulary } = require('../src/core/pipeline');
  const { ALLOWED_ASSETS } = require('../src/config');
  // No DATABASE_URL in the test env, so getTenantAssets returns null for any id.
  for (const tenantId of [null, undefined, 'T0B8LPRDKHR']) {
    const v = await resolveAssetVocabulary(tenantId);
    assert.strictEqual(v.source, 'default', `tenant ${tenantId} falls back`);
    assert.deepStrictEqual(v.names, ALLOWED_ASSETS);
  }
  // An empty list passed to gemini.parseBrief is treated as "no vocabulary",
  // never as "nothing is allowed" — which would reject every brief.
  const { prompt } = await parseBriefWith({ ...MODEL_BASE, assets: [] }, 'brief', []);
  assert.ok(prompt.includes('Battle Card'), 'an empty list still offers the bundled 30');
});

test('the mapping block is filtered to targets the tenant actually has', async () => {
  const { assetPhraseHintLines, ASSET_PHRASE_HINTS } = require('../src/services/gemini');
  const { ALLOWED_ASSETS } = require('../src/config');

  // Every targeted hint must name a real asset AND mention it in its own rendered
  // line. That is the drift guard: `target` drives the filtering, so if someone
  // rewrites a line's text without updating `target` (or vice versa), the wrong
  // line gets dropped for the wrong tenant. Not `endsWith` — most lines are
  // "phrase → Target", but the A/B one is prose ("… one entry: X, count 3").
  for (const h of ASSET_PHRASE_HINTS) {
    if (h.always || h.anyMatching) continue;
    assert.ok(ALLOWED_ASSETS.includes(h.target), `${h.target} is a real asset name`);
    assert.ok(h.line.includes(h.target), `hint line for ${h.target} names its own target`);
  }

  // Full list → every mapping present.
  const full = assetPhraseHintLines(ALLOWED_ASSETS).join('\n');
  assert.ok(full.includes('→ Battle Card'));
  assert.ok(full.includes('→ Sales Basho Email'));

  // Narrow list → the lines whose targets are gone go with them. A stale mapping
  // line is worse than none: it tells the model to emit a name the filter will
  // then reject, which is exactly the silent drop this work made loud.
  const narrow = assetPhraseHintLines(['One-Pager', 'Campaign Landing Page']).join('\n');
  assert.ok(!narrow.includes('Battle Card'), 'no mapping to an asset this tenant lacks');
  assert.ok(!narrow.includes('Sales Basho Email'));
  assert.ok(narrow.includes('→ One-Pager'), 'kept the one it does have');

  // The count/A-B rule is about the `count` mechanism, not any asset, so it
  // survives a library with no LinkedIn in it at all.
  assert.ok(narrow.includes('the BASE asset, count 2'), 'universal count guidance always ships');
  assert.ok(narrow.includes('MORE VERSIONS OF ONE ASSET'));
  // …but the LinkedIn example and the Variant caveat do not.
  assert.ok(!narrow.includes('3 linkedin ads'), 'the LinkedIn example needs LinkedIn');
  assert.ok(!narrow.includes('Variant A'), 'the Variant caveat needs Variant types');
  assert.ok(
    assetPhraseHintLines(['LinkedIn Single Image Ad — Variant A']).join('\n').includes('Variant A'),
    'and it comes back for a library that has them'
  );
});

test('refusal examples never name an asset the tenant owns', async () => {
  const { refusalRuleLine, REFUSAL_EXAMPLES } = require('../src/services/gemini');
  const { ALLOWED_ASSETS } = require('../src/config');

  // Default library: none of the four are in it, so all four still illustrate.
  const base = refusalRuleLine(ALLOWED_ASSETS);
  for (const ex of REFUSAL_EXAMPLES) assert.ok(base.includes(ex), `${ex} still an example`);

  // A tenant with a podcast asset must NOT be told to refuse podcast asks. The
  // match is token-based on purpose: "Podcast Read Ad" does not CONTAIN the
  // substring "podcast ad" — "Read" sits between the words — so a substring
  // test left this exact line in the prompt.
  const podcast = refusalRuleLine([...ALLOWED_ASSETS, 'Podcast Read Ad']);
  assert.ok(!podcast.includes('podcast ad'), 'dropped the example this tenant owns');
  assert.ok(podcast.includes('TikTok') && podcast.includes('billboard'), 'kept the others');

  // A tenant owning all four gets the rule with no examples rather than a rule
  // naming their own assets as things to refuse.
  const all = refusalRuleLine(['TikTok Ad', 'Podcast Ad', 'Billboard', 'SMS Blast']);
  assert.ok(!/e\.g\./.test(all), 'no examples left');
  assert.ok(all.includes('do NOT substitute a nearest guess'), 'but the rule still stands');
});

test('the unmatched message names the gate that actually ran', () => {
  const { totalMissMessage, partialMissNotice } = require('../src/utils/assetMatch');

  // Tenant library gate → "your asset library", and adding it is REAL advice.
  const t = totalMissMessage(['TikTok Ad'], 'tenant');
  assert.match(t, /your asset library: TikTok Ad\./);
  assert.match(t, /add them to your asset library/i);
  const tp = partialMissNotice(['TikTok Ad'], 'tenant');
  assert.match(tp, /your asset library/);
  assert.match(tp, /Add it to your asset library to include it next time\./);

  // Bundled-list gate (no DB / demo) → the old wording. There is no library to
  // add to, so promising that adding one would help would be a lie.
  const d = totalMissMessage(['TikTok Ad'], 'default');
  assert.match(d, /any asset type Quillio supports/);
  assert.ok(!/add them to your asset library/i.test(d), 'never promises a fix that cannot work');
  // An absent/unknown source degrades to the weaker but never-false claim.
  assert.strictEqual(totalMissMessage(['X']), totalMissMessage(['X'], 'default'));
  assert.strictEqual(partialMissNotice(['X'], 'nonsense'), partialMissNotice(['X'], 'default'));
});

// --- The asset-library EDITOR read (read-only) -------------------------------
// getTenantAssets is built for the pipeline: it hides inactive rows and drops
// copy_fields.id. An editor needs both. getTenantLibrary is a second reader
// rather than a widened one, so what a brief builds cannot change underneath it.

test('db/assets exposes the editor read and the id-based toggle', () => {
  const a = require('../src/db/assets');
  assert.strictEqual(typeof a.getTenantLibrary, 'function');
  assert.strictEqual(typeof a.setActiveAssetIds, 'function');
  // The pipeline's reader and the legacy name toggle both still exist.
  assert.strictEqual(typeof a.getTenantAssets, 'function');
  assert.strictEqual(typeof a.setActiveAssets, 'function');
});

test('getTenantAssets was NOT changed to serve the editor', () => {
  // Widening the pipeline's read would silently change what every brief builds.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'assets.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function getTenantAssets'), src.indexOf('// THE EDITOR READ'));
  assert.match(fn, /WHERE tenant_id = \$1 AND is_active = true/, 'still active-only');
  assert.ok(!/\bid: row\.id\b/.test(fn), 'still does not carry copy_fields.id');
  // And the editor read is the one that does both.
  const lib = src.slice(src.indexOf('async function getTenantLibrary'));
  assert.ok(!/is_active = true/.test(lib.slice(0, lib.indexOf('ORDER BY'))), 'editor read is not active-filtered');
  assert.match(lib, /SELECT id, asset_type_id, field_name/, 'and it selects field ids');
});

test('the library route is session-scoped and cannot be pointed elsewhere', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'settings.js'), 'utf8');
  // The GET slice now ends at the POST below it, which legitimately reads
  // req.body for the asset id — that is checked separately, and against the
  // tenant's own library, so the two must not be measured as one block.
  const route = src.slice(src.indexOf("'/api/settings/library'"), src.indexOf("POST /api/settings/library/active"));
  assert.match(route, /settingsReadLimiter, requireAuth/, 'rate-limited and auth-gated');
  assert.match(route, /req\.user && req\.user\.tenant_id/, 'tenant comes from the session');
  assert.ok(!/req\.body|req\.query|req\.params/.test(route), 'never takes a tenant from the request');
  // It must NOT share the deliberately un-gated onboarding handler.
  const onboarding = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'onboarding.js'), 'utf8');
  assert.ok(!/api\/settings\/library/.test(onboarding), 'the un-gated router does not serve it');
});

test('onboarding toggles are keyed on ids, with names kept for one deploy window', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'onboarding.js'), 'utf8');
  assert.match(route, /body\.deactivatedIds/, 'ids are the primary input');
  assert.match(route, /setActiveAssetIds/);
  // The name path still exists — a browser that loaded the old script before
  // this deploy is still open and will post names when the user finishes.
  assert.match(route, /body\.deactivated\b/);
  assert.match(route, /setActiveAssets\(/);
  // The GET now carries ids for the POST to send back.
  assert.match(route, /id: a\.id \|\| null/);
  assert.match(route, /getTenantLibrary/, 'and reads inactive rows so returning users see their own toggles');

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(html, /data-id/, 'the client stores the id on each checkbox');
  assert.match(html, /deactivatedIds: deactivatedIds/, 'and posts ids when it has them');
});

test('the legacy name toggle folds names the way everything else does', () => {
  // The old SQL matched `name <> ALL($2::text[])` — raw text. A name differing
  // only in dash style matched nothing and silently deactivated nothing. The
  // name path now resolves through utils/normalize before touching ids.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'assets.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function setActiveAssets(tenantId'));
  assert.ok(!/name <> ALL/.test(fn), 'no raw-text name matching left');
  assert.match(fn, /normalize\(/, 'folds through the shared normalizer');
  assert.match(fn, /setActiveAssetIds\(tenantId, ids\)/, 'and delegates to the id path');

  // The id write is the only place that flips is_active, and it validates ids
  // before they reach Postgres (a bad cast would abort the whole statement).
  const byId = src.slice(src.indexOf('async function setActiveAssetIds'));
  assert.match(byId, /\/\^\\d\+\$\//, 'ids are digit-checked');
  assert.match(byId, /id <> ALL\(\$2::bigint\[\]\)/);
});

test('an EXISTING asset card is still read-only apart from its toggle', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  assert.ok(html.includes('id="panel-library"'), 'the panel exists');
  assert.ok(html.includes('data-tab="library"'), 'reachable from the hub and the sidebar');
  assert.match(html, /fetch\('\/api\/settings\/library'\)/, 'and reads the gated route');

  // libRenderAsset draws a card for an asset the tenant ALREADY has. A create
  // form now exists elsewhere on this panel, but the card itself must stay
  // read-only: one checkbox (the toggle) and nothing else. Editing an existing
  // asset — seeded or custom — is a later step.
  const card = html.slice(html.indexOf('function libRenderAsset'), html.indexOf('--- Create an asset type'));
  const inputs = card.match(/createElement\('input'\)/g) || [];
  assert.strictEqual(inputs.length, 1, 'exactly one input on a card: the toggle');
  assert.match(card, /input\.type = 'checkbox'/);
  for (const affordance of ["createElement('textarea')", "createElement('select')", 'contenteditable']) {
    assert.ok(!card.includes(affordance), `no ${affordance} on an existing asset card`);
  }

  // house_default / null must render NO tier — same rule googleDocs specTypeLine
  // applies, so an unsourced field never looks authoritative.
  assert.match(html, /if \(f\.spec_type !== 'enforced' && f\.spec_type !== 'recommended'\) return null;/);
  // And the unit shown matches what the doc's bracket means.
  assert.match(html, /fieldType === 'words' \? 'words' : 'chars'/);
});

// --- Sign-in routing: a finished user never re-enters onboarding -------------
// The flag was being set correctly and read correctly — but `redirect=onboarding`
// returned one line BEFORE the read, and requireAuth pointed every
// unauthenticated page request at the onboarding screen, whose only control
// carried that parameter. So the ordinary way a returning user signed in was the
// one path that never consulted the flag.

test('the callback reads setup state BEFORE branching on redirect=onboarding', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oauth.js'), 'utf8');
  const cb = src.slice(src.indexOf("router.get('/oauth/google/callback'"));

  // Anchored on the READ specifically (the camelCase assignment), not on the
  // column name — that also appears in the new-tenant INSERT earlier in this
  // same handler, which would measure the wrong position.
  const readAt = cb.indexOf('onboardingComplete = !!(');
  const onboardingBranchAt = cb.indexOf("'/onboarding?step=2'");
  assert.ok(readAt > 0 && onboardingBranchAt > 0, 'both still present');
  assert.ok(readAt < onboardingBranchAt, 'the flag is read before the onboarding branch, not after');

  // Completed → the app, unconditionally, whichever link started the sign-in.
  assert.match(cb, /if \(onboardingComplete\) return res\.redirect\('\/app\?connected=google'\)/);
  // Incomplete + came from onboarding → resume at step 2; otherwise start.
  assert.match(
    cb,
    /redirectTo === 'onboarding' \? '\/onboarding\?step=2' : '\/onboarding'/,
    'the resume branch survives for the users it was for'
  );
  // Settings is about the sign-in itself, not setup state — untouched, and still
  // returning before the DB read so it costs no query.
  const settingsAt = cb.indexOf("'/settings?connected=google'");
  assert.ok(settingsAt > 0 && settingsAt < readAt, 'settings still returns early');
});

test('an unauthenticated page request goes to the landing page, not the signup flow', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8');
  const deny = src.slice(src.indexOf('function denyUnauthenticated'));
  assert.match(deny, /return res\.redirect\('\/'\)/, 'pages land on /');
  assert.ok(!/redirect\('\/onboarding'\)/.test(deny), 'no longer dumps returning users into signup');
  // NOT /oauth/google: that route redirects to /app?error=google_failed when
  // OAuth is misconfigured, and /app is behind requireAuth — this function would
  // then redirect back to it forever.
  assert.ok(!/redirect\('\/oauth\/google/.test(deny), 'and not straight into OAuth (loop risk)');
  // API callers still get JSON, unchanged.
  assert.match(deny, /status\(401\)\.json/);
});

test('onboarding step 1 offers a way out for someone who already has an account', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  const step1 = html.slice(html.indexOf('id="step-1"'), html.indexOf('id="step-2"'));

  // The create-account button still carries redirect=onboarding (it resumes an
  // incomplete signup at step 2) — that behaviour is unchanged.
  assert.ok(html.includes("/oauth/google?redirect=onboarding"), 'signup path intact');
  // And there is now a BARE /oauth/google on the same screen, which routes on
  // setup state. A plain <a>, so it works even if the page script fails.
  assert.match(step1, /<a href="\/oauth\/google"/, 'bare sign-in link present on step 1');
  assert.match(step1, /Already have an account\?/);
  assert.ok(!/oauth\/google\?redirect/.test(step1.slice(step1.indexOf('Already have an account'))),
    'the escape-hatch link carries no redirect parameter');
});

test('the landing page keeps the two CTAs distinct', () => {
  // Unchanged, and load-bearing: /onboarding is the create-account flow and bare
  // /oauth/google is the flag-checked sign-in. requireAuth now points at this
  // page precisely because it offers the choice.
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /href="\/onboarding">Create account<\/a>/);
  assert.match(server, /href="\/oauth\/google">Sign in<\/a>/);
});

// --- Asset on/off from Settings ----------------------------------------------
// The smallest possible write path: is_active and nothing else. Onboarding was
// the only place with these toggles, so a tenant that finished setup could not
// change their asset list without signing out and re-onboarding.

test('the on/off route writes is_active only, scoped to the session tenant', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'settings.js'), 'utf8');
  // Ends at the create route below it, which legitimately NAMES spec_type and
  // spec_source in its comment (explaining why they are absent) — measuring the
  // two as one block would read that comment as this handler touching them.
  const route = src.slice(
    src.indexOf("POST /api/settings/library/active"),
    src.indexOf('POST /api/settings/library/asset')
  );
  assert.match(route, /settingsWriteLimiter, requireAuth/, 'rate-limited and auth-gated');
  assert.match(route, /req\.user && req\.user\.tenant_id/, 'tenant from the session');
  // The id IS taken from the body — but validated against this tenant's own
  // library, so somebody else's id is a 404 rather than a silent no-op.
  assert.match(route, /assets\.some\(\(a\) => a\.id === id\)/);
  assert.match(route, /status\(404\)/);
  // is_active is the only thing it can change: the write is setActiveAssetIds,
  // and no other column name appears anywhere in the handler.
  assert.match(route, /setActiveAssetIds\(tenantId, deactivated\)/);
  for (const col of ['char_max', 'char_min', 'field_name', 'spec_type', 'spec_source', 'asset_direction', 'name =']) {
    assert.ok(!route.includes(col), `handler never touches ${col}`);
  }
  // Typed input, so a junk id never reaches Postgres.
  assert.match(route, /\/\^\\d\+\$\//);
  assert.match(route, /typeof active !== 'boolean'/);
});

test('a failed save reverts the toggle, the card and the count', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  const handler = html.slice(html.indexOf("input.addEventListener('change'"), html.indexOf('card.appendChild(head)'));

  // Optimistic first…
  assert.match(handler, /a\.is_active = want;[\s\S]*libPaintActive\(card, want\)/, 'paints before the request');
  // …then a full revert on ANY failure — not just the checkbox. A revert that
  // left the card dimmed would still be showing a state the server rejected.
  const revert = handler.slice(handler.indexOf('} catch (e) {'));
  assert.match(revert, /a\.is_active = before/);
  assert.match(revert, /input\.checked = before/);
  assert.match(revert, /libPaintActive\(card, before\)/);
  assert.match(revert, /libRenderSummary\(\)/);
  assert.match(revert, /Not saved\./, 'and it says so');
  // A non-2xx with a JSON body must throw, not be treated as success.
  assert.match(handler, /if \(!res\.ok \|\| !data \|\| !data\.success\)/);
  // In-flight guard so a double click can't race itself.
  assert.match(handler, /input\.disabled = true/);
  assert.match(handler, /input\.disabled = false/);
});

test('the library screen reaches exactly two writes, and neither claims a spec', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  const libJs = html.slice(html.indexOf('--- Asset library'), html.indexOf('--- Markdown render'));

  // Two, and only two: flip an asset on/off, and create a new one.
  const posts = libJs.match(/method: 'POST'/g) || [];
  assert.strictEqual(posts.length, 2, 'two POSTs, no more');
  assert.match(libJs, /'\/api\/settings\/library\/active'/);
  assert.match(libJs, /'\/api\/settings\/library\/asset'/);
  // No delete, no clone, no edit-an-existing-asset.
  assert.ok(!/method: 'DELETE'|method: 'PATCH'|method: 'PUT'/.test(libJs), 'no delete/patch/put from this screen');

  // The client cannot even NAME the two authority columns — there is nothing to
  // put them in, which is the point of the allowlist being server-side. (The
  // read-only renderer above DOES read f.spec_type, to draw the tier badge; the
  // create form is the half that must never mention either.)
  const createJs = html.slice(html.indexOf('--- Create an asset type'), html.indexOf('async function libEnsureLoaded'));
  assert.ok(createJs.length > 500, 'found the create form');
  // Comments stripped: the form's own comments explain WHY the two columns are
  // absent, which is the opposite of touching them.
  const code = createJs.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/spec_type|spec_source/.test(code),
    'the create form never sends spec_type or spec_source');
  // What it does send is the allowlisted six.
  assert.match(libJs, /field_name: name\.value/);
  assert.match(libJs, /spec_note: note\.value/);
});

test('the group label heads its rows the way the doc does — space and indent', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  const css = html.slice(html.indexOf('.lib-grouplabel {'), html.indexOf('.lib-toggle {'));

  // The doc renders this as a HEADING_4 and INDENTS the fields under it
  // (googleDocs.js GROUP_INDENT_PT). No rule — the nesting carries the grouping.
  assert.match(css, /border-top: none/, 'no rule: it floated between two separations');
  assert.match(css, /margin: 11px 0 0/, 'space above, nothing below');
  // The rows step in, and the divider steps in with them (margin, not padding).
  assert.match(css, /\.lib-field\.grouped \{ margin-left: 14px; \}/);
  assert.match(html, /'lib-field' \+ \(f\.group_label \? ' grouped' : ''\)/, 'grouped rows get the class');
  // The first row under a label needs no rule of its own.
  assert.match(css, /\.lib-grouplabel \+ \.lib-field \{ border-top: none; padding-top: 3px; \}/);
  // Still a heading, not a caption.
  assert.match(css, /font-weight: 700/);
  assert.match(css, /text-transform: uppercase/);
  assert.match(css, /letter-spacing/);
  assert.match(css, /rgba\(26,26,46,0\.62\)/);
  // A label that opens an asset has nothing above it to separate from.
  assert.match(css, /\.lib-grouplabel:first-child \{ margin-top: 2px; \}/);
});

test('the off state is the toggle and the card, with no pill to shift it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  // The pill sat between the toggle and the card edge, so adding/removing it
  // moved the toggle sideways on every flip.
  const libJs = html.slice(html.indexOf('--- Asset library'), html.indexOf('--- Markdown render'));
  assert.ok(!/'pill', 'Off'/.test(libJs), 'no Off pill is rendered');
  assert.ok(!/querySelector\('\.pill'\)/.test(libJs), 'and none is added or removed on toggle');
  // The toggle is the last thing in the row and is pinned to the edge.
  assert.match(html, /\.lib-toggle \{[^}]*margin-left: auto/);
  // The remaining off cues are the dimmed, dashed card — unchanged.
  assert.match(html, /\.lib-asset\.off \{ opacity: 0\.6; border-style: dashed; \}/);
  assert.match(html, /function libPaintActive\(card, active\) \{\s*card\.classList\.toggle\('off', !active\);\s*\}/);
});

// --- Creating a custom asset type -------------------------------------------
// The first tenant-facing WRITE into asset_types. Everything below is about one
// question: what shape can a tenant put in the library, and what can it never
// put there? utils/assetInput is the whole answer, so it is tested directly.

test('the accepted shape is built key by key — spec_type and spec_source have no branch', () => {
  const { normalizeNewAsset } = require('../src/utils/assetInput');

  // Every hostile shape at once: the two authority columns, the primary key, the
  // tenant, the sort position, and a nested attempt on the field.
  const { errors, asset } = normalizeNewAsset({
    name: 'House Landing Page',
    group: 'Web',
    asset_direction: 'Plain. Concrete.',
    id: 999,
    tenant_id: 'other-tenant',
    is_active: false,
    sort_order: -5,
    spec_type: 'enforced',
    spec_source: 'https://www.linkedin.com/help/linkedin/answer/a552861',
    fields: [
      {
        field_name: 'Hero Headline',
        char_max: 70,
        spec_type: 'enforced',
        spec_source: 'https://www.linkedin.com/help/linkedin/answer/a552861',
        spec_version: 3,
        id: 42,
        asset_type_id: 7,
      },
    ],
  });
  assert.deepStrictEqual(errors, []);

  // The asset carries four keys and the field carries six. Not "the extras were
  // set to null" — they are ABSENT, so nothing downstream can read them back.
  assert.deepStrictEqual(Object.keys(asset).sort(), ['asset_direction', 'fields', 'group', 'name']);
  assert.deepStrictEqual(Object.keys(asset.fields[0]).sort(),
    ['char_max', 'char_min', 'field_name', 'field_type', 'sort_order', 'spec_note']);
  assert.ok(!('spec_type' in asset.fields[0]), 'spec_type is not a key');
  assert.ok(!('spec_source' in asset.fields[0]), 'spec_source is not a key');
  // The whole object, serialized, mentions neither — no nesting, no aliasing.
  assert.ok(!/spec_type|spec_source|tenant_id|is_active/.test(JSON.stringify(asset)));
  // sort_order is the submitted ORDER, never the submitted number.
  assert.strictEqual(asset.fields[0].sort_order, 1);
});

test('the INSERT statement itself never names the authority columns', () => {
  // The allowlist above is the design; this is the backstop. Even if a shape
  // leaked through, the SQL has no placeholder for either column, so Postgres
  // leaves them NULL and googleDocs specTypeLine renders no tier for the field.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'assets.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function createAssetType'), src.indexOf('// Asset toggles, BY ID'));
  const sql = fn.match(/INSERT INTO copy_fields[\s\S]*?VALUES \([^)]*\)/)[0];
  assert.ok(!/spec_type|spec_source|spec_version/.test(sql), 'the field INSERT names six columns and no spec claim');
  assert.match(sql, /field_name, char_min, char_max, field_type, sort_order, spec_note/);

  // Asset + fields land together or not at all. A type with zero fields is
  // dropped by tenantAssetsToSpecs, so a half-write would be invisible to the
  // pipeline while still showing in the library.
  assert.match(fn, /await client\.query\('BEGIN'\)/);
  assert.match(fn, /await client\.query\('COMMIT'\)/);
  assert.match(fn, /ROLLBACK/);
  assert.match(fn, /client\.release\(\)/);
  // And it appends rather than colliding with a seeded position.
  assert.match(fn, /COALESCE\(MAX\(sort_order\), 0\)/);
});

test('every rejected shape is rejected, and says why', () => {
  const { normalizeNewAsset, MAX_FIELDS_PER_ASSET, MAX_ASSETS_PER_TENANT } = require('../src/utils/assetInput');
  const ok = { name: 'X', fields: [{ field_name: 'Headline', char_max: 70 }] };
  const bad = (body, opts) => normalizeNewAsset(body, opts).errors;

  assert.match(bad({ ...ok, name: '  ' })[0], /Give the asset type a name/);
  assert.match(bad({ ...ok, name: 'A'.repeat(121) })[0], /120 characters or fewer/);
  assert.match(bad({ ...ok, fields: [] })[0], /at least one copy field/);
  assert.match(bad({ ...ok, fields: [{ field_name: '' }] })[0], /Field 1: give the field a name/);

  // A name ending in a number is how googleDocs labels a REPEATED asset, so the
  // doc would read it back as instance N of a different asset.
  assert.match(bad({ ...ok, name: 'Landing Page 2' })[0], /ends in a number/);
  // A field name ending in brackets collides with the limit fieldLabel appends.
  assert.match(bad({ ...ok, fields: [{ field_name: 'Headline [v2]' }] })[0], /can't end in \[brackets\]/);

  // Duplicates — against the tenant's library, and within the submission. Both
  // fold through utils/normalize, so a dash variant is caught too.
  assert.match(bad(ok, { existingNames: ['x'] })[0], /already have an asset type called "X"/);
  assert.match(bad({ ...ok, name: 'Co-Branded — Ad' }, { existingNames: ['Co-Branded - Ad'] })[0], /already have/);
  assert.match(bad({ ...ok, fields: [{ field_name: 'Headline' }, { field_name: 'headline' }] })[0],
    /Field 2: "headline" duplicates "Headline"/);

  // Limits: non-integers rejected rather than coerced, min above max caught.
  assert.match(bad({ ...ok, fields: [{ field_name: 'H', char_max: '70abc' }] })[0], /whole number/);
  assert.match(bad({ ...ok, fields: [{ field_name: 'H', char_max: 1.5 }] })[0], /whole number/);
  assert.match(bad({ ...ok, fields: [{ field_name: 'H', char_max: 200001 }] })[0], /whole number/);
  assert.match(bad({ ...ok, fields: [{ field_name: 'H', char_min: 90, char_max: 40 }] })[0], /is above the limit/);
  // The unit is the two rowToSpecGroup understands; a third would be silently
  // rewritten to 'text' by the pipeline.
  assert.match(bad({ ...ok, fields: [{ field_name: 'H', field_type: 'sentences' }] })[0], /"text" or "words"/);

  // Caps, both directions.
  const many = Array.from({ length: MAX_FIELDS_PER_ASSET + 1 }, (_, i) => ({ field_name: `F${i}` }));
  assert.match(bad({ ...ok, fields: many })[0], new RegExp(`at most ${MAX_FIELDS_PER_ASSET} fields`));
  assert.match(bad(ok, { existingAssetCount: MAX_ASSETS_PER_TENANT })[0],
    new RegExp(`limit ${MAX_ASSETS_PER_TENANT}`));

  // Garbage in the body positions is an error, never a throw.
  for (const junk of [null, undefined, 'a string', 42, []]) {
    assert.ok(normalizeNewAsset(junk).errors.length > 0, `${JSON.stringify(junk)} is rejected, not thrown on`);
  }
  assert.ok(bad({ name: 'X', fields: 'not an array' }).length > 0);
});

test('no limit is a real state, and survives the doc round trip', () => {
  const { normalizeNewAsset } = require('../src/utils/assetInput');
  const { asset } = normalizeNewAsset({ name: 'X', fields: [{ field_name: 'Legal Line' }] });
  assert.strictEqual(asset.fields[0].char_max, 0);
  assert.strictEqual(asset.fields[0].char_min, 0);

  // 0 is what the rest of the system already means by "no limit": fieldLabel
  // emits no bracket, and parseDoc reads a bracket-less label straight back.
  const { fieldLabel } = require('../src/destinations/googleDocs');
  const label = fieldLabel({ fieldName: 'Legal Line', charMin: 0, charMax: 0 });
  assert.strictEqual(label, 'Legal Line');
  assert.ok(!label.includes('['), 'no empty bracket in the doc');
});

test('the create route takes its tenant from the session and nothing from the body', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'settings.js'), 'utf8');
  const route = src.slice(src.indexOf("'/api/settings/library/asset'"), src.indexOf('GET /api/settings/workspace'));
  assert.match(route, /settingsWriteLimiter, requireAuth/, 'rate-limited and auth-gated');
  assert.match(route, /req\.user && req\.user\.tenant_id/, 'tenant comes from the session');
  // req.body appears exactly once, as the argument to the allowlist — never as a
  // tenant, an id, or a column.
  assert.strictEqual((route.match(/req\.body/g) || []).length, 1);
  assert.match(route, /normalizeNewAsset\(req\.body/);
  assert.ok(!/req\.query|req\.params/.test(route), 'no tenant from the query string either');
  // The duplicate check runs against the CALLER's library, so a name can only
  // collide with their own assets.
  assert.match(route, /existingNames: existing\.map/);
  // The unique index stays the authority; its error becomes the same sentence.
  assert.match(route, /err\.code === '23505'/);
  assert.match(route, /status\(409\)/);
  // Nothing else in the router writes an asset type.
  assert.strictEqual((src.match(/createAssetType\(/g) || []).length, 1);
});

test('the create form survives a dozen-plus fields on a phone', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');

  // The paste box is the primary input — typing four controls a row, fourteen
  // times, on a phone is the thing that makes a form like this unusable.
  const createJs = html.slice(html.indexOf('--- Create an asset type'), html.indexOf('async function libEnsureLoaded'));
  assert.match(createJs, /LIB_LINE_RE/, 'a bracket-syntax paste box exists');
  // Rows appear AS THE BOX CHANGES. There is no "add these fields" step: a paste
  // that produces nothing until you find and press a button looks broken.
  assert.match(createJs, /paste\.addEventListener\('input'/);
  assert.match(createJs, /setTimeout\(syncFromPaste, 200\)/, 'debounced, so one paste rebuilds once');
  assert.ok(!/Add these fields/.test(html), 'the parse button is gone');
  // …and pressing Create flushes a sync still sitting in the debounce, so a
  // paste followed immediately by Create sends what is on screen.
  const save = createJs.slice(createJs.indexOf('save.addEventListener'));
  assert.match(save, /if \(syncTimer\) \{ clearTimeout\(syncTimer\); syncTimer = null; syncFromPaste\(\); \}/);

  // The paste box opens at eight lines and grows with its content, rather than
  // offering four lines for a feature whose point is a dozen-plus fields.
  assert.match(html, /\.lib-paste \{ min-height: 172px/);
  assert.match(createJs, /libAutoGrow\(paste\)/);
  assert.match(createJs, /ta\.style\.height = ta\.scrollHeight \+ 'px'/);

  // Zero rows on open. Either the paste or "+ Add a field" makes the first one —
  // an empty row on open is a chore presented as a starting point.
  const open = createJs.slice(createJs.indexOf('function libOpenNew'));
  assert.ok(!/addRows\(\[\{\}\]\)/.test(open.slice(0, open.indexOf('oneMore.addEventListener'))),
    'nothing seeds a row before the user acts');
  assert.match(open, /oneMore\.addEventListener\('click', function \(\) \{ addRows\(\[\{\}\]\); \}\)/);

  // The row is STACKED: a single grid line put the field name in the narrowest
  // column, where at 390px it showed nine characters — "Section 1 Headline" and
  // "Section 1 Body" rendered identically. The name now owns the first line.
  assert.match(html, /\.lib-fname \{ flex: 1; min-width: 0/);
  assert.ok(!/\.lib-frow \{ display: grid/.test(html), 'the row is no longer a five-column grid');
  assert.match(createJs, /name\.className = 'lib-fname'/);
  assert.match(createJs, /var ctl = el\('div', 'lib-fctl'\)/, 'the small values share the line below');

  // Thumb targets, and a unit control that reads as a control. "chars" with
  // appearance:none and no arrow was a label sitting beside two numbers.
  assert.match(html, /\.lib-fdel \{ flex: none;[^}]*min-height: 36px; min-width: 36px/);
  assert.match(html, /\.lib-funit::after \{ content: '▾'/);
  assert.match(html, /\.lib-funit select \{ width: 86px; min-height: 36px/);
  assert.match(createJs, /var unitWrap = el\('span', 'lib-funit'\)/);

  // The writing note is the only guidance a custom field gets, so it is a
  // full-width invitation with a stated reason above the rows — not a small
  // underlined word beside an X.
  assert.match(html, /\.lib-fnotebtn \{ display: block; width: 100%;[^}]*min-height: 38px/);
  assert.match(createJs, /'\+ Add a writing note'/);
  assert.match(createJs, /'Writing note — the drafter follows this'/);
  assert.match(createJs, /lib-notewhy/, 'the reason is stated once, above the rows');
  assert.match(createJs, /setNoteOpen\(!!f\.spec_note\)/, 'a note that exists opens showing');
  assert.match(createJs, /aria-expanded/);
  assert.match(html, /\.hidden \{ display: none !important; \}/, 'the class it toggles is real');

  // Every control the user works blind is labelled for a screen reader, since
  // the column header that used to name them is gone.
  for (const label of ['Minimum', 'Limit', 'Counted in', 'Remove field']) {
    assert.ok(createJs.includes(`'${label}'`), `${label} is announced`);
  }
  // The header is replaced by a live count — with a dozen-plus rows that is the
  // thing worth showing, and it confirms the paste parsed what was expected.
  assert.match(createJs, /n === 1 \? '1 field' : n \+ ' fields'/);
});

test('re-parsing never silently discards a row the user edited', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  const createJs = html.slice(html.indexOf('--- Create an asset type'), html.indexOf('async function libEnsureLoaded'));
  const sync = createJs.slice(createJs.indexOf('var syncFromPaste'), createJs.indexOf('var syncTimer'));

  // A row records which pasted LINE made it, and whether the user has touched
  // it. Those two facts are the whole ownership rule.
  assert.match(createJs, /wrap\.srcKey = srcKey \|\| null/);
  assert.match(createJs, /wrap\.dirty = false/);
  assert.match(createJs, /if \(wrap\.dirty\) return;\s*wrap\.dirty = true/, 'first edit flips it, once');
  // Every control in the row arms it — including the note and the unit select,
  // which do not fire 'input' the way the text fields do.
  assert.match(createJs, /\[name, min, max, note\]\.forEach\(function \(e\) \{ e\.addEventListener\('input', touch\); \}\)/);
  assert.match(createJs, /unit\.addEventListener\('change', touch\)/);

  // Matching is by the line a row CAME FROM, not by its current name or its
  // position — so renaming a row, reordering the paste box, or inserting a line
  // above it all still land the edit on the right field.
  assert.match(sync, /if \(!r\.srcKey\) \{ manual\.push\(r\); return; \}/, 'hand-added rows are never the paste box\'s');
  assert.match(sync, /if \(r\.dirty && !claimed\[r\.srcKey\]\) claimed\[r\.srcKey\] = r/);
  assert.match(sync, /if \(claimed\[key\]\) \{ next\.push\(claimed\[key\]\); delete claimed\[key\]; protectedCount\+\+; return; \}/);
  // An edited row whose line is deleted is MOVED, not dropped.
  assert.match(sync, /Object\.keys\(claimed\)\.forEach\(function \(k\) \{ moved\.push\(claimed\[k\]\); \}\)/);
  assert.match(sync, /next\.concat\(moved, manual\)/);
  assert.ok(!/\.remove\(\)/.test(sync), 'the reconciler removes no row');

  // And it says what it did. A protection the user cannot see is a bug to them.
  assert.match(sync, /libSetKept\(protectedCount, moved\.length\)/);
  assert.match(createJs, /the paste box no longer overwrites (it|them)/);
  assert.match(createJs, /moved to the bottom rather than removed/);
  assert.match(html, /\.lib-frow\.dirty \{ border-left/, 'and marks the rows it is protecting');

  // The row key folds the same way the server folds names. Not asserted as a
  // string — the browser's function is lifted out and run against the real
  // utils/normalize, so the two cannot drift into disagreeing about what "the
  // same field" is. (A laxer key would merge two distinct rows; a stricter one
  // would lose an edit on a name Postgres considers unchanged.)
  const src = createJs.slice(createJs.indexOf('function libRowKey'));
  const libRowKey = new Function(src.slice(0, src.indexOf('\n    }') + 6) + '\n    return libRowKey;')();
  const { normalize } = require('../src/utils/normalize');
  for (const s of [
    'Hero Headline', 'HERO  headline', 'Co-Branded — Ad', 'Co-Branded - Ad', 'Co – Branded',
    '  Legal Line  ', 'Offer\tBody', 'A−B', 'Section 1 Body', 'section 1  body',
  ]) {
    assert.strictEqual(libRowKey(s), normalize(s), `libRowKey matches normalize for ${JSON.stringify(s)}`);
  }
});
