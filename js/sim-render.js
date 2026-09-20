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

   API:
     SIM_RENDER.attach(frameEl, imgEl)   once, at startup
     SIM_RENDER.fireMission(e, n, elev)  drop a sheaf of bursts on a grid
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
  const ROUNDS = 6;
  const SPREAD_RANGE_M = 20;     /* half-axis, north-south for now */
  const SPREAD_DEFL_M  = 8;      /* half-axis, east-west for now */
  const BURST_R_M = 14;          /* visual radius of one burst on the ground */
  const BURST_MS  = 1700;        /* flash, then smoke fading out */
  const STAGGER_MS = 90;         /* rounds do not land in the same instant */

  let frameEl = null, imgEl = null, cv = null, cx2d = null;
  let box = null;                /* {left, top, width, height, scale} in CSS px */
  let bursts = [];
  let raf = 0;

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

  /* ---------- loop ---------- */
  function frame() {
    raf = 0;
    if (!cv) return;
    sync();
    cx2d.save();
    cx2d.setTransform(1, 0, 0, 1, 0, 0);
    cx2d.clearRect(0, 0, cv.width, cv.height);
    cx2d.restore();

    const now = performance.now();
    let live = 0;
    for (const b of bursts) {
      const age = now - b.t0;
      if (age < 0) { live++; continue; }
      if (age > BURST_MS) continue;
      drawBurst(b, age);
      live++;
    }
    bursts = bursts.filter(b => now - b.t0 <= BURST_MS);
    if (live) raf = requestAnimationFrame(frame);
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
    return true;
  }

  /** Drop a sheaf on a grid. elev is metres above sea level at the impact
      point — the sim has no terrain lookup, so the caller owns it. */
  function fireMission(e, n, elev) {
    const t = performance.now();
    for (let i = 0; i < ROUNDS; i++) {
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
    return ROUNDS;
  }

  function clear() { bursts = []; kick(); }

  /** Screen point -> frame pixels. Dev tool only: nothing the student does
      needs this, because a call for fire names a grid, it does not click one. */
  function toFrame(clientX, clientY) {
    if (!box || !frameEl) return null;
    const fr = frameEl.getBoundingClientRect();
    const x = (clientX - fr.left - box.left) / box.scale;
    const y = (clientY - fr.top  - box.top ) / box.scale;
    return { x, y };
  }

  return { attach, fireMission, clear, toFrame, containBox, get box() { return box; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_RENDER;
