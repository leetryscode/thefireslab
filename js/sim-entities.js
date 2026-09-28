/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   Fire Mission Sim — the things that move.

   A plain array of entity objects and a tick function. Deliberately not a
   systems architecture: one moving contact does not need one, and the parts
   that will matter later — a state per entity, distance along route, a class
   and an HPT flag — are one field each.

   ---------------------------------------------------------
   DISTANCE IS INTEGRATED, NEVER LOOKED UP.

   Each entity carries metresAlongRoute and the tick adds to it. Nothing here
   asks "where should this be at T+340?", because the answer has to be allowed
   to depend on what the student did. Halting a column at an obstacle lane is
   setting state to 'halted'; it costs nothing precisely because position was
   never a function of time.

   metresAlongRoute IS THE SCOREBOARD. "Nothing crossed PL AMBER before T+40"
   is a comparison against a number this file already keeps.
   ---------------------------------------------------------

   States: staged -> moving -> arrived
           moving <-> halted        (a holding area, a refuel ring, a breach)
           any    -> destroyed      (adjudication: js/sim-damage.js)

   'destroyed' means STOPPED. Lee, 2026-09-27: no kill types — the only
   question is whether it stops moving. The name is the one reserved here from
   the start and the suite already uses it. A destroyed vehicle stays on the
   field (drawn dim, tagged STOPPED) but is out of every rule: it moves no
   more, blocks nobody (wrecks are ignored, 2026-09-21), fuels nobody and
   breaches nothing.

   API:
     SIM_ENTITIES.load(scenario)   build the live list. Returns the count.
     SIM_ENTITIES.tick(t, dt)      advance every mover by one logical step
     SIM_ENTITIES.reset()          back to the loaded scenario's start state
     SIM_ENTITIES.list()           the live entities, with position resolved
     SIM_ENTITIES.get(id)
     SIM_ENTITIES.obstacles()      debris lines to draw, with each lane's breach progress
     SIM_ENTITIES.setState(id, s)
     SIM_ENTITIES.targets()        what a volley can hit right now, cargo aboard included
     SIM_ENTITIES.stop(id, t)      adjudication's one verb: it stops
   ========================================================= */

const SIM_ENTITIES = (() => {

  let scn = null;
  let ents = [];
  let nowT = 0;                  /* sim time of the last tick, for timer-lane progress */

  const MOVING = 'moving';
  const HALTED = 'halted';

  function build() {
    ents = (scn.entities || []).map(spec => {
      const cls = SIM_SCENARIO.CLASSES[spec.type];
      if (!cls) throw new Error(`[sim-entities] ${spec.id}: unknown class "${spec.type}"`);
      const route = scn.routes[spec.route];
      if (!route) throw new Error(`[sim-entities] ${spec.id}: unknown route "${spec.route}"`);
      return {
        id: spec.id,
        type: spec.type,
        cls,
        /* The HPT flag is the entity's own if it carries one, otherwise the
           class default. A scenario can promote a fuel truck without editing
           the class table. */
        hpt: typeof spec.hpt === 'boolean' ? spec.hpt : cls.hpt,
        route,
        startSec: Number(spec.startSec) || 0,
        s: Number(spec.startM) || 0,
        /* An entity due at or before T+00:00 is on the field before the student
           presses play: the opening picture is part of the problem, and a
           contact that pops into existence one step in looks like a bug. */
        vKph: undefined,
        /* Where this vehicle stops short of a closed lane, and which lane it is
           waiting on. Both come from the converter: the holding area is already
           spliced into the route as a waypoint, so the engine only has to stop
           at a distance and watch a flag. */
        holdAtM: (typeof spec.holdAtM === 'number') ? spec.holdAtM : null,
        lane: spec.lane || null,
        /* REFUEL. An amphib that carries a ring slot stops there, facing out,
           until its depot has a free slot; drives in to a truck; stands for the
           refuel time; and only then carries on. `phase` walks
           pending -> ring -> toDepot -> fueling -> done. A vehicle that starts
           past its ring (startM) has nothing left to do. */
        fuel: (typeof spec.refuelAtM === 'number' && typeof spec.fuelAtM === 'number' && spec.depot)
          ? { ringAtM: spec.refuelAtM, fuelAtM: spec.fuelAtM, depot: spec.depot,
              faceDeg: (typeof spec.faceDeg === 'number') ? spec.faceDeg : null,
              phase: (Number(spec.startM) || 0) >= spec.refuelAtM ? 'done' : 'pending',
              ringSince: null, doneAt: null }
          : null,
        /* An engineer knows the lane it breaches and where on its path it stops
           to do the work. It needs no fuel and waits for no escort. */
        breach: (spec.breachLane && typeof spec.breachAtM === 'number')
          ? { lane: spec.breachLane, atM: spec.breachAtM,
              phase: (Number(spec.startM) || 0) >= spec.breachAtM ? 'done' : 'pending' }
          : null,
        /* A fuel truck knows its depot; parked (arrived) and not destroyed, it
           opens `perTruck` refuelling slots there. */
        depot: spec.depot && !(typeof spec.refuelAtM === 'number') ? spec.depot : null,
        /* The landing craft it rides until offload (converter, 2026-09-27).
           Until its startSec it is aboard: at the craft's position, a target
           for the rockets only. */
        carrier: spec.carrier || null,
        /* A choice of paths (ENG 07 A / B, Lee 2026-09-28): taken once, when it
           leaves the craft — see pickPath. */
        alts: Array.isArray(spec.alts) && spec.alts.length > 1
          ? spec.alts.map(a => ({ route: scn.routes[a.route], lane: a.breachLane || null, atM: a.breachAtM }))
                     .filter(a => a.route)
          : null,
        /* Metres along its route where it crosses the delay line, and when it
           did. Past it a vehicle is THROUGH: scored, and no longer a target. */
        crossAtM: null,
        throughAt: null,
        lostAboard: false,
        stoppedAt: null,
        state: (Number(spec.startSec) || 0) <= 0 ? MOVING : 'staged'
      };
    });
    return ents.length;
  }

  /* ---------- lanes ----------
     A lane is closed until it is breached. TODAY the breach is a timer that
     starts when the first vehicle reaches the holding area — a stand-in for an
     engineering vehicle arriving and doing the work, because there are no
     engineers in the scenario yet. When there are, `openAt` gets set by a
     breacher being present instead, and killing it is what stops the lane
     opening. Nothing else has to change. */
  let lanes = {};

  function resetLanes() {
    lanes = {};
    for (const [id, spec] of Object.entries((scn && scn.lanes) || {})) {
      lanes[id] = { breachSec: (typeof spec.breachSec === 'number') ? spec.breachSec : null,
                    firstArrivalSec: null, openAt: null,
                    byEngineer: false, workSec: 0, engineersAt: 0 };
    }
    /* A lane that some engineer is assigned to is opened BY ENGINEERS: its
       clock runs only while a living one is standing at it, and a replacement
       picks the work up where the last one stopped. A lane nobody is assigned
       to keeps the old stand-in timer, started by the first vehicle to reach
       its holding area. */
    for (const en of ents) {
      if (en.breach && lanes[en.breach.lane]) lanes[en.breach.lane].byEngineer = true;
      if (en.alts) for (const a of en.alts) if (a.lane && lanes[a.lane]) lanes[a.lane].byEngineer = true;
    }
  }

  function workLanes(t, dt) {
    for (const L of Object.values(lanes)) L.engineersAt = 0;
    for (const en of ents) {
      if (en.breach && en.breach.phase === 'breaching' && en.state === HALTED && lanes[en.breach.lane])
        lanes[en.breach.lane].engineersAt++;
    }
    for (const L of Object.values(lanes)) {
      if (!L.byEngineer || L.openAt !== null || L.breachSec === null || L.engineersAt === 0) continue;
      L.workSec += dt;                     /* one engineer or three: the same clock */
      if (L.workSec >= L.breachSec - 1e-9) L.openAt = t + dt;
    }
  }

  function laneOpen(id, t) {
    const L = lanes[id];
    if (!L) return true;                       /* no such lane: nothing blocks */
    if (L.breachSec === null) return false;    /* a lane with no time never opens */
    return L.openAt !== null && t >= L.openAt;
  }

  function load(scenario) {
    scn = SIM_SCENARIO.prepare(scenario);
    const n = build();
    resetLanes();
    prepareDelay();
    for (const en of ents) if (en.state === MOVING) pickPath(en);
    return n;
  }

  function reset() {
    if (!scn) return 0;
    const n = build(); resetLanes(); nowT = 0; prepareDelay();
    for (const en of ents) if (en.state === MOVING) pickPath(en);
    return n;
  }

  /* ---------- the engineer's choice (Lee, 2026-09-28) ----------
     An engineer with more than one drawn path (ENG 07 A / B) picks when it
     leaves the craft, and keeps it:
       1. a lane still closed that no living engineer is committed to,
       2. then the one with the least breach done,
       3. then the order drawn.
     A closed lane that does have an engineer comes next (least done first).
     If every lane is open it takes the first path and simply drives on —
     through the lanes and past the delay line, which scores nothing for an
     engineer. Deterministic: same answer at 1x and 30x. */
  function committed(lane, self) {
    return ents.some(o => o !== self && o.type === 'engineering' && o.state !== 'destroyed' && !o.lostAboard &&
                          !(o.alts && !o.picked) && o.breach && o.breach.lane === lane && o.breach.phase !== 'done');
  }
  function progress(lane) {
    const L = lanes[lane];
    return L && L.breachSec ? L.workSec / L.breachSec : 0;
  }
  function pickPath(en) {
    if (!en.alts || en.picked) return;
    en.picked = true;
    const t = nowT;
    const shut = en.alts.map((a, i) => ({ a, i })).filter(x => x.a.lane && !laneOpen(x.a.lane, t));
    const order = (xs) => xs.slice().sort((x, y) => (progress(x.a.lane) - progress(y.a.lane)) || (x.i - y.i));
    const free = shut.filter(x => !committed(x.a.lane, en));
    const pick = (free.length ? order(free)[0] : shut.length ? order(shut)[0] : { a: en.alts[0], i: 0 }).a;
    en.route = pick.route;
    en.pickedLane = pick.lane;
    en.breach = pick.lane && typeof pick.atM === 'number'
      ? { lane: pick.lane, atM: pick.atM, phase: laneOpen(pick.lane, t) ? 'done' : 'pending' } : null;
    en.crossAtM = crossingOf(en.route);
  }

  /* ---------- the delay line (Lee, 2026-09-28) ----------
     'PL RED' in the KMZ; 'DELAY LINE RED' to the student. Where each route
     crosses it is worked out once, as metres along the route. */
  let delaySegs = [], delayLabel = '';
  function prepareDelay() {
    delaySegs = []; delayLabel = '';
    const src = (scn && scn.delayLines) || {};
    for (const [id, d] of Object.entries(src)) {
      const pts = (d.points || []).map(g => SIM_PROJ.mgrsToUtm(g)).filter(Boolean);
      for (let i = 0; i + 1 < pts.length; i++) delaySegs.push([pts[i], pts[i + 1]]);
      if (!delayLabel) delayLabel = d.label || id;
    }
    for (const en of ents) en.crossAtM = crossingOf(en.route);
  }
  function crossingOf(route) {
    if (!delaySegs.length || !route || !route.legs) return null;
    let best = null;
    for (const leg of route.legs) {
      const a = route.nodes[leg.from], b = route.nodes[leg.from + 1];
      for (const [c, d] of delaySegs) {
        const r = { e: b.e - a.e, n: b.n - a.n }, s = { e: d.e - c.e, n: d.n - c.n };
        const den = r.e * s.n - r.n * s.e;
        if (Math.abs(den) < 1e-9) continue;
        const u = ((c.e - a.e) * s.n - (c.n - a.n) * s.e) / den;
        const v = ((c.e - a.e) * r.n - (c.n - a.n) * r.e) / den;
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
          const m = leg.start + u * leg.len;
          if (best === null || m < best) best = m;
        }
      }
    }
    return best;
  }

  /* ---------- obstacles, as the student sees them ----------
     Lee, 2026-09-27. The OBS belts are long because they do the halting; the
     RUBBLE nn / TREES nn lines are what is actually drawn, where the debris
     really lies. Each is paired to its lane by number at convert time.

     progress is how much of the lane is cleared, 0..1: the engineer's work over
     the breach time, or — on a lane no engineer is assigned to — the stand-in
     timer since the first vehicle reached the holding area. The lane line comes
     back APPROACH END FIRST (the end nearest where the breacher, or failing that
     the queue, arrives), so the renderer can clear debris from the near side
     to the far side. Display only: nothing here changes who moves. */
  let debrisCache = null;
  function debrisGeometry() {
    if (debrisCache && debrisCache.scn === scn) return debrisCache.list;
    const toUtm = g => { const u = SIM_PROJ.mgrsToUtm(g); return u ? { e: u.e, n: u.n } : null; };
    const list = [];
    for (const [id, d] of Object.entries((scn && scn.debris) || {})) {
      const points = (d.points || []).map(toUtm).filter(Boolean);
      if (points.length < 2) continue;
      const laneSpec = d.lane && scn.lanes && scn.lanes[d.lane];
      let laneLine = laneSpec ? (laneSpec.points || []).map(toUtm).filter(Boolean) : [];
      if (laneLine.length >= 2) {
        /* where does the breach come from? the breacher's approach, else the queue's */
        let from = null;
        const eng = ents.find(en => en.breach && en.breach.lane === d.lane);
        if (eng) from = SIM_SCENARIO.routeAt(eng.route, Math.max(0, eng.breach.atM - 40));
        else {
          const q = ents.find(en => en.lane === d.lane && typeof en.holdAtM === 'number');
          if (q) from = SIM_SCENARIO.routeAt(q.route, q.holdAtM);
        }
        if (from) {
          const a = laneLine[0], b = laneLine[laneLine.length - 1];
          if (Math.hypot(b.e - from.e, b.n - from.n) < Math.hypot(a.e - from.e, a.n - from.n)) laneLine = laneLine.slice().reverse();
        }
      } else laneLine = [];
      list.push({ id, style: d.style === 'trees' ? 'trees' : 'rubble', obstacle: d.obstacle || null,
                  lane: d.lane || null, points, laneLine });
    }
    debrisCache = { scn, list };
    return list;
  }

  function obstacles() {
    return debrisGeometry().map(d => {
      const L = d.lane && lanes[d.lane];
      let progress = 0, state = 'closed';
      if (L) {
        const open = laneOpen(d.lane, nowT);
        if (open) progress = 1;
        else if (L.breachSec > 0) {
          progress = L.byEngineer ? L.workSec / L.breachSec
                   : (L.firstArrivalSec !== null ? (nowT - L.firstArrivalSec) / L.breachSec : 0);
        }
        progress = Math.max(0, Math.min(1, progress));
        state = open ? 'open'
              : (L.byEngineer ? L.engineersAt > 0 : L.firstArrivalSec !== null) ? 'opening' : 'closed';
      }
      return { id: d.id, style: d.style, obstacle: d.obstacle, lane: d.lane,
               points: d.points, laneLine: d.laneLine, progress, state };
    });
  }

  /* ---------- refuelling ----------
     A depot's capacity is perTruck x the fuel trucks PARKED there and alive,
     counted fresh every tick — so killing a truck costs slots the moment it
     dies, and a depot no truck has reached yet refuels nobody. Vehicles already
     driving in or fuelling finish; only new releases are held back.

     Release order is first-come at the ring (then id), never array order or
     distance-to-go, so a run is identical at 1x and 3x.

     Both figures are Lee's (2026-09-27): about four minutes a vehicle, two
     vehicles per truck. A scenario may override them with
     `fuelling: { secondsPerVehicle, perTruck }`. */
  const DEFAULT_FUEL_SEC  = 240;
  const DEFAULT_PER_TRUCK = 2;

  function fuelling() {
    const f = (scn && scn.fuelling) || {};
    return {
      sec: Number(f.secondsPerVehicle) > 0 ? Number(f.secondsPerVehicle) : DEFAULT_FUEL_SEC,
      perTruck: Number(f.perTruck) > 0 ? Number(f.perTruck) : DEFAULT_PER_TRUCK
    };
  }

  function depotSlots(depot) {
    const { perTruck } = fuelling();
    let trucks = 0;
    for (const en of ents) if (en.depot === depot && en.state === 'arrived') trucks++;
    return trucks * perTruck;
  }

  function releaseFromRings() {
    const busy = {}, waiting = {};
    for (const en of ents) {
      if (!en.fuel || en.state === 'destroyed') continue;
      const d = en.fuel.depot;
      if (en.fuel.phase === 'toDepot' || en.fuel.phase === 'fueling') busy[d] = (busy[d] || 0) + 1;
      if (en.fuel.phase === 'ring' && en.state === HALTED) (waiting[d] = waiting[d] || []).push(en);
    }
    for (const [d, q] of Object.entries(waiting)) {
      let free = depotSlots(d) - (busy[d] || 0);
      if (free <= 0) continue;
      q.sort((a, b) => (a.fuel.ringSince - b.fuel.ringSince) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const en of q) {
        if (free-- <= 0) break;
        en.fuel.phase = 'toDepot';
        en.state = MOVING;
      }
    }
  }

  /* ---------- minimum spacing ----------
     Vehicles keep a longitudinal gap and slow to hold it. That is what turns a
     narrow gate into a queue instead of a stack of symbols on one pixel: the
     column compresses to the gap, the arrival rate at the choke exceeds the
     departure rate, and a tail grows backwards along the inbound leg. The jam
     is emergent from the geometry Lee drew, not scripted.

     TWO TRAPS, both hit while prototyping this on 2026-09-21.

     1. LATERAL TOLERANCE. A vehicle only follows one that is in its own file.
        Without this, sixteen vehicles abreast across a 749 m gate each counted
        the one beside it as "ahead" and the whole wave froze on the start line.

     2. A STRICT PRIORITY ORDER. Two vehicles converging on a choke can each be
        in front of the other, so each yields and both stop for ever. Ordering
        by distance remaining — nearest its objective moves first — is a total
        order, so it cannot contain a cycle and the leader always moves. The id
        breaks ties, because an unstable sort would make a run depend on the
        order the array happened to be in, and that would break determinism. */
  const DEFAULT_MIN_GAP_M  = 20;
  const DEFAULT_LANE_TOL_M = 10;

  function spacing() {
    const s = (scn && scn.spacing) || {};
    return {
      gap: Number(s.minGapM)  >= 0 ? Number(s.minGapM)  : DEFAULT_MIN_GAP_M,
      lat: Number(s.laneTolM) >  0 ? Number(s.laneTolM) : DEFAULT_LANE_TOL_M
    };
  }

  /* ---------- one logical step ----------
     dt is the clock's step in seconds and nothing else. No wall clock, no
     frame delta: that is what makes a run at 3x come out identical to the same
     run at 1x. */
  function tick(t, dt) {
    nowT = t;
    for (const en of ents) {
      if (en.state === 'staged' && t >= en.startSec && !en.lostAboard) { en.state = MOVING; pickPath(en); }
    }

    /* Halted vehicles still occupy ground, so they are in the position map and
       everything still yields to them — a column does not drive through the one
       in front just because it has stopped. */
    /* Fuel first: a vehicle whose refuel time is up leaves the truck, and ring
       waiters are released into whatever slots that frees, before anyone moves. */
    for (const en of ents) {
      if (en.fuel && en.fuel.phase === 'fueling' && en.state === HALTED && t >= en.fuel.doneAt) {
        en.fuel.phase = 'done';
        en.state = MOVING;
      }
    }
    releaseFromRings();
    workLanes(t, dt);

    const active = ents.filter(en => en.state === MOVING || en.state === HALTED);
    if (active.length === 0) return;

    const at = new Map();
    for (const en of active) at.set(en, SIM_SCENARIO.routeAt(en.route, en.s));

    active.sort((a, b) =>
      ((a.route.lengthM - a.s) - (b.route.lengthM - b.s)) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const { gap: MIN_GAP, lat: LANE_TOL } = spacing();

    for (let i = 0; i < active.length; i++) {
      const en = active[i], here = at.get(en);

      if (en.state === HALTED && en.fuel && (en.fuel.phase === 'ring' || en.fuel.phase === 'fueling')) {
        en.vKph = 0; continue;               /* released above, or not at all */
      }
      if (en.state === HALTED && en.breach && en.breach.phase === 'breaching') {
        if (laneOpen(en.breach.lane, t)) { en.breach.phase = 'done'; en.state = MOVING; }
        else { en.vKph = 0; continue; }
      }

      if (en.state === HALTED) {
        /* Only a vehicle waiting on a LANE resumes by itself. A contact halted
           from outside — setState('halted'), which is how a future adjudication
           will stop a column — has no lane and stays stopped until something
           else moves it. Section 30 catches it if this inverts. */
        if (en.lane && laneOpen(en.lane, t)) en.state = MOVING;
        else { en.vKph = 0; continue; }
      }

      let want = (here.speedKph / 3.6) * dt;

      if (MIN_GAP > 0) {
        const hr = here.heading * Math.PI / 180;
        const hx = Math.sin(hr), hy = Math.cos(hr);
        let ahead = Infinity;
        for (let j = 0; j < i; j++) {
          /* A vehicle parked on a refuel ring is pulled off to the side on the
             perimeter; the ones still arriving drive past it to their own slots.
             Counting it as "ahead" jammed seven of sixteen short of the ring. */
          const o = active[j];
          if (o.fuel && o.fuel.phase === 'ring' && o.state === HALTED) continue;
          /* An engineer is waved through the column. Everything queued at a
             holding area — halted, or stopped nose-to-tail behind the halted
             ones — is waiting on the lane IT has to open, so letting any of it
             block the engineer deadlocks the breach. Found on v2.8 with two
             waves: the second engineer sat 62 m short of LANE 01 behind the
             queue until the first had opened it. Engineers still keep their
             distance from each other. */
          if (en.breach && o.type !== 'engineering') continue;
          const p = at.get(o);
          const dE = p.e - here.e, dN = p.n - here.n;
          const fwd = dE * hx + dN * hy;
          if (fwd <= 0 || fwd >= ahead) continue;
          if (Math.abs(dN * hx - dE * hy) < LANE_TOL) ahead = fwd;
        }
        if (ahead < Infinity) want = Math.min(want, Math.max(0, ahead - MIN_GAP));
      }

      /* An engineer stops at its lane and works until the lane is open. */
      if (en.breach && en.breach.phase === 'pending' && en.s + want >= en.breach.atM) {
        want = Math.max(0, en.breach.atM - en.s);
        if (!laneOpen(en.breach.lane, t)) { en.state = HALTED; en.breach.phase = 'breaching'; }
        else en.breach.phase = 'done';
      }

      /* Stop on the ring slot to wait for fuel, and at the truck to take it. */
      if (en.fuel && en.fuel.phase === 'pending' && en.s + want >= en.fuel.ringAtM) {
        want = Math.max(0, en.fuel.ringAtM - en.s);
        en.state = HALTED;
        en.fuel.phase = 'ring';
        en.fuel.ringSince = t;
      } else if (en.fuel && en.fuel.phase === 'toDepot' && en.s + want >= en.fuel.fuelAtM) {
        want = Math.max(0, en.fuel.fuelAtM - en.s);
        en.state = HALTED;
        en.fuel.phase = 'fueling';
        en.fuel.doneAt = t + fuelling().sec;
      }

      /* Stop at the holding area while the lane is shut. The first vehicle to
         arrive starts the breach clock for that lane. */
      if (en.holdAtM !== null && en.s < en.holdAtM && !laneOpen(en.lane, t)) {
        if (en.s + want >= en.holdAtM) {
          want = en.holdAtM - en.s;
          en.state = HALTED;
          const L = lanes[en.lane];
          if (L && L.firstArrivalSec === null) {
            L.firstArrivalSec = t;
            /* An engineer lane is opened by work (workLanes), not by the clock. */
            if (!L.byEngineer) L.openAt = (L.breachSec === null) ? null : t + L.breachSec;
          }
        }
      }

      en.vKph = dt > 0 ? (want / dt) * 3.6 : 0;
      en.s += want;
      if (en.throughAt === null && en.crossAtM !== null && en.s >= en.crossAtM) en.throughAt = t + dt;
      if (en.s >= en.route.lengthM) {
        en.s = en.route.lengthM;
        en.state = 'arrived';
      }
    }
  }

  /* ---------- what the renderer and the panels read ----------
     Position is resolved here rather than stored, so there is exactly one
     answer to where something is and it always agrees with its distance. */
  function view(en) {
    const p = SIM_SCENARIO.routeAt(en.route, en.s);
    /* Waiting on the ring it faces OUT — security, not the direction it drove in. */
    const facing = (en.fuel && en.fuel.phase === 'ring' && en.state === HALTED && en.fuel.faceDeg !== null)
      ? en.fuel.faceDeg : p.heading;
    return {
      id: en.id, type: en.type, state: en.state, hpt: en.hpt,
      stopped: en.state === 'destroyed', stoppedAt: en.stoppedAt,
      through: en.throughAt !== null, throughAt: en.throughAt,
      label: en.cls.label, lengthM: en.cls.lengthM, widthM: en.cls.widthM,
      e: p.e, n: p.n, elev: p.elev, heading: facing,
      /* The speed it is actually making, not the leg's nominal: a vehicle
         held behind a choke reports 0 while the leg still says 15. */
      speedKph: en.state === MOVING ? (typeof en.vKph === 'number' ? en.vKph : p.speedKph) : 0,
      nominalKph: p.speedKph,
      held: en.state === MOVING && typeof en.vKph === 'number' && en.vKph < p.speedKph - 0.01,
      metresAlongRoute: en.s,
      waitingForLane: (en.state === HALTED && !(en.fuel && (en.fuel.phase === 'ring' || en.fuel.phase === 'fueling'))) ? en.lane : null,
      /* 'ring' = waiting for a slot, 'fueling' = at a truck, else null. */
      breaching: (en.state === HALTED && en.breach && en.breach.phase === 'breaching') ? en.breach.lane : null,
      waitingForFuel: (en.state === HALTED && en.fuel && (en.fuel.phase === 'ring' || en.fuel.phase === 'fueling')) ? en.fuel.phase : null,
      routeLengthM: en.route.lengthM,
      leg: p.leg
    };
  }

  /* Staged entities are left out: they have not entered the scenario, and a
     contact sitting on its start point before its time is a contact the student
     can see and should not. A STOPPED vehicle stays in (Lee, 2026-09-27: it
     freezes in place, dim, tagged STOPPED) — except cargo lost aboard its
     landing craft, which never came ashore to be seen. */
  function list() {
    return ents.filter(en => en.state !== 'staged' && !en.lostAboard).map(view);
  }

  /* ---------- what a volley can hit ----------
     Everything on the field and not already stopped, plus cargo still aboard
     a landing craft that is itself under way or beached. Cargo aboard sits at
     the craft's position; the damage table decides who may shoot it. */
  function targets() {
    const out = [];
    const byId = new Map(ents.map(en => [en.id, en]));
    for (const en of ents) {
      if (en.state === 'destroyed' || en.lostAboard) continue;
      if (en.throughAt !== null) continue;          /* past the delay line: out of reach */
      if (en.state === 'staged') {
        const c = en.carrier && byId.get(en.carrier);
        if (!c || c.state === 'staged') continue;
        const p = SIM_SCENARIO.routeAt(c.route, c.s);
        out.push({ id: en.id, type: en.type, e: p.e, n: p.n, aboard: true, carrier: c.id });
        continue;
      }
      const p = SIM_SCENARIO.routeAt(en.route, en.s);
      out.push({ id: en.id, type: en.type, e: p.e, n: p.n, aboard: false });
    }
    return out;
  }

  /* It stops. Aboard, it is lost with the load and never offloads. */
  function stop(id, t) {
    const en = ents.find(e => e.id === id);
    if (!en || en.state === 'destroyed' || en.lostAboard) return false;
    if (en.throughAt !== null) return false;       /* through: a score cannot be undone */
    if (en.state === 'staged') en.lostAboard = true;
    else en.state = 'destroyed';
    en.vKph = 0;
    en.stoppedAt = typeof t === 'number' ? t : nowT;
    return true;
  }

  function get(id) {
    const en = ents.find(e => e.id === id);
    return en ? view(en) : null;
  }

  function setState(id, state) {
    const en = ents.find(e => e.id === id);
    if (!en) return false;
    en.state = state;
    return true;
  }

  /* ---------- the score (Lee, 2026-09-28) ----------
     Every ZBD is in exactly one bucket, so the student can see what the fuel
     trucks and engineers they hit did to the ZBDs. Kills by type are kept
     too, "for fun". */
  const ZBD = 'amphibious-assault-vehicle';
  function tally() {
    const out = { label: delayLabel, zbd: 0, through: 0, stopped: 0, heldObstacle: 0, heldFuel: 0, moving: 0,
                  kills: { ZBD: 0, FUEL: 0, ENG: 0 } };
    for (const en of ents) {
      const dead = en.state === 'destroyed' || en.lostAboard;
      if (dead) {
        if (en.type === ZBD) out.kills.ZBD++;
        else if (en.type === 'logistics') out.kills.FUEL++;
        else if (en.type === 'engineering') out.kills.ENG++;
      }
      if (en.type !== ZBD) continue;
      out.zbd++;
      if (dead) out.stopped++;
      else if (en.throughAt !== null) out.through++;
      else if (en.state === HALTED && en.fuel && (en.fuel.phase === 'ring' || en.fuel.phase === 'fueling')) out.heldFuel++;
      /* Waiting on a shut lane: at the holding area, or queued nose-to-tail
         behind the ones that are (moving, but making no way). */
      else if (en.lane && !laneOpen(en.lane, nowT) && (!en.fuel || en.fuel.phase === 'done') &&
               (en.state === HALTED || (en.state === MOVING && typeof en.vKph === 'number' && en.vKph < 1)))
        out.heldObstacle++;
      else out.moving++;
    }
    return out;
  }

  return { load, reset, tick, list, get, setState, targets, stop, obstacles, tally, count: () => ents.length,
           lanes: () => JSON.parse(JSON.stringify(lanes)) };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_ENTITIES;
