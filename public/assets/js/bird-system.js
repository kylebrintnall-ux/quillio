/* Quillio bird system — scheduling + element swapping only.
   Perch targets are passed in as selectors; no coordinates are hardcoded
   against a screenshot. All sizes derive from one art-pixel scale. */
(function (global) {
  'use strict';

  /* where the sprites live; override with init({ assetBase: '/assets/gifs/' }) */
  var BASE = 'assets/';

  var CLIP = {
    fly:     { file: 'bird-fly.gif',     w: 258, h: 234 },
    landing: { file: 'bird-landing.gif', w: 528, h: 288, dur: 3770, perchAt: 1070, swapAt: 1400 },
    idle:    { file: 'bird-idle.gif',    w: 528, h: 288, dur: 7680 },
    takeoff: { file: 'bird-takeoff.gif', w: 528, h: 288, dur: 1360 },
    dropin:  { file: 'doc-dropin.gif',   w: 132, h: 66,  dur: 3450 }
  };

  /* shared foot anchor of landing / idle / takeoff, as fractions of the
     528x288 canvas — the invariant that makes the swaps invisible */
  var FOOT_X = 0.6534, FOOT_Y = 0.8715;

  /* one scale for perched birds, one for flying — sized so the bird reads the
     same in both sprites, and small enough to sit in a canopy */
  /* two tiers: distant ambient birds, and the nearer ones that use the trees */
  var FLY_K = 0.13;                    // ambient crossings — small, far off
  var PERCH_K = 0.252, PERCH_FLY_K = 0.1575;   // tree birds, perched and flying
  var AMBIENT_SPAN = [22000, 30000];   // ms to cross a frame width
  var PERCH_SPAN = [10000, 14000];
  /* measured from frame 0 of each sprite (opaque bbox centre, as canvas
     fractions) so the fly <-> landing handover is continuous */
  var ENTRY_X = 0.279, ENTRY_Y = 0.179;   // bird-landing frame 0
  var FLY_CX = 0.440, FLY_CY = 0.434;     // bird-fly frame 0
  var HANDOFF = 380;   /* ms into takeoff (1360ms total) to swap to bird-fly —
                          early, while the launch still has momentum */

  /* doc-dropin: art-pixel (22,42) of its canvas sits on the scroll icon's
     top-left, and the scroll it resolves into is 20x21 art pixels */
  var DROP_OFF_X = 22, DROP_OFF_Y = 42, DROP_ICON = 20;

  function rand(a, b) { return a + Math.random() * (b - a); }

  function img(clip, w, h) {
    var el = document.createElement('img');
    el.src = BASE + clip.file;
    el.alt = '';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:absolute;image-rendering:pixelated;pointer-events:none;' +
      'width:' + w + 'px;height:' + h + 'px;';
    return el;
  }

  /* top of the glyphs for an inline text node, not the top of the line box */
  function glyphTop(el) {
    var rects = el.getClientRects();
    if (!rects.length) return null;
    var r = rects[rects.length - 1];
    var cs = getComputedStyle(el);
    var ctx = glyphTop._ctx || (glyphTop._ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    var m = ctx.measureText('H');
    var fbA = m.fontBoundingBoxAscent || parseFloat(cs.fontSize) * 0.8;
    var abA = m.actualBoundingBoxAscent || fbA * 0.9;
    return { rect: r, top: r.top + (fbA - abA) };
  }

  /* layout offset inside a positioned ancestor, in unscaled CSS px —
     getBoundingClientRect would return the canvas's zoom-scaled values */
  function offsetIn(el, ancestor) {
    var x = 0, y = 0, n = el;
    while (n && n !== ancestor) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x: x, y: y };
  }

  /* Geometry comes from `wrap` (the fixed sky layer), never from `phone`: with
     frame:'body' the phone element is the document, which grows with content,
     while sprites live in a position:fixed wrap clipped to the viewport. */
  /* An element that is in the DOM but on a hidden screen has no offsetParent
     and no client rects. The app keeps every screen mounted and toggles them,
     so this is the difference between "exists" and "on screen right now". */
  function onScreen(el) {
    return !!(el && el.offsetParent !== null && el.getClientRects().length);
  }

  function Scene(phone, opts) {
    this.phone = phone;
    this.opts = opts;
    this.timers = [];
    this.live = [];
    this.running = false;
    this.actors = 0;
    this.wrap = phone.querySelector(opts.skyLayer || '.clouds-wrap') || phone;
    this.desktop = phone.classList.contains('desktop');
  }

  Scene.prototype.after = function (ms, fn) {
    var t = setTimeout(fn, ms);
    this.timers.push(t);
    return t;
  };

  Scene.prototype.adopt = function (el, parent) {
    (parent || this.wrap).appendChild(el);
    this.live.push(el);
    return el;
  };

  /* Remove the outgoing clip only after the incoming one has painted —
     dropping it on a timer leaves a one-frame hole at every swap. */
  Scene.prototype.swap = function (oldEl, newEl) {
    var self = this;
    var go = function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { self.drop(oldEl); });
      });
    };
    if (newEl.complete) go(); else newEl.addEventListener('load', go, { once: true });
  };

  Scene.prototype.drop = function (el) {
    var i = this.live.indexOf(el);
    if (i > -1) this.live.splice(i, 1);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  };

  Scene.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.actors = this.actors || 0;
    this.lastLaunch = 0;
    this.queueCrossing(rand(1500, 7000));
    if (this.opts.trees !== false) this.queuePerch(rand(6000, 14000));
    /* dropinArmed IS THE GUARD, NOT dropinDone — dropinDone only tells you
       whether THIS document's arrival already finished; it says nothing
       about whether a check is already in flight for it. Both start() and
       armDropin() can queue one (a resize — an on-screen keyboard opening
       while the next brief is typed — fires the debounced stop()+start()
       below on every visible scene independently of anything armDropin is
       doing) and neither used to know about the other, so a still-pending
       queueDropin from one collided with a fresh one from the other: two
       independent dropin(icon) calls landed the same overlay on the same
       icon a few seconds apart, which is the "started halfway through, then
       restarted" glitch reported directly. One flag, checked here and in
       armDropin, makes the two callers mutually exclusive. */
    if (this.phone.querySelector(this.opts.docIcon) && !this.dropinArmed) {
      this.dropinArmed = true;
      this.queueDropin(rand(1200, 3000));
    }
  };

  Scene.prototype.stop = function () {
    this.running = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.live.slice().forEach(this.drop, this);
    this.revealIcon();
    // Whatever queueDropin chain was pending just had its timer cleared
    // above — it will never fire. Un-arm so the next start() (this same
    // resize cycle's own start(), or a later one) is free to queue a real
    // replacement instead of believing one is still out there.
    this.dropinArmed = false;
    this.actors = 0;
  };

  /* never more than two birds in a frame, and never two launching together */
  Scene.prototype.canLaunch = function () {
    return (this.actors || 0) < 2 && Date.now() - (this.lastLaunch || 0) > 7000;
  };
  Scene.prototype.claim = function () {
    this.actors = (this.actors || 0) + 1;
    this.lastLaunch = Date.now();
  };
  Scene.prototype.release = function () {
    this.actors = Math.max(0, (this.actors || 1) - 1);
  };

  /* ---------- flight ---------- */

  /* one flying bird travelling from x -> edge at a constant, distant pace */
  Scene.prototype.fly = function (opt) {
    var self = this;
    var k = opt.k || FLY_K;
    var w = Math.round(CLIP.fly.w * k), h = Math.round(CLIP.fly.h * k);
    var W = this.wrap.clientWidth;
    var ltr = opt.dir !== 'rtl';
    var el = img(CLIP.fly, w, h);
    el.style.left = '0px';
    el.style.top = Math.round(opt.y) + 'px';
    el.style.opacity = String(opt.opacity == null ? rand(0.45, 0.6) : opt.opacity);
    if (opt.z) el.style.zIndex = String(opt.z);
    this.adopt(el, opt.parent || this.wrap);

    var from = opt.from != null ? opt.from : (ltr ? -w - 40 : W + 40);
    var to = opt.to != null ? opt.to : (ltr ? W + 60 : -w - 60);
    if (ltr) el.style.transform = 'scaleX(-1)';   // sprites face right
    var span = opt.span || AMBIENT_SPAN;
    var pace = W / rand(span[0], span[1]);        // px per ms across a full frame
    var dur = Math.abs(to - from) / pace;
    var y0 = Math.round(opt.y);
    var y1 = opt.climbTo != null ? Math.round(opt.climbTo) : y0;
    el.style.left = from + 'px';
    /* animating left/top rather than transform keeps the element off a
       composited layer, so the GIF keeps advancing for the whole crossing */
    var frames = y1 === y0
      ? [{ left: from + 'px' }, { left: to + 'px' }]
      : [{ left: from + 'px', top: y0 + 'px', easing: 'cubic-bezier(.17,.85,.3,1)' },
         { left: from + (to - from) * 0.12 + 'px', top: y1 + 'px', offset: 0.12 },
         { left: to + 'px', top: y1 + 'px' }];
    var anim = el.animate(frames, { duration: dur, easing: 'linear', fill: 'forwards' });
    anim.onfinish = function () {
      if (opt.onArrive) { opt.onArrive(el); return; }   // caller owns the element
      self.drop(el); if (opt.onEnd) opt.onEnd();
    };
    return el;
  };

  /* ---------- ambient: crossings ---------- */

  Scene.prototype.queueCrossing = function (delay) {
    var self = this;
    this.after(delay, function () {
      if (!self.running) return;
      if (self.canLaunch()) {
        var H = self.wrap.clientHeight;
        var lanes = self.desktop ? [96, H - 220] : [70, H - 190];
        self.claim();
        self.fly({
          y: lanes[Math.random() < 0.5 ? 0 : 1] + rand(-14, 14),
          dir: Math.random() < 0.5 ? 'ltr' : 'rtl',
          onEnd: function () { self.release(); }
        });
      }
      self.queueCrossing(rand(25000, 45000));
    });
  };

  /* ---------- perches ---------- */

  Scene.prototype.treePoints = function () {
    /* the tree band is a baked background on .clouds-wrap::after, so the
       canopy points come from the band's own geometry, not a screenshot */
    var W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    var tw = this.desktop ? 248 : 124, th = this.desktop ? 168 : 84;
    var inset = 16;
    /* perch on top of the canopy, just inside its silhouette, so the bird
       reads clearly against the sky rather than disappearing into foliage */
    var canopy = this.desktop ? 0.09 : 0.11;
    var top = H - th + th * canopy;
    return this.desktop
      ? [{ x: inset + tw * 0.5, y: top }, { x: W - inset - tw * 0.5, y: top }]
      : [{ x: W * 0.5, y: top }];
  };

  Scene.prototype.queuePerch = function (delay) {
    var self = this;
    this.after(delay, function () {
      if (!self.running) return;
      if (self.canLaunch()) {
        var pts = self.treePoints();
        self.perch(pts[Math.floor(Math.random() * pts.length)], {
          opacity: 1, idle: rand(9000, 16000), parent: self.wrap
        });
      }
      self.queuePerch(rand(30000, 55000));
    });
  };

  /* fly in from an edge -> land -> idle -> take off -> away again, all on one
     foot anchor, and the whole arc in one direction. */
  Scene.prototype.perch = function (pt, o) {
    var self = this;
    var k = PERCH_K;
    var dir = Math.random() < 0.5 ? 'ltr' : 'rtl';
    var W = CLIP.landing.w * k, H = CLIP.landing.h * k;
    var footFrac = dir === 'rtl' ? 1 - FOOT_X : FOOT_X;
    var left = Math.round(pt.x - W * footFrac);
    var top = Math.round(pt.y - H * FOOT_Y);
    var mirror = dir === 'rtl' ? 'scaleX(-1)' : '';
    var fw = CLIP.fly.w * PERCH_FLY_K, fh = CLIP.fly.h * PERCH_FLY_K;

    this.claim();

    function place(clip) {
      var el = img(clip, W, H);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.opacity = String(o.opacity);
      if (mirror) el.style.transform = mirror;
      if (o.z) el.style.zIndex = String(o.z);
      return self.adopt(el, o.parent);
    }

    /* where the bird sits in the landing clip's first frame — the fly sprite
       is handed over at exactly that point so the arrival is continuous */
    var ex = left + W * (dir === 'rtl' ? 1 - ENTRY_X : ENTRY_X);
    var ey = top + H * ENTRY_Y;

    this.fly({
      parent: o.parent, k: PERCH_FLY_K, span: PERCH_SPAN, z: o.z,
      opacity: o.opacity, dir: dir,
      y: Math.round(ey - fh * FLY_CY),
      to: Math.round(ex - fw * FLY_CX),
      onArrive: function (inbound) {
        if (!self.running) { self.drop(inbound); self.release(); return; }
        var a = place(CLIP.landing);
        self.swap(inbound, a);
        self.after(CLIP.landing.swapAt, function () {
          if (!self.running) return;
          var b = place(CLIP.idle);        // fresh element: GIFs cannot be restarted
          self.swap(a, b);
          self.after(o.idle, function () {
            if (!self.running) return;
            var c = place(CLIP.takeoff);
            self.swap(b, c);
            /* hand off to the flying sprite before takeoff runs out of frames,
               so the bird keeps going instead of blinking out at the perch */
            self.after(HANDOFF, function () {
              if (!self.running) { self.drop(c); self.release(); return; }
              var lift = 20 * k, reach = 16 * k;
              var y0 = Math.round(pt.y - fh * FLY_CY - lift);
              var f = self.fly({
                parent: o.parent, k: PERCH_FLY_K, span: PERCH_SPAN, z: o.z,
                opacity: o.opacity, dir: dir,
                y: y0,
                climbTo: Math.round(y0 - 84 * k),
                from: Math.round(pt.x - fw * FLY_CX + (dir === 'rtl' ? -reach : reach)),
                onEnd: function () { self.release(); }
              });
              self.swap(c, f);
            });
          });
        });
      }
    });
  };

  /* ---------- dynamic: document complete ---------- */

  /* Waits for the completion screen to actually appear rather than firing on a
     timer after load — the icon is mounted from the start but hidden, and
     playing the arrival over a hidden icon burns the once-only flag unseen. */
  Scene.prototype.queueDropin = function (delay) {
    var self = this;
    this.after(delay, function () {
      if (!self.running || self.dropinDone) return;
      var icon = self.phone.querySelector(self.opts.docIcon);
      if (onScreen(icon)) self.dropin(icon);
      else self.queueDropin(500);
    });
  };

  /* Called by the host page when a NEW document has just finished building
     and the icon deserves a fresh arrival. dropinDone reads as "once per
     page load" but the Scene for frame:'body' is a SINGLETON that outlives
     every document an SPA session builds — start() only calls queueDropin
     from inside itself, and start() is a no-op once `running` is already
     true (see the STOP IS DEBOUNCED comment in init() for why running stays
     true across an ordinary scroll). So on every document after the first,
     nothing was ever going to call queueDropin again: not stop/start (the
     page never leaves the intersection root), not the dropinDone flag alone
     (clearing it with nothing to re-check it is silent). This re-arms both
     halves — clears the flag AND re-queues the check directly — which is
     why it exists as its own method rather than being folded into start(). */
  Scene.prototype.armDropin = function () {
    this.dropinDone = false;
    // Same mutual-exclusion check start() makes. Without it, a document that
    // finishes while a resize-triggered stop()+start() has already queued
    // its own check (see the comment on dropinArmed in start()) queues a
    // SECOND, independent one here — two chains racing to the same icon.
    if (this.running && !this.dropinArmed) {
      this.dropinArmed = true;
      this.queueDropin(rand(1200, 3000));
    }
  };

  Scene.prototype.dropin = function (icon) {
    var self = this;
    var at = offsetIn(icon, this.phone);

    /* Scale comes from the icon: the clip resolves into a 20x21 art-px scroll,
       so k = icon width / 20 puts the landed scroll exactly on the existing
       icon — same size, same position, no jump at the handoff. The bird enters
       at the canvas's upper right, which is off-frame on a narrow screen; it
       flies in from beyond the corner and becomes visible on the descent. */
    var k = Math.max(1, Math.round(icon.offsetWidth / DROP_ICON));
    var el = img(CLIP.dropin, CLIP.dropin.w * k, CLIP.dropin.h * k);
    el.style.left = Math.round(at.x - DROP_OFF_X * k) + 'px';
    el.style.top = Math.round(at.y - DROP_OFF_Y * k) + 'px';
    el.style.zIndex = '6';
    icon.style.visibility = 'hidden';
    this.hiddenIcon = icon;
    this.adopt(el, this.phone);
    /* Reveal the scroll UNDER the overlay a beat before the clip would loop
       back to its empty first frame, then drop the overlay on the next frame.
       Swapping in the other order leaves a blank gap.
       dropinDone IS SET HERE, NOT AT THE TOP OF THIS FUNCTION — it used to be,
       on the comment "one arrival per page load, ever", and that is exactly
       what made a brief that finished while the tab was backgrounded show NO
       arrival at all rather than a late one. stop() (fired by the
       visibilitychange handler when a tab backgrounds) clears every timer and
       tears down every live sprite unconditionally, INCLUDING this one
       mid-flight — so the bird vanished, the icon was revealed early, and
       with the flag already true from the top of dropin(), the retry loop in
       queueDropin refused to ever try again once the tab came back. Setting
       it only on genuine completion means an interruption leaves dropinDone
       false, so the next start() (fired the moment the tab is visible again)
       re-arms queueDropin and the arrival gets a real second attempt instead
       of silently never happening. */
    this.after(CLIP.dropin.dur - 140, function () {
      self.dropinDone = true;
      // MUST clear here, not only in stop(): if a genuine completion left
      // dropinArmed true forever, the NEXT document's armDropin() call would
      // see a chain that finished normally and read it as one still in
      // flight — refusing to re-arm at all, which silently brings back the
      // exact "only the first document ever gets a bird" bug this flag was
      // added to fix in the first place.
      self.dropinArmed = false;
      self.revealIcon(true);
      requestAnimationFrame(function () { self.drop(el); });
    });
  };

  /* Restore the scroll icon. `fresh` swaps in a new element so the doc-done
     GIF starts at its first frame as the bird hands off, then persists. */
  Scene.prototype.revealIcon = function (fresh) {
    var icon = this.hiddenIcon;
    if (!icon) return;
    this.hiddenIcon = null;
    if (fresh && icon.parentNode) {
      var next = icon.cloneNode(true);
      next.style.visibility = '';
      icon.parentNode.replaceChild(next, icon);
    } else {
      icon.style.visibility = '';
    }
  };

  /* ---------- ground scrim ---------- */

  /* The ground band is opaque pixel art at the bottom of a fixed layer, so
     content scrolling over it collides. A scrim hazes the lower strip — but
     only while there is still page left: as the scroll reaches the end, the
     haze clears so the trees and grass are seen plainly. Published as a
     custom property; the CSS owns the gradient. */
  function scrim(scenes) {
    var FADE = 260;        // px from the bottom over which the haze clears
    var queued = false;

    function apply() {
      queued = false;
      var doc = document.documentElement;
      var y = window.pageYOffset || doc.scrollTop || 0;
      var remaining = Math.max(0, doc.scrollHeight - y - window.innerHeight);
      /* a page too short to scroll has nothing to obscure, so no haze */
      var strength = doc.scrollHeight - window.innerHeight < 40
        ? 0
        : Math.min(1, remaining / FADE);
      /* Also published on <html>, not just each scene's own sky layer: a
         consumer that has to sit ABOVE page content (a fade over the content
         itself, not just the sky behind it) can't be a descendant of
         .clouds-wrap without being capped at its stacking level, so it lives
         outside that subtree — and a custom property only inherits down the
         tree it's set on. <html> is the one ancestor every such consumer
         shares. */
      doc.style.setProperty('--q-scrim', strength.toFixed(3));
      scenes.forEach(function (s) {
        s.wrap.style.setProperty('--q-scrim', strength.toFixed(3));
      });
    }

    function queue() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(apply);
    }

    addEventListener('scroll', queue, { passive: true });
    /* A scroll event is not the only thing that changes how much page is
       left to haze. An SPA screen swap, an async fetch populating a panel,
       or a GIF finishing layout all change scrollHeight with no scroll event
       at all — so a screen that arrives short (nothing loaded yet) froze at
       strength 0 and stayed there, invisible, until the visitor scrolled by
       hand and finally re-ran apply() against the grown page. A
       ResizeObserver on the document catches every one of those generically,
       without every call site having to remember to resync it by hand. */
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(queue).observe(document.documentElement);
    }
    apply();
    return apply;
  }

  /* ---------- controller ---------- */

  function init(cfg) {
    cfg = cfg || {};
    if (cfg.assetBase) BASE = cfg.assetBase;
    var root = cfg.root || document;
    var opts = {
      headline: null,   /* headline perches are off: a full bird on a header
                           reads as a control, and at this scale it dominates */
      docIcon: cfg.docIcon || '#screen-output .header-gif',
      skyLayer: cfg.skyLayer || '.clouds-wrap',
      trees: cfg.trees !== false
    };
    var reduce = matchMedia('(prefers-reduced-motion: reduce)');
    if (reduce.matches) return null;

    var sel = cfg.frame || '.phone';
    var scenes = [];
    var visible = new Set();
    /* STOP IS DEBOUNCED; START IS NOT. Reported directly: scrolling froze a
       bird mid-landing and it vanished — exactly Scene.stop()'s behavior
       (every timer cleared, every live sprite dropped with no transition).
       frame is 'body' in this app (there is one scene, the whole page, not
       several independent phone mockups scrolling past each other), and iOS
       Safari resizes the viewport live as its address bar collapses and
       expands during a scroll — which is exactly when IntersectionObserver
       recalculates every observed target's intersection against that
       changing root. A target sitting near the root's edge can read as
       momentarily not-intersecting for a single tick with nothing about the
       page actually having changed. Immediate stop() treated that tick as a
       genuine exit; a 400ms grace period treats it as the blip it is, while
       a real, sustained scroll-away (more than a few ticks) still stops the
       scene same as before — the debounce delays the stop, it doesn't skip
       it. */
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var s = scenes[+e.target.dataset.qbIndex];
        if (!s) return;
        if (e.isIntersecting) {
          visible.add(s);
          if (s.pendingStop) { clearTimeout(s.pendingStop); s.pendingStop = null; }
          if (!document.hidden) s.start();
        } else {
          visible.delete(s);
          if (!s.pendingStop) {
            s.pendingStop = setTimeout(function () { s.pendingStop = null; s.stop(); }, 400);
          }
        }
      });
    }, { rootMargin: '120px' });

    function scan() {
      Array.prototype.forEach.call(root.querySelectorAll(sel), function (p) {
        if (p.dataset.qbIndex) return;
        var s = new Scene(p, opts);
        p.dataset.qbIndex = scenes.push(s) - 1;
        io.observe(p);
      });
    }
    scan();
    var mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });

    function onVis() {
      visible.forEach(function (s) { document.hidden ? s.stop() : s.start(); });
    }
    document.addEventListener('visibilitychange', onVis);

    var resyncScrim = cfg.scrim === false ? null : scrim(scenes);

    var rt;
    addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (resyncScrim) resyncScrim();
        visible.forEach(function (s) { s.stop(); s.start(); });
      }, 250);
    });

    return {
      scenes: scenes,
      /* One document just finished building — see Scene.prototype.armDropin
         for why this has to be called explicitly rather than happening on
         its own. Safe to call for every scene: a scene with no docIcon in
         its DOM never queues a dropin in the first place (queueDropin's own
         onScreen check keeps it dormant until the icon is actually visible). */
      armDropin: function () { scenes.forEach(function (s) { s.armDropin(); }); },
      destroy: function () {
        io.disconnect();
        mo.disconnect();
        document.removeEventListener('visibilitychange', onVis);
        scenes.forEach(function (s) { s.stop(); });
      }
    };
  }

  global.QuillioBirds = { init: init, CLIP: CLIP };

  /* Auto-init once the frames exist. Set window.QUILLIO_BIRDS_MANUAL = true
     before loading this file to configure and call init() yourself. */
  var tries = 0;
  (function wait() {
    if (global.QUILLIO_BIRDS_MANUAL) return;
    if (document.body && document.querySelector('.phone')) init();
    else if (tries++ < 300) setTimeout(wait, 100);
  })();
})(window);
