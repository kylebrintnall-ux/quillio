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
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/i.test(html), 'no external fonts');
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
    '/app',
  ]);
});

test('routes/app does NOT import the Slack messaging layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  assert.ok(!/services\/slack/.test(src), 'app.js must not import services/slack');
});

// --- Week 9: web app frontend ---

test('public/app.html exists with the three screens and no external assets', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  // The three single-page screens are all present.
  for (const id of ['screen-brief', 'screen-progress', 'screen-output']) {
    assert.ok(html.includes(id), `app.html should contain #${id}`);
  }
  // It talks to the Week 8 API.
  assert.ok(html.includes('/api/brief'), 'app.html posts to /api/brief');
  assert.ok(html.includes('/api/draft'), 'app.html posts to /api/draft');
  // System fonts / no frameworks: no external fonts, CDNs, or <img>/<script src>.
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/i.test(html), 'no Google Fonts');
  assert.ok(!/<script\s+[^>]*src=/i.test(html), 'no external scripts');
  assert.ok(!/<img\b/i.test(html), 'no images');
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
