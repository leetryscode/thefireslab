/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   The Fires Lab — language switching (English / 繁體中文)

   How it works
   ------------
   English is written directly into the HTML. Every translatable
   element carries data-i18n="some.key". The Chinese text lives in
   js/lang-zh.js as a plain object on window.D3A_LANG_ZH.

   If a key is missing or its value is an empty string, the English
   already in the page is used. That means the site is always usable,
   even with the dictionary only half filled in.

   The dictionary is a .js file, NOT .json, on purpose: browsers block
   fetch()/XHR against file:// URLs, so a JSON file would fail the
   moment somebody opens the course from a USB stick.
   ========================================================= */

const I18N = (() => {
  const KEY = 'd3a-course-lang-v1';
  const DEFAULT = 'en';
  const LANGS = {
    en: { tag: 'en',      label: 'EN',   name: 'English' },
    zh: { tag: 'zh-Hant', label: '繁中', name: '繁體中文' }
  };

  /* The original English is captured on first load so that switching
     back from Chinese restores it exactly, including inline markup. */
  const english = new Map();
  let current = DEFAULT;

  function dict() {
    return (current === 'zh' && window.D3A_LANG_ZH) ? window.D3A_LANG_ZH : null;
  }

  /* Look up one key. Returns null when there is no usable translation,
     which is what makes a half-finished dictionary safe to ship.
     Entries look like { en: "...", zh: "..." }; a bare string also works. */
  function lookup(key) {
    const d = dict();
    if (!d) return null;
    const v = d[key];
    if (typeof v === 'string') return v.trim() !== '' ? v : null;
    if (v && typeof v === 'object' && typeof v.zh === 'string' && v.zh.trim() !== '') return v.zh;
    return null;
  }

  /* Translate a runtime string built in JavaScript.
     t('ui.complete', 'COMPLETE')  ->  the translation, or the fallback.
     Placeholders: t('ui.progress', 'Tasks: {done} of {total}', {done: 2, total: 5}) */
  function t(key, fallback, vars) {
    let s = lookup(key);
    if (s === null) s = fallback;
    if (vars) {
      Object.keys(vars).forEach(k => {
        s = s.split('{' + k + '}').join(vars[k]);
      });
    }
    return s;
  }

  function load() {
    try {
      const saved = localStorage.getItem(KEY);
      return LANGS[saved] ? saved : DEFAULT;
    } catch (e) { return DEFAULT; }
  }
  function save(lang) {
    try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode — ignore */ }
  }

  /* ---------- Applying a language to the page ---------- */

  function remember(el, key) {
    if (!english.has(key)) english.set(key, el.innerHTML);
  }

  function applyTo(root) {
    const scope = root || document;

    /* element content */
    scope.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      remember(el, key);
      const translated = lookup(key);
      el.innerHTML = translated !== null ? translated : english.get(key);
    });

    /* attributes: data-i18n-attr="title:some.key, placeholder:other.key" */
    scope.querySelectorAll('[data-i18n-attr]').forEach(el => {
      el.dataset.i18nAttr.split(',').forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (!attr || !key) return;
        const store = 'i18nOrig' + attr.replace(/[^a-z]/gi, '');
        if (el.dataset[store] === undefined) el.dataset[store] = el.getAttribute(attr) || '';
        const translated = lookup(key);
        el.setAttribute(attr, translated !== null ? translated : el.dataset[store]);
      });
    });
  }

  function setLang(lang, opts) {
    if (!LANGS[lang]) lang = DEFAULT;
    current = lang;
    document.documentElement.setAttribute('lang', LANGS[lang].tag);
    document.documentElement.setAttribute('data-lang', lang);
    applyTo(document);
    save(lang);
    updateToggle();
    /* let the rest of the app redraw anything it generated itself */
    if (!opts || opts.notify !== false) {
      document.dispatchEvent(new CustomEvent('d3a:langchange', { detail: { lang } }));
    }
  }

  function toggle() { setLang(current === 'en' ? 'zh' : 'en'); }
  function get() { return current; }

  /* ---------- The switch in the header ---------- */

  function updateToggle() {
    document.querySelectorAll('.lang-toggle button').forEach(b => {
      const on = b.dataset.lang === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function buildToggle() {
    /* A page may already contain its own .lang-toggle; if not, add one.
       Placement is deliberate: never inside a.brand-link, or clicking the
       switch would navigate away. Pages with a phase nav get it on the tab
       row; the two splash pages get it under the title. */
    let box = document.querySelector('.lang-toggle');
    if (!box) {
      const host = document.querySelector('nav.phases') || document.querySelector('.header-inner');
      if (!host) return;
      box = document.createElement('div');
      box.className = 'lang-toggle';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Language / 語言');
      host.appendChild(box);
    }
    if (!box.children.length) {
      Object.keys(LANGS).forEach(code => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.lang = code;
        b.textContent = LANGS[code].label;
        b.title = LANGS[code].name;
        box.appendChild(b);
      });
    }
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-lang]');
      if (b) setLang(b.dataset.lang);
    });
  }

  /* Console helper: I18N.audit() lists keys whose English has changed
     since the dictionary was generated, plus anything still untranslated.
     Run tools/tag-i18n.js to regenerate after editing English content. */
  function audit() {
    const d = window.D3A_LANG_ZH || {};
    const stale = [], missing = [], orphan = [];
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      const entry = d[key];
      if (!entry) { orphan.push(key); return; }
      const now = (english.get(key) || '').replace(/\s+/g, ' ').trim();
      if (entry.en !== undefined && entry.en !== now) stale.push(key);
      if (!entry.zh || !entry.zh.trim()) missing.push(key);
    });
    console.log(`i18n audit — ${missing.length} untranslated, ${stale.length} stale, ${orphan.length} not in dictionary`);
    if (stale.length) console.log('stale (English changed):', stale);
    if (orphan.length) console.log('missing from dictionary:', orphan);
    return { missing, stale, orphan };
  }

  function init() {
    buildToggle();
    setLang(load(), { notify: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { t, setLang, toggle, get, apply: applyTo, audit, LANGS };
})();

window.I18N = I18N;
