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
           moving <-> halted        (an obstacle, a lost breacher — not built)
           moving -> breaching      (opening a lane — not built)
           any    -> destroyed      (adjudication — not built)

   Only staged, moving and arrived are reachable today. The rest are named now
   so that the day they are wired, nothing else has to change shape.

   API:
     SIM_ENTITIES.load(scenario)   build the live list. Returns the count.
     SIM_ENTITIES.tick(t, dt)      advance every mover by one logical step
     SIM_ENTITIES.reset()          back to the loaded scenario's start state
     SIM_ENTITIES.list()           the live entities, with position resolved
     SIM_ENTITIES.get(id)
     SIM_ENTITIES.setState(id, s)
   ========================================================= */

const SIM_ENTITIES = (() => {

  let scn = null;
  let ents = [];

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
    for (const en of ents) if (en.breach && lanes[en.breach.lane]) lanes[en.breach.lane].byEngineer = true;
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
    return n;
  }

  function reset() { if (!scn) return 0; const n = build(); resetLanes(); return n; }

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
    for (const en of ents) {
      if (en.state === 'staged' && t >= en.startSec) en.state = MOVING;
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
     can see and should not. */
  function list() {
    return ents.filter(en => en.state !== 'staged' && en.state !== 'destroyed').map(view);
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

  return { load, reset, tick, list, get, setState, count: () => ents.length,
           lanes: () => JSON.parse(JSON.stringify(lanes)) };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_ENTITIES;
