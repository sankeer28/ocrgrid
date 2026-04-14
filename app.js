// ═══════════════════════════════════════════════════════════════
// OCRGRID — app.js  (Supabase + Tesseract.js)
// ═══════════════════════════════════════════════════════════════

const S = {
  roomCode:      null,
  uid:           localStorage.getItem('ocrgrid_uid') || uid8(),
  columns:       new Map(),   // colId → col row
  images:        new Map(),   // imgId → img row  (also pending)
  activeColId:   null,
  query:         '',
  searchOpen:    false,
  ocrWorker:     null,
  ocrReady:      false,
  imgChannel:    null,
  colChannel:    null,
};
localStorage.setItem('ocrgrid_uid', S.uid);

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
const $  = id => document.getElementById(id);

// ════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  initOCR();
  bindEvents();
  const code = new URLSearchParams(location.search).get('room');
  if (code && /^[A-Z0-9]{6}$/i.test(code)) joinRoom(code.toUpperCase());
  else show('landing');
});

// ════════════════════════════════════════════════════════════
// OCR (Tesseract.js — local)
// ════════════════════════════════════════════════════════════
async function initOCR() {
  try {
    S.ocrWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
    S.ocrReady  = true;
  } catch (e) { console.error('[OCR]', e); }
}

async function runOCR(dataUrl) {
  if (!S.ocrReady) {
    await new Promise((res, rej) => {
      let t = 0;
      const iv = setInterval(() => {
        if (S.ocrReady) { clearInterval(iv); res(); }
        if (++t > 300)  { clearInterval(iv); rej(new Error('OCR timeout')); }
      }, 100);
    });
  }
  const { data: { text } } = await S.ocrWorker.recognize(dataUrl);
  return text.trim();
}

// ════════════════════════════════════════════════════════════
// EVENTS
// ════════════════════════════════════════════════════════════
function bindEvents() {
  $('btn-create').addEventListener('click', () => joinRoom(genCode()));
  $('btn-join').addEventListener('click', handleJoin);
  $('input-code').addEventListener('keydown', e => e.key === 'Enter' && handleJoin());
  $('input-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('file-input').addEventListener('change', e => {
    [...e.target.files].forEach(f => processFile(f));
    e.target.value = '';
  });

  $('btn-copy').addEventListener('click', copyLink);
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-search-close').addEventListener('click', closeSearch);
  $('search-input').addEventListener('input', e => { S.query = e.target.value; applySearch(); });

  // Add column
  $('btn-add-col').addEventListener('click', openColPrompt);
  $('col-prompt-ok').addEventListener('click', confirmColPrompt);
  $('col-prompt-cancel').addEventListener('click', closeColPrompt);
  $('col-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmColPrompt();
    if (e.key === 'Escape') closeColPrompt();
  });

  // Lightbox
  $('lb-backdrop').addEventListener('click', closeLightbox);
  $('lb-close').addEventListener('click', closeLightbox);

  // Drag & drop on board (go to active column)
  const board = $('board');
  board.addEventListener('dragover',  e => { e.preventDefault(); });
  board.addEventListener('drop', e => {
    e.preventDefault();
    [...e.dataTransfer.files].filter(f => f.type.startsWith('image/')).forEach(processFile);
  });

  // Paste
  document.addEventListener('paste', e => {
    if (!S.roomCode) return;
    const imgs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    imgs.forEach(i => { const f = i.getAsFile(); if (f) processFile(f); });
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); if (S.roomCode) openSearch(); }
    if (e.key === 'Escape') {
      if (!$('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
      if (S.searchOpen) closeSearch();
    }
  });
}

// ════════════════════════════════════════════════════════════
// ROOM
// ════════════════════════════════════════════════════════════
function handleJoin() {
  const v = $('input-code').value.trim().toUpperCase();
  if (v.length !== 6) { shake($('input-code')); return; }
  joinRoom(v);
}

async function joinRoom(code) {
  S.roomCode = code;
  $('room-code-display').textContent = code;
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.pushState({}, '', url);
  show('app');
  initBoardScrollbar();

  // Load columns
  const { data: cols } = await sb
    .from('columns').select('*')
    .eq('room_code', code)
    .order('position', { ascending: true });
  (cols || []).forEach(col => { S.columns.set(col.id, col); renderColumn(col); });

  // Load images
  const { data: imgs } = await sb
    .from('images').select('*')
    .eq('room_code', code)
    .order('uploaded_at', { ascending: true });
  (imgs || []).forEach(img => { S.images.set(img.id, img); appendImgCard(img); });

  // Realtime: images
  S.imgChannel = sb.channel('imgs-' + code)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'images', filter: `room_code=eq.${code}` },
      ({ new: row }) => {
        if (S.images.has(row.id)) {
          // Our own pending card — upgrade it with confirmed data
          S.images.set(row.id, row);
          const el = document.querySelector(`.img-card[data-id="${row.id}"]`);
          if (el) finaliseImgCard(el, row);
        } else {
          // Someone else's image
          S.images.set(row.id, row);
          appendImgCard(row);
        }
        syncColCounts();
        if (S.searchOpen) applySearch();
      })
    .subscribe();

  // Realtime: columns
  S.colChannel = sb.channel('cols-' + code)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'columns', filter: `room_code=eq.${code}` },
      ({ new: col }) => {
        if (!S.columns.has(col.id)) {
          S.columns.set(col.id, col);
          renderColumn(col);
        }
      })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'columns', filter: `room_code=eq.${code}` },
      ({ new: col }) => {
        S.columns.set(col.id, col);
        const nameEl = document.querySelector(`.col[data-col-id="${col.id}"] .col-name`);
        if (nameEl) nameEl.textContent = col.name;
      })
    .subscribe();
}

function leaveRoom() {
  S.imgChannel?.unsubscribe();
  S.colChannel?.unsubscribe();
  S.imgChannel = S.colChannel = null;
  S.roomCode = S.activeColId = null;
  S.columns.clear(); S.images.clear();

  // Remove all columns from DOM
  document.querySelectorAll('.col').forEach(c => c.remove());

  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.pushState({}, '', url);
  $('input-code').value = '';
  show('landing');
}

// ════════════════════════════════════════════════════════════
// COLUMNS
// ════════════════════════════════════════════════════════════
function openColPrompt() {
  $('col-prompt').classList.remove('hidden');
  $('col-name-input').value = '';
  $('col-name-input').focus();
}
function closeColPrompt() { $('col-prompt').classList.add('hidden'); }

async function confirmColPrompt() {
  const name = $('col-name-input').value.trim() || 'Column';
  closeColPrompt();
  const position = S.columns.size;
  const { data, error } = await sb.from('columns').insert({
    room_code:  S.roomCode,
    name,
    created_by: S.uid,
    position,
  }).select().single();
  if (!error && data) {
    S.columns.set(data.id, data);
    renderColumn(data);
    setActiveCol(data.id);
  }
}

function renderColumn(col) {
  const board = $('board');
  const addBtn = $('btn-add-col');

  const el = document.createElement('div');
  el.className = 'col';
  el.dataset.colId = col.id;
  el.innerHTML = `
    <div class="col-resize"></div>
    <div class="col-header" title="Click to select · Double-click name to rename">
      <span class="col-active-dot"></span>
      <span class="col-name">${esc(col.name)}</span>
      <span class="col-count">0</span>
    </div>
    <div class="col-images">
      <div class="col-empty">Click to select,<br>then paste or upload</div>
    </div>
    <div class="col-drop-hint">↑ paste / drop here</div>`;

  initColResize(el);

  // Click header → activate column
  el.querySelector('.col-header').addEventListener('click', () => setActiveCol(col.id));

  // Double-click name → inline rename
  el.querySelector('.col-name').addEventListener('dblclick', e => {
    e.stopPropagation();
    startRename(el, col.id);
  });

  // Drop on this specific column
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('active'); setActiveCol(col.id); });
  el.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    [...e.dataTransfer.files].filter(f => f.type.startsWith('image/')).forEach(processFile);
  });

  board.insertBefore(el, addBtn);
}

function startRename(colEl, colId) {
  const nameEl = colEl.querySelector('.col-name');
  const current = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'col-name-input';
  input.value = current;
  nameEl.replaceWith(input);
  input.focus(); input.select();

  const finish = async () => {
    const newName = input.value.trim() || current;
    const span = document.createElement('span');
    span.className = 'col-name';
    span.textContent = newName;
    span.addEventListener('dblclick', e => { e.stopPropagation(); startRename(colEl, colId); });
    input.replaceWith(span);
    if (newName !== current) {
      await sb.from('columns').update({ name: newName }).eq('id', colId);
    }
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function setActiveCol(colId) {
  S.activeColId = colId;
  document.querySelectorAll('.col').forEach(el => {
    el.classList.toggle('active', el.dataset.colId === colId);
  });
}

function syncColCounts() {
  document.querySelectorAll('.col').forEach(colEl => {
    const colId = colEl.dataset.colId;
    const count = document.querySelectorAll(`.img-card[data-col-id="${colId}"]`).length;
    const countEl = colEl.querySelector('.col-count');
    if (countEl) countEl.textContent = count;
    const emptyEl = colEl.querySelector('.col-empty');
    if (emptyEl) emptyEl.style.display = count > 0 ? 'none' : '';
  });
}

// ════════════════════════════════════════════════════════════
// UPLOAD + OCR
// ════════════════════════════════════════════════════════════
async function processFile(file) {
  if (!S.roomCode || !file.type.startsWith('image/')) return;
  if (!S.activeColId) {
    flashNoCol(); return;
  }

  const id      = crypto.randomUUID();
  const preview = URL.createObjectURL(file);
  const colId   = S.activeColId;

  // Register as pending BEFORE appending so realtime won't duplicate
  S.images.set(id, { id, image_data: preview, file_name: file.name, ocr_text: '', column_id: colId, _pending: true });
  appendImgCard(S.images.get(id));
  syncColCounts();

  try {
    const imageData = await toBase64(file);
    const ocrText   = await runOCR(imageData).catch(() => '');
    URL.revokeObjectURL(preview);

    const { error } = await sb.from('images').insert({
      id,
      room_code:   S.roomCode,
      column_id:   colId,
      image_data:  imageData,
      file_name:   file.name,
      ocr_text:    ocrText,
      uploader_id: S.uid,
    });
    if (error) throw error;
  } catch (err) {
    console.error('[upload]', err);
    URL.revokeObjectURL(preview);
    S.images.delete(id);
    const el = document.querySelector(`.img-card[data-id="${id}"]`);
    el?.remove();
    syncColCounts();
  }
}

async function toBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 900;
      let { width: w, height: h } = img;
      if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w*s); h = Math.round(h*s); }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(src);
      resolve(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('load failed')); };
    img.src = src;
  });
}

function flashNoCol() {
  const btn = $('btn-add-col');
  btn.style.borderColor = '#F87171';
  btn.style.color       = '#F87171';
  setTimeout(() => { btn.style.borderColor = ''; btn.style.color = ''; }, 1200);
}

// ════════════════════════════════════════════════════════════
// IMAGE CARD RENDERING
// ════════════════════════════════════════════════════════════
function appendImgCard(row) {
  const colId = row.column_id;
  const colEl = document.querySelector(`.col[data-col-id="${colId}"]`);
  if (!colEl) return;

  const list = colEl.querySelector('.col-images');
  const card = document.createElement('div');
  card.className = 'img-card';
  card.dataset.id    = row.id;
  card.dataset.colId = colId;
  card.innerHTML = imgCardHTML(row);
  list.appendChild(card);
  requestAnimationFrame(() => card.classList.add('in'));

  // Click image → lightbox
  card.querySelector('.img-wrap').addEventListener('click', () => openLightbox(row.id));
  syncColCounts();
}

function finaliseImgCard(el, row) {
  el.innerHTML = imgCardHTML(row);
  el.classList.add('in');
  el.querySelector('.img-wrap').addEventListener('click', () => openLightbox(row.id));
  if (S.query) applySearchToCard(el, row, S.query.toLowerCase());
}

function imgCardHTML(row) {
  const pending = !!row._pending;
  const src     = row.image_data || '';
  const name    = esc(trunc(row.file_name || 'image', 32));

  const imgWrap = `<div class="img-wrap${pending ? ' scanning' : ''}">
    <img src="${src}" alt="${name}" loading="lazy">
    ${pending ? '<div class="scan-label">processing</div>' : ''}
  </div>`;

  let ocrEl;
  if (pending) {
    ocrEl = `<span class="img-ocr-scan">reading text…</span>`;
  } else if (row.ocr_text) {
    ocrEl = `<div class="img-ocr-text">${esc(row.ocr_text)}</div>`;
  } else {
    ocrEl = `<span class="img-ocr-empty">no text found</span>`;
  }

  return `${imgWrap}<div class="img-ocr">${ocrEl}</div>`;
}

// ════════════════════════════════════════════════════════════
// LIGHTBOX
// ════════════════════════════════════════════════════════════
function openLightbox(imgId) {
  const row = S.images.get(imgId);
  if (!row || row._pending) return;
  $('lb-img').src  = row.image_data || '';
  $('lb-text').textContent = row.ocr_text || '(no text found)';
  $('lightbox').classList.remove('hidden');
}
function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lb-img').src = '';
}

// ════════════════════════════════════════════════════════════
// SEARCH
// ════════════════════════════════════════════════════════════
function openSearch() {
  S.searchOpen = true;
  $('search-bar').classList.add('open');
  $('search-input').focus();
  $('search-input').select();
}
function closeSearch() {
  S.searchOpen = false; S.query = '';
  $('search-bar').classList.remove('open');
  $('search-input').value = '';
  $('search-count').textContent = '';
  clearSearchStates();
}

function applySearch() {
  if (!S.query) { clearSearchStates(); $('search-count').textContent = ''; return; }
  const q = S.query.toLowerCase();
  let hits = 0;
  const colHits = new Set();

  document.querySelectorAll('.img-card').forEach(card => {
    const row = S.images.get(card.dataset.id);
    if (!row || row._pending) { card.classList.remove('search-hit', 'search-miss'); return; }
    const match = row.ocr_text?.toLowerCase().includes(q);
    card.classList.toggle('search-hit',  !!match);
    card.classList.toggle('search-miss', !match);
    if (match) { hits++; colHits.add(card.dataset.colId); applySearchToCard(card, row, q); }
    else restoreOCREl(card, row);
  });

  // Dim columns with no hits
  document.querySelectorAll('.col').forEach(col => {
    col.classList.toggle('col-search-miss', !colHits.has(col.dataset.colId));
  });

  $('search-count').textContent = hits ? `${hits} match${hits > 1 ? 'es' : ''}` : 'no matches';
}

function applySearchToCard(card, row, q) {
  const ocrDiv = card.querySelector('.img-ocr-text');
  if (!ocrDiv || !row.ocr_text) return;
  const lower = row.ocr_text.toLowerCase();
  const idx   = lower.indexOf(q);
  if (idx === -1) return;
  const s    = Math.max(0, idx - 60);
  const e    = Math.min(row.ocr_text.length, idx + q.length + 60);
  const snip = `${s > 0 ? '…' : ''}${esc(row.ocr_text.slice(s, idx))}<mark>${esc(row.ocr_text.slice(idx, idx + q.length))}</mark>${esc(row.ocr_text.slice(idx + q.length, e))}${e < row.ocr_text.length ? '…' : ''}`;
  ocrDiv.innerHTML = snip;
}

function restoreOCREl(card, row) {
  const ocrDiv = card.querySelector('.img-ocr-text');
  if (ocrDiv) ocrDiv.textContent = row.ocr_text || '';
}

function clearSearchStates() {
  document.querySelectorAll('.img-card').forEach(card => {
    card.classList.remove('search-hit', 'search-miss');
    const row = S.images.get(card.dataset.id);
    if (row) restoreOCREl(card, row);
  });
  document.querySelectorAll('.col').forEach(col => col.classList.remove('col-search-miss'));
}

// ════════════════════════════════════════════════════════════
// BOARD SCROLLBAR SYNC (top navbar ↔ board)
// ════════════════════════════════════════════════════════════
function initBoardScrollbar() {
  const board   = $('board');
  const hscroll = $('board-hscroll');
  const inner   = $('board-hscroll-inner');

  const updateWidth = () => {
    inner.style.width = board.scrollWidth + 'px';
  };
  updateWidth();
  new ResizeObserver(updateWidth).observe(board);

  let syncing = false;
  hscroll.addEventListener('scroll', () => {
    if (syncing) return; syncing = true;
    board.scrollLeft = hscroll.scrollLeft;
    syncing = false;
  });
  board.addEventListener('scroll', () => {
    if (syncing) return; syncing = true;
    hscroll.scrollLeft = board.scrollLeft;
    syncing = false;
  });
}

// ════════════════════════════════════════════════════════════
// COLUMN RESIZE
// ════════════════════════════════════════════════════════════
function initColResize(colEl) {
  const handle = colEl.querySelector('.col-resize');
  let startX, startW;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startW = colEl.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = e => {
      const w = Math.max(220, Math.min(900, startW + (e.clientX - startX)));
      colEl.style.width = w + 'px';
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════
function show(screen) {
  $('landing').classList.toggle('hidden', screen !== 'landing');
  $('app').classList.toggle('hidden',     screen !== 'app');
}

async function copyLink() {
  try { await navigator.clipboard.writeText(location.href); } catch {}
  const btn = $('btn-copy');
  btn.textContent = 'copied!'; btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'copy link'; btn.classList.remove('copied'); }, 2000);
}

function shake(el) {
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 500);
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => c[b % c.length]).join('');
}

function uid8() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(36)).join('').slice(0, 8);
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function trunc(s, n) {
  return s && s.length > n ? s.slice(0, n) + '…' : (s || '');
}
