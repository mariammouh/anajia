/* Anajia end-to-end check — drives the real app in headless Chrome/Edge over the
   DevTools protocol. No dependencies: needs Node 22+ and Python 3 (for the static server).

     node tests/e2e.mjs [outputDir]

   Set CHROME=/path/to/chrome if the browser is not found automatically.
   Exits with code 1 if any check fails or the page logs a console error. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(tmpdir(), 'anajia-e2e'));
const PORT = 8765, DEBUG_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
mkdirSync(OUT, { recursive: true });

const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(p => existsSync(p));
if (!CHROME) { console.error('No Chrome/Edge found. Set CHROME=/path/to/browser'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Drops network-level errors caused by a stalled dev-server response; keeps real page errors.
const serverHiccups = list => { const keep = list.filter(e => !/ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_CONNECTION_REFUSED/.test(e)); list.splice(0, list.length, ...keep); return keep.length; };
const results = [];
const consoleErrors = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  PASS' : '✗ FAIL'}  ${name}${detail !== undefined ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

const profileDir = path.join(OUT, 'chrome-profile');
rmSync(profileDir, { recursive: true, force: true });
const server = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=360,780', 'about:blank'
], { stdio: 'ignore' });

let exitCode = 1;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch { /* browser still starting */ }
  }
  if (!target) throw new Error('Could not connect to the browser');
  let serverUp = false;
  for (let i = 0; i < 60 && !serverUp; i++) {
    // Plain TCP probe: no HTTP request, so nothing lingers on python's simple server.
    serverUp = await new Promise(res => {
      const s = net.connect(PORT, '127.0.0.1');
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
    });
    if (!serverUp) await sleep(250);
  }
  if (!serverUp) throw new Error('Static server did not start on port ' + PORT);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleErrors.push('EXCEPTION: ' + ((d.exception && d.exception.description) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      consoleErrors.push('console.error: ' + m.params.args.map(a => a.value || a.description).join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const e = m.params.entry;
      if (!/fonts\.(googleapis|gstatic)\.com/.test(e.url || '')) consoleErrors.push(`log: ${e.text} ${e.url || ''}`);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text) + '\n  in: ' + expr.slice(0, 160));
    return r.result.value;
  };
  const click = sel => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('not found: ' + ${JSON.stringify(sel)}); el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);
  const count = sel => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
  const setInput = (sel, value, type = 'input') => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('not found: ' + ${JSON.stringify(sel)});
      if (el.type === 'checkbox') el.checked = ${JSON.stringify(value)}; else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event(${JSON.stringify(type)}, { bubbles: true })); return true; })()`);
  const overflow = () => ev('document.documentElement.scrollWidth - window.innerWidth');
  const goto = async url => {
    // python's http.server occasionally stalls a response under headless Chrome on Windows:
    // retry the navigation rather than fail the whole run on a dev-server hiccup.
    for (let attempt = 1; attempt <= 4; attempt++) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try { if (await ev(`location.href.split('#')[0] === ${JSON.stringify(url.split('#')[0])} && !!(window.Anajia && window.Anajia.kb)`)) return; } catch { /* navigating */ }
      }
      console.log(`  (boot attempt ${attempt} timed out, retrying)`);
      consoleErrors.length = serverHiccups(consoleErrors);
    }
    throw new Error('App did not boot at ' + url);
  };
  const shot = async (name, full = true) => {
    await sleep(350);
    const params = { format: 'png' };
    if (full) {
      const m = await send('Page.getLayoutMetrics');
      const h = Math.min(Math.ceil(m.cssContentSize.height), 5200);
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: 360, height: h, scale: 1 };
    }
    const r = await send('Page.captureScreenshot', params);
    writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  };

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });

  /* ---------------- 1. first run + onboarding ---------------- */
  console.log('\n# Onboarding');
  await goto(BASE);
  check('boots over http and reads the JSON files', await ev('Anajia.kb.conditions.length === 3 && Anajia.community.cards.length'), await ev('Anajia.community.cards.length') + ' community cards');
  check('onboarding shown on first run, French by default', await ev('document.querySelector("#app").dataset.view === "onboarding" && document.documentElement.lang === "fr"'));
  check('no horizontal overflow at 360px (onboarding)', (await overflow()) <= 0, await overflow());
  await shot('01-onboarding-welcome');
  await click('[data-action="onb-next"]');
  await setInput('[data-input="onb-nickname"]', 'Yasmine');
  await shot('02-onboarding-name');
  await click('[data-action="onb-next"]');
  const tenDaysAgo = await ev('(() => { const d = new Date(); d.setDate(d.getDate() - 10); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()');
  await setInput('[data-input="onb-last"]', tenDaysAgo);
  await setInput('[data-input="onb-len"]', '29');
  await shot('03-onboarding-cycle');
  await click('[data-action="onb-finish"]');
  check('onboarding completes to Home', await ev('Anajia.state.profile.onboarded && document.querySelector("#app").dataset.view === "home"'));
  check('nickname and cycle saved', await ev('Anajia.state.profile.nickname === "Yasmine" && Anajia.state.profile.cycleLength === 29 && Anajia.state.profile.periodStarts.length === 1'));
  check('home greets by nickname and shows cycle day 11', (await text('.bubble h1')).includes('Yasmine') && (await text('.ring-center strong')) === '11', await text('.ring-center strong'));
  check('data persisted in localStorage', await ev('JSON.parse(localStorage.getItem("anajia.v1")).profile.nickname === "Yasmine"'));

  /* ---------------- 2. mood + mascot ---------------- */
  console.log('\n# Home');
  await click('[data-action="set-mood"][data-mood="rough"]');
  check('mascot reacts to mood', await count('.hero .mascot--rough') === 1);
  await click('[data-action="set-mood"][data-mood="great"]');
  check('mood stored for today', await ev('Object.values(Anajia.state.moods)[0] === "great"') && await count('.hero .mascot--great') === 1);
  await shot('04-home-new-user');

  /* ---------------- 3. log in 3 taps ---------------- */
  console.log('\n# Log (3 taps)');
  await click('.tab[data-view="log"]');                                   // tap 1
  await click('.chip[data-action="toggle-symptom"][data-id="cramps"]');   // tap 2
  await click('[data-action="save-log"]');                                // tap 3
  check('logged in 3 taps (tab → chip → save)', await ev('(() => { const l = Anajia.state.logs; return l.length === 1 && l[0].symptoms.cramps === 5; })()'));
  check('"saved" celebration shown, no urgent screen', await count('.overlay.celebrate') === 1 && await count('.overlay.urgent') === 0);
  await shot('05-log-saved', false);
  await click('[data-action="close-modal"]');

  // body map + intensity slider
  await click('.region[data-region="pelvis"]');
  const pelvisChips = await count('.chips .chip[data-action="toggle-symptom"]');
  check('body map filters symptoms by zone', pelvisChips > 3 && pelvisChips < 36, pelvisChips + ' chips for pelvis');
  await setInput('[data-input="intensity"][data-id="cramps"]', '9');
  check('intensity slider updates emoji + value live', (await text('[data-face="cramps"]')) === '😭' && (await text('[data-out="cramps"]')) === '9');
  await click('.chip[data-action="toggle-symptom"][data-id="heavy_bleeding"]');
  const badges = await ev('Array.from(document.querySelectorAll(".map-badge text")).map(n => n.textContent).join(",")');
  check('zone badges count selected symptoms (belly 1, pelvis 2)', badges === '1,2', badges);
  await shot('06-log-bodymap');
  await click('[data-action="save-log"]');
  check('same-day entry is updated, not duplicated', await ev('Anajia.state.logs.length === 1 && Anajia.state.logs[0].symptoms.cramps === 9'));
  await click('[data-action="close-modal"]');

  /* ---------------- 4. red flags ---------------- */
  console.log('\n# Safety red flags');
  const flagCase = async (label, ids, expectUrgent) => {
    await click('.tab[data-view="home"]');
    await click('.tab[data-view="log"]');
    await ev('(() => { Anajia.state.logs.length = 0; return 1; })()');
    await click('.tab[data-view="home"]'); await click('.tab[data-view="log"]');
    await click('[data-action="category"][data-id="all"]');
    for (const id of ids) await click(`.chip[data-action="toggle-symptom"][data-id="${id}"]`);
    await click('[data-action="save-log"]');
    const urgent = await count('.overlay.urgent');
    check(`${label} → ${expectUrgent ? 'urgent screen' : 'no urgent screen'}`, expectUrgent ? urgent === 1 : urgent === 0, (await text('.urgent-list strong')) || undefined);
    if (label.startsWith('fever + pelvic')) {
      await shot('07-urgent-screen', false);
      check('urgent screen offers emergency call links', await count('.urgent-screen a[href="tel:141"]') === 1 && await count('.urgent-screen a[href="tel:15"]') === 1);
    }
    await click('[data-action="close-modal"]');
  };
  await flagCase('fainting', ['fainting'], true);
  await flagCase('soaking a pad per hour', ['soaking_pad_hourly'], true);
  await flagCase('sudden severe pelvic pain', ['sudden_severe_pelvic_pain'], true);
  await flagCase('pregnancy + pain', ['pregnant', 'cramps'], true);
  await flagCase('fever + pelvic pain', ['fever', 'pelvic_pain'], true);
  await flagCase('dark thoughts (support)', ['dark_thoughts'], true);
  await flagCase('fever alone', ['fever'], false);
  await flagCase('pregnancy alone', ['pregnant'], false);
  await flagCase('cramps + bloating', ['cramps', 'bloating'], false);

  /* ---------------- 5. the three personas ---------------- */
  console.log('\n# Demo personas');
  const personas = await ev('Anajia.PERSONAS.map(p => ({ id: p.id, condition: p.condition }))');
  for (const p of personas) {
    console.log(`\n## ${p.id} (${p.condition})`);
    await ev(`Anajia.loadPersona(${JSON.stringify(p.id)})`);
    const scores = await ev('(() => { const S = Anajia; return S.Engine.scoreAll(S.Engine.windowLogs(S.state.logs, S.kb), S.state.profile, S.kb).map(r => ({ id: r.id, pct: Math.round(r.ratio * 100), level: r.level, pts: Math.round(r.points * 10) / 10, max: r.max, rules: r.rules.filter(x => x.matched).map(x => x.rule.id) })); })()');
    check(`${p.id}: top pattern is ${p.condition} and "strong"`, scores[0].id === p.condition && scores[0].level === 'strong', scores.map(s => `${s.id} ${s.pct}% (${s.level})`).join(' | '));
    check(`${p.id}: clear gap to the second pattern`, scores[0].pct - scores[1].pct >= 20, `${scores[0].pct}% vs ${scores[1].pct}%`);
    check(`${p.id}: timing rules matched`, scores[0].rules.length >= 1, scores[0].rules.join(', '));
    check(`${p.id}: home shows cycle ring and demo banner`, await count('.ring-wrap') === 1 && await count('.demo-banner') === 1, 'day ' + await text('.ring-center strong'));
    check(`${p.id}: no urgent flag in demo data`, await ev('Anajia.state.logs.every(e => Anajia.Engine.redFlags(e, Anajia.kb).every(f => f.level !== "urgent"))'));
    if (p.id === 'imane') await shot('10-home-imane');

    await click('.tab[data-view="insights"]');
    check(`${p.id}: insights lead with the expected card + "not a diagnosis" banner`,
      (await ev('document.querySelector(".pattern").className')).includes('lvl-strong') && await count('.notdx') === 1,
      (await text('.pattern .pattern-title h3')) + ' ' + (await text('.pattern .pattern-pct')));
    check(`${p.id}: contributing symptoms and evidence listed`, await count('.pattern .contrib') >= 5 && await count('.pattern .ev') >= 5, `${await count('.pattern:first-of-type .contrib')} symptoms, ${await count('.pattern:first-of-type .ev')} evidence items`);
    check(`${p.id}: no horizontal overflow (insights)`, (await overflow()) <= 0, await overflow());
    await ev('document.querySelector(".pattern details").open = true');
    await shot(`11-insights-${p.id}`);

    await click('.tab[data-view="doctor"]');
    check(`${p.id}: doctor tab has questions, exams and a timeline`, await count('.q-list .q') >= 6 && await count('.exam-list li') >= 4 && await count('.tl-item') >= 8,
      `${await count('.q-list .q')} questions, ${await count('.exam-list li')} exams, ${await count('.tl-item')} timeline entries`);
    check(`${p.id}: no horizontal overflow (doctor)`, (await overflow()) <= 0, await overflow());
    if (p.id === 'imane') await shot('12-doctor-imane');

    await click('.tab[data-view="community"]');
    check(`${p.id}: community shows 18 demo cards, labelled as demo`, await count('.com-card') === 18 && await count('.demo-data') === 1);
    await click('.tab[data-view="log"]');
    check(`${p.id}: no horizontal overflow (log)`, (await overflow()) <= 0, await overflow());
    await click('.tab[data-view="home"]');
  }

  /* ---------------- 6. features on a persona ---------------- */
  console.log('\n# Features');
  await ev('Anajia.loadPersona("imane")');

  await click('.tab[data-view="log"]');
  check('log opens on a short first screen (pain category)', await count('.chips .chip[data-action="toggle-symptom"]') === 9);
  await click('[data-action="category"][data-id="all"]');
  await click('[data-action="toggle-diagnosed"][data-id="endometriosis"]');
  const related = await count('.chip-related');
  await setInput('[data-input="only-related"]', true, 'change');
  const onlyRelated = await count('.chips .chip[data-action="toggle-symptom"]');
  check('"already diagnosed with" highlights and filters related symptoms', related === 14 && onlyRelated === 19, `${related} related, ${onlyRelated} shown with filter (14 + 5 safety signals)`);
  await click('.tab[data-view="insights"]');
  check('diagnosed condition is tagged in Insights', await count('.level-pill.dx') === 1);
  check('"soon" flag banner shown for strong bowel pain', await count('.card.soon .soon-item') >= 1, await text('.soon-item strong'));

  check('verification badges hidden by default', await count('.badge-warn') === 0);
  await click('[data-action="open-modal"][data-modal="settings"]');
  await shot('13-settings', false);
  await setInput('[data-input="set-verif"]', true, 'change');
  await click('[data-action="close-modal"]');
  const warn = await count('.ev .badge-warn'), evs = await count('.ev');
  check('dev toggle shows "to verify" on every evidence item', warn === evs && evs > 0 && await count('.ev .badge-ok') === 0, `${warn}/${evs} unverified`);

  await click('[data-action="open-modal"][data-modal="how"]');
  check('"How it works" modal explains scoring and lists weights', await count('.how-step') === 6 && await count('.weights li') > 30);
  await shot('14-how-it-works', false);
  await click('[data-action="close-modal"]');

  await click('.tab[data-view="community"]');
  await click('[data-action="com-filter"][data-key="condition"][data-id="pcos"]');
  check('community filter by condition', await count('.com-card') === 6);
  await click('[data-action="com-filter"][data-key="result"][data-id="worse"]');
  check('community filter by result', await count('.com-card') === 1);
  await click('[data-action="com-filter"][data-key="result"][data-id="all"]');
  const before = Number(await text('.helped-btn b'));
  await click('.helped-btn');
  check('"helped me too" increments and persists', Number(await text('.helped-btn b')) === before + 1 && await ev('Object.keys(Anajia.state.community.helped).length === 1'));
  await click('[data-action="com-filter"][data-key="condition"][data-id="all"]');
  await shot('15-community');
  await click('[data-action="open-share"]');
  await setInput('[data-input="share"][data-key="tried"]', 'Yoga doux le soir');
  await setInput('[data-input="share"][data-key="duration"]', '2 mois');
  await click('[data-action="publish-share"]');
  check('sharing an experience adds a local card', await count('.com-card') === 19 && (await text('.com-card .com-tried')) === 'Yoga doux le soir');

  await click('.tab[data-view="doctor"]');
  const q0 = await count('.q-list .q');
  await setInput('.q input[data-input="question"]', false, 'change');
  check('unticking a question excludes it from print', await count('.q.off') === 1);
  await setInput('#custom-q', 'Puis-je continuer le sport ?');
  await click('[data-action="add-question"]');
  check('custom question added', await count('.q-list .q') === q0 + 1);
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  check('print layout hides navigation and unticked questions', await ev('getComputedStyle(document.querySelector("#tabbar")).display === "none" && getComputedStyle(document.querySelector(".q.off")).display === "none" && getComputedStyle(document.querySelector(".print-head")).display === "block"'));
  await send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const pv = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 794, height: 1500, scale: 1 } });
  writeFileSync(path.join(OUT, '18-print-preview.png'), Buffer.from(pv.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  const pdf = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  writeFileSync(path.join(OUT, 'doctor-report.pdf'), Buffer.from(pdf.data, 'base64'));
  check('printable timeline exports to PDF', pdf.data.length > 20000, Math.round(pdf.data.length * 0.75 / 1024) + ' KB');
  await send('Emulation.setEmulatedMedia', { media: '' });

  /* ---------------- 7. languages ---------------- */
  console.log('\n# Languages');
  for (const lang of ['ar', 'en', 'fr']) {
    await click(`.lang-switch [data-lang="${lang}"]`);
    const okDir = await ev(`document.documentElement.dir === ${JSON.stringify(lang === 'ar' ? 'rtl' : 'ltr')} && document.documentElement.lang === ${JSON.stringify(lang)}`);
    let maxOverflow = 0, missing = 0;
    const clipped = await ev('Array.from(document.querySelectorAll(".tab-label")).filter(n => n.scrollWidth > n.clientWidth).map(n => n.textContent).join(",")');
    check(`${lang}: tab labels fit at 360px`, clipped === '', clipped || undefined);
    if (lang === 'ar') {
      await click('.tab[data-view="home"]');
      check('ar: demo persona name and notes follow the language', (await text('.bubble h1')).includes('إيمان'), await text('.bubble h1'));
    }
    for (const v of ['home', 'log', 'insights', 'community', 'doctor']) {
      await click(`.tab[data-view="${v}"]`);
      maxOverflow = Math.max(maxOverflow, await overflow());
      missing += await ev('(document.querySelector("#app").innerText.match(/\\b(nav|common|onb|home|mood|mascot|phase|log|int|ins|doc|com|urg|set|how|country)\\.[a-zA-Z_.]+/g) || []).length');
      if (lang !== 'fr' && (v === 'home' || v === 'insights' || v === 'log')) await shot(`20-${lang}-${v}`);
    }
    check(`${lang}: direction set, all 5 views render, no overflow, no missing strings`, okDir && maxOverflow <= 0 && missing === 0, `dir ok=${okDir}, overflow=${maxOverflow}, missing keys=${missing}`);
  }
  check('language choice persists', await ev('JSON.parse(localStorage.getItem("anajia.v1")).profile.lang === "fr"'));

  /* ---------------- 8. reload, delete, file:// ---------------- */
  console.log('\n# Persistence, delete, double-click mode');
  await goto(BASE + '#/insights');
  check('state survives a reload (deep link to Insights)', await ev('Anajia.state.profile.demo === "imane" && document.querySelector("#app").dataset.view === "insights"') && await count('.pattern') >= 1);
  await click('[data-action="open-modal"][data-modal="settings"]');
  await click('.sheet [data-action="open-modal"][data-modal="confirm-delete"]');
  await shot('16-confirm-delete', false);
  await click('[data-action="delete-all"]');
  check('"Delete all my data" wipes localStorage and returns to onboarding', await ev('localStorage.getItem("anajia.v1") === null && document.querySelector("#app").dataset.view === "onboarding" && Anajia.state.logs.length === 0'));
  await ev('localStorage.setItem("sehhati.v1", JSON.stringify({ profile: { nickname: "Legacy" } }))');
  await goto(BASE);
  check('legacy user data migrates to the Anajia storage key', await ev('Anajia.state.profile.nickname === "Legacy" && localStorage.getItem("anajia.v1") !== null && localStorage.getItem("sehhati.v1") === null'));

  await goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  check('opens by double-click (file://) using the embedded data bundle', await ev('location.protocol === "file:" && Anajia.kb.conditions.length === 3 && Anajia.community.cards.length === 18'));
  await click('[data-action="open-modal"][data-modal="demo"]');
  await shot('17-demo-picker', false);
  await click('[data-action="load-persona"][data-id="khadija"]');
  await click('.tab[data-view="insights"]');
  check('persona flow works from file://', (await text('.pattern .pattern-title h3')) === 'SOPK', await text('.pattern .pattern-pct'));
  const fromBundle = await ev('JSON.stringify(window.ANAJIA_DATA)');
  const fromJson = JSON.stringify({
    knowledge: JSON.parse(readFileSync(path.join(ROOT, 'data/knowledge.json'), 'utf8')),
    community: JSON.parse(readFileSync(path.join(ROOT, 'data/community.json'), 'utf8'))
  });
  check('data.bundle.js is in sync with the JSON files', fromBundle === fromJson, fromBundle === fromJson ? undefined : 'run: python tools/sync_data.py');
  check('every evidence item is flagged verified:false', await ev('Anajia.kb.conditions.every(c => c.evidence.every(e => e.verified === false))'));

  await sleep(300);
  check('no console errors or uncaught exceptions during the whole run', consoleErrors.length === 0, consoleErrors.length ? consoleErrors : '0 errors');

  ws.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('\nTest run aborted:', err.message);
  if (consoleErrors.length) console.error('Console errors so far:', consoleErrors);
} finally {
  chrome.kill();
  server.kill();
  await sleep(400);
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(exitCode);
