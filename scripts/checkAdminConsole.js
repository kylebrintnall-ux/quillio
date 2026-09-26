'use strict';

// ADMIN CONSOLE CHECK — READ-ONLY. Renders the REAL public/admin.html against a
// stubbed admin API, in a real browser, and reports what a device pass reports:
// script errors, horizontal overflow, what each status tile DECIDED, whether the
// per-row actions answer where the reader is looking, and the text contrast of
// every small-text rule the page declares — from pixels, through
// scripts/checkContrast.js's own ratio function.
//
// ─── WHY IT IS COMMITTED ────────────────────────────────────────────────────
// admin.html had no fixture in any tool. The command-center rebuild was checked
// from a throwaway harness in a scratchpad, and its passes found what a green
// suite could not, because none of it was a question about what the source SAYS:
//
//   - "Last run" showed a one-page check pressed a minute earlier, and hid a
//     full run that had died three hours before it.
//   - the agent tile believed a `script` run — which can be a console session in
//     any service — about the cron.
//   - "Check now" reported its result at the top of the page, thousands of
//     pixels above the row that was tapped; and at desktop width it wrapped
//     onto two lines.
//   - two-up tiles at 390px: 330px boxes holding two lines beside eight-line ones.
//   - the watched-pages table ran to about 6,000px at 390px, then 4,179px after
//     the first fix, and is 2,744px now.
//
// And THIS version found one more on its first full run: the run-row hover fill
// took the amber "agent off" to 4.41:1 (see the pointer note in main()).
//
// Left in a scratchpad, every number behind those would be an assertion by
// CLAUDE.md's own rule. Here they can be re-derived.
//
// ─── THE STUB IS A RIG, AND IT AGES LIKE ONE ────────────────────────────────
// Four scenarios, each a complete set of API responses: `trouble` (a full run
// that died, a missed slot, the agent off, an erroring row, a stuck row, an
// unanchored row, a flag carrying an ungrounded proposal), `healthy`, `busy`
// (twenty single-page checks crowding the history list — the case that hid the
// full run) and `unmigrated` (no run log). A rig that omits a field the page
// reads makes the page do nothing and report success — CLAUDE.md's docSim
// entry — so test/smoke.test.js compares every fixture's KEYS with what the real
// code produces: the SQL column lists, and the objects getDetectionHealth,
// getFlagForReview and readSpecProposal build. A key added to a real response
// fails that test until it is added here. The schedule is not restated at all:
// it is computed by src/utils/cronSchedule, the code the real endpoint uses.
//
// ─── WHAT IT DOES NOT COVER ─────────────────────────────────────────────────
// Only what the four scenarios render. The approve PREVIEW and COMMIT steps need
// endpoints this does not stub, so their rules are reported as unmeasured, not
// passed. A pseudo-element is not an element and cannot be screenshotted (the
// phone table's `::before` labels) — reported too. And as with every tool here
// that measures one property: green contrast says nothing about rhythm,
// repetition or hierarchy. Those are still the device.
//
//   npm i --no-save playwright-core
//   node scripts/checkAdminConsole.js                    # every scenario, 390 + 1280
//   node scripts/checkAdminConsole.js --all              # list what it did NOT measure
//   node scripts/checkAdminConsole.js --shots=<dir>      # also save screenshots
//   node scripts/checkAdminConsole.js --font-cache=<dir> # fetch Google Fonts with curl
//
// --font-cache is for a sandbox whose proxy the browser cannot use and curl can.
// The page's font comes from Google Fonts; without it every height and ratio is
// for a FALLBACK face. So the run checks which face actually rendered and says
// so, rather than reporting fallback numbers as the page's.
//
// Writes nothing unless --shots or --font-cache names a directory. Exits 1 on a
// script error, an unexpected failed request, horizontal overflow, a tile or
// interaction check failing, or any measured text below its floor.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const cronSchedule = require('../src/utils/cronSchedule');

const TAG = '[admin-check]';
const ROOT = path.join(__dirname, '..');
const ARG = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const CRON = '0 15 * * 1';
const MIN = 60000;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WATCH = [
  ['LinkedIn – single image ad specs', 'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads/specs'],
  ['LinkedIn – carousel ad specs', 'https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs'],
  ['LinkedIn – conversation ads', 'https://business.linkedin.com/advertise/ads/sponsored-messaging/conversation-ads/specs'],
  ['Meta – image', 'https://www.facebook.com/business/ads-guide/update/image/facebook-feed'],
  ['Meta – carousel', 'https://www.facebook.com/business/ads-guide/update/carousel/facebook-feed'],
  ['X – creative ad specs', 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications'],
  ['Google – responsive display', 'https://support.google.com/google-ads/answer/9823397'],
  ['Google – responsive search', 'https://support.google.com/google-ads/answer/7684791'],
  ['Google – Performance Max', 'https://support.google.com/google-ads/answer/13676244'],
  ['Google – Demand Gen video', 'https://support.google.com/google-ads/answer/17091270'],
  ['Pinterest – pin specs', 'https://help.pinterest.com/en/business/article/pinterest-product-specs'],
];
const TEST_ID = 12;
const TEST_URL = 'https://quillio.example/admin/test-spec';
const LITMUS = [
  [13, 'Litmus – subject line length', 'https://www.litmus.com/blog/the-ultimate-guide-to-email-subject-lines'],
  [14, 'Litmus – preview text', 'https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support'],
];
// Rows the trouble scenario breaks, by watch id.
const ERR_ID = 6, STUCK_ID = 9, UNANCHORED_ID = 10, FLAGGED_ID = 2;

// tenantValueBreakdown's shape for two tenants that agree.
const agreeing = (value) => ({ expected: value, expected_row_count: 2, divergent_row_count: 0, divergent: [], diverged: false });

function fixtures(scenario, now = Date.now()) {
  const ago = (min) => new Date(now - min * MIN).toISOString();
  const trouble = scenario === 'trouble';

  // GET /admin/api/health — getDetectionHealth plus the route's two keys.
  const watch = WATCH.map(([display_name, source_url], i) => {
    const id = i + 1;
    return {
      id, display_name, source_url, is_test: false,
      last_checked_at: ago(trouble ? 200 : 20), baselined: true,
      last_error: trouble && id === ERR_ID ? 'anchor "post copy:" not found in the normalized page' : null,
      pending_count: trouble && id === FLAGGED_ID ? 1 : 0,
      pending_since: trouble && id === FLAGGED_ID ? ago(210) : null,
      source_kind: 'platform_enforced',
      anchored: !(trouble && id === UNANCHORED_ID),
      consecutive_failures: trouble && id === ERR_ID ? 2 : 0,
      consecutive_unconfirmed: trouble && id === STUCK_ID ? 3 : 0,
      unconfirmed_reason: trouble && id === STUCK_ID ? 'page varies per request' : null,
    };
  });
  const testFlagged = scenario === 'trouble' || scenario === 'unmigrated';
  watch.push({
    id: TEST_ID, display_name: 'Quillio test spec', source_url: TEST_URL, is_test: true,
    last_checked_at: ago(30), baselined: true, last_error: null,
    pending_count: testFlagged ? 1 : 0, pending_since: testFlagged ? ago(30) : null,
    source_kind: 'platform_enforced', anchored: true,
    consecutive_failures: 0, consecutive_unconfirmed: 0, unconfirmed_reason: null,
  });
  for (const [id, display_name, source_url] of LITMUS) {
    watch.push({
      id, display_name, source_url, is_test: false, last_checked_at: ago(40000), baselined: true,
      last_error: null, pending_count: 0, pending_since: null, source_kind: 'observed_practice',
      anchored: false, consecutive_failures: 0, consecutive_unconfirmed: 0, unconfirmed_reason: null,
    });
  }
  const health = { success: true, lastRun: ago(20), watch, unconfirmedAlertAt: 3 };

  // The stored agentic read on the real flag: one clean field, one conditional
  // limit with two candidates, one whose quote was not in the page.
  const proposalField = (field, current, suggested, snippet, tier, candidates, confidence, ambiguities, detail) => ({
    asset: 'LinkedIn Carousel Ad', field, currentCharMax: current, suggestedCharMax: suggested, snippet,
    citationTier: tier, candidates, confidence, ambiguities, ambiguityDetail: detail,
  });
  const readProposal = {
    version: 1, readAt: ago(210), pageHash: 'b'.repeat(64), budget: { max: 3, used: 0 },
    status: 'read', capped: false, model: 'gemini-flash-stub', promptVersion: 2, pageTextTruncated: false,
    fields: [
      proposalField('Card 1 Headline', '45', 45, 'Card headline: 45 characters.', 'exact', [45, 30], 'medium',
        ['multiple_candidates', 'conditional_limit'],
        { multiple_candidates: 'the page states 45, 30', conditional_limit: 'conditional wording; lead gen form' }),
      proposalField('Intro Text', '255', 255, 'Introductory text: 255 characters', 'exact', [255], 'high', [], {}),
      proposalField('Card 2 Headline', '45', 40, '', 'none', [40], 'low', ['citation_unverified'],
        { citation_unverified: 'snippet not found in the page text' }),
      proposalField('Card 3 Headline', '45', 45, 'Card headline: 45 characters.', 'exact', [45], 'high', [], {}),
    ],
  };
  const skippedProposal = {
    version: 1, readAt: ago(30), pageHash: 'd'.repeat(64), budget: { max: 3, used: 0 },
    status: 'skipped', reason: 'no_affected_fields', capped: false,
  };

  // GET /admin/api/review-queue — every status; the page filters to pending.
  const queueRows = testFlagged ? [
    { id: 41, watch_id: FLAGGED_ID, source_url: WATCH[FLAGGED_ID - 1][1], old_hash: 'a'.repeat(64), new_hash: 'b'.repeat(64),
      detected_at: ago(210), status: 'pending', is_test: false, created_at: ago(210), agent_proposal: readProposal },
    { id: 42, watch_id: TEST_ID, source_url: TEST_URL, old_hash: 'c'.repeat(64), new_hash: 'd'.repeat(64),
      detected_at: ago(30), status: 'pending', is_test: true, created_at: ago(30), agent_proposal: skippedProposal },
    { id: 16, watch_id: TEST_ID, source_url: TEST_URL, old_hash: 'e'.repeat(64), new_hash: 'f'.repeat(64),
      detected_at: ago(9000), status: 'reviewed', is_test: true, created_at: ago(9000), agent_proposal: null },
  ] : [];
  const queue = { success: true, reviewQueue: queueRows };

  // GET /admin/api/flag/:id — getFlagForReview.
  const flags = {};
  for (const q of queueRows) {
    const w = watch.find((x) => x.id === q.watch_id);
    const pairs = q.agent_proposal && q.agent_proposal.fields ? q.agent_proposal.fields : [];
    flags[q.id] = {
      success: true,
      flag: {
        id: q.id, watch_id: q.watch_id, display_name: w ? w.display_name : null, source_url: q.source_url,
        is_test: q.is_test, status: q.status, detected_at: q.detected_at, new_hash: q.new_hash,
        fields: pairs.map((p) => ({
          asset: p.asset, field: p.field, tenant_count: 2,
          current_char_max: p.currentCharMax, current_spec_note: '',
          char_max_divergence: agreeing(p.currentCharMax), spec_note_divergence: agreeing(''),
        })),
        agent_proposal: q.agent_proposal,
      },
    };
  }

  const runs = runsOverview(scenario, now);
  return { health, queue, flags, runs };
}

// A run's summary and results, in runDetection's own shapes. A full run covers
// every row, the test row and the two observed-practice rows included, exactly
// as the real one does.
function runReport(reader, { changed = 0, failed = 0, scopedTo = null } = {}) {
  const rows = scopedTo ? [scopedTo] : [
    ...WATCH.map(([display_name, source_url], i) => ({ id: i + 1, display_name, source_url })),
    { id: TEST_ID, display_name: 'Quillio test spec', source_url: TEST_URL },
    ...LITMUS.map(([id, display_name, source_url]) => ({ id, display_name, source_url, observed: true })),
  ];
  const results = rows.map((w) => ({
    watch_id: w.id, display_name: w.display_name, source_url: w.source_url, is_test: w.id === TEST_ID,
    status: w.observed ? 'not_watched' : changed && w.id === FLAGGED_ID ? 'changed' : failed && w.id === ERR_ID ? 'failed' : 'unchanged',
    last_checked_at: null, error: failed && w.id === ERR_ID ? 'anchor "post copy:" not found' : null,
    anchored: !w.observed, consecutive_failures: w.observed ? null : 0, consecutive_unconfirmed: w.observed ? null : 0,
    unconfirmed_reason: null, source_kind: w.observed ? 'observed_practice' : 'platform_enforced',
    agent: changed && w.id === FLAGGED_ID ? { status: reader === 'on' ? 'read' : 'skipped', reason: null, fields: 4, proposed: 4, flagged: 2 } : null,
  }));
  const n = (s) => results.filter((r) => r.status === s).length;
  const summary = {
    total: results.length, baseline: 0, unchanged: n('unchanged'), changed: n('changed'),
    unconfirmed: 0, failed: n('failed'), error: 0, unanchored: 0, stuck: 0, not_watched: n('not_watched'),
    reader, agent_read: changed && reader === 'on' ? 1 : 0, agent_skipped: changed && reader !== 'on' ? 1 : 0, agent_failed: 0,
  };
  return { summary, results };
}

// GET /admin/api/runs — getRunsOverview. The list is the newest 20; `latest` is
// read from the whole log, as getLatestRuns reads it; the schedule is computed
// by the same cronSchedule functions the real endpoint calls.
function runsOverview(scenario, now) {
  const at = (ms) => new Date(ms).toISOString();
  const nowD = new Date(now);
  const slot = cronSchedule.lastSlotAtOrBefore(CRON, nowD);
  const schedule = (lastSlot) => ({
    cron: CRON, parsed: true, source: 'railway.cron.json',
    nextAt: cronSchedule.nextSlotAfter(CRON, nowD), lastSlot,
  });
  if (scenario === 'unmigrated') {
    return { success: true, available: false, reason: 'not-migrated', runs: [], latest: null,
      schedule: schedule({ at: slot, ...cronSchedule.assessSlot({ slot, runsInWindow: [], logStartedAt: null, now: nowD }) }) };
  }
  const row = (id, startMinAgo, durSec, trigger, watchId, reader, report) => ({
    id, started_at: at(now - startMinAgo * MIN),
    finished_at: durSec == null ? null : at(now - startMinAgo * MIN + durSec * 1000),
    trigger, watch_id: watchId, reader,
    summary: report ? report.summary : null, results: report ? report.results : null,
  });
  // Minutes ago for the moment `offsetMin` after the last slot (negative = before).
  const slotMinAgo = (offsetMin) => (now - slot.getTime()) / MIN - offsetMin;
  const testRow = { id: TEST_ID, display_name: 'Quillio test spec', source_url: TEST_URL };
  let all;
  if (scenario === 'trouble') {
    all = [
      row(31, 20, 5, 'admin', TEST_ID, 'on', runReport('on', { scopedTo: testRow })),
      row(30, 200, null, 'script', null, 'off', null), // opened, never closed
      row(29, 215, 180, 'admin', null, 'on', runReport('on', { changed: 1, failed: 1 })),
      row(28, slotMinAgo(-7 * 24 * 60 + 3), 60, 'script', null, 'off', runReport('off')), // the slot before
    ];
  } else {
    all = [
      row(23, 20, 60, 'admin', null, 'on', runReport('on')),
      row(22, slotMinAgo(2), 60, 'scheduled', null, 'on', runReport('on')),
    ];
    if (scenario === 'busy') {
      for (let i = 0; i < 25; i++) all.push(row(200 + i, 10 - i * 0.3, 3, 'admin', TEST_ID, 'on', runReport('on', { scopedTo: testRow })));
    }
  }
  const sorted = all.slice().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id);
  const lean = (r) => { const { results, ...rest } = r; return rest; }; // LATEST_COLS carries no results
  const byTrigger = {};
  for (const r of sorted) if (!byTrigger[r.trigger]) byTrigger[r.trigger] = lean(r);
  const full = sorted.find((r) => r.watch_id == null);
  const early = slot.getTime() - cronSchedule.SLOT_EARLY_MS, late = slot.getTime() + cronSchedule.SLOT_LATE_MS;
  const runsInWindow = sorted.filter((r) => Date.parse(r.started_at) >= early && Date.parse(r.started_at) <= late)
    .map((r) => ({ id: r.id, started_at: new Date(r.started_at), finished_at: r.finished_at, trigger: r.trigger }));
  const logStartedAt = new Date(Math.min(...sorted.map((r) => Date.parse(r.started_at))));
  return {
    success: true, available: true, runs: sorted.slice(0, 20),
    latest: { lastFull: full ? lean(full) : null, byTrigger },
    schedule: schedule({ at: slot, ...cronSchedule.assessSlot({ slot, runsInWindow, logStartedAt, now: nowD }) }),
  };
}

// ─── The stub server ────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
  });
}

function startServer() {
  const state = { scenario: 'trouble', failCheck: false };
  const fontsDir = path.join(ROOT, 'public', 'fonts');
  const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://stub').pathname;
    const fx = fixtures(state.scenario);
    try {
      if (req.method === 'GET' && p === '/admin') {
        return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'public', 'admin.html')));
      }
      if (req.method === 'GET' && p.startsWith('/fonts/')) {
        const f = path.resolve(fontsDir, decodeURIComponent(p.slice('/fonts/'.length)));
        if (!f.startsWith(fontsDir + path.sep) || !fs.existsSync(f)) return send(res, 404, 'text/plain', 'not found');
        return send(res, 200, f.endsWith('.otf') ? 'font/otf' : 'application/octet-stream', fs.readFileSync(f));
      }
      if (req.method === 'GET' && p === '/admin/api/health') return json(res, 200, fx.health);
      if (req.method === 'GET' && p === '/admin/api/review-queue') return json(res, 200, fx.queue);
      if (req.method === 'GET' && p === '/admin/api/runs') return json(res, 200, fx.runs);
      const flag = p.match(/^\/admin\/api\/flag\/(\d+)$/);
      if (req.method === 'GET' && flag) {
        return fx.flags[flag[1]] ? json(res, 200, fx.flags[flag[1]]) : json(res, 404, { success: false, error: 'flag not found' });
      }
      if (req.method === 'GET' && p === '/admin/test-spec') {
        return send(res, 200, 'text/html; charset=utf-8',
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quillio Test Spec</title></head>' +
          '<body><pre>Quillio Test Spec\nTest headline: 50 characters.</pre></body></html>');
      }
      if (req.method === 'POST' && p === '/admin/api/test-spec') {
        const body = await readBody(req);
        return json(res, 200, { success: true, content: body.content || '' });
      }
      if (req.method === 'POST' && p === '/admin/api/run-detection') {
        const body = await readBody(req);
        if (state.failCheck) return json(res, 500, { success: false, error: 'Detection run failed' });
        const w = body.watchId != null ? fx.health.watch.find((x) => String(x.id) === String(body.watchId)) : null;
        const report = runReport('on', w ? { scopedTo: w } : {});
        return json(res, 200, { success: true, ran: true, runId: 99, ...report });
      }
      return json(res, 404, { success: false, error: 'not stubbed: ' + req.method + ' ' + p });
    } catch (err) {
      return json(res, 500, { success: false, error: 'stub failed: ' + err.message });
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

// ─── Fonts ──────────────────────────────────────────────────────────────────

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Google Fonts through curl, cached by URL. The CSS is requested with a desktop
// Chrome user agent so Google returns the woff2 subsets a browser would get.
function fontRoute(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return async (route) => {
    const url = route.request().url();
    const f = path.join(dir, crypto.createHash('sha1').update(url).digest('hex').slice(0, 20));
    try {
      if (!fs.existsSync(f)) execFileSync('curl', ['-sfL', '-m', '30', '-A', CHROME_UA, '-o', f, url]);
      const css = /fonts\.googleapis\.com/.test(url);
      await route.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body: fs.readFileSync(f),
        headers: { 'access-control-allow-origin': '*' } });
    } catch (_) {
      await route.abort();
    }
  };
}

// ─── The pass ───────────────────────────────────────────────────────────────

const SCENARIOS = ['trouble', 'healthy', 'busy', 'unmigrated'];
const VIEWPORTS = [
  // 390x844 at 3x is checkContrast's measurement setting, kept so ratios compare.
  { label: '390', width: 390, height: 844, deviceScaleFactor: 3 },
  // 2x at desktop width: it measures only what 390px never renders (the table
  // header), and 3x full-page shots at this width run to hundreds of megabytes.
  { label: '1280', width: 1280, height: 900, deviceScaleFactor: 2 },
];

// What each scenario must show. These are the decisions the defects above got
// wrong, asserted on the rendered page rather than on the function.
const EXPECT = {
  trouble: (t) => [
    [t['Last full run'] && t['Last full run'].v === 'Did not finish' && t['Last full run'].tone === 'bad', 'the full run that died is named on the Last full run tile'],
    [t['Next check'] && /Missed/.test(t['Next check'].text) && t['Next check'].tone === 'bad', 'the missed slot is called missed'],
    [t['Agent, scheduled run'] && t['Agent, scheduled run'].v === 'Off' && t['Agent, scheduled run'].tone === 'bad', 'the agent tile reports the cron OFF, not the admin runs\' ON'],
    [t['Watched pages'] && t['Watched pages'].links === 3, 'the Watched pages tile links each problem row'],
  ],
  healthy: (t) => [[Object.values(t).every((x) => x.tone === null), 'a healthy console marks nothing']],
  busy: (t) => [
    [t['Last full run'] && t['Last full run'].v !== 'None yet', 'twenty single-page checks do not hide the last full run'],
    [t['Agent, scheduled run'] && t['Agent, scheduled run'].v === 'On' && t['Agent, scheduled run'].tone === null, 'nor the scheduled run the agent tile reads'],
  ],
  unmigrated: (t) => [
    [!!t['Last page check'], 'with no run log the number is titled as a page check, not a run'],
    [t['Agent, scheduled run'] && t['Agent, scheduled run'].v === 'Unknown', 'and the agent state is unknown, not off'],
  ],
};

async function tilesOf(page) {
  const list = await page.$$eval('#tiles .tile', (ts) => ts.map((t) => ({
    k: t.querySelector('.k').textContent,
    v: t.querySelector('.v').textContent,
    tone: t.classList.contains('is-bad') ? 'bad' : t.classList.contains('is-warn') ? 'warn' : null,
    text: [...t.querySelectorAll('.s')].map((s) => s.textContent).join(' / '),
    links: t.querySelectorAll('a[href^="#watch-"]').length,
  })));
  const byKey = {};
  for (const t of list) byKey[t.k] = t;
  return { list, byKey };
}

// THE POPULATION IS EVERY RULE THAT DECLARES A COLOUR — wider than
// checkContrast's (a small font-size AND a colour). The first run of this used
// that narrower one and reported a clean page while leaving out the words that
// carry this page's alarms: .flag-bad, .flag-warn and button.warn declare only a
// colour and take their size from context, and they were the lowest ratios on
// the page. Each element is judged at its own computed size, so large text gets
// the large-text floor. @media blocks are flattened first — a rule inside one is
// still a rule the page renders.
function colorSelectors(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  const out = new Set();
  for (const m of flat.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@') || !/(?:^|;|\s)color:\s*[^;]+/.test(m[2])) continue;
    for (const one of sel.split(',')) {
      const x = one.trim();
      if (x && !/^(html|body|:root)$/.test(x)) out.add(x);
    }
  }
  return [...out];
}

// The worst-measuring visible instance of each selector that carries text. A
// container's number is its MOST contrasting ink, so it can overstate the
// dimmest text inside it — which is why the child rules are measured too.
//
// `scope` confines the query to one container. The review overlay needs it: the
// page behind it is still in the DOM, dimmed by the overlay's own backdrop, and
// measured through that it would report failures nobody can see.
async function measure(page, selectors, into, where, contrast, scope = null) {
  for (const sel of selectors) {
    const q = scope && !sel.startsWith(scope) ? `${scope} ${sel}` : sel;
    let handles;
    try { handles = await page.$$(q); } catch (_) { continue; } // a pseudo-element selector throws
    let taken = 0;
    for (const h of handles) {
      if (taken >= 6) break;
      const state = await h.evaluate((n) => {
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        // A field's text is its value, not its textContent. (Its placeholder is
        // a pseudo-element and stays unmeasured, so an empty field is skipped
        // rather than measured as though the placeholder were its text.)
        const text = n.matches('input, textarea') ? n.value : n.textContent;
        if (!(r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && String(text || '').trim().length > 0 && !!n.offsetParent)) return 'hidden';
        // WCAG 1.4.3 exempts an inactive control, and this page dims one on
        // purpose (the step-1 "Next" button waits for a checked field).
        return n.matches(':disabled') || !!n.closest(':disabled') ? 'disabled' : 'ok';
      }).catch(() => 'hidden');
      if (state === 'disabled') { into.exempt = (into.exempt || new Set()).add(sel); continue; }
      if (state !== 'ok' || !(await h.isVisible())) continue;
      let b64;
      try {
        b64 = (await h.screenshot({ timeout: 3000 })).toString('base64');
      } catch (err) {
        // Reported, never dropped: an element that could not be measured is a gap
        // in the coverage, and a gap nobody is told about reads as a pass.
        into.skipped = into.skipped || new Map();
        into.skipped.set(sel, `${where}: ${String(err.message).split('\n')[0]}`);
        continue;
      }
      taken += 1;
      const ratio = await page.evaluate(contrast.RATIO_FN, b64);
      const { px, weight, sample } = await h.evaluate((n) => {
        const cs = getComputedStyle(n);
        const text = n.matches('input, textarea') ? n.value : n.textContent;
        return { px: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), sample: String(text).trim().replace(/\s+/g, ' ').slice(0, 48) };
      });
      const floor = contrast.floorFor(px, weight >= 700);
      const prev = into.get(sel);
      if (!prev || ratio - floor < prev.ratio - prev.floor) into.set(sel, { ratio, floor, px, where, sample });
    }
  }
}

async function main() {
  const contrast = require('./checkContrast');
  const pw = contrast.loadBrowser(TAG, 'scripts/checkAdminConsole.js');
  const shots = ARG('shots', null);
  const fontCache = ARG('font-cache', null);
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const css = contrast.styleBlocks('public/admin.html');
  const population = colorSelectors(css);
  // Rules whose colour or size is inherited, and so are not in the population
  // above, but whose text the defects in the header lived in.
  const EXTRA = ['.check-result', '.tile .s a', '#runMsg', '.agent-line', '#panel a'];
  const selectors = [...new Set(population.concat(EXTRA))];

  const { server, state, base } = await startServer();
  const browser = await pw.chromium.launch({ executablePath: contrast.chromePath() });
  const failures = [];
  const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
  const check = (cond, msg) => { if (!cond) fail(msg); };
  const worst = new Map();
  let fontWarned = false;

  for (const scenario of SCENARIOS) {
    for (const vp of VIEWPORTS) {
      state.scenario = scenario;
      state.failCheck = false;
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor });
      if (fontCache) await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, fontRoute(fontCache));
      const errors = [];
      let expected500 = 0;
      page.on('pageerror', (e) => errors.push('script error: ' + e.message));
      page.on('response', (r) => {
        const u = new URL(r.url());
        if (r.status() < 400 || u.pathname === '/favicon.ico') return;
        if (r.status() === 500 && u.pathname === '/admin/api/run-detection' && expected500 > 0) { expected500 -= 1; return; }
        errors.push(`HTTP ${r.status()} ${u.pathname}`);
      });
      await page.goto(base + '/admin', { waitUntil: 'networkidle' });
      await page.waitForSelector('#tiles .tile');
      await page.evaluate(async () => { await document.fonts.ready; return true; });

      const face = await page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Zen Kaku Gothic New' && f.status === 'loaded'));
      if (!face && !fontWarned) {
        fontWarned = true;
        console.log(`${TAG} WARNING: Zen Kaku Gothic New did not load — heights and ratios below are for a FALLBACK face.`);
        console.log(`${TAG}          If Google Fonts is unreachable from the browser here, pass --font-cache=<dir>.`);
      }

      const geo = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      const { list, byKey } = await tilesOf(page);
      console.log(`\n${TAG} ${scenario} @ ${vp.label}px — page ${geo.h}px`);
      for (const t of list) console.log(`    ${(t.tone ? '[' + t.tone.toUpperCase() + '] ' : '').padEnd(7)}${t.k}: ${t.v}`);
      check(geo.sw <= geo.cw, `${scenario} @ ${vp.label}: horizontal overflow (${geo.sw} > ${geo.cw})`);
      for (const [ok, what] of EXPECT[scenario](byKey)) check(ok, `${scenario} @ ${vp.label}: ${what}`);
      if (scenario === 'busy') {
        const hist = await page.$$eval('#runsList .run', (rs) => rs.length);
        check(hist === 20, `busy @ ${vp.label}: the history list shows 20 rows (got ${hist})`);
      }
      if (shots) await page.screenshot({ path: path.join(shots, `${scenario}-${vp.label}.png`), fullPage: true });

      if (vp.label === '390' && scenario === 'trouble') {
        // A tile's row link lands on the row.
        const link = await page.$('#tiles a[href^="#watch-"]');
        const href = link && await link.getAttribute('href');
        if (link) await link.click();
        await page.waitForTimeout(300);
        const landed = href && await page.evaluate((h) => { const r = document.querySelector(h).getBoundingClientRect(); return location.hash === h && r.top >= 0 && r.top < innerHeight; }, href);
        check(landed, 'a Watched pages link scrolls to the row it names');

        // "Check now" answers in the row, and the page does not move under it.
        const rowSel = `#watch-${WATCH.length}`;
        await page.$eval(rowSel, (n) => n.scrollIntoView({ block: 'center' }));
        const before = await page.evaluate((s) => ({ y: scrollY, top: document.querySelector(s).getBoundingClientRect().top }), rowSel);
        await page.click(`${rowSel} button.small`);
        await page.waitForSelector(`${rowSel} .check-result`);
        const after = await page.evaluate((s) => ({ y: scrollY, top: document.querySelector(s).getBoundingClientRect().top, note: document.querySelector(s + ' .check-result').textContent }), rowSel);
        check(Math.abs(after.y - before.y) <= 2 && Math.abs(after.top - before.top) <= 2, `Check now keeps the row where it was (moved ${Math.round(after.top - before.top)}px)`);
        check(/^Checked .+: unchanged\.$/.test(after.note), `Check now reports in the row (got ${JSON.stringify(after.note)})`);

        // A failed check says so, in its own row, and the previous note goes.
        state.failCheck = true;
        expected500 = 2;
        const failSel = `#watch-${WATCH.length - 1}`;
        await page.click(`${failSel} button.small`);
        await page.waitForSelector(`${failSel} .check-result`);
        const failed = await page.$eval(`${failSel} .check-result`, (n) => ({ t: n.textContent, bad: n.classList.contains('flag-bad') }));
        check(failed.bad && /^Check failed/.test(failed.t), 'a failed check is reported as failed, in its row');
        check(!(await page.$(`${rowSel} .check-result`)), 'and the earlier row\'s note is cleared');

        // "Save and check" does not claim a check that failed.
        await page.click('text=Save and check');
        await page.waitForFunction(() => /check failed|checked:/i.test(document.querySelector('#testTools .actions .note').textContent));
        const said = await page.$eval('#testTools .actions .note', (n) => n.textContent);
        check(/check failed/i.test(said), `Save and check reports the failure (got ${JSON.stringify(said)})`);
        state.failCheck = false;

        // Measured AFTER the actions, so the notes they write have text to measure.
        // THE POINTER IS PAGE STATE: the last click leaves it over whatever was
        // there, and a :hover rule under it changes the ground a ratio is taken
        // against. It is parked in the right-hand gutter, which holds nothing at
        // any scroll position, so a number cannot depend on where a click landed.
        // (That is how the run-row hover fill was found: by accident, first.)
        await page.mouse.move(vp.width - 2, Math.round(vp.height / 2));
        await measure(page, selectors, worst, `${scenario}`, contrast);

        // The review overlay, step 1.
        await page.evaluate(() => scrollTo(0, 0));
        await page.click('text=Review change…');
        await page.waitForSelector('#panel h1');
        await page.mouse.move(vp.width - 2, Math.round(vp.height / 2));
        await measure(page, selectors, worst, 'review overlay', contrast, '#panel');
        if (shots) await page.screenshot({ path: path.join(shots, 'trouble-390-review.png') });
        await page.evaluate(() => closeOverlay()); // eslint-disable-line no-undef
      } else if (vp.label === '390') {
        await page.mouse.move(vp.width - 2, Math.round(vp.height / 2));
        await measure(page, selectors, worst, scenario, contrast);
      } else {
        // Only what no 390px pass rendered — the desktop table's header row.
        await page.mouse.move(vp.width - 2, Math.round(vp.height / 2));
        await measure(page, selectors.filter((x) => !worst.has(x)), worst, `${scenario} @1280`, contrast);
      }

      for (const e of errors) fail(`${scenario} @ ${vp.label}: ${e}`);
      await page.close();
    }
  }

  await browser.close();
  server.close();

  // ─── Contrast report ───
  console.log(`\n${TAG} contrast at 390px (and at 1280px for what 390px never renders), worst instance per rule (floor 4.5, or 3 for large text)`);
  const rows = [...worst.entries()].sort((a, b) => (a[1].ratio - a[1].floor) - (b[1].ratio - b[1].floor));
  for (const [sel, m] of rows) {
    const below = m.ratio < m.floor;
    if (below) fail(`contrast: ${sel} ${m.ratio.toFixed(2)}:1 < ${m.floor} (${m.where})`);
    console.log(`    ${below ? 'BELOW' : 'ok   '} ${m.ratio.toFixed(2).padStart(6)}:1  ${String(m.px).padStart(4)}px  ${sel}  [${m.where}: "${m.sample}"]`);
  }
  for (const sel of worst.exempt || []) {
    if (!worst.has(sel)) console.log(`    EXEMPT ${sel}  — only rendered disabled here; WCAG 1.4.3 exempts an inactive control`);
  }
  for (const [sel, why] of worst.skipped || []) {
    console.log(`    SKIP  ${sel}  — could not screenshot (${why})`);
  }
  const measured = population.filter((s) => worst.has(s));
  const unmeasured = population.filter((s) => !worst.has(s));
  console.log(`\n${TAG} measured ${measured.length} of ${population.length} colour-declaring rules in admin.html; ${unmeasured.length} not rendered by any scenario, or not an element (a pseudo-class or pseudo-element).`);
  if (process.argv.includes('--all')) for (const s of unmeasured) console.log(`    unmeasured  ${s}`);
  else if (unmeasured.length) console.log(`${TAG} pass --all to list them.`);
  if (fontWarned) console.log(`${TAG} every number above is for a FALLBACK face — see the warning at the top.`);

  console.log(`\n${TAG} ${failures.length ? `${failures.length} check(s) FAILED` : 'every check passed; every measured element meets its floor'}`);
  process.exitCode = failures.length ? 1 : 0;
}

module.exports = { fixtures, startServer };

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.stack || err.message}`);
    process.exit(1);
  });
}
