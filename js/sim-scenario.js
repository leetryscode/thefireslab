/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   Fire Mission Sim — scenario data and route geometry.

   Data and pure geometry. No DOM, no clock, no drawing, no state that changes
   during a run — SIM_ENTITIES owns all of that. Everything here can be computed
   once at load and never touched again.

   ---------------------------------------------------------
   A ROUTE IS GEOMETRY PLUS A SPEED. IT IS NOT A LIST OF TIMESTAMPS.

   The tempting shape is waypoints as {grid, t} with positionAt(t). It is less
   code and it works fine for one contact. It also dead-ends the whole design,
   because a time-parameterized path cannot be DELAYED, and delay is the game.
   The moment a killed breacher has to hold a column at an obstacle lane,
   position stops being a function of t.

   So a route is a polyline with a speed on each leg, and an entity carries its
   own distance along it. SIM_ENTITIES integrates that distance one logical step
   at a time. Halting a column is then setting a state, not rewriting a path.

   See claude/sim-clock-design.md.
   ---------------------------------------------------------

   API:
     SIM_SCENARIO.CLASSES              the entity class table — ONE vocabulary
     SIM_SCENARIO.CLASS_LABELS         engine key -> what is said on the net
     SIM_SCENARIO.ENVIRONMENTS         what the target is sitting in
     SIM_SCENARIO.prepare(scn)         resolve grids, measure legs. Returns scn.
     SIM_SCENARIO.routeAt(route, s)    {e, n, elev, heading, leg, speedKph, atEnd}
     SIM_SCENARIO.SAMPLE               the one scenario that exists today
   ========================================================= */

const SIM_SCENARIO = (() => {

  /* ---------- the class table ----------
     ONE VOCABULARY, NOT TWO. Lee's list from `call for fire instructions v2`,
     2026-09-19, and it is deliberately the same list the student picks from in
     the call for fire as the one the engine knows the contact actually is.

     That was an open question and he closed it: same list. He also expects to
     keep refining it, so treat this table as the single place it changes — the
     call-for-fire dropdown is built from it rather than repeating it.

     `label` is what floats above the contact; `hpt` marks a high-payoff target.
     Only `engineering` carries it, because the breacher is the one Lee has
     actually named as the designed HPT. Nothing else is flagged on a guess.

     THE DIMENSIONS AND SPEEDS ARE PLACEHOLDERS, not researched figures —
     plausible orders of magnitude so the footprints draw at a believable size.
     They set how big a thing looks and how long a run takes, so they want
     replacing before any tuning. `amphibious-assault-craft` is the workhorse,
     since most targets in the real scenario will be one; its 9.5 x 3.4 m is a
     rough stand-in for Lee's reference vehicle (a ZBD-05) and is NOT verified.
     He is supplying real numbers. */
  const CLASSES = {
    'amphibious-assault-craft': { label: 'AAC', lengthM:  9.5, widthM:  3.4, defaultKph: 40, hpt: false },
    'engineering':              { label: 'ENG', lengthM:  7.5, widthM:  3.4, defaultKph: 25, hpt: true  },
    'landing-craft':            { label: 'LC',  lengthM: 35.0, widthM: 10.0, defaultKph: 20, hpt: false },
    'self-propelled-artillery': { label: 'SPA', lengthM: 10.0, widthM:  3.5, defaultKph: 35, hpt: false },
    'logistics':                { label: 'LOG', lengthM:  9.0, widthM:  2.6, defaultKph: 40, hpt: false }
  };

  /* What the student says the target is sitting in. Lee's list; the call for
     fire builds its dropdown from here so there is one place to change it. */
  const ENVIRONMENTS = ['in the open', 'in the urban environment', 'in the water'];

  /* The label the student sees for a class in the call for fire. The engine key
     is kebab-case; the net is plain English. */
  const CLASS_LABELS = {
    'amphibious-assault-craft': 'amphibious assault craft',
    'engineering':              'engineering',
    'landing-craft':            'landing craft',
    'self-propelled-artillery': 'self propelled artillery',
    'logistics':                'logistics'
  };

  /* ---------- the sample track ----------
     Lee's seven grids, 2026-09-19: in from seaward, across the beach, onto the
     road. Throwaway data whose job is to make one symbol move; the shape of the
     object is the part meant to last.

     The contact is an amphibious assault craft — Lee's reference is a ZBD-05,
     and most targets in the real scenario will be this. That is what makes one
     entity on one route from open water to the parking lot coherent: it swims
     ashore and keeps driving. A landing craft would have had to hand off at the
     beach, which is two entities on two routes.

     Speeds are per leg because this track crosses three mediums, and a single
     figure would make either the water crossing tedious or the beach exit
     absurd. A leg's speedKph applies from that point to the next one.

     THE WATER SPEED IS A PLACEHOLDER AND PROBABLY LOW. A high-water-speed
     amphibian is usually credited with considerably more than 20 km/h on the
     water; that figure came from an assumed landing craft and has not been
     revisited. Lee is supplying the real dimensions and speeds.

     Elevation is a flat 0 for the whole route: right for open water and the
     0-8 m coastal plain, and wrong the moment a route climbs. A route that goes
     inland needs per-point elevation, and the plain is where the engagement
     happens, so that is not today's problem. */
  const SAMPLE = {
    id: 'sample-track',
    name: 'Sample track — single contact from seaward',
    durationSec: 900,
    routes: {
      'seaward-1': {
        elevM: 0,
        points: [
          { grid: '20Q KF 05839 00540', speedKph: 20, note: 'ocean start, on the horizon' },
          { grid: '20Q KF 05105 01305', speedKph: 20, note: 'ocean' },
          { grid: '20Q KF 04324 01816', speedKph: 12, note: 'approaching the beach' },
          { grid: '20Q KF 04265 02176', speedKph: 15, note: 'on the beach' },
          { grid: '20Q KF 04307 02239', speedKph: 15, note: 'more beach' },
          { grid: '20Q KF 04336 02301', speedKph: 30, note: 'enters the road' },
          { grid: '20Q KF 04251 02394', speedKph: 30, note: 'closer, on the parking lot' }
        ]
      }
    },
    entities: [
      { id: 'A01', type: 'amphibious-assault-craft', route: 'seaward-1', startSec: 0 }
    ]
  };

  /* ---------- preparation ----------
     Grids to UTM, leg lengths, leg bearings, cumulative distance. Done once, so
     the tick does nothing but add metres. */
  function prepare(scn) {
    if (!scn || scn._prepared) return scn;
    for (const id of Object.keys(scn.routes || {})) {
      const r = scn.routes[id];
      r.id = id;
      r.nodes = [];
      for (const p of r.points) {
        const u = SIM_PROJ.mgrsToUtm(p.grid);
        if (!u) throw new Error(`[sim-scenario] route ${id}: cannot parse grid "${p.grid}"`);
        r.nodes.push({ e: u.e, n: u.n, grid: p.grid, speedKph: p.speedKph, note: p.note || '' });
      }
      if (r.nodes.length < 2) throw new Error(`[sim-scenario] route ${id} needs at least two points`);

      r.legs = [];
      let cum = 0;
      for (let i = 0; i < r.nodes.length - 1; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1];
        const dE = b.e - a.e, dN = b.n - a.n;
        const len = Math.hypot(dE, dN);
        if (!(len > 0)) throw new Error(`[sim-scenario] route ${id} leg ${i} has zero length`);
        r.legs.push({
          from: i, len, start: cum,
          /* Bearing is clockwise from grid north, which is how everything else
             in a fires conversation is said. Screen geometry is the
             projection's problem, not this file's. */
          heading: (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360,
          speedKph: a.speedKph > 0 ? a.speedKph : 0
        });
        cum += len;
      }
      r.lengthM = cum;
      r.elevM = r.elevM || 0;
    }
    scn._prepared = true;
    return scn;
  }

  /* ---------- where a route is, s metres along it ----------
     Clamped at both ends rather than extrapolating: an entity that has run out
     of route sits at the last point, it does not sail off into the Atlantic on
     the last leg's bearing. */
  function routeAt(route, s) {
    const legs = route.legs, last = legs[legs.length - 1];
    const d = Math.max(0, Math.min(route.lengthM, Number(s) || 0));

    let leg = 0;
    while (leg < legs.length - 1 && d >= legs[leg].start + legs[leg].len) leg++;

    const L = legs[leg];
    const a = route.nodes[L.from], b = route.nodes[L.from + 1];
    const f = L.len > 0 ? (d - L.start) / L.len : 0;
    return {
      e: a.e + (b.e - a.e) * f,
      n: a.n + (b.n - a.n) * f,
      elev: route.elevM,
      heading: L.heading,
      speedKph: L.speedKph,
      leg,
      atEnd: d >= route.lengthM - 1e-9 && L === last
    };
  }

  return { CLASSES, CLASS_LABELS, ENVIRONMENTS, SAMPLE, prepare, routeAt };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_SCENARIO;
