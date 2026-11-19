const { JSDOM } = require('jsdom');
(async () => {
  const dom = await JSDOM.fromFile(require('path').join(__dirname, '..', 'index.html'), { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
  const w = dom.window; const errs = [];
  w.addEventListener('error', e => errs.push(e.message));
  w.console.error = (...a) => errs.push(a.join(' '));
  await new Promise(r => setTimeout(r, 800));
  await w.Sehhati.ready;
  const S = w.Sehhati, d = w.document, q = s => d.querySelector(s), qa = s => d.querySelectorAll(s);
  const ok = (n, c, x) => console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  [' + x + ']' : ''));
  S.loadPersona('khadija'); await new Promise(r => setTimeout(r, 200));
  S.go('insights');
  ok('signs shown instead of %', /\d+\/\d+/.test(q('.pattern-pct').textContent) && !q('.pattern-pct').textContent.includes('%'), q('.pattern-pct').textContent);
  ok('top pattern still PCOS strong', q('.pattern').className.includes('lvl-strong'), q('.pattern-title h3').textContent);
  ok('narrowing question card', !!q('.q-card [data-action="answer-q"]'), q('.q-text') && q('.q-text').textContent);
  // answer yes then no
  const first = q('.q-card [data-action="answer-q"][data-ans="yes"]'); const id = first.dataset.id; first.click();
  ok('yes logs symptom today', S.state.logs.some(e => e.symptoms[id] > 0) && S.state.answers[id] === 'yes');
  const no = q('.q-card [data-action="answer-q"][data-ans="no"]'); if (no) { const nid = no.dataset.id; no.click(); ok('no stored', S.state.answers[nid] === 'no' && !!q('.q-card')); }
  // open details and check ranking order + try buttons
  d.querySelector('details.more').open = true;
  const items = [...qa('.pattern:first-of-type .life-list li .life-text')].map(e => e.textContent);
  ok('lifestyle list ranked by community (PCOS: activity first)', items[0] && /physical activity|Activité physique/.test(items[0]), items.join(' | '));
  ok('community badge on ranked item', !!q('.life-list .badge-com'));
  ok('try buttons present', qa('.try-btn').length >= 5);
  q('.pattern:first-of-type .try-btn').click();
  ok('experiment active card', !!q('.exp-card') && S.state.experiments.length === 1 && S.state.experiments[0].symptom, JSON.stringify(S.state.experiments[0]));
  ok('only one at a time (buttons disabled)', [...qa('.try-btn')].every(b => b.disabled));
  S.go('home'); ok('experiment card also on Home', !!q('.exp-card'));
  S.go('insights'); q('[data-action="finish-exp"][data-res="helped"]').click();
  ok('experiment finished + saved', S.state.experiments[0].status === 'done' && S.state.community.mine[0].item);
  ok('history shown', !!qa('.card').length && d.body.textContent.includes('Mes essais'));
  S.go('community');
  ok('community: approved badge + not-approved note', !!q('.badge-mint') && d.body.textContent.includes('Hors liste approuvée'));
  ok('my card is first/mine', q('.com-card').textContent.includes('Moi') || S.state.community.mine.length === 1);
  for (const l of ['ar', 'en']) { S.state.profile.lang = l; S.go('insights'); S.go('community'); S.go('insights'); }
  ok('ar/en render without raw keys', !/ins\.signs|exp\.try|com\.rankNote|ins\.qTitle/.test(d.body.textContent));
  S.go('doctor'); ok('doctor view renders signs', /\d+ (of|sur) \d+|من/.test(d.body.textContent));
  ok('no JS errors', errs.length === 0, errs.slice(0, 3).join(' || '));
  process.exit(0);
})();
