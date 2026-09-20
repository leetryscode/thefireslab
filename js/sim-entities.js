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
        state: (Number(spec.startSec) || 0) <= 0 ? MOVING : 'staged'
      };
    });
    return ents.length;
  }

  function load(scenario) {
    scn = SIM_SCENARIO.prepare(scenario);
    return build();
  }

  function reset() { return scn ? build() : 0; }

  /* ---------- one logical step ----------
     dt is the clock's step in seconds and nothing else. No wall clock, no
     frame delta: that is what makes a run at 3x come out identical to the same
     run at 1x. */
  function tick(t, dt) {
    for (const en of ents) {
      if (en.state === 'staged') {
        if (t >= en.startSec) en.state = MOVING; else continue;
      }
      if (en.state !== MOVING) continue;

      const here = SIM_SCENARIO.routeAt(en.route, en.s);
      en.s += (here.speedKph / 3.6) * dt;
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
      speedKph: en.state === MOVING ? p.speedKph : 0,
      metresAlongRoute: en.s,
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

  return { load, reset, tick, list, get, setState, count: () => ents.length };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_ENTITIES;
