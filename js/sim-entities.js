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
                    firstArrivalSec: null, openAt: null };
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
          const p = at.get(active[j]);
          const dE = p.e - here.e, dN = p.n - here.n;
          const fwd = dE * hx + dN * hy;
          if (fwd <= 0 || fwd >= ahead) continue;
          if (Math.abs(dN * hx - dE * hy) < LANE_TOL) ahead = fwd;
        }
        if (ahead < Infinity) want = Math.min(want, Math.max(0, ahead - MIN_GAP));
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
            L.openAt = (L.breachSec === null) ? null : t + L.breachSec;
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
    return {
      id: en.id, type: en.type, state: en.state, hpt: en.hpt,
      label: en.cls.label, lengthM: en.cls.lengthM, widthM: en.cls.widthM,
      e: p.e, n: p.n, elev: p.elev, heading: p.heading,
      /* The speed it is actually making, not the leg's nominal: a vehicle
         held behind a choke reports 0 while the leg still says 15. */
      speedKph: en.state === MOVING ? (typeof en.vKph === 'number' ? en.vKph : p.speedKph) : 0,
      nominalKph: p.speedKph,
      held: en.state === MOVING && typeof en.vKph === 'number' && en.vKph < p.speedKph - 0.01,
      metresAlongRoute: en.s,
      waitingForLane: en.state === HALTED ? en.lane : null,
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
