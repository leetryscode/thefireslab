/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved. */
/* =========================================================
   Fire Mission Sim — where rounds land, and whether a vehicle stops.

   The spec is claude/sim-damage-model.md (agreed with Lee 2026-09-27). This
   file is Part A of it in code. If a number here changes, change the doc's
   tables AND its student explainer (Part B) with it.

   ---------------------------------------------------------
   ONE OUTCOME: DOES IT STOP.
   Lee, 2026-09-27: no kill types. A mobility kill stops the vehicle and that
   is all the mission cares about. A stopped vehicle never moves again, and it
   blocks nobody (wrecks are ignored, 2026-09-21).
   ---------------------------------------------------------

   THE FALLOFF. Each round rolls separately against each vehicle:

       P(stop from this round) = exp( -(d / R)^2 )

   d = ground distance from the burst to the vehicle AT THE MOMENT THAT VOLLEY
   LANDS; R = kill radius for that munition against that class. The vehicle
   stops if any roll succeeds. (Carleton damage function, circular form.)

   THE DICE ARE KEYED, NOT DRAWN IN ORDER. Every random number is a hash of
   (seed, mission, volley, round, entity). So the answer does not depend on
   the order vehicles sit in an array, on how many other contacts are on the
   field, or on the clock rate — 30x is the same run as 1x, and a replay from
   T+0 (the pinned undo) lands every round in the same place and gets the same
   stops. Nothing here uses the browser's unseeded random.

   EVERY R IS A PLACEHOLDER chosen by Claude and accepted by Lee. No public
   source was found for kill radii against light armour. Tune them here.

   API:
     SIM_DAMAGE.reset(seed)
     SIM_DAMAGE.pattern(system)          -> { kind, count?, sheafM?, lengthM?, widthM?, axisDeg? }
     SIM_DAMAGE.impactPoints(spec, volley) -> [{e, n}]   spec: {id, system, e, n, guns}
     SIM_DAMAGE.pStop(system, type, d)   -> 0..1 for one round at d metres
     SIM_DAMAGE.resolve(spec, volley, targets) -> { points, rolls: [...], stopped: [ids] }
         targets: [{ id, type, e, n, inWater, aboard }]
     SIM_DAMAGE.inWater(e, n)
     SIM_DAMAGE.log()                    the last rolls, for the dev readout
   ========================================================= */

const SIM_DAMAGE = (() => {

  /* ---------- where the rounds land ----------
     Tubes: every gun's round lands uniformly inside a 100 m circle centred on
     the called grid. All four batteries use 100 m (the M109's old 200 m made
     a 105 beat a 155 against a point target, which Lee did not intend).

     Fire Storm (RT2000): one salvo of 36 Mk45 steel-ball rockets, uniformly
     inside an ellipse 600 m long x 400 m wide, long axis roughly east-west
     (Lee: "not a hard rule"). Two salvos a scenario — that count lives with
     the unit in sim-missions.js. */
  const PATTERNS = {
    M109:   { kind: 'sheaf',   sheafM: 100 },
    M101:   { kind: 'sheaf',   sheafM: 100 },
    RT2000: { kind: 'ellipse', count: 36, lengthM: 600, widthM: 400, axisDeg: 90 }
  };

  /* ---------- kill radius R, metres ----------
     Munition x class. A class missing from a row is IMMUNE to that munition:
     the landing craft is unsinkable (Lee's rule). Cargo still aboard one is
     rolled as its own class — see `aboard` below. OWA (Predator) is postponed
     and has no row, so its rounds land and stop nothing. */
  const R = {
    M109: { 'logistics': 35, 'engineering': 15, 'amphibious-assault-vehicle': 10, 'self-propelled-artillery': 10 },
    M101: { 'logistics': 25, 'engineering': 10, 'amphibious-assault-vehicle': 6,  'self-propelled-artillery': 6  },
    RT2000: { 'logistics': 75, 'engineering': 30, 'amphibious-assault-vehicle': 8, 'self-propelled-artillery': 8 }
  };

  /* Tube artillery does nothing in the water — Lee's objective, not an
     accident: the first checkpoint of each corridor sits offshore to offer
     the temptation. Applied if EITHER the round lands in the water or the
     vehicle is in it. Rockets get no water rule (Lee, 2026-09-27): they are
     already close to useless against a swimming AAV, and the student learns
     it by seeing it.

     "In the water" comes from the terrain grid, which stores water as 0. The
     coast is one clean crossing on every amphib route (checked 2026-09-27), so
     no drawn beach line was needed. */
  const TUBES = { M109: true, M101: true };
  const WATER_M = 0.05;

  const DEFAULT_SEED = 0xB1A57;
  let seed = DEFAULT_SEED;
  let last = [];                 /* every roll this run, newest last — the fires log reads it */
  let volleys = [];              /* one record per volley that landed, so an empty one still shows */
  const LOG_KEEP = 5000;

  function reset(s) { seed = (typeof s === 'number' ? s : DEFAULT_SEED) >>> 0; last = []; volleys = []; return true; }

  /* ---------- keyed dice ----------
     FNV-1a over the key, the murmur3 finaliser so keys that differ only in
     their last character come out unrelated, then one mulberry32 step. */
  function hash(str) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
  function u01(key) {
    let a = (hash(key) + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function pattern(system) { return PATTERNS[system] || null; }

  /* Uniform over the area: radius goes as sqrt(u) so the density is even,
     not bunched at the centre. */
  function impactPoints(spec, volley) {
    const p = pattern(spec.system);
    const pts = [];
    if (!p) {
      /* No pattern (the OWA): one aim point per round, on the grid. */
      for (let i = 0; i < Math.max(1, spec.guns || 1); i++) pts.push({ e: spec.e, n: spec.n });
      return pts;
    }
    const count = p.kind === 'ellipse' ? p.count : Math.max(1, spec.guns || 1);
    for (let i = 0; i < count; i++) {
      const k = `${spec.id}|${volley}|${i}`;
      const r = Math.sqrt(u01(k + '|r')), th = u01(k + '|a') * Math.PI * 2;
      if (p.kind === 'ellipse') {
        /* along = the long axis, bearing axisDeg from north */
        const along = r * Math.cos(th) * p.lengthM / 2, across = r * Math.sin(th) * p.widthM / 2;
        const b = p.axisDeg * Math.PI / 180;
        pts.push({ e: spec.e + along * Math.sin(b) + across * Math.cos(b),
                   n: spec.n + along * Math.cos(b) - across * Math.sin(b) });
      } else {
        pts.push({ e: spec.e + r * Math.cos(th) * p.sheafM / 2, n: spec.n + r * Math.sin(th) * p.sheafM / 2 });
      }
    }
    return pts;
  }

  function radius(system, type) {
    const row = R[system];
    return row && typeof row[type] === 'number' ? row[type] : 0;
  }

  function pStop(system, type, d) {
    const r = radius(system, type);
    if (!(r > 0)) return 0;
    return Math.exp(-(d / r) * (d / r));
  }

  /* Inside the impact area itself: the sheaf circle or the rocket ellipse.
     Everything in here gets a line in the fires log, even at 0% — seeing an
     AAV sit untouched in the middle of a salvo is the lesson (Lee, 2026-09-27). */
  function inArea(spec, e, n) {
    const p = pattern(spec.system);
    if (!p) return false;
    const dE = e - spec.e, dN = n - spec.n;
    if (p.kind === 'sheaf') return Math.hypot(dE, dN) <= p.sheafM / 2;
    const b = p.axisDeg * Math.PI / 180;
    const along = dE * Math.sin(b) + dN * Math.cos(b), across = dE * Math.cos(b) - dN * Math.sin(b);
    return (along / (p.lengthM / 2)) ** 2 + (across / (p.widthM / 2)) ** 2 <= 1;
  }

  function inWater(e, n) {
    if (typeof SIM_TERRAIN === 'undefined' || !SIM_TERRAIN.elevAt) return false;
    return SIM_TERRAIN.elevAt(e, n) < WATER_M;
  }

  /* ---------- one volley ----------
     Every round against every target. Pure apart from the log: it does not
     touch the entities — the mission layer applies `stopped`. */
  function resolve(spec, volley, targets) {
    const points = impactPoints(spec, volley);
    const tube = !!TUBES[spec.system];
    const wet = tube ? points.map(p => inWater(p.e, p.n)) : null;
    const rolls = [], stopped = [];
    /* A vehicle the rounds could not touch still gets a 0% line if it sat in
       the impact area, with the reason — the water rule is a lesson too. */
    const noEffect = (t, note) => {
      if (inArea(spec, t.e, t.n))
        rolls.push({ mission: spec.id, volley, id: t.id, type: t.type, nearestM: null,
                     pStop: 0, stopped: false, aboard: !!t.aboard, note });
    };
    for (const t of (targets || [])) {
      const r = radius(spec.system, t.type);
      if (!(r > 0)) continue;                          /* immune, or no row */
      if (tube && t.inWater) { noEffect(t, 'in water'); continue; }   /* tubes can't touch a vehicle afloat */
      /* Cargo aboard a landing craft: the rockets only (Lee, 2026-09-27). */
      if (t.aboard && spec.system !== 'RT2000') { noEffect(t, 'aboard'); continue; }
      let survive = 1, best = Infinity, bestP = 0, hit = false;
      for (let i = 0; i < points.length; i++) {
        if (tube && wet[i]) continue;                  /* a round in the water does nothing */
        const d = Math.hypot(points[i].e - t.e, points[i].n - t.n);
        if (d < best) best = d;
        if (d > r * 4) continue;                       /* exp(-16): nothing to roll for */
        const p = Math.exp(-(d / r) * (d / r));
        if (p > bestP) bestP = p;
        survive *= (1 - p);
        if (!hit && u01(`${spec.id}|${volley}|${i}|${t.id}`) < p) hit = true;
      }
      if (best === Infinity) { noEffect(t, 'rounds in water'); continue; }
      /* A line if it was inside the impact area, or had a real chance from
         outside it (a truck 150 m off still feels a 155). */
      const listed = inArea(spec, t.e, t.n) || (best <= r * 4 && (hit || 1 - survive >= 0.005));
      if (!listed) continue;
      const roll = { mission: spec.id, volley, id: t.id, type: t.type, nearestM: Math.round(best),
                     pStop: 1 - survive, stopped: hit, aboard: !!t.aboard, note: t.aboard ? 'aboard' : '' };
      rolls.push(roll);
      if (hit) stopped.push(t.id);
    }
    last.push(...rolls);
    if (last.length > LOG_KEEP) last = last.slice(-LOG_KEEP);
    volleys.push({ mission: spec.id, volley, system: spec.system, lines: rolls.length });
    return { points, rolls, stopped };
  }

  /* A Predator drone's outcome (js/sim-drones.js), into the same logs the fires
     log reads: one "volley" per drone, numbered by its place in the mission. */
  function recordDrone(d, res) {
    const rolls = res && !res.lost
      ? [{ mission: d.mission, volley: d.index, id: res.id, type: res.type, nearestM: null, drone: true,
           pStop: res.pStop, stopped: !!res.stopped, aboard: false, note: '' }]
      : [];
    last.push(...rolls);
    if (last.length > LOG_KEEP) last = last.slice(-LOG_KEEP);
    volleys.push({ mission: d.mission, volley: d.index, system: 'OWA', lines: rolls.length,
                   drone: true, lost: !!(res && res.lost) });
    return rolls;
  }

  return { reset, pattern, impactPoints, pStop, radius, resolve, inWater, inArea, recordDrone,
           log: () => last.slice(), volleys: () => volleys.slice(), PATTERNS, R, WATER_M };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_DAMAGE;
