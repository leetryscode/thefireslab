/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   Fire Mission Sim — English / 繁體中文.

   The sim stays outside the course's re-tagging pipeline (tools/tag-i18n.js
   would renumber it and drop its keys from js/lang-zh.js), so it keeps its own
   dictionary, js/lang-zh-sim.js, and its own attribute, data-sim-i18n. What it
   shares with the course is the language itself: js/i18n.js owns the choice,
   the EN / 繁中 switch and the saved setting, so a student who picked Chinese
   on the course lands in the sim in Chinese.

   THE ENGLISH LIVES IN THE CODE, not in the dictionary. Every call carries its
   own English:  T('sim.say.shot', '{head} {id}, shot, over.', { head, id })
   and the dictionary's `en` is a copy for the translator. test-runtime.js
   (section 46) checks the two copies agree, so an English edit shows up as a
   stale entry instead of silently showing old Chinese.

   Markup:  data-sim-i18n="key"                  element content (innerHTML)
            data-sim-i18n-attr="title:key, ..."  attributes

   Callsigns are translated for display only. Everything the engine keys on —
   the unit select's value, UNIT[callsign], a mission's `unit` — stays English.
   ========================================================= */

const SIM_I18N = (() => {
  const fmt = (s, v) => v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)) : s;

  function lang() {
    return (typeof I18N !== 'undefined' && I18N.get && I18N.get() === 'zh') ? 'zh' : 'en';
  }
  function lookup(key) {
    if (lang() !== 'zh') return null;
    const d = (typeof window !== 'undefined' && window.SIM_LANG_ZH) || null;
    const e = d && d[key];
    return e && typeof e.zh === 'string' && e.zh.trim() !== '' ? e.zh : null;
  }
  /** The translation of `key`, or the English given here. {name} placeholders
      are filled from `vars` in either language. */
  function t(key, en, vars) {
    const z = lookup(key);
    return fmt(z !== null ? z : en, vars);
  }

  /* One slug rule for every dynamic key: "Steel Rain" -> steel-rain,
     "Fire for effect" -> fire-for-effect. */
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  /** A callsign as shown to the student. */
  const name = cs => cs ? t('sim.cs.' + slug(cs), cs) : cs;

  /* ---------- markup ---------- */
  const english = new Map();
  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-sim-i18n]').forEach(el => {
      const key = el.dataset.simI18n;
      if (!english.has(key)) english.set(key, el.innerHTML);
      const z = lookup(key);
      el.innerHTML = z !== null ? z : english.get(key);
    });
    scope.querySelectorAll('[data-sim-i18n-attr]').forEach(el => {
      el.dataset.simI18nAttr.split(',').forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (!attr || !key) return;
        const store = 'simOrig' + attr.replace(/[^a-z]/gi, '');
        if (el.dataset[store] === undefined) el.dataset[store] = el.getAttribute(attr) || '';
        const z = lookup(key);
        el.setAttribute(attr, z !== null ? z : el.dataset[store]);
      });
    });
  }

  /* ---------- telling the page ----------
     js/i18n.js sets the saved language on DOMContentLoaded without an event,
     and fires d3a:langchange when the student flips the switch. Both end here:
     the markup is re-applied and every painter that wrote text from script is
     asked to paint again. */
  const listeners = [];
  const onChange = fn => { listeners.push(fn); };
  function refresh() {
    if (typeof document === 'undefined') return;
    apply(document);
    document.body && document.body.classList.toggle('sim-zh', lang() === 'zh');
    for (const fn of listeners) { try { fn(lang()); } catch (e) { console.error(e); } }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('d3a:langchange', refresh);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
    else setTimeout(refresh, 0);
  }

  /* Pad to a display width, counting a CJK character as two columns, so the
     monospaced fires log and score keep their columns in Chinese. */
  const wide = ch => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);
  const width = s => [...String(s)].reduce((a, ch) => a + (wide(ch) ? 2 : 1), 0);
  const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
  const padStart = (s, w) => ' '.repeat(Math.max(0, w - width(s))) + s;

  return { t, lang, name, slug, apply, onChange, refresh, width, padEnd, padStart, fmt };
})();

if (typeof window !== 'undefined') window.SIM_I18N = SIM_I18N;
if (typeof module !== 'undefined' && module.exports) module.exports = SIM_I18N;
