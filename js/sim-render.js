/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   Fire Mission Sim — the canvas overlay.

   Everything the sim draws on the feed goes through here. This file owns three
   things and nothing else: where the picture actually is on screen, the draw
   loop, and the bursts.

   ---------------------------------------------------------
   THE TRAP THIS FILE EXISTS TO AVOID.

   js/sim-projection.js answers in FRAME pixels — the 1882 x 563 of
   img/sim-pov.jpg, which is what the calibration was solved in. The browser
   draws that picture at some other size, and not necessarily filling its box:
   .sim-frame carries the right aspect ratio but also a max-height, so on a
   short window the box goes wider than the image and `object-fit: contain`
   pillarboxes it. Size the canvas to the box and every burst is then wrong by
   the width of a bar, on some window shapes only.

   So the canvas never assumes. It measures the image's rendered box the way
   `contain` computes it, and installs that as a transform. After `sync()`,
   every draw call below is in frame pixels and lands on the right piece of
   ground whatever the window is doing.
   ---------------------------------------------------------

   ---------------------------------------------------------
   TIME COMES FROM THE CLOCK, NOT THE WALL.

   Every age and lifetime below is measured in SIM milliseconds, read from
   SIM_CLOCK. Nothing here calls performance.now() for behaviour. That is what
   makes a pause actually freeze the rounds in flight and a 3x run land them at
   the same sim instant a 1x run does.

   While the clock is playing it drives the draw through SIM_CLOCK.onFrame, so
   this file does not run a second animation loop of its own. While it is
   paused the picture is frozen, so a single redraw is all a resize or a
   transport change needs. With no SIM_CLOCK present at all — a bare page, a
   test — it falls back to the wall clock and self-drives, exactly as before.
   ---------------------------------------------------------

   API:
     SIM_RENDER.attach(frameEl, imgEl)   once, at startup
     SIM_RENDER.fireMission(e, n, elev, rounds)  drop one volley on a grid
     SIM_RENDER.setEntitySource(fn)      fn() -> contacts to draw this frame
     SIM_RENDER.clear()                  remove everything in flight
     SIM_RENDER.toFrame(clientX, clientY)  screen point -> frame px (dev tool)
   ========================================================= */

const SIM_RENDER = (() => {

  /* ---------- the sheaf ----------
     Placeholder pattern. Six rounds scattered in an ellipse about the called
     grid: wider in range than in deflection, which is the right shape but not
     yet the right orientation — a real sheaf lies along the gun-target line,
     and there are no firing unit positions in the sim yet. Revisit when there
     are. */
  const ROUNDS = 6;              /* default when the caller names no gun count */
  const SPREAD_RANGE_M = 20;     /* half-axis, north-south for now */
  const SPREAD_DEFL_M  = 8;      /* half-axis, east-west for now */
  const BURST_R_M = 14;          /* visual radius of one burst on the ground */
  const BURST_MS  = 1700;        /* flash, then smoke fading out */
  const STAGGER_MS = 90;         /* rounds do not land in the same instant */

  let frameEl = null, imgEl = null, cv = null, cx2d = null;
  let box = null;                /* {left, top, width, height, scale} in CSS px */
  let bursts = [];
  let raf = 0;
  let unhook = [];               /* clock subscriptions, released by detach() */

  /* ---------- the only clock this file reads ----------
     SIM_CLOCK.renderMs() is interpolated sim time: step-aligned time plus the
     un-stepped remainder, so a 10 Hz logical step does not make a burst flash
     at 10 fps. It is for drawing and nothing else — no decision is ever made
     from it. Falls back to the wall clock when there is no SIM_CLOCK, which is
     what lets the overlay be tested and demoed on its own. */
  const hasClock = () => typeof SIM_CLOCK !== 'undefined';
  const simNow   = () => (hasClock() ? SIM_CLOCK.renderMs() : performance.now());

  /* ---------- where the picture actually is ----------
     The `object-fit: contain` computation, done by hand because we need the
     numbers rather than the effect. Pure, and exported, because this is the
     single piece of arithmetic standing between a correct grid and a burst in
     the wrong field — it is worth a test that does not need a browser. */
  function containBox(boxW, boxH, natW, natH) {
    if (!(boxW > 0 && boxH > 0 && natW > 0 && natH > 0)) return null;
    const scale = Math.min(boxW / natW, boxH / natH);
    const w = natW * scale, h = natH * scale;
    return { left: (boxW - w) / 2, top: (boxH - h) / 2, width: w, height: h, scale };
  }

  function measure() {
    if (!imgEl || !frameEl) return null;
    const fr = frameEl.getBoundingClientRect();
    const nw = imgEl.naturalWidth  || (typeof SIM_CAMERA !== 'undefined' ? SIM_CAMERA.frame.width  : 0);
    const nh = imgEl.naturalHeight || (typeof SIM_CAMERA !== 'undefined' ? SIM_CAMERA.frame.height : 0);
    return containBox(fr.width, fr.height, nw, nh);
  }

  /* Resize the backing store to the frame, then install a transform so that
     every drawing call afterwards can speak frame pixels. */
  function sync() {
    const m = measure();
    if (!m) return false;
    box = m;
    const fr = frameEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(fr.width  * dpr));
    const h = Math.max(1, Math.round(fr.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    cv.style.width = fr.width + 'px';
    cv.style.height = fr.height + 'px';
    cx2d.setTransform(dpr, 0, 0, dpr, 0, 0);           /* CSS px */
    cx2d.translate(box.left, box.top);
    cx2d.scale(box.scale, box.scale);                   /* now: frame px */
    return true;
  }

  /* ---------- ground shapes ----------
     A circle on the ground is not a circle on screen. The view is oblique, so
     it is an ellipse that leans, and it leans differently in different parts
     of the frame. Rather than work that out, project points around the real
     circle and fill the polygon they make. Exact, and the same trick will draw
     a vehicle's footprint when there are vehicles. */
  function groundDisc(e, n, elev, radius, steps) {
    const pts = [];
    const k = steps || 20;
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2;
      const p = SIM_PROJ.worldToScreen(e + radius * Math.cos(a), n + radius * Math.sin(a), elev);
      if (!p || !p.inFront || !isFinite(p.x) || !isFinite(p.y)) return null;
      pts.push(p);
    }
    return pts;
  }

  function tracePolygon(pts) {
    cx2d.beginPath();
    cx2d.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) cx2d.lineTo(pts[i].x, pts[i].y);
    cx2d.closePath();
  }

  /* ---------- one burst ---------- */
  function drawBurst(b, age) {
    const t = age / BURST_MS;
    if (t < 0 || t > 1) return;

    const centre = SIM_PROJ.worldToScreen(b.e, b.n, b.elev);
    if (!centre || !centre.inFront) return;

    /* Smoke sits on the ground and spreads. Drawn as a real ground disc so it
       foreshortens — narrow and deep near the camera, flat and wide far off. */
    const grow = 0.45 + 1.15 * t;
    const smoke = groundDisc(b.e, b.n, b.elev, BURST_R_M * grow);
    if (smoke) {
      cx2d.globalAlpha = 0.55 * (1 - t) * (1 - t);
      cx2d.fillStyle = '#d8d2c4';
      tracePolygon(smoke);
      cx2d.fill();
    }

    /* The flash has height, so its centre is a point in the air above the
       impact. Projecting that point is what makes it sit correctly rather than
       looking painted onto the ground. */
    const flashT = Math.min(1, t / 0.22);
    if (flashT < 1) {
      const top = SIM_PROJ.worldToScreen(b.e, b.n, b.elev + BURST_R_M * 0.9);
      const cyv = top && top.inFront ? (centre.y + top.y) / 2 : centre.y;
      const rPx = Math.max(1.5, (BURST_R_M * (0.3 + 0.7 * flashT)) / metresPerPixel(centre));
      const g = cx2d.createRadialGradient(centre.x, cyv, 0, centre.x, cyv, rPx);
      g.addColorStop(0,   'rgba(255, 247, 214, 1)');
      g.addColorStop(0.45,'rgba(255, 178, 64, 0.95)');
      g.addColorStop(1,   'rgba(190, 72, 20, 0)');
      cx2d.globalAlpha = 1 - flashT * 0.15;
      cx2d.fillStyle = g;
      cx2d.beginPath();
      cx2d.arc(centre.x, cyv, rPx, 0, Math.PI * 2);
      cx2d.fill();
    }
    cx2d.globalAlpha = 1;
  }

  /* Rough metres per pixel across the frame at a projected point, used only to
     size the flash. The exact figure comes from SIM_PROJ.groundScaleAt, but
     that back-projects and we already have the point, so approximate from the
     range instead — this is a visual, not a measurement. */
  function metresPerPixel(p) {
    const f = (typeof SIM_CAMERA !== 'undefined') ? SIM_CAMERA.intrinsics.focal_px : 1612.77;
    return Math.max(0.05, p.range / f);
  }

  /* ---------- contacts ----------
     Lee's concept, 2026-09-19: a small to-scale dark rectangle with a tactical
     symbol on a leader hovering above it.

     THE RECTANGLE IS FOUR PROJECTED GROUND CORNERS, never an axis-aligned rect.
     An oblique view compresses range about three times harder than deflection,
     so a ground rectangle is a trapezoid on screen whose shape changes with
     both position and heading. Projecting the corners costs nothing and gives
     the foreshortening and the heading for free.

     The footprint is honestly to scale, which means it is tiny at range — a
     35 m craft is about 2 px deep at 4.6 km. That is the point: you should not
     be able to identify a vehicle at that range. The floating symbol is what
     carries the identification, so it is sized in SCREEN pixels and stays
     legible wherever the contact is. */
  const SYMBOL_LEAD_PX = 40;     /* frame px from the footprint up to the symbol */
  const SYMBOL_HALF_W  = 24;
  const SYMBOL_HALF_H  = 15;
  const HOSTILE        = '#b3261e';
  const HULL           = '#22201c';

  let entitySource = null;

  function groundQuad(e, n, elev, headingDeg, lengthM, widthM) {
    const b = headingDeg * Math.PI / 180;
    const fE = Math.sin(b), fN = Math.cos(b);        /* forward, bearing from north */
    const rE = Math.cos(b), rN = -Math.sin(b);       /* right of forward */
    const hl = lengthM / 2, hw = widthM / 2;
    const pts = [];
    for (const [sl, sw] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
      const p = SIM_PROJ.worldToScreen(e + fE * hl * sl + rE * hw * sw,
                                       n + fN * hl * sl + rN * hw * sw, elev);
      if (!p || !p.inFront || !isFinite(p.x) || !isFinite(p.y)) return null;
      pts.push(p);
    }
    return pts;
  }

  function drawEntity(v) {
    const centre = SIM_PROJ.worldToScreen(v.e, v.n, v.elev);
    if (!centre || !centre.inFront || !centre.inFrame) return;

    const quad = groundQuad(v.e, v.n, v.elev, v.heading, v.lengthM, v.widthM);
    if (!quad) return;

    /* Filled and stroked both: at long range the quad is sub-pixel and a fill
       alone can disappear into nothing, which would read as "no contact"
       rather than "a contact too far away to make out". */
    cx2d.globalAlpha = v.state === 'destroyed' ? 0.35 : 1;
    cx2d.fillStyle = HULL;
    tracePolygon(quad);
    cx2d.fill();
    cx2d.strokeStyle = HULL;
    cx2d.lineWidth = 1;
    cx2d.stroke();

    /* The leader rises from the top of the footprint, so the symbol never sits
       on top of the thing it is labelling. */
    const top = Math.min(...quad.map(p => p.y));
    const sx = centre.x, sy = top - SYMBOL_LEAD_PX;

    cx2d.strokeStyle = HOSTILE;
    cx2d.lineWidth = 1.5;
    cx2d.beginPath();
    cx2d.moveTo(sx, top);
    cx2d.lineTo(sx, sy + SYMBOL_HALF_H);
    cx2d.stroke();

    /* A diamond is the hostile ground frame. Deliberately not a full 2525
       symbol set — the class abbreviation inside it carries the identification
       until there is a reason for more. */
    cx2d.beginPath();
    cx2d.moveTo(sx, sy - SYMBOL_HALF_H);
    cx2d.lineTo(sx + SYMBOL_HALF_W, sy);
    cx2d.lineTo(sx, sy + SYMBOL_HALF_H);
    cx2d.lineTo(sx - SYMBOL_HALF_W, sy);
    cx2d.closePath();
    cx2d.fillStyle = 'rgba(255, 246, 244, .92)';
    cx2d.fill();
    cx2d.stroke();

    /* A high-payoff target gets a second ring. Nothing reads it yet — there is
       no HPTL — but the flag is already on the entity and drawing it is one
       line, so the day the list exists the feed already agrees with it. */
    if (v.hpt) {
      cx2d.lineWidth = 1;
      cx2d.beginPath();
      cx2d.moveTo(sx, sy - SYMBOL_HALF_H - 4);
      cx2d.lineTo(sx + SYMBOL_HALF_W + 5, sy);
      cx2d.lineTo(sx, sy + SYMBOL_HALF_H + 4);
      cx2d.lineTo(sx - SYMBOL_HALF_W - 5, sy);
      cx2d.closePath();
      cx2d.stroke();
    }

    cx2d.fillStyle = HOSTILE;
    cx2d.font = '600 15px "IBM Plex Mono", ui-monospace, monospace';
    cx2d.textAlign = 'center';
    cx2d.textBaseline = 'middle';
    cx2d.fillText(v.label, sx, sy + 0.5);
    cx2d.globalAlpha = 1;
  }

  /* ---------- loop ---------- */
  function frame() {
    raf = 0;
    if (!cv) return;
    sync();
    cx2d.save();
    cx2d.setTransform(1, 0, 0, 1, 0, 0);
    cx2d.clearRect(0, 0, cv.width, cv.height);
    cx2d.restore();

    /* Contacts under the bursts: a round landing on a vehicle should obscure
       it, not the other way round. */
    if (entitySource) {
      let vs = null;
      try { vs = entitySource(); } catch (err) { console.error('[sim-render] entity source threw', err); }
      if (vs) for (const v of vs) drawEntity(v);
    }

    const now = simNow();
    let live = 0;
    for (const b of bursts) {
      const age = now - b.t0;
      if (age < 0) { live++; continue; }
      if (age > BURST_MS) continue;
      drawBurst(b, age);
      live++;
    }
    bursts = bursts.filter(b => now - b.t0 <= BURST_MS);

    /* Self-drive only when nothing else is driving. With a clock playing, the
       next frame arrives through SIM_CLOCK.onFrame; with a clock paused the
       picture cannot change, so one draw is the whole job. */
    if (live && !hasClock()) raf = requestAnimationFrame(frame);
  }

  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  /* ---------- public ---------- */

  function attach(fEl, iEl) {
    frameEl = fEl; imgEl = iEl;
    cv = document.createElement('canvas');
    cv.className = 'sim-canvas';
    frameEl.appendChild(cv);
    cx2d = cv.getContext('2d');
    const redraw = () => { sync(); kick(); };
    if (imgEl.complete) redraw(); else imgEl.addEventListener('load', redraw);
    window.addEventListener('resize', redraw);
    if (window.ResizeObserver) new ResizeObserver(redraw).observe(frameEl);

    if (hasClock()) {
      /* While playing, the clock is the only thing that asks for a frame. */
      unhook.push(SIM_CLOCK.onFrame(() => { raf = 0; frame(); }));
      /* Pause, play, rate and stop each need one repaint. Stop is a scenario
         reset — sim time goes back to zero, so every burst in flight now has a
         t0 in the future and would hang on screen. Drop them. */
      unhook.push(SIM_CLOCK.onChange(s => { if (s.reason === 'stop') bursts = []; kick(); }));
    }
    return true;
  }

  function detach() {
    unhook.forEach(fn => fn());
    unhook = [];
  }

  /** Drop a sheaf on a grid. elev is metres above sea level at the impact
      point — the sim has no terrain lookup, so the caller owns it. */
  /** One volley. `rounds` is the gun count for this type of mission — six for
      fire for effect, one for suppression — and the spread is still the file's
      own placeholder pattern, NOT the unit's dispersion diameter. Lee has
      dispersion on standby until rounds are spread over that area against a
      burst radius and compared to an enemy position. */
  function fireMission(e, n, elev, rounds) {
    const shots = Math.max(1, Math.round(Number(rounds) || ROUNDS));
    const t = simNow();
    for (let i = 0; i < shots; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      bursts.push({
        e: e + Math.cos(a) * r * SPREAD_DEFL_M,
        n: n + Math.sin(a) * r * SPREAD_RANGE_M,
        elev: elev || 0,
        t0: t + i * STAGGER_MS + Math.random() * STAGGER_MS
      });
    }
    kick();
    return shots;
  }

  function clear() { bursts = []; kick(); }

  /** Hand the overlay a function returning the contacts to draw this frame.
      A pull, not a push: the renderer asks at draw time, so it can never show a
      position that disagrees with the one the tick just computed. */
  function setEntitySource(fn) { entitySource = (typeof fn === 'function') ? fn : null; kick(); }

  /** Screen point -> frame pixels. Dev tool only: nothing the student does
      needs this, because a call for fire names a grid, it does not click one. */
  function toFrame(clientX, clientY) {
    if (!box || !frameEl) return null;
    const fr = frameEl.getBoundingClientRect();
    const x = (clientX - fr.left - box.left) / box.scale;
    const y = (clientY - fr.top  - box.top ) / box.scale;
    return { x, y };
  }

  return { attach, detach, fireMission, setEntitySource, clear, toFrame, containBox,
           groundQuad, get box() { return box; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_RENDER;
