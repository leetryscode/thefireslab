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
     SIM_RENDER.mark() / clearMark()     the clicked grid, and clearing it
    SIM_RENDER.bracketed() / groupTag(vs)  ids under the hover bracket; its tag text
    SIM_RENDER.setObstacleSource(fn)    fn() -> debris lines (SIM_ENTITIES.obstacles())
     SIM_RENDER.toFrame(clientX, clientY)  screen point -> frame px (dev tool)
   ========================================================= */

const SIM_RENDER = (() => {

  /* Language (js/sim-i18n.js): the words on the overlay translate; class codes
     (AAV, FUEL, ENG, LCU), grids and numbers do not (Lee, 2026-09-28). */
  const T = (k, en, v) => (typeof SIM_I18N !== 'undefined') ? SIM_I18N.t(k, en, v)
    : (v ? en.replace(/\{(\w+)\}/g, (m, x) => (x in v ? v[x] : m)) : en);

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
     A small to-scale dark footprint, and nothing standing above it. The
     floating flags (a leader up to a hostile diamond with the class glyph)
     were cut by Lee on 2026-09-27: over a busy feed they stacked into a wall of
     white plates. Identification now comes from the hover bracket below.

     THE FOOTPRINT IS FOUR PROJECTED GROUND CORNERS, never an axis-aligned rect.
     An oblique view compresses range about three times harder than deflection,
     so a ground rectangle is a trapezoid on screen whose shape changes with
     both position and heading. Projecting the corners costs nothing and gives
     the foreshortening and the heading for free.

     It is honestly to scale, which means it is tiny at range — a 35 m craft is
     about 2 px deep at 4.6 km. Below MIN_SMUDGE_PX it is drawn as a smudge of
     that size instead, so a far contact reads as "something too far away to
     make out" rather than vanishing. */
  const HULL           = '#22201c';
  const HULL_IR        = '#f6f6f1';   /* white-hot */
  const MIN_SMUDGE_PX  = 3;

  let entitySource = null;
  let obstacleSource = null;

  /* ---------- obstacles: rubble and fallen trees ----------
     Lee, 2026-09-27. What the student sees at an obstacle, drawn from the
     RUBBLE nn / TREES nn lines he traces in Google Earth (SIM_ENTITIES
     .obstacles()). Pieces are laid along each line with some spread either
     side, from a generator seeded by the line's NAME — so they are the same
     every run and every reload, and only move when he redraws the line.

     THE BREACH SHOWS. Pieces within LANE_HALF_M of the lane are put in a
     clearing order (see piecesFor) and go one at a time as the lane's
     progress runs from 0 to 1. A breach in
     progress eats into the pile from the near side; a killed engineer leaves
     the gap half-cut; an open lane is a clear road through the debris.

     Sizes are deliberately a little larger than life (DEBRIS_SCALE): at 2 km
     a metre is about one pixel across and 2.5 deep, and a to-scale lump of
     rubble would be a speck. Cool, not hot: dark grey in IR, so the white-hot
     vehicles still pop against it. */
  const LANE_HALF_M   = 6;
  const DEBRIS_SCALE  = { rubble: 2.6, trees: 1.3 };   /* larger than life, so it reads */
  const debrisPieces  = new Map();       /* id + geometry -> generated pieces */

  function seeded(str) {                 /* mulberry32 over a string hash */
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a);
                   x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  }

  /** Distance from a point to a polyline, and how far along it (0..1) the
      nearest point lies. Pure; metres. */
  function alongLine(p, line) {
    let total = 0; const segs = [];
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1], len = Math.hypot(b.e - a.e, b.n - a.n);
      segs.push({ a, b, len, start: total }); total += len;
    }
    let best = { d: Infinity, u: 0 };
    for (const s of segs) {
      const ax = s.b.e - s.a.e, ay = s.b.n - s.a.n, L2 = ax * ax + ay * ay;
      const f = L2 > 0 ? Math.max(0, Math.min(1, ((p.e - s.a.e) * ax + (p.n - s.a.n) * ay) / L2)) : 0;
      const d = Math.hypot(p.e - s.a.e - f * ax, p.n - s.a.n - f * ay);
      if (d < best.d) best = { d, u: total > 0 ? (s.start + f * s.len) / total : 0 };
    }
    best.total = total;
    return best;
  }

  /** The pieces of one debris line: {e, n, kind, size, rot, tone, verts, u}.
      u is the piece's place along the lane, or null if it is not on the lane.
      Pure given the line; cached by name and geometry. */
  function piecesFor(ob) {
    const key = ob.id + '|' + ob.points.map(p => p.e.toFixed(1) + ',' + p.n.toFixed(1)).join(';') +
                '|' + (ob.laneLine || []).map(p => p.e.toFixed(1) + ',' + p.n.toFixed(1)).join(';');
    if (debrisPieces.has(key)) return debrisPieces.get(key);
    const rnd = seeded(ob.id);
    const trees = ob.style === 'trees';
    const spacing = trees ? 4 : 1.8, spread = trees ? 4 : 3.5;
    const out = [];
    for (let i = 0; i < ob.points.length - 1; i++) {
      const a = ob.points[i], b = ob.points[i + 1];
      const len = Math.hypot(b.e - a.e, b.n - a.n);
      if (!(len > 0)) continue;
      const fx = (b.e - a.e) / len, fy = (b.n - a.n) / len;       /* along */
      const n = Math.max(1, Math.round(len / spacing));
      for (let k = 0; k < n; k++) {
        const s = (k + 0.2 + 0.6 * rnd()) / n * len;
        const off = (rnd() * 2 - 1) * spread * (trees ? 1 : (0.6 + 0.4 * rnd()));
        const p = { e: a.e + fx * s - fy * off, n: a.n + fy * s + fx * off };
        const piece = { e: p.e, n: p.n, rot: rnd() * Math.PI, tone: rnd() };
        if (trees) {
          piece.kind = 'tree';
          piece.size = (8 + 7 * rnd()) * DEBRIS_SCALE.trees;                 /* trunk length, m */
        } else {
          piece.kind = 'rubble';
          piece.size = (1.2 + 1.8 * rnd() * rnd()) * DEBRIS_SCALE.rubble;     /* radius, m: mostly small */
          const nv = 5 + Math.floor(rnd() * 3);
          piece.verts = [...Array(nv)].map((_, j) => ({ a: j / nv * 2 * Math.PI + (rnd() - 0.5) * 0.6, r: 0.6 + 0.4 * rnd() }));
        }
        if (ob.laneLine && ob.laneLine.length >= 2) {
          const q = alongLine(p, ob.laneLine);
          piece.key = q.d <= LANE_HALF_M ? q.u * q.total + q.d : null;
        } else piece.key = null;
        out.push(piece);
      }
    }
    /* Clearing order. Each piece on the lane is ranked by metres along the lane
       from the breacher's end, plus its distance off the lane's centre line.
       Debris drawn DOWN the lane then clears front to back; debris drawn
       ACROSS it (every piece at about the same place along the lane) clears
       from the centre outward. Either way it goes a piece at a time, and u is
       the fraction of the breach at which the piece is gone. */
    const onLane = out.filter(pc => pc.key !== null).sort((x, y) => x.key - y.key);
    onLane.forEach((pc, i) => { pc.u = (i + 1) / onLane.length; });
    for (const pc of out) if (pc.key === null) pc.u = null;
    /* Trees are drawn far to near so a nearer trunk lies over a farther one. */
    out.sort((x, y) => y.n - x.n);
    debrisPieces.set(key, out);
    return out;
  }

  /** Is this piece still there, given how far the breach has got? */
  const pieceStands = (pc, progress) => pc.u === null || pc.u > progress;

  function drawDebris(ob) {
    const ir = mode === 'ir';
    const pieces = piecesFor(ob);
    const drawn = [];
    for (const pc of pieces) {
      const elev = (typeof SIM_TERRAIN !== 'undefined') ? SIM_TERRAIN.elevAt(pc.e, pc.n) : 0;
      const c = SIM_PROJ.worldToScreen(pc.e, pc.n, elev);
      if (!c || !c.inFront || !isFinite(c.x) || !isFinite(c.y)) continue;
      drawn.push({ x: c.x, y: c.y });
      if (!pieceStands(pc, ob.progress)) continue;
      if (pc.kind === 'tree') {
        const hx = Math.sin(pc.rot) * pc.size / 2, hy = Math.cos(pc.rot) * pc.size / 2;
        const A = SIM_PROJ.worldToScreen(pc.e - hx, pc.n - hy, elev), B = SIM_PROJ.worldToScreen(pc.e + hx, pc.n + hy, elev);
        if (!A || !B) continue;
        cx2d.lineCap = 'round';
        cx2d.strokeStyle = ir ? '#2c2c2c' : (pc.tone < 0.5 ? '#4a3a28' : '#5b4630');
        cx2d.lineWidth = 3;
        cx2d.beginPath(); cx2d.moveTo(A.x, A.y); cx2d.lineTo(B.x, B.y); cx2d.stroke();
        /* the crown, at the far end of the trunk: a dark leafy smudge */
        const r = Math.max(2.5, 3 * DEBRIS_SCALE.trees / metresPerPixel(B));
        cx2d.fillStyle = ir ? '#383838' : (pc.tone < 0.5 ? '#2e4424' : '#3d5230');
        cx2d.beginPath(); cx2d.ellipse(B.x, B.y, r, r * 0.55, 0, 0, Math.PI * 2); cx2d.fill();
      } else {
        const poly = [];
        for (const v of pc.verts) {
          const q = SIM_PROJ.worldToScreen(pc.e + Math.cos(v.a + pc.rot) * pc.size * v.r,
                                           pc.n + Math.sin(v.a + pc.rot) * pc.size * v.r, elev);
          if (!q) { poly.length = 0; break; }
          poly.push(q);
        }
        if (!poly.length) continue;
        /* Dark broken masonry with a pale chip on each lump: a pile reads as
           texture — dark and light together — where a flat grey would sink
           into the road. */
        const TV = ['#57514a', '#6b645b', '#48433d', '#7a7267'], IR = ['#2a2a2a', '#353535', '#222222', '#404040'];
        cx2d.fillStyle = (ir ? IR : TV)[Math.floor(pc.tone * 4)];
        tracePolygon(poly);
        cx2d.fill();
        cx2d.strokeStyle = ir ? '#151515' : '#2e2a26';
        cx2d.lineWidth = 0.8;
        cx2d.stroke();
        const hi = poly[Math.floor(pc.tone * poly.length) % poly.length];
        cx2d.fillStyle = ir ? '#8a8a8a' : '#c9bfae';
        cx2d.beginPath(); cx2d.arc((hi.x + c.x) / 2, (hi.y + c.y) / 2, 0.9, 0, Math.PI * 2); cx2d.fill();
      }
    }
    return drawn.length ? { ob, pts: drawn } : null;
  }


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

  function drawFootprint(v) {
    const centre = SIM_PROJ.worldToScreen(v.e, v.n, v.elev);
    if (!centre || !centre.inFront || !centre.inFrame) return null;

    const quad = groundQuad(v.e, v.n, v.elev, v.heading, v.lengthM, v.widthM);
    if (!quad) return null;

    /* Filled and stroked both: at long range the quad is sub-pixel and a fill
       alone can disappear into nothing, which would read as "no contact"
       rather than "a contact too far away to make out".
       In IR a running vehicle is the hottest thing on the ground, so its
       footprint goes white-hot. */
    /* A STOPPED vehicle is shaded differently (Lee, 2026-09-27), full strength
       so it still reads at range: burnt rust in TV; in IR it fades from
       white-hot to a cooled grey as its heat dies (wreckHeat below). */
    const hull = v.stopped ? wreckHull(v, simNow())
               : (mode === 'ir' ? HULL_IR : HULL);
    cx2d.globalAlpha = 1;
    cx2d.fillStyle = hull;
    const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
    if (Math.max(...xs) - Math.min(...xs) < MIN_SMUDGE_PX && Math.max(...ys) - Math.min(...ys) < MIN_SMUDGE_PX) {
      const h = MIN_SMUDGE_PX / 2;
      cx2d.fillRect(centre.x - h, centre.y - h, MIN_SMUDGE_PX, MIN_SMUDGE_PX);
    } else {
      tracePolygon(quad);
      cx2d.fill();
      cx2d.strokeStyle = hull;
      cx2d.lineWidth = 1;
      cx2d.stroke();
    }
    cx2d.globalAlpha = 1;
    return { v, centre, quad };
  }

  /* ---------- wrecks ----------
     Lee, 2026-09-27: a stopped vehicle stays on the field for the whole run,
     shaded differently, and smokes. FUEL trucks burn bigger and longer with
     more smoke; everything else (ZBD, engineers) smoulders thin, so it does
     not hide the ground.

     Like the burst plumes, every puff is a pure function of the wreck's age —
     emitted on a fixed cadence from the moment it stopped — so a pause freezes
     it, 30x reaches the same picture, and nothing is stored per frame. A
     picture only: nothing here touches the engine. */
  const WRECK = {
    /* a fuel fire: ~15 min of heavy smoke rising to 60-80 m, a flame at the base */
    logistics: { burnS: 900, emitS: 1.2, lifeS: 45, rise: 70, r0: 6, grow: 4.5, alpha: 0.5,  heatS: 480, fire: true,  hotM: 9 },
    /* armour, engineers: ~5 min of a thin wisp */
    other:     { burnS: 300, emitS: 2.5, lifeS: 25, rise: 35, r0: 2.5, grow: 1.8, alpha: 0.16, heatS: 120, fire: false, hotM: 4 }
  };
  const WRECK_TV = '#6b4a33';          /* burnt rust */
  const WRECK_IR_COLD = [112, 112, 108];
  const wreckSpec = v => WRECK[v.type] || WRECK.other;
  function idSeed(id) { let h = 2166136261; for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  /** 0..1, how hot the wreck still is. 1 at the moment it stops. */
  function wreckHeat(v, nowMs) {
    if (!v.stopped || typeof v.stoppedAt !== 'number') return 0;
    const s = nowMs / 1000 - v.stoppedAt;
    if (s < 0) return 0;
    return Math.exp(-s / wreckSpec(v).heatS);
  }
  function wreckHull(v, nowMs) {
    if (mode !== 'ir') return WRECK_TV;
    const k = wreckHeat(v, nowMs);
    const c = WRECK_IR_COLD.map(x => Math.round(x + (246 - x) * k));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }

  /** The whole smoke column of one wreck at one moment. Pure: vehicle (with
      stoppedAt in sim seconds), now in sim ms, grid wind m/s. Puffs out, each
      with ground e/n, height h, radius rM and opacity a; plus `fire` 0..1 (the
      flame at the base) and `heat` 0..1. */
  function wreckState(v, nowMs, wind) {
    if (!v || !v.stopped || typeof v.stoppedAt !== 'number') return null;
    const sp = wreckSpec(v);
    const now = nowMs / 1000, t0 = v.stoppedAt;
    if (now < t0) return null;
    const end = t0 + sp.burnS;
    const w = wind || { e: 0, n: 0 };
    const seed = idSeed(v.id);
    const puffs = [];
    const kLo = Math.max(0, Math.ceil((now - sp.lifeS - t0) / sp.emitS));
    const kHi = Math.floor((Math.min(now, end) - t0) / sp.emitS);
    for (let k = kLo; k <= kHi; k++) {
      const tE = t0 + k * sp.emitS, a = now - tE;
      if (a < 0 || a >= sp.lifeS) continue;
      /* the fire dies down over its last minute, and so does its smoke */
      const dying = Math.min(1, (end - tE) / 60);
      const carry = a - 2.4 * (1 - Math.exp(-a / 6));
      puffs.push({
        e: v.e + (hash01(seed, k) - 0.5) * 4 + w.e * carry,
        n: v.n + (hash01(seed, k + 7) - 0.5) * 4 + w.n * carry,
        h: sp.rise * (0.7 + 0.3 * hash01(seed, k + 13)) * (1 - Math.exp(-a / 8)),
        rM: sp.r0 + sp.grow * Math.sqrt(a),
        a: sp.alpha * (1 - a / sp.lifeS) * Math.min(1, a / 0.6) * dying
      });
    }
    const burning = now < end ? Math.min(1, (end - now) / 60) : 0;
    return { puffs, fire: sp.fire ? burning : 0, heat: wreckHeat(v, nowMs), hotM: sp.hotM };
  }

  function drawWreck(v, nowMs, wind) {
    const st = wreckState(v, nowMs, wind);
    if (!st) return;
    const ir = mode === 'ir';
    /* IR: the wreck itself stays a hot spot while it cools. */
    if (ir && st.heat > 0.02) {
      const disc = groundDisc(v.e, v.n, v.elev, st.hotM, 12);
      if (disc) { cx2d.globalAlpha = 0.85 * st.heat; cx2d.fillStyle = '#ffffff'; tracePolygon(disc); cx2d.fill(); }
    }
    /* TV: flame at the base of a burning fuel truck, flickering on sim time. */
    if (!ir && st.fire > 0) {
      const c = SIM_PROJ.worldToScreen(v.e, v.n, v.elev + 2);
      if (c && c.inFront) {
        const flick = 0.75 + 0.25 * hash01(idSeed(v.id), Math.floor(nowMs / 120));
        const r = Math.max(1.5, (5 * flick) / metresPerPixel(c));
        const g = cx2d.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        g.addColorStop(0, 'rgba(255, 236, 170, 1)');
        g.addColorStop(0.5, 'rgba(255, 140, 40, 0.85)');
        g.addColorStop(1, 'rgba(200, 60, 10, 0)');
        cx2d.globalAlpha = st.fire * flick;
        cx2d.fillStyle = g;
        cx2d.beginPath(); cx2d.arc(c.x, c.y, r, 0, Math.PI * 2); cx2d.fill();
      }
    }
    const img = sprite(ir ? 'ir' : 'tv', ir ? HOT_RGB : SMOKE_RGB);
    for (const q of st.puffs) {
      const c = SIM_PROJ.worldToScreen(q.e, q.n, v.elev + q.h);
      if (!c || !c.inFront || !isFinite(c.x) || !isFinite(c.y)) continue;
      const r = Math.max(1, q.rM / metresPerPixel(c));
      /* In IR the smoke is only as bright as the fire under it. */
      cx2d.globalAlpha = q.a * (ir ? 0.7 * Math.max(st.heat, 0.15) : 1);
      if (img) cx2d.drawImage(img, c.x - r, c.y - r, 2 * r, 2 * r);
    }
    cx2d.globalAlpha = 1;
  }

  /* ---------- Predator drones in flight ----------
     Lee, 2026-09-28: visible in flight, a tiny bracket when hovered. A small
     delta at the drone's height, dark with a light halo in TV, white-hot in IR.
     Positions come from SIM_DRONES.list() — a picture of the engine's drones,
     never a decision. */
  let droneSource = null;
  const DRONE_PX = 3.5;
  /* Lee's Switchblade silhouette, 2026-09-28: a fuselage with a pointed nose,
     a long front wing and a shorter rear wing. Unit = fuselage length; u runs
     nose-ward, v across. Drawn in screen space (not foreshortened) so it reads
     at a few pixels, nose along the flight path. */
  const DRONE_SHAPE = (() => {
    const half = [[0.5, 0], [0.42, 0.08], [0.21, 0.08], [0.21, 0.68], [0.01, 0.68], [0.01, 0.08],
                  [-0.30, 0.08], [-0.30, 0.55], [-0.49, 0.55], [-0.49, 0]];
    const mirror = half.slice(1, -1).reverse().map(([u, v]) => [u, -v]);
    return half.concat(mirror);
  })();
  const DRONE_LEN_PX = 6.2;      /* nose to tail; front span ~8.4 px, about the old triangle */
  function drawDrone(q) {
    const g0 = (typeof SIM_TERRAIN !== 'undefined' && SIM_TERRAIN.elevAt) ? SIM_TERRAIN.elevAt(q.e, q.n) : 0;
    const c = SIM_PROJ.worldToScreen(q.e, q.n, g0 + q.h);
    if (!c || !c.inFront || !isFinite(c.x) || !isFinite(c.y)) return null;
    const ir = mode === 'ir';
    const r = DRONE_PX;
    let fx = 0, fy = -1;                    /* nose up the screen if the path is unknown */
    if (q.prev) {
      const g1 = (typeof SIM_TERRAIN !== 'undefined' && SIM_TERRAIN.elevAt) ? SIM_TERRAIN.elevAt(q.prev.e, q.prev.n) : 0;
      const b = SIM_PROJ.worldToScreen(q.prev.e, q.prev.n, g1 + q.prev.h);
      if (b && b.inFront && isFinite(b.x) && isFinite(b.y)) {
        const dx = c.x - b.x, dy = c.y - b.y, L = Math.hypot(dx, dy);
        if (L > 1e-3) { fx = dx / L; fy = dy / L; }
      }
    }
    const s = DRONE_LEN_PX;
    const tri = () => {
      cx2d.beginPath();
      DRONE_SHAPE.forEach(([u, v], i) => {
        const x = c.x + (fx * u - fy * v) * s, y = c.y + (fy * u + fx * v) * s;
        if (i) cx2d.lineTo(x, y); else cx2d.moveTo(x, y);
      });
      cx2d.closePath();
    };
    cx2d.globalAlpha = 1;
    cx2d.lineJoin = 'round';
    cx2d.lineWidth = 2; cx2d.strokeStyle = ir ? '#000000' : '#f4f1e8'; tri(); cx2d.stroke();
    cx2d.fillStyle = ir ? '#ffffff' : '#141414'; tri(); cx2d.fill();
    cx2d.lineJoin = 'miter';
    const quad = [{ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y - r }, { x: c.x + r, y: c.y + r }, { x: c.x - r, y: c.y + r }];
    return { v: { id: q.id, type: 'owa', label: 'OWA' }, centre: c, quad };
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
       rose above y 266, so the tape ends at 250. (Measured against the old
       floating flags, cut 2026-09-27; footprints sit lower still.) */
    elevTop: 120, elevH: 130, elevX: 60,
    bracketW: 300, bracketH: 250, bracketArm: 30,
    font: '500 15px "IBM Plex Mono", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", ui-monospace, monospace',
    margin: 22,
    top: 43              /* frame px, heading box and ACRFT block */
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
    /* Fixed. It used to sit below the imagery credit; the credit moved to the
       bottom (2026-09-26) and Lee kept the HUD where it was, which is this. */
    const boxTop = HUD.top;
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
    g.fillText(T('sim.hud.north', 'N'), ncx + Math.sin(nt) * (nr + 10), ncy - Math.cos(nt) * (nr + 10));

    /* -- the aircraft's position, top right, beside the north arrow -- */
    g.textAlign = 'right';
    const rx = W - HUD.margin - 2 * nr - 44;
    g.fillText(T('sim.hud.acrft', 'ACRFT'), rx, boxTop + 8);
    g.fillText(v.acft[0], rx, boxTop + 28);
    g.fillText(v.acft[1], rx, boxTop + 46);

    g.restore();
  }

  /* ---------- sway: the picture drifts like a stabilised ISR ball ----------
     Lee, 2026-09-26: a small, slow sway, and the view pulled a little toward
     the mouse, just enough for the illusion of a live feed.

     THE CALIBRATION SURVIVES BECAUSE EVERYTHING ON THE GROUND MOVES AS ONE.
     The picture is zoomed ZOOM about its centre so a drift never shows an
     edge, and that same zoom-and-offset is applied, with the same numbers,
     to the image (a CSS transform) and to the ground layer of the canvas
     (footprints, smoke, bursts). A burst still lands on the pixel
     the projection says, because the pixel moved with it. The HUD is drawn
     after the ground layer is restored, so it stays fixed on the glass, the
     way sensor symbology does.

     The sway runs on SIM time, like everything else in this file: a pause
     freezes it, and at 3x it drifts three times as fast. The mouse pull eases
     toward its target a fixed fraction per drawn frame and asks for frames
     until it settles, so it also works while paused.

     Presentation only. Nothing here is read by the clock, the entities or the
     missions, and the call for fire names a grid, not a pixel. */
  const VIEW = {
    zoom: 1.04,
    /* frame px. The zoom leaves (zoom - 1) / 2 of the frame spare on each
       side: 37 px across and 14 px up and down. Sway plus full pull stays
       inside that, so no edge ever shows. */
    swayX: 10, swayY: 4,
    pullX: 22, pullY: 8,
    ease: 0.08
  };
  let pull = { x: 0, y: 0 }, pullTarget = { x: 0, y: 0 };
  let still = false;       /* prefers-reduced-motion: zoom kept, no movement */

  /** The sway at a sim time, in frame px. Pure. Two slow sines per axis at
      unrelated periods, so it never visibly repeats. */
  function swayAt(tSec) {
    const T = 2 * Math.PI;
    return {
      x: VIEW.swayX * (0.65 * Math.sin(T * tSec / 23) + 0.35 * Math.sin(T * tSec / 9.7 + 1.3)),
      y: VIEW.swayY * (0.6 * Math.sin(T * tSec / 17 + 0.7) + 0.4 * Math.sin(T * tSec / 7.3 + 2.1))
    };
  }

  /** frame px -> where it shows on the zoomed, shifted picture, and back. */
  function frameSize() {
    return (typeof SIM_CAMERA !== 'undefined') ? SIM_CAMERA.frame : { width: 1860, height: 707 };
  }
  function viewApply(p, v) {
    const F = frameSize(), cx = F.width / 2, cy = F.height / 2;
    return { x: cx + v.dx + v.zoom * (p.x - cx), y: cy + v.dy + v.zoom * (p.y - cy) };
  }
  function viewInvert(p, v) {
    const F = frameSize(), cx = F.width / 2, cy = F.height / 2;
    return { x: cx + (p.x - cx - v.dx) / v.zoom, y: cy + (p.y - cy - v.dy) / v.zoom };
  }

  let view = { zoom: VIEW.zoom, dx: 0, dy: 0 };
  function updateView() {
    const t = hasClock() ? SIM_CLOCK.renderMs() / 1000 : 0;
    const s = still ? { x: 0, y: 0 } : swayAt(t);
    pull.x += (pullTarget.x - pull.x) * VIEW.ease;
    pull.y += (pullTarget.y - pull.y) * VIEW.ease;
    if (Math.abs(pullTarget.x - pull.x) < 0.05 && Math.abs(pullTarget.y - pull.y) < 0.05) pull = { ...pullTarget };
    view = { zoom: VIEW.zoom, dx: s.x + pull.x, dy: s.y + pull.y };
    if (imgEl && box) {
      imgEl.style.transformOrigin = '50% 50%';
      imgEl.style.transform =
        `translate(${(view.dx * box.scale).toFixed(3)}px, ${(view.dy * box.scale).toFixed(3)}px) scale(${view.zoom})`;
    }
    return pull.x !== pullTarget.x || pull.y !== pullTarget.y;   /* still easing */
  }

  /* Mouse toward an edge = the sensor looks that way, so the picture slides
     the other way. Normalised to the frame, so it is the same on any window. */
  function onPointer(ev) {
    if (still || !frameEl || mark) return;      /* locked: the view holds */
    const r = frameEl.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    const nx = Math.max(-1, Math.min(1, ((ev.clientX - r.left) / r.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((ev.clientY - r.top) / r.height) * 2 - 1));
    pullTarget = { x: -nx * VIEW.pullX, y: -ny * VIEW.pullY };
    kick();
  }
  function onLeave() { if (!mark) pullTarget = { x: 0, y: 0 }; kick(); }

  /* ---------- the designator: hover reticle, click for a grid ----------
     Lee, 2026-09-26. Over the feed the mouse is a sideways cross (an X with
     an open centre). Click, and it locks: the X stays on that piece of ground
     and an 8-digit grid appears in a box under it. Click the feed again, press
     Escape, or send a call for fire, and it clears back to hover.

     WHILE LOCKED:
       - the mark is GROUND-stabilised: it moves with the sway, because it is a
         point on the ground, and the grid never changes while it moves;
       - the view stops chasing the mouse, so the student can go to the chat
         without dragging the picture — and the mark — with them;
       - the ordinary cursor comes back, so they can see where they are going.

     The grid is the first ground the pixel's ray meets (SIM_TERRAIN.pick),
     truncated to 8 digits the way MGRS is: a 10 m square. At sea level it was
     right on the plain and 100 m+ long up the hillside. Presentation only —
     nothing here reaches the missions; the student still types the grid. */
  let hover = null;            /* {x, y} glass px (frame px, unswayed), or null */
  let mark = null;             /* {x, y, e, n, grid} ground frame px + grid, or null */

  /** Frame px (ground, unswayed) -> 8-digit grid, or null off the ground. */
  function gridAt(fx, fy) {
    const F = frameSize();
    if (!(fx >= 0 && fy >= 0 && fx <= F.width && fy <= F.height)) return null;
    const w = (typeof SIM_TERRAIN !== 'undefined') ? SIM_TERRAIN.pick(fx, fy)
                                                   : SIM_PROJ.screenToWorld(fx, fy, 0);
    if (!w) return null;
    return { e: w.e, n: w.n, grid: SIM_PROJ.utmToMgrs(w.e, w.n, 4) };
  }

  function glassPoint(clientX, clientY) {
    if (!box || !frameEl) return null;
    const fr = frameEl.getBoundingClientRect();
    return { x: (clientX - fr.left - box.left) / box.scale, y: (clientY - fr.top - box.top) / box.scale };
  }

  function setHoverClass() {
    if (frameEl) frameEl.classList.toggle('is-designating', !mark);
  }

  function lockAt(clientX, clientY) {
    const g = glassPoint(clientX, clientY);
    if (!g) return false;
    const p = viewInvert(g, view);                  /* the ground under the X */
    const at = gridAt(p.x, p.y);
    if (!at) return false;
    mark = { x: p.x, y: p.y, e: at.e, n: at.n, grid: at.grid };
    hover = null;
    setHoverClass();
    kick();
    return true;
  }
  function clearMark() {
    if (!mark) return false;
    mark = null;
    setHoverClass();
    kick();
    return true;
  }

  function onDesignatorMove(ev) {
    if (mark) return;
    hover = glassPoint(ev.clientX, ev.clientY);
    kick();
  }
  function onDesignatorLeave() { hover = null; kick(); }
  function onDesignatorClick(ev) {
    /* The TV / IR readout and the credit corner are not ground. */
    if (ev.target && ev.target.closest && ev.target.closest('.sim-corner')) return;
    if (mark) clearMark(); else lockAt(ev.clientX, ev.clientY);
  }
  function onDesignatorKey(ev) {
    if (ev.key === 'Escape' && !ev.defaultPrevented && mark) { clearMark(); }
  }

  /* The X: four strokes on the diagonals with an open centre, glass-sized. */
  function drawX(g, x, y) {
    const gap = 7, arm = 13;
    g.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      g.moveTo(x + sx * gap, y + sy * gap);
      g.lineTo(x + sx * (gap + arm), y + sy * (gap + arm));
    }
    g.stroke();
  }

  function drawDesignator() {
    if (!mark && !hover) return;
    const ir = mode === 'ir';
    const ink = ir ? '#ffffff' : '#000000';
    const g = cx2d;
    g.save();
    g.strokeStyle = ink;
    g.lineWidth = 2;
    if (!mark) { drawX(g, hover.x, hover.y); g.restore(); return; }

    const at = viewApply(mark, view);                /* where the ground is now */
    drawX(g, at.x, at.y);
    g.font = '500 17px "IBM Plex Mono", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const w = g.measureText ? (g.measureText(mark.grid).width || 190) : 190;
    const bw = w + 20, bh = 28, bx = at.x - bw / 2, by = at.y + 30;
    /* A backed box, so ten digits stay readable over surf or sand. */
    g.fillStyle = ir ? 'rgba(0, 0, 0, .6)' : 'rgba(255, 255, 255, .78)';
    g.fillRect(bx, by, bw, bh);
    g.lineWidth = 1.5;
    g.strokeRect(bx, by, bw, bh);
    g.fillStyle = ink;
    g.fillText(mark.grid, at.x, by + bh / 2 + 1);
    g.restore();
  }

  /* ---------- the hover bracket ----------
     Lee, 2026-09-27. Hover the reticle over a contact and corner brackets close
     on it, with its class in a short tag on the top-right corner: [AAV],
     [FUEL], [ENG], [LCU]. Where vehicles are packed tighter than the reticle
     can separate, every contact within reach of the cursor is bracketed as ONE
     group and the tag counts them: [6 FUEL  3 AAV]. No click — clicking is
     still the designator's, for a grid.

     Glass symbology like the HUD and the designator: black in TV, white in IR,
     drawn outside the sway, with a halo in the other colour so the tag reads
     over surf and sand without a plate. Nothing here touches the entities; it
     reads the footprints the frame just drew, so it can never bracket a place
     the vehicle is not. */
  const HOVER_R_PX   = 18;   /* glass px from the reticle to a contact's centre */
  const BRACKET_PAD  = 5;    /* glass px of air between the footprints and the bracket */
  const BRACKET_MIN  = 18;   /* a far contact still gets a bracket you can see */
  let bracketed = [];        /* ids under the bracket at the last frame */

  /** The tag for a set of contacts. Pure. One contact: its class, [AAV]. Several:
      a count per class, most first, then in class-table order: [6 FUEL  3 AAV]. */
  /* A stopped contact (Lee, 2026-09-27) reads [AAV STOPPED]; in a pack it is
     counted apart from the live ones of its class: [5 FUEL  1 FUEL STOPPED]. */
  const tagKey = v => v.stopped ? T('sim.tag.stopped', '{cls} STOPPED', { cls: v.label }) : v.label;
  function groupTag(vs) {
    if (!vs || !vs.length) return '';
    if (vs.length === 1) return `[${tagKey(vs[0])}]`;
    const order = (typeof SIM_SCENARIO !== 'undefined') ? Object.keys(SIM_SCENARIO.CLASSES) : [];
    const n = new Map();
    for (const v of vs) { const k = tagKey(v); n.set(k, { k, c: ((n.get(k) || {}).c || 0) + 1, o: order.indexOf(v.type) + (v.stopped ? 0.5 : 0) }); }
    return '[' + [...n.values()].sort((a, b) => b.c - a.c || a.o - b.o).map(x => `${x.c} ${x.k}`).join('  ') + ']';
  }

  /** Which drawn contacts the reticle is on: everything within HOVER_R_PX of
      it, measured on the glass (the picture as it sits after sway and pull). */
  function underReticle(drawn) {
    if (!hover || mark || !drawn || !drawn.length) return [];
    return drawn.filter(d => {
      const g = viewApply(d.centre, view);
      return Math.hypot(g.x - hover.x, g.y - hover.y) <= HOVER_R_PX;
    });
  }

  function drawBracket(drawn) {
    const hit = underReticle(drawn);
    bracketed = hit.map(d => d.v.id);
    if (!hit.length) return;
    const pts = [];
    for (const d of hit) for (const q of d.quad) pts.push(viewApply(q, view));
    let x0 = Math.min(...pts.map(p => p.x)) - BRACKET_PAD, x1 = Math.max(...pts.map(p => p.x)) + BRACKET_PAD;
    let y0 = Math.min(...pts.map(p => p.y)) - BRACKET_PAD, y1 = Math.max(...pts.map(p => p.y)) + BRACKET_PAD;
    if (x1 - x0 < BRACKET_MIN) { const c = (x0 + x1) / 2; x0 = c - BRACKET_MIN / 2; x1 = c + BRACKET_MIN / 2; }
    if (y1 - y0 < BRACKET_MIN) { const c = (y0 + y1) / 2; y0 = c - BRACKET_MIN / 2; y1 = c + BRACKET_MIN / 2; }

    const ir = mode === 'ir';
    const ink = ir ? '#ffffff' : '#000000', halo = ir ? '#000000' : '#ffffff';
    const arm = Math.min(8, (x1 - x0) / 3, (y1 - y0) / 3);
    const g = cx2d;
    g.save();
    const corners = () => {
      g.beginPath();
      for (const [x, y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]]) {
        g.moveTo(x + sx * arm, y); g.lineTo(x, y); g.lineTo(x, y + sy * arm);
      }
      g.stroke();
    };
    g.lineCap = 'square';
    g.strokeStyle = halo; g.lineWidth = 3.5; corners();
    g.strokeStyle = ink;  g.lineWidth = 1.5; corners();

    const tag = groupTag(hit.map(d => d.v));
    g.font = '600 14px "IBM Plex Mono", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", ui-monospace, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    const F = frameSize();
    const tw = (g.measureText && g.measureText(tag).width) || tag.length * 8.4;
    const tx = Math.min(x1 + 2, F.width - tw - 4), ty = Math.max(y0 - 2, 18);
    g.lineJoin = 'round';
    g.strokeStyle = halo; g.lineWidth = 3;
    g.strokeText(tag, tx, ty);
    g.fillStyle = ink;
    g.fillText(tag, tx, ty);
    g.restore();
  }

  /** The obstacle's tag: [OBS 01], [OBS 01 OPENING] while the lane is being
      worked, [OBS 01 OPEN] once it is through. Pure. */
  function obstacleTag(ob) {
    const m = /(\d+)\s*$/.exec(ob.obstacle || ob.id || '');
    const name = m ? T('sim.tag.obs', 'OBS {n}', { n: String(+m[1]).padStart(2, '0') }) : (ob.obstacle || ob.id);
    return '[' + (ob.state === 'opening' ? T('sim.tag.opening', '{name} OPENING', { name })
                : ob.state === 'open'    ? T('sim.tag.open', '{name} OPEN', { name }) : name) + ']';
  }

  let bracketedObstacles = [];

  /* An obstacle under the reticle gets the same corner brackets as a contact,
     around the whole debris line, with its tag under the bottom-left corner so
     it never lands on a vehicle tag (those sit top-right). Vehicles queue at
     obstacles, so both brackets can be up at once. */
  function drawObstacleBracket(obsDrawn) {
    bracketedObstacles = [];
    if (!hover || mark || !obsDrawn || !obsDrawn.length) return;
    const g = cx2d, ir = mode === 'ir';
    const ink = ir ? '#ffffff' : '#000000', halo = ir ? '#000000' : '#ffffff';
    for (const d of obsDrawn) {
      const pts = d.pts.map(p => viewApply(p, view));
      if (!pts.some(p => Math.hypot(p.x - hover.x, p.y - hover.y) <= HOVER_R_PX)) continue;
      bracketedObstacles.push(d.ob.id);
      let x0 = Math.min(...pts.map(p => p.x)) - BRACKET_PAD, x1 = Math.max(...pts.map(p => p.x)) + BRACKET_PAD;
      let y0 = Math.min(...pts.map(p => p.y)) - BRACKET_PAD, y1 = Math.max(...pts.map(p => p.y)) + BRACKET_PAD;
      if (x1 - x0 < BRACKET_MIN) { const c = (x0 + x1) / 2; x0 = c - BRACKET_MIN / 2; x1 = c + BRACKET_MIN / 2; }
      if (y1 - y0 < BRACKET_MIN) { const c = (y0 + y1) / 2; y0 = c - BRACKET_MIN / 2; y1 = c + BRACKET_MIN / 2; }
      const arm = Math.min(8, (x1 - x0) / 3, (y1 - y0) / 3);
      g.save();
      const corners = () => {
        g.beginPath();
        for (const [x, y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]]) {
          g.moveTo(x + sx * arm, y); g.lineTo(x, y); g.lineTo(x, y + sy * arm);
        }
        g.stroke();
      };
      g.lineCap = 'square';
      g.strokeStyle = halo; g.lineWidth = 3.5; corners();
      g.strokeStyle = ink;  g.lineWidth = 1.5; corners();
      const tag = obstacleTag(d.ob);
      g.font = '600 14px "IBM Plex Mono", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", ui-monospace, monospace';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      const F = frameSize();
      const tw = (g.measureText && g.measureText(tag).width) || tag.length * 8.4;
      const tx = Math.max(4, Math.min(x0, F.width - tw - 4)), ty = Math.min(y1 + 3, F.height - 18);
      g.lineJoin = 'round';
      g.strokeStyle = halo; g.lineWidth = 3;
      g.strokeText(tag, tx, ty);
      g.fillStyle = ink;
      g.fillText(tag, tx, ty);
      g.restore();
    }
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

    const easing = updateView();

    /* The ground layer moves with the picture; see "sway" above. */
    cx2d.save();
    cx2d.transform(view.zoom, 0, 0, view.zoom,
                   (1 - view.zoom) * frameSize().width / 2 + view.dx,
                   (1 - view.zoom) * frameSize().height / 2 + view.dy);

    /* Order: debris on the ground, footprints, then smoke over them, then the bursts. A round
       landing on a vehicle should obscure it, and so should its smoke. The
       hover bracket is glass symbology and is drawn later, outside the sway. */
    let obsDrawn = [];
    if (obstacleSource) {
      let obs = null;
      try { obs = obstacleSource(); } catch (err) { console.error('[sim-render] obstacle source threw', err); }
      if (obs) for (const ob of obs) { const d = drawDebris(ob); if (d) obsDrawn.push(d); }
    }

    let drawn = [];
    if (entitySource) {
      let vs = null;
      try { vs = entitySource(); } catch (err) { console.error('[sim-render] entity source threw', err); }
      if (vs) for (const v of vs) { const d = drawFootprint(v); if (d) drawn.push(d); }
      /* Wreck smoke over the footprints, under the burst smoke. */
      if (vs) { const tNow = simNow(), wd = windNow(); for (const v of vs) if (v.stopped) drawWreck(v, tNow, wd); }
    }
    if (droneSource) {
      let ds = null;
      try { ds = droneSource(simNow() / 1000); } catch (err) { console.error('[sim-render] drone source threw', err); }
      if (ds) for (const q of ds) { const d = drawDrone(q); if (d) drawn.push(d); }
    }

    const now = simNow();
    plumes = plumes.filter(p => now - p.t0 <= PLUME_MS);
    const wind = windNow();
    for (const p of plumes) {
      const age = now - p.t0;
      if (age >= 0) drawPlume(p, age, wind);
    }

    let live = 0;
    for (const b of bursts) {
      const age = now - b.t0;
      if (age < 0) { live++; continue; }
      if (age > BURST_MS) continue;
      drawBurst(b, age);
      live++;
    }
    bursts = bursts.filter(b => now - b.t0 <= BURST_MS);

    cx2d.restore();              /* end of the ground layer */

    /* The HUD last, and outside the sway: it is symbology on the glass. */
    drawHud();
    drawObstacleBracket(obsDrawn);
    drawBracket(drawn);
    drawDesignator();

    /* Self-drive only when nothing else is driving. With a clock playing, the
       next frame arrives through SIM_CLOCK.onFrame; with a clock paused the
       picture cannot change, so one draw is the whole job. */
    if ((live || plumes.length) && !hasClock()) raf = requestAnimationFrame(frame);
    /* The mouse pull eases over a few frames; a paused clock sends none, so ask. */
    if (easing && !(hasClock() && SIM_CLOCK.isRunning())) raf = requestAnimationFrame(frame);
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
    still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    frameEl.addEventListener('pointermove', onPointer);
    frameEl.addEventListener('pointerleave', onLeave);
    frameEl.addEventListener('pointermove', onDesignatorMove);
    frameEl.addEventListener('pointerleave', onDesignatorLeave);
    frameEl.addEventListener('click', onDesignatorClick);
    document.addEventListener('keydown', onDesignatorKey);
    setHoverClass();

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
      point — the caller looks it up (SIM_TERRAIN.elevAt) and passes it in. */
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

  /** One volley at the points where the rounds actually landed — the damage
      model's own points (js/sim-damage.js), so what the student sees is what
      was adjudicated. elev per point, from the caller. The small stagger is a
      picture, not a ballistic: it is keyed off the point so it is stable. */
  function impacts(points) {
    if (!points || !points.length) return 0;
    const t = simNow();
    points.forEach((p, i) => {
      const jitter = ((Math.abs(Math.round(p.e * 7 + p.n * 13)) % 97) / 97) * STAGGER_MS;
      const b = { e: p.e, n: p.n, elev: p.elev || 0, t0: t + Math.min(i, 12) * STAGGER_MS * 0.5 + jitter };
      bursts.push(b);
      addPlume(b.e, b.n, b.elev, b.t0);
    });
    kick();
    return points.length;
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

  /** The same pull, for the debris lines and their breach progress. */
  function setObstacleSource(fn) { obstacleSource = (typeof fn === 'function') ? fn : null; kick(); }

  /** The drones to draw: fn(nowSec) -> [{id, e, n, h}]. */
  function setDroneSource(fn) { droneSource = (typeof fn === 'function') ? fn : null; kick(); }

  /** Screen point -> frame pixels. Dev tool only: nothing the student does
      needs this, because a call for fire names a grid, it does not click one. */
  function toFrame(clientX, clientY) {
    if (!box || !frameEl) return null;
    const fr = frameEl.getBoundingClientRect();
    const x = (clientX - fr.left - box.left) / box.scale;
    const y = (clientY - fr.top  - box.top ) / box.scale;
    /* Undo the sway, so the dev readout still names the ground under the
       mouse rather than the ground that would be there with the camera still. */
    return viewInvert({ x, y }, view);
  }

  return { attach, detach, fireMission, impacts, setEntitySource, setDroneSource, wreckState, wreckHull, WRECK, clear, toFrame, containBox,
           groundQuad, setMode, toggleMode, mode: () => mode,
           plumeState, plumeCount: () => plumes.length, hudValues, latLonText,
           swayAt, viewApply, viewInvert, VIEW, view: () => ({ ...view }),
           gridAt, clearMark, mark: () => (mark ? { ...mark } : null), hover: () => (hover ? { ...hover } : null),
           groupTag, bracketed: () => bracketed.slice(),
           setObstacleSource, obstacleTag, piecesFor, pieceStands, bracketedObstacles: () => bracketedObstacles.slice(),
           PLUME_MS, PUFFS_PER_PLUME, MAX_PUFFS,
           get box() { return box; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_RENDER;
