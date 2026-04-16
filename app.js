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
  searchPreferExact: true,
  searchFocusId: null,
  searchHitIds:  [],
  searchHitIndex: -1,
  ocrEngine:     null,
  scribe:        null,
  ocrWorker:     null,
  ocrReady:      false,
  imgChannel:    null,
  colChannel:    null,
  boardSync:     null,
  mobileOCRDisabled: false,
  duplicateToastSeen: new Set(),
  duplicateHighlightIds: new Set(),
  duplicateNavIds: [],
  duplicateNavIndex: -1,
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
const OCR_ENABLE_ON_MOBILE = false;
const THEME_KEY = 'ocrgrid_theme';
const SEARCH_MODE_KEY = 'ocrgrid_search_mode';

// ════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initSearchMode();
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
  $('btn-upload-mobile')?.addEventListener('click', () => $('file-input').click());
  $('btn-search-mobile')?.addEventListener('click', () => {
    if (S.roomCode) openSearch();
  });

  $('btn-copy').addEventListener('click', copyLink);
  $('btn-theme')?.addEventListener('click', toggleTheme);
  $('btn-copy-mobile')?.addEventListener('click', copyLink);
  $('btn-export').addEventListener('click', exportZip);
  $('btn-export-mobile')?.addEventListener('click', exportZip);
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-leave-mobile')?.addEventListener('click', leaveRoom);
  $('btn-search-close').addEventListener('click', closeSearch);
  $('btn-search-next').addEventListener('click', goToNextSearchHit);
  $('search-mode-toggle')?.addEventListener('change', e => {
    S.searchPreferExact = !!e.target.checked;
    localStorage.setItem(SEARCH_MODE_KEY, S.searchPreferExact ? 'exact' : 'regular');
    if (S.searchOpen && S.query) applySearch();
  });
  $('search-input').addEventListener('input', e => { S.query = e.target.value; applySearch(); });
  $('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goToNextSearchHit();
    }
  });

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
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      // Smart mode ON: use in-app search. Smart mode OFF: fall back to native browser find.
      if (S.searchPreferExact) {
        e.preventDefault();
        if (S.roomCode) openSearch();
      } else if (S.searchOpen) {
        closeSearch();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (!$('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
      if (S.searchOpen) closeSearch();
    }
  });
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || 'dark';
  applyTheme(theme);
}

function initSearchMode() {
  const raw = localStorage.getItem(SEARCH_MODE_KEY);
  S.searchPreferExact = raw !== 'regular';
  const toggle = $('search-mode-toggle');
  if (toggle) toggle.checked = S.searchPreferExact;
}

function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', normalized);
  localStorage.setItem(THEME_KEY, normalized);
  const btn = $('btn-theme');
  if (btn) {
    const switchingTo = normalized === 'light' ? 'dark' : 'light';
    btn.innerHTML = switchingTo === 'light' ? themeIconSun() : themeIconMoon();
    btn.setAttribute('aria-label', `Switch to ${switchingTo} mode`);
    btn.setAttribute('title', `Switch to ${switchingTo} mode`);
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'light' ? 'dark' : 'light');
}

function themeIconSun() {
  return `<svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}

function themeIconMoon() {
  return `<svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14.8 3.2a8.9 8.9 0 1 0 6 15.6A9.7 9.7 0 1 1 14.8 3.2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>`;
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
  startDbUsagePolling();

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
        notifyDuplicateQuestionIfNeeded(row.id, row.column_id, row.ocr_text);
        syncColCounts();
        if (S.searchOpen) applySearch();
      })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'images', filter: `room_code=eq.${code}` },
      ({ new: row }) => {
        if (!S.images.has(row.id)) return;
        const prev = S.images.get(row.id);
        S.images.set(row.id, { ...prev, ...row });
        // If OCR text just arrived from another client, update the card
        if (row.ocr_text && row.ocr_text !== prev.ocr_text) {
          updateImgCardOCR(row.id, row.ocr_text);
          notifyDuplicateQuestionIfNeeded(row.id, row.column_id, row.ocr_text);
          if (S.searchOpen) applySearch();
        }
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
  stopDbUsagePolling();
  S.imgChannel?.unsubscribe();
  S.colChannel?.unsubscribe();
  S.imgChannel = S.colChannel = null;
  S.roomCode = S.activeColId = null;
  S.columns.clear(); S.images.clear();
  S.duplicateToastSeen.clear();
  clearDuplicateQuestionHighlights();

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
      <span class="col-focus-badge">click to select</span>
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
    const ocrText   = await getOCRTextSafe(file, imageData);
    notifyDuplicateQuestionIfNeeded(id, colId, ocrText);
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

async function getOCRTextSafe(file, imageData) {
  if (isMobileClient()) {
    if (!OCR_ENABLE_ON_MOBILE) return '';
    if (S.mobileOCRDisabled) return '';
    try {
      // Mobile browsers can crash/freeze on OCR; fail open and keep upload working.
      return await withTimeout(runOCR(file, imageData), 12000, 'mobile OCR timeout');
    } catch (err) {
      console.warn('[OCR][mobile] failed, skipping OCR for this upload', err);
      S.mobileOCRDisabled = true;
      return '';
    }
  }

  return runOCR(file, imageData).catch(() => '');
}

function isMobileClient() {
  const ua = navigator.userAgent || '';
  const mobileUA = /android|iphone|ipad|ipod|mobile|silk|kindle|blackberry|opera mini|iemobile/i.test(ua);
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches;
  return !!(mobileUA || coarsePointer);
}

function withTimeout(promise, ms, label = 'operation timeout') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
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

// ════════════════════════════════════════════════════════════
// COLLABORATIVE OCR (desktop only)
// ════════════════════════════════════════════════════════════

// Called after every non-pending card render. On desktop, if the
// image has no OCR text we race to claim a distributed lock and
// run OCR, then push the result so every client updates.
function scheduleOCRIfNeeded(row) {
  if (isMobileClient()) return;
  if (row._pending || row.ocr_text) return;
  // Random jitter so multiple desktop clients don't all claim simultaneously
  const delay = Math.floor(Math.random() * 1500);
  setTimeout(() => tryClaimAndRunOCR(row.id), delay);
}

async function tryClaimAndRunOCR(imgId) {
  const row = S.images.get(imgId);
  if (!row || row.ocr_text || row._pending) return; // already filled

  // Claim the lock atomically — only succeeds if no one else holds it
  // (or their lock expired more than 2 minutes ago)
  const expiry = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: claimed } = await sb
    .from('images')
    .update({ ocr_locked_by: S.ip, ocr_locked_at: new Date().toISOString() })
    .eq('id', imgId)
    .eq('ocr_text', '')
    .or(`ocr_locked_by.is.null,ocr_locked_at.lt.${expiry}`)
    .select('id');

  if (!claimed?.length) return; // another client got there first

  // Show local scanning indicator
  const card = document.querySelector(`.img-card[data-id="${imgId}"]`);
  const ocrDiv = card?.querySelector('.img-ocr');
  if (ocrDiv) ocrDiv.innerHTML = '<span class="img-ocr-scan">reading text…</span>';

  try {
    const imgRow = S.images.get(imgId);
    // Convert stored data URL back to a Blob so Scribe.js is happy
    const blob = await fetch(imgRow.image_data).then(r => r.blob());
    const file = new File([blob], imgRow.file_name || 'image.jpg', { type: blob.type });

    const ocrText = await runOCR(file, imgRow.image_data).catch(() => '');

    // Push result and release lock in one update
    await sb.from('images').update({
      ocr_text:       ocrText,
      ocr_locked_by:  null,
      ocr_locked_at:  null,
    }).eq('id', imgId);

    // Update local state + card (realtime UPDATE will handle other clients)
    S.images.set(imgId, { ...S.images.get(imgId), ocr_text: ocrText });
    updateImgCardOCR(imgId, ocrText);
    if (S.searchOpen) applySearch();

  } catch (err) {
    console.error('[collab OCR]', err);
    // Release lock so someone else can try
    await sb.from('images').update({ ocr_locked_by: null, ocr_locked_at: null }).eq('id', imgId);
    if (ocrDiv) ocrDiv.innerHTML = '<span class="img-ocr-empty">no text found</span>';
  }
}

function updateImgCardOCR(imgId, ocrText) {
  const card = document.querySelector(`.img-card[data-id="${imgId}"]`);
  if (!card) return;
  const ocrDiv = card.querySelector('.img-ocr');
  if (!ocrDiv) return;
  if (ocrText) {
    ocrDiv.innerHTML = `<div class="img-ocr-text">${esc(ocrText)}</div>${buildAnswerSummaryHTML(ocrText)}`;
  } else {
    ocrDiv.innerHTML = '<span class="img-ocr-empty">no text found</span>';
  }
}

function notifyDuplicateQuestionIfNeeded(imageId, columnId, ocrText) {
  if (!imageId || !columnId || !ocrText) return;

  const stem = extractQuestionStem(ocrText);
  if (!stem) return;

  const stemKey = normalizeQuestionStem(stem);
  if (!stemKey) return;

  const matchIds = getSameQuestionMatchIdsInOtherColumns(stemKey, columnId, imageId);
  const matchCount = matchIds.length;
  if (matchCount <= 0) return;

  const dedupeKey = `${imageId}:${stemKey}`;
  if (S.duplicateToastSeen.has(dedupeKey)) return;
  S.duplicateToastSeen.add(dedupeKey);

  highlightDuplicateQuestionMatches(imageId, columnId, stemKey);

  const questionPreview = buildQuestionPreview(stem);
  const containerSummary = buildContainerNamesSummary(matchIds);

  showDuplicateQuestionToast(matchCount, questionPreview, containerSummary, () => {
    goToNextDuplicateQuestionMatch();
  });
}

function buildQuestionPreview(stem) {
  const cleaned = (stem || '')
    .replace(/\bquestion\s*\d+\b/ig, ' ')
    .replace(/\(\s*\d+\s*point[s]?\s*\)/ig, ' ')
    .replace(/\bsaved\b/ig, ' ')
    .replace(/\bnot\s+saved\b/ig, ' ')
    .replace(/[^\w\s?']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'this question';
  const words = cleaned.split(' ').filter(Boolean);
  const head = words.slice(0, 24).join(' ');
  return words.length > 24 ? `${head}...` : head;
}

function buildContainerNamesSummary(matchIds) {
  if (!Array.isArray(matchIds) || !matchIds.length) return '';

  const names = [];
  const seen = new Set();

  for (const id of matchIds) {
    const row = S.images.get(id);
    const colName = row?.column_id ? S.columns.get(row.column_id)?.name : null;
    const cleaned = (colName || '').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    names.push(cleaned);
  }

  if (!names.length) return '';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

function extractQuestionStem(text) {
  if (!text) return '';

  const flattened = text
    .replace(/\r/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!flattened) return '';

  const questionEnd = flattened.indexOf('?');
  if (questionEnd !== -1) {
    return flattened.slice(0, questionEnd + 1).trim();
  }

  const optionMarker = flattened.match(/\s(?:[@●◉○◯]|\([oO0eE]\)|\([a-dA-D]\)|[A-D][\).]|[a-d][\).])\s+/);
  const head = optionMarker?.index ? flattened.slice(0, optionMarker.index).trim() : flattened;

  return head
    .replace(/^\d+\s*[.)-]\s*/, '')
    .replace(/[:;,.\-\s]+$/, '')
    .trim();
}

function normalizeQuestionStem(stem) {
  const raw = (stem || '').toLowerCase();
  if (!raw) return '';

  const cleaned = raw
    // Remove common quiz metadata that should not affect duplicate matching.
    .replace(/\bquestion\s*\d+\b/g, ' ')
    .replace(/\(\s*\d+\s*point[s]?\s*\)/g, ' ')
    .replace(/\bpoint[s]?\b/g, ' ')
    .replace(/\bsaved\b/g, ' ')
    .replace(/\bnot\s+saved\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\b[a-z]\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

function isSameQuestionStem(baseStemKey, candidateStemKey) {
  if (!baseStemKey || !candidateStemKey) return false;
  if (baseStemKey === candidateStemKey) return true;

  // Accept tiny OCR differences while still requiring near-identical stems.
  const minLen = Math.min(baseStemKey.length, candidateStemKey.length);
  if (minLen < 18) return false;
  return similarityByEditDistance(baseStemKey, candidateStemKey) >= 0.94;
}

function countSameQuestionInOtherColumns(stemKey, currentColumnId, currentImageId) {
  return getSameQuestionMatchIdsInOtherColumns(stemKey, currentColumnId, currentImageId).length;
}

function getSameQuestionMatchIdsInOtherColumns(stemKey, currentColumnId, currentImageId) {
  const ids = [];

  for (const row of S.images.values()) {
    if (!row || row._pending || !row.ocr_text) continue;
    if (row.id === currentImageId) continue;
    if (!row.column_id || row.column_id === currentColumnId) continue;

    const otherStem = extractQuestionStem(row.ocr_text);
    if (!otherStem) continue;
    const otherStemKey = normalizeQuestionStem(otherStem);
    if (isSameQuestionStem(stemKey, otherStemKey)) ids.push(row.id);
  }

  return ids;
}

function highlightDuplicateQuestionMatches(sourceImageId, sourceColumnId, stemKey) {
  clearDuplicateQuestionHighlights();

  const matchIds = getSameQuestionMatchIdsInOtherColumns(stemKey, sourceColumnId, sourceImageId);
  if (!matchIds.length) return;

  S.duplicateNavIds = matchIds;
  S.duplicateNavIndex = -1;

  for (const id of matchIds) {
    const card = document.querySelector(`.img-card[data-id="${id}"]`);
    if (!card) continue;
    card.classList.add('dup-question-hit');
    S.duplicateHighlightIds.add(id);
  }
}

function goToNextDuplicateQuestionMatch() {
  if (!S.duplicateNavIds.length) return;

  S.duplicateNavIndex = (S.duplicateNavIndex + 1) % S.duplicateNavIds.length;
  const nextId = S.duplicateNavIds[S.duplicateNavIndex];
  if (!nextId) return;

  document.querySelectorAll('.img-card.dup-question-focus').forEach(el => el.classList.remove('dup-question-focus'));

  const nextCard = document.querySelector(`.img-card[data-id="${nextId}"]`);
  if (!nextCard) return;
  nextCard.classList.add('dup-question-focus');

  const col = nextCard.closest('.col');
  if (col) {
    setActiveCol(col.dataset.colId);
    col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  nextCard.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
}

function clearDuplicateQuestionHighlights() {
  if (!S.duplicateHighlightIds.size && !S.duplicateNavIds.length) return;
  for (const id of S.duplicateHighlightIds) {
    const card = document.querySelector(`.img-card[data-id="${id}"]`);
    card?.classList.remove('dup-question-hit');
    card?.classList.remove('dup-question-focus');
  }
  S.duplicateHighlightIds.clear();
  S.duplicateNavIds = [];
  S.duplicateNavIndex = -1;
}

function showDuplicateQuestionToast(matchCount, questionPreview, containerSummary, onNextMatch) {
  const stack = $('toast-stack');
  if (!stack) return;

  const matchText = containerSummary
    ? `In: ${esc(containerSummary)}`
    : `${matchCount} match${matchCount === 1 ? '' : 'es'} in other container${matchCount === 1 ? '' : 's'}`;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <div class="toast-row">
      <span class="toast-question-preview">Question: ${esc(questionPreview || 'this question')}</span>
      <span class="toast-body">${matchText}</span>
      <div class="toast-actions toast-actions-right">
      <button class="toast-action toast-action-next" type="button">Next match</button>
        <button class="toast-close" type="button" aria-label="Close notification">✕</button>
      </div>
    </div>
  `;

  stack.appendChild(toast);

  let removed = false;
  const removeToast = () => {
    if (removed) return;
    removed = true;
    clearDuplicateQuestionHighlights();
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 180);
  };

  toast.querySelector('.toast-close')?.addEventListener('click', removeToast);
  toast.querySelector('.toast-action-next')?.addEventListener('click', () => {
    onNextMatch?.();
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
  scheduleOCRIfNeeded(row);
}

function finaliseImgCard(el, row) {
  el.innerHTML = imgCardHTML(row);
  el.classList.add('in');
  bindImgCardEvents(el, row);
  if (S.query) applySearchToCard(el, row, S.query.toLowerCase());
  scheduleOCRIfNeeded(row);
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
  S.searchHitIds = [];
  S.searchHitIndex = -1;
  $('search-bar').classList.remove('open');
  $('search-input').value = '';
  $('search-count').textContent = '';
  clearSearchStates();
}

function applySearch() {
  if (!S.query) { clearSearchStates(); $('search-count').textContent = ''; return; }
  const q = S.query;
  let hits = [];
  let fuzzyCount = 0;
  const colHits = new Set();
  const candidates = [];

  document.querySelectorAll('.img-card').forEach(card => {
    const row = S.images.get(card.dataset.id);
    if (!row || row._pending) {
      card.classList.remove('search-hit', 'search-miss', 'search-hit-active');
      return;
    }

    const match = evaluateSearchMatch(q, row.ocr_text || '');
    if (match && match.score >= 0.66) {
      candidates.push({ card, row, match });
    }
  });

  // In smart exact mode, if any exact phrase match exists, suppress fuzzy-only alternatives.
  if (S.searchPreferExact) {
    const hasExact = candidates.some(c => c.match.exact);
    hits = hasExact ? candidates.filter(c => c.match.exact) : candidates;
  } else {
    hits = candidates;
  }

  document.querySelectorAll('.img-card').forEach(card => {
    const row = S.images.get(card.dataset.id);
    if (!row || row._pending) return;

    const hit = hits.find(h => h.card.dataset.id === card.dataset.id);
    if (!hit) {
      card.classList.remove('search-hit', 'search-hit-active');
      card.classList.add('search-miss');
      restoreOCREl(card, row);
      return;
    }

    if (!hit.match.exact) fuzzyCount++;
    colHits.add(card.dataset.colId);
    card.classList.add('search-hit');
    card.classList.remove('search-miss');
    if (hit.match.exact) applySearchToCard(card, row, hit.match);
    else applyFuzzySearchToCard(card, row, hit.match);
  });

  hits.sort((a, b) => {
    if (a.match.exact !== b.match.exact) return a.match.exact ? -1 : 1;
    return b.match.score - a.match.score;
  });

  S.searchHitIds = hits.map(h => h.card.dataset.id);
  const currentIdx = S.searchHitIds.indexOf(S.searchFocusId);
  S.searchHitIndex = currentIdx >= 0 ? currentIdx : (S.searchHitIds.length ? 0 : -1);

  const lead = hits[0]?.card || null;
  const activeCard = S.searchHitIndex >= 0
    ? document.querySelector(`.img-card[data-id="${S.searchHitIds[S.searchHitIndex]}"]`)
    : lead;
  setActiveSearchHit(activeCard);
  if (activeCard) scrollToSearchHit(activeCard);

  // Dim columns with no hits
  document.querySelectorAll('.col').forEach(col => {
    col.classList.toggle('col-search-miss', !colHits.has(col.dataset.colId));
  });

  if (hits.length === 0) {
    S.searchHitIds = [];
    S.searchHitIndex = -1;
    $('search-count').textContent = 'no matches';
    return;
  }

  if (fuzzyCount === 0) {
    $('search-count').textContent = `${hits.length} match${hits.length > 1 ? 'es' : ''}`;
    return;
  }

  $('search-count').textContent = `${hits.length} match${hits.length > 1 ? 'es' : ''} (${fuzzyCount} fuzzy)`;
}

function applySearchToCard(card, row, match) {
  const ocrDiv = card.querySelector('.img-ocr-text');
  if (!ocrDiv || !row.ocr_text) return;

  const bodyLower = row.ocr_text.toLowerCase();
  const queryLower = (match.queryNormalized || '').toLowerCase();
  let idx = queryLower ? bodyLower.indexOf(queryLower) : -1;

  if (idx === -1 && match.bestSegmentRaw) {
    idx = bodyLower.indexOf(match.bestSegmentRaw.toLowerCase());
  }

  if (idx === -1) {
    ocrDiv.innerHTML = buildSnippet(row.ocr_text, match.bestStart || 0, match.bestEnd || 0);
    return;
  }

  const len = Math.max(1, queryLower.length || (match.bestSegmentRaw || '').length || 1);
  ocrDiv.innerHTML = buildSnippet(row.ocr_text, idx, idx + len);
}

function restoreOCREl(card, row) {
  const ocrDiv = card.querySelector('.img-ocr-text');
  if (ocrDiv) ocrDiv.textContent = row.ocr_text || '';
}

function clearSearchStates() {
  S.searchHitIds = [];
  S.searchHitIndex = -1;
  document.querySelectorAll('.img-card').forEach(card => {
    card.classList.remove('search-hit', 'search-miss', 'search-hit-active');
    const row = S.images.get(card.dataset.id);
    if (row) restoreOCREl(card, row);
  });
  document.querySelectorAll('.col').forEach(col => col.classList.remove('col-search-miss'));
}

function goToNextSearchHit() {
  if (!S.query) return;
  if (!S.searchHitIds.length) {
    applySearch();
    if (!S.searchHitIds.length) return;
  }

  S.searchHitIndex = (S.searchHitIndex + 1) % S.searchHitIds.length;
  const nextId = S.searchHitIds[S.searchHitIndex];
  const card = document.querySelector(`.img-card[data-id="${nextId}"]`);
  if (!card) return;

  setActiveSearchHit(card);
  scrollToSearchHit(card);
}

function applyFuzzySearchToCard(card, row, match) {
  const ocrDiv = card.querySelector('.img-ocr-text');
  if (!ocrDiv || !row.ocr_text) return;
  const snippet = buildSnippet(row.ocr_text, match.bestStart || 0, match.bestEnd || 0);
  ocrDiv.innerHTML = `${snippet}<br><span class="img-ocr-empty">fuzzy ${(match.score * 100).toFixed(0)}%</span>`;
}

function buildSnippet(text, matchStart, matchEnd) {
  const start = Math.max(0, matchStart || 0);
  const end = Math.max(start + 1, matchEnd || start + 1);
  const s = Math.max(0, start - 60);
  const e = Math.min(text.length, end + 60);
  return `${s > 0 ? '...' : ''}${esc(text.slice(s, start))}<mark>${esc(text.slice(start, end))}</mark>${esc(text.slice(end, e))}${e < text.length ? '...' : ''}`;
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

function evaluateSearchMatch(query, text) {
  const queryNorm = normalizeSearchText(query);
  const textNorm = normalizeSearchText(text);
  if (!queryNorm || !textNorm) return null;

  const exactIdx = textNorm.indexOf(queryNorm);
  if (exactIdx !== -1) {
    const rawPos = mapNormalizedSpanToRaw(text, queryNorm, exactIdx);
    return {
      score: 1,
      exact: true,
      queryNormalized: queryNorm,
      bestSegmentRaw: rawPos.segment,
      bestStart: rawPos.start,
      bestEnd: rawPos.end,
    };
  }

  const queryTokens = tokenizeSearchText(queryNorm);
  const textTokens = tokenizeSearchText(textNorm);
  if (!queryTokens.length || !textTokens.length) return null;

  const tokenCoverage = queryTokenCoverage(queryTokens, textTokens);
  const bestWindow = findBestTokenWindow(queryNorm, textNorm, queryTokens.length);
  const charScore = diceCoefficient(bigrams(queryNorm), bigrams(textNorm));
  const score = clamp01((tokenCoverage * 0.46) + (bestWindow.score * 0.42) + (charScore * 0.12));

  const bestRaw = mapNormalizedSpanToRaw(text, bestWindow.segment, bestWindow.index);
  return {
    score,
    exact: false,
    queryNormalized: queryNorm,
    bestSegmentRaw: bestRaw.segment,
    bestStart: bestRaw.start,
    bestEnd: bestRaw.end,
  };
}

function tokenizeSearchText(v) {
  return v.split(/\s+/).filter(Boolean);
}

function queryTokenCoverage(queryTokens, textTokens) {
  let hits = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const t of textTokens) {
      if (!t) continue;
      if (t.includes(q) || q.includes(t)) {
        best = 1;
        break;
      }
      best = Math.max(best, similarityByEditDistance(q, t));
      if (best >= 0.96) break;
    }
    if (best >= 0.7) hits++;
  }
  return hits / queryTokens.length;
}

function findBestTokenWindow(query, text, queryTokenCount) {
  const tokens = tokenizeSearchText(text);
  if (!tokens.length) return { score: 0, segment: text, index: 0 };

  const minWindow = Math.max(1, queryTokenCount - 1);
  const maxWindow = Math.min(tokens.length, queryTokenCount + 2);
  let best = { score: 0, segment: tokens[0], index: text.indexOf(tokens[0]) };
  let checks = 0;

  for (let size = minWindow; size <= maxWindow; size++) {
    for (let i = 0; i <= tokens.length - size; i++) {
      const segment = tokens.slice(i, i + size).join(' ');
      const index = text.indexOf(segment);
      if (index === -1) continue;
      const score = similarityByEditDistance(query, segment);
      if (score > best.score) {
        best = { score, segment, index };
      }
      checks++;
      if (checks >= 600) return best;
    }
  }

  return best;
}

function mapNormalizedSpanToRaw(rawText, segmentNorm, indexNorm) {
  if (!rawText || !segmentNorm) return { segment: '', start: 0, end: 0 };

  const rawLower = rawText.toLowerCase();
  const direct = rawLower.indexOf(segmentNorm);
  if (direct !== -1) {
    return {
      segment: rawText.slice(direct, direct + segmentNorm.length),
      start: direct,
      end: direct + segmentNorm.length,
    };
  }

  const chunk = rawText.split(/\s+/).find(part => similarityByEditDistance(segmentNorm, normalizeSearchText(part)) >= 0.72);
  if (chunk) {
    const start = rawText.indexOf(chunk);
    if (start !== -1) {
      return {
        segment: chunk,
        start,
        end: start + chunk.length,
      };
    }
  }

  const fallbackStart = Math.max(0, Math.min(rawText.length - 1, indexNorm || 0));
  const fallbackEnd = Math.min(rawText.length, fallbackStart + Math.max(1, segmentNorm.length));
  return {
    segment: rawText.slice(fallbackStart, fallbackEnd),
    start: fallbackStart,
    end: fallbackEnd,
  };
}

function similarityByEditDistance(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  const dist = damerauLevenshteinDistance(a, b);
  return clamp01(1 - (dist / maxLen));
}

function damerauLevenshteinDistance(a, b) {
  const al = a.length;
  const bl = b.length;
  const dp = Array.from({ length: al + 1 }, () => Array(bl + 1).fill(0));

  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
      }
    }
  }

  return dp[al][bl];
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
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
  if (S.boardSync?.cleanup) S.boardSync.cleanup();

  const board   = $('board');
  const hscroll = $('board-hscroll');
  const track   = $('board-hscroll-track');
  const thumb   = $('board-hscroll-thumb');
  if (!board || !hscroll || !track || !thumb) return;

  let rafId = 0;
  let maxScroll = 0;
  let maxThumbLeft = 0;
  let thumbWidth = 46;
  let dragging = false;
  let dragOffsetX = 0;

  const setOverflowState = () => {
    const hasOverflow = board.scrollWidth > board.clientWidth + 2;
    hscroll.classList.toggle('show', hasOverflow);
    if (!hasOverflow) {
      board.scrollLeft = 0;
      thumb.style.transform = 'translateX(0px)';
    }
    return hasOverflow;
  };

  const syncThumbFromBoard = () => {
    if (maxScroll <= 0 || maxThumbLeft <= 0) {
      thumb.style.transform = 'translateX(0px)';
      return;
    }
    const ratio = board.scrollLeft / maxScroll;
    const left = Math.max(0, Math.min(maxThumbLeft, ratio * maxThumbLeft));
    thumb.style.transform = `translateX(${left}px)`;
  };

  const updateMetrics = () => {
    const hasOverflow = setOverflowState();
    if (!hasOverflow) return;

    const trackWidth = track.clientWidth;
    const visibleRatio = board.clientWidth / board.scrollWidth;
    thumbWidth = Math.max(46, Math.round(trackWidth * visibleRatio));
    thumb.style.width = `${thumbWidth}px`;

    maxScroll = Math.max(0, board.scrollWidth - board.clientWidth);
    maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
    syncThumbFromBoard();
  };

  const queueUpdate = () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateMetrics);
  };

  const resizeObs = new ResizeObserver(queueUpdate);
  resizeObs.observe(board);
  resizeObs.observe(track);

  const mutObs = new MutationObserver(queueUpdate);
  mutObs.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  window.addEventListener('resize', queueUpdate);
  queueUpdate();

  const onBoardScroll = () => syncThumbFromBoard();
  board.addEventListener('scroll', onBoardScroll);

  const onThumbPointerDown = e => {
    if (!hscroll.classList.contains('show')) return;
    dragging = true;
    dragOffsetX = e.clientX - thumb.getBoundingClientRect().left;
    thumb.classList.add('dragging');
    thumb.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onThumbPointerMove = e => {
    if (!dragging || maxThumbLeft <= 0) return;
    e.preventDefault();
    const trackRect = track.getBoundingClientRect();
    const nextLeft = e.clientX - trackRect.left - dragOffsetX;
    const clamped = Math.max(0, Math.min(maxThumbLeft, nextLeft));
    const ratio = clamped / maxThumbLeft;
    board.scrollLeft = ratio * maxScroll;
  };

  const onThumbPointerUp = () => {
    dragging = false;
    thumb.classList.remove('dragging');
  };

  const onTrackPointerDown = e => {
    if (maxThumbLeft <= 0) return;
    if (e.target === thumb) return;
    const trackRect = track.getBoundingClientRect();
    const desiredLeft = e.clientX - trackRect.left - thumbWidth / 2;
    const clamped = Math.max(0, Math.min(maxThumbLeft, desiredLeft));
    const ratio = clamped / maxThumbLeft;
    board.scrollLeft = ratio * maxScroll;

    dragging = true;
    dragOffsetX = thumbWidth / 2;
    thumb.classList.add('dragging');
    track.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  thumb.addEventListener('pointerdown', onThumbPointerDown);
  window.addEventListener('pointermove', onThumbPointerMove, { passive: false });
  window.addEventListener('pointerup', onThumbPointerUp);
  window.addEventListener('pointercancel', onThumbPointerUp);
  track.addEventListener('pointerdown', onTrackPointerDown);

  S.boardSync = {
    cleanup: () => {
      cancelAnimationFrame(rafId);
      resizeObs.disconnect();
      mutObs.disconnect();
      window.removeEventListener('resize', queueUpdate);
      board.removeEventListener('scroll', onBoardScroll);
      thumb.removeEventListener('pointerdown', onThumbPointerDown);
      window.removeEventListener('pointermove', onThumbPointerMove);
      window.removeEventListener('pointerup', onThumbPointerUp);
      window.removeEventListener('pointercancel', onThumbPointerUp);
      track.removeEventListener('pointerdown', onTrackPointerDown);
    },
  };
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
// DB USAGE
// ════════════════════════════════════════════════════════════
const DB_LIMIT_BYTES = 500 * 1024 * 1024; // 500 MB free tier
let _dbUsageTimer = null;

function startDbUsagePolling() {
  fetchDbUsage();
  _dbUsageTimer = setInterval(fetchDbUsage, 5_000);
}

function stopDbUsagePolling() {
  clearInterval(_dbUsageTimer);
  _dbUsageTimer = null;
  $('db-usage')?.classList.add('hidden');
}

async function fetchDbUsage() {
  try {
    const { data, error } = await sb.rpc('get_db_size');
    if (error || data == null) return;
    renderDbUsage(Number(data));
  } catch { /* silently ignore */ }
}

function renderDbUsage(bytes) {
  const el    = $('db-usage');
  const fill  = $('db-usage-fill');
  const label = $('db-usage-label');
  if (!el || !fill || !label) return;

  const pct   = Math.min(100, (bytes / DB_LIMIT_BYTES) * 100);
  const mb    = (bytes / (1024 * 1024)).toFixed(1);

  fill.style.width = pct + '%';
  fill.classList.toggle('warn', pct >= 70 && pct < 90);
  fill.classList.toggle('crit', pct >= 90);
  label.textContent = `${mb} MB / 500 MB`;
  el.classList.remove('hidden');
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
  $('mobile-upload-wrap')?.classList.toggle('hidden', screen !== 'app');
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
