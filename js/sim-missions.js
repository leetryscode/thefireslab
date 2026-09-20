/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   Fire Mission Sim — missions in flight.

   Owns what happens between Send and the rounds landing: the target number, the
   time of flight, the method of control, and the radio traffic that goes with
   them. No DOM. It talks to the clock through the event queue and to the page
   through two callbacks.

   ---------------------------------------------------------
   WHAT THIS IS TEACHING, AND WHAT IT IS NOT.

   In scope: that rounds take time to arrive, and that the method of control is
   a choice with consequences. A call for fire names a GRID, and a contact
   moving at 5-8 m/s is tens of metres from where it was by the time the rounds
   get there. Lead is the skill.

   Out of scope: gunnery. There are no firing positions, no charges, no
   ballistics. The time of flight is drawn from a band because the unit
   displaces after every mission, so the range is different every time anyway —
   which is exactly what a student in the observer's seat experiences. Do not
   let this file grow into a fire direction centre.
   ---------------------------------------------------------

   ---------------------------------------------------------
   THE RANDOM DRAW IS SEEDED, AND THAT IS NOT FUSSINESS.

   Everything else in the sim is reproducible: the whole point of the fixed step
   is that a run at 3x comes out identical to the same run at 1x. One call to
   Math.random() in here would throw that away, and it would throw it away
   silently, in the one place that decides whether a mission beat a target to a
   piece of road.

   So the band is drawn from a seeded generator that resets with the scenario.
   The time of flight still differs mission to mission — which is the realism
   Lee wanted — while the same run replayed gives the same answer.
   ---------------------------------------------------------

   API:
     SIM_MISSIONS.init({ clock, onChat, onChange })
     SIM_MISSIONS.send({ unit, type, control, totSec, count, targetType,
                         environment, shell, e, n, elev, grid }) -> {ok, mission|error}
     SIM_MISSIONS.fireNow(id)       give the command for an at-my-command mission
     SIM_MISSIONS.list() / get(id) / reset()
   ========================================================= */

const SIM_MISSIONS = (() => {

  /* ---------- who the student is ----------
     The STUDENT is the fire support coordination centre. The firing units
     answer to them, so every transmission on this net — in both directions —
     opens [recipient] this is [speaker], per Lee. Getting that backwards was
     the bug in the first draft: the replies were labelled FSCC, which is the
     student's own callsign. */
  const OBSERVER = 'Dragonfire FSCC';

  /* ---------- the munitions ----------
     `value` is what the student picks; `spoken` is how it reads inside a
     sentence on the net. Two fields rather than one so "high explosive" can be
     lower case mid-transmission without lower-casing an acronym. */
  const MUNITIONS = [
    { value: 'High explosive',    spoken: 'high explosive' },
    { value: 'One Way Attack UAS', spoken: 'one-way attack UAS' }
  ];
  const spokenShell = v => {
    const m = MUNITIONS.find(x => x.value === v);
    return m ? m.spoken : v;
  };

  /* ---------- everything said on the net, in one place ----------
     DRAFT WORDING, approved by Lee for now. He supplies the exact radio traffic
     and it is used verbatim. Kept together here so replacing it is one edit and
     never a hunt through the logic.

     Order per Lee, 2026-09-19: recipient, speaker, target number, rounds and
     shell, time of flight. */
  const head = m => `${OBSERVER}, this is ${m.unit},`;
  const body = m => `${m.id}, ${m.rounds} rounds ${spokenShell(m.shell)}`;
  const SAY = {
    mto:      m => `${head(m)} ${body(m)}, time of flight ${m.tofSec} seconds, over.`,
    mtoTot:   m => `${head(m)} ${body(m)}, time on target ${SIM_CLOCK.format(m.totSec)}, ` +
                   `time of flight ${m.tofSec} seconds, over.`,
    mtoHold:  m => `${head(m)} ${body(m)}, time of flight ${m.tofSec} seconds. ` +
                   `Ready, at your command, over.`,
    shot:     m => `${head(m)} ${m.id}, shot, over.`,
    splash:   m => `${head(m)} ${m.id}, splash, over.`,
    lateTot:  (m, now) => `${head(m)} unable. Time on target ${SIM_CLOCK.format(m.totSec)} is inside ` +
                          `time of flight — earliest is ${SIM_CLOCK.format(now + m.tofSec)}. ` +
                          `Send a later time on target, over.`
  };

  /* ---------- the firing units ----------
     Lee's spreadsheet, 2026-09-19. SIX SEPARATELY TASKABLE UNITS — two M109
     batteries, two M101 batteries, the RT2000s and the one-way-attack UAS. The
     student tasks a CALLSIGN and never sees the designator except as the type
     shown on the asset board. He expects to narrow this list later.

     dispersionM is recorded and NOT YET USED. Lee has it on standby: spreading
     rounds across that diameter with a burst radius appropriate to the munition,
     then comparing that footprint to an enemy position, is how adjudication and
     any BDA call will work — and none of that is built. The sheaf SIM_RENDER
     draws is still its own placeholder pattern. Fire Storm has no figure at all
     because Lee has not decided how the RT2000s are employed; it will be a big
     area.

     Every band is 20-35 s, Lee's figure, on the reasoning that the unit
     displaces after each mission so the range differs every time. THE PREDATOR
     BAND IS A PLACEHOLDER AND IS ALMOST CERTAINLY WRONG — a one-way attack UAS
     does not transit in half a minute. Left at the tube band so the control flow
     could be built, flagged so it is not mistaken for a decision. */
  const UNITS = [
    { callsign: 'Steel Rain', system: 'M109',   dispersionM: 200,  tof: [20, 35] },
    { callsign: 'Typhoon',    system: 'M109',   dispersionM: 200,  tof: [20, 35] },
    { callsign: 'Anvil',      system: 'M101',   dispersionM: 100,  tof: [20, 35] },
    { callsign: 'Lightning',  system: 'M101',   dispersionM: 100,  tof: [20, 35] },
    { callsign: 'Fire Storm', system: 'RT2000', dispersionM: null, tof: [20, 35] },
    { callsign: 'Predator',   system: 'OWA',    dispersionM: 300,  tof: [20, 35] }
  ];
  const UNIT = {};
  UNITS.forEach(u => { UNIT[u.callsign] = u; });
  const DEFAULT_BAND = [20, 35];

  /* ---------- the types of mission ----------
     Lee's spreadsheet. A mission is no longer one splash: it is `volleys`
     arrivals of `guns` rounds each, `intervalSec` apart.

     Suppression is the odd one: one gun, one round every seven seconds, two
     minutes of coverage. 18 volleys at 7 s spans 119 s, which is that coverage
     to the nearest whole round — the count is derived rather than a second
     number to keep in step with the interval.

     TOT and SPLASH both apply to the FIRST volley only, per Lee. So a time on
     target names when the first rounds arrive, not the middle of the sheaf. */
  const MISSION_TYPES = {
    'Fire for effect':       { guns: 6, volleys: 3,  intervalSec: 20 },
    'Immediate suppression': { guns: 6, volleys: 1,  intervalSec: 0  },
    'Adjust fire':           { guns: 3, volleys: 1,  intervalSec: 0  },
    'Suppression':           { guns: 1, volleys: 18, intervalSec: 7  }
  };
  const DEFAULT_TYPE = 'Fire for effect';

  /* Five seconds before impact, which is when SPLASH is called. */
  const SPLASH_WARN_SEC = 5;

  const FIRST_TARGET_NUM = 1001;

  let clock = null, onChat = null, onChange = null;
  let missions = [];
  let nextNum = FIRST_TARGET_NUM;
  let rng = null;

  /* mulberry32 — small, fast, and good enough for picking a number out of a
     15-second band. Chosen over Math.random purely because it can be reseeded. */
  function seeded(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function changed() { if (onChange) { try { onChange(list()); } catch (e) { console.error(e); } } }
  function say(who, text) { if (onChat) { try { onChat(who, text); } catch (e) { console.error(e); } } }

  function drawTof(callsign) {
    const [lo, hi] = (UNIT[callsign] && UNIT[callsign].tof) || DEFAULT_BAND;
    return lo + Math.floor(rng() * (hi - lo + 1));
  }

  function init(opts) {
    clock = (opts && opts.clock) || (typeof SIM_CLOCK !== 'undefined' ? SIM_CLOCK : null);
    onChat = opts && opts.onChat;
    onChange = opts && opts.onChange;
    reset(opts && opts.seed);
    return true;
  }

  function reset(seed) {
    missions = [];
    nextNum = FIRST_TARGET_NUM;
    rng = seeded(typeof seed === 'number' ? seed : 0x5EED17);
    changed();
    return true;
  }

  /* ---------- a volley lands ----------
     Rounds land HERE, not when Send was pressed. Everything the mission layer
     exists for is in that sentence.

     A mission is `volleys` of these, `intervalSec` apart. The first is the one
     that carries the time on target and the SPLASH call; the rest just arrive. */
  function impact(m, n) {
    m.volleysLanded = n + 1;
    if (n === 0) m.splashedAt = clock.time();
    if (typeof SIM_RENDER !== 'undefined') SIM_RENDER.fireMission(m.e, m.n, m.elev, m.guns);
    m.state = m.volleysLanded >= m.volleys ? 'complete' : 'impacting';
    if (m.state === 'complete') m.completedAt = clock.time();
    changed();
  }

  /* fireTime is when the guns fire, so the FIRST volley lands a time of flight
     later. Every later volley is measured from that first arrival, not from the
     firing: the interval is the interval between rounds on the ground. */
  function fireAt(m, fireTime) {
    m.fireAt = fireTime;
    m.splashAt = fireTime + m.tofSec;
    m.lastVolleyAt = m.splashAt + (m.volleys - 1) * m.intervalSec;
    m.state = 'queued';
    m.volleysLanded = 0;

    clock.at(fireTime, () => {
      m.state = 'inFlight';
      say(m.unit, SAY.shot(m));
      changed();
    });
    /* SPLASH warns for the first volley only, per Lee. Calling it eighteen
       times through a two-minute suppression mission would stop it meaning
       anything. */
    clock.at(m.splashAt - SPLASH_WARN_SEC, () => {
      if (m.state !== 'inFlight') return;
      say(m.unit, SAY.splash(m));
    });
    for (let i = 0; i < m.volleys; i++) {
      clock.at(m.splashAt + i * m.intervalSec, () => impact(m, i));
    }
    changed();
  }

  /* ---------- send ----------
     The three methods of control differ only in WHEN the guns fire; the time of
     flight is the same once they do. That is the whole lesson, and it is why
     they share a path.

       when ready       fire now, land now + tof
       at my command    hold until fireNow(), then land command + tof
       time on target   fire at tot - tof, land at tot
   */
  function send(spec) {
    if (!clock) return { ok: false, error: 'No clock.' };

    const unit    = spec.unit || UNITS[0].callsign;
    const control = spec.control || 'When ready';
    const type    = MISSION_TYPES[spec.type] ? spec.type : DEFAULT_TYPE;
    const pattern = MISSION_TYPES[type];
    const now     = clock.time();

    const m = {
      id: 'AB' + (nextNum++),
      unit, control, type,
      system: (UNIT[unit] && UNIT[unit].system) || '',
      /* Recorded, not used. Lee has dispersion on standby until rounds are
         spread over that diameter and compared against an enemy position. */
      dispersionM: UNIT[unit] ? UNIT[unit].dispersionM : null,
      shell: spec.shell || MUNITIONS[0].value,
      guns: pattern.guns,
      volleys: pattern.volleys,
      intervalSec: pattern.intervalSec,
      rounds: pattern.guns * pattern.volleys,
      /* WHAT THE STUDENT CLAIMED IS ON THE TARGET. Carried on the mission and
         graded by nothing, because there is no adjudication. It is deliberately
         kept separate from what the engine knows is actually there: the gap
         between the two is where adjudication will live. */
      count: spec.count || '',
      targetType: spec.targetType || '',
      environment: spec.environment || '',
      e: spec.e, n: spec.n, elev: spec.elev || 0,
      grid: spec.grid || '',
      tofSec: drawTof(unit),
      totSec: null,
      sentAt: now,
      state: 'ready'
    };

    if (control === 'Time on target') {
      const tot = Number(spec.totSec);
      if (!isFinite(tot)) { nextNum--; return { ok: false, error: 'Time on target needs a time.' }; }
      m.totSec = tot;
      /* A TOT closer than the time of flight cannot be met. Refusing it is the
         teaching point, not an inconvenience: it is why the observer has to know
         roughly how long the rounds take before naming a time. */
      if (tot < now + m.tofSec) {
        say(m.unit, SAY.lateTot(m, now));
        nextNum--;
        return { ok: false, error: `Unable: earliest TOT is ${SIM_CLOCK.format(now + m.tofSec)}.`, mission: m };
      }
      missions.push(m);
      say(m.unit, SAY.mtoTot(m));
      fireAt(m, tot - m.tofSec);
      return { ok: true, mission: m };
    }

    if (control === 'At my command') {
      missions.push(m);
      m.state = 'awaiting';
      say(m.unit, SAY.mtoHold(m));
      changed();
      return { ok: true, mission: m };
    }

    missions.push(m);
    say(m.unit, SAY.mto(m));
    fireAt(m, now);
    return { ok: true, mission: m };
  }

  /* "FIRE." The guns were laid and waiting; the time of flight starts now. */
  function fireNow(id) {
    const m = missions.find(x => x.id === id);
    if (!m || m.state !== 'awaiting') return false;
    fireAt(m, clock.time());
    changed();
    return true;
  }

  function view(m) {
    return {
      id: m.id, unit: m.unit, system: m.system, control: m.control, type: m.type,
      shell: m.shell, rounds: m.rounds, guns: m.guns, volleys: m.volleys,
      intervalSec: m.intervalSec, volleysLanded: m.volleysLanded || 0,
      dispersionM: m.dispersionM,
      count: m.count, targetType: m.targetType, environment: m.environment,
      grid: m.grid, state: m.state, tofSec: m.tofSec, totSec: m.totSec,
      sentAt: m.sentAt, fireAt: m.fireAt, splashAt: m.splashAt,
      lastVolleyAt: m.lastVolleyAt, splashedAt: m.splashedAt, completedAt: m.completedAt
    };
  }

  function list() { return missions.map(view); }
  function get(id) { const m = missions.find(x => x.id === id); return m ? view(m) : null; }
  function active() { return missions.filter(m => m.state !== 'complete').length; }

  return { init, reset, send, fireNow, list, get, active,
           SAY, OBSERVER, MUNITIONS, spokenShell, UNITS, UNIT,
           MISSION_TYPES, DEFAULT_TYPE, SPLASH_WARN_SEC };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_MISSIONS;
