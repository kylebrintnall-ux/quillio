'use strict';

// CONTRAST CHECK — READ-ONLY. Measures rendered text against the surface it
// actually lands on, and reports the WCAG ratio.
//
// ─── WHY A SCREENSHOT AND NOT THE STYLESHEET ────────────────────────────────
// THE DECLARED ALPHA IS NOT THE RENDERED COLOUR. A `.glass-panel` is
// `backdrop-filter: blur(16px)` over a gradient sky, and some rows add their own
// near-opaque fill on top. What `rgba(26,26,46,0.5)` composites to on that stack
// cannot be read off the CSS and lands far lighter than the declaration suggests.
// Both 11px labels the project-detail pass introduced were under the 4.5:1 floor
// and neither looked wrong in the source.
//
// So the only method that sees through backdrop-filter is: screenshot the
// element, read its pixels, take the darkest 1% as the glyph colour and the 90th
// percentile as the surface behind it, and apply the WCAG formula. That is what
// this does, in the browser, via a canvas — no image library, no extra
// dependency beyond the browser itself.
//
// ─── WHY IT LIVES IN scripts/ AND NOT IN THE SUITE ──────────────────────────
// `npm test` runs with no credentials, no network and no browser, in about ten
// seconds, and that is a property worth keeping. This needs a browser. It is
// manual and read-only by design — the same shape as scripts/checkSpecHealth.js
// — so the dependency is on somebody running it.
//
// It is committed rather than kept in a scratchpad for one reason: a measurement
// nobody else can reproduce is an assertion, not a measurement. Every number this
// project has acted on visually was produced by a throwaway script, and none of
// them can be re-derived today.
//
// ─── WHAT IT MEASURES, AND THE GAP IT REPORTS RATHER THAN HIDES ─────────────
// It renders a FIXTURE — committed markup that instantiates real labels inside
// their real containers — using the page's own stylesheet, and measures every
// element in it that carries text. It does not try to guess which surface a
// selector lands on; the fixture puts it there.
//
// It then scans the stylesheet for every rule declaring a small font-size and a
// colour, and reports the ones NO fixture exercised. That list is the honest
// statement of coverage: a label nothing renders here is unmeasured, and saying
// so is the difference between this and a tool that reports a clean sweep of
// whatever it happened to look at.
//
//   node scripts/checkContrast.js                     # every fixture
//   node scripts/checkContrast.js --file=settings     # one page
//   node scripts/checkContrast.js --all               # include the uncovered list
//   node scripts/checkContrast.js --probe=.lib-sub    # alpha ladder for a selector
//   node scripts/checkContrast.js --color=.lib-tier.enforced=#6b3a00   # a candidate
//
// Needs a browser, which is NOT a project dependency:
//   npm i --no-save playwright-core     (or set PW=/path/to/playwright-core)
//
// Exits 1 when anything measured is below its floor.

const fs = require('fs');
const path = require('path');

const TAG = '[contrast]';
const ROOT = path.join(__dirname, '..');
const ARG = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const SHOW_UNCOVERED = process.argv.includes('--all');

// WCAG 2.1 §1.4.3. Large text is 18pt (24px), or 14pt (18.66px) bold; everything
// else needs 4.5:1. Every label this was built for is 9–14px, so the floor is
// 4.5 in practice — the branch is here so a heading measured incidentally is not
// reported as failing a rule it does not have to meet.
const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;
function floorFor(px, bold) {
  const large = px >= 24 || (bold && px >= 18.66);
  return large ? AA_LARGE : AA_NORMAL;
}

// The pages that have a fixture. A page with none is not measured and is not
// silently reported as clean.
const PAGES = [
  { name: 'settings', html: 'public/settings.html', fixture: 'scripts/fixtures/contrast/settings.html' },
  // THE DARK PAGE. app.html renders cream on the sky gradient — every panel on
  // the brief screen is `background: transparent` with a cream border — so the
  // ratio runs the OPPOSITE way to settings.html and none of the alpha numbers
  // recorded for that page transfer. Covers the Spec Check panel; the rest of
  // app.html is still unmeasured and the coverage line says so.
  { name: 'app', html: 'public/app.html', fixture: 'scripts/fixtures/contrast/app.html' },
];

function styleBlocks(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const blocks = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  if (!blocks.length) throw new Error(`no <style> block in ${file}`);
  return blocks.join('\n');
}

// Every rule that declares BOTH a small font-size and a colour — the population
// this tool is about. A rule declaring only one of the two inherits the other and
// cannot be classified from the stylesheet alone; those are not counted, and that
// limit is stated rather than papered over.
const SMALL_PX = 18;
function smallTextSelectors(css) {
  const out = new Map();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;
    const size = m[2].match(/font-size:\s*([0-9.]+)px/);
    const color = m[2].match(/(?:^|;|\s)color:\s*([^;]+)/);
    if (!size || !color) continue;
    const px = parseFloat(size[1]);
    if (!(px < SMALL_PX)) continue;
    for (const one of sel.split(',')) {
      const s = one.trim();
      if (s) out.set(s, { px, color: color[1].trim() });
    }
  }
  return out;
}

// The class names a selector depends on, so a fixture rendering `.lib-sub` counts
// as covering `.lib-frow .lib-sub`. Deliberately loose: over-crediting coverage
// would be the wrong direction, so the LAST class in the selector is what has to
// appear — that is the element the rule actually paints.
function targetClass(sel) {
  const parts = sel.split(/\s+|>/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const m = last.match(/\.([a-zA-Z0-9_-]+)/g);
  return m ? m[m.length - 1].slice(1) : null;
}

function loadBrowser() {
  const override = process.env.PW;
  for (const spec of [override, 'playwright-core', 'playwright',
    path.join(ROOT, 'node_modules/playwright-core')].filter(Boolean)) {
    try {
      return require(spec);
    } catch (_) { /* try the next */ }
  }
  console.error(`${TAG} needs a browser driver, which is not a project dependency.`);
  console.error(`${TAG} npm test stays browser-free on purpose — see the header.`);
  console.error(`${TAG}   npm i --no-save playwright-core`);
  console.error(`${TAG}   PW=/path/to/playwright-core node scripts/checkContrast.js`);
  process.exit(1);
  return null;
}

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  const flat = path.join(base, 'chromium');
  return fs.existsSync(flat) ? flat : undefined;
}

// Relative luminance and the WCAG ratio, from the sRGB values a screenshot gives
// us. No alpha anywhere: these are COMPOSITED pixels, which is the whole point.
const LUM = `function lum(r,g,b){const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
  return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)}`;

// The measurement itself, as a function the page evaluates on a base64 PNG of one
// element. Most pixels of a text element are BACKGROUND — antialiasing means the
// true ink is a tail — so the surface is read from the bulk and the ink from the
// tail furthest from it.
//
// ═══ IT IS POLARITY-AWARE NOW, AND IT WAS NOT ═══════════════════════════════
//
// THE BUG THIS FIXES PRODUCED A FULL TABLE OF CONFIDENT, IMPOSSIBLE NUMBERS —
// the fourth species of measurement failure in CLAUDE.md, arriving in the tool
// built to prevent the first three.
//
// The original took "darkest 1%" as the ink and the "90th percentile" as the
// surface, unconditionally. That is correct for DARK INK ON A LIGHT PANEL, which
// is every surface this script was written against. On a DARK ground with CREAM
// text the roles invert: the darkest pixels ARE the background, so it compared
// the background against itself and reported ~1.0:1 for everything. A 22px
// heading in #F5C518 gold on #2E5FD6 blue measured 1.03:1.
//
// It is not a small population. The rebrand made app.html AND settings.html
// cream-on-sky — `.lib-asset`, `.glass-card` and `.sc-panel` are all
// `background: transparent` — so BOTH pages were being measured with the wrong
// polarity, and the tool's own guard (which asked whether a container paints a
// background) was failing first and hiding it. Its last honest run predates the
// rebrand, which is why CLAUDE.md's ladder describes a page that no longer
// looks like that.
//
// CLAUDE.md anticipated half of this — it lists ~6 dark-surface rules as
// unmeasured and says "the existing fixture would measure them against the wrong
// ground". The half it did not anticipate is that the fix is not only a second
// FIXTURE: the measurement FUNCTION could not express a light-on-dark ratio at
// all.
//
// THE RULE NOW: the median is the surface (background dominates every text
// element, whichever way round it is), and its position decides which tail is
// ink. Light surfaces keep EXACTLY the old percentiles, so every number this
// tool has ever reported for a light panel is reproduced unchanged — verified by
// re-running settings.html across the change.
// eslint-disable-next-line no-new-func
const RATIO_FN = new Function('b64', `return new Promise((res) => { ${LUM}
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const ls = [];
    for (let i = 0; i < d.length; i += 4) ls.push(lum(d[i], d[i+1], d[i+2]));
    ls.sort((x, y) => x - y);
    const at = (q) => ls[Math.min(ls.length - 1, Math.max(0, Math.floor(ls.length * q)))];
    // The bulk of a text element is its surface, so the median identifies which
    // way round this element is. 0.5 relative luminance is the midpoint of the
    // WCAG scale, not of sRGB — the same scale both ends of the ratio use.
    var ink, bg;
    if (at(0.50) > 0.5) {
      // Dark ink on a light surface. The original percentiles, unchanged: the
      // 90th and not the max, so a stray highlight cannot flatter the ratio.
      ink = at(0.01); bg = at(0.90);
    } else {
      // Light ink on a dark surface — the mirror image, for the same reason.
      ink = at(0.99); bg = at(0.10);
    }
    res((Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05));
  };
  img.src = 'data:image/png;base64,' + b64;
})`);

// THE BACKDROP, TAKEN FROM THE PAGE INSTEAD OF RESTATED HERE.
//
// Every ratio is ultimately against whatever is behind the text, so a fixture
// that gets the backdrop wrong reports a surface nobody sees — the same defect
// as an inert container, one layer further back.
//
// THIS WAS WRONG AND THE ERROR WAS LARGE. The script used to hardcode a single
// `<div class="sky-bg"></div>`. Both pages actually open with THREE layers, and
// the second one carries `.clouds-wrap::before` — a texture at `mix-blend-mode:
// soft-light; opacity: .28` — which LIGHTENS the sky substantially. Measured in
// the running app against the same gradient: the sky renders rgb(99,136,222)
// where the raw stop is rgb(46,95,214). Cream against the first is 3.18:1 and
// against the second 5.15:1 — so hardcoding one layer flattered every number on
// a dark page by around 1.9x, in the direction of a pass.
//
// Read from the page's own <body> so it cannot drift again: everything before
// the nav token or <main> is the backdrop stack.
function backdropMarkup(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const body = src.slice(src.indexOf('<body>') + 6);
  const end = body.search(/__NAV:|<main\b/);
  const markup = end > 0 ? body.slice(0, end) : '';
  if (!/class="sky-bg"/.test(markup)) {
    throw new Error(`could not find the backdrop layers at the top of ${file}'s <body>`);
  }
  return markup.trim();
}

// A STATIC SERVER, because the backdrop's texture is a RELATIVE URL. Under
// setContent the page has no base URL, so /assets/images/texture.jpg silently
// 404s and the soft-light layer paints nothing — which is precisely the lighter
// -sky error above, arriving through the loader instead of through the markup.
// Serving public/ makes the fixture load exactly what the app loads.
function serveFixtures() {
  const http = require('http');
  const types = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.otf': 'font/otf',
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/__fixture') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(server.__html || '');
      return;
    }
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(ROOT, 'public', rel);
    if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(''); return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return server;
}

async function main() {
  const only = ARG('file', null);
  const pages = PAGES.filter((p) => !only || p.name === only);
  if (!pages.length) {
    console.error(`${TAG} no fixture for "${only}". Have: ${PAGES.map((p) => p.name).join(', ')}`);
    process.exit(1);
  }

  const { chromium } = loadBrowser();
  const browser = await chromium.launch({ executablePath: chromePath() });
  const server = serveFixtures();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let failures = 0;

  for (const page of pages) {
    const css = styleBlocks(page.html);
    const fixture = fs.readFileSync(path.join(ROOT, page.fixture), 'utf8');
    const selectors = smallTextSelectors(css);
    const backdrop = backdropMarkup(page.html);

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    const p = await ctx.newPage();
    server.__html =
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<style>${css.replace(/\?v=__BUILD__/g, '')}</style></head><body>${backdrop}${fixture}</body></html>`;
    await p.goto(`${origin}/__fixture`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(500);

    // THE CONTAINER IS ASSERTED BEFORE ANYTHING IS MEASURED, because a fixture
    // whose container is inert reports the absence of its own fidelity as a
    // result. The first version of the settings fixture wrapped everything in a
    // class this page does not define: an unknown class is silently inert, so
    // backdrop-filter resolved to `none`, the background stayed transparent, and
    // every label was measured against the raw sky. Thirty-two of thirty-five
    // "failed" — including 16px near-black ink at 4.79:1, which is impossible.
    // Nothing errored. Same shape as a test rig omitting a field the code under
    // test reads (CLAUDE.md, the fourth species of measurement failure).
    // ═══ THE FIDELITY GUARD, AND WHAT IT ACTUALLY HAS TO ASK ════════════════
    //
    // The failure this exists to catch: the first settings fixture wrapped
    // everything in `.glass-panel`, a class that page does not define. An
    // unknown class is SILENTLY INERT — no error, nothing painted — so every
    // label was measured against the raw sky and thirty-two of thirty-five
    // "failed", including 16px near-black ink at 4.79:1, which is impossible.
    //
    // THE FIRST VERSION OF THIS GUARD ASKED THE WRONG QUESTION, and it went
    // wrong in the way this repo's own preamble is about: it tested whether a
    // CONTAINER PAINTS A BACKGROUND, which was a good proxy for "is this class
    // real" only for as long as the panels had fills. The rebrand made them
    // transparent with cream borders on purpose — `.lib-asset`, `.glass-card`
    // and `.sc-panel` are all `background: transparent` today — so this guard
    // began firing on the CORRECT design and the script has been refusing to
    // report any numbers at all since. A contrast tool that cannot run is worse
    // than no contrast tool, because the repo still says the panel was measured.
    //
    // So it asks the real question now: IS EVERY CLASS IN THIS FIXTURE ONE THE
    // PAGE ACTUALLY DEFINES? That catches `.glass-panel` exactly — the original
    // bug — and says nothing about whether a correct class chose to paint.
    //
    // Plus one thing that genuinely must hold whatever the panels do: THE PAGE
    // BACKDROP MUST BE PAINTED. With transparent panels the sky IS the surface
    // every ratio is taken against, so an unpainted backdrop would measure cream
    // text on the browser's default white and report the exact opposite of the
    // truth on a dark page.
    const fixtureClasses = [...new Set(
      [...fixture.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].trim().split(/\s+/))
    )].filter(Boolean);
    const definedClasses = new Set(
      [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1])
    );
    const undefinedClasses = fixtureClasses.filter((c) => !definedClasses.has(c));

    const surfaces = await p.evaluate(() => [...document.querySelectorAll('[class]')]
      .filter((el) => el.children.length && el.querySelector('*'))
      .slice(0, 4)
      .map((el) => {
        const cs = getComputedStyle(el);
        return {
          cls: el.className,
          bg: cs.backgroundColor,
          filter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
        };
      }));
    // What every ratio is ultimately taken against on a transparent-panel page.
    const backdropPaint = await p.evaluate(() => {
      const sky = document.querySelector('.sky-bg');
      const cs = sky ? getComputedStyle(sky) : getComputedStyle(document.body);
      return {
        which: sky ? '.sky-bg' : 'body',
        bg: cs.backgroundColor,
        image: cs.backgroundImage,
      };
    });
    console.log(`\n${TAG} ${page.fixture}`);
    for (const s of surfaces) {
      console.log(`    surface  ${String(s.cls).padEnd(24)} bg ${s.bg.padEnd(26)} backdrop-filter ${s.filter}`);
    }
    console.log(`    backdrop ${backdropPaint.which.padEnd(24)} bg ${String(backdropPaint.bg).padEnd(26)} image ${backdropPaint.image === 'none' ? 'none' : 'gradient'}`);
    if (undefinedClasses.length) {
      throw new Error(
        `this fixture uses ${undefinedClasses.length} class name(s) ${page.html} does not define: `
        + `${undefinedClasses.join(', ')}. An unknown class is silently inert, so those elements `
        + 'would be measured on the wrong surface. Refusing to report numbers.'
      );
    }
    const backdropPainted = backdropPaint.image !== 'none' || !/rgba\(0, 0, 0, 0\)/.test(String(backdropPaint.bg));
    if (!backdropPainted) {
      throw new Error(
        'the page backdrop paints nothing, so every ratio would be taken against the browser '
        + 'default white. Refusing to report numbers.'
      );
    }

    // Every element carrying its own visible text. Measured as it renders rather
    // than looked up by selector — the fixture decides what exists, so nothing
    // here has to guess which surface a class lands on.
    const targets = await p.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        el.setAttribute('data-contrast-id', String(out.length));
        out.push({
          id: out.length,
          cls: el.className || el.tagName.toLowerCase(),
          px: parseFloat(cs.fontSize),
          bold: parseInt(cs.fontWeight, 10) >= 600,
          text: el.textContent.trim().slice(0, 38),
        });
      }
      return out;
    });

    const rows = [];
    for (const t of targets) {
      const shot = await p.locator(`[data-contrast-id="${t.id}"]`).screenshot();
      const measured = await p.evaluate(
        RATIO_FN,
        shot.toString('base64')
      );
      rows.push({ ...t, ratio: measured, floor: floorFor(t.px, t.bold) });
    }

    console.log(`\n${TAG} ${page.html} — ${rows.length} text element(s) at 390x844/3x\n`);
    rows.sort((a, b) => a.ratio - b.ratio);
    for (const r of rows) {
      const ok = r.ratio >= r.floor;
      if (!ok) failures += 1;
      console.log(
        `  ${(ok ? 'ok  ' : 'FAIL')} ${r.ratio.toFixed(2).padStart(6)}:1  (floor ${r.floor})  `
        + `${String(r.px).padStart(5)}px${r.bold ? ' b' : '  '}  ${String(r.cls).padEnd(28)}  ${r.text}`
      );
    }

    // COVERAGE, REPORTED RATHER THAN ASSUMED. A selector no fixture rendered is
    // unmeasured — not clean.
    // THREE BUCKETS, NOT TWO. A rule whose element the fixture renders but which
    // carries no text of its OWN — `.lib-fresh` wraps two lines that ARE measured
    // — is neither measured nor absent, and counting it as a gap makes the number
    // pessimistic in a way that teaches the reader to distrust the list. A
    // pessimistic honest number is still a wrong one.
    const seen = new Set();
    for (const t of targets) for (const c of String(t.cls).split(/\s+/)) if (c) seen.add(c);
    const present = new Set(await p.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[class]')) {
        for (const c of String(el.className).split(/\s+/)) if (c) out.push(c);
      }
      return out;
    }));
    const container = [];
    const uncovered = [];
    for (const [sel, d] of selectors) {
      const c = targetClass(sel);
      if (!c || seen.has(c)) continue;
      (present.has(c) ? container : uncovered).push([sel, d]);
    }
    container.sort((a, b) => a[1].px - b[1].px);
    uncovered.sort((a, b) => a[1].px - b[1].px);
    // PROBE MODE. `--probe=.lib-sub,.lib-hint` re-renders each named selector at a
    // ladder of alphas and reports the ratio each one lands at, on THIS surface.
    //
    // IT MEASURES THE DARKEST INK IN THE ELEMENT, so probing a container that
    // holds a darker CHILD reports the child. `.lib-sub` wrapping a `.lib-tier`
    // chip is the live case: its ladder stays flat until the parent's own text
    // passes the chip. The fixture therefore carries the class both ways — with a
    // chip and without — and the bare one is the number to read.
    // The point is that the answer is per-surface: 0.75 is safe on .lib-asset and
    // says nothing about a label on the header band or a dark overlay. Nobody
    // should be picking an alpha from a table in a document.
    const probes = String(ARG('probe', '')).split(',').map((x) => x.trim()).filter(Boolean);
    for (const sel of probes) {
      const base = await p.evaluate((s2) => {
        const el = document.querySelector(s2);
        if (!el) return null;
        const m = getComputedStyle(el).color.match(/\d+/g);
        return m ? { r: +m[0], g: +m[1], b: +m[2] } : null;
      }, sel);
      if (!base) { console.log(`\n${TAG} probe ${sel}: not in this fixture`); continue; }
      console.log(`\n${TAG} probe ${sel} — rgb(${base.r},${base.g},${base.b}) on this surface`);
      for (const alpha of [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]) {
        const n = await p.evaluate(({ s2, a, c }) => {
          const id = 'probe-style';
          let st = document.getElementById(id);
          if (!st) { st = document.createElement('style'); st.id = id; document.head.appendChild(st); }
          st.textContent = `${s2} { color: rgba(${c.r},${c.g},${c.b},${a}) !important; }`;
          const els = [...document.querySelectorAll(s2)];
          els.forEach((e, i) => e.setAttribute('data-probe', String(i)));
          return els.length;
        }, { s2: sel, a: alpha, c: base });
        if (!n) continue;
        // EVERY element matching the selector, and the WORST ratio decides — that
        // is the one a reader meets. It also routes around the container problem
        // above without anyone having to write a cleverer selector: the instance
        // holding a darker chip scores higher and is not the answer.
        let ratio = Infinity;
        for (let i = 0; i < n; i += 1) {
          const shot = await p.locator(`[data-probe="${i}"]`).screenshot();
          ratio = Math.min(ratio, await p.evaluate(RATIO_FN, shot.toString('base64')));
        }
        console.log(`    alpha ${alpha.toFixed(2)}   ${ratio.toFixed(2).padStart(6)}:1   ${ratio >= AA_NORMAL ? 'passes AA' : ''}`);
      }
      await p.evaluate(() => {
        const st = document.getElementById('probe-style'); if (st) st.textContent = '';
        document.querySelectorAll('[data-probe]').forEach((e) => e.removeAttribute('data-probe'));
      });
    }

    // COLOUR MODE. `--color=.lib-tier.enforced=#6b3a00` measures a CANDIDATE on
    // this surface, which is the only way to propose one honestly. A hex proven
    // on one element is not proven on another: weight, size and whatever the
    // element sits on all move the number, so a colour that measures 5.03 on an
    // 11px regular line has to be re-measured at 600 weight before it is claimed.
    const colours = String(ARG('color', '')).split(',').map((x) => x.trim()).filter(Boolean);
    for (const pair of colours) {
      const at = pair.lastIndexOf('=');
      const sel = pair.slice(0, at);
      const hex = pair.slice(at + 1);
      const n = await p.evaluate(({ s2, c }) => {
        const id = 'colour-style';
        let st = document.getElementById(id);
        if (!st) { st = document.createElement('style'); st.id = id; document.head.appendChild(st); }
        st.textContent = `${s2} { color: ${c} !important; }`;
        const els = [...document.querySelectorAll(s2)];
        els.forEach((e, i) => e.setAttribute('data-probe', String(i)));
        return els.length;
      }, { s2: sel, c: hex });
      if (!n) { console.log(`\n${TAG} colour ${sel}: not in this fixture`); continue; }
      let ratio = Infinity;
      let px = 0;
      let bold = false;
      for (let i = 0; i < n; i += 1) {
        const shot = await p.locator(`[data-probe="${i}"]`).screenshot();
        ratio = Math.min(ratio, await p.evaluate(RATIO_FN, shot.toString('base64')));
        const m = await p.evaluate((j) => {
          const el = document.querySelector(`[data-probe="${j}"]`);
          const cs = getComputedStyle(el);
          return { px: parseFloat(cs.fontSize), bold: parseInt(cs.fontWeight, 10) >= 600 };
        }, i);
        px = m.px; bold = m.bold;
      }
      const need = floorFor(px, bold);
      console.log(`\n${TAG} colour ${sel} = ${hex}   ${ratio.toFixed(2)}:1   `
        + `(${px}px${bold ? ' 600' : ''}, floor ${need}) ${ratio >= need ? 'PASSES' : 'FAILS'}`);
      await p.evaluate(() => {
        const st = document.getElementById('colour-style'); if (st) st.textContent = '';
        document.querySelectorAll('[data-probe]').forEach((e) => e.removeAttribute('data-probe'));
      });
    }

    console.log(`\n${TAG} ${selectors.size - container.length - uncovered.length} of ${selectors.size} `
      + `small-text rules MEASURED; ${container.length} render but carry no text of their own; `
      + `${uncovered.length} NOT in this fixture and therefore NOT measured.`);
    if (SHOW_UNCOVERED) {
      for (const [sel, d] of uncovered) {
        console.log(`    unmeasured  ${String(d.px).padStart(5)}px  ${sel.padEnd(34)} ${d.color}`);
      }
    } else if (uncovered.length) {
      console.log(`${TAG} pass --all to list them.`);
    }

    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${TAG} ${failures ? `${failures} element(s) BELOW the floor` : 'every measured element meets its floor'}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(`${TAG} ${err.stack || err.message}`);
  process.exit(1);
});
