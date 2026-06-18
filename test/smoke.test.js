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
