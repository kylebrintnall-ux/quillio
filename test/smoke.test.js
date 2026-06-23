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
  assert.strictEqual(typeof require('../src/services/sheets').getAssetSpecs, 'function');
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
  const { normalize } = require('../src/services/sheets');
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
  assert.deepStrictEqual(paths, ['/oauth/slack', '/oauth/slack/callback', '/welcome']);
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
  assert.deepStrictEqual(paths, ['/api/brief', '/api/draft', '/app']);
});

test('routes/app does NOT import the Slack messaging layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  assert.ok(!/services\/slack/.test(src), 'app.js must not import services/slack');
});
