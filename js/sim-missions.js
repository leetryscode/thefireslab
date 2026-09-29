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
     SIM_MISSIONS.init({ clock, onChat, onChange, onTyping, seed })
     SIM_MISSIONS.send({ unit, type, control, totSec, count, targetType,
                         environment, shell, e, n, elev, grid }) -> {ok, mission|error}
     SIM_MISSIONS.fireNow(id)       give the command for an at-my-command mission
     SIM_MISSIONS.list() / get(id) / reset()
     SIM_MISSIONS.unitStatus() / status(callsign)   who can be tasked, and when
   ========================================================= */

const SIM_MISSIONS = (() => {

  /* Language (js/sim-i18n.js). Bare in node, where the English is used as is. */
  const T = (k, en, v) => (typeof SIM_I18N !== 'undefined') ? SIM_I18N.t(k, en, v)
    : (v ? en.replace(/\{(\w+)\}/g, (m, x) => (x in v ? v[x] : m)) : en);
  const NAME = cs => (typeof SIM_I18N !== 'undefined') ? SIM_I18N.name(cs) : cs;
  const SLUG = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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
    return m ? T('sim.mun.spoken.' + SLUG(m.value), m.spoken) : v;
  };

  /* ---------- everything said on the net, in one place ----------
     DRAFT WORDING, approved by Lee for now. He supplies the exact radio traffic
     and it is used verbatim. Kept together here so replacing it is one edit and
     never a hunt through the logic.

     Order per Lee, 2026-09-19: recipient, speaker, target number, rounds and
     shell, time of flight. */
  const head = m => T('sim.say.head', '{obs}, this is {unit},', { obs: NAME(OBSERVER), unit: NAME(m.unit) });
  /* Fire Storm fires rockets, not rounds. Placeholder wording like the rest. */
  const body = m => m.system === 'RT2000'
    ? T('sim.say.body.rockets', '{id}, {n} rockets {shell}', { id: m.id, n: m.rounds, shell: spokenShell(m.shell) })
    : T('sim.say.body.rounds',  '{id}, {n} rounds {shell}',  { id: m.id, n: m.rounds, shell: spokenShell(m.shell) });
  const drones = n => n === 1 ? T('sim.drone.one', '{n} drone', { n }) : T('sim.drone.many', '{n} drones', { n });
  const SAY = {
    mto:      m => T('sim.say.mto', '{head} {body}, time of flight {tof} seconds, over.',
                     { head: head(m), body: body(m), tof: m.tofSec }),
    mtoTot:   m => T('sim.say.mtotot', '{head} {body}, time on target {tot}, time of flight {tof} seconds, over.',
                     { head: head(m), body: body(m), tot: SIM_CLOCK.format(m.totSec), tof: m.tofSec }),
    mtoHold:  m => T('sim.say.mtohold', '{head} {body}, time of flight {tof} seconds. Ready, at your command, over.',
                     { head: head(m), body: body(m), tof: m.tofSec }),
    shot:     m => T('sim.say.shot', '{head} {id}, shot, over.', { head: head(m), id: m.id }),
    splash:   m => T('sim.say.splash', '{head} {id}, splash, over.', { head: head(m), id: m.id }),
    /* Predator (Lee, 2026-09-28). Placeholder wording like the rest. */
    mtoDrone: m => T('sim.say.mtodrone', '{head} {id}, {drones}, one every {sec} seconds, time of flight {min} minutes, over.',
                     { head: head(m), id: m.id, drones: drones(m.drones), sec: m.intervalSec, min: Math.round(m.tofSec / 60) }),
    droneAway: m => T('sim.say.droneaway', '{head} {id}, drones away, over.', { head: head(m), id: m.id }),
    noDrones: (unit, left, need) => T('sim.say.nodrones',
                     '{obs}, this is {unit}, unable — insufficient drones, {left} remaining, {need} requested, over.',
                     { obs: NAME(OBSERVER), unit: NAME(unit), left, need }),
    /* Lee, 2026-09-27: refused from the battery itself, over the net. */
    noAmmo:   (unit, left, need) => T('sim.say.noammo',
                     '{obs}, this is {unit}, unable — insufficient ammunition, {left} rounds remaining, {need} required, over.',
                     { obs: NAME(OBSERVER), unit: NAME(unit), left, need }),
    lateTot:  (m, now) => T('sim.say.latetot',
                     '{head} unable. Time on target {tot} is inside time of flight — earliest is {earliest}. Send a later time on target, over.',
                     { head: head(m), tot: SIM_CLOCK.format(m.totSec), earliest: SIM_CLOCK.format(now + m.tofSec) })
  };

  /* ---------- the firing units ----------
     Lee's spreadsheet, 2026-09-19. SIX SEPARATELY TASKABLE UNITS — two M109
     batteries, two M101 batteries, the RT2000s and the one-way-attack UAS. The
     student tasks a CALLSIGN and never sees the designator except as the type
     shown on the asset board. He expects to narrow this list later.

     WHERE ROUNDS LAND AND WHAT THEY DO lives in js/sim-damage.js, and nowhere
     else: the 100 m sheaf, Fire Storm's 600 x 400 m ellipse, the kill radii.
     A mission's `dispersionM` is read from there, not stored here — one home
     for the number (2026-09-27; the M109 was 200 m until then).

     FIRE STORM (Lee, 2026-09-27): one salvo of 36 Mk45 rockets whatever
     mission type is picked, and `salvos: 2` a scenario. Once both are fired the
     unit is spent for the rest of the run.

     AMMUNITION (Lee, 2026-09-27): `rounds` on hand for the whole run, no
     resupply — 230 per M109 battery, 300 per M101 battery (about what six
     guns carry). At the 15-minute recovery a battery will rarely run dry in a
     45-minute fight; it is shown on the asset board for realism. A mission
     needing more than is left is refused by the battery over the net.

     Every band is 20-35 s, Lee's figure, on the reasoning that the unit
     displaces after each mission so the range differs every time. THE PREDATOR
     BAND IS A PLACEHOLDER AND IS ALMOST CERTAINLY WRONG — a one-way attack UAS
     does not transit in half a minute. Left at the tube band so the control flow
     could be built, flagged so it is not mistaken for a decision. */
  const UNITS = [
    { callsign: 'Steel Rain', system: 'M109',   tof: [20, 35], rounds: 230 },
    { callsign: 'Typhoon',    system: 'M109',   tof: [20, 35], rounds: 230 },
    { callsign: 'Anvil',      system: 'M101',   tof: [20, 35], rounds: 300 },
    { callsign: 'Lightning',  system: 'M101',   tof: [20, 35], rounds: 300 },
    { callsign: 'Fire Storm', system: 'RT2000', tof: [20, 35], salvos: 2 },
    /* PREDATOR (Lee, 2026-09-28): seeking one-way attack drones, 30 on hand,
       up to 20 a mission, one launched every 10 s, 4 minutes to the aim point.
       No 15-minute recovery — the launcher is only as busy as its queue. The
       flight, search and strike live in js/sim-drones.js. */
    { callsign: 'Predator',   system: 'OWA',    tof: [240, 240], drones: 30 }
  ];
  /* The sheaf diameter, from the damage table. null for Fire Storm (an
     ellipse, not a circle) and for the OWA (postponed). */
  function dispersionOf(callsign) {
    const u = UNIT[callsign];
    if (!u || typeof SIM_DAMAGE === 'undefined') return null;
    const p = SIM_DAMAGE.pattern(u.system);
    return p && p.kind === 'sheaf' ? p.sheafM : null;
  }
  /* A salvo-limited unit: how many it has left. Resolved on read from the
     mission list, like everything else about availability. */
  function salvosLeft(callsign) {
    const u = UNIT[callsign];
    if (!u || typeof u.salvos !== 'number') return null;
    return Math.max(0, u.salvos - missions.filter(m => m.unit === callsign).length);
  }
  /* Rounds left: what it started with less every mission it has taken. Charged
     when the mission is accepted, so a held at-my-command mission has its
     rounds set aside. */
  function dronesLeft(callsign) {
    const u = UNIT[callsign];
    if (!u || typeof u.drones !== 'number') return null;
    const used = missions.filter(m => m.unit === callsign).reduce((a, m) => a + (m.drones || 0), 0);
    return Math.max(0, u.drones - used);
  }
  const isDroneUnit = callsign => !!(UNIT[callsign] && typeof UNIT[callsign].drones === 'number');

  function roundsLeft(callsign) {
    const u = UNIT[callsign];
    if (!u || typeof u.rounds !== 'number') return null;
    const used = missions.filter(m => m.unit === callsign).reduce((a, m) => a + (m.rounds || 0), 0);
    return Math.max(0, u.rounds - used);
  }
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

  /* ---------- how long the firing unit takes to answer ----------
     About five seconds, drawn 4-6 from the seeded generator so it is not
     metronomic. Somebody at the other end is reading the call for fire back and
     working it up; the student should feel that beat rather than have the
     acknowledgement appear under their own transmission.

     IN SIM SECONDS, on the clock's event queue, like everything else: pause the
     sim and the reply waits too.

     IT GATES THE MISSION, not just the chat line. Nothing is fired until the
     unit has acknowledged, because SHOT arriving before the message to observer
     would read as the guns answering a call nobody confirmed. */
  const REPLY_BAND = [4, 6];

  /* ---------- a battery goes off the air once it has fired ----------
     Fifteen minutes from the moment the mission is SENT, Lee's figure. It
     stands in for displacing after a mission: shoot and move.

     A UNIT IS ALSO BUSY WHILE IT HOLDS AN UNFINISHED MISSION, which is the part
     that actually closes the hole. The interface has no way to cancel a
     mission, so a second one to the same guns would sit in a queue nobody can
     see or unwind. Two rules, one consequence: a unit takes exactly one mission
     at a time.

     That is what settles the far-future time on target. A TOT thirty minutes
     out leaves the unit holding an unfinished mission for thirty minutes, so it
     is unavailable for all of them — it does not come back at fifteen and
     accept a second call that would fire while the first is still pending. */
  const RECOVERY_SEC = 15 * 60;

  const FIRST_TARGET_NUM = 1001;

  let clock = null, onChat = null, onChange = null, onTyping = null;
  let missions = [];
  let nextNum = FIRST_TARGET_NUM;
  let rng = null;
  /* Counted, not a flag: two missions to the same unit in quick succession must
     not have the first reply clear the indicator while the second is pending. */
  let typing = new Map();
  let launcherFreeAt = 0;     /* the next moment the drone launcher is free */
  let hookedClock = null;
  /* callsign -> the sim second it is back on the air */
  let busyUntil = new Map();

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

  function drawReply() {
    const [lo, hi] = REPLY_BAND;
    return lo + Math.floor(rng() * (hi - lo + 1));
  }

  function emitTyping() {
    if (!onTyping) return;
    try { onTyping([...typing.keys()]); } catch (e) { console.error(e); }
  }

  /* The unit is composing. `text` is said when it finishes; whatever else has
     to happen on acknowledgement happens in `then`. */
  function replyAfter(who, at, text, then) {
    typing.set(who, (typing.get(who) || 0) + 1);
    emitTyping();
    clock.at(at, () => {
      const n = (typing.get(who) || 1) - 1;
      if (n > 0) typing.set(who, n); else typing.delete(who);
      emitTyping();
      say(who, text);
      if (then) then();
    });
  }

  function init(opts) {
    clock = (opts && opts.clock) || (typeof SIM_CLOCK !== 'undefined' ? SIM_CLOCK : null);
    onChat = opts && opts.onChat;
    onChange = opts && opts.onChange;
    onTyping = opts && opts.onTyping;
    reset(opts && opts.seed);
    /* Drones fly on the clock's step, after the vehicles (the page subscribes
       the vehicle tick first). Hooked once per clock, however often init runs. */
    if (clock && typeof SIM_DRONES !== 'undefined' && hookedClock !== clock) {
      hookedClock = clock;
      clock.onTick((t, dt) => { SIM_DRONES.tick(t, dt); droneProgress(); });
    }
    return true;
  }

  /* A drone mission moves on as its drones finish: each one that strikes or is
     lost counts as a "volley" landed, and the mission completes with the last. */
  function droneProgress() {
    let moved = false;
    for (const m of missions) {
      if (m.kind !== 'drone' || m.state === 'complete' || m.state === 'sending') continue;
      const ds = SIM_DRONES.forMission(m.id);
      const done = ds.filter(d => d.state === 'done' || d.state === 'lost');
      if (done.length !== (m.volleysLanded || 0)) {
        m.volleysLanded = done.length;
        m.stopped = done.filter(d => d.result && d.result.stopped).map(d => d.result.id);
        if (m.volleysLanded === 1 && m.splashedAt == null) m.splashedAt = clock.time();
        m.state = m.volleysLanded >= m.drones ? 'complete' : 'impacting';
        if (m.state === 'complete') m.completedAt = clock.time();
        moved = true;
      }
    }
    if (moved) changed();
  }

  function reset(seed) {
    missions = [];
    nextNum = FIRST_TARGET_NUM;
    rng = seeded(typeof seed === 'number' ? seed : 0x5EED17);
    launcherFreeAt = 0;
    if (typeof SIM_DRONES !== 'undefined') SIM_DRONES.reset();
    /* The damage dice are keyed to mission ids, which restart here — so the
       same run replayed lands every round in the same place. */
    if (typeof SIM_DAMAGE !== 'undefined') SIM_DAMAGE.reset();
    /* Stop empties the clock's queue, so a reply in flight never lands. The
       indicator has to go with it or a unit types forever. */
    typing = new Map();
    busyUntil = new Map();
    emitTyping();
    changed();
    return true;
  }

  /* ---------- who can be tasked ----------
     Resolved on read from the mission list and the recovery clock, never stored
     as a flag. A flag would have to be cleared in every path that finishes,
     cancels or resets a mission, and the one that got missed would leave a
     battery permanently off the air. */
  /* The drone launcher is never "holding" a mission: it takes the next one and
     queues its launches behind the last. */
  const pending = callsign => isDroneUnit(callsign) ? null :
    (missions.find(m => m.unit === callsign && m.state !== 'complete') || null);

  function status(callsign) {
    const now = clock ? clock.time() : 0;
    const recover = busyUntil.get(callsign) || 0;
    const held = pending(callsign);
    const left = salvosLeft(callsign);
    const dLeft = dronesLeft(callsign);
    const spent = (left === 0 && !held) || dLeft === 0;
    /* A held mission that has not been fired yet has no end time — an
       at-my-command mission waits as long as the student leaves it. */
    const end = held ? (held.lastVolleyAt != null ? Math.max(recover, held.lastVolleyAt) : null)
                     : (recover > now ? recover : null);
    return {
      callsign,
      system: (UNIT[callsign] && UNIT[callsign].system) || '',
      ready: !held && now >= recover && !spent,
      holding: held ? held.id : null,
      spent,
      salvosLeft: left,
      salvosMax: (UNIT[callsign] && typeof UNIT[callsign].salvos === 'number') ? UNIT[callsign].salvos : null,
      roundsLeft: roundsLeft(callsign),
      dronesLeft: dLeft,
      dronesMax: (UNIT[callsign] && typeof UNIT[callsign].drones === 'number') ? UNIT[callsign].drones : null,
      roundsMax: (UNIT[callsign] && typeof UNIT[callsign].rounds === 'number') ? UNIT[callsign].rounds : null,
      backAt: spent ? null : end,
      remainingSec: (!spent && end != null) ? Math.max(0, end - now) : null,
      recoverySec: RECOVERY_SEC
    };
  }

  function unitStatus() { return UNITS.map(u => status(u.callsign)); }

  /* ---------- a volley lands ----------
     Rounds land HERE, not when Send was pressed. Everything the mission layer
     exists for is in that sentence.

     A mission is `volleys` of these, `intervalSec` apart. The first is the one
     that carries the time on target and the SPLASH call; the rest just arrive. */
  function impact(m, n) {
    m.volleysLanded = n + 1;
    if (n === 0) m.splashedAt = clock.time();
    /* Adjudication (2026-09-27): where each round lands, and who stops, judged
       against where every vehicle is at THIS instant. Only when the damage
       table and the entities are loaded — a page without them still fires. */
    let points = null;
    if (typeof SIM_DAMAGE !== 'undefined' && typeof SIM_ENTITIES !== 'undefined' && SIM_ENTITIES.targets) {
      const targets = SIM_ENTITIES.targets().map(t => ({ ...t, inWater: SIM_DAMAGE.inWater(t.e, t.n) }));
      const res = SIM_DAMAGE.resolve({ id: m.id, system: m.system, e: m.e, n: m.n, guns: m.guns }, n, targets);
      for (const id of res.stopped) SIM_ENTITIES.stop(id, clock.time());
      m.stopped.push(...res.stopped);
      points = res.points;
    }
    if (typeof SIM_RENDER !== 'undefined') {
      if (points && SIM_RENDER.impacts) {
        const elevAt = (typeof SIM_TERRAIN !== 'undefined' && SIM_TERRAIN.elevAt) ? SIM_TERRAIN.elevAt : null;
        SIM_RENDER.impacts(points.map(p => ({ e: p.e, n: p.n, elev: elevAt ? elevAt(p.e, p.n) : m.elev })));
      } else SIM_RENDER.fireMission(m.e, m.n, m.elev, m.guns);
    }
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
     Two beats, not one.

     FIRST the unit acknowledges. The student's transmission goes up, the unit
     shows as composing for a few seconds, then the message to observer lands.
     Nothing has been fired at this point.

     THEN the mission runs, and the three methods of control differ only in WHEN
     the guns fire — which is why they share one path into fireAt():

       when ready       fire on acknowledgement, land + tof
       at my command    hold until fireNow(), then land command + tof
       time on target   fire at tot - tof, land at tot

     Splitting it this way is what keeps SHOT from arriving before the
     acknowledgement it answers.
   */
  function send(spec) {
    if (!clock) return { ok: false, error: 'No clock.' };

    const unit    = spec.unit || UNITS[0].callsign;
    const control = spec.control || 'When ready';
    const type    = MISSION_TYPES[spec.type] ? spec.type : DEFAULT_TYPE;
    const pattern = MISSION_TYPES[type];
    const now     = clock.time();

    /* ONE MISSION PER BATTERY, and the check comes first — before a target
       number is drawn, before anything is said on the net.

       Refused IMMEDIATELY, with no acknowledgement delay and no radio traffic:
       these are the student's own guns and their own asset board already shows
       the battery is down. Making them wait five seconds for a unit to tell
       them something they can see on their own screen would be theatre. */
    const st = status(unit);
    if (isDroneUnit(unit)) return sendDrones(spec, unit, now, st);
    if (!st.ready && st.spent) {
      return { ok: false, error: T('sim.err.nosalvos', '{unit} is unavailable — no salvos remaining.', { unit: NAME(unit) }), status: st };
    }
    if (!st.ready) {
      const when = st.backAt != null
        ? T('sim.err.backat', 'back on the air {t}', { t: SIM_CLOCK.format(st.backAt) })
        : T('sim.err.holding', 'still holding {id}', { id: st.holding });
      return { ok: false, error: T('sim.err.unavailable', '{unit} is unavailable — {when}.', { unit: NAME(unit), when }), status: st };
    }

    /* Fire Storm is one salvo whatever type was picked. */
    const system = (UNIT[unit] && UNIT[unit].system) || '';
    const salvo = (typeof SIM_DAMAGE !== 'undefined') && SIM_DAMAGE.pattern(system);
    const shape = (salvo && salvo.kind === 'ellipse')
      ? { guns: salvo.count, volleys: 1, intervalSec: 0 } : pattern;
    /* Not enough rounds for this mission: the battery says so, after its usual
       beat, and nothing is fired. No target number is used up. */
    const have = roundsLeft(unit), need = shape.guns * shape.volleys;
    if (have !== null && need > have) {
      const at = now + drawReply();
      replyAfter(unit, at, SAY.noAmmo(unit, have, need));
      return { ok: false, error: T('sim.err.noammo', '{unit}: insufficient ammunition — {have} rounds remaining, {need} required.', { unit: NAME(unit), have, need }),
               status: st, radio: true };
    }

    const m = {
      id: 'AB' + (nextNum++),
      unit, control, type,
      system,
      dispersionM: dispersionOf(unit),
      shell: spec.shell || MUNITIONS[0].value,
      guns: shape.guns,
      volleys: shape.volleys,
      intervalSec: shape.intervalSec,
      rounds: shape.guns * shape.volleys,
      /* Who this mission stopped — the engine's truth, never shown as BDA. */
      stopped: [],
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
      replySec: drawReply(),
      totSec: null,
      sentAt: now,
      state: 'sending'
    };
    m.replyAt = now + m.replySec;

    if (control === 'Time on target') {
      const tot = Number(spec.totSec);
      if (!isFinite(tot)) { nextNum--; return { ok: false, error: T('sim.err.totneeded', 'Time on target needs a time.') }; }
      m.totSec = tot;
      /* A TOT that cannot be met is refused — and the earliest that CAN be met
         now includes the acknowledgement, because the guns are not laid until
         the unit has answered. Refusing it is the teaching point, not an
         inconvenience: it is why the observer has to know roughly how long the
         rounds take before naming a time. */
      if (tot < m.replyAt + m.tofSec) {
        nextNum--;
        replyAfter(unit, m.replyAt, SAY.lateTot(m, m.replyAt));
        return { ok: false, error: T('sim.err.earliest', 'Unable: earliest TOT is {t}.', { t: SIM_CLOCK.format(m.replyAt + m.tofSec) }),
                 mission: m };
      }
      accept(m);
      replyAfter(unit, m.replyAt, SAY.mtoTot(m), () => fireAt(m, tot - m.tofSec));
      return { ok: true, mission: m };
    }

    if (control === 'At my command') {
      accept(m);
      replyAfter(unit, m.replyAt, SAY.mtoHold(m), () => { m.state = 'awaiting'; changed(); });
      return { ok: true, mission: m };
    }

    accept(m);
    replyAfter(unit, m.replyAt, SAY.mto(m), () => fireAt(m, m.replyAt));
    return { ok: true, mission: m };
  }

  /* The battery goes off the air from the moment the mission is SENT, not from
     when it fires — shoot and move starts when the call is taken. */
  function accept(m) {
    missions.push(m);
    if (m.kind !== 'drone') busyUntil.set(m.unit, m.sentAt + RECOVERY_SEC);
    changed();
  }

  /* ---------- Predator ----------
     spec.drones (1-20), spec.targetType (the class the drones hunt), and either
     a grid (e, n) or spec.area { name, points: [{e,n}] } — a TAI or EA Lee
     draws. Always launched on acknowledgement: no at-my-command, no TOT. */
  function sendDrones(spec, unit, now, st) {
    if (typeof SIM_DRONES === 'undefined') return { ok: false, error: T('sim.err.nodronemod', 'Drones are not loaded.') };
    const C = SIM_DRONES.CONFIG;
    const n = Math.max(1, Math.min(C.maxPerMission, Math.floor(Number(spec.drones) || 1)));
    const left = dronesLeft(unit);
    if (left !== null && n > left) {
      replyAfter(unit, now + drawReply(), SAY.noDrones(unit, left, n));
      return { ok: false, error: T('sim.err.nodrones', '{unit}: insufficient drones — {left} remaining, {n} requested.', { unit: NAME(unit), left, n }),
               status: st, radio: true };
    }
    const area = spec.area && spec.area.points && spec.area.points.length >= 3 ? spec.area : null;
    const aimE = area ? area.points.reduce((a, p) => a + p.e, 0) / area.points.length : spec.e;
    const aimN = area ? area.points.reduce((a, p) => a + p.n, 0) / area.points.length : spec.n;
    const aim = area ? { area: area.name, points: area.points, e: aimE, n: aimN }
                     : { e: aimE, n: aimN,
                         water: (typeof SIM_DAMAGE !== 'undefined' && SIM_DAMAGE.inWater) ? SIM_DAMAGE.inWater(aimE, aimN) : false };
    const m = {
      id: 'AB' + (nextNum++),
      unit, kind: 'drone', control: 'When ready', type: 'Drones',
      system: (UNIT[unit] && UNIT[unit].system) || '',
      dispersionM: null,
      shell: 'One Way Attack UAS',
      drones: n, guns: 1, volleys: n, intervalSec: C.launchEverySec, rounds: n,
      stopped: [],
      count: spec.count || '', targetType: spec.targetType || '', environment: spec.environment || '',
      e: aimE, n: aimN, elev: spec.elev || 0,
      grid: spec.grid || (area ? area.name : ''), area: area ? area.name : null,
      tofSec: C.tofSec, replySec: drawReply(), totSec: null, sentAt: now, state: 'sending'
    };
    m.replyAt = now + m.replySec;
    accept(m);
    replyAfter(unit, m.replyAt, SAY.mtoDrone(m), () => {
      const first = Math.max(m.replyAt, launcherFreeAt);
      for (let i = 0; i < n; i++) {
        SIM_DRONES.launch({ id: `${m.id}-${i + 1}`, mission: m.id, index: i,
                            launchAt: first + i * C.launchEverySec, aim, cls: m.targetType });
      }
      launcherFreeAt = first + n * C.launchEverySec;
      m.fireAt = first;
      m.splashAt = first + C.tofSec;
      m.lastVolleyAt = first + (n - 1) * C.launchEverySec + C.tofSec + C.loiterSec;
      m.state = 'queued';
      m.volleysLanded = 0;
      clock.at(first, () => { if (m.state === 'queued') m.state = 'inFlight'; say(unit, SAY.droneAway(m)); changed(); });
      changed();
    });
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
      dispersionM: m.dispersionM, stopped: (m.stopped || []).slice(),
      kind: m.kind || 'fires', drones: m.drones || null, area: m.area || null,
      count: m.count, targetType: m.targetType, environment: m.environment,
      grid: m.grid, state: m.state, tofSec: m.tofSec, totSec: m.totSec,
      sentAt: m.sentAt, replySec: m.replySec, replyAt: m.replyAt,
      fireAt: m.fireAt, splashAt: m.splashAt,
      lastVolleyAt: m.lastVolleyAt, splashedAt: m.splashedAt, completedAt: m.completedAt
    };
  }

  function list() { return missions.map(view); }
  function get(id) { const m = missions.find(x => x.id === id); return m ? view(m) : null; }
  function active() { return missions.filter(m => m.state !== 'complete').length; }

  return { init, reset, send, fireNow, list, get, active,
           SAY, OBSERVER, MUNITIONS, spokenShell, UNITS, UNIT,
           MISSION_TYPES, DEFAULT_TYPE, SPLASH_WARN_SEC, REPLY_BAND, RECOVERY_SEC,
           status, unitStatus, dispersionOf, salvosLeft, roundsLeft, dronesLeft, isDroneUnit,
           typing: () => [...typing.keys()] };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_MISSIONS;
