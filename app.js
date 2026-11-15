'use strict';

// ---------- storage ----------
// shortcut: everything lives in one localStorage JSON (~5MB limit, ~tens of thousands of words); move to IndexedDB if it ever fills up.
const KEY = 'wordking';
const DEFAULT_DB = {
  settings: { apiKey: '', model: 'claude-haiku-5-5', perDay: 30 },
  folders: [{ id: 'daily', name: 'DailyWord' }, { id: 'exam', name: 'ExamWord' }],
  pages: [] // { id, folderId, day, createdAt, words: [{ en, ko }] }
};
let db;
try { db = JSON.parse(localStorage.getItem(KEY)) || structuredClone(DEFAULT_DB); }
catch { db = structuredClone(DEFAULT_DB); }
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

// ---------- Claude API ----------
async function claude(system, content, schema) {
  const s = db.settings;
  if (!s.apiKey) throw new Error('설정(⚙︎)에서 API 키를 먼저 넣어주세요.');
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
      const out = await claude(EXTRACT_SYSTEM, [
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
    db = data; save(); ui.view = 'home'; render();
  } catch { alert('WordKing 백업 파일이 아니에요.'); }
});

// ---------- views ----------
function render() { ({ home, review, page, settings })[ui.view](); window.scrollTo(0, 0); }

function home() {
  if (!db.folders.some(f => f.id === ui.folderId)) ui.folderId = db.folders[0].id;
  const pages = folderPages(ui.folderId);
  $('#app').innerHTML = `
    <header><h1>Word<span>King</span></h1><button class="icon-btn" data-go="settings" aria-label="설정">⚙︎</button></header>
    <div class="tabs">
      ${db.folders.map(f => `<button class="tab ${f.id === ui.folderId ? 'on' : ''}" data-folder="${f.id}">${esc(f.name)}</button>`).join('')}
      <button class="tab" id="add-folder">＋ 폴더</button>
    </div>
    <button class="btn big" id="snap">📷 사진으로 단어 추가</button>
    <div class="list">
      ${pages.length ? pages.map(p => `
        <button class="row" data-page="${p.id}"><b>Day ${p.day}</b><span>${p.words.length}단어</span>
        <small>${new Date(p.createdAt).toLocaleDateString('ko-KR')}</small></button>`).join('')
      : `<div class="empty">아직 단어장이 없어요.<br>단어가 적힌 페이지를 찍어보세요.</div>`}
    </div>`;
  $('#snap').onclick = () => $('#photo').click();
  $('#add-folder').onclick = () => {
    const name = prompt('새 폴더 이름')?.trim();
    if (!name) return;
    const f = { id: uid(), name }; db.folders.push(f); save(); ui.folderId = f.id; render();
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

function openPage(id) { ui.pageId = id; ui.view = 'page'; ui.hideAll = false; ui.shown = new Set(); render(); }

function page() {
  const p = db.pages.find(x => x.id === ui.pageId);
  if (!p) { ui.view = 'home'; return render(); }
  const list = folderPages(p.folderId), idx = list.indexOf(p);
  const hidden = i => ui.hideAll !== ui.shown.has(i); // tapping a word flips it against the page-wide setting
  $('#app').innerHTML = `
    <header><button class="icon-btn" data-go="home" aria-label="뒤로">←</button>
      <h1>Day ${p.day}</h1><small>${idx + 1} / ${list.length}</small></header>
    <div class="toolbar">
      <button class="btn ghost" id="toggle-all">${ui.hideAll ? '뜻 전부 보기' : '뜻 전부 가리기'}</button>
      <button class="btn danger" id="del-page">이 페이지 삭제</button>
    </div>
    <div class="sheet">${p.words.map((w, i) => `
      <div class="word"><span class="n">${i + 1}</span><span class="en">${esc(w.en)}</span>
      <span class="ko ${hidden(i) ? 'hidden' : ''}" data-ko="${i}">${esc(w.ko)}</span></div>`).join('')}</div>
    <div class="pager">
      <button class="btn ghost" id="prev" ${idx ? '' : 'disabled'}>◀ 이전</button>
      <button class="btn ghost" id="next" ${idx < list.length - 1 ? '' : 'disabled'}>다음 ▶</button>
    </div>`;
  document.querySelectorAll('[data-ko]').forEach(el => el.onclick = () => {
    const i = +el.dataset.ko; ui.shown.has(i) ? ui.shown.delete(i) : ui.shown.add(i); el.classList.toggle('hidden', hidden(i));
  });
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
    <label for="key">Claude API 키</label>
    <input id="key" type="password" autocomplete="off" placeholder="sk-ant-..." value="${esc(s.apiKey)}">
    <p class="hint">platform.claude.com → API Keys에서 만든 키. 이 아이패드에만 저장돼요.</p>
    <label for="model">AI 모델</label>
    <select id="model">
      <option value="claude-haiku-5-5" ${s.model === 'claude-haiku-5-5' ? 'selected' : ''}>Haiku 5.5 · 아주 저렴</option>
      <option value="claude-opus-5-5" ${s.model === 'claude-opus-5-5' ? 'selected' : ''}>Opus 5.5 · 더 정확, 더 비쌈</option>
    </select>
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
    Object.assign(s, { apiKey: $('#key').value.trim(), model: $('#model').value, perDay: per });
    save(); ui.view = 'home'; render();
  };
  $('#backup').onclick = () => {
    const key = db.settings.apiKey; db.settings.apiKey = '';
    try { exportBackup(); } finally { db.settings.apiKey = key; }
  };
  $('#load').onclick = () => $('#restore').click();
  bindGo();
}

function bindGo() { document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { ui.view = b.dataset.go; render(); }); }

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
