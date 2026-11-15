'use strict';

// ---------- storage ----------
// shortcut: everything lives in one localStorage JSON (~5MB limit, ~tens of thousands of words); move to IndexedDB if it ever fills up.
const KEY = 'wordking';
const DEFAULT_DB = {
  settings: { apiKey: '', geminiKey: '', model: 'gemini-3.5-flash-lite', perDay: 30 },
  folders: [{ id: 'daily', name: 'DailyWord' }, { id: 'exam', name: 'ExamWord' }],
  pages: [], // { id, folderId, day, createdAt, rounds: { r1, r2, r3 }, words: [{ en, ko, mark, wrong }] }
  log: [] // { date, folderId, pageId, kind } one entry per finished test, for the calendar
};
let db;
try { db = JSON.parse(localStorage.getItem(KEY)) || structuredClone(DEFAULT_DB); }
catch { db = structuredClone(DEFAULT_DB); }
db.log ||= [];
if (!db.settings.apiKey && db.settings.model.startsWith('claude')) db.settings.model = DEFAULT_DB.settings.model; // never set up Claude → free Gemini
const save = () => localStorage.setItem(KEY, JSON.stringify(db));
if (navigator.storage?.persist) navigator.storage.persist();

const ui = { view: 'home', folderId: 'daily', pageId: null, draft: [], hideAll: false, shown: new Set() };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
console.assert(JSON.stringify(chunk([1, 2, 3, 4, 5], 2)) === '[[1,2],[3,4],[5]]', 'chunk');

function busy(msg) { $('#busy').classList.toggle('on', !!msg); $('#busy-msg').textContent = msg || ''; }
const folderPages = fid => db.pages.filter(p => p.folderId === fid).sort((a, b) => a.day - b.day);

// ---------- dates & review schedule ----------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date, compares as a string
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const maxDate = (a, b) => (a > b ? a : b);
const md = s => `${+s.slice(5, 7)}/${+s.slice(8)}`;
console.assert(addDays('2026-02-28', 1) === '2026-03-01' && addDays('2026-12-31', 1) === '2027-01-01', 'addDays');

const ROUND = { r1: '1차 시험', r2: '복습1', r3: '복습2', big: '오답 총복습', practice: '연습' };
const DONE_TEXT = ['학습 전', '1차 완료', '복습1 완료', '복습2 완료'];
// Day page flow: r1 on study day (all words) → r2 next day (all words) → r3 the day after (ever-wrong words only).
function nextRound(p) {
  const r = p.rounds ||= {};
  if (!r.r1) return { kind: 'r1', due: today() };
  if (!r.r2) return { kind: 'r2', due: addDays(r.r1, 1) };
  if (!r.r3) return { kind: 'r3', due: maxDate(addDays(r.r1, 2), addDays(r.r2, 1)) };
  return null;
}
const doneSteps = p => ['r1', 'r2', 'r3'].filter(k => p.rounds?.[k]).length;
// Test items: { pid, wi } for a word, plus s ('syn' | 'ant') and k for its synonyms/antonyms, which are tested as words too.
function pageItems(p, onlyWrong = false) {
  return p.words.flatMap((w, wi) => [{ pid: p.id, wi }, ...['syn', 'ant'].flatMap(s => (w[s] || []).map((_, k) => ({ pid: p.id, wi, s, k })))])
    .filter(it => !onlyWrong || wordOf(it).wrong);
}

// Folder-wide 오답 총복습 every 5 days, counted from the first 1차 시험 (then from the last 총복습).
function bigDue(fid) {
  const firsts = folderPages(fid).map(p => p.rounds?.r1).filter(Boolean).sort();
  if (!firsts.length) return null;
  const f = db.folders.find(x => x.id === fid);
  return addDays(f.lastBig || firsts[0], 5);
}
const bigItems = fid => folderPages(fid).flatMap(p => pageItems(p, true));

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
Skip page numbers, headings, and example sentences. Do not add words that are not in the photo.`;
const WORDS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['words'],
  properties: { words: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['en', 'ko'],
    properties: { en: { type: 'string' }, ko: { type: 'string' } }
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
      ], WORDS_SCHEMA);
      found.push(...out.words.filter(w => w.en.trim()));
    }
    if (!found.length) throw new Error('사진에서 영단어를 찾지 못했어요.');
    ui.draft = found; ui.view = 'review';
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

// items: [{ pid, wi }] so one test can span pages (오답 총복습). kind: r1 | r2 | r3 | big | practice.
function startTest(items, kind, title, back) {
  ui.test = { items, kind, title, back, i: 0, answers: [], result: null };
  ui.view = 'test'; render();
}
const wordOf = it => { const w = db.pages.find(p => p.id === it.pid)?.words[it.wi]; return it.s ? w?.[it.s]?.[it.k] : w; };

// Starts whatever the page needs next: the due round, or a practice test if nothing is due yet.
function startPageTest(p) {
  const nr = nextRound(p);
  const back = { view: 'page', pageId: p.id };
  if (nr && nr.due <= today()) {
    const items = pageItems(p, nr.kind === 'r3');
    if (!items.length) { // nothing ever wrong → 복습2 has no words, count it as done
      p.rounds.r3 = today(); db.log.push({ date: today(), folderId: p.folderId, pageId: p.id, kind: 'r3' }); save();
      alert('틀린 단어가 없어서 복습2 완료!'); return render();
    }
    return startTest(items, nr.kind, `Day ${p.day} ${ROUND[nr.kind]}`, back);
  }
  startTest(pageItems(p), 'practice', `Day ${p.day} 연습`, back);
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
    const first = db.pages.find(p => p.id === t.items[0].pid);
    if (t.kind.startsWith('r')) first.rounds[t.kind] = today();
    if (t.kind === 'big') db.folders.find(f => f.id === first.folderId).lastBig = today();
    db.log.push({ date: today(), folderId: first.folderId, pageId: t.kind === 'big' ? null : first.id, kind: t.kind });
    save(); t.result = g;
  } catch (err) { alert(err.message); }
  busy(); render();
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
    if (!Array.isArray(data.pages) || !Array.isArray(data.folders) || !data.settings) throw 0;
    if (!confirm('지금 데이터가 백업 파일 내용으로 바뀌어요. 계속할까요?')) return;
    data.settings.apiKey ||= db.settings.apiKey;
    data.settings.geminiKey ||= db.settings.geminiKey;
    db = data; save(); ui.view = 'home'; render();
  } catch { alert('WordKing 백업 파일이 아니에요.'); }
});

// ---------- views ----------
function render() { ({ home, review, page, settings, test, calendar })[ui.view](); window.scrollTo(0, 0); }

// Month grid: green = tests done that day, orange = reviews due, red = overdue. Tap a date for details.
function dayEvents(date) {
  const t = today(), ev = [];
  const name = fid => db.folders.find(f => f.id === fid)?.name ?? '';
  for (const l of db.log.filter(l => l.date === date)) {
    const p = db.pages.find(x => x.id === l.pageId);
    if (l.pageId && !p) continue;
    ev.push({ type: 'done', text: `${name(l.folderId)} ${p ? `Day ${p.day} ` : ''}${ROUND[l.kind]} 완료`, pid: p?.id });
  }
  for (const p of db.pages) {
    const nr = nextRound(p);
    if (!nr || nr.kind === 'r1') continue;
    if (nr.due === date || (date === t && nr.due < t)) ev.push({ type: nr.due < t ? 'late' : 'due', text: `${name(p.folderId)} Day ${p.day} ${ROUND[nr.kind]}${nr.due < t ? ' (밀림)' : ''}`, pid: p.id });
  }
  for (const f of db.folders) {
    const bd = bigDue(f.id);
    if (bd && bigItems(f.id).length && (bd === date || (date === t && bd < t))) ev.push({ type: bd < t ? 'late' : 'due', text: `${f.name} 오답 총복습`, fid: f.id });
  }
  return ev;
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
      ${cells.map(c => {
        if (!c) return '<div></div>';
        const ev = dayEvents(c), has = k => ev.some(e => e.type === k);
        return `<button class="day ${c === t ? 'today' : ''} ${c === ui.calDay ? 'sel' : ''}" data-day="${c}">${+c.slice(8)}
          <span class="dots">${has('done') ? '<i class="done"></i>' : ''}${has('due') ? '<i class="due"></i>' : ''}${has('late') ? '<i class="late"></i>' : ''}</span></button>`;
      }).join('')}
    </div>
    <h2 class="cal-h">${md(ui.calDay)}${ui.calDay === t ? ' (오늘)' : ''}</h2>
    <div class="list">${sel.length ? sel.map((e, i) => `<button class="row ev ${e.type}" data-ev="${i}"><i></i>${esc(e.text)}</button>`).join('')
      : '<div class="empty">이 날은 기록이 없어요.</div>'}</div>`;
  $('#pm').onclick = () => shift(-1);
  $('#nm').onclick = () => shift(1);
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { ui.calDay = b.dataset.day; calendar(); });
  document.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => {
    const e = sel[+b.dataset.ev];
    if (e.pid) openPage(e.pid); else if (e.fid) { ui.folderId = e.fid; ui.view = 'home'; render(); }
  });
  bindGo();
}

const MARK = { tri: '<span class="mark tri" title="비슷함">△</span>', x: '<span class="mark x" title="틀림">—</span>', o: '<span class="mark o" title="맞음">○</span>' };

function test() {
  const t = ui.test;
  t.items = t.items.filter(wordOf); // a page may have been deleted
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
    const title = t.title.replace(/ (1차 시험|복습\d|연습)$/, '') + ' 연습';
    $('#retry-wrong')?.addEventListener('click', () => startTest(wrong, 'practice', title, t.back));
    $('#retry-all').onclick = () => startTest(t.items, 'practice', title, t.back);
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
  $('#quit').onclick = () => { if (!t.result && t.i && !confirm('시험을 그만둘까요? 기록이 안 남아요.')) return; Object.assign(ui, t.back); render(); };
}

// Progress pill: 0/3 grey → 1/3 orange → 2/3 yellow → 3/3 green.
const PILL = ['#9aa0a6', '#e67e22', '#e0b400', '#27ae60'];
function dayStatus(p) {
  const n = doneSteps(p), nr = nextRound(p), t = today();
  const due = nr && nr.kind !== 'r1' && nr.due <= t ? `<span class="duebadge">${nr.due < t ? '밀림' : '오늘'} ${ROUND[nr.kind]}</span>` : '';
  return `<span class="pill" style="background:${PILL[n]}">${Math.round(n / 3 * 100)}%</span><span class="st">${DONE_TEXT[n]}</span>${due}`;
}

function home() {
  if (!db.folders.some(f => f.id === ui.folderId)) ui.folderId = db.folders[0].id;
  const pages = folderPages(ui.folderId);
  const total = db.pages.reduce((n, p) => n + p.words.length, 0);
  const inFolder = pages.reduce((n, p) => n + p.words.length, 0);
  const bd = bigDue(ui.folderId), big = bigItems(ui.folderId);
  $('#app').innerHTML = `
    <header><h1>Word<span>King</span></h1>
      <button class="icon-btn" data-go="calendar" aria-label="달력">📅</button>
      <button class="icon-btn" data-go="settings" aria-label="설정">⚙︎</button></header>
    <div class="stat"><div><small>누적 단어</small><strong>${total.toLocaleString()}</strong></div>
      <span>이 폴더 ${inFolder.toLocaleString()}개 · Day ${pages.length}개</span></div>
    <div class="tabs">
      ${db.folders.map(f => `<button class="tab ${f.id === ui.folderId ? 'on' : ''}" data-folder="${f.id}">${esc(f.name)}</button>`).join('')}
      <button class="tab" id="add-folder">＋ 폴더</button>
    </div>
    ${bd && big.length ? `<button class="row bigrev ${bd <= today() ? 'now' : ''}" id="big">
      <b>🔥 오답 총복습</b><span>틀린 적 있는 단어 ${big.length}개</span>
      <small>${bd <= today() ? '오늘 할 차례!' : `${md(bd)} 예정 · 미리 연습`}</small></button>` : ''}
    <button class="btn big" id="snap">📷 사진으로 단어 추가</button>
    <div class="list">
      ${pages.length ? pages.map(p => `
        <button class="row" data-page="${p.id}"><b>Day ${p.day}</b><span>${p.words.length}단어</span>${dayStatus(p)}</button>`).join('')
      : `<div class="empty">아직 단어장이 없어요.<br>단어가 적힌 페이지를 찍어보세요.</div>`}
    </div>`;
  $('#big')?.addEventListener('click', () => {
    const f = db.folders.find(x => x.id === ui.folderId);
    startTest(big, bd <= today() ? 'big' : 'practice', `${f.name} 오답 총복습`, { view: 'home' });
  });
  $('#snap').onclick = () => $('#photo').click();
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
      const f = { id: uid(), name }; db.folders.push(f); save(); ui.folderId = f.id; render();
    };
  };
  document.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => { ui.folderId = b.dataset.folder; render(); });
  document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => openPage(b.dataset.page));
  bindGo();
}

function review() {
  const folder = db.folders.find(f => f.id === ui.folderId);
  const per = db.settings.perDay;
  $('#app').innerHTML = `
    <header><button class="icon-btn" id="cancel" aria-label="취소">✕</button><h1>단어 확인</h1></header>
    <p class="hint">${ui.draft.length}개를 찾았어요. 틀린 건 고치고 저장하세요.
      <b>${esc(folder.name)}</b>에 하루 ${per}개씩 Day ${Math.ceil(ui.draft.length / per)}개로 나눠 저장돼요.</p>
    <div id="edits">${ui.draft.map((w, i) => `
      <div class="edit"><input data-i="${i}" data-k="en" value="${esc(w.en)}" aria-label="영단어">
      <input data-i="${i}" data-k="ko" value="${esc(w.ko)}" aria-label="뜻">
      <button class="icon-btn" data-del="${i}" aria-label="삭제">✕</button></div>`).join('')}</div>
    <div class="toolbar"><button class="btn ghost" id="add-row">＋ 단어 추가</button></div>
    <button class="btn big" id="save">저장</button>`;
  document.querySelectorAll('[data-k]').forEach(inp => inp.oninput = () => { ui.draft[inp.dataset.i][inp.dataset.k] = inp.value; });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { ui.draft.splice(+b.dataset.del, 1); review(); });
  $('#add-row').onclick = () => { ui.draft.push({ en: '', ko: '' }); review(); };
  $('#cancel').onclick = () => { if (confirm('찾은 단어를 버릴까요?')) { ui.draft = []; ui.view = 'home'; render(); } };
  $('#save').onclick = () => {
    const words = ui.draft.map(w => ({ en: w.en.trim(), ko: w.ko.trim() })).filter(w => w.en);
    if (!words.length) return alert('저장할 단어가 없어요.');
    let day = Math.max(0, ...folderPages(ui.folderId).map(p => p.day));
    for (const part of chunk(words, per)) db.pages.push({ id: uid(), folderId: ui.folderId, day: ++day, createdAt: Date.now(), words: part });
    save(); ui.draft = []; ui.view = 'home'; render();
  };
}

function openPage(id) { ui.pageId = id; ui.view = 'page'; ui.hideAll = false; ui.shown = new Set(); ui.exOpen = new Set(); render(); }

function page() {
  const p = db.pages.find(x => x.id === ui.pageId);
  if (!p) { ui.view = 'home'; return render(); }
  const list = folderPages(p.folderId), idx = list.indexOf(p);
  const hidden = i => ui.hideAll !== ui.shown.has(i); // tapping a word flips it against the page-wide setting
  const nr = nextRound(p);
  const testLabel = !nr || nr.due > today() ? '연습 시험'
    : nr.kind === 'r3' ? `복습2 (틀린 단어 ${pageItems(p, true).length}개)` : `${ROUND[nr.kind]} (전체)`;
  $('#app').innerHTML = `
    <header><button class="icon-btn" data-go="home" aria-label="뒤로">←</button>
      <h1>Day ${p.day}</h1><small>${idx + 1} / ${list.length}</small></header>
    <div class="steps">${['r1', 'r2', 'r3'].map(k => p.rounds[k]
      ? `<span class="step done">✓ ${ROUND[k]} <small>${md(p.rounds[k])}</small></span>`
      : `<span class="step ${nr?.kind === k && nr.due <= today() ? 'now' : ''}">${ROUND[k]}${nr?.kind === k && k !== 'r1' ? ` <small>${nr.due <= today() ? '오늘' : md(nr.due)}</small>` : ''}</span>`).join('')}</div>
    <div class="toolbar">
      <button class="btn" id="start-test">✏️ ${testLabel}</button>
      <button class="btn ghost" id="toggle-all">${ui.hideAll ? '뜻 전부 보기' : '뜻 전부 가리기'}</button>
      <button class="btn danger" id="del-page">이 페이지 삭제</button>
    </div>
    <div class="sheet">${p.words.map((w, i) => `
      <div class="word"><span class="n">${w.mark && w.mark !== 'o' ? MARK[w.mark] : i + 1}</span><span class="en">${esc(w.en)}</span>
      <span class="ko ${hidden(i) ? 'hidden' : ''}" data-ko="${i}">${esc(w.ko)}</span>
      <div class="extra">
        ${['syn', 'ant'].flatMap(s => (w[s] || []).map(x => `<span class="chip ${s}">${x.mark && x.mark !== 'o' ? MARK[x.mark] : ''}<b>${esc(x.en)}</b>
          <span class="cko ${hidden(i) ? 'hidden' : ''}" data-ko="${i}">${esc(x.ko)}</span></span>`)).join('')}
        ${w.syn ? (w.syn.length + w.ant.length ? '' : '<span class="hint">유의어·반의어 없음</span>') : `<button class="mini" data-rel="${i}">유의어·반의어</button>`}
        <button class="mini" data-ex="${i}">${ui.exOpen?.has(i) ? '예문 닫기' : '예문'}</button>
        ${w.ex && ui.exOpen?.has(i) ? `<div class="ex">${esc(w.ex.en)}<small>${esc(w.ex.ko)}</small></div>` : ''}
      </div></div>`).join('')}</div>
    <div class="pager">
      <button class="btn ghost" id="prev" ${idx ? '' : 'disabled'}>◀ 이전</button>
      <button class="btn ghost" id="next" ${idx < list.length - 1 ? '' : 'disabled'}>다음 ▶</button>
    </div>`;
  document.querySelectorAll('[data-ko]').forEach(el => el.onclick = () => {
    const i = +el.dataset.ko; ui.shown.has(i) ? ui.shown.delete(i) : ui.shown.add(i);
    document.querySelectorAll(`[data-ko="${i}"]`).forEach(x => x.classList.toggle('hidden', hidden(i)));
  });
  const keepScroll = async fn => { const y = scrollY; await fn(); page(); scrollTo(0, y); };
  document.querySelectorAll('[data-rel]').forEach(b => b.onclick = () => keepScroll(() => makeRelated(p.words[+b.dataset.rel])));
  document.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => keepScroll(async () => {
    const i = +b.dataset.ex, w = p.words[i];
    ui.exOpen ||= new Set();
    if (ui.exOpen.has(i)) return ui.exOpen.delete(i);
    if (!w.ex) await makeExample(w);
    if (w.ex) ui.exOpen.add(i);
  }));
  $('#start-test').onclick = () => startPageTest(p);
  $('#toggle-all').onclick = () => { ui.hideAll = !ui.hideAll; ui.shown = new Set(); page(); };
  $('#del-page').onclick = () => {
    if (!confirm(`Day ${p.day} 페이지를 삭제할까요? 되돌릴 수 없어요.`)) return;
    db.pages = db.pages.filter(x => x !== p); save(); ui.view = 'home'; render();
  };
  const go = d => { const t = list[idx + d]; if (t) { const keep = ui.hideAll; openPage(t.id); ui.hideAll = keep; page(); } };
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  bindGo();
}

// Swipe left/right to flip notebook pages.
let touchX = null;
document.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', e => {
  if (ui.view !== 'page' || touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) > 80) $(dx < 0 ? '#next' : '#prev')?.click();
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
    <p class="hint">새로 저장하는 단어부터 적용돼요.</p>
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

function bindGo() { document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { ui.view = b.dataset.go; render(); }); }

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
