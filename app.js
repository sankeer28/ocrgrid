// ═══════════════════════════════════════════════════════════════
// OCRGRID — app.js  (Supabase + Scribe.js OCR + Tesseract fallback)
// ═══════════════════════════════════════════════════════════════

const S = {
  roomCode:      null,
  ip:            null,          // fetched on boot, used for ownership
  columns:       new Map(),   // colId → col row
  images:        new Map(),   // imgId → img row  (also pending)
  activeColId:   null,
  query:         '',
  searchOpen:    false,
  searchFocusId: null,
  ocrEngine:     null,
  scribe:        null,
  ocrWorker:     null,
  ocrReady:      false,
  imgChannel:    null,
  colChannel:    null,
};

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
const $  = id => document.getElementById(id);
const OCR_LANG = 'eng';
const OCR_TESS_LANG_PATH = 'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_best';
const OCR_TESS_ENGINE = (window.Tesseract?.OEM && Number.isInteger(Tesseract.OEM.LSTM_ONLY))
  ? Tesseract.OEM.LSTM_ONLY
  : 1;
const OCR_ALLOW_TESSERACT_FALLBACK = false;
const OCR_SCRIBE_OPTIONS = {
  mode: 'quality',
  modeAdv: 'lstm',
};

// ════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  initOCR();
  bindEvents();
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const { ip } = await res.json();
    S.ip = ip;
  } catch (e) {
    // fallback: random stable id stored in localStorage
    S.ip = localStorage.getItem('ocrgrid_uid') || uid8();
    localStorage.setItem('ocrgrid_uid', S.ip);
  }
  const code = new URLSearchParams(location.search).get('room');
  if (code && /^[A-Z0-9]{6}$/i.test(code)) joinRoom(code.toUpperCase());
  else show('landing');
});

// ════════════════════════════════════════════════════════════
// OCR (Scribe.js primary, Tesseract fallback)
// ════════════════════════════════════════════════════════════
async function initOCR() {
  try {
    // Scribe.js must be loaded from same origin. Use vendored path for local + Vercel.
    const scribeMod = await import('./vendor/scribe.js-ocr/scribe.js');
    S.scribe = scribeMod.default || scribeMod;
    S.ocrEngine = 'scribe';
    S.ocrReady = true;
    console.info('[OCR] Using Scribe.js');
    return;
  } catch (scribeErr) {
    console.warn('[OCR] Scribe.js unavailable; falling back to Tesseract.js', scribeErr);
  }

  try {
    S.ocrWorker = await Tesseract.createWorker(OCR_LANG, OCR_TESS_ENGINE, {
      logger: () => {},
      langPath: OCR_TESS_LANG_PATH,
    });
    S.ocrEngine = 'tesseract';
    S.ocrReady  = true;
    console.info('[OCR] Using Tesseract.js fallback');
  } catch (e) {
    console.error('[OCR]', e);
  }
}

async function runOCR(sourceFile, dataUrl) {
  if (!S.ocrReady) {
    await new Promise((res, rej) => {
      let t = 0;
      const iv = setInterval(() => {
        if (S.ocrReady) { clearInterval(iv); res(); }
        if (++t > 300)  { clearInterval(iv); rej(new Error('OCR timeout')); }
      }, 100);
    });
  }

  if (S.ocrEngine === 'scribe' && S.scribe?.extractText) {
    try {
      // Scribe expects File/Blob/path-like inputs, not data URLs.
      const raw = await S.scribe.extractText([sourceFile], [OCR_LANG], 'txt', OCR_SCRIBE_OPTIONS);
      const txt = normalizeScribeText(raw);
      if (txt) return txt;
      console.warn('[OCR] Scribe returned empty text');
      if (!OCR_ALLOW_TESSERACT_FALLBACK) return '';
      console.warn('[OCR] Falling back to Tesseract (enabled by config)');
    } catch (e) {
      console.warn('[OCR] Scribe failed', e);
      if (!OCR_ALLOW_TESSERACT_FALLBACK) return '';
      console.warn('[OCR] Falling back to Tesseract (enabled by config)');
    }
  }

  if (!S.ocrWorker) {
    throw new Error('Tesseract fallback is not ready');
  }
  const { data: { text } } = await S.ocrWorker.recognize(dataUrl);
  return text.trim();
}

function normalizeScribeText(raw) {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    const texts = raw
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean);
    return texts.join('\n').trim();
  }
  if (raw && typeof raw.text === 'string') return raw.text.trim();
  return '';
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
  $('btn-export').addEventListener('click', exportZip);
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
          S.images.set(row.id, row);
          const el = document.querySelector(`.img-card[data-id="${row.id}"]`);
          if (el) finaliseImgCard(el, row);
        } else {
          S.images.set(row.id, row);
          appendImgCard(row);
        }
        syncColCounts();
        if (S.searchOpen) applySearch();
      })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'images' },
      ({ old: row }) => {
        if (!S.images.has(row.id)) return;
        S.images.delete(row.id);
        document.querySelector(`.img-card[data-id="${row.id}"]`)?.remove();
        syncColCounts();
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
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'columns' },
      ({ old: col }) => {
        if (!S.columns.has(col.id)) return;
        S.columns.delete(col.id);
        document.querySelector(`.col[data-col-id="${col.id}"]`)?.remove();
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
    created_by: S.ip,
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
    <div class="col-resize" title="Drag to resize column">
      <svg class="col-resize-icon" viewBox="0 0 8 20" fill="currentColor">
        <circle cx="2" cy="5"  r="1.2"/><circle cx="6" cy="5"  r="1.2"/>
        <circle cx="2" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/>
        <circle cx="2" cy="15" r="1.2"/><circle cx="6" cy="15" r="1.2"/>
      </svg>
    </div>
    <div class="col-header">
      <span class="col-active-dot"></span>
      <span class="col-name">${esc(col.name)}</span>
      <span class="col-count">0</span>
      <span class="col-focus-badge">click to paste</span>
      ${col.created_by === S.ip ? '<button class="col-delete" title="Delete column">✕</button>' : ''}
    </div>
    <div class="col-images">
      <div class="col-empty">Click to select,<br>then paste (Ctrl+V)</div>
    </div>
    <div class="col-drop-hint">↑ paste here (Ctrl+V)</div>`;

  initColResize(el);

  // Click header → activate column
  el.querySelector('.col-header').addEventListener('click', () => setActiveCol(col.id));

  // Double-click name → inline rename
  el.querySelector('.col-name').addEventListener('dblclick', e => {
    e.stopPropagation();
    startRename(el, col.id);
  });

  // Delete column (owner only)
  el.querySelector('.col-delete')?.addEventListener('click', e => {
    e.stopPropagation();
    deleteColumn(col.id);
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
  S.images.set(id, { id, image_data: preview, file_name: file.name, ocr_text: '', column_id: colId, uploader_id: S.ip, _pending: true });
  appendImgCard(S.images.get(id));
  syncColCounts();

  try {
    const imageData = await toBase64(file);
    const ocrText   = await runOCR(file, imageData).catch(() => '');
    URL.revokeObjectURL(preview);

    const { error } = await sb.from('images').insert({
      id,
      room_code:   S.roomCode,
      column_id:   colId,
      image_data:  imageData,
      file_name:   file.name,
      ocr_text:    ocrText,
      uploader_id: S.ip,
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

  bindImgCardEvents(card, row);
  syncColCounts();
}

function finaliseImgCard(el, row) {
  el.innerHTML = imgCardHTML(row);
  el.classList.add('in');
  bindImgCardEvents(el, row);
  if (S.query) applySearchToCard(el, row, S.query.toLowerCase());
}

function bindImgCardEvents(card, row) {
  card.querySelector('.img-wrap').addEventListener('click', () => openLightbox(row.id));
  const delBtn = card.querySelector('.img-delete');
  if (delBtn) delBtn.addEventListener('click', e => { e.stopPropagation(); deleteImage(row.id); });
}

function imgCardHTML(row) {
  const pending = !!row._pending;
  const src     = row.image_data || '';
  const name    = esc(trunc(row.file_name || 'image', 32));
  const isOwner = row.uploader_id === S.ip;

  const imgWrap = `<div class="img-wrap${pending ? ' scanning' : ''}">
    <img src="${src}" alt="${name}" loading="lazy">
    ${pending ? '<div class="scan-label">processing</div>' : ''}
    ${isOwner && !pending ? '<button class="img-delete" title="Delete image">✕</button>' : ''}
  </div>`;

  let ocrEl;
  if (pending) {
    ocrEl = `<span class="img-ocr-scan">reading text…</span>`;
  } else if (row.ocr_text) {
    ocrEl = `<div class="img-ocr-text">${esc(row.ocr_text)}</div>`;
  } else {
    ocrEl = `<span class="img-ocr-empty">no text found</span>`;
  }

  const answerEl = pending ? '' : buildAnswerSummaryHTML(row.ocr_text || '');
  return `${imgWrap}<div class="img-ocr">${ocrEl}${answerEl}</div>`;
}

function buildAnswerSummaryHTML(ocrText) {
  const parsed = parseSelectedOption(ocrText);
  if (!parsed?.selectedText) return '';
  const label = parsed.optionIndex > -1 ? String.fromCharCode(65 + parsed.optionIndex) : '?';
  return `<div class="img-answer-pill"><span class="img-answer-k">selected</span><span class="img-answer-v">${esc(label)}. ${esc(parsed.selectedText)}</span></div>`;
}

function parseSelectedOption(text) {
  const src = (text || '').replace(/\r/g, ' ').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!src) return null;

  // Includes OCR variants where bubbles are read as (e)/(0) and empty circles as (D)/(d).
  const markerRx = /(\(o\)|\(O\)|\(e\)|\(E\)|\(0\)|\(\*\)|[@®]|[●◉]|\(D\)?|\(d\)?|\(\s*\)|[○◯]|\bO\b)/g;
  const selectedMarkers = new Set(['(o)', '(O)', '(e)', '(E)', '(0)', '(*)', '@', '®', '●', '◉']);
  const marks = [...src.matchAll(markerRx)];
  if (!marks.length) return null;

  const options = [];
  for (let i = 0; i < marks.length; i++) {
    const marker = marks[i][0];
    const normalizedMarker = marker.replace(/\s+/g, '');
    const start = marks[i].index + marker.length;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    let optionText = src.slice(start, end).trim();
    optionText = optionText.replace(/^[\-:.)\s]+/, '').trim();
    if (!optionText || optionText.length < 2) continue;

    options.push({
      marker,
      text: optionText,
      selected: selectedMarkers.has(normalizedMarker),
    });
  }

  if (!options.length) return null;
  const selected = options.find(o => o.selected);
  if (!selected) return null;

  return {
    selectedText: selected.text,
    optionIndex: options.indexOf(selected),
    options,
  };
}

// ════════════════════════════════════════════════════════════
// LIGHTBOX
// ════════════════════════════════════════════════════════════
function openLightbox(imgId) {
  const row = S.images.get(imgId);
  if (!row || row._pending) return;
  $('lb-img').src  = row.image_data || '';
  const parsed = parseSelectedOption(row.ocr_text || '');
  if (parsed?.selectedText) {
    $('lb-text').textContent = `[detected answer] ${parsed.selectedText}\n\n${row.ocr_text || '(no text found)'}`;
  } else {
    $('lb-text').textContent = row.ocr_text || '(no text found)';
  }
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
  S.searchFocusId = null;
  $('search-bar').classList.remove('open');
  $('search-input').value = '';
  $('search-count').textContent = '';
  clearSearchStates();
}

function applySearch() {
  if (!S.query) { clearSearchStates(); $('search-count').textContent = ''; return; }
  const q = S.query.toLowerCase();
  const exactHits = [];
  const fuzzyHits = [];
  const colHits = new Set();

  document.querySelectorAll('.img-card').forEach(card => {
    const row = S.images.get(card.dataset.id);
    if (!row || row._pending) {
      card.classList.remove('search-hit', 'search-miss', 'search-hit-active');
      return;
    }

    const text = row.ocr_text || '';
    const lower = text.toLowerCase();
    const exact = lower.includes(q);

    if (exact) {
      exactHits.push({ card, row, score: 1 });
      colHits.add(card.dataset.colId);
      card.classList.add('search-hit');
      card.classList.remove('search-miss');
      applySearchToCard(card, row, q);
      return;
    }

    const score = fuzzyScore(q, lower);
    if (score >= 0.62) {
      fuzzyHits.push({ card, row, score });
      colHits.add(card.dataset.colId);
      card.classList.add('search-hit');
      card.classList.remove('search-miss');
      applyFuzzySearchToCard(card, row, q, score);
    } else {
      card.classList.remove('search-hit', 'search-hit-active');
      card.classList.add('search-miss');
      restoreOCREl(card, row);
    }
  });

  const usingFuzzy = exactHits.length === 0;
  const activeHits = usingFuzzy ? fuzzyHits.sort((a, b) => b.score - a.score) : exactHits;
  setActiveSearchHit(activeHits[0]?.card || null);
  if (activeHits.length) scrollToSearchHit(activeHits[0].card);

  // Dim columns with no hits
  document.querySelectorAll('.col').forEach(col => {
    col.classList.toggle('col-search-miss', !colHits.has(col.dataset.colId));
  });

  if (activeHits.length === 0) {
    $('search-count').textContent = 'no matches';
  } else if (usingFuzzy) {
    $('search-count').textContent = `${activeHits.length} fuzzy match${activeHits.length > 1 ? 'es' : ''}`;
  } else {
    $('search-count').textContent = `${activeHits.length} match${activeHits.length > 1 ? 'es' : ''}`;
  }
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
    card.classList.remove('search-hit', 'search-miss', 'search-hit-active');
    const row = S.images.get(card.dataset.id);
    if (row) restoreOCREl(card, row);
  });
  document.querySelectorAll('.col').forEach(col => col.classList.remove('col-search-miss'));
}

function applyFuzzySearchToCard(card, row, q, score) {
  const ocrDiv = card.querySelector('.img-ocr-text');
  if (!ocrDiv || !row.ocr_text) return;
  const preview = esc(trunc(row.ocr_text, 180));
  ocrDiv.innerHTML = `${preview}<br><span class="img-ocr-empty">fuzzy ${(score * 100).toFixed(0)}%</span>`;
}

function setActiveSearchHit(card) {
  document.querySelectorAll('.img-card.search-hit-active').forEach(el => el.classList.remove('search-hit-active'));
  if (!card) {
    S.searchFocusId = null;
    return;
  }
  card.classList.add('search-hit-active');
  S.searchFocusId = card.dataset.id;
}

function scrollToSearchHit(card) {
  const col = card.closest('.col');
  if (col) {
    setActiveCol(col.dataset.colId);
    col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
}

function fuzzyScore(q, text) {
  const query = normalizeSearchText(q);
  const body = normalizeSearchText(text);
  if (!query || !body) return 0;
  if (body.includes(query)) return 1;

  const qTokens = query.split(/\s+/).filter(Boolean);
  const tTokens = body.split(/\s+/).filter(Boolean);
  if (!qTokens.length || !tTokens.length) return 0;

  let tokenHits = 0;
  for (const qt of qTokens) {
    if (tTokens.some(tt => tt.includes(qt) || qt.includes(tt))) tokenHits++;
  }
  const tokenScore = tokenHits / qTokens.length;

  const gramScore = diceCoefficient(bigrams(query), bigrams(body));
  return Math.max(tokenScore, gramScore);
}

function normalizeSearchText(v) {
  return (v || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function diceCoefficient(a, b) {
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const g of a) counts.set(g, (counts.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of b) {
    const n = counts.get(g) || 0;
    if (n > 0) {
      overlap++;
      counts.set(g, n - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
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
// DELETE
// ════════════════════════════════════════════════════════════
async function deleteImage(id) {
  const img = S.images.get(id);
  if (!img || img.uploader_id !== S.ip) return;

  // Optimistic remove
  S.images.delete(id);
  const cardEl = document.querySelector(`.img-card[data-id="${id}"]`);
  cardEl?.remove();
  syncColCounts();

  const { error } = await sb.from('images').delete().eq('id', id);
  if (error) {
    console.error('[deleteImage]', error);
    // Revert — re-fetch and re-render
    const { data } = await sb.from('images').select('*').eq('id', id).single();
    if (data) { S.images.set(id, data); appendImgCard(data); }
  }
}

async function deleteColumn(id) {
  const col = S.columns.get(id);
  if (!col || col.created_by !== S.ip) return;

  // Optimistic remove
  S.columns.delete(id);
  document.querySelector(`.col[data-col-id="${id}"]`)?.remove();

  const { error: imgErr } = await sb.from('images').delete().eq('column_id', id);
  if (imgErr) console.error('[deleteColumn images]', imgErr);

  const { error: colErr } = await sb.from('columns').delete().eq('id', id);
  if (colErr) {
    console.error('[deleteColumn]', colErr);
    // Revert column
    S.columns.set(id, col);
    renderColumn(col);
  }
}

// ════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════
async function exportZip() {
  const btn = $('btn-export');
  if (!S.images.size) return;

  btn.textContent = 'zipping…';
  btn.disabled = true;

  const zip = new JSZip();

  // Track used filenames per folder to avoid collisions
  const folderUsed = new Map();

  for (const [, img] of S.images) {
    if (img._pending || !img.image_data) continue;

    const col = S.columns.get(img.column_id);
    const folderName = sanitizeName(col?.name || 'unknown');

    if (!folderUsed.has(folderName)) folderUsed.set(folderName, new Map());
    const used = folderUsed.get(folderName);

    const ext = extFromImg(img);
    const baseName = sanitizeName(img.file_name?.replace(/\.[^.]+$/, '') || 'image');

    // Ensure unique filename within the folder
    let fileName = baseName + '.' + ext;
    if (used.has(fileName)) {
      const n = used.get(fileName) + 1;
      used.set(fileName, n);
      fileName = `${baseName}_${n}.${ext}`;
    } else {
      used.set(fileName, 1);
    }

    const b64 = img.image_data.split(',')[1];
    if (!b64) continue;
    zip.folder(folderName).file(fileName, b64, { base64: true });
  }

  try {
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ocrgrid-${S.roomCode}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    console.error('[export]', e);
  }

  btn.textContent = 'export zip';
  btn.disabled = false;
}

function sanitizeName(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed';
}

function extFromImg(img) {
  const match = img.image_data?.match(/^data:image\/(\w+);/);
  if (match) return match[1] === 'jpeg' ? 'jpg' : match[1];
  const fn = img.file_name || '';
  return fn.includes('.') ? fn.split('.').pop().toLowerCase() : 'jpg';
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
