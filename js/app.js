/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* D3A Targeting Course — shared app logic
   Progress is stored in the browser (localStorage) per student machine.
   Where localStorage is unreachable it degrades to memory for the session;
   see the storage shim below. */

const D3A = (() => {
  const KEY = 'd3a-course-progress-v1';

  /* ---------- Storage that cannot throw ----------
     localStorage is not always reachable. Opening the course from a
     content:// URI (an Android file manager handing the page to Chrome) puts
     it on an opaque origin, where merely touching window.localStorage raises
     SecurityError. Safari private mode throws on setItem. A locked-down
     machine may have site data blocked outright.

     None of those should take the page down. The shim probes once, and if the
     real store is unusable it keeps answers in memory for the session: the
     student can still work through every exercise, progress just does not
     survive a reload. D3A.storageAvailable reports which mode is in use. */
  const store = (() => {
    const memory = Object.create(null);
    let backing = null;

    try {
      const probe = '__d3a_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      backing = window.localStorage;
    } catch (e) {
      backing = null;
    }

    /* One failure after the probe (quota, or permission revoked mid-session)
       drops us to memory for good rather than half-reading a store that is
       no longer writable. */
    function degrade() { backing = null; }

    return {
      get available() { return backing !== null; },
      getItem(k) {
        if (backing) {
          try { return backing.getItem(k); } catch (e) { degrade(); }
        }
        return k in memory ? memory[k] : null;
      },
      setItem(k, v) {
        if (backing) {
          try { backing.setItem(k, v); return; } catch (e) { degrade(); }
        }
        memory[k] = String(v);
      },
      removeItem(k) {
        if (backing) {
          try { backing.removeItem(k); } catch (e) { degrade(); }
        }
        delete memory[k];
      }
    };
  })();

  /* Strings built here in JavaScript have no English copy sitting in the
     HTML to fall back to, so they go through I18N.t(key, english).
     If i18n.js is not loaded the English is used unchanged. */
  function t(key, english, vars) {
    if (window.I18N) return window.I18N.t(key, english, vars);
    let s = english;
    if (vars) Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(vars[k]); });
    return s;
  }

  function load() {
    try { return JSON.parse(store.getItem(KEY)) || {}; }
    catch (e) { return {}; }
  }
  function save(state) { store.setItem(KEY, JSON.stringify(state)); }

  /* Mark one exercise complete, e.g. D3A.complete('decide-1') */
  function complete(id) {
    const s = load();
    s[id] = true;
    save(s);
    refreshUI();
  }
  function isComplete(id) { return !!load()[id]; }

  /* Each page declares its exercise ids:  D3A.registerPage('decide', ['decide-1', ...]) */
  let pageName = null, pageExercises = [];
  function registerPage(name, exercises) {
    pageName = name;
    pageExercises = exercises || [];
    document.addEventListener('DOMContentLoaded', refreshUI);
    /* status pills and progress labels are written by this module, so they
       have to be redrawn when the student switches language */
    document.addEventListener('d3a:langchange', refreshUI);
  }

  /* Which exercises belong to each phase (for nav checkmarks).
     Decide runs across three sub-pages; the phase tab lights only when
     all three are finished. */
  const PHASES = {
    scenario: ['scenario-1'],
    decide:  ['decide-1', 'decide-2', 'decide-3',
              'decide-4', 'decide-5', 'decide-6', 'decide-13',
              'decide-8', 'decide-9', 'decide-10',
              'decide-11', 'decide-12'],
    /* Detect came back on 2026-08-24 with Task 2.1, the collection plan.
       Deliver and Assess are still "Coming soon" placeholders while their
       content is written. An empty list keeps a tab dark (phaseDone requires
       length > 0) and keeps the course progress bar counting only what a
       student can actually do. Move the ids back out of PARKED as each
       exercise is built. */
    detect:  ['detect-1', 'detect-3'],
    deliver: ['deliver-1'],
    assess:  []
  };

  /* The exercise ids still to come. detect-2 is the acquisition drill, which
     is not written yet. Task 2.2 on the F2T2EA page is detect-3, not detect-2,
     because detect-2 was already reserved. Displayed task numbers and internal
     ids do not line up anywhere in this course; do not try to make them. */
  const PARKED = {
    detect:  ['detect-2'],
    deliver: ['deliver-2'],
    assess:  ['assess-1', 'assess-2', 'assess-3']
  };

  /* Decide's second-level nav. Keyed by filename so a sub-tab can show its
     own checkmark independently of the phase tab above it. */
  const SUBPAGES = {
    'decide.html':     ['decide-1', 'decide-2', 'decide-3'],
    'decide-tss.html': ['decide-4', 'decide-5', 'decide-6', 'decide-13'],
    'decide-agm.html': ['decide-8', 'decide-9', 'decide-10'],
    'decide-sync.html': ['decide-11', 'decide-12'],
    /* Detect's second-level nav, added 2026-08-27. 2B (F2T2EA) carries
       Task 2.2, whose id is detect-3. */
    'detect.html':          ['detect-1'],
    'detect-f2t2ea.html':   ['detect-3']
  };

  function phaseDone(phase) {
    const ex = PHASES[phase] || [];
    return ex.length > 0 && ex.every(isComplete);
  }

  function subPageDone(file) {
    const ex = SUBPAGES[file] || [];
    return ex.length > 0 && ex.every(isComplete);
  }

  function refreshUI() {
    // nav checkmarks
    document.querySelectorAll('nav.phases a[data-phase]').forEach(a => {
      if (phaseDone(a.dataset.phase)) a.classList.add('done');
      else a.classList.remove('done');
    });
    // second-level nav checkmarks (the three Decide products)
    document.querySelectorAll('nav.subphases a[data-sub]').forEach(a => {
      if (subPageDone(a.dataset.sub)) a.classList.add('done');
      else a.classList.remove('done');
    });
    // exercise status pills on this page
    pageExercises.forEach(id => {
      const pill = document.querySelector(`[data-status="${id}"]`);
      if (pill) {
        if (isComplete(id)) { pill.textContent = t('ui.complete', 'COMPLETE'); pill.classList.add('done'); }
        else { pill.textContent = t('ui.notdone', 'NOT DONE'); pill.classList.remove('done'); }
      }
    });
    // page progress bar
    const fill = document.getElementById('page-progress-fill');
    const label = document.getElementById('page-progress-label');
    if (fill && pageExercises.length) {
      const done = pageExercises.filter(isComplete).length;
      const pct = Math.round(100 * done / pageExercises.length);
      fill.style.width = pct + '%';
      if (label) label.textContent = t('ui.pageprogress', 'Tasks complete: {done} of {total}',
                                       { done: done, total: pageExercises.length });
    }
    // overall progress bar (home page)
    const allFill = document.getElementById('course-progress-fill');
    const allLabel = document.getElementById('course-progress-label');
    if (allFill) {
      const all = Object.values(PHASES).flat();
      const done = all.filter(isComplete).length;
      const pct = Math.round(100 * done / all.length);
      allFill.style.width = pct + '%';
      if (allLabel) allLabel.textContent = t('ui.courseprogress', 'Course progress: {done} of {total} tasks ({pct}%)',
                                             { done: done, total: all.length, pct: pct });
    }
    /* Locked panels. An element with data-reveal-when="id id id" stays hidden
       until every listed exercise is complete. Used for the finished AGM at the
       foot of decide-agm.html: printing the answer table above an unfinished
       exercise would hand the student the answers. Hidden by CSS, not by JS, so
       it never flashes into view while the page is loading. */
    document.querySelectorAll('[data-reveal-when]').forEach(el => {
      const ids = el.dataset.revealWhen.split(/\s+/).filter(Boolean);
      const ready = ids.length && ids.every(isComplete);
      el.classList.toggle('revealed', ready);
      el.setAttribute('aria-hidden', ready ? 'false' : 'true');
    });

    // completion banner
    const banner = document.getElementById('phase-complete-banner');
    if (banner && pageName && phaseDone(pageName)) banner.classList.add('show');
  }

  function resetAll() {
    if (confirm(t('ui.resetconfirm', 'Reset all course progress? This cannot be undone.'))) {
      store.removeItem(KEY);
      location.reload();
    }
  }

  /* ---------- Flagged-cell explanations ----------
     A small "?" button beside a value in a table opens a short note.
     Used where the worksheet says something a thoughtful student will
     rightly question — the OWA-UAS target location error, and the
     "BDA Required" row, which is really asking whether BDA must be
     immediate.

     The note text lives in a hidden block in the HTML, never in a
     JavaScript string, so tools/tag-i18n.js tags it like any other
     content and the translator sees it. */
  function initModals() {
    let lastTrigger = null;

    function open(id, trigger) {
      const box = document.getElementById(id);
      if (!box) return;
      lastTrigger = trigger || null;
      box.classList.add('show');
      /* A tall reference product scrolls inside its own box, and focusing the
         close button at the foot of it would scroll the reader straight past
         the thing they opened. */
      const panel = box.querySelector('.modal-box');
      if (panel) panel.scrollTop = 0;
      const close = box.querySelector('.modal-close');
      if (close) close.focus({ preventScroll: true });
    }
    function closeAll() {
      document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show'));
      if (lastTrigger) { lastTrigger.focus(); lastTrigger = null; }
    }

    document.addEventListener('click', e => {
      const trigger = e.target.closest('[data-modal]');
      if (trigger) { e.preventDefault(); open(trigger.dataset.modal, trigger); return; }
      /* the backdrop is the .modal itself; the panel inside stops the click */
      if (e.target.classList && e.target.classList.contains('modal')) closeAll();
      if (e.target.closest('.modal-close')) closeAll();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeAll();
    });
  }


  /* ---------- Phase 3: the synchronization matrix as a clock ----------

     Each event on the timeline declares its hour column in data-hour,
     counting the twelve hours from 1 (T-4) to 12 (T+7). Whichever event is
     nearest the middle of the screen lights that hour on the rail and
     rewrites the line under it with what every asset is doing in that hour.

     That line is read out of the matrix in the modal, cell by cell, so the
     matrix exists exactly once on the page. Reading it means walking each
     row and accumulating colspans, because a block covering T-4 to T-1 is
     one cell, not four. */
  function initTimeline(opts) {
    const wrap = document.getElementById(opts.clockId);
    const list = document.getElementById(opts.timelineId);
    if (!wrap || !list) return;
    const events = [...list.querySelectorAll('.ev')];
    if (!events.length) return;

    let current = null;
    function setCurrent(el) {
      if (el === current) return;
      current = el;
      events.forEach(e => e.classList.toggle('current', e === el));
      const n = parseInt(el.dataset.hour, 10);
      wrap.querySelectorAll('.hour-rail li').forEach(s => s.classList.toggle('hour-on', parseInt(s.dataset.hour, 10) === n));
    }

    list.addEventListener('click', e => {
      const li = e.target.closest('.ev');
      if (li) setCurrent(li);
    });

    /* Follow the reader: whichever event sits nearest the middle of the
       viewport is the one the clock reports. */
    window.addEventListener('scroll', () => {
      const mid = window.innerHeight * 0.55;
      let best = null, bestD = Infinity;
      for (const e of events) {
        const r = e.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) setCurrent(best);
    }, { passive: true });

    /* The site header is sticky too, so the rail has to sit under whatever
       height it happens to be at this viewport width. */
    const header = document.querySelector('header.site');
    function place() { if (header) wrap.style.top = header.offsetHeight + 'px'; }
    window.addEventListener('resize', place);
    place();

    document.addEventListener('d3a:langchange', () => {
      if (current) { const el = current; current = null; setCurrent(el); }
    });

    setCurrent(events[0]);
  }

  /* ---------- Reusable exercise helpers ---------- */

  /* Multi-select checkbox exercise.
     cfg = { containerId, checkBtnId, feedbackId, exerciseId, correct: [values], explainOk, explainBad } */
  function initMultiSelect(cfg) {
    const btn = document.getElementById(cfg.checkBtnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const container = document.getElementById(cfg.containerId);
      const boxes = container.querySelectorAll('input[type=checkbox]');
      let allRight = true;
      boxes.forEach(b => {
        const lab = b.closest('.choice');
        lab.classList.remove('correct', 'incorrect', 'missed');
        lab.classList.add('reveal');
        const shouldCheck = cfg.correct.includes(b.value);
        if (b.checked && shouldCheck) lab.classList.add('correct');
        else if (b.checked && !shouldCheck) { lab.classList.add('incorrect'); allRight = false; }
        else if (!b.checked && shouldCheck) { lab.classList.add('missed'); allRight = false; }
      });
      showFeedback(cfg.feedbackId, allRight, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
      if (allRight) complete(cfg.exerciseId);
    });
  }

  /* Single-answer radio quiz.
     cfg = { containerId, checkBtnId, feedbackId, exerciseId, correct: value, explainOk, explainBad } */
  function initSingleSelect(cfg) {
    const btn = document.getElementById(cfg.checkBtnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const container = document.getElementById(cfg.containerId);
      const chosen = container.querySelector('input[type=radio]:checked');
      if (!chosen) { showFeedback(cfg.feedbackId, false, '', t('ui.selectfirst', 'Select an answer first.')); return; }
      container.querySelectorAll('.choice').forEach(c => c.classList.remove('correct', 'incorrect'));
      const lab = chosen.closest('.choice');
      const right = chosen.value === cfg.correct;
      lab.classList.add(right ? 'correct' : 'incorrect');
      lab.classList.add('reveal');
      showFeedback(cfg.feedbackId, right, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
      if (right) complete(cfg.exerciseId);
    });
  }

  /* Reorderable priority list with up/down buttons.
     cfg = { listId, checkBtnId, feedbackId, exerciseId, correctOrder: [values], explainOk, explainBad } */
  function initSortList(cfg) {
    const list = document.getElementById(cfg.listId);
    if (!list) return;
    function renumber() {
      [...list.children].forEach((li, i) => {
        li.querySelector('.rank').textContent = i + 1;
        li.classList.remove('correct', 'incorrect');
      });
    }
    list.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const li = btn.closest('li');
      if (btn.classList.contains('up') && li.previousElementSibling)
        list.insertBefore(li, li.previousElementSibling);
      if (btn.classList.contains('down') && li.nextElementSibling)
        list.insertBefore(li.nextElementSibling, li);
      renumber();
    });
    document.getElementById(cfg.checkBtnId).addEventListener('click', () => {
      const order = [...list.children].map(li => li.dataset.value);
      let allRight = true;
      [...list.children].forEach((li, i) => {
        li.classList.remove('correct', 'incorrect');
        if (li.dataset.value === cfg.correctOrder[i]) li.classList.add('correct');
        else { li.classList.add('incorrect'); allRight = false; }
      });
      showFeedback(cfg.feedbackId, allRight, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
      if (allRight) complete(cfg.exerciseId);
    });
  }

  /* Dropdown matching. Each select has data-answer with the correct value.
     cfg = { containerId, checkBtnId, feedbackId, exerciseId, explainOk, explainBad }

     Two ways to check. A single button named by checkBtnId marks the whole
     exercise. Alternatively any .match-row may carry its own button.row-check,
     which marks that row only, for immediate feedback while the student works
     down the page. Both may be present; either one completes the exercise once
     every select in the container is correct. */
  function initSelectMatch(cfg) {
    const container = document.getElementById(cfg.containerId);
    if (!container) return;
    const allSelects = () => [...container.querySelectorAll('select[data-answer]')];

    /* Mark one row and reveal its notes. Returns false if the row is blank. */
    function markRow(row) {
      const sels = [...row.querySelectorAll('select[data-answer]')];
      if (!sels.length) return true;
      row.querySelectorAll('.row-note').forEach(n => n.classList.remove('show'));
      /* The tertiary means is not chosen, it is what is left over, so it is
         revealed once the row's own picks are right rather than selected. */
      row.querySelectorAll('.pick.is-tertiary').forEach(n => n.classList.remove('show'));
      if (sels.some(sel => !sel.value)) {
        sels.forEach(sel => sel.classList.remove('correct', 'incorrect'));
        return false;
      }
      let ok = true; const wrong = [];
      sels.forEach(sel => {
        const right = sel.value === sel.dataset.answer;
        sel.classList.remove('correct', 'incorrect');
        sel.classList.add(right ? 'correct' : 'incorrect');
        if (!right) { ok = false; wrong.push(sel.value); }
      });
      /* Per-row notes. Every text lives in the HTML so the tagger sees it;
         app.js only adds .show, it never writes into the element.
         .always is neutral (the commander's justification) and is shown right
         or wrong. .ok / .bad are the older verdict pair and still work. */
      const notes = [...row.querySelectorAll('.row-note')];
      notes.filter(n => n.classList.contains('always')).forEach(n => n.classList.add('show'));
      if (ok) {
        row.querySelectorAll('.pick.is-tertiary').forEach(n => n.classList.add('show'));
        const noteOk = notes.find(n => n.classList.contains('ok'));
        if (noteOk) noteOk.classList.add('show');
      } else {
        /* A row may carry one note per wrong option (data-for="P").
           Anything without data-for is the catch-all for that row. */
        const bad = notes.filter(n => n.classList.contains('bad'));
        const noteBad = wrong.map(v => bad.find(n => n.dataset.for === v)).find(Boolean)
                     || bad.find(n => !n.dataset.for);
        if (noteBad) noteBad.classList.add('show');
      }
      return true;
    }

    /* The exercise is finished when every select in it is right, however the
       student got there — one row at a time or all at once. */
    function settle() {
      const sels = allSelects();
      const done = sels.length && sels.every(s => s.value && s.value === s.dataset.answer);
      if (done) {
        showFeedback(cfg.feedbackId, true, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
        complete(cfg.exerciseId);
      }
      return done;
    }

    const rowOf = sel => sel.closest('.match-row') || sel.closest('tr');
    const allRows = () => [...new Set(allSelects().map(rowOf).filter(Boolean))];

    const btn = document.getElementById(cfg.checkBtnId);
    if (btn) btn.addEventListener('click', () => {
      const blank = allSelects().filter(s => !s.value).length;
      allRows().forEach(markRow);
      if (blank > 0) {
        showFeedback(cfg.feedbackId, false, '', t('ui.rowsblank', 'Answer every row — {n} still blank.', { n: blank }));
        return;
      }
      if (!settle()) showFeedback(cfg.feedbackId, false, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
    });

    container.querySelectorAll('button.row-check').forEach(rb => {
      rb.addEventListener('click', () => {
        const row = rb.closest('.match-row') || rb.closest('tr');
        if (!row) return;
        if (!markRow(row)) {
          showFeedback(cfg.feedbackId, false, '', t('ui.rowblank', 'Answer both choices in that row first.'));
          return;
        }
        settle();
      });
    });
  }



  /* The target workbench. The four high-payoff targets across the six F2T2EA
     steps, pinned under the hour rail so a student can see where every target
     stands while reading an event. It is the workbook's stand-in for a target
     workbench or target factory.

     Each row is ONE RADIO GROUP. That is deliberate: a target sits in exactly
     one column, which is what a radio group means, and it buys keyboard
     support, :checked styling with no JS, and a control jsdom can drive. The
     alternative, dragging, does not fire on touch and cannot be tested here.

     The leftmost column is HPTL: on the list, not yet detected. Every target
     starts there, so "on the list but nobody has found it" is a visible state
     rather than an empty row.

     Positions persist under cfg.stateKey as { engineers: 'fix', ... }. Moving
     a target fires d3a:wbmove on the document with { target, from, to }, which
     is the hook a question engine listens for. */
  function initWorkbench(cfg) {
    const board = document.getElementById(cfg.boardId);
    if (!board) return null;
    const KEY = cfg.stateKey || 'workbench';
    const rows = () => [...board.querySelectorAll('.wb-row')];

    function positions() {
      const out = {};
      rows().forEach(r => {
        const on = r.querySelector('input[type="radio"]:checked');
        out[r.dataset.target] = on ? on.value : 'hptl';
      });
      return out;
    }
    function persist() { const s = load(); s[KEY] = positions(); save(s); }

    function restore() {
      const saved = load()[KEY];
      const want = (saved && typeof saved === 'object') ? saved : {};
      rows().forEach(r => {
        const at = want[r.dataset.target] || 'hptl';
        const input = r.querySelector('input[value="' + at + '"]');
        if (input) input.checked = true;
        r.dataset.at = at;
      });
    }

    board.addEventListener('change', e => {
      const input = e.target;
      if (!input || input.type !== 'radio') return;
      const row = input.closest('.wb-row');
      if (!row) return;
      const from = row.dataset.at || 'hptl';
      if (from === input.value) return;
      row.dataset.at = input.value;
      persist();
      document.dispatchEvent(new CustomEvent('d3a:wbmove', {
        detail: { target: row.dataset.target, from: from, to: input.value }
      }));
    });

    restore();

    return {
      positions: positions,
      get: name => positions()[name],
      set: function (name, step) {
        const row = rows().find(r => r.dataset.target === name);
        if (!row) return false;
        const input = row.querySelector('input[value="' + step + '"]');
        if (!input) return false;
        input.checked = true;
        row.dataset.at = step;
        persist();
        return true;
      },
      reset: function () { rows().forEach(r => this.set(r.dataset.target, 'hptl')); }
    };
  }

  /* A step ladder. One situation at a time: the next is not revealed until
     the current one is answered correctly. Built for Task 2.2, where a single
     tank is followed through F2T2EA and the shape of the path is the lesson,
     including the two places where it goes backwards.

     Progress is stored as a count under "<exerciseId>.step", so a student who
     closes the browser resumes rather than replaying nine correct answers.
     That key is not an exercise id, so it never counts towards phase
     completion or the course progress bar.

     Steps are hidden by CSS (.lad-step is display:none until .shown), never by
     JS, so nothing flashes into view while the page is loading. Same reason
     data-reveal-when is done that way.

     cfg = { containerId, feedbackId, exerciseId, counterId, explainOk, explainBad } */
  function initStepLadder(cfg) {
    const container = document.getElementById(cfg.containerId);
    if (!container) return;
    const steps = () => [...container.querySelectorAll('.lad-step')];
    const total = steps().length;
    if (!total) return;
    const KEY_AT = cfg.exerciseId + '.step';

    function solvedCount() {
      const n = load()[KEY_AT];
      return typeof n === 'number' ? Math.max(0, Math.min(n, total)) : 0;
    }
    function setSolved(n) { const s = load(); s[KEY_AT] = n; save(s); }

    /* Everything is re-queried on every use. i18n.js rewrites the innerHTML of
       tagged blocks when a language is applied, so anything cached at start-up
       is a detached orphan a moment later. */
    function draw() {
      const done = solvedCount();
      steps().forEach((li, i) => {
        li.classList.toggle('shown', i <= done);
        li.classList.toggle('solved', i < done);
        const sel = li.querySelector('select[data-answer]');
        if (!sel) return;
        if (i < done) {
          sel.value = sel.dataset.answer;
          sel.classList.remove('incorrect');
          sel.classList.add('correct');
          sel.disabled = true;
          li.querySelectorAll('.row-note.ok').forEach(n => n.classList.add('show'));
        } else {
          sel.disabled = false;
        }
      });
      const counter = cfg.counterId && document.getElementById(cfg.counterId);
      if (counter) {
        counter.textContent = done >= total
          ? t('ui.laddone', 'All {total} situations answered.', { total: total })
          : t('ui.ladstep', 'Situation {n} of {total}', { n: done + 1, total: total });
      }
    }

    /* A prompt sits beside the Check button, not in a banner at the foot of
       the page, which a student working at step nine would never see. The
       element is empty in the HTML so the tagger gives it no key. */
    function say(li, msg) {
      const m = li.querySelector('.tev-msg');
      if (m) m.textContent = msg || '';
    }

    function check(li) {
      say(li, '');
      const sel = li.querySelector('select[data-answer]');
      if (!sel) return;
      if (!sel.value) {
        showFeedback(cfg.feedbackId, false, '', t('ui.selectfirst', 'Select an answer first.'));
        return;
      }
      li.querySelectorAll('.row-note').forEach(n => n.classList.remove('show'));
      const right = sel.value === sel.dataset.answer;
      sel.classList.remove('correct', 'incorrect');
      sel.classList.add(right ? 'correct' : 'incorrect');

      if (!right) {
        /* Same note contract as initSelectMatch: .bad[data-for] targets one
           wrong option, a .bad without data-for is the catch-all. */
        const bad = [...li.querySelectorAll('.row-note.bad')];
        const note = bad.find(n => n.dataset.for === sel.value) || bad.find(n => !n.dataset.for);
        if (note) note.classList.add('show');
        if (cfg.explainBad) showFeedback(cfg.feedbackId, false, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
        return;
      }

      const idx = steps().indexOf(li);
      if (idx === solvedCount()) setSolved(idx + 1);
      draw();

      if (solvedCount() >= total) {
        showFeedback(cfg.feedbackId, true, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
        complete(cfg.exerciseId);
      } else {
        const fb = document.getElementById(cfg.feedbackId);
        if (fb) fb.classList.remove('show');
      }
    }

    container.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('button.row-check');
      if (!btn) return;
      const li = btn.closest('.lad-step');
      if (li) check(li);
    });

    document.addEventListener('DOMContentLoaded', draw);
    document.addEventListener('d3a:langchange', draw);
    draw();
  }


  /* Gated timeline events on deliver.html. Same contract as initStepLadder:
     one event at a time, the next is revealed only when the current one is
     right, and the position resumes from the store. The difference is what
     gets checked.

     An event answers in one of two ways:
       data-target + data-answer   the student moves that target's box on the
                                   pinned workbench, and the board is read
       a <select data-answer>      an ordinary choice, e.g. which asset fires

     The board is NOT reset between events. Positions accumulate, which is the
     whole point of a workbench, and a target may move backwards.

     cfg = { containerId, feedbackId, exerciseId, counterId, workbench,
             explainOk, explainBad } */
  function initTargetEvents(cfg) {
    const box = document.getElementById(cfg.containerId);
    if (!box) return;
    const steps = () => [...box.querySelectorAll('.tev')];
    const total = steps().length;
    if (!total) return;
    const KEY_AT = cfg.exerciseId + '.step';
    /* Which option the student chose, per step index. Needed because a step may
       accept more than one answer (data-answer="a|b"), so on a reload we cannot
       reconstruct the choice from the markup the way a single-answer step can. */
    const KEY_PICK = cfg.exerciseId + '.pick';
    const wb = cfg.workbench || null;

    function solvedCount() {
      const n = load()[KEY_AT];
      return typeof n === 'number' ? Math.max(0, Math.min(n, total)) : 0;
    }
    function setSolved(n) { const s = load(); s[KEY_AT] = n; save(s); }
    function picks() { return load()[KEY_PICK] || {}; }
    function setPick(i, v) { const s = load(); const p = s[KEY_PICK] || {}; p[i] = v; s[KEY_PICK] = p; save(s); }
    /* A .row-note.pick is shown for the option actually chosen, right or wrong.
       That is what lets one step carry a different justification per answer when
       more than one answer is genuinely defensible. */
    function showPick(li, given) {
      li.querySelectorAll('.row-note.pick').forEach(n => n.classList.toggle('show', n.dataset.for === given));
    }

    function draw() {
      const done = solvedCount();
      const chosen = picks();
      steps().forEach((li, i) => {
        li.classList.toggle('shown', i <= done);
        li.classList.toggle('solved', i < done);
        const sel = li.querySelector('select[data-answer]');
        if (sel) {
          if (i < done) {
            sel.value = chosen[i] || sel.dataset.answer.split('|')[0];
            sel.disabled = true; sel.classList.add('correct');
          } else sel.disabled = false;
        }
        if (i < done) showPick(li, chosen[i]);
        /* A report can put a target on the board that was not on the HPTL.
           The row is hidden in the markup and revealed with its step, so a
           student is not told in advance that another one is coming. */
        if (i <= done && li.dataset.revealRow) {
          const row = document.querySelector('.wb-row[data-target="' + li.dataset.revealRow + '"]');
          if (row) row.classList.remove('is-new');
        }
        /* The mirror of revealRow. A target whose cycle is finished comes off
           the board so the pinned bar does not grow without limit as new
           targets arrive. Its stored position is untouched; only the row is
           hidden, and only once the step has actually been pressed, which is
           why this reads i < done and revealRow reads i <= done. */
        if (li.dataset.removeRow) {
          li.dataset.removeRow.split(/\s+/).forEach(name => {
            const row = document.querySelector('.wb-row[data-target="' + name + '"]');
            if (row) row.classList.toggle('is-done', i < done);
          });
        }
        if (i < done) {
          li.querySelectorAll('.row-note.always, .row-note.ok').forEach(n => n.classList.add('show'));
          const v = li.querySelector('.tev-verdict');
          if (v) v.textContent = t('ui.correct', 'Correct.');
          li.classList.add('right');
        }
      });
      const counter = cfg.counterId && document.getElementById(cfg.counterId);
      if (counter) {
        counter.textContent = done >= total
          ? t('ui.laddone', 'All {total} situations answered.', { total: total })
          : t('ui.ladstep', 'Situation {n} of {total}', { n: done + 1, total: total });
      }
    }

    /* Lee's explanations are written to be shown whether the student got it
       right or wrong: "the explaination / hint when the student gets it right
       or wrong". That is what .row-note.always already means.

       The verdict line is a deliberately EMPTY element in the HTML. The tagger
       skips wordless elements, so it carries no key of its own and app.js
       writes the already-translated ui.correct or ui.tryagain into it. Same
       trick as the situation counter.

       A wrong answer MUST say so. Lee, 2026-08-27: "if they get it wrong, they
       just get a message. It's not obvious that they got it wrong. And they may
       just click the button for the assess button." Leaving the line blank read
       as silence, and silence next to an explanation that shows either way is
       indistinguishable from success. */
    function reveal(li, right) {
      li.querySelectorAll('.row-note.always').forEach(n => n.classList.add('show'));
      const v = li.querySelector('.tev-verdict');
      if (v) v.textContent = right ? t('ui.correct', 'Correct.')
                                   : t('ui.tryagain', 'Not quite. Try again.');
      li.classList.toggle('right', !!right);
    }

    /* A prompt sits beside the Check button, not in a banner at the foot of
       the page, which a student working at step nine would never see. The
       element is empty in the HTML so the tagger gives it no key. */
    function say(li, msg) {
      const m = li.querySelector('.tev-msg');
      if (m) m.textContent = msg || '';
    }

    function check(li) {
      say(li, '');
      const sel = li.querySelector('select[data-answer]');
      let given, want;
      if (li.dataset.action === 'confirm') {
        /* An acknowledgement step. One button, nothing to get wrong, so it
           carries no .tev-verdict: there is no judgement to report. It still
           gates the run like any other step. */
        given = want = 'confirm';
      } else if (sel) {
        if (!sel.value) { say(li, t('ui.selectfirst', 'Select an answer first.')); return; }
        given = sel.value; want = sel.dataset.answer;
        sel.classList.remove('correct', 'incorrect');
        sel.classList.add(given === want ? 'correct' : 'incorrect');
      } else {
        want = li.dataset.answer;
        given = wb ? wb.get(li.dataset.target) : null;
        if (given === 'hptl' && want !== 'hptl') {
          say(li, t('ui.movefirst', 'Move the target on the board first.'));
          return;
        }
      }

      /* data-answer may list several acceptable values separated by "|", for a
         step where the doctrine genuinely admits more than one defensible call. */
      const right = want.split('|').indexOf(given) !== -1;
      showPick(li, given);
      li.classList.toggle('wrong', !right);
      reveal(li, right);
      if (!right) {
        const bad = [...li.querySelectorAll('.row-note.bad')];
        const note = bad.find(n => n.dataset.for === given) || bad.find(n => !n.dataset.for);
        if (note) note.classList.add('show');
        if (cfg.explainBad) showFeedback(cfg.feedbackId, false, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
        return;
      }
      li.querySelectorAll('.row-note.bad').forEach(n => n.classList.remove('show'));
      li.querySelectorAll('.row-note.ok').forEach(n => n.classList.add('show'));

      /* data-set="target:step ..." moves a box FOR the student, used on a
         narrative beat where the FSCC has already made the call. Applied here
         and NOT in draw(), because re-applying on every redraw would undo a
         later step that moves the same target on. The position persists in
         deliver.wb, so a reload needs no replay. */
      if (li.dataset.set && wb) {
        li.dataset.set.split(/\s+/).forEach(pair => {
          const bits = pair.split(':');
          if (bits.length === 2 && bits[0] && bits[1]) wb.set(bits[0], bits[1]);
        });
      }

      const idx = steps().indexOf(li);
      setPick(idx, given);
      if (idx === solvedCount()) setSolved(idx + 1);
      draw();

      if (solvedCount() >= total) {
        if (cfg.explainOk) showFeedback(cfg.feedbackId, true, cfg.explainOk, cfg.explainBad, cfg.exerciseId);
        complete(cfg.exerciseId);
      } else {
        const fb = cfg.feedbackId && document.getElementById(cfg.feedbackId);
        if (fb) fb.classList.remove('show');
      }
    }

    box.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('button.row-check');
      if (!btn) return;
      const li = btn.closest('.tev');
      if (li) check(li);
    });

    document.addEventListener('DOMContentLoaded', draw);
    document.addEventListener('d3a:langchange', draw);
    draw();
  }

  /* Decision-card drills (detect validation, assess BDA).
     Each .report-card has data-answer; its buttons have data-value.
     cfg = { containerId, exerciseId, onAllCorrect } */
  function initDecisionCards(cfg) {
    const container = document.getElementById(cfg.containerId);
    if (!container) return;
    const cards = container.querySelectorAll('.report-card');
    const solved = new Set();
    cards.forEach(card => {
      card.querySelectorAll('.decision-btns button').forEach(btn => {
        btn.addEventListener('click', () => {
          const right = btn.dataset.value === card.dataset.answer;
          card.querySelectorAll('button').forEach(b => b.classList.remove('chosen-ok', 'chosen-bad'));
          btn.classList.add(right ? 'chosen-ok' : 'chosen-bad');
          const fb = card.querySelector('.drill-feedback');
          fb.classList.add('show');
          fb.classList.toggle('ok', right);
          fb.classList.toggle('bad', !right);
          const why  = t(card.dataset.i18nWhy  || '', card.dataset.why || '');
          const hint = t(card.dataset.i18nHint || '', card.dataset.hint || '');
          fb.innerHTML = right
            ? '<strong>' + t('ui.correct', 'Correct.') + '</strong> ' + why
            : '<strong>' + t('ui.tryagain', 'Not quite — try again.') + '</strong> ' + hint;
          if (right) {
            solved.add(card.id);
            card.querySelectorAll('button').forEach(b => { if (b !== btn) b.disabled = true; });
            if (solved.size === cards.length) {
              complete(cfg.exerciseId);
              const done = document.getElementById(cfg.exerciseId + '-alldone');
              if (done) done.classList.add('show');
            }
          }
        });
      });
    });
  }

  /* exId lets the explanation text be translated: the keys are
     "<exercise id>.ok" and "<exercise id>.bad", e.g. "decide-1.ok". */
  function showFeedback(id, ok, okMsg, badMsg, exId) {
    const fb = document.getElementById(id);
    if (!fb) return;
    fb.classList.add('show');
    fb.classList.remove('ok', 'bad');
    fb.classList.add(ok ? 'ok' : 'bad');
    const body = exId ? t(exId + (ok ? '.ok' : '.bad'), ok ? okMsg : badMsg) : (ok ? okMsg : badMsg);
    const lead = ok ? t('ui.correct', 'Correct.') : t('ui.checkanswers', 'Check your answers.');
    fb.innerHTML = '<strong>' + lead + '</strong> ' + body;
  }


  /* ---------------------------------------------------------------
     Asset status pies on the Deliver timeline.

     Every event that carries a clock time also carries data-min, the
     offset in minutes from T=0 (negative before H-hour). From that one
     number plus a firing schedule we can say what each firing asset was
     doing at that moment, so the student sees the guns go off line and
     come back as the operation runs.

     A tube asset is off line for `recover` minutes after it fires:
     displace, re-occupy, lay in again. The red wedge is the share of
     that wait still to run, so it is a full circle the moment the
     rounds leave and shrinks to nothing as the battery comes back.

     A drone unit is counted, not timed. It spends airframes when it
     launches, and `downFrom` takes the whole unit off line for good
     when the scenario breaks it.

     Nothing here is stored or graded. It is a read-out of the scenario,
     redrawn on a language switch like every other runtime string.
     --------------------------------------------------------------- */
  function initAssetStatus(cfg) {
    const rows = [...document.querySelectorAll('li.ev[data-min]')];
    if (!rows.length || !cfg || !cfg.assets) return;
    const assets = cfg.assets.map(a =>
      Object.assign({}, a, { fires: (a.fires || []).slice().sort((x, y) => x - y) }));

    function stateOf(a, now) {
      if (a.stock != null) {
        if (a.downFrom != null && now >= a.downFrom) {
          return { deg: 360, cls: 'is-down', note: t('ui.assetmalf', 'Malfunction') };
        }
        const gone = (a.sorties || []).reduce((n, s) => n + (s.at <= now ? s.n : 0), 0);
        return { deg: 0, cls: 'is-ready',
                 note: t('ui.assetdrones', '{n} of {total} drones',
                         { n: a.stock - gone, total: a.stock }) };
      }
      let last = null;
      a.fires.forEach(f => { if (f <= now) last = f; });
      if (last === null || now - last >= a.recover) {
        return { deg: 0, cls: 'is-ready', note: t('ui.assetavail', 'Available') };
      }
      const remain = a.recover - (now - last);
      return { deg: Math.max(1, Math.round(360 * remain / a.recover)), cls: 'is-recovering',
               note: t('ui.assetback', 'Back in {n} min', { n: remain }) };
    }

    function draw() {
      rows.forEach(li => {
        const time = li.querySelector('.ev-time');
        if (!time) return;
        const old = li.querySelector(':scope > .asset-status');
        if (old) old.remove();
        const now = Number(li.dataset.min);
        if (!isFinite(now)) return;
        const wrap = document.createElement('div');
        wrap.className = 'asset-status';
        assets.forEach(a => {
          const st = stateOf(a, now);
          const item = document.createElement('div');
          item.className = 'as-item ' + st.cls;
          const pie = document.createElement('span');
          pie.className = 'as-pie';
          pie.style.setProperty('--as-deg', st.deg + 'deg');
          const text = document.createElement('span');
          text.className = 'as-text';
          const lab = document.createElement('span');
          lab.className = 'as-label';
          lab.textContent = t(a.labelKey, a.label);
          const note = document.createElement('span');
          note.className = 'as-note';
          note.textContent = st.note;
          text.appendChild(lab); text.appendChild(note);
          item.appendChild(pie); item.appendChild(text);
          /* one sentence for a screen reader, since the wedge says nothing */
          item.setAttribute('aria-label', t(a.labelKey, a.label) + ': ' + st.note);
          wrap.appendChild(item);
        });
        time.insertAdjacentElement('afterend', wrap);
      });
    }

    draw();
    document.addEventListener('d3a:langchange', draw);
  }

  initModals();

  return { registerPage, complete, isComplete, resetAll, refreshUI, PHASES, PARKED,
           initTimeline,
           initMultiSelect, initSingleSelect, initSortList, initSelectMatch, initDecisionCards,
           initStepLadder, initWorkbench, initTargetEvents, initAssetStatus,
           get storageAvailable() { return store.available; } };
})();
