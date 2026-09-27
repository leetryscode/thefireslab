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
     SIM_RENDER.setMode('tv' | 'ir')     sensor mode; toggleMode() / mode()
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
  let creditBottomFr = 0;        /* where the imagery credit ends, in frame px */

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
    /* The HUD's heading tape sits under the imagery credit, whatever the credit
       is doing at this window size. The credit is sized in CSS px and the HUD
       in frame px, so measure the one and convert. */
    const credit = frameEl.querySelector('.sim-attribution');
    if (credit && box.scale > 0) {
      const cr = credit.getBoundingClientRect();
      creditBottomFr = (cr.bottom - fr.top - box.top) / box.scale;
    }
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
      cx2d.fillStyle = mode === 'ir' ? '#ffffff' : '#d8d2c4';
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
      /* In IR the flash is heat, so it is white rather than orange. */
      const ir = mode === 'ir';
      g.addColorStop(0,   'rgba(255, 247, 214, 1)');
      g.addColorStop(0.45, ir ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 178, 64, 0.95)');
      g.addColorStop(1,   ir ? 'rgba(235, 235, 235, 0)'    : 'rgba(190, 72, 20, 0)');
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

  /* ---------- burst smoke and heat ----------
     Every round leaves a plume that lasts PLUME_MS of SIM time and fades out
     gradually: grey smoke in TV, a white-hot bloom cooling to nothing in IR.

     A plume is a handful of puffs, and every puff is a pure function of the
     plume's age — where it is, how high, how big, how opaque. Nothing is
     integrated frame to frame, so a pause freezes it exactly, 3x reaches the
     same picture as 1x, and there is no per-frame state to go stale.

     The wind is applied on the GROUND, in grid metres, and projected at draw
     time — so a plume leans the way the ground says south is, foreshortened
     like everything else, rather than sliding down the screen.

     Nothing here reads or writes the engine. Smoke is a picture: it hides
     nothing from the adjudication that does not exist yet, and toggling the
     sensor mode cannot change an outcome. */
  const PLUME_MS        = 60000;   /* Lee: about 60 sim seconds */
  const PUFFS_PER_PLUME = 8;
  const MAX_PUFFS       = 768;     /* the cap; oldest plumes go first */
  const MAX_PLUMES      = Math.floor(MAX_PUFFS / PUFFS_PER_PLUME);
  const EMIT_S          = 4;       /* puffs leave the crater over the first 4 s */

  let plumes = [];
  let plumeSeq = 0;
  let mode = 'tv';                 /* 'tv' | 'ir' */

  const windNow = () => (typeof SIM_SCENARIO !== 'undefined' && SIM_SCENARIO.windGrid)
    ? SIM_SCENARIO.windGrid() : { e: 0, n: 0 };

  /* Deterministic per-puff variation. Math.random would be harmless here —
     nothing is graded on smoke — but a hash means the same round draws the
     same plume every time, which is what you want when comparing two runs. */
  function hash01(a, b) {
    let h = (a * 374761393 + b * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** The whole state of one plume at one age. Pure: plume, age in sim ms, and
      the grid wind in m/s in; puffs out. `smoke` and `heat` are the TV and IR
      envelopes, 0..1, and both are exactly 0 at PLUME_MS. */
  function plumeState(p, ageMs, wind) {
    if (!(ageMs >= 0) || ageMs > PLUME_MS) return null;
    const s = ageMs / 1000, x = ageMs / PLUME_MS;
    const fadeIn = Math.min(1, s / 0.4);
    const smoke = fadeIn * Math.pow(1 - x, 1.5);
    const heat  = Math.exp(-s / 20) * (1 - x);
    const w = wind || { e: 0, n: 0 };
    const puffs = [];
    for (let k = 0; k < PUFFS_PER_PLUME; k++) {
      const a = s - (k / PUFFS_PER_PLUME) * EMIT_S;    /* this puff's own age */
      if (a < 0) continue;
      const top = 25 + 20 * hash01(p.seed, k);        /* metres it rises to */
      const h = top * (1 - Math.exp(-a / 6));
      /* Smoke near the ground is held back by it; the higher a puff gets, the
         nearer it moves at the full wind. Integrated, not multiplied, so no puff
         ever outruns the wind: its speed is 1 - 0.4 e^(-a/6) of it, never more. */
      const carry = a - 2.4 * (1 - Math.exp(-a / 6));
      puffs.push({
        e: p.e + (hash01(p.seed, k + 50) - 0.5) * 6 + w.e * carry,
        n: p.n + (hash01(p.seed, k + 90) - 0.5) * 6 + w.n * carry,
        h,
        rM: 5 + 3.5 * Math.sqrt(a)
      });
    }
    return { smoke, heat, puffs };
  }

  /* One soft round sprite per colour, made once. A radial gradient per puff
     per frame is the expensive way to draw 700 puffs. */
  const sprites = {};
  function sprite(key, rgb) {
    if (sprites[key] !== undefined) return sprites[key];
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext && c.getContext('2d');
    if (!g) return (sprites[key] = null);
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0,    `rgba(${rgb}, 1)`);
    grad.addColorStop(0.55, `rgba(${rgb}, 0.55)`);
    grad.addColorStop(1,    `rgba(${rgb}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return (sprites[key] = c);
  }
  const SMOKE_RGB = '104, 100, 94';
  const HOT_RGB   = '255, 255, 255';

  function drawPlume(p, ageMs, wind) {
    const st = plumeState(p, ageMs, wind);
    if (!st) return;
    const ir = mode === 'ir';
    const k = ir ? st.heat : st.smoke;
    if (k <= 0.004) return;

    /* IR: the crater itself stays hot after the gas has gone. A ground disc,
       so it foreshortens with the view. */
    if (ir) {
      const disc = groundDisc(p.e, p.n, p.elev, 10, 12);
      if (disc) {
        cx2d.globalAlpha = 0.9 * k;
        cx2d.fillStyle = '#ffffff';
        tracePolygon(disc);
        cx2d.fill();
      }
    }

    const img = sprite(ir ? 'ir' : 'tv', ir ? HOT_RGB : SMOKE_RGB);
    const base = ir ? 0.8 : 0.85;
    for (const q of st.puffs) {
      const c = SIM_PROJ.worldToScreen(q.e, q.n, p.elev + q.h);
      if (!c || !c.inFront || !isFinite(c.x) || !isFinite(c.y)) continue;
      const r = Math.max(1, q.rM / metresPerPixel(c));
      /* A puff thins as it spreads. */
      cx2d.globalAlpha = base * k * Math.sqrt(Math.min(1, 8 / q.rM));
      if (img) cx2d.drawImage(img, c.x - r, c.y - r, 2 * r, 2 * r);
      else {
        cx2d.fillStyle = `rgb(${ir ? HOT_RGB : SMOKE_RGB})`;
        cx2d.beginPath();
        cx2d.arc(c.x, c.y, r, 0, Math.PI * 2);
        cx2d.fill();
      }
    }
    cx2d.globalAlpha = 1;
  }

  function addPlume(e, n, elev, t0) {
    plumes.push({ e, n, elev, t0, seed: ++plumeSeq });
    /* The cap. The oldest plume is also the faintest, so it goes first. */
    while (plumes.length > MAX_PLUMES) plumes.shift();
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
  const HULL_IR        = '#f6f6f1';   /* white-hot */

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

  /* ---------- class glyphs ----------
     Drawn from Lee's ops graphics as canvas paths rather than an image file:
     they stay crisp at any size, tint with the hostile colour, and keep the
     offline requirement (no new asset to ship). Coordinates are relative to the
     symbol centre and sized to sit inside the 48 x 30 px hostile diamond.

     Only the amphibious assault vehicle is drawn so far, because it is the only
     class on the field. The rest fall back to their abbreviation until Lee
     confirms each symbol. */
  const GLYPHS = {
    /* Armour ellipse, with the amphibious wave over it: two curves down the
       flanks and a crest rising through the middle. */
    'amphibious-assault-vehicle': (g, x, y) => {
      g.strokeStyle = HOSTILE;
      g.beginPath();
      g.ellipse(x, y, 13, 7, 0, 0, Math.PI * 2);
      g.stroke();

      g.beginPath();
      g.moveTo(x - 14.5, y - 8.5);
      g.quadraticCurveTo(x - 17, y + 1, x - 10.5, y + 8.5);
      g.moveTo(x + 14.5, y - 8.5);
      g.quadraticCurveTo(x + 17, y + 1, x + 10.5, y + 8.5);
      g.stroke();

      g.beginPath();
      g.moveTo(x - 8.5, y + 9);
      g.quadraticCurveTo(x, y - 13.5, x + 8.5, y + 9);
      g.stroke();
    }
  };

  /* The footprint and the symbol are drawn in two passes so smoke can sit
     between them: a plume should hide the vehicle, not the track symbol a
     student needs to read. The symbol code itself is unchanged. */
  function drawFootprint(v) {
    const centre = SIM_PROJ.worldToScreen(v.e, v.n, v.elev);
    if (!centre || !centre.inFront || !centre.inFrame) return null;

    const quad = groundQuad(v.e, v.n, v.elev, v.heading, v.lengthM, v.widthM);
    if (!quad) return null;

    /* Filled and stroked both: at long range the quad is sub-pixel and a fill
       alone can disappear into nothing, which would read as "no contact"
       rather than "a contact too far away to make out".
       In IR a running vehicle is the hottest thing on the ground, so its
       footprint goes white-hot. Only the footprint: the symbol is unchanged. */
    const hull = mode === 'ir' ? HULL_IR : HULL;
    cx2d.globalAlpha = v.state === 'destroyed' ? 0.35 : 1;
    cx2d.fillStyle = hull;
    tracePolygon(quad);
    cx2d.fill();
    cx2d.strokeStyle = hull;
    cx2d.lineWidth = 1;
    cx2d.stroke();
    cx2d.globalAlpha = 1;
    return { v, centre, quad };
  }

  function drawSymbol({ v, centre, quad }) {
    cx2d.globalAlpha = v.state === 'destroyed' ? 0.35 : 1;

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
    /* The plate stays. Transparent was tried on 2026-09-22 and Lee rejected it:
       over this imagery a stroke-only frame is unreadable against sand and surf,
       and the ground it revealed was worth less than the legibility it cost. */
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

    /* The class glyph if there is one, otherwise the abbreviation. Falling back
       to text rather than to nothing means a new class is legible the moment it
       is added, before anyone has drawn its symbol. */
    const glyph = GLYPHS[v.type];
    if (glyph) {
      cx2d.lineWidth = 1.4;
      glyph(cx2d, sx, sy);
    } else {
      cx2d.fillStyle = HOSTILE;
      cx2d.font = '600 15px "IBM Plex Mono", ui-monospace, monospace';
      cx2d.textAlign = 'center';
      cx2d.textBaseline = 'middle';
      cx2d.fillText(v.label, sx, sy + 0.5);
    }
    cx2d.globalAlpha = 1;
  }

  /* ---------- the HUD ----------
     Lee's schematic, 2026-09-26: a heading tape across the top, an elevation
     tape down the left, corner brackets on the line of sight, and the
     aircraft's position under ACRFT top right. Thin lines, no fills beyond the
     heading box, black in TV and white in IR, so it reads as sensor symbology
     laid over the picture and stays out of the way.

     EVERY NUMBER IS COMPUTED, never typed in:
       - sensor azimuth and elevation are the fitted camera in sim-camera.js
         (heading 124.14 true, tilt 69.44 from nadir = 20.56 below the horizon)
       - the brackets centre on the principal point (cx, cy), which is where
         the line of sight actually meets the picture — not the middle of the
         JPEG, which is 29 px right and 16 px up of it
       - the aircraft position is the camera position the fit derived
       - the aircraft heading is SIM_SCENARIO.PLATFORM, and that one IS
         invented; see the note there.
     Static, because the frame is: no drift, so nothing here moves. */
  const HUD = {
    tapeHalfW: 150,       /* heading tape: half-width, frame px */
    degPx: 5,             /* heading tape: px per degree -> +-30 deg shown */
    /* Elevation tape, 0 to -90. Held in the sea above the left-hand column:
       measured over the whole run, no contact symbol in the left 160 px ever
       rises above y 266, so the tape ends at 250. Lower and it sits on the
       left column's symbols (142 collisions when it ran 190-520). */
    elevTop: 120, elevH: 130, elevX: 60,
    bracketW: 300, bracketH: 250, bracketArm: 30,
    font: '500 15px "IBM Plex Mono", ui-monospace, monospace',
    margin: 22
  };
  const wrap360 = d => ((d % 360) + 360) % 360;
  const signed = d => { const x = wrap360(d + 180) - 180; return x; };
  const pad3 = n => String(Math.round(wrap360(n)) % 360).padStart(3, '0');

  /** Degrees and decimal minutes, the way the position reads on the feed. */
  function latLonText(lat, lon) {
    const dm = (v, degDigits, pos, neg) => {
      const h = v >= 0 ? pos : neg, a = Math.abs(v);
      let d = Math.floor(a), m = (a - d) * 60;
      if (+m.toFixed(3) >= 60) { d += 1; m = 0; }
      return `${h}${String(d).padStart(degDigits, '0')}°${m.toFixed(3).padStart(6, '0')}'`;
    };
    return [dm(lat, 2, 'N', 'S'), dm(lon, 3, 'E', 'W')];
  }

  /** The HUD's numbers, pure, so the suite can check them without a canvas. */
  function hudValues() {
    const cam = (typeof SIM_CAMERA !== 'undefined') ? SIM_CAMERA : null;
    if (!cam) return null;
    const plat = (typeof SIM_SCENARIO !== 'undefined' && SIM_SCENARIO.PLATFORM) || { headingTrueDeg: cam.view.heading_deg };
    const sensorAz = wrap360(cam.view.heading_deg);
    const sensorEl = -(90 - cam.view.tilt_deg);        /* negative = below the horizon */
    const heading = wrap360(plat.headingTrueDeg);
    return {
      heading, sensorAz, sensorEl,
      sensorRel: signed(sensorAz - heading),
      boresight: { x: cam.intrinsics.cx, y: cam.intrinsics.cy },
      acft: latLonText(cam.camera.lat, cam.camera.lon),
      headingText: pad3(heading),
      relText: (signed(sensorAz - heading) >= 0 ? '+' : '') + Math.round(signed(sensorAz - heading)),
      elText: String(Math.round(sensorEl)),
      /* Screen rotation of the north arrow, clockwise positive: up on the
         glass is the sensor's line of sight, so north sits at minus the
         sensor azimuth. The usual FMV convention — a compass relative to the
         look direction, not the foreshortened direction of north across the
         ground at the boresight. */
      northRotDeg: -sensorAz
    };
  }

  function drawHud() {
    const v = hudValues();
    if (!v) return;
    const ink = mode === 'ir' ? '#ffffff' : '#000000';
    const W = (typeof SIM_CAMERA !== 'undefined') ? SIM_CAMERA.frame.width : 1860;
    const g = cx2d;
    g.save();
    g.globalAlpha = 0.85;
    g.strokeStyle = ink; g.fillStyle = ink;
    g.lineWidth = 1.5;
    g.font = HUD.font;
    g.textBaseline = 'middle';

    /* -- heading tape: centred on the aircraft's heading, sensor caret below -- */
    const cx = v.boresight.x;
    const boxTop = Math.max(HUD.margin, creditBottomFr + 8);
    const boxH = 20, tapeY = boxTop + boxH + 26;
    const x0 = cx - HUD.tapeHalfW, x1 = cx + HUD.tapeHalfW;
    g.beginPath();
    g.moveTo(x0, tapeY); g.lineTo(x1, tapeY);
    const span = HUD.tapeHalfW / HUD.degPx;
    for (let d = Math.ceil((v.heading - span) / 5) * 5; d <= v.heading + span; d += 5) {
      const x = cx + (d - v.heading) * HUD.degPx;
      const len = (wrap360(d) % 10 === 0) ? 16 : 8;
      g.moveTo(x, tapeY); g.lineTo(x, tapeY - len);
    }
    g.stroke();
    /* the heading box and its pointer */
    g.beginPath();
    g.rect(cx - 22, boxTop, 44, boxH);
    g.moveTo(cx - 9, boxTop + boxH); g.lineTo(cx, boxTop + boxH + 9); g.lineTo(cx + 9, boxTop + boxH);
    g.stroke();
    g.textAlign = 'center';
    g.fillText(v.headingText, cx, boxTop + boxH / 2 + 1);
    /* the sensor caret, pinned to the end of the tape if it is off the scale */
    const rel = v.sensorRel;
    const sx = cx + Math.max(-span, Math.min(span, rel)) * HUD.degPx;
    g.beginPath();
    g.moveTo(sx - 8, tapeY + 12); g.lineTo(sx, tapeY + 2); g.lineTo(sx + 8, tapeY + 12);
    g.stroke();
    g.fillText(v.relText, sx, tapeY + 24);

    /* -- elevation tape: 0 at the top, -90 at the bottom, caret on the sensor -- */
    const ex = HUD.elevX, et = HUD.elevTop, eh = HUD.elevH;
    g.beginPath();
    g.moveTo(ex, et); g.lineTo(ex, et + eh);
    for (let d = 0; d <= 90; d += 10) {
      const y = et + (d / 90) * eh;
      const len = d % 30 === 0 ? 22 : 12;
      g.moveTo(ex, y); g.lineTo(ex - len, y);
    }
    g.stroke();
    const ey = et + Math.min(1, Math.max(0, -v.sensorEl / 90)) * eh;
    g.beginPath();
    g.moveTo(ex + 18, ey - 9); g.lineTo(ex + 6, ey); g.lineTo(ex + 18, ey + 9);
    g.stroke();
    g.textAlign = 'left';
    g.fillText(v.elText, ex + 22, ey + 1);

    /* -- brackets on the line of sight -- */
    const bx = v.boresight.x, by = v.boresight.y;
    const hw = HUD.bracketW / 2, hh = HUD.bracketH / 2, a = HUD.bracketArm;
    g.beginPath();
    for (const [sxn, syn] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const px = bx + sxn * hw, py = by + syn * hh;
      g.moveTo(px - sxn * a, py); g.lineTo(px, py); g.lineTo(px, py - syn * a);
    }
    g.stroke();

    /* -- north arrow, in the top-right corner -- */
    const nr = 20, ncx = W - HUD.margin - nr, ncy = boxTop + nr + 4;
    g.save();
    g.translate(ncx, ncy);
    g.rotate(v.northRotDeg * Math.PI / 180);
    g.beginPath();
    g.moveTo(0, nr); g.lineTo(0, -nr);                                 /* shaft */
    g.moveTo(-7, -nr + 10); g.lineTo(0, -nr); g.lineTo(7, -nr + 10);   /* head */
    g.stroke();
    g.restore();
    /* The N stays upright, just beyond the arrowhead. */
    const nt = v.northRotDeg * Math.PI / 180;
    g.textAlign = 'center';
    g.fillText('N', ncx + Math.sin(nt) * (nr + 10), ncy - Math.cos(nt) * (nr + 10));

    /* -- the aircraft's position, top right, beside the north arrow -- */
    g.textAlign = 'right';
    const rx = W - HUD.margin - 2 * nr - 44;
    g.fillText('ACRFT', rx, boxTop + 8);
    g.fillText(v.acft[0], rx, boxTop + 28);
    g.fillText(v.acft[1], rx, boxTop + 46);

    g.restore();
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

    /* Order: footprints, then smoke over them, then the symbols, then the
       bursts. A round landing on a vehicle should obscure it, and so should its
       smoke — but never the symbol the student is reading. */
    let drawn = [];
    if (entitySource) {
      let vs = null;
      try { vs = entitySource(); } catch (err) { console.error('[sim-render] entity source threw', err); }
      if (vs) for (const v of vs) { const d = drawFootprint(v); if (d) drawn.push(d); }
    }

    const now = simNow();
    plumes = plumes.filter(p => now - p.t0 <= PLUME_MS);
    const wind = windNow();
    for (const p of plumes) {
      const age = now - p.t0;
      if (age >= 0) drawPlume(p, age, wind);
    }

    for (const d of drawn) drawSymbol(d);

    let live = 0;
    for (const b of bursts) {
      const age = now - b.t0;
      if (age < 0) { live++; continue; }
      if (age > BURST_MS) continue;
      drawBurst(b, age);
      live++;
    }
    bursts = bursts.filter(b => now - b.t0 <= BURST_MS);

    /* The HUD last: it is symbology on the glass, over everything. */
    drawHud();

    /* Self-drive only when nothing else is driving. With a clock playing, the
       next frame arrives through SIM_CLOCK.onFrame; with a clock paused the
       picture cannot change, so one draw is the whole job. */
    if ((live || plumes.length) && !hasClock()) raf = requestAnimationFrame(frame);
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
      unhook.push(SIM_CLOCK.onChange(s => { if (s.reason === 'stop') { bursts = []; plumes = []; } kick(); }));
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
      const b = {
        e: e + Math.cos(a) * r * SPREAD_DEFL_M,
        n: n + Math.sin(a) * r * SPREAD_RANGE_M,
        elev: elev || 0,
        t0: t + i * STAGGER_MS + Math.random() * STAGGER_MS
      };
      bursts.push(b);
      addPlume(b.e, b.n, b.elev, b.t0);
    }
    kick();
    return shots;
  }

  function clear() { bursts = []; plumes = []; kick(); }

  /** Sensor mode. TV is the colour picture; IR puts a CSS filter on the image
      (the .is-ir class, styled in css/sim.css) and redraws the overlay white-hot.
      Pure presentation: it touches the frame's class and this file's colours,
      and nothing the clock, the entities or the missions can see. */
  function setMode(m) {
    mode = (m === 'ir') ? 'ir' : 'tv';
    if (frameEl) frameEl.classList.toggle('is-ir', mode === 'ir');
    kick();
    return mode;
  }
  const toggleMode = () => setMode(mode === 'ir' ? 'tv' : 'ir');

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
           groundQuad, setMode, toggleMode, mode: () => mode,
           plumeState, plumeCount: () => plumes.length, hudValues, latLonText,
           PLUME_MS, PUFFS_PER_PLUME, MAX_PUFFS,
           get box() { return box; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_RENDER;
