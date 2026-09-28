/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved. */
/* =========================================================
   Fire Mission Sim — Predator: one-way attack drones that seek.

   Lee, 2026-09-28. A small loitering munition (Switchblade-type) used both as
   a swarm and to pick off single vehicles. The student sends up to 20 in one
   call for fire; they launch one every 10 s, fly 4 minutes to a grid or a
   drawn area (TAI / EA), then SEARCH for the class of vehicle the student
   named, loiter up to 5 minutes, and dive. One roll per strike, like the
   artillery: a chance to stop by class. A drone that finds nothing is lost.

   ---------------------------------------------------------
   WHERE A DRONE LOOKS
     grid in the water   every vehicle of the named class in the water
                         within 2 km (easy to see on water — "virtually
                         guaranteed")
     grid on land        within 300 m of the grid (the urban clutter limits
                         it; Lee tried 200 and settled on 300)
     TAI / EA            anywhere inside the drawn shape
   The search area is FIXED on the aim point. On land that makes a drone an
   ambush on a point: with a 4-minute flight, a vehicle seen now is ~1.3 km
   away by the time the drone arrives. The student has to aim where the enemy
   WILL be — a refuel ring, a depot, a breach lane.

   WHO IT PICKS: at random among the live vehicles of the named class in its
   search area (keyed dice, so a replay picks the same). No claiming — two
   drones can pick the same vehicle, which is Lee's call. A drone whose target
   is stopped by someone else before it arrives searches again.
   ---------------------------------------------------------

   Tick-integrated like the vehicles (sim-entities.js): what a drone finds
   depends on where the enemy is, so it cannot be a function of time alone.
   Every random number is keyed to the drone, so 30x is the same run as 1x.

   API:
     SIM_DRONES.reset()
     SIM_DRONES.launch({ id, mission, index, launchAt, aim, cls })
         aim: { e, n, water } for a grid, or { area: name, points: [{e,n}], e, n }
     SIM_DRONES.tick(t, dt)            needs SIM_ENTITIES and SIM_DAMAGE
     SIM_DRONES.list(tSec)             positions for the renderer
     SIM_DRONES.get(id) / all()
     SIM_DRONES.pStop(type, inWater)
     SIM_DRONES.CONFIG
   ========================================================= */

const SIM_DRONES = (() => {

  /* EVERY NUMBER HERE IS A PLACEHOLDER Lee set on 2026-09-28 for tuning.
     The total on hand lives with the unit in sim-missions.js. */
  const CONFIG = {
    maxPerMission: 20,
    launchEverySec: 10,
    tofSec: 240,           /* launch to arrival over the aim point */
    loiterSec: 300,        /* then lost */
    landRadiusM: 300,
    waterRadiusM: 2000,
    diveSec: 8,            /* from choosing a target to the strike */
    speedMps: 28,          /* ~100 km/h, for the picture only */
    cruiseM: 140,          /* height over the aim point while searching */
    orbitM: 120,
    showSec: 60            /* drawn for the last minute of the flight in */
  };

  /* Chance one strike stops the vehicle (Lee, 2026-09-28). Not armour-piercing
     — a mobility kill is enough, and in the water it is fatal. */
  const P_STOP = {
    'amphibious-assault-vehicle': { water: 0.5, land: 0.6 },
    'self-propelled-artillery':   { water: 0.5, land: 0.6 },
    'engineering':                { water: 0.6, land: 0.6 },
    'logistics':                  { water: 0.8, land: 0.8 }
    /* landing-craft: absent, so immune */
  };

  let drones = [];
  const seed = 0xD20E5;

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

  function pStop(type, inWater) {
    const row = P_STOP[type];
    return row ? (inWater ? row.water : row.land) : 0;
  }

  function reset() { drones = []; return true; }

  function launch(spec) {
    const d = {
      id: spec.id, mission: spec.mission, index: spec.index,
      launchAt: spec.launchAt, arriveAt: spec.launchAt + CONFIG.tofSec,
      aim: spec.aim, cls: spec.cls,
      state: 'queued',            /* queued -> transit -> loiter -> dive -> done | lost */
      target: null, diveAt: null, diveFrom: null, strikeAt: null,
      picks: 0, result: null
    };
    drones.push(d);
    return d;
  }

  /* ---------- the search area ---------- */
  function inPolygon(pts, e, n) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (((a.n > n) !== (b.n > n)) && (e < (b.e - a.e) * (n - a.n) / (b.n - a.n) + a.e)) inside = !inside;
    }
    return inside;
  }
  const wet = (e, n) => (typeof SIM_DAMAGE !== 'undefined' && SIM_DAMAGE.inWater) ? SIM_DAMAGE.inWater(e, n) : false;

  /* A drawn area is searched in full, AND the drone still sees what it would
     see from a grid at the area's centre (all water within 2 km if the centre
     is on the water, 300 m if on land). Lee, 2026-09-28: the TAIs overlap on
     purpose — "I don't want drones stupidly missing a target they would see".
     A wave crosses a TAI in about two minutes; without this, a drone arriving
     just after would orbit an empty shape beside a full one. */
  function searchArea(aim) {
    if (aim.points && aim.points.length >= 3) {
      const near = searchArea({ e: aim.e, n: aim.n, water: wet(aim.e, aim.n) });
      return { kind: 'area', test: t => inPolygon(aim.points, t.e, t.n) || near.test(t) };
    }
    if (aim.water) return { kind: 'water', test: t => wet(t.e, t.n) && Math.hypot(t.e - aim.e, t.n - aim.n) <= CONFIG.waterRadiusM };
    return { kind: 'land', test: t => Math.hypot(t.e - aim.e, t.n - aim.n) <= CONFIG.landRadiusM };
  }

  /* One look at the field per step, shared by every drone searching in it. */
  let pool = null;
  function field() {
    if (pool) return pool;
    pool = (typeof SIM_ENTITIES === 'undefined' || !SIM_ENTITIES.targets) ? [] : SIM_ENTITIES.targets().filter(t => !t.aboard);
    return pool;
  }
  function candidates(d) {
    const area = searchArea(d.aim);
    return field()
      .filter(t => t.type === d.cls && area.test(t))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /* Where a drone is at time s (sim seconds): the last minute of the flight in,
     an orbit over the aim point, or the dive. For the picture — and for the
     dive's starting point, which is the only place the engine uses it. */
  const CAM = () => {
    if (typeof SIM_PROJ === 'undefined' || !SIM_PROJ.camera || !SIM_PROJ.latLonToUtm) return null;
    const g = SIM_PROJ.camera.geodetic;
    return SIM_PROJ.latLonToUtm(g.lat, g.lon);
  };
  function orbitAt(d, s) {
    const ph = u01(d.id + '|orbit') * Math.PI * 2;
    const w = CONFIG.speedMps / CONFIG.orbitM;
    const a = ph + (s - d.arriveAt) * w;
    return { e: d.aim.e + CONFIG.orbitM * Math.cos(a), n: d.aim.n + CONFIG.orbitM * Math.sin(a), h: CONFIG.cruiseM };
  }
  function positionAt(d, s, targetPos) {
    if (s < d.launchAt || d.state === 'queued') return null;
    if (d.state === 'done' || d.state === 'lost') return null;
    if (s < d.arriveAt) {
      const left = d.arriveAt - s;
      if (left > CONFIG.showSec) return null;           /* still off the feed */
      const cam = CAM();
      let ux = 0, uy = -1;
      if (cam) { const dx = cam.e - d.aim.e, dy = cam.n - d.aim.n, L = Math.hypot(dx, dy) || 1; ux = dx / L; uy = dy / L; }
      const back = left * CONFIG.speedMps;
      /* spread the stream a little so twenty drones are not one dot */
      const off = (u01(d.id + '|lane') - 0.5) * 60;
      return { e: d.aim.e + ux * back - uy * off * (left / CONFIG.showSec),
               n: d.aim.n + uy * back + ux * off * (left / CONFIG.showSec),
               h: CONFIG.cruiseM + 40 * (left / CONFIG.showSec) };
    }
    if (d.state === 'dive' && d.diveFrom && targetPos) {
      const k = Math.max(0, Math.min(1, (s - d.diveAt) / CONFIG.diveSec));
      return { e: d.diveFrom.e + (targetPos.e - d.diveFrom.e) * k,
               n: d.diveFrom.n + (targetPos.n - d.diveFrom.n) * k,
               h: d.diveFrom.h * (1 - k) + 2 * k };
    }
    return orbitAt(d, s);
  }

  /* ---------- one step ----------
     Drones only ever read the vehicles and stop them through SIM_ENTITIES.
     Every outcome goes to SIM_DAMAGE's log so the fires log shows it. */
  function record(d, roll) {
    if (typeof SIM_DAMAGE !== 'undefined' && SIM_DAMAGE.recordDrone) SIM_DAMAGE.recordDrone(d, roll);
  }

  function tick(t, dt) {
    const now = t + (dt || 0);
    pool = null;
    for (const d of drones) {
      if (d.state === 'done' || d.state === 'lost') continue;
      if (d.state === 'queued' && now >= d.launchAt) d.state = 'transit';
      if (d.state === 'transit' && now >= d.arriveAt) d.state = 'loiter';

      if (d.state === 'dive' && now >= d.strikeAt) {
        const tgt = (typeof SIM_ENTITIES !== 'undefined') ? SIM_ENTITIES.get(d.target) : null;
        if (!tgt || tgt.stopped || tgt.through) {
          /* someone else stopped it first, or it got past the delay line
             (out of reach): look again if there is time */
          d.state = 'loiter'; d.target = null;
        } else {
          const w = wet(tgt.e, tgt.n);
          const p = pStop(tgt.type, w);
          const hit = u01(`${d.id}|strike|${d.picks}`) < p;
          if (hit) { SIM_ENTITIES.stop(tgt.id, now); pool = null; }
          d.state = 'done';
          d.result = { id: tgt.id, type: tgt.type, pStop: p, stopped: hit, water: w, at: now, e: tgt.e, n: tgt.n };
          record(d, d.result);
          continue;
        }
      }

      if (d.state === 'loiter') {
        if (now >= d.arriveAt + CONFIG.loiterSec) {
          d.state = 'lost';
          d.result = { lost: true, at: now };
          record(d, d.result);
          continue;
        }
        const c = candidates(d);
        if (c.length) {
          const pick = c[Math.floor(u01(`${d.id}|pick|${d.picks}`) * c.length)];
          d.picks++;
          d.target = pick.id;
          d.state = 'dive';
          d.diveAt = now;
          d.strikeAt = now + CONFIG.diveSec;
          d.diveFrom = orbitAt(d, now);
        }
      }
    }
  }

  function list(tSec) {
    const out = [];
    for (const d of drones) {
      let tp = null;
      if (d.state === 'dive' && typeof SIM_ENTITIES !== 'undefined') tp = SIM_ENTITIES.get(d.target);
      const p = positionAt(d, tSec, tp);
      if (!p) continue;
      /* where it was half a second ago, so the picture can point the nose
         along the flight path; just appeared -> look half a second ahead */
      const back = positionAt(d, tSec - 0.5, tp);
      const fwd = back ? null : positionAt(d, tSec + 0.5, tp);
      const from = back || (fwd ? { e: 2 * p.e - fwd.e, n: 2 * p.n - fwd.n, h: 2 * p.h - fwd.h } : null);
      out.push({ id: d.id, mission: d.mission, index: d.index, state: d.state, e: p.e, n: p.n, h: p.h,
                 prev: from });
    }
    return out;
  }

  const view = d => ({ id: d.id, mission: d.mission, index: d.index, state: d.state, cls: d.cls,
                       launchAt: d.launchAt, arriveAt: d.arriveAt, target: d.target,
                       result: d.result ? { ...d.result } : null });

  return { CONFIG, P_STOP, reset, launch, tick, list, pStop, inPolygon,
           get: id => { const d = drones.find(x => x.id === id); return d ? view(d) : null; },
           all: () => drones.map(view),
           forMission: m => drones.filter(d => d.mission === m).map(view) };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_DRONES;
