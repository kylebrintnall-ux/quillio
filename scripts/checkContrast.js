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
// element. Darkest 1% is the glyph — antialiasing means most pixels of a text
// element are background, and the true ink is the tail. The 90th percentile is
// the surface, not the max: a stray highlight would flatter the ratio.
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
    const ink = ls[Math.max(0, Math.floor(ls.length * 0.01))];
    const bg = ls[Math.min(ls.length - 1, Math.floor(ls.length * 0.90))];
    res((Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05));
  };
  img.src = 'data:image/png;base64,' + b64;
})`);

async function main() {
  const only = ARG('file', null);
  const pages = PAGES.filter((p) => !only || p.name === only);
  if (!pages.length) {
    console.error(`${TAG} no fixture for "${only}". Have: ${PAGES.map((p) => p.name).join(', ')}`);
    process.exit(1);
  }

  const { chromium } = loadBrowser();
  const browser = await chromium.launch({ executablePath: chromePath() });
  let failures = 0;

  for (const page of pages) {
    const css = styleBlocks(page.html);
    const fixture = fs.readFileSync(path.join(ROOT, page.fixture), 'utf8');
    const selectors = smallTextSelectors(css);

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    const p = await ctx.newPage();
    await p.setContent(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<style>${css}</style></head><body><div class="sky-bg"></div>${fixture}</body></html>`
    );
    await p.waitForTimeout(400);

    // THE CONTAINER IS ASSERTED BEFORE ANYTHING IS MEASURED, because a fixture
    // whose container is inert reports the absence of its own fidelity as a
    // result. The first version of the settings fixture wrapped everything in a
    // class this page does not define: an unknown class is silently inert, so
    // backdrop-filter resolved to `none`, the background stayed transparent, and
    // every label was measured against the raw sky. Thirty-two of thirty-five
    // "failed" — including 16px near-black ink at 4.79:1, which is impossible.
    // Nothing errored. Same shape as a test rig omitting a field the code under
    // test reads (CLAUDE.md, the fourth species of measurement failure).
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
    const painted = surfaces.filter((s) => s.filter !== 'none' || !/rgba\(0, 0, 0, 0\)/.test(s.bg));
    console.log(`\n${TAG} ${page.fixture}`);
    for (const s of surfaces) {
      console.log(`    surface  ${String(s.cls).padEnd(24)} bg ${s.bg.padEnd(26)} backdrop-filter ${s.filter}`);
    }
    if (!painted.length) {
      throw new Error(
        'every container in this fixture is transparent with no backdrop-filter. '
        + 'That is what an unknown class name looks like, and it would measure the '
        + 'page background instead of the surface. Refusing to report numbers.'
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
    const seen = new Set();
    for (const t of targets) for (const c of String(t.cls).split(/\s+/)) if (c) seen.add(c);
    const uncovered = [...selectors.entries()]
      .filter(([sel]) => { const c = targetClass(sel); return c && !seen.has(c); })
      .sort((a, b) => a[1].px - b[1].px);
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

    console.log(`\n${TAG} covered ${selectors.size - uncovered.length} of ${selectors.size} small-text rules; `
      + `${uncovered.length} NOT rendered by this fixture and therefore NOT measured.`);
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
  console.log(`\n${TAG} ${failures ? `${failures} element(s) BELOW the floor` : 'every measured element meets its floor'}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(`${TAG} ${err.stack || err.message}`);
  process.exit(1);
});
