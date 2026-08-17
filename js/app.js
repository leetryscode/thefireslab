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
              'decide-4', 'decide-5', 'decide-6', 'decide-7',
              'decide-8', 'decide-9', 'decide-10',
              'decide-11', 'decide-12'],
    /* Parked 2026-08-16. Detect, Deliver and Assess are "Coming soon"
       placeholders while their content is written. An empty list keeps the tab
       dark (phaseDone requires length > 0) and keeps the course progress bar
       counting only what a student can actually do. Move the ids back out of
       PARKED when a phase is ready. */
    detect:  [],
    deliver: [],
    assess:  []
  };

  /* The exercise ids each parked phase will bring back with it. */
  const PARKED = {
    detect:  ['detect-1', 'detect-2'],
    deliver: ['deliver-1', 'deliver-2'],
    assess:  ['assess-1', 'assess-2', 'assess-3']
  };

  /* Decide's second-level nav. Keyed by filename so a sub-tab can show its
     own checkmark independently of the phase tab above it. */
  const SUBPAGES = {
    'decide.html':     ['decide-1', 'decide-2', 'decide-3'],
    'decide-tss.html': ['decide-4', 'decide-5', 'decide-6', 'decide-7'],
    'decide-agm.html': ['decide-8', 'decide-9', 'decide-10'],
    'decide-sync.html': ['decide-11', 'decide-12']
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
      const close = box.querySelector('.modal-close');
      if (close) close.focus();
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

  initModals();

  return { registerPage, complete, isComplete, resetAll, refreshUI, PHASES, PARKED,
           initMultiSelect, initSingleSelect, initSortList, initSelectMatch, initDecisionCards,
           get storageAvailable() { return store.available; } };
})();
