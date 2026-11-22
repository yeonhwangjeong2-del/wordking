'use strict';

// ---------- storage ----------
// shortcut: everything lives in one localStorage JSON (~5MB limit, ~tens of thousands of words); move to IndexedDB if it ever fills up.
const KEY = 'wordking';
const newFolder = (id, name) => ({ id, name, words: [], days: [] });
const DEFAULT_DB = {
  v: 2,
  settings: { apiKey: '', geminiKey: '', model: 'gemini-3.5-flash-lite', perDay: 30 },
  // folder.words: the word pool, in the order added: [{ id, en, ko, ex?, syn?, ant?, mark?, wrong? }]
  // folder.days[n-1]: { ids?, done: { test, r1, r2, big } }. ids is fixed when Day n's 1차 시험 is done.
  folders: [newFolder('daily', 'DailyWord'), newFolder('exam', 'ExamWord')],
  log: [] // { date, fid, n, kind } one entry per finished test, for the calendar
};
let db;
try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
if (db?.v !== 2) db = { ...structuredClone(DEFAULT_DB), settings: { ...DEFAULT_DB.settings, ...db?.settings } }; // v1 data: wiped on purpose, keys kept
if (!db.settings.apiKey && db.settings.model.startsWith('claude')) db.settings.model = DEFAULT_DB.settings.model;
const save = () => localStorage.setItem(KEY, JSON.stringify(db));
save();
if (navigator.storage?.persist) navigator.storage.persist();

const ui = { view: 'home', folderId: 'daily', dayN: 1, draft: [], hideAll: false, shown: new Set(), exOpen: new Set() };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
console.assert(JSON.stringify(chunk([1, 2, 3, 4, 5], 2)) === '[[1,2],[3,4],[5]]', 'chunk');

function busy(msg) { $('#busy').classList.toggle('on', !!msg); $('#busy-msg').textContent = msg || ''; }
const folderOf = fid => db.folders.find(f => f.id === fid);

// ---------- dates ----------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date, compares as a string
const today = () => ymd(new Date());
const md = s => `${+s.slice(5, 7)}/${+s.slice(8)}`;

// ---------- Days ----------
// Days are cut from the folder's word pool in order, perDay words each. Days already tested keep their words;
// the rest of the pool is re-cut every time, so a half-full Day keeps filling until its 1차 시험.
// Two review-only Days follow the last word Day so its 복습1/복습2 have somewhere to live.
function planDays(f, per = db.settings.perDay) {
  const fixed = [];
  for (const d of f.days) { if (!d?.ids) break; fixed.push(d.ids); }
  const used = new Set(fixed.flat());
  const rest = chunk(f.words.filter(w => !used.has(w.id)).map(w => w.id), per);
  const wordDays = [...fixed, ...rest];
  return wordDays.length ? [...wordDays, [], []] : [];
}
console.assert(JSON.stringify(planDays({ words: [1, 2, 3, 4, 5].map(id => ({ id })), days: [] }, 2)) === '[[1,2],[3,4],[5],[],[]]', 'planDays');
console.assert(JSON.stringify(planDays({ words: [1, 2, 3, 4, 5].map(id => ({ id })), days: [{ ids: [1], done: {} }] }, 2)) === '[[1],[2,3],[4,5],[],[]]', 'planDays fixed');

const dayRec = (f, n) => (f.days[n - 1] ||= { done: {} });
const isDone = (f, n, kind) => !!f.days[n - 1]?.done?.[kind];
const LABEL = { test: '1차 시험', r1: '복습1', r2: '복습2', big: '오답 총복습', practice: '연습' };

// Day n: its own 1차 시험, Day n-1's 복습1 (all words), Day n-2's 복습2 (ever-wrong only), and 오답 총복습 on every 5th Day.
function dayTasks(f, plan, n) {
  const t = [];
  if (plan[n - 1].length) t.push({ kind: 'test', src: n, ids: plan[n - 1] });
  if (n >= 2 && plan[n - 2].length) t.push({ kind: 'r1', src: n - 1, ids: plan[n - 2] });
  if (n >= 3 && plan[n - 3].length) t.push({ kind: 'r2', src: n - 2, ids: plan[n - 3], onlyWrong: true });
  if (n % 5 === 0) t.push({ kind: 'big', ids: plan.slice(0, n).filter((_, i) => isDone(f, i + 1, 'test')).flat(), onlyWrong: true });
  return t.map(x => ({ ...x, done: f.days[n - 1]?.done?.[x.kind] }));
}
// Day n opens once the Day before it has its 1차 시험 done (or, for a review-only Day, all its tasks done).
function isOpen(f, plan, n) {
  if (n === 1) return true;
  const prev = dayTasks(f, plan, n - 1);
  return prev.some(t => t.kind === 'test') ? !!prev.find(t => t.kind === 'test').done : isOpen(f, plan, n - 1) && prev.every(t => t.done);
}
// A word counts as finished once its Day's 복습2 is done.
const finishedWords = f => { const plan = planDays(f); return plan.reduce((s, ids, i) => s + (ids.length && isDone(f, i + 3, 'r2') ? ids.length : 0), 0); };

// Test items: { fid, id } for a word, plus s ('syn' | 'ant') and k for its synonyms/antonyms, which are tested as words too.
const wordById = (f, id) => f.words.find(w => w.id === id);
const wordOf = it => { const w = wordById(folderOf(it.fid) || { words: [] }, it.id); return it.s ? w?.[it.s]?.[it.k] : w; };
function itemsFor(f, ids, onlyWrong = false) {
  return ids.flatMap(id => { const w = wordById(f, id); return w ? [{ fid: f.id, id }, ...['syn', 'ant'].flatMap(s => (w[s] || []).map((_, k) => ({ fid: f.id, id, s, k })))] : []; })
    .filter(it => !onlyWrong || wordOf(it).wrong);
}

// ---------- AI (Gemini free tier or Claude) ----------
// content is Claude-style: a string, or [{ type: 'image', source }, { type: 'text', text }].
const ai = (system, content, schema) => (db.settings.model.startsWith('gemini') ? gemini : claude)(system, content, schema);

async function gemini(system, content, schema) {
  const s = db.settings;
  if (!s.geminiKey) throw new Error('설정(⚙︎)에서 Gemini API 키를 먼저 넣어주세요.');
  const parts = typeof content === 'string' ? [{ text: content }]
    : content.map(b => (b.type === 'image' ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } } : { text: b.text }));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${s.model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': s.geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error?.details?.some(d => d.reason === 'API_KEY_INVALID')) throw new Error('Gemini API 키가 틀렸어요. 설정에서 확인해주세요.');
    if (r.status === 429) throw new Error('무료 사용량을 잠깐 다 썼어요. 1분쯤 뒤에 다시 해주세요.');
    throw new Error(j.error?.message || `오류 ${r.status}`);
  }
  const c = j.candidates?.[0];
  if (!c?.content) throw new Error('AI가 이 요청을 처리하지 못했어요.');
  if (c.finishReason === 'MAX_TOKENS') throw new Error('단어가 너무 많아요. 사진을 나눠서 찍어주세요.');
  return JSON.parse(c.content.parts.filter(p => p.text && !p.thought).map(p => p.text).join(''));
}

async function claude(system, content, schema) {
  const s = db.settings;
  if (!s.apiKey) throw new Error('설정(⚙︎)에서 Claude API 키를 먼저 넣어주세요.');
  const headers = {
    'content-type': 'application/json',
    'x-api-key': s.apiKey,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true' // personal app: the key stays on this device
  };
  const body = {
    model: s.model, max_tokens: 16000, system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } }
  };
  if (s.model === 'claude-opus-5-5') { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) throw new Error('API 키가 틀렸어요. 설정에서 확인해주세요.');
    if (r.status === 429) throw new Error('요청이 너무 많아요. 잠시 후 다시 해주세요.');
    throw new Error(j.error?.message || `오류 ${r.status}`);
  }
  if (j.stop_reason === 'refusal') throw new Error('AI가 이 사진을 처리하지 못했어요.');
  if (j.stop_reason === 'max_tokens') throw new Error('단어가 너무 많아요. 사진을 나눠서 찍어주세요.');
  return JSON.parse(j.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}

const EXTRACT_SYSTEM = `You read photos of English vocabulary lists or textbook pages for a Korean student.
Return every English word or phrase in the photo, in the order shown, with its Korean meaning.
Use the Korean meaning printed in the photo when there is one; otherwise write a short, common Korean meaning.
If the photo shows an example sentence for a word (next to or under it), put it in ex_en and its Korean translation in ex_ko
(use the printed translation if there is one, otherwise translate it). If there is no example sentence, leave both empty.
Skip page numbers and headings. Do not add words that are not in the photo.`;
const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['words'],
  properties: { words: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['en', 'ko', 'ex_en', 'ex_ko'],
    properties: { en: { type: 'string' }, ko: { type: 'string' }, ex_en: { type: 'string' }, ex_ko: { type: 'string' } }
  } } }
};

// Shrink photos before upload: fewer tokens, faster on iPad.
function toJpegBase64(file, max = 1568) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => rej(new Error('사진을 열 수 없어요.'));
    img.src = URL.createObjectURL(file);
  });
}

$('#photo').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const found = [];
  try {
    for (let i = 0; i < files.length; i++) {
      busy(`AI가 단어를 읽는 중… (${i + 1}/${files.length})`);
      const data = await toJpegBase64(files[i]);
      const out = await ai(EXTRACT_SYSTEM, [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
        { type: 'text', text: 'Extract the vocabulary.' }
      ], EXTRACT_SCHEMA);
      for (const w of out.words) if (w.en.trim()) found.push({ en: w.en, ko: w.ko, ex: w.ex_en.trim() ? { en: w.ex_en.trim(), ko: w.ex_ko.trim() } : null });
    }
    if (!found.length) throw new Error('사진에서 영단어를 찾지 못했어요.');
    ui.draft = found; ui.manual = false; ui.view = 'review';
  } catch (err) { alert(err.message); }
  busy(); render();
});

// ---------- test grading ----------
const GRADE_SYSTEM = `You grade a Korean student's English vocabulary test.
For each item you get the English word, the reference Korean meaning, and the student's Korean answer.
Grade "o" if the answer means the same as the reference (different wording or another correct meaning of the word is fine),
"tri" if it is close or partly right but imprecise, "x" if it is wrong.`;
const GRADE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['grades'],
  properties: { grades: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['i', 'g'],
    properties: { i: { type: 'integer' }, g: { type: 'string', enum: ['o', 'tri', 'x'] } }
  } } }
};
const norm = s => s.replace(/\s+/g, '').toLowerCase();

// Blank → x, exact match → o, everything else goes to the AI in one call.
async function grade(items) {
  const g = items.map(it => !norm(it.answer) ? 'x' : norm(it.answer) === norm(it.ref) ? 'o' : null);
  const ask = items.map((it, i) => ({ i, en: it.en, ref: it.ref, answer: it.answer })).filter(x => g[x.i] === null);
  if (ask.length) {
    const out = await ai(GRADE_SYSTEM, JSON.stringify(ask), GRADE_SCHEMA);
    for (const { i, g: v } of out.grades) if (g[i] === null) g[i] = v;
  }
  return g.map(v => v ?? 'x');
}

// ctx: { fid, n, kind, ids } — kind is test | r1 | r2 | big | practice; ids are Day n's words for a 1차 시험.
function startTest(items, ctx, title) {
  ui.test = { items, ctx, title, i: 0, answers: [], result: null };
  ui.view = 'test'; render();
}

function markDone(f, n, kind, ids) {
  const rec = dayRec(f, n);
  rec.done[kind] = today();
  if (kind === 'test') rec.ids = ids;
  db.log.push({ date: today(), fid: f.id, n, kind });
}

async function finishTest() {
  const t = ui.test;
  busy('AI가 채점하는 중…');
  try {
    const g = await grade(t.items.map((it, k) => { const w = wordOf(it); return { en: w.en, ref: w.ko, answer: t.answers[k] || '' }; }));
    t.items.forEach((it, k) => {
      const w = wordOf(it);
      w.mark = g[k];
      if (g[k] !== 'o') w.wrong = true; // ever wrong (△ counts) — feeds 복습2 and 오답 총복습
    });
    const { fid, n, kind, ids } = t.ctx;
    if (kind !== 'practice') markDone(folderOf(fid), n, kind, ids);
    save(); t.result = g;
  } catch (err) { alert(err.message); }
  busy(); render();
}

// ---------- meanings for typed words ----------
const FILL_SYSTEM = `For each English word or phrase, give its Korean meaning the way a Korean vocabulary book would:
the 1-2 most common meanings, short, separated by a comma.`;
const FILL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['i', 'ko'],
    properties: { i: { type: 'integer' }, ko: { type: 'string' } }
  } } }
};
// Fills empty ko in place. Returns false if the AI call failed (the error is already shown).
async function fillMeanings(words) {
  const ask = words.map((w, i) => ({ i, en: w.en.trim() })).filter(x => x.en && !words[x.i].ko.trim());
  if (!ask.length) return true;
  busy(`뜻 ${ask.length}개 채우는 중…`);
  try {
    const out = await ai(FILL_SYSTEM, JSON.stringify(ask), FILL_SCHEMA);
    for (const { i, ko } of out.items) if (words[i] && !words[i].ko.trim()) words[i].ko = ko.trim();
    return true;
  } catch (err) { alert(err.message); return false; }
  finally { busy(); }
}

// ---------- synonyms / antonyms / example ----------
const REL_SYSTEM = `You help a Korean student studying English vocabulary.
Given an English word and its Korean meaning, list synonyms and antonyms used in that sense.
Synonyms: 1 to 3, closest first. Give 3 only if there really are 3 close, common ones; otherwise 1 or 2.
Antonyms: up to 3 common opposites, closest first; an empty list if the word has no real opposite.
Each item is a single common English word or short phrase with a short Korean meaning.`;
const REL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['syn', 'ant'],
  properties: Object.fromEntries(['syn', 'ant'].map(k => [k, { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['en', 'ko'],
    properties: { en: { type: 'string' }, ko: { type: 'string' } }
  } }]))
};
const EX_SYSTEM = `Write one short, natural English example sentence that uses the given word in the given Korean sense,
at a high-school level, and its Korean translation.`;
const EX_SCHEMA = { type: 'object', additionalProperties: false, required: ['en', 'ko'], properties: { en: { type: 'string' }, ko: { type: 'string' } } };

async function makeRelated(w) {
  busy(`${w.en} 유의어·반의어 만드는 중…`);
  try {
    const out = await ai(REL_SYSTEM, JSON.stringify({ word: w.en, meaning: w.ko }), REL_SCHEMA);
    const clean = list => list.filter(x => x.en.trim() && x.en.toLowerCase() !== w.en.toLowerCase()).slice(0, 3);
    w.syn = clean(out.syn); w.ant = clean(out.ant); save();
  } catch (err) { alert(err.message); }
  busy();
}
async function makeExample(w) {
  busy(`${w.en} 예문 만드는 중…`);
  try { w.ex = await ai(EX_SYSTEM, JSON.stringify({ word: w.en, meaning: w.ko }), EX_SCHEMA); save(); }
  catch (err) { alert(err.message); }
  busy();
}

// ---------- backup ----------
function exportBackup() {
  const blob = new Blob([JSON.stringify(db)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `wordking-${new Date().toISOString().slice(0, 10)}.json` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#restore').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.v !== 2 || !Array.isArray(data.folders) || !data.settings) throw 0;
    if (!confirm('지금 데이터가 백업 파일 내용으로 바뀌어요. 계속할까요?')) return;
    data.settings.apiKey ||= db.settings.apiKey;
    data.settings.geminiKey ||= db.settings.geminiKey;
    db = data; save(); ui.view = 'home'; render();
  } catch { alert('WordKing 백업 파일이 아니에요.'); }
});

// ---------- views ----------
function render() { ({ home, review, day, settings, test, calendar })[ui.view](); window.scrollTo(0, 0); }
function bindGo() { document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { ui.view = b.dataset.go; render(); }); }
const MARK = { tri: '<span class="mark tri" title="비슷함">△</span>', x: '<span class="mark x" title="틀림">—</span>', o: '<span class="mark o" title="맞음">○</span>' };

// Calendar: green dot on days with finished tests. Tap a date to list them.
function dayEvents(date) {
  return db.log.filter(l => l.date === date && folderOf(l.fid))
    .map(l => ({ fid: l.fid, n: l.n, text: `${folderOf(l.fid).name} Day ${l.n} ${LABEL[l.kind]} 완료` }));
}

function calendar() {
  const t = today();
  ui.calMonth ||= t.slice(0, 7);
  ui.calDay ||= t;
  const [y, m] = ui.calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
  const cells = Array(first.getDay()).fill('');
  for (let d = 1; d <= days; d++) cells.push(`${ui.calMonth}-${pad(d)}`);
  const shift = n => { const d = new Date(y, m - 1 + n, 1); ui.calMonth = ymd(d).slice(0, 7); calendar(); };
  const sel = dayEvents(ui.calDay);
  $('#app').innerHTML = `
    <header><button class="icon-btn" data-go="home" aria-label="뒤로">←</button><h1>${y}년 ${m}월</h1>
      <button class="icon-btn" id="pm" aria-label="이전 달">‹</button><button class="icon-btn" id="nm" aria-label="다음 달">›</button></header>
    <div class="cal">
      ${['일', '월', '화', '수', '목', '금', '토'].map(d => `<div class="dow">${d}</div>`).join('')}
      ${cells.map(c => c ? `<button class="day ${c === t ? 'today' : ''} ${c === ui.calDay ? 'sel' : ''}" data-day="${c}">${+c.slice(8)}
          <span class="dots">${dayEvents(c).length ? '<i class="done"></i>' : ''}</span></button>` : '<div></div>').join('')}
    </div>
    <h2 class="cal-h">${md(ui.calDay)}${ui.calDay === t ? ' (오늘)' : ''}</h2>
    <div class="list">${sel.length ? sel.map((e, i) => `<button class="row ev done" data-ev="${i}"><i></i>${esc(e.text)}</button>`).join('')
      : '<div class="empty">이 날은 기록이 없어요.</div>'}</div>`;
  $('#pm').onclick = () => shift(-1);
  $('#nm').onclick = () => shift(1);
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { ui.calDay = b.dataset.day; calendar(); });
  document.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => { const e = sel[+b.dataset.ev]; ui.folderId = e.fid; openDay(e.n); });
  bindGo();
}

function test() {
  const t = ui.test;
  t.items = t.items.filter(wordOf);
  if (!t.items.length) { ui.view = 'home'; return render(); }
  const back = `<button class="icon-btn" id="quit" aria-label="그만하기">✕</button>`;
  if (t.result) {
    const wrong = t.items.filter((_, k) => t.result[k] !== 'o');
    const score = t.result.filter(v => v === 'o').length;
    $('#app').innerHTML = `
      <header>${back}<h1>${esc(t.title)} 결과</h1><small>${score} / ${t.items.length}</small></header>
      <div class="sheet">${t.items.map((it, k) => { const w = wordOf(it); return `
        <div class="word result"><span class="n">${MARK[t.result[k]]}</span><span class="en">${esc(w.en)}</span>
        <span class="ko"><span class="mine">${esc(t.answers[k] || '(모름)')}</span>${t.result[k] !== 'o' ? `<br><b>${esc(w.ko)}</b>` : ''}</span></div>`; }).join('')}</div>
      <div class="pager">
        ${wrong.length ? `<button class="btn" id="retry-wrong">틀린 것만 다시 (${wrong.length})</button>` : ''}
        <button class="btn ghost" id="retry-all">전체 다시</button>
      </div>`;
    const ctx = { ...t.ctx, kind: 'practice' }, title = `${t.title.replace(/ 연습$/, '')} 연습`;
    $('#retry-wrong')?.addEventListener('click', () => startTest(wrong, ctx, title));
    $('#retry-all').onclick = () => startTest(t.items, ctx, title);
  } else {
    const w = wordOf(t.items[t.i]);
    $('#app').innerHTML = `
      <header>${back}<h1>${esc(t.title)}</h1><small>${t.i + 1} / ${t.items.length}</small></header>
      <form id="qa" class="quiz">
        <div class="quiz-en">${esc(w.en)}</div>
        <input id="ans" autocomplete="off" autocapitalize="off" placeholder="뜻을 쓰세요" value="${esc(t.answers[t.i] || '')}">
        <div class="pager">
          <button type="button" class="btn ghost" id="prev-q" ${t.i ? '' : 'disabled'}>◀ 이전</button>
          <button type="button" class="btn ghost" id="skip">모름</button>
          <button class="btn">${t.i < t.items.length - 1 ? '다음 ▶' : '채점하기'}</button>
        </div>
      </form>`;
    $('#ans').focus();
    const next = () => { t.answers[t.i] = $('#ans').value.trim(); if (++t.i < t.items.length) test(); else finishTest(); };
    $('#qa').onsubmit = e => { e.preventDefault(); next(); };
    $('#skip').onclick = () => { $('#ans').value = ''; next(); };
    $('#prev-q').onclick = () => { t.answers[t.i] = $('#ans').value.trim(); t.i--; test(); };
  }
  $('#quit').onclick = () => {
    if (!t.result && t.i && !confirm('시험을 그만둘까요? 기록이 안 남아요.')) return;
    ui.folderId = t.ctx.fid; ui.dayN = t.ctx.n; ui.view = 'day'; render();
  };
}

// Progress pill colour: 0% grey → orange → yellow (≥50%) → 100% green.
const pillColor = p => (p === 0 ? '#9aa0a6' : p === 100 ? '#27ae60' : p >= 50 ? '#e0b400' : '#e67e22');
const taskName = t => (t.kind === 'test' ? '1차 시험' : t.kind === 'big' ? '오답 총복습' : `Day ${t.src} ${LABEL[t.kind]}`);

function home() {
  if (!folderOf(ui.folderId)) ui.folderId = db.folders[0].id;
  const f = folderOf(ui.folderId), plan = planDays(f);
  const finished = db.folders.reduce((s, x) => s + finishedWords(x), 0);
  $('#app').innerHTML = `
    <header><h1>Word<span>King</span></h1>
      <button class="icon-btn" data-go="calendar" aria-label="달력">📅</button>
      <button class="icon-btn" data-go="settings" aria-label="설정">⚙︎</button></header>
    <div class="stat"><div><small>누적 완료 단어 (복습2까지 끝낸 단어)</small><strong>${finished.toLocaleString()}</strong></div>
      <span>이 폴더에 저장된 단어 ${f.words.length.toLocaleString()}개</span></div>
    <div class="tabs">
      ${db.folders.map(x => `<button class="tab ${x.id === f.id ? 'on' : ''}" data-folder="${x.id}">${esc(x.name)}</button>`).join('')}
      <button class="tab" id="add-folder">＋ 폴더</button>
    </div>
    <div class="add-row"><button class="btn big" id="snap">📷 사진으로 단어 추가</button>
      <button class="btn big ghost" id="type">✍️ 직접 입력</button></div>
    <div class="list">
      ${plan.length ? plan.map((ids, i) => {
        const n = i + 1, open = isOpen(f, plan, n), tasks = dayTasks(f, plan, n);
        const pct = Math.round(tasks.filter(t => t.done).length / tasks.length * 100);
        return `<button class="row ${open ? '' : 'locked'}" data-n="${n}" ${open ? '' : 'disabled'}>
          <b>Day ${n}</b><span>${ids.length ? `새 단어 ${ids.length}` : '복습만'}</span>
          ${open ? `<span class="pill" style="background:${pillColor(pct)}">${pct}%</span>
            <span class="tasks">${tasks.map(t => `<span class="${t.done ? 'ok' : ''}">${t.done ? '✓ ' : ''}${esc(taskName(t))}</span>`).join('')}</span>`
          : `<small>🔒 Day ${n - 1} 먼저</small>`}</button>`;
      }).join('')
      : `<div class="empty">아직 단어가 없어요.<br>사진을 찍거나 직접 입력해서 단어를 넣어보세요.</div>`}
    </div>`;
  $('#snap').onclick = () => $('#photo').click();
  $('#type').onclick = () => { ui.draft = [{ en: '', ko: '' }]; ui.manual = true; ui.view = 'review'; render(); $('[data-k="en"]').focus(); };
  // Inline input instead of prompt(): prompt() is blocked in some browsers.
  $('#add-folder').onclick = () => {
    $('.tabs').outerHTML = `<form class="tabs" id="folder-form">
      <input id="folder-name" placeholder="새 폴더 이름" maxlength="30" style="max-width:240px">
      <button class="btn">추가</button><button type="button" class="btn ghost" id="folder-cancel">취소</button></form>`;
    $('#folder-name').focus();
    $('#folder-cancel').onclick = render;
    $('#folder-form').onsubmit = e => {
      e.preventDefault();
      const name = $('#folder-name').value.trim();
      if (!name) return;
      const nf = newFolder(uid(), name); db.folders.push(nf); save(); ui.folderId = nf.id; render();
    };
  };
  document.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => { ui.folderId = b.dataset.folder; render(); });
  document.querySelectorAll('[data-n]').forEach(b => b.onclick = () => openDay(+b.dataset.n));
  bindGo();
}

function review() {
  const f = folderOf(ui.folderId);
  $('#app').innerHTML = `
    <header><button class="icon-btn" id="cancel" aria-label="취소">✕</button><h1>${ui.manual ? '단어 입력' : '단어 확인'}</h1></header>
    <p class="hint">${ui.manual ? '영어 철자만 쓰면 뜻은 AI가 채워요. 뜻을 직접 써도 돼요.' : `${ui.draft.length}개를 찾았어요. 틀린 건 고치고 저장하세요.`}
      <b>${esc(f.name)}</b> 단어 모음에 저장되고, 하루 ${db.settings.perDay}개씩 Day로 나뉘어요.</p>
    <div id="edits">${ui.draft.map((w, i) => `
      <div class="edit"><input data-i="${i}" data-k="en" value="${esc(w.en)}" aria-label="영단어">
      <input data-i="${i}" data-k="ko" value="${esc(w.ko)}" placeholder="뜻 (비우면 AI)" aria-label="뜻">
      <button class="icon-btn" data-del="${i}" aria-label="삭제">✕</button>
      ${w.ex ? `<p class="hint ex-line">예문: ${esc(w.ex.en)}</p>` : ''}</div>`).join('')}</div>
    <div class="toolbar"><button class="btn ghost" id="add-row">＋ 단어 추가</button>
      <button class="btn ghost" id="fill">✨ 빈 뜻 AI로 채우기</button></div>
    <button class="btn big" id="save">저장</button>`;
  const addRow = () => { ui.draft.push({ en: '', ko: '' }); review(); document.querySelector(`[data-i="${ui.draft.length - 1}"][data-k="en"]`).focus(); };
  document.querySelectorAll('[data-k]').forEach(inp => {
    inp.oninput = () => { ui.draft[inp.dataset.i][inp.dataset.k] = inp.value; };
    // Enter: English → its meaning box, meaning → a new row (fast typing on the iPad keyboard)
    inp.onkeydown = e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (inp.dataset.k === 'en') inp.nextElementSibling.focus(); else addRow();
    };
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { ui.draft.splice(+b.dataset.del, 1); review(); });
  $('#add-row').onclick = addRow;
  $('#fill').onclick = async () => { await fillMeanings(ui.draft); review(); };
  $('#cancel').onclick = () => { if (confirm(ui.manual ? '입력한 단어를 버릴까요?' : '찾은 단어를 버릴까요?')) { ui.draft = []; ui.view = 'home'; render(); } };
  $('#save').onclick = async () => {
    if (ui.draft.some(w => w.en.trim() && !w.ko.trim()) && !(await fillMeanings(ui.draft))) return review();
    const words = ui.draft.filter(w => w.en.trim()).map(w => ({ id: uid(), en: w.en.trim(), ko: w.ko.trim(), ...(w.ex && { ex: w.ex }) }));
    if (!words.length) return alert('저장할 단어가 없어요.');
    f.words.push(...words);
    save(); ui.draft = []; ui.manual = false; ui.view = 'home'; render();
  };
}

function openDay(n) { ui.dayN = n; ui.view = 'day'; ui.hideAll = false; ui.shown = new Set(); ui.exOpen = new Set(); render(); }

function day() {
  const f = folderOf(ui.folderId), plan = planDays(f), n = ui.dayN;
  if (!plan[n - 1]) { ui.view = 'home'; return render(); }
  const open = isOpen(f, plan, n), tasks = dayTasks(f, plan, n);
  const words = plan[n - 1].map(id => wordById(f, id));
  const hidden = i => ui.hideAll !== ui.shown.has(i); // tapping a word flips it against the page-wide setting
  $('#app').innerHTML = `
    <header><button class="icon-btn" data-go="home" aria-label="뒤로">←</button>
      <h1>Day ${n}</h1><small>${esc(f.name)}</small></header>
    ${open ? `<div class="task-list">${tasks.map((t, k) => {
      const count = itemsFor(f, t.ids, t.onlyWrong).length;
      return `<div class="task ${t.done ? 'ok' : ''}"><b>${t.done ? '✓ ' : ''}${esc(taskName(t))}</b>
        <span>${t.onlyWrong ? `틀린 적 있는 단어 ${count}개` : `${count}문제`}${t.done ? ` · ${md(t.done)} 완료` : ''}</span>
        <button class="btn ${t.done ? 'ghost' : ''}" data-task="${k}">${count ? (t.done ? '연습' : '시험 보기') : (t.done ? '완료' : '틀린 단어 없음 → 완료')}</button></div>`;
    }).join('')}</div>` : `<div class="empty">🔒 Day ${n - 1}의 1차 시험을 먼저 끝내주세요.</div>`}
    ${words.length ? `<div class="toolbar"><button class="btn ghost" id="toggle-all">${ui.hideAll ? '뜻 전부 보기' : '뜻 전부 가리기'}</button></div>
    <div class="sheet grid2">${words.map((w, i) => `
      <div class="word"><span class="n">${w.mark && w.mark !== 'o' ? MARK[w.mark] : i + 1}</span><span class="en">${esc(w.en)}</span>
      <span class="ko ${hidden(i) ? 'hidden' : ''}" data-ko="${i}">${esc(w.ko)}</span>
      <span class="acts">${w.syn ? '' : `<button class="mini" data-rel="${i}" title="유의어·반의어">유·반</button>`}<button class="mini ${ui.exOpen.has(i) ? 'on' : ''}" data-ex="${i}">예문</button></span>
      ${(w.syn?.length || w.ant?.length) ? `<div class="extra">${['syn', 'ant'].flatMap(s => (w[s] || []).map(x => `<span class="chip ${s}">${x.mark && x.mark !== 'o' ? MARK[x.mark] : ''}<b>${esc(x.en)}</b>
          <span class="cko ${hidden(i) ? 'hidden' : ''}" data-ko="${i}">${esc(x.ko)}</span></span>`)).join('')}</div>` : ''}
      ${w.ex && ui.exOpen.has(i) ? `<div class="extra"><div class="ex">${esc(w.ex.en)}<small>${esc(w.ex.ko)}</small></div></div>` : ''}
      </div>`).join('')}</div>` : (open ? '<p class="hint">이 Day는 새 단어 없이 복습만 있어요. 단어를 더 넣으면 여기에 채워져요.</p>' : '')}
    <div class="pager">
      <button class="btn ghost" id="prev" ${n > 1 ? '' : 'disabled'}>◀ Day ${n - 1 || ''}</button>
      <button class="btn ghost" id="next" ${n < plan.length && isOpen(f, plan, n + 1) ? '' : 'disabled'}>Day ${n + 1} ▶</button>
    </div>`;
  document.querySelectorAll('[data-task]').forEach(b => b.onclick = () => {
    const t = tasks[+b.dataset.task], items = itemsFor(f, t.ids, t.onlyWrong);
    if (!items.length) { if (!t.done) { markDone(f, n, t.kind, t.ids); save(); } return day(); }
    startTest(items, { fid: f.id, n, kind: t.done ? 'practice' : t.kind, ids: t.ids }, `Day ${n} ${taskName(t)}${t.done ? ' 연습' : ''}`);
  });
  document.querySelectorAll('[data-ko]').forEach(el => el.onclick = () => {
    const i = +el.dataset.ko; ui.shown.has(i) ? ui.shown.delete(i) : ui.shown.add(i);
    document.querySelectorAll(`[data-ko="${i}"]`).forEach(x => x.classList.toggle('hidden', hidden(i)));
  });
  const keepScroll = async fn => { const y = scrollY; await fn(); day(); scrollTo(0, y); };
  document.querySelectorAll('[data-rel]').forEach(b => b.onclick = () => keepScroll(() => makeRelated(words[+b.dataset.rel])));
  document.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => keepScroll(async () => {
    const i = +b.dataset.ex, w = words[i];
    if (ui.exOpen.has(i)) return ui.exOpen.delete(i);
    if (!w.ex) await makeExample(w);
    if (w.ex) ui.exOpen.add(i);
  }));
  $('#toggle-all')?.addEventListener('click', () => { ui.hideAll = !ui.hideAll; ui.shown = new Set(); day(); });
  $('#prev').onclick = () => openDay(n - 1);
  $('#next').onclick = () => openDay(n + 1);
  bindGo();
}

// Swipe left/right to flip Days.
let touchX = null;
document.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', e => {
  if (ui.view !== 'day' || touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) > 80) { const b = $(dx < 0 ? '#next' : '#prev'); if (b && !b.disabled) b.click(); }
});

function settings() {
  const s = db.settings;
  $('#app').innerHTML = `
    <header><button class="icon-btn" data-go="home" aria-label="뒤로">←</button><h1>설정</h1></header>
    <label for="model">AI 모델</label>
    <select id="model">
      ${[['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite · 무료'], ['gemini-3-flash-preview', 'Gemini 3 Flash · 무료, 더 똑똑함'],
         ['claude-haiku-5-5', 'Claude Haiku 5.5 · 유료, 저렴'], ['claude-opus-5-5', 'Claude Opus 5.5 · 유료, 가장 정확']]
        .map(([v, t]) => `<option value="${v}" ${s.model === v ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <label for="gkey">Gemini API 키</label>
    <input id="gkey" type="password" autocomplete="off" placeholder="AIza..." value="${esc(s.geminiKey)}">
    <p class="hint">aistudio.google.com → Get API key에서 무료로 만들 수 있어요. 이 기기에만 저장돼요.</p>
    <label for="key">Claude API 키 <small>(Claude 모델 쓸 때만)</small></label>
    <input id="key" type="password" autocomplete="off" placeholder="sk-ant-..." value="${esc(s.apiKey)}">
    <label for="per">하루 단어 수</label>
    <input id="per" type="number" min="1" max="200" inputmode="numeric" value="${s.perDay}">
    <p class="hint">아직 1차 시험을 안 본 Day부터 적용돼요.</p>
    <label>백업</label>
    <div class="toolbar">
      <button class="btn ghost" id="backup">백업 파일 저장</button>
      <button class="btn ghost" id="load">백업 불러오기</button>
    </div>
    <p class="hint">Safari 데이터를 지우면 단어장도 지워져요. 가끔 백업해두세요. (API 키는 백업 파일에 안 들어가요)</p>
    <button class="btn big" id="save-set" style="margin-top:24px">저장</button>`;
  $('#save-set').onclick = () => {
    const per = Math.round(+$('#per').value);
    if (!(per >= 1 && per <= 200)) return alert('하루 단어 수는 1~200 사이로 넣어주세요.');
    Object.assign(s, { apiKey: $('#key').value.trim(), geminiKey: $('#gkey').value.trim(), model: $('#model').value, perDay: per });
    save(); ui.view = 'home'; render();
  };
  $('#backup').onclick = () => {
    const { apiKey, geminiKey } = db.settings; Object.assign(db.settings, { apiKey: '', geminiKey: '' });
    try { exportBackup(); } finally { Object.assign(db.settings, { apiKey, geminiKey }); }
  };
  $('#load').onclick = () => $('#restore').click();
  bindGo();
}

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
