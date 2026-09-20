/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   Fire Mission Sim — the clock.

   THE ONE RULE: sim time is the single authority for everything that changes.
   Nothing else in the sim reads performance.now() or Date.now() for behaviour.
   Bursts, contacts, time of flight, gun recovery, wave spawns — all of them are
   functions of the time this file keeps.

   The reason is the pause button. Anything keyed to wall clock keeps running
   while the sim is stopped and lands at the wrong moment at 3x. js/sim-render.js
   shipped keyed to performance.now(); re-keying it to this file is the smallest
   possible proof that the clock has authority.

   ---------------------------------------------------------
   FIXED STEP, SO THE RUN IS DETERMINISTIC.

   The sim advances in whole 100 ms logical steps. A speed multiplier changes
   HOW MANY STEPS RUN PER FRAME, never the step size. So 1x and 3x produce
   identical outcomes, and "did the mission beat the bulldozer to the lane" does
   not depend on frame rate or on whether the student watched at speed.

   Variable-dt would look fine with one moving symbol and quietly break the first
   time something is graded against time. The 2026-09-19 calibration lesson,
   restated: the thing being graded must not depend on the renderer.
   ---------------------------------------------------------

   TWO CLOCKS, AND THE NAMES CARRY THE RULE.

     time()      step-aligned seconds. AUTHORITATIVE. Anything graded, scored,
                 scheduled or recorded uses this and only this.
     renderMs()  step-aligned time plus the un-stepped remainder, in ms. For
                 DRAWING only, so a 10 Hz logical step does not make a burst
                 flash at 10 fps. Never make a decision from it.

   Public API is in SECONDS. renderMs() is the single exception and is named
   loudly for it.

   ---------------------------------------------------------
   THE TEST SEAM.

   advance(wallMs) is the whole engine and takes wall time as an argument, so
   the suite drives it directly with no browser, no rAF and no fake timers.
   The rAF pump below is a thin driver over it and nothing else.
   ---------------------------------------------------------

   API:
     SIM_CLOCK.play() / pause() / stop() / toggle()
     SIM_CLOCK.setRate(n) / rate()          1, 2 or 3
     SIM_CLOCK.isRunning()
     SIM_CLOCK.time()                       sim seconds, step-aligned
     SIM_CLOCK.renderMs()                   sim ms, interpolated — drawing only
     SIM_CLOCK.setDuration(sec) / duration()
     SIM_CLOCK.progress()                   0..1 across the scenario, 0 if none
     SIM_CLOCK.at(sec, fn) -> id            fire once at an absolute sim time
     SIM_CLOCK.after(sec, fn) -> id         fire once, that far from now
     SIM_CLOCK.cancel(id)
     SIM_CLOCK.onTick(fn)   fn(t, dt)       every logical step
     SIM_CLOCK.onFrame(fn)  fn(t)           every animation frame while running
     SIM_CLOCK.onChange(fn) fn(state)       transport or rate changed
     SIM_CLOCK.advance(wallMs) -> steps     the engine; tests call this
     SIM_CLOCK.format(sec)                  "T+04:20"
   ========================================================= */

const SIM_CLOCK = (() => {

  /* 100 ms is far finer than anything the sim grades — a vehicle at 40 km/h
     moves 1.1 m in a step — and coarse enough that a slow frame never runs more
     than a handful. */
  const STEP_MS = 100;

  /* A backgrounded tab hands back a delta of seconds or minutes. Real time is
     supposed to mean real time in a trainer, so a hidden tab must not
     fast-forward the enemy: the frame delta is clamped and the missing time is
     simply not simulated. Deliberate — the alternative is an advance that
     teleports. */
  const MAX_FRAME_MS = 250;

  const RATES = [1, 2, 3];

  let tMs = 0;          /* sim ms at the last completed step — authoritative */
  let restMs = 0;       /* sim ms taken in but not yet made into a step */
  let rateN = 1;
  let running = false;
  let durSec = 0;       /* scenario length; 0 means unbounded */

  let queue = [];       /* {id, at, fn, live} — at is sim ms */
  let nextId = 1;

  const tickSubs = [], frameSubs = [], changeSubs = [];

  let raf = 0, lastWall = 0;

  /* ---------- subscriptions ---------- */

  function sub(list, fn) {
    if (typeof fn !== 'function') return () => {};
    list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }

  /* A throwing subscriber must not stop the clock: the sim freezing is a worse
     failure than one broken panel, and a frozen clock hides which one broke. */
  function emit(list, a, b) {
    for (const fn of list.slice()) {
      try { fn(a, b); } catch (err) { console.error('[sim-clock] subscriber threw', err); }
    }
  }

  function state() {
    return { running, rate: rateN, t: tMs / 1000, reason: '' };
  }

  function changed(reason) {
    const s = state(); s.reason = reason;
    emit(changeSubs, s);
  }

  /* ---------- the event queue ----------
     Ordered by scheduled time, ties broken by insertion id. Both halves of that
     matter: without the tie-break, two events at the same instant could run in
     either order and the run stops being reproducible.

     Re-scanned each pass because an event is allowed to schedule another one at
     a time that has already arrived. n is small — tens, not thousands. */
  function runDue() {
    for (;;) {
      let best = null;
      for (const e of queue) {
        if (!e.live || e.at > tMs) continue;
        if (!best || e.at < best.at || (e.at === best.at && e.id < best.id)) best = e;
      }
      if (!best) break;
      best.live = false;
      try { best.fn(tMs / 1000); } catch (err) { console.error('[sim-clock] event threw', err); }
    }
    if (queue.some(e => !e.live)) queue = queue.filter(e => e.live);
  }

  /* ---------- one logical step ----------
     Order inside a step: time moves, then events due at the new time fire, then
     tick subscribers run. So a subscriber always sees a world in which
     everything scheduled for this instant has already happened. */
  function step() {
    tMs += STEP_MS;
    runDue();
    emit(tickSubs, tMs / 1000, STEP_MS / 1000);
    if (durSec > 0 && tMs >= durSec * 1000) pause('end');
  }

  /* ---------- the engine ----------
     Takes ONE FRAME's wall milliseconds and returns how many logical steps it
     ran. This is the whole of the clock; everything else is transport and
     bookkeeping.

     One frame, not an arbitrary span: anything over MAX_FRAME_MS is clamped
     here rather than in the driver, so that no caller anywhere — a driver, a
     test, a future scrub — can hand the sim a jump and have the enemy
     teleport. To cover a long span, pump it in frame-sized pieces, which is
     what the rAF driver does and what the suite does. */
  function advance(wallMs) {
    if (!running) return 0;
    const w = Math.max(0, Math.min(MAX_FRAME_MS, Number(wallMs) || 0));
    restMs += w * rateN;
    let n = 0;
    while (running && restMs >= STEP_MS) { restMs -= STEP_MS; step(); n++; }
    return n;
  }

  /* ---------- the rAF driver ----------
     A thin pump over advance(). Runs only while playing; a paused sim costs
     nothing and repaints through onChange instead. */
  function loop(now) {
    raf = 0;
    const dt = lastWall ? now - lastWall : 0;
    lastWall = now;
    advance(dt);
    emit(frameSubs, tMs / 1000);
    if (running) raf = requestAnimationFrame(loop);
  }

  function startPump() {
    if (typeof requestAnimationFrame !== 'function') return;  /* headless */
    lastWall = 0;
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function stopPump() {
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = 0; lastWall = 0;
  }

  /* ---------- transport ---------- */

  function play() {
    if (running) return false;
    running = true;
    restMs = 0;
    startPump();
    changed('play');
    return true;
  }

  /* The leftover sub-step is dropped on pause, so resuming never inherits a
     partial step from whenever the student happened to hit the button. */
  function pause(reason) {
    if (!running) return false;
    running = false;
    restMs = 0;
    stopPump();
    changed(reason || 'pause');
    return true;
  }

  function toggle() { return running ? pause() : play(); }

  /* Stop is a scenario reset, not a longer pause: time goes back to zero and
     the queue is emptied. Whoever owns the scenario re-seeds its events from
     the onChange notification — the clock does not remember content. */
  function stop() {
    running = false;
    stopPump();
    tMs = 0; restMs = 0;
    queue = []; nextId = 1;
    changed('stop');
    return true;
  }

  function setRate(n) {
    const r = RATES.includes(Number(n)) ? Number(n) : 1;
    if (r === rateN) return rateN;
    rateN = r;
    changed('rate');
    return rateN;
  }

  /* ---------- scheduling ----------
     Everything timed goes here. Nothing in the sim uses setTimeout: time of
     flight, "at my command" holds, gun recovery and wave spawns are then one
     mechanism that pauses and scales correctly, instead of four that do not. */
  function at(sec, fn) {
    if (typeof fn !== 'function') return 0;
    const id = nextId++;
    queue.push({ id, at: Math.round(Number(sec) * 1000), fn, live: true });
    return id;
  }

  function after(sec, fn) { return at(tMs / 1000 + Number(sec), fn); }

  function cancel(id) {
    const e = queue.find(q => q.id === id);
    if (!e || !e.live) return false;
    e.live = false;
    queue = queue.filter(q => q.live);
    return true;
  }

  function pending() { return queue.filter(e => e.live).length; }

  /* ---------- readouts ---------- */

  function setDuration(sec) { durSec = Math.max(0, Number(sec) || 0); return durSec; }

  function progress() {
    if (durSec <= 0) return 0;
    return Math.max(0, Math.min(1, (tMs / 1000) / durSec));
  }

  /* T+MM:SS, rolling over to T+H:MM:SS past the hour rather than showing a
     75th minute. */
  function format(sec) {
    const t = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const pad = v => String(v).padStart(2, '0');
    return h ? `T+${h}:${pad(m)}:${pad(s)}` : `T+${pad(m)}:${pad(s)}`;
  }

  return {
    play, pause, stop, toggle, setRate, advance,
    at, after, cancel, pending,
    setDuration, progress, format,
    onTick:   fn => sub(tickSubs, fn),
    onFrame:  fn => sub(frameSubs, fn),
    onChange: fn => sub(changeSubs, fn),
    isRunning: () => running,
    rate: () => rateN,
    duration: () => durSec,
    time: () => tMs / 1000,
    renderMs: () => tMs + restMs,
    stepSeconds: () => STEP_MS / 1000,
    maxFrameMs: () => MAX_FRAME_MS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_CLOCK;
