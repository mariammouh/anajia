/* ==========================================================================
   Sehhati (صحتي) — women's health companion · hackathon prototype
   Vanilla JS, no build step, no backend. Everything stays in localStorage.

   1 helpers & i18n   2 state        3 dates        4 scoring engine
   5 demo personas    6 UI pieces    7 views        8 modals
   9 actions & events 10 boot

   The app NEVER diagnoses or prescribes: it surfaces transparent,
   rule-based "patterns commonly associated with…" and safety red flags.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 1 */
  const I18N = window.SEHHATI_I18N || {};
  const STORE_KEY = 'sehhati.v1';
  const LOCALES = { fr: 'fr-FR', ar: 'ar-MA', en: 'en-GB' };
  const LANG_NAMES = { fr: 'Français', ar: 'العربية', en: 'English' };
  const LANG_SHORT = { fr: 'FR', ar: 'ع', en: 'EN' };
  const VIEWS = ['home', 'log', 'insights', 'community', 'doctor'];
  const MOODS = [
    { id: 'great', emoji: '🤩' }, { id: 'good', emoji: '😊' }, { id: 'meh', emoji: '😐' },
    { id: 'low', emoji: '😢' }, { id: 'rough', emoji: '😖' }
  ];
  const RESULTS = ['helped', 'partly', 'no_change', 'worse'];
  const CATEGORIES = ['medical', 'lifestyle', 'complementary', 'support'];

  let KB = null;
  let COMMUNITY = null;

  const $ = (sel, root) => (root || document).querySelector(sel);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function lang() { return state.profile.lang || 'fr'; }
  function t(key, vars) {
    let s = I18N[lang()] && I18N[lang()][key];
    if (s == null) s = I18N.fr && I18N.fr[key];
    if (s == null) s = key;
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }
  /** Pick the current language out of a {fr, ar, en} object (plain strings pass through). */
  function L(o) {
    if (o == null) return '';
    if (typeof o === 'string') return o;
    return o[lang()] || o.fr || o.en || '';
  }
  function num(n, digits) {
    return new Intl.NumberFormat(LOCALES[lang()], { maximumFractionDigits: digits == null ? 1 : digits }).format(n);
  }
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  /* ------------------------------------------------------------------ 2 */
  function defaultState() {
    return {
      v: 1,
      profile: {
        onboarded: false, nickname: '', anonymous: false, lang: 'fr',
        cycleLength: 28, periodLength: 5, periodStarts: [], diagnosed: [], demo: null
      },
      logs: [],            // [{id, date:'YYYY-MM-DD', symptoms:{id:intensity}, mood, note, ts}]
      moods: {},           // {date: moodId}
      community: { helped: {}, mine: [] },
      answers: {},         // narrowing questions: {symptomId: 'yes'|'no'}
      experiments: [],     // [{id, cond, item, symptom, start, baseline, status:'active'|'done', result, end, after}]
      doctor: { unchecked: {}, custom: [] },
      settings: { showVerification: false }
    };
  }
  function loadState() {
    const base = defaultState();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return base;
      const saved = JSON.parse(raw);
      for (const k of Object.keys(base)) {
        if (saved[k] === undefined) continue;
        if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) Object.assign(base[k], saved[k]);
        else base[k] = saved[k];
      }
    } catch (e) { /* corrupted or unavailable storage: start fresh */ }
    return base;
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }

  let state = loadState();

  const ui = {
    view: 'home',
    modal: null,
    onb: { step: 0, nickname: '', anonymous: false, lastPeriod: '', cycleLength: 28 },
    log: null,
    open: {},
    com: { condition: 'all', result: 'all', category: 'all' },
    share: null
  };

  /* ------------------------------------------------------------------ 3 */
  const pad = n => String(n).padStart(2, '0');
  const toStr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function parseDate(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2], 12); }
  function today() { return toStr(new Date()); }
  function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return toStr(d); }
  function diffDays(a, b) { return Math.round((parseDate(a) - parseDate(b)) / 86400000); }
  function fmtDate(s, opts) {
    return new Intl.DateTimeFormat(LOCALES[lang()], opts || { day: 'numeric', month: 'short' }).format(parseDate(s));
  }
  function friendlyDate(s) {
    if (s === today()) return t('common.today');
    if (s === addDays(today(), -1)) return t('common.yesterday');
    return fmtDate(s, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  /* ------------------------------------------------------------------ 4
     Scoring engine — pure functions, no DOM. Exposed as window.Sehhati.Engine
     so it can be tested from the console.

     points(symptom) = weight × (floor + (1 − floor) × avgIntensity / 10)
     points(rule)    = rule.points when the timing / intensity / cycle rule matches
     score           = Σ points ÷ Σ possible points                      */
  const Engine = {
    avgCycleLength(profile) {
      const ps = profile.periodStarts.slice().sort();
      const gaps = [];
      for (let i = 1; i < ps.length; i++) {
        const g = diffDays(ps[i], ps[i - 1]);
        if (g >= 15 && g <= 120) gaps.push(g);
      }
      if (gaps.length) return Math.round(mean(gaps));
      return profile.cycleLength || 28;
    },

    /** Cycle day + estimated phase for a date, from the list of period start dates. */
    cycleInfo(profile, date, kb) {
      const ps = profile.periodStarts.slice().sort();
      let prev = null, next = null;
      for (const p of ps) {
        if (p <= date) prev = p;
        else if (!next) next = p;
      }
      if (!prev) return { cycleDay: null, phase: null };
      const sc = kb.meta.scoring;
      const len = Engine.avgCycleLength(profile);
      const periodLen = profile.periodLength || sc.defaultPeriodLength;
      const cycleDay = diffDays(date, prev) + 1;
      const daysToNext = next ? diffDays(next, date) : diffDays(addDays(prev, len), date);
      let phase;
      if (cycleDay <= periodLen) phase = 'menstrual';
      else if (daysToNext <= 0) phase = 'late';
      else if (daysToNext <= sc.lutealDays) phase = 'luteal';
      else if (daysToNext <= sc.lutealDays + 6) phase = 'ovulation';
      else phase = 'follicular';
      return { cycleDay, phase, cycleLength: len, daysToNext, estimated: !next, lastStart: prev };
    },

    /** Logs inside the analysis window. */
    windowLogs(logs, kb, ref) {
      const end = ref || today();
      const from = addDays(end, -kb.meta.scoring.windowDays);
      return logs.filter(e => e.date > from && e.date <= end);
    },

    /** {symptomId: [{date, intensity, phase}]} */
    observations(logs, profile, kb) {
      const obs = {};
      for (const e of logs) {
        const ci = Engine.cycleInfo(profile, e.date, kb);
        for (const id in e.symptoms) {
          const v = e.symptoms[id];
          if (!(v > 0)) continue;
          (obs[id] = obs[id] || []).push({ date: e.date, intensity: v, phase: ci.phase });
        }
      }
      return obs;
    },

    evalRule(rule, obs, profile) {
      if (rule.type === 'timing') {
        let total = 0, hit = 0;
        for (const id of rule.symptoms) {
          for (const o of (obs[id] || [])) {
            if (!o.phase) continue;
            total++;
            const ok = rule.phase === 'non_menstrual' ? o.phase !== 'menstrual' : o.phase === rule.phase;
            if (ok) hit++;
          }
        }
        const share = total ? hit / total : 0;
        return { matched: hit >= (rule.minCount || 1) && share >= (rule.minShare || 0.5), share, hit, total };
      }
      if (rule.type === 'intensity') {
        const vals = [];
        for (const id of rule.symptoms) for (const o of (obs[id] || [])) vals.push(o.intensity);
        const avg = mean(vals);
        return { matched: vals.length >= (rule.minCount || 1) && avg >= rule.minAvg, avg, count: vals.length };
      }
      if (rule.type === 'cycle_length') {
        const len = Engine.avgCycleLength(profile);
        return { matched: len >= rule.min, len };
      }
      return { matched: false };
    },

    scoreCondition(cond, obs, profile, kb) {
      const sc = kb.meta.scoring;
      const floor = sc.intensityFloor;
      let points = 0, max = 0;
      const contributions = [];
      for (const ws of cond.symptoms) {
        max += ws.weight;
        const o = obs[ws.id];
        if (!o || !o.length) continue;
        const avg = mean(o.map(x => x.intensity));
        const pts = ws.weight * (floor + (1 - floor) * (avg / 10));
        points += pts;
        contributions.push({ id: ws.id, weight: ws.weight, avg, days: o.length, points: pts });
      }
      const rules = [];
      for (const r of (cond.rules || [])) {
        max += r.points;
        const res = Engine.evalRule(r, obs, profile);
        if (res.matched) points += r.points;
        rules.push({ rule: r, matched: res.matched, detail: res });
      }
      contributions.sort((a, b) => b.points - a.points);
      const ratio = max ? points / max : 0;
      const lvl = sc.levels.find(l => ratio >= l.min);
      return { id: cond.id, points, max, ratio, level: lvl ? lvl.id : 'none', contributions, rules };
    },

    scoreAll(logs, profile, kb) {
      const obs = Engine.observations(logs, profile, kb);
      return kb.conditions.map(c => Engine.scoreCondition(c, obs, profile, kb)).sort((a, b) => b.ratio - a.ratio);
    },

    /** Global red flags + every condition's own red flags, de-duplicated by id. */
    redFlagRules(kb) {
      const seen = {}, out = [];
      const add = (r, condId) => { if (!seen[r.id]) { seen[r.id] = 1; out.push(Object.assign({ condition: condId || null }, r)); } };
      (kb.redFlags || []).forEach(r => add(r));
      kb.conditions.forEach(c => (c.redFlags || []).forEach(r => add(r, c.id)));
      return out;
    },

    /** Red-flag rules matched by ONE log entry (same-day combination). */
    redFlags(entry, kb) {
      const s = entry.symptoms || {};
      const has = c => typeof c === 'string' ? s[c] > 0 : (s[c.symptom] || 0) >= c.min;
      return Engine.redFlagRules(kb).filter(r => {
        if (!r.all && !r.any) return false;
        return (r.all || []).every(has) && (!r.any || r.any.some(has));
      });
    },

    symptomStats(logs) {
      const m = {};
      for (const e of logs) for (const id in e.symptoms) {
        if (!(e.symptoms[id] > 0)) continue;
        (m[id] = m[id] || []).push(e.symptoms[id]);
      }
      return Object.keys(m).map(id => ({ id, days: m[id].length, avg: mean(m[id]) }))
        .sort((a, b) => b.days - a.days || b.avg - a.avg);
    }
  };

  const symptomById = id => KB.symptoms.find(s => s.id === id);
  const conditionById = id => KB.conditions.find(c => c.id === id);
  const currentLogs = () => Engine.windowLogs(state.logs, KB);

  /* ------------------------------------------------------------------ 5
     Demo personas: three fictional profiles, one per implemented condition.
     Dates are generated relative to today so the cycle maths always works. */
  const PERSONAS = [
    {
      id: 'salma', condition: 'dysmenorrhea_pms', emoji: '🌸', age: 22,
      name: { fr: 'Salma', ar: 'سلمى', en: 'Salma' },
      desc: {
        fr: 'Étudiante, 22 ans. Crampes fortes les deux premiers jours, humeur en montagnes russes avant les règles.',
        ar: 'طالبة، 22 سنة. تقلصات قوية في اليومين الأولين ومزاج متقلب قبل الدورة.',
        en: 'Student, 22. Strong cramps on the first two days, rollercoaster mood before her period.'
      },
      cycleLength: 28, periodLength: 5, starts: [2, 30, 58, 86, 114],
      cycle: [
        { day: 1, s: { cramps: 8, lower_back_pain: 6, nausea: 4, fatigue: 6 }, mood: 'rough', note: { fr: "J'ai raté le cours du matin.", ar: 'تغيبت عن درس الصباح.', en: 'I missed my morning class.' } },
        { day: 2, s: { cramps: 7, lower_back_pain: 5, diarrhea_constipation: 3 }, mood: 'low' },
        { day: 3, s: { cramps: 4, fatigue: 4 }, mood: 'meh' },
        { before: 6, s: { bloating: 5, food_cravings: 6 }, mood: 'meh' },
        { before: 4, s: { mood_swings: 7, irritability: 6, breast_tenderness: 5 }, mood: 'low' },
        { before: 2, s: { mood_swings: 8, irritability: 7, fatigue: 5, headache: 4, sleep_problems: 5 }, mood: 'low', note: { fr: 'Dispute pour un rien, puis envie de pleurer.', ar: 'شجار لسبب تافه ثم رغبة في البكاء.', en: 'Argued over nothing, then felt like crying.' } },
        { before: 1, s: { bloating: 6, breast_tenderness: 6, low_mood: 5, food_cravings: 5 }, mood: 'meh' }
      ]
    },
    {
      id: 'imane', condition: 'endometriosis', emoji: '🦋', age: 29,
      name: { fr: 'Imane', ar: 'إيمان', en: 'Imane' },
      desc: {
        fr: "Enseignante, 29 ans. Douleurs très fortes pendant les règles, mais aussi en dehors, aux selles et pendant les rapports. « On m'a toujours dit que c'était normal. »",
        ar: 'أستاذة، 29 سنة. آلام شديدة جداً أثناء الدورة وخارجها أيضاً، عند التبرز وأثناء العلاقة الحميمة. «قيل لي دائماً إن ذلك طبيعي.»',
        en: 'Teacher, 29. Very strong pain during periods but also outside them, with bowel movements and during sex. “I was always told it was normal.”'
      },
      cycleLength: 27, periodLength: 5, starts: [9, 36, 63, 90, 117],
      cycle: [
        { day: 1, s: { cramps: 9, heavy_bleeding: 8, nausea: 5, lower_back_pain: 7 }, mood: 'rough', note: { fr: 'Impossible de travailler, restée allongée.', ar: 'لم أستطع العمل وبقيت مستلقية.', en: 'Could not work, stayed lying down.' } },
        { day: 2, s: { cramps: 9, heavy_bleeding: 7, pain_bowel: 8, leg_pain: 5, fatigue: 7 }, mood: 'rough' },
        { day: 3, s: { cramps: 7, pain_bowel: 6, bloating: 6 }, mood: 'low' },
        { day: 4, s: { cramps: 6, fatigue: 6 }, mood: 'meh' },
        { day: 9, s: { pelvic_pain: 6, pain_during_sex: 7 }, mood: 'low' },
        { day: 14, s: { pelvic_pain: 7, bloating: 5 }, mood: 'meh' },
        { day: 20, s: { pelvic_pain: 6, pain_during_sex: 7, fatigue: 6 }, mood: 'low', note: { fr: 'Douleur en dehors des règles, encore.', ar: 'ألم خارج أيام الدورة مرة أخرى.', en: 'Pain outside my period, again.' } },
        { day: 24, s: { pelvic_pain: 5, lower_back_pain: 6 }, mood: 'meh' }
      ]
    },
    {
      id: 'khadija', condition: 'pcos', emoji: '🌿', age: 26,
      name: { fr: 'Khadija', ar: 'خديجة', en: 'Khadija' },
      desc: {
        fr: 'Designer, 26 ans. Cycles très irréguliers, acné, pilosité et fatigue. Elle se demande si tout cela est lié.',
        ar: 'مصممة، 26 سنة. دورات غير منتظمة جداً، حب شباب، شعر زائد وتعب. تتساءل هل كل ذلك مترابط.',
        en: 'Designer, 26. Very irregular cycles, acne, excess hair and fatigue. She wonders whether it is all connected.'
      },
      cycleLength: 60, periodLength: 5, starts: [39, 137],
      absolute: [
        { ago: 3, s: { acne: 6, excess_hair: 7, fatigue: 5 }, mood: 'meh' },
        { ago: 10, s: { irregular_cycles: 7, weight_gain: 6, low_mood: 5 }, mood: 'low' },
        { ago: 18, s: { hair_thinning: 5, acne: 6 }, mood: 'meh' },
        { ago: 27, s: { excess_hair: 7, dark_patches: 4, fatigue: 6 }, mood: 'meh' },
        { ago: 38, s: { cramps: 4, fatigue: 4 }, mood: 'meh', note: { fr: 'Enfin mes règles, après plus de 3 mois.', ar: 'أخيراً جاءت دورتي بعد أكثر من 3 أشهر.', en: 'My period at last, after more than 3 months.' } },
        { ago: 45, s: { missed_periods: 7, irregular_cycles: 7, anxiety: 5 }, mood: 'low', note: { fr: 'Toujours pas de règles. Test de grossesse négatif.', ar: 'الدورة لم تأتِ بعد. اختبار الحمل سلبي.', en: 'Still no period. Pregnancy test negative.' } },
        { ago: 56, s: { weight_gain: 6, fatigue: 5, sleep_problems: 4 }, mood: 'meh' },
        { ago: 66, s: { acne: 7, excess_hair: 6 }, mood: 'low' },
        { ago: 78, s: { irregular_cycles: 6, hair_thinning: 5, low_mood: 5 }, mood: 'low' },
        { ago: 90, s: { excess_hair: 7, dark_patches: 4, weight_gain: 6 }, mood: 'meh' },
        { ago: 103, s: { acne: 5, fatigue: 5 }, mood: 'meh' }
      ]
    }
  ];

  function buildPersona(p) {
    const td = today();
    const byAgo = {};
    const put = (ago, item, vary, withNote) => {
      if (ago < 1 || ago > 110) return;       // keep today free for the live demo
      const symptoms = {};
      for (const id in item.s) symptoms[id] = Math.max(1, Math.min(10, item.s[id] + (vary || 0)));
      byAgo[ago] = { symptoms, mood: item.mood || null, note: withNote && item.note ? item.note : '' };   // {fr, ar, en}: follows the UI language
    };
    (p.cycle || []).forEach(item => {
      p.starts.forEach((startAgo, idx) => {
        const vary = idx % 2 === 1 ? -1 : 0;   // small, deterministic cycle-to-cycle variation
        const ago = item.day ? startAgo - (item.day - 1) : startAgo + item.before;
        put(ago, item, vary, idx <= 1);        // notes only on the two most recent cycles
      });
    });
    (p.absolute || []).forEach(item => put(item.ago, item, 0, true));
    const logs = [], moods = {};
    Object.keys(byAgo).map(Number).sort((a, b) => b - a).forEach((ago, i) => {
      const date = addDays(td, -ago), e = byAgo[ago];
      logs.push({ id: 'demo' + i, date, symptoms: e.symptoms, mood: e.mood, note: e.note, ts: Date.now() - ago * 86400000 });
      if (e.mood) moods[date] = e.mood;
    });
    return {
      periodStarts: p.starts.map(a => addDays(td, -a)).sort(),
      logs, moods
    };
  }

  function loadPersona(id) {
    const p = PERSONAS.find(x => x.id === id);
    if (!p) return;
    const keepLang = state.profile.lang, keepSettings = state.settings;
    state = defaultState();
    state.profile.lang = keepLang;
    state.settings = keepSettings;
    const built = buildPersona(p);
    Object.assign(state.profile, {
      onboarded: true, nickname: L(p.name), anonymous: false, demo: p.id,
      cycleLength: p.cycleLength, periodLength: p.periodLength, periodStarts: built.periodStarts
    });
    state.logs = built.logs;
    state.moods = built.moods;
    persist();
    ui.log = null; ui.open = {}; ui.modal = null;
    ui.com = { condition: 'all', result: 'all', category: 'all' };
    go('home');
    renderModal();
    toast(t('set.demoLoaded', { name: L(p.name) }));
  }

  /* ------------------------------------------------------------------ 6 */
  const INK = '#4A2C3A';
  let uid = 0;

  /** The mascot, "Warda" (little rose). Her face follows the mood. */
  function mascot(mood, cls) {
    const g = 'mg' + (++uid);
    const stroke = `stroke="${INK}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
    const roundEyes = `<g class="m-eyes"><circle cx="45" cy="66" r="5.5" fill="${INK}"/><circle cx="75" cy="66" r="5.5" fill="${INK}"/><circle cx="47" cy="64" r="1.8" fill="#fff"/><circle cx="77" cy="64" r="1.8" fill="#fff"/></g>`;
    const faces = {
      great: `<path ${stroke} d="M37 68 Q45 57 53 68"/><path ${stroke} d="M67 68 Q75 57 83 68"/>
              <path d="M48 77 Q60 96 72 77 Z" fill="${INK}"/><path d="M54 86 Q60 91 66 86 Q60 82 54 86Z" fill="#FF8FB1"/>
              <path class="m-spark" d="M104 26l2.4 5.6 5.6 2.4-5.6 2.4-2.4 5.6-2.4-5.6-5.6-2.4 5.6-2.4z" fill="#FFD166"/>
              <path class="m-spark m-spark2" d="M14 34l1.8 4.2 4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2-4.2-1.8 4.2-1.8z" fill="#C77DFF"/>`,
      good: `${roundEyes}<path ${stroke} d="M50 79 Q60 89 70 79"/>`,
      meh: `${roundEyes}<path ${stroke} d="M51 83 L69 83"/>`,
      low: `${roundEyes}<path ${stroke} stroke-width="3" d="M37 58 L51 54"/><path ${stroke} stroke-width="3" d="M83 58 L69 54"/>
            <path ${stroke} d="M51 87 Q60 79 69 87"/>
            <path class="m-tear" d="M37 75 Q32 84 37 87 Q42 84 37 75Z" fill="#8ED8F8"/>`,
      rough: `<path ${stroke} d="M39 61 L51 66 L39 71"/><path ${stroke} d="M81 61 L69 66 L81 71"/>
              <path ${stroke} d="M48 85 Q52 80 56 85 T64 85 T72 85"/>
              <path class="m-tear" d="M96 42 Q91 51 96 55 Q101 51 96 42Z" fill="#8ED8F8"/>`
    };
    const m = faces[mood] ? mood : 'good';
    return `<svg class="mascot mascot--${m} ${cls || ''}" viewBox="0 0 120 120" aria-hidden="true">
      <defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF8FB1"/><stop offset="1" stop-color="#FF5C8A"/></linearGradient></defs>
      <path d="M60 26 C52 9 39 8 36 14 C43 17 52 21 60 28Z" fill="#5ED6B5"/>
      <path d="M60 26 C68 9 81 8 84 14 C77 17 68 21 60 28Z" fill="#46C4A2"/>
      <path d="M60 24 C92 24 104 48 104 68 C104 94 84 108 60 108 C36 108 16 94 16 68 C16 48 28 24 60 24Z" fill="url(#${g})"/>
      <path d="M32 50 C38 37 54 32 66 36" stroke="#fff" stroke-opacity=".45" stroke-width="4" stroke-linecap="round" fill="none"/>
      <ellipse cx="33" cy="78" rx="8" ry="5" fill="#FF2E6E" opacity=".28"/><ellipse cx="87" cy="78" rx="8" ry="5" fill="#FF2E6E" opacity=".28"/>
      ${faces[m]}
    </svg>`;
  }

  const ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9"/><path d="M10 20v-5h4v5"/>',
    log: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    insights: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    community: '<circle cx="9" cy="9" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="8" r="2.5"/><path d="M16.5 13.2c2.5.2 4.1 1.8 4.5 4.3"/>',
    doctor: '<rect x="5" y="4.5" width="14" height="16.5" rx="3"/><path d="M9 4.5V4a3 3 0 0 1 6 0v.5"/><path d="M12 10v6M9 13h6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
    print: '<path d="M7 8V3.5h10V8"/><rect x="3.5" y="8" width="17" height="9" rx="2.5"/><rect x="7" y="14" width="10" height="6.5" rx="1.2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.2"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.500 15.4 12 20 12 20z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };
  function icon(name, cls) {
    return `<svg class="icon ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  function intensityFace(v) { return v <= 0 ? '😌' : v <= 2 ? '🙂' : v <= 4 ? '😕' : v <= 6 ? '😣' : v <= 8 ? '😖' : '😭'; }
  function intensityWord(v) { return t('int.' + (v <= 0 ? 0 : v <= 2 ? 1 : v <= 4 ? 2 : v <= 6 ? 3 : v <= 8 ? 4 : 5)); }
  function intensityClass(v) { return v >= 7 ? 'i-high' : v >= 4 ? 'i-mid' : 'i-low'; }
  /** Nickname to show. Demo personas follow the UI language (Salma / سلمى). */
  function nickname() {
    const p = state.profile;
    const persona = p.demo && PERSONAS.find(x => x.id === p.demo);
    if (persona && Object.keys(persona.name).some(k => persona.name[k] === p.nickname)) return L(persona.name);
    return p.nickname;
  }
  function displayName() {
    return (state.profile.anonymous || !state.profile.nickname) ? t('common.anonymous') : nickname();
  }
  function sourceLabel(code) {
    const s = KB.meta.sources[code];
    return s && s.label ? L(s.label) : code;
  }

  function topbar() {
    return `
      <button class="brand" data-action="go" data-view="home" aria-label="Sehhati">
        <span class="brand-logo">${mascot('good')}</span>
        <span class="brand-name">Sehhati <span class="brand-ar" lang="ar">صحتي</span></span>
      </button>
      <div class="topbar-actions">
        <div class="lang-switch" role="group" aria-label="${esc(t('common.language'))}">
          ${Object.keys(LANG_SHORT).map(l => `<button data-action="lang" data-lang="${l}" class="${l === lang() ? 'on' : ''}" aria-pressed="${l === lang()}" title="${LANG_NAMES[l]}">${LANG_SHORT[l]}</button>`).join('')}
        </div>
        <button class="icon-btn" data-action="open-modal" data-modal="settings" aria-label="${esc(t('common.settings'))}">${icon('gear')}</button>
      </div>`;
  }

  function tabbar() {
    return VIEWS.map(v => `
      <button class="tab ${ui.view === v ? 'on' : ''}" data-action="go" data-view="${v}" ${ui.view === v ? 'aria-current="page"' : ''}>
        <span class="tab-ico">${icon(v)}</span><span class="tab-label">${t('nav.' + v)}</span>
      </button>`).join('');
  }

  function moodPicker(selected, action) {
    return `<div class="mood-row" role="group">${MOODS.map(m => `
      <button class="mood-btn ${selected === m.id ? 'on' : ''}" data-action="${action}" data-mood="${m.id}" aria-pressed="${selected === m.id}">
        <span class="mood-emoji">${m.emoji}</span><span class="mood-label">${t('mood.' + m.id)}</span>
      </button>`).join('')}</div>`;
  }

  function personaCards() {
    return `<div class="persona-list">${PERSONAS.map(p => {
      const c = conditionById(p.condition);
      return `<button class="persona" data-action="load-persona" data-id="${p.id}" style="--accent:${c.color}">
        <span class="persona-emoji">${p.emoji}</span>
        <span class="persona-text"><strong>${esc(L(p.name))} · ${esc(L(c.shortName))}</strong><small>${esc(L(p.desc))}</small></span>
      </button>`;
    }).join('')}</div>`;
  }

  /* ------------------------------------------------------------------ 7 */

  /* ---- Onboarding ---- */
  function viewOnboarding() {
    const o = ui.onb;
    const dots = `<div class="dots">${[0, 1, 2].map(i => `<span class="dot ${i === o.step ? 'on' : ''}"></span>`).join('')}</div>`;
    let body;
    if (o.step === 0) {
      body = `
        <div class="onb-hero">${mascot('great', 'mascot-xl')}</div>
        <h1 class="onb-title">${t('onb.welcome')}</h1>
        <p class="onb-sub">${t('onb.welcomeSub')}</p>
        <p class="field-label center">${t('onb.chooseLang')}</p>
        <div class="lang-big">
          ${Object.keys(LANG_NAMES).map(l => `<button class="lang-opt ${l === lang() ? 'on' : ''}" data-action="lang" data-lang="${l}" aria-pressed="${l === lang()}">${LANG_NAMES[l]}</button>`).join('')}
        </div>
        <button class="btn btn-primary btn-block" data-action="onb-next">${t('onb.start')}</button>
        <button class="btn btn-ghost btn-block" data-action="open-modal" data-modal="demo">${t('onb.tryDemo')}</button>
        <p class="fineprint">${t('onb.notMedical')}</p>`;
    } else if (o.step === 1) {
      body = `
        <div class="onb-hero small">${mascot('good', 'mascot-lg')}</div>
        <h1 class="onb-title">${t('onb.nameTitle')}</h1>
        <p class="onb-sub">${t('onb.nameSub')}</p>
        <input class="input input-lg" type="text" maxlength="24" autocomplete="off" data-input="onb-nickname"
               placeholder="${esc(t('onb.namePh'))}" value="${esc(o.nickname)}" ${o.anonymous ? 'disabled' : ''}>
        <label class="switch-row">
          <span><strong>${t('onb.anon')}</strong><small>${t('onb.anonHint')}</small></span>
          <input type="checkbox" class="switch" data-input="onb-anon" ${o.anonymous ? 'checked' : ''}>
        </label>
        <div class="privacy-note">🔒 ${t('onb.privacy')}</div>
        <div class="btn-row">
          <button class="btn btn-soft" data-action="onb-back">${t('common.back')}</button>
          <button class="btn btn-primary grow" data-action="onb-next">${t('common.next')}</button>
        </div>`;
    } else {
      body = `
        <div class="onb-hero small">${mascot('good', 'mascot-lg')}</div>
        <h1 class="onb-title">${t('onb.cycleTitle')}</h1>
        <p class="onb-sub">${t('onb.cycleSub')}</p>
        <label class="field"><span class="field-label">${t('onb.lastPeriod')}</span>
          <input class="input" type="date" max="${today()}" data-input="onb-last" value="${esc(o.lastPeriod)}"></label>
        <label class="field"><span class="field-label">${t('onb.cycleLen')}</span>
          <input class="input" type="number" inputmode="numeric" min="15" max="120" data-input="onb-len" value="${o.cycleLength}">
          <small class="hint">${t('onb.cycleLenHint')}</small></label>
        <div class="btn-row">
          <button class="btn btn-soft" data-action="onb-back">${t('common.back')}</button>
          <button class="btn btn-primary grow" data-action="onb-finish">${t('onb.finish')} 💖</button>
        </div>
        <p class="fineprint">${t('onb.notMedical')}</p>`;
    }
    return `<section class="onb">${dots}${body}</section>`;
  }

  /* ---- Home ---- */
  function streak() {
    const dates = new Set(state.logs.map(e => e.date));
    let d = today(), n = 0;
    if (!dates.has(d)) d = addDays(d, -1);
    while (dates.has(d)) { n++; d = addDays(d, -1); }
    return n;
  }

  function cycleRing(day, len) {
    const r = 46, c = 2 * Math.PI * r, p = Math.max(0.03, Math.min(1, day / len));
    const g = 'rg' + (++uid);
    return `<div class="ring-wrap">
      <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
        <defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF5C8A"/><stop offset="1" stop-color="#C77DFF"/></linearGradient></defs>
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="#FFE4EC" stroke-width="11"/>
        <circle class="ring-fg" cx="60" cy="60" r="${r}" fill="none" stroke="url(#${g})" stroke-width="11" stroke-linecap="round"
                stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p)).toFixed(1)}" transform="rotate(-90 60 60)"/>
      </svg>
      <div class="ring-center"><small>${t('home.day')}</small><strong>${day}</strong></div>
    </div>`;
  }

  function pickTip(phase) {
    const pool = KB.tips.filter(x => x.phase === phase).concat(KB.tips.filter(x => x.phase === 'any'));
    const d = parseDate(today());
    const dayIdx = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    return pool[dayIdx % pool.length];
  }

  function viewHome() {
    const td = today();
    const mood = state.moods[td] || null;
    const named = !(state.profile.anonymous || !state.profile.nickname);
    const ci = Engine.cycleInfo(state.profile, td, KB);
    const stats = Engine.symptomStats(state.logs);
    const quick = (stats.length ? stats.slice(0, 4).map(s => s.id) : ['cramps', 'fatigue', 'bloating', 'headache'])
      .map(symptomById).filter(Boolean);
    const tip = pickTip(ci.phase);
    const periodToday = state.profile.periodStarts.includes(td);
    const persona = state.profile.demo && PERSONAS.find(p => p.id === state.profile.demo);

    let cycle;
    if (ci.cycleDay) {
      const next = ci.daysToNext > 0 ? t('home.nextIn', { n: ci.daysToNext }) : t('home.nextLate', { n: Math.abs(ci.daysToNext) });
      cycle = `
        <div class="cycle-body">
          ${cycleRing(ci.cycleDay, ci.cycleLength)}
          <div class="cycle-info">
            <span class="phase-pill phase-${ci.phase}">${t('phase.' + ci.phase)}</span>
            <p class="cycle-of">${t('home.ofCycle', { n: ci.cycleLength })}</p>
            <p class="cycle-next">${next}</p>
            <small class="muted">${t('home.estimate')}</small>
          </div>
        </div>`;
    } else {
      cycle = `
        <p class="muted">${t('home.noCycle')}</p>
        <label class="field"><span class="field-label">${t('onb.lastPeriod')}</span>
          <input class="input" type="date" max="${td}" data-input="last-period"></label>`;
    }

    return `
      ${persona ? `<div class="demo-banner"><span>🎬 ${t('home.demoBanner', { name: esc(L(persona.name)) })}</span>
        <button class="link-btn" data-action="open-modal" data-modal="confirm-delete">${t('home.exitDemo')}</button></div>` : ''}
      <section class="hero">
        <div class="hero-mascot">${mascot(mood || 'good', 'mascot-lg')}</div>
        <div class="bubble">
          <h1>${named ? t('home.hello', { name: '<bdi>' + esc(nickname()) + '</bdi>' }) : t('home.helloAnon')}</h1>
          <p>${t('mascot.' + (mood || 'none'))}</p>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">${t('home.moodQ')}</h2>
        ${moodPicker(mood, 'set-mood')}
      </section>

      <button class="cta" data-action="go" data-view="log">
        <span class="cta-plus">${icon('plus')}</span>
        <span class="cta-text"><strong>${t('home.logCta')}</strong><small>${t('home.logSub')}</small></span>
      </button>
      <div class="quick">
        <span class="quick-label">${t('home.quick')}</span>
        ${quick.map(s => `<button class="chip chip-sm" data-action="quick-log" data-id="${s.id}"><span>${s.emoji}</span>${esc(L(s.label))}</button>`).join('')}
      </div>

      ${experimentCard()}
      <section class="card cycle-card">
        <h2 class="card-title">${t('home.cycleTitle')}</h2>
        ${cycle}
        <button class="btn ${periodToday ? 'btn-mint' : 'btn-soft'} btn-block" data-action="period-today" aria-pressed="${periodToday}">
          🩸 ${periodToday ? t('home.periodLogged') + ' ✓' : t('home.periodToday')}
        </button>
      </section>

      <section class="card tip-card">
        <span class="tip-ico">💡</span>
        <div><h2 class="card-title">${t('home.tip')}</h2><p>${esc(L(tip.text))}</p></div>
      </section>

      <section class="stats">
        <div class="stat"><strong>${state.logs.length}</strong><span>${t('home.statsLogs')}</span></div>
        <div class="stat"><strong>${stats.length}</strong><span>${t('home.statsSymptoms')}</span></div>
        <div class="stat"><strong>${streak()}</strong><span>${t('home.statsStreak')}</span></div>
      </section>
      <p class="fineprint">${t('onb.notMedical')}</p>`;
  }

  /* ---- Log ---- */
  function initLogDraft(date, preselect) {
    const d = date || today();
    const existing = state.logs.find(e => e.date === d);
    ui.log = {
      date: d,
      symptoms: existing ? Object.assign({}, existing.symptoms) : {},
      mood: existing ? existing.mood : (state.moods[d] || null),
      note: existing ? L(existing.note) : '',
      // Start on the first category (pain) so the chips, the sliders and Save fit on one
      // screen; "All" and the body map are one tap away.
      region: null, category: KB.categories[0].id, onlyRelated: false,
      editing: !!existing
    };
    const pre = preselect && symptomById(preselect);
    if (pre) {
      if (!(ui.log.symptoms[preselect] > 0)) ui.log.symptoms[preselect] = pre.binary ? 10 : 5;
      ui.log.category = pre.category;
    }
  }

  function bodyMap(active, counts) {
    const cls = id => `region ${active === id ? 'on' : ''} ${counts[id] ? 'has' : ''}`;
    const attrs = id => `class="${cls(id)}" data-action="region" data-region="${id}" role="button" tabindex="0" aria-label="${esc(L(KB.regions.find(r => r.id === id).label))}" aria-pressed="${active === id}"`;
    const badge = (id, x, y) => counts[id] ? `<g class="map-badge" transform="translate(${x} ${y})"><circle r="10"/><text y="4" text-anchor="middle">${counts[id]}</text></g>` : '';
    const hair = '#7A4A5E';
    return `<svg class="bodymap" viewBox="0 0 200 400" role="group" aria-label="${esc(t('log.tapZone'))}">
      <circle cx="100" cy="20" r="14" fill="${hair}"/>
      <path d="M62 62 C58 16 142 16 138 62 C143 88 138 102 132 110 L68 110 C62 102 57 88 62 62Z" fill="${hair}"/>
      <path d="M66 114 Q43 152 48 224" stroke="#FFC2D4" stroke-width="18" stroke-linecap="round" fill="none"/>
      <path d="M134 114 Q157 152 152 224" stroke="#FFC2D4" stroke-width="18" stroke-linecap="round" fill="none"/>
      <rect x="91" y="82" width="18" height="20" rx="6" fill="#FFC2D4"/>
      <circle ${attrs('head')} cx="100" cy="58" r="30"/>
      <path ${attrs('chest')} d="M62 108 Q100 94 138 108 Q140 136 134 160 Q100 168 66 160 Q60 136 62 108Z"/>
      <path ${attrs('belly')} d="M66 160 Q100 168 134 160 Q130 186 136 208 Q100 216 64 208 Q70 186 66 160Z"/>
      <path ${attrs('pelvis')} d="M64 208 Q100 216 136 208 Q148 232 146 256 Q100 268 54 256 Q52 232 64 208Z"/>
      <g ${attrs('legs')}>
        <path d="M54 256 Q78 264 99 262 L93 382 Q82 392 72 382 Z"/>
        <path d="M146 256 Q122 264 101 262 L107 382 Q118 392 128 382 Z"/>
      </g>
      <g class="map-face">
        <path d="M71 54 C73 30 127 30 129 54 C116 43 92 41 71 54Z" fill="${hair}"/>
        <circle cx="89" cy="62" r="2.8" fill="${INK}"/><circle cx="111" cy="62" r="2.8" fill="${INK}"/>
        <path d="M92 71 Q100 78 108 71" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" fill="none"/>
        <ellipse cx="81" cy="69" rx="5" ry="3" fill="#FF5C8A" opacity=".35"/><ellipse cx="119" cy="69" rx="5" ry="3" fill="#FF5C8A" opacity=".35"/>
      </g>
      ${badge('head', 130, 34)}${badge('chest', 140, 118)}${badge('belly', 138, 176)}${badge('pelvis', 148, 226)}${badge('legs', 134, 312)}
    </svg>`;
  }

  function relatedSymptomIds() {
    const ids = new Set();
    state.profile.diagnosed.forEach(cid => {
      const c = conditionById(cid);
      if (c) c.symptoms.forEach(s => ids.add(s.id));
    });
    return ids;
  }

  function viewLog() {
    if (!ui.log) initLogDraft();
    const d = ui.log;
    const related = relatedSymptomIds();
    const selectedIds = Object.keys(d.symptoms);

    const counts = {};
    selectedIds.forEach(id => { const s = symptomById(id); if (s) s.regions.forEach(r => counts[r] = (counts[r] || 0) + 1); });

    let list = KB.symptoms.filter(s =>
      (d.category === 'all' || s.category === d.category) &&
      (!d.region || s.regions.includes(d.region)) &&
      (!d.onlyRelated || !related.size || related.has(s.id) || s.category === 'alert'));
    if (related.size) list = list.slice().sort((a, b) => (related.has(b.id) ? 1 : 0) - (related.has(a.id) ? 1 : 0));

    const bubbles = KB.regions.filter(r => r.emoji).map(r => `
      <button class="zone-bubble ${d.region === r.id ? 'on' : ''} ${counts[r.id] ? 'has' : ''}" data-action="region" data-region="${r.id}" aria-pressed="${d.region === r.id}">
        <span>${r.emoji}</span>${esc(L(r.label))}${counts[r.id] ? `<b>${counts[r.id]}</b>` : ''}
      </button>`).join('');
    const regionLabel = d.region ? L(KB.regions.find(r => r.id === d.region).label) : '';

    const cats = [{ id: 'all', emoji: '🌈', label: t('common.all') }].concat(KB.categories.map(c => ({ id: c.id, emoji: c.emoji, label: L(c.label) })));

    const selected = selectedIds.map(id => {
      const s = symptomById(id); if (!s) return '';
      const v = d.symptoms[id];
      const head = `<div class="sel-head"><span class="sel-name"><span>${s.emoji}</span>${esc(L(s.label))}</span>
        <button class="sel-x" data-action="toggle-symptom" data-id="${id}" aria-label="${esc(t('common.close'))}">${icon('close')}</button></div>`;
      if (s.binary) return `<div class="sel-item binary">${head}<span class="sel-present">✓ ${t('log.present')}</span></div>`;
      return `<div class="sel-item">${head}
        <div class="sel-slider">
          <span class="sel-face" data-face="${id}">${intensityFace(v)}</span>
          <input type="range" min="0" max="10" step="1" value="${v}" data-input="intensity" data-id="${id}" style="--pct:${v * 10}%" aria-label="${esc(L(s.label))}">
          <output data-out="${id}">${v}</output>
        </div>
        <div class="sel-word" data-word="${id}">${intensityWord(v)}</div>
      </div>`;
    }).join('');

    const nSel = selectedIds.filter(id => d.symptoms[id] > 0).length;

    return `
      <header class="page-head">
        <div><h1>${t('log.title')}</h1><p>${t('log.sub')}</p></div>
        <label class="date-pill"><span class="sr-only">${t('log.date')}</span>
          <input type="date" max="${today()}" value="${d.date}" data-input="log-date"></label>
      </header>
      ${d.editing ? `<div class="note-banner">✏️ ${t('log.editing')} · ${esc(friendlyDate(d.date))}</div>` : ''}

      <section class="card map-card">
        <div class="map-wrap">
          ${bodyMap(d.region, counts)}
          <div class="map-side">
            ${bubbles}
            <div class="zone-current">
              ${d.region
                ? `<span class="zone-name">${t('log.zone')} : <strong>${esc(regionLabel)}</strong></span><button class="link-btn" data-action="region" data-region="">${t('log.allZones')}</button>`
                : `<span class="zone-hint">👆 ${t('log.tapZone')}</span>`}
            </div>
          </div>
        </div>
      </section>

      <div class="cat-tabs" role="tablist">
        ${cats.map(c => `<button class="cat-tab ${d.category === c.id ? 'on' : ''}" data-action="category" data-id="${c.id}" role="tab" aria-selected="${d.category === c.id}"><span>${c.emoji}</span>${esc(c.label)}</button>`).join('')}
      </div>

      <div class="chips">
        ${list.length ? list.map(s => {
          const on = d.symptoms[s.id] != null;
          return `<button class="chip ${on ? 'on' : ''} ${s.category === 'alert' ? 'chip-alert' : ''} ${related.has(s.id) ? 'chip-related' : ''}" data-action="toggle-symptom" data-id="${s.id}" aria-pressed="${on}" ${related.has(s.id) ? `title="${esc(t('log.related'))}"` : ''}>
            <span>${s.emoji}</span>${esc(L(s.label))}${related.has(s.id) ? '<i class="star">★</i>' : ''}</button>`;
        }).join('') : `<p class="muted">${t('log.noMatch')}</p>`}
      </div>

      <section class="card">
        <h2 class="card-title">${t('log.selected')}${nSel ? ` <span class="count">${nSel}</span>` : ''}</h2>
        ${selected || `<p class="muted">${t('log.noneSelected')}</p>`}
      </section>

      <section class="card">
        <h2 class="card-title">${t('log.diagnosed')}</h2>
        <p class="muted small">${t('log.diagnosedHint')}</p>
        <div class="chips tight">
          ${KB.conditions.map(c => {
            const on = state.profile.diagnosed.includes(c.id);
            return `<button class="chip chip-dx ${on ? 'on' : ''}" style="--accent:${c.color}" data-action="toggle-diagnosed" data-id="${c.id}" aria-pressed="${on}"><span>${c.emoji}</span>${esc(L(c.shortName))}</button>`;
          }).join('')}
        </div>
        ${state.profile.diagnosed.length ? `<label class="switch-row compact"><span>★ ${t('log.onlyRelated')}</span>
          <input type="checkbox" class="switch" data-input="only-related" ${d.onlyRelated ? 'checked' : ''}></label>` : ''}
      </section>

      <section class="card">
        <h2 class="card-title">${t('log.mood')}</h2>
        ${moodPicker(d.mood, 'log-mood')}
        <label class="field"><span class="field-label">${t('log.note')}</span>
          <textarea class="input" rows="2" maxlength="280" data-input="log-note" placeholder="${esc(t('log.notePh'))}">${esc(d.note)}</textarea></label>
        ${d.editing ? `<button class="link-btn danger" data-action="delete-log">${t('log.delete')}</button>` : ''}
      </section>

      <div class="save-bar">
        <button class="btn btn-primary btn-block btn-lg" data-action="save-log">
          ${d.editing ? t('log.update') : t('log.save')}${nSel ? ` · ${nSel}` : ''} 💖
        </button>
      </div>`;
  }

  /* ---- Insights ---- */
  function evidenceList(cond) {
    const showV = state.settings.showVerification;
    return `<ul class="ev-list">${cond.evidence.map(e => `
      <li class="ev">
        <p>${esc(L(e.statement))}</p>
        <div class="ev-meta">
          <span class="badge badge-src" title="${esc((KB.meta.sources[e.source] || {}).name || e.source)}">${esc(sourceLabel(e.source))}</span>
          <span class="badge badge-lvl">${esc(L(KB.meta.evidenceLevels[e.level]) || e.level)}</span>
          ${showV ? `<span class="badge ${e.verified ? 'badge-ok' : 'badge-warn'}">${e.verified ? '✓ ' + t('ins.verified') : '⚠ ' + t('ins.unverified')}</span>` : ''}
        </div>
        <small class="ev-detail" dir="ltr">${esc(e.sourceDetail)}</small>
      </li>`).join('')}</ul>`;
  }

  /* ---- Prototype v2 additions: signs count, community ranking, narrowing question, one-thing experiments ---- */
  function signsText(res) {
    const c = conditionById(res.id);
    return t('ins.signs', { n: res.contributions.length, m: c.symptoms.length });
  }

  /** The community can reorder approved ideas, never add new ones. */
  function itemStats(itemId) {
    let helped = 0, cards = 0;
    communityCards().forEach(c => {
      if (c.item !== itemId) return;
      cards++;
      if (c.result === 'helped') helped += (c.helped || 1);
    });
    return { helped, cards };
  }

  function activeExperiment() { return state.experiments.find(x => x.status === 'active') || null; }

  /** Average intensity of one symptom on the days it was noted, between two dates (inclusive). */
  function avgSymptom(id, from, to) {
    const vals = state.logs.filter(e => e.date >= from && e.date <= to && e.symptoms[id] > 0).map(e => e.symptoms[id]);
    return vals.length ? mean(vals) : null;
  }

  /** The not-yet-asked symptom that best separates the two leading patterns. */
  function nextQuestion(results, logs) {
    if (results.length < 2) return null;
    const a = conditionById(results[0].id), b = conditionById(results[1].id);
    const logged = new Set();
    logs.forEach(e => Object.keys(e.symptoms).forEach(id => { if (e.symptoms[id] > 0) logged.add(id); }));
    const w = (c, id) => { const s = c.symptoms.find(x => x.id === id); return s ? s.weight : 0; };
    let best = null;
    Array.from(new Set(a.symptoms.concat(b.symptoms).map(s => s.id))).forEach(id => {
      if (logged.has(id) || state.answers[id]) return;
      const diff = Math.abs(w(a, id) - w(b, id));
      if (diff > 0 && (!best || diff > best.diff)) best = { id, diff };
    });
    return best;
  }

  function questionCard(results, logs) {
    const q = nextQuestion(results, logs);
    const no = Object.keys(state.answers).filter(id => state.answers[id] === 'no').map(symptomById).filter(Boolean);
    if (!q && !no.length) return '';
    const sy = q && symptomById(q.id);
    return `<section class="card q-card">
      <h2 class="card-title">🔎 ${t('ins.qTitle')}</h2>
      ${q ? `<p class="q-text">${t('ins.q', { s: '<b>' + sy.emoji + ' ' + esc(L(sy.label)) + '</b>' })}</p>
        <div class="q-btns">
          <button class="btn btn-mint" data-action="answer-q" data-id="${q.id}" data-ans="yes">${t('ins.qYes')}</button>
          <button class="btn btn-soft" data-action="answer-q" data-id="${q.id}" data-ans="no">${t('ins.qNo')}</button>
        </div>
        <small class="muted">${t('ins.qNote')}</small>` : ''}
      ${no.length ? `<p class="muted small">${t('ins.qNoList', { s: no.map(s => esc(L(s.label))).join(', ') })}</p>` : ''}
    </section>`;
  }

  function experimentCard() {
    const x = activeExperiment();
    if (!x) return '';
    const cond = conditionById(x.cond);
    const item = cond && cond.lifestyle.find(l => l.id === x.item);
    const sy = x.symptom ? symptomById(x.symptom) : null;
    const td = today();
    const after = sy ? avgSymptom(x.symptom, x.start, td) : null;
    const val = v => v == null ? '—' : num(v);
    return `<section class="card exp-card">
      <h2 class="card-title">🧪 ${t('exp.title')}</h2>
      <p class="exp-item">${esc(L(item && item.text))}</p>
      <p class="muted small">${t('exp.day', { n: diffDays(td, x.start) + 1 })} · ${t('exp.oneAtATime')}</p>
      ${sy ? `<p>${t('exp.target', { s: sy.emoji + ' ' + esc(L(sy.label)) })}<br>
        <b>${t('exp.before')} ${val(x.baseline)}</b> → <b>${t('exp.now')} ${val(after)}</b></p>` : ''}
      ${x.baseline == null ? `<small class="muted">${t('exp.noBase')}</small>` : ''}
      <h4>${t('exp.finishQ')}</h4>
      <div class="exp-res">${RESULTS.map(r => `<button class="chip chip-sm" data-action="finish-exp" data-res="${r}">${t('com.res.' + r)}</button>`).join('')}</div>
      <button class="link-btn danger" data-action="cancel-exp">${t('exp.cancel')}</button>
    </section>`;
  }

  function experimentHistory() {
    const done = state.experiments.filter(x => x.status === 'done').slice().reverse();
    if (!done.length) return '';
    return `<section class="card"><h2 class="card-title">${t('exp.history')}</h2>
      <ul class="plain">${done.map(x => {
        const cond = conditionById(x.cond), item = cond && cond.lifestyle.find(l => l.id === x.item);
        const sy = x.symptom ? symptomById(x.symptom) : null;
        const change = sy && x.baseline != null && x.after != null ? ` · ${esc(L(sy.label))}: ${num(x.baseline)} → ${num(x.after)}` : '';
        return `<li>${esc(L(item && item.text))} · <span class="res-badge res-${x.result}">${t('com.res.' + x.result)}</span>${change}</li>`;
      }).join('')}</ul></section>`;
  }

  function lifestyleList(cond) {
    const showV = state.settings.showVerification;
    const busy = !!activeExperiment();
    const items = cond.lifestyle.map((l, i) => ({ l, i, st: itemStats(l.id) }))
      .sort((x, y) => y.st.helped - x.st.helped || x.i - y.i);
    return `<ul class="life-list">${items.map(({ l, st }) => `
      <li><span class="life-text">${esc(L(l.text))}</span>
        <span class="life-meta">
          <span class="badge ${l.strength === 'limited' ? 'badge-muted' : 'badge-mint'}">${t('ins.strength.' + l.strength)}</span>
          <span class="badge badge-src">${esc(sourceLabel(l.source))}</span>
          ${st.helped ? `<span class="badge badge-com">👥 ${t('com.helpedN', { n: st.helped })}</span>` : ''}
          ${showV ? `<span class="badge ${l.verified ? 'badge-ok' : 'badge-warn'}">${l.verified ? '✓ ' + t('ins.verified') : '⚠ ' + t('ins.unverified')}</span>` : ''}
        </span>
        <button class="btn btn-soft try-btn" ${busy ? 'disabled' : ''} data-action="start-exp" data-cond="${cond.id}" data-item="${l.id}">🧪 ${t('exp.try')}</button></li>`).join('')}</ul>
      ${busy ? `<small class="muted">${t('exp.busy')}</small>` : ''}`;
  }

  function patternCard(res) {
    const c = conditionById(res.id);
    const pct = Math.round(res.ratio * 100);
    const dx = state.profile.diagnosed.includes(c.id);
    const key = 'pat-' + c.id;
    const contrib = res.contributions.length ? res.contributions.map(k => {
      const s = symptomById(k.id);
      return `<li class="contrib">
        <span class="contrib-name"><span>${s.emoji}</span>${esc(L(s.label))}</span>
        <span class="contrib-meta">${t('ins.avg', { n: num(k.avg) })} · ${t('ins.weight', { n: k.weight })}</span>
        <span class="contrib-pts">+${num(k.points)}</span>
        <span class="contrib-bar"><i style="width:${Math.round(k.points / 3 * 100)}%"></i></span>
      </li>`;
    }).join('') : `<li class="muted">${t('ins.noContrib')}</li>`;
    const rules = res.rules.map(r => `
      <li class="rule ${r.matched ? 'hit' : ''}">
        <span class="rule-ico">${r.matched ? '✓' : '·'}</span>
        <span class="rule-label">${esc(L(r.rule.label))}</span>
        <span class="rule-pts">${r.matched ? '+' + r.rule.points : t('ins.notMatched')}</span>
      </li>`).join('');

    return `<article class="card pattern lvl-${res.level}" style="--accent:${c.color}">
      <header class="pattern-head">
        <span class="pattern-emoji">${c.emoji}</span>
        <div class="pattern-title">
          <h3>${esc(L(c.shortName))}</h3>
          <span class="level-pill">${t('ins.level.' + res.level)}</span>
          ${dx ? `<span class="level-pill dx">✓ ${t('ins.diagnosed')}</span>` : ''}
        </div>
        <strong class="pattern-pct">${res.contributions.length}<small>/${c.symptoms.length}</small></strong>
      </header>
      <div class="meter" role="img" aria-label="${signsText(res)}"><i style="width:${pct}%"></i></div>
      <p class="pattern-points">${t('ins.points', { p: num(res.points), m: res.max })}</p>
      ${dx ? `<p class="dx-note">${t('ins.diagnosedNote')}</p>` : ''}
      <p class="pattern-about">${esc(L(c.about))}</p>

      <h4>${t('ins.contrib')}</h4>
      <ul class="contrib-list">${contrib}</ul>
      ${rules ? `<h4>${t('ins.rules')}</h4><ul class="rule-list">${rules}</ul>` : ''}

      <details class="more" data-key="${key}" ${ui.open[key] ? 'open' : ''}>
        <summary>${t('ins.more')}</summary>
        <h4>${t('ins.evidence')}</h4>
        ${evidenceList(c)}
        <h4>${t('ins.lifestyle')}</h4>
        <p class="muted small">${t('ins.lifestyleNote')}</p>
        <p class="muted small">${t('com.rankNote')}</p>
        ${lifestyleList(c)}
      </details>
      <button class="btn btn-soft btn-block" data-action="go" data-view="doctor">${icon('doctor')} ${t('ins.prepare')}</button>
    </article>`;
  }

  /** Red flags found in recent logs: urgent (last 7 days) and "soon" (last 60 days). */
  function recentFlags() {
    const td = today(), urgent = [], soon = {};
    state.logs.forEach(e => {
      const age = diffDays(td, e.date);
      if (age < 0 || age > 60) return;
      Engine.redFlags(e, KB).forEach(f => {
        if (f.level === 'urgent' && age <= 7) urgent.push({ flag: f, date: e.date });
        if (f.level === 'soon') soon[f.id] = f;
      });
    });
    return { urgent, soon: Object.keys(soon).map(k => soon[k]) };
  }

  function viewInsights() {
    const logs = currentLogs();
    const head = `<header class="page-head">
        <div><h1>${t('ins.title')}</h1><p>${logs.length ? t('ins.sub', { n: logs.length }) : t('ins.window', { n: KB.meta.scoring.windowDays })}</p></div>
        <button class="pill-btn" data-action="open-modal" data-modal="how">${icon('info')} ${t('ins.how')}</button>
      </header>
      <div class="notdx"><span class="notdx-ico">🩺</span><div><strong>${t('ins.notDx')}</strong><p>${t('ins.notDxText')}</p></div></div>`;

    if (!logs.length) {
      return `${head}
        <section class="card empty">
          ${mascot('meh', 'mascot-lg')}
          <h2>${t('ins.empty')}</h2><p class="muted">${t('ins.emptySub')}</p>
          <button class="btn btn-primary" data-action="go" data-view="log">${t('home.logCta')}</button>
          <button class="btn btn-ghost" data-action="open-modal" data-modal="demo">${t('ins.loadDemo')}</button>
        </section>`;
    }

    const results = Engine.scoreAll(logs, state.profile, KB);
    const shown = results.filter(r => r.level !== 'none' || state.profile.diagnosed.includes(r.id));
    const others = results.filter(r => !shown.includes(r));
    const stats = Engine.symptomStats(logs).slice(0, 6);
    const maxDays = stats.length ? stats[0].days : 1;
    const flags = recentFlags();

    return `${head}
      ${flags.urgent.length ? `<button class="alert-banner" data-action="review-urgent">
          <span>🚨</span><span><strong>${t('ins.urgentRecent', { date: esc(friendlyDate(flags.urgent[flags.urgent.length - 1].date)) })}</strong><small>${t('ins.urgentRecentCta')}</small></span>
        </button>` : ''}
      ${flags.soon.length ? `<section class="card soon">
          <h2 class="card-title">📌 ${t('ins.soonTitle')}</h2>
          ${flags.soon.map(f => `<div class="soon-item"><strong>${esc(L(f.title))}</strong><p>${esc(L(f.message))}</p></div>`).join('')}
        </section>` : ''}

      ${experimentCard()}
      ${questionCard(results, logs)}

      <section class="card">
        <h2 class="card-title">${t('ins.top')}</h2>
        <ul class="bars">
          ${stats.map(s => { const sy = symptomById(s.id); return `<li>
            <span class="bar-label"><span>${sy.emoji}</span>${esc(L(sy.label))}</span>
            <span class="bar-track"><i class="${intensityClass(s.avg)}" style="width:${Math.max(8, Math.round(s.days / maxDays * 100))}%"></i></span>
            <span class="bar-val">${t('ins.daysCount', { n: s.days })}${sy.binary ? '' : ' · ' + t('ins.avg', { n: num(s.avg) })}</span></li>`; }).join('')}
        </ul>
        <small class="muted">${t('ins.window', { n: KB.meta.scoring.windowDays })}</small>
      </section>

      <h2 class="section-title">${t('ins.patterns')}</h2>
      ${shown.map(patternCard).join('')}
      ${others.length ? `<section class="card others">
          <h2 class="card-title">${t('ins.others')}</h2>
          ${others.map(r => { const c = conditionById(r.id); return `<div class="other-row"><span>${c.emoji} ${esc(L(c.shortName))}</span><span class="muted">${signsText(r)} · ${t('ins.points', { p: num(r.points), m: r.max })}</span></div>`; }).join('')}
        </section>` : ''}
      ${experimentHistory()}
      <p class="fineprint">${t('how.limit')}</p>`;
  }

  /* ---- Community ---- */
  function communityCards() {
    return state.community.mine.map(c => Object.assign({ mine: true }, c)).concat(COMMUNITY.cards);
  }

  function viewCommunity() {
    const f = ui.com;
    const cards = communityCards().filter(c =>
      (f.condition === 'all' || c.condition === f.condition) &&
      (f.result === 'all' || c.result === f.result) &&
      (f.category === 'all' || c.category === f.category));
    const filterRow = (label, key, opts) => `<div class="filter-row"><span class="filter-label">${label}</span><div class="filter-chips">
        ${opts.map(o => `<button class="chip chip-sm ${f[key] === o.id ? 'on' : ''}" data-action="com-filter" data-key="${key}" data-id="${o.id}" aria-pressed="${f[key] === o.id}">${o.label}</button>`).join('')}
      </div></div>`;
    const all = { id: 'all', label: t('common.all') };

    return `
      <header class="page-head"><div><h1>${t('com.title')}</h1><p>${t('com.sub')}</p></div></header>
      <div class="demo-data"><span class="demo-tag">${t('com.demo')}</span><p>${t('com.demoText')}</p></div>
      <p class="muted small rank-note">${t('com.rankNote')}</p>

      <section class="card filters">
        ${filterRow(t('com.filterCond'), 'condition', [all].concat(KB.conditions.map(c => ({ id: c.id, label: c.emoji + ' ' + esc(L(c.shortName)) }))))}
        ${filterRow(t('com.filterRes'), 'result', [all].concat(RESULTS.map(r => ({ id: r, label: t('com.res.' + r) }))))}
        ${filterRow(t('com.filterCat'), 'category', [all].concat(CATEGORIES.map(r => ({ id: r, label: t('com.cat.' + r) }))))}
      </section>

      <button class="btn btn-primary btn-block" data-action="open-share">${icon('plus')} ${t('com.share')}</button>
      <p class="count-line">${t('com.count', { n: cards.length })}</p>

      ${cards.length ? cards.map(c => {
        const cond = conditionById(c.condition) || KB.conditions[0];
        const liked = !!state.community.helped[c.id];
        const side = L(c.sideEffects);
        return `<article class="card com-card" style="--accent:${cond.color}">
          <header class="com-head">
            <span class="avatar">${c.mine ? '💖' : c.avatar}</span>
            <div class="com-who">
              <strong>${c.mine ? t('com.you') : t('common.anonymous') + ' · ' + t('com.age', { a: c.age })}</strong>
              <small>${c.mine ? '' : t('country.' + c.country) + ' · '}${cond.emoji} ${esc(L(cond.shortName))}</small>
            </div>
            <span class="res-badge res-${c.result}">${t('com.res.' + c.result)}</span>
          </header>
          <div class="com-block"><span class="com-label">${c.mine ? t('com.triedYou') : t('com.tried')}</span><p class="com-tried">${esc(L(c.tried))}</p></div>
          <div class="com-grid">
            <div><span class="com-label">${t('com.duration')}</span><p>${esc(L(c.duration)) || '—'}</p></div>
            <div><span class="com-label">${t('com.filterCat')}</span><p>${t('com.cat.' + c.category)}</p></div>
          </div>
          ${L(c.note) ? `<blockquote>${esc(L(c.note))}</blockquote>` : ''}
          <div class="com-block com-side"><span class="com-label">${t('com.side')}</span><p>${side ? esc(side) : t('com.noSide')}</p></div>
          ${c.item ? `<span class="badge badge-mint">✓ ${t('com.approved')}</span>` : `<p class="muted small">ℹ️ ${t('com.notApproved')}</p>`}
          <footer class="com-foot">
            ${c.mine
              ? `<span class="demo-tag you">${t('com.you')}</span><button class="link-btn danger" data-action="remove-mine" data-id="${c.id}">${t('com.remove')}</button>`
              : `<button class="helped-btn ${liked ? 'on' : ''}" data-action="helped" data-id="${c.id}" aria-pressed="${liked}">${icon('heart')} ${t('com.helpedToo')} · <b>${c.helped + (liked ? 1 : 0)}</b></button>
                 <span class="demo-tag">${t('com.demo')}</span>`}
          </footer>
        </article>`;
      }).join('') : `<section class="card empty"><p class="muted">${t('com.none')}</p></section>`}`;
  }

  /* ---- Doctor ---- */
  function viewDoctor() {
    const logs = currentLogs();
    const results = logs.length ? Engine.scoreAll(logs, state.profile, KB) : [];
    const relevant = KB.conditions
      .map(c => ({ c, r: results.find(x => x.id === c.id) }))
      .filter(x => (x.r && x.r.level !== 'none') || state.profile.diagnosed.includes(x.c.id))
      .sort((a, b) => ((b.r && b.r.ratio) || 0) - ((a.r && a.r.ratio) || 0));
    const stats = Engine.symptomStats(logs).slice(0, 6);
    const ci = Engine.cycleInfo(state.profile, today(), KB);
    const dates = logs.map(e => e.date).sort();
    const q = (key, text) => {
      const off = !!state.doctor.unchecked[key];
      return `<li class="q ${off ? 'off' : ''}"><label><input type="checkbox" data-input="question" data-key="${esc(key)}" ${off ? '' : 'checked'}><span>${esc(text)}</span></label></li>`;
    };

    const questionBlocks = (relevant.length
      ? relevant.map(x => `<h3 class="sub-title" style="--accent:${x.c.color}">${x.c.emoji} ${esc(L(x.c.shortName))}</h3>
          <ul class="q-list">${x.c.doctorQuestions.map((qq, i) => q(x.c.id + ':' + i, L(qq))).join('')}</ul>`).join('')
      : `<h3 class="sub-title">${t('doc.generic')}</h3>
          <ul class="q-list">${KB.genericQuestions.map((qq, i) => q('generic:' + i, L(qq))).join('')}</ul>`)
      + (state.doctor.custom.length ? `<h3 class="sub-title">✍️ ${t('doc.myQuestions')}</h3>
          <ul class="q-list">${state.doctor.custom.map((txt, i) => `<li class="q"><label><input type="checkbox" checked disabled><span>${esc(txt)}</span></label>
            <button class="sel-x no-print" data-action="remove-question" data-i="${i}" aria-label="${esc(t('com.remove'))}">${icon('close')}</button></li>`).join('')}</ul>` : '');

    const exams = relevant.length ? `<section class="card">
        <h2 class="card-title">🔬 ${t('doc.exams')}</h2><p class="muted small">${t('doc.examsHint')}</p>
        ${relevant.map(x => `<h3 class="sub-title" style="--accent:${x.c.color}">${x.c.emoji} ${esc(L(x.c.shortName))}</h3>
          <ul class="exam-list">${x.c.exams.map(e => `<li><strong>${esc(L(e.name))}</strong><span>${esc(L(e.why))}</span></li>`).join('')}</ul>`).join('')}
      </section>` : '';

    const timeline = state.logs.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 80);

    return `
      <header class="page-head no-print">
        <div><h1>${t('doc.title')}</h1><p>${t('doc.sub')}</p></div>
        <button class="pill-btn strong" data-action="print">${icon('print')} ${t('doc.print')}</button>
      </header>
      <p class="muted small no-print">${t('doc.printHint')}</p>

      <div class="print-head print-only">
        <h1>${t('doc.reportTitle')}</h1>
        <p>${t('doc.preparedBy', { name: esc(displayName()), date: fmtDate(today(), { day: 'numeric', month: 'long', year: 'numeric' }) })}</p>
      </div>

      <section class="card summary">
        <h2 class="card-title">📋 ${t('doc.summary')}</h2>
        <dl class="facts">
          <div><dt>${t('doc.period')}</dt><dd>${dates.length ? esc(fmtDate(dates[0], { day: 'numeric', month: 'short', year: 'numeric' })) + ' → ' + esc(fmtDate(dates[dates.length - 1], { day: 'numeric', month: 'short', year: 'numeric' })) + ' · ' + t('doc.entries', { n: logs.length }) : '—'}</dd></div>
          <div><dt>${t('home.cycleTitle')}</dt><dd>${t('doc.cycleAvg', { n: Engine.avgCycleLength(state.profile) })}${ci.lastStart ? '<br>' + t('doc.lastPeriod', { date: esc(fmtDate(ci.lastStart, { day: 'numeric', month: 'long' })) }) : ''}</dd></div>
          ${state.profile.diagnosed.length ? `<div><dt>${t('doc.diagnosed')}</dt><dd>${state.profile.diagnosed.map(id => esc(L(conditionById(id).shortName))).join(', ')}</dd></div>` : ''}
        </dl>
        ${stats.length ? `<h3 class="sub-title">${t('doc.topSymptoms')}</h3>
          <div class="pills">${stats.map(s => { const sy = symptomById(s.id); return `<span class="pill ${intensityClass(s.avg)}">${sy.emoji} ${esc(L(sy.label))} · ${t('ins.daysCount', { n: s.days })}${sy.binary ? '' : ' · ' + t('ins.avg', { n: num(s.avg) })}</span>`; }).join('')}</div>` : ''}
        ${relevant.filter(x => x.r && x.r.level !== 'none').length ? `<h3 class="sub-title">${t('doc.pattern')}</h3>
          <ul class="plain">${relevant.filter(x => x.r && x.r.level !== 'none').map(x => `<li>${x.c.emoji} ${esc(L(x.c.shortName))} · ${t('ins.level.' + x.r.level)} (${signsText(x.r)})</li>`).join('')}</ul>` : ''}
      </section>

      <section class="card">
        <h2 class="card-title">💬 ${t('doc.questions')}</h2><p class="muted small no-print">${t('doc.questionsHint')}</p>
        ${questionBlocks}
        <div class="add-q no-print">
          <input class="input" type="text" maxlength="160" id="custom-q" placeholder="${esc(t('doc.addQPh'))}">
          <button class="btn btn-soft" data-action="add-question">${t('doc.addQ')}</button>
        </div>
      </section>

      ${exams}

      <section class="card">
        <h2 class="card-title">🗓️ ${t('doc.timeline')}</h2>
        ${timeline.length ? `<ol class="timeline">${timeline.map(e => {
          const info = Engine.cycleInfo(state.profile, e.date, KB);
          const moodObj = MOODS.find(m => m.id === e.mood);
          const syms = Object.keys(e.symptoms).map(id => { const sy = symptomById(id); if (!sy) return ''; const v = e.symptoms[id];
            return `<span class="pill ${sy.binary ? 'i-flag' : intensityClass(v)}">${sy.emoji} ${esc(L(sy.label))}${sy.binary ? '' : ' · ' + v}</span>`; }).join('');
          return `<li class="tl-item">
            <div class="tl-date"><strong>${esc(fmtDate(e.date))}</strong>
              ${info.cycleDay ? `<span class="tl-cd">${t('doc.cycleDay', { n: info.cycleDay })}</span>` : ''}
              ${moodObj ? `<span class="tl-mood" title="${esc(t('mood.' + moodObj.id))}">${moodObj.emoji}</span>` : ''}</div>
            <div class="tl-body"><div class="pills">${syms}</div>${L(e.note) ? `<p class="tl-note">“${esc(L(e.note))}”</p>` : ''}</div>
          </li>`; }).join('')}</ol>` : `<p class="muted">${t('doc.noLogs')}</p>`}
      </section>
      <p class="fineprint">${t('doc.footer')}</p>`;
  }

  const VIEW_FN = { home: viewHome, log: viewLog, insights: viewInsights, community: viewCommunity, doctor: viewDoctor };

  function render() {
    document.documentElement.lang = lang();
    document.documentElement.dir = lang() === 'ar' ? 'rtl' : 'ltr';
    const app = $('#app');
    if (!KB) return;
    if (!state.profile.onboarded) {
      app.dataset.view = 'onboarding';
      $('#topbar').innerHTML = '';
      $('#tabbar').innerHTML = '';
      $('#view').innerHTML = viewOnboarding();
      return;
    }
    app.dataset.view = ui.view;
    $('#topbar').innerHTML = topbar();
    $('#tabbar').innerHTML = tabbar();
    $('#view').innerHTML = VIEW_FN[ui.view]();
  }

  function go(view, opts) {
    if (!VIEWS.includes(view)) view = 'home';
    if (view === 'log' && !(opts && opts.keepDraft)) initLogDraft();
    ui.view = view;
    if (location.hash !== '#/' + view) {
      try { history.replaceState(null, '', '#/' + view); } catch (e) { location.hash = '#/' + view; }
    }
    render();
    const v = $('#view');
    v.classList.remove('enter');
    void v.offsetWidth;                 // restart the entrance animation
    v.classList.add('enter');
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ 8 */
  const MODALS = {
    settings() {
      const p = state.profile;
      const last = p.periodStarts.slice().sort().pop() || '';
      return { title: t('set.title'), body: `
        <h3 class="sheet-h">${t('set.profile')}</h3>
        <label class="field"><span class="field-label">${t('set.nickname')}</span>
          <input class="input" type="text" maxlength="24" data-input="set-nickname" value="${esc(p.nickname)}" ${p.anonymous ? 'disabled' : ''} placeholder="${esc(t('onb.namePh'))}"></label>
        <label class="switch-row compact"><span>${t('onb.anon')}</span><input type="checkbox" class="switch" data-input="set-anon" ${p.anonymous ? 'checked' : ''}></label>

        <h3 class="sheet-h">${t('common.language')}</h3>
        <div class="lang-big row">${Object.keys(LANG_NAMES).map(l => `<button class="lang-opt ${l === lang() ? 'on' : ''}" data-action="lang" data-lang="${l}">${LANG_NAMES[l]}</button>`).join('')}</div>

        <h3 class="sheet-h">${t('set.cycle')}</h3>
        <div class="two">
          <label class="field"><span class="field-label">${t('onb.lastPeriod')}</span>
            <input class="input" type="date" max="${today()}" data-input="last-period" value="${last}"></label>
          <label class="field"><span class="field-label">${t('onb.cycleLen')}</span>
            <input class="input" type="number" min="15" max="120" data-input="set-len" value="${p.cycleLength}"></label>
        </div>

        <h3 class="sheet-h">🎬 ${t('set.demo')}</h3>
        <p class="muted small">${t('set.demoSub')}</p>
        ${personaCards()}

        <button class="btn btn-soft btn-block" data-action="open-modal" data-modal="how">${icon('info')} ${t('how.title')}</button>

        <h3 class="sheet-h">🛠️ ${t('set.dev')}</h3>
        <label class="switch-row compact"><span><strong>${t('set.showVerif')}</strong><small>${t('set.showVerifHint')}</small></span>
          <input type="checkbox" class="switch" data-input="set-verif" ${state.settings.showVerification ? 'checked' : ''}></label>

        <h3 class="sheet-h">🔒 ${t('set.data')}</h3>
        <p class="muted small">${t('set.local')}</p>
        <button class="btn btn-danger btn-block" data-action="open-modal" data-modal="confirm-delete">${t('set.delete')}</button>
        <p class="fineprint">${t('set.about')}<br>Sehhati v${esc(KB.meta.version)}</p>` };
    },

    demo() {
      return { title: '🎬 ' + t('set.demo'), body: `<p class="muted small">${t('set.demoSub')}</p>${personaCards()}` };
    },

    how() {
      const sc = KB.meta.scoring;
      const pc = id => Math.round(sc.levels.find(l => l.id === id).min * 100);
      const step = (n, title, text) => `<div class="how-step"><span class="how-n">${n}</span><div><strong>${title}</strong><p>${text}</p></div></div>`;
      const weights = KB.conditions.map(c => `
        <h4 style="--accent:${c.color}" class="sub-title">${c.emoji} ${esc(L(c.shortName))}</h4>
        <ul class="weights">
          ${c.symptoms.map(ws => { const s = symptomById(ws.id); return `<li><span>${s.emoji} ${esc(L(s.label))}</span><b>${ws.weight}</b></li>`; }).join('')}
          ${(c.rules || []).map(r => `<li class="bonus"><span>⏱️ ${t('how.bonus')} : ${esc(L(r.label))}</span><b>+${r.points}</b></li>`).join('')}
        </ul>`).join('');
      return { title: t('how.title'), body: `
        <p class="lead">${t('how.intro')}</p>
        ${step(1, t('how.s1t'), t('how.s1'))}
        ${step(2, t('how.s2t'), t('how.s2'))}
        ${step(3, t('how.s3t'), t('how.s3'))}
        ${step(4, t('how.s4t'), t('how.s4', { n: sc.windowDays, a: pc('strong'), b: pc('moderate'), c: pc('low') }))}
        ${step(5, t('how.s5t'), t('how.s5'))}
        ${step(6, t('how.s6t'), t('how.s6'))}
        <details class="more" data-key="how-weights" ${ui.open['how-weights'] ? 'open' : ''}><summary>${t('how.weights')}</summary>${weights}</details>
        <p class="fineprint">${t('how.limit')}</p>` };
    },

    'confirm-delete'() {
      return { title: t('set.deleteQ'), cls: 'small', body: `
        <div class="center">${mascot('low', 'mascot-md')}</div>
        <p class="center">${t('set.deleteText')}</p>
        <div class="btn-row">
          <button class="btn btn-soft grow" data-action="close-modal">${t('common.cancel')}</button>
          <button class="btn btn-danger grow" data-action="delete-all">${t('set.deleteYes')}</button>
        </div>` };
    },

    saved() {
      return { title: '', cls: 'small celebrate', body: `
        <div class="center">${mascot('great', 'mascot-lg')}</div>
        <h2 class="center">${t('log.saved')}</h2>
        <p class="center muted">${t('log.savedSub')}</p>
        <button class="btn btn-primary btn-block" data-action="go" data-view="insights">${t('log.seeInsights')}</button>
        <button class="btn btn-ghost btn-block" data-action="close-modal">${t('common.close')}</button>` };
    },

    urgent(args) {
      const all = Engine.redFlagRules(KB);
      const flags = (args.ids || []).map(id => all.find(f => f.id === id)).filter(Boolean);
      const onlySupport = flags.length && flags.every(f => f.kind === 'support');
      return { cls: 'urgent', raw: true, body: `
        <div class="urgent-screen" role="alertdialog" aria-labelledby="urg-title">
          <div class="urgent-ico">${onlySupport ? '🫂' : '🚨'}</div>
          <h1 id="urg-title">${onlySupport ? t('urg.supportTitle') : t('urg.title')}</h1>
          <p class="urgent-sub">${t('urg.sub')}</p>
          <ul class="urgent-list">${flags.map(f => `<li><strong>${esc(L(f.title))}</strong><p>${esc(L(f.message))}</p></li>`).join('')}</ul>
          <p class="urgent-do">${t('urg.do')}</p>
          <a class="btn btn-white btn-block btn-lg" href="tel:141">📞 ${t('urg.call141')}</a>
          <a class="btn btn-outline-white btn-block" href="tel:15">📞 ${t('urg.call15')}</a>
          <p class="urgent-local">${t('urg.local')}</p>
          <button class="btn btn-outline-white btn-block" data-action="close-modal">${t('urg.ok')}</button>
          <p class="urgent-foot">${args.justSaved ? t('urg.saved') + ' ' : ''}${t('urg.disclaimer')}</p>
        </div>` };
    },

    share() {
      const s = ui.share;
      const opt = (v, label, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
      return { title: t('com.share'), body: `
        <p class="muted small">🔒 ${t('com.shareSub')}</p>
        <label class="field"><span class="field-label">${t('com.f.condition')}</span>
          <select class="input" data-input="share" data-key="condition">${KB.conditions.map(c => opt(c.id, c.emoji + ' ' + esc(L(c.shortName)), s.condition)).join('')}</select></label>
        <label class="field"><span class="field-label">${t('com.f.tried')}</span>
          <textarea class="input" rows="2" maxlength="200" data-input="share" data-key="tried" placeholder="${esc(t('com.f.triedPh'))}">${esc(s.tried)}</textarea></label>
        <div class="two">
          <label class="field"><span class="field-label">${t('com.f.category')}</span>
            <select class="input" data-input="share" data-key="category">${CATEGORIES.map(c => opt(c, t('com.cat.' + c), s.category)).join('')}</select></label>
          <label class="field"><span class="field-label">${t('com.f.duration')}</span>
            <input class="input" type="text" maxlength="40" data-input="share" data-key="duration" value="${esc(s.duration)}" placeholder="${esc(t('com.f.durationPh'))}"></label>
        </div>
        <label class="field"><span class="field-label">${t('com.f.result')}</span>
          <select class="input" data-input="share" data-key="result">${RESULTS.map(r => opt(r, t('com.res.' + r), s.result)).join('')}</select></label>
        <label class="field"><span class="field-label">${t('com.f.side')}</span>
          <input class="input" type="text" maxlength="120" data-input="share" data-key="sideEffects" value="${esc(s.sideEffects)}" placeholder="${esc(t('com.f.sidePh'))}"></label>
        <button class="btn btn-primary btn-block" data-action="publish-share">${t('com.publish')}</button>
        <p class="fineprint">${t('com.demoText')}</p>` };
    }
  };

  function openModal(name, args) { ui.modal = { name, args: args || {} }; renderModal(); }
  function closeModal() { ui.modal = null; renderModal(); }
  function renderModal() {
    const root = $('#overlay-root');
    if (!ui.modal || !MODALS[ui.modal.name]) {
      root.innerHTML = '';
      document.body.classList.remove('modal-open');
      return;
    }
    const keepScroll = $('.sheet-body', root) ? $('.sheet-body', root).scrollTop : 0;
    const sameModal = root.firstElementChild && root.firstElementChild.dataset.modal === ui.modal.name;
    const m = MODALS[ui.modal.name](ui.modal.args);
    root.innerHTML = m.raw
      ? `<div class="overlay ${m.cls || ''}" data-modal="${ui.modal.name}">${m.body}</div>`
      : `<div class="overlay ${m.cls || ''} ${sameModal ? 'still' : ''}" data-modal="${ui.modal.name}" data-action="backdrop">
          <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(m.title || 'Sehhati')}">
            <div class="sheet-head"><h2>${m.title || ''}</h2>
              <button class="icon-btn" data-action="close-modal" aria-label="${esc(t('common.close'))}">${icon('close')}</button></div>
            <div class="sheet-body">${m.body}</div>
          </div></div>`;
    document.body.classList.add('modal-open');
    if (sameModal && $('.sheet-body', root)) $('.sheet-body', root).scrollTop = keepScroll;
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('#toast-root').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2400);
    setTimeout(() => el.remove(), 2900);
  }

  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = $('#confetti');
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#FF5C8A', '#FF8FB1', '#C77DFF', '#5ED6B5', '#FFD166', '#FFB3C8'];
    const parts = [];
    for (let i = 0; i < 90; i++) {
      parts.push({
        x: W / 2 + (Math.random() - 0.5) * 140, y: H * 0.6,
        vx: (Math.random() - 0.5) * 12, vy: -(7 + Math.random() * 10),
        s: 5 + Math.random() * 7, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
        c: colors[i % colors.length], shape: i % 3
      });
    }
    const DURATION = 1900;
    const start = performance.now();
    canvas.classList.add('on');
    (function frame(now) {
      const el = now - start;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = Math.max(0, 1 - Math.pow(el / DURATION, 3));
      for (const p of parts) {
        p.vy += 0.34; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        if (p.shape === 0) ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s / 1.5);
        else if (p.shape === 1) { ctx.beginPath(); ctx.arc(0, 0, p.s / 2.2, 0, 6.29); ctx.fill(); }
        else {                                         // little heart
          const s = p.s * 0.8;
          ctx.beginPath(); ctx.moveTo(0, s * 0.5);
          ctx.bezierCurveTo(-s * 1.2, -s * 0.3, -s * 0.5, -s * 1.1, 0, -s * 0.35);
          ctx.bezierCurveTo(s * 0.5, -s * 1.1, s * 1.2, -s * 0.3, 0, s * 0.5);
          ctx.fill();
        }
        ctx.restore();
      }
      if (el < DURATION) requestAnimationFrame(frame);
      else { ctx.clearRect(0, 0, W, H); canvas.classList.remove('on'); }
    })(start);
  }

  /* ------------------------------------------------------------------ 9 */
  function setLastPeriod(value) {
    if (!value || value > today()) return;
    const ps = state.profile.periodStarts.slice().sort();
    const last = ps[ps.length - 1];
    if (last && Math.abs(diffDays(value, last)) <= 10) ps[ps.length - 1] = value;   // correcting the latest date
    else if (!ps.includes(value)) ps.push(value);
    state.profile.periodStarts = Array.from(new Set(ps)).sort();
    persist();
  }

  function saveLog() {
    const d = ui.log;
    const symptoms = {};
    for (const id in d.symptoms) if (d.symptoms[id] > 0) symptoms[id] = d.symptoms[id];
    const note = (d.note || '').trim();
    if (!Object.keys(symptoms).length && !d.mood && !note) { toast(t('log.empty')); return; }
    const entry = { id: 'l' + Date.now(), date: d.date, symptoms, mood: d.mood || null, note, ts: Date.now() };
    state.logs = state.logs.filter(e => e.date !== d.date);
    state.logs.push(entry);
    state.logs.sort((a, b) => a.date.localeCompare(b.date));
    if (d.mood) state.moods[d.date] = d.mood;
    persist();
    d.symptoms = Object.assign({}, symptoms);
    d.editing = true;
    render();
    const urgent = Engine.redFlags(entry, KB).filter(f => f.level === 'urgent');
    if (urgent.length) openModal('urgent', { ids: urgent.map(f => f.id), justSaved: true });
    else { openModal('saved'); confetti(); }
  }

  const actions = {
    go(el) { closeModal(); go(el.dataset.view); },
    lang(el) {
      state.profile.lang = el.dataset.lang;
      persist(); render(); renderModal();
    },
    'open-modal'(el) { openModal(el.dataset.modal); },
    'close-modal'() { closeModal(); },
    backdrop(el, e) { if (e.target === el) closeModal(); },

    'onb-next'() { ui.onb.step = Math.min(2, ui.onb.step + 1); render(); window.scrollTo(0, 0); },
    'onb-back'() { ui.onb.step = Math.max(0, ui.onb.step - 1); render(); },
    'onb-finish'() {
      const o = ui.onb, p = state.profile;
      p.nickname = o.anonymous ? '' : o.nickname.trim();
      p.anonymous = o.anonymous || !p.nickname;
      p.cycleLength = Math.max(15, Math.min(120, parseInt(o.cycleLength, 10) || 28));
      if (o.lastPeriod && o.lastPeriod <= today()) p.periodStarts = [o.lastPeriod];
      p.onboarded = true;
      persist();
      go('home');
      confetti();
    },
    'load-persona'(el) { loadPersona(el.dataset.id); },

    'set-mood'(el) {
      const td = today(), m = el.dataset.mood;
      if (state.moods[td] === m) delete state.moods[td]; else state.moods[td] = m;
      const entry = state.logs.find(e => e.date === td);
      if (entry) entry.mood = state.moods[td] || null;
      persist(); render();
    },
    'period-today'() {
      const td = today(), ps = state.profile.periodStarts;
      state.profile.periodStarts = ps.includes(td) ? ps.filter(x => x !== td) : ps.concat(td).sort();
      persist(); render();
    },
    'quick-log'(el) { initLogDraft(today(), el.dataset.id); go('log', { keepDraft: true }); },

    region(el) {
      const r = el.dataset.region || null;
      ui.log.region = ui.log.region === r ? null : r;
      if (ui.log.region) ui.log.category = 'all';      // a zone shows every kind of symptom it has
      render();
    },
    category(el) { ui.log.category = el.dataset.id; render(); },
    'toggle-symptom'(el) {
      const id = el.dataset.id, d = ui.log;
      if (d.symptoms[id] != null) delete d.symptoms[id];
      else d.symptoms[id] = symptomById(id).binary ? 10 : 5;
      render();
    },
    'toggle-diagnosed'(el) {
      const id = el.dataset.id, dx = state.profile.diagnosed;
      state.profile.diagnosed = dx.includes(id) ? dx.filter(x => x !== id) : dx.concat(id);
      if (!state.profile.diagnosed.length && ui.log) ui.log.onlyRelated = false;
      persist(); render();
    },
    'log-mood'(el) { ui.log.mood = ui.log.mood === el.dataset.mood ? null : el.dataset.mood; render(); },
    'save-log'() { saveLog(); },
    'delete-log'() {
      const date = ui.log.date;
      state.logs = state.logs.filter(e => e.date !== date);
      delete state.moods[date];
      persist(); initLogDraft(date); render(); toast(t('log.deleted'));
    },

    'review-urgent'() {
      const f = recentFlags().urgent;
      if (f.length) openModal('urgent', { ids: Array.from(new Set(f.map(x => x.flag.id))) });
    },

    'answer-q'(el) {
      const id = el.dataset.id, yes = el.dataset.ans === 'yes';
      state.answers[id] = yes ? 'yes' : 'no';
      if (yes) {
        const td = today();
        let entry = state.logs.find(e => e.date === td);
        if (!entry) {
          entry = { id: 'l' + Date.now(), date: td, symptoms: {}, mood: state.moods[td] || null, note: '', ts: Date.now() };
          state.logs.push(entry);
          state.logs.sort((x, y) => x.date.localeCompare(y.date));
        }
        entry.symptoms[id] = symptomById(id).binary ? 10 : 5;
      }
      persist(); render();
    },
    'start-exp'(el) {
      if (activeExperiment()) return;
      const cond = el.dataset.cond, item = el.dataset.item, td = today();
      const res = Engine.scoreAll(currentLogs(), state.profile, KB).find(r => r.id === cond);
      let symptom = res && res.contributions.length ? res.contributions[0].id : null;
      if (!symptom) { const st = Engine.symptomStats(state.logs); symptom = st.length ? st[0].id : null; }
      const baseline = symptom ? avgSymptom(symptom, addDays(td, -28), addDays(td, -1)) : null;
      state.experiments.push({ id: 'x' + Date.now(), cond, item, symptom, start: td, baseline, status: 'active' });
      persist(); go('insights'); toast(t('exp.started'));
    },
    'finish-exp'(el) {
      const x = activeExperiment();
      if (!x) return;
      const td = today(), result = el.dataset.res;
      x.status = 'done'; x.end = td; x.result = result;
      x.after = x.symptom ? avgSymptom(x.symptom, x.start, td) : null;
      const cond = conditionById(x.cond), item = cond.lifestyle.find(l => l.id === x.item);
      const n = Math.max(1, diffDays(td, x.start) + 1), days = {};
      ['fr', 'ar', 'en'].forEach(l => { days[l] = ((I18N[l] || {})['exp.days'] || '{n}').replace('{n}', n); });
      state.community.mine.unshift({ id: 'me' + Date.now(), condition: x.cond, category: 'lifestyle', result, item: x.item,
        tried: item.text, duration: days, sideEffects: '', note: '' });
      persist(); render(); toast(t('exp.finished'));
    },
    'cancel-exp'() {
      state.experiments = state.experiments.filter(x => x.status !== 'active');
      persist(); render();
    },

    'com-filter'(el) { ui.com[el.dataset.key] = el.dataset.id; render(); },
    helped(el) {
      const id = el.dataset.id, h = state.community.helped;
      if (h[id]) delete h[id]; else h[id] = true;
      persist(); render();
      const btn = $(`.helped-btn[data-id="${id}"]`);
      if (btn && h[id]) btn.classList.add('pop');
    },
    'open-share'() {
      ui.share = { condition: state.profile.diagnosed[0] || (ui.com.condition !== 'all' ? ui.com.condition : KB.conditions[0].id), tried: '', category: 'lifestyle', duration: '', result: 'helped', sideEffects: '' };
      openModal('share');
    },
    'publish-share'() {
      const s = ui.share;
      if (!s.tried.trim()) { toast(t('com.needTried')); return; }
      state.community.mine.unshift({
        id: 'me' + Date.now(), condition: s.condition, category: s.category, result: s.result,
        tried: s.tried.trim(), duration: s.duration.trim(), sideEffects: s.sideEffects.trim(), note: ''
      });
      persist(); closeModal(); render(); confetti(); toast(t('com.thanks'));
    },
    'remove-mine'(el) {
      state.community.mine = state.community.mine.filter(c => c.id !== el.dataset.id);
      persist(); render();
    },

    'add-question'() {
      const input = $('#custom-q');
      const v = input ? input.value.trim() : '';
      if (!v) return;
      state.doctor.custom.push(v);
      persist(); render();
    },
    'remove-question'(el) { state.doctor.custom.splice(Number(el.dataset.i), 1); persist(); render(); },
    print() { window.print(); },

    'delete-all'() {
      const keepLang = state.profile.lang;
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
      state = defaultState();
      state.profile.lang = keepLang;
      ui.log = null; ui.open = {}; ui.modal = null;
      ui.onb = { step: 0, nickname: '', anonymous: false, lastPeriod: '', cycleLength: 28 };
      ui.view = 'home';
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// */ }
      renderModal(); render(); window.scrollTo(0, 0);
      toast(t('set.deleted'));
    }
  };

  const inputs = {
    'onb-nickname'(el) { ui.onb.nickname = el.value; },
    'onb-anon'(el) { ui.onb.anonymous = el.checked; render(); },
    'onb-last'(el) { ui.onb.lastPeriod = el.value; },
    'onb-len'(el) { ui.onb.cycleLength = el.value; },

    intensity(el) {
      const id = el.dataset.id, v = Number(el.value);
      ui.log.symptoms[id] = v;
      el.style.setProperty('--pct', (v * 10) + '%');
      const set = (sel, txt) => { const n = $(sel); if (n) n.textContent = txt; };
      set(`[data-face="${id}"]`, intensityFace(v));
      set(`[data-out="${id}"]`, v);
      set(`[data-word="${id}"]`, intensityWord(v));
    },
    'log-note'(el) { ui.log.note = el.value; },
    'log-date'(el, type) {
      if (type !== 'change' || !el.value || el.value > today()) return;
      initLogDraft(el.value); render();
    },
    'only-related'(el) { ui.log.onlyRelated = el.checked; render(); },

    'last-period'(el, type) {
      if (type !== 'change') return;
      setLastPeriod(el.value); render(); if (ui.modal) renderModal();
    },
    'set-nickname'(el, type) {
      state.profile.nickname = el.value.trim(); persist();
      if (type === 'change') render();
    },
    'set-anon'(el) { state.profile.anonymous = el.checked; persist(); render(); renderModal(); },
    'set-len'(el, type) {
      if (type !== 'change') return;
      state.profile.cycleLength = Math.max(15, Math.min(120, parseInt(el.value, 10) || 28));
      persist(); render(); renderModal();
    },
    'set-verif'(el) { state.settings.showVerification = el.checked; persist(); render(); },

    question(el) {
      const key = el.dataset.key;
      if (el.checked) delete state.doctor.unchecked[key]; else state.doctor.unchecked[key] = true;
      persist();
      const li = el.closest('.q'); if (li) li.classList.toggle('off', !el.checked);
    },
    share(el) { ui.share[el.dataset.key] = el.value; }
  };

  function bindEvents() {
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const fn = actions[el.dataset.action];
      if (fn) fn(el, e);
    });
    const onInput = e => {
      const el = e.target.closest && e.target.closest('[data-input]');
      if (!el) return;
      const fn = inputs[el.dataset.input];
      if (fn) fn(el, e.type);
    };
    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && ui.modal) closeModal();
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.region')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      if (e.key === 'Enter' && e.target.id === 'custom-q') actions['add-question']();
    });
    // <details> state survives re-renders
    document.addEventListener('toggle', e => {
      const d = e.target;
      if (d && d.dataset && d.dataset.key) ui.open[d.dataset.key] = d.open;
    }, true);
    window.addEventListener('hashchange', () => {
      const v = location.hash.replace('#/', '');
      if (state.profile.onboarded && VIEWS.includes(v) && v !== ui.view) go(v);
    });
  }

  /* ------------------------------------------------------------------ 10 */
  async function loadData() {
    const embedded = window.SEHHATI_DATA || null;
    if (location.protocol !== 'file:') {
      try {
        const [k, c] = await Promise.all([
          fetch('data/knowledge.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
          fetch('data/community.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        ]);
        return { knowledge: k, community: c };
      } catch (e) {
        if (!embedded) throw e;
      }
    }
    if (!embedded) throw new Error('No data available');
    return embedded;
  }

  async function boot() {
    bindEvents();
    try {
      const data = await loadData();
      KB = data.knowledge;
      COMMUNITY = data.community;
    } catch (e) {
      $('#view').innerHTML = `<div class="boot"><p>${esc(t('common.loadError'))}</p></div>`;
      return;
    }
    const v = location.hash.replace('#/', '');
    ui.view = VIEWS.includes(v) ? v : 'home';
    if (ui.view === 'log') initLogDraft();
    render();
    $('#view').classList.add('enter');
  }

  // Small surface for console testing and automated checks.
  window.Sehhati = {
    Engine, PERSONAS, buildPersona, loadPersona, go,
    get state() { return state; },
    get kb() { return KB; },
    get community() { return COMMUNITY; },
    ready: null
  };
  window.Sehhati.ready = boot();
})();
