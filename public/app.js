/* DropCull client */
'use strict';

const $ = (s) => document.querySelector(s);
const state = {
  items: [],
  shoots: [],
  byId: new Map(),
  filter: 'all',
  shootFilter: null,
  expanded: new Set(), // burst groups shown in full
  filtered: [],
  sel: -1,
  loupeOpen: false,
  zoomed: false,
  scanning: false,
  looks: [],
  defaultLook: 'costa-rica',
};

// ---------------------------------------------------------------- filters
const FILTERS = [
  { key: 'all', label: 'Everything', fn: () => true },
  { key: 'unflagged', label: 'Still to review', fn: (i) => !i.pick && !i.reject },
  { key: 'picks', label: 'Picks', fn: (i) => i.pick },
  { key: 'rejects', label: 'Rejects', fn: (i) => i.reject },
  { key: 'warn', label: 'Blur & exposure', fn: (i) => i.flags && (i.flags.blurry || i.flags.under || i.flags.over) },
  { key: 'stacks', label: 'Burst stacks', fn: (i) => !!i.group },
  { key: 'videos', label: 'Videos', fn: (i) => i.type === 'vid' },
];

function computeFiltered() {
  const f = FILTERS.find(x => x.key === state.filter) || FILTERS[0];
  state.filtered = state.items.filter(i => {
    if (state.shootFilter && i.shoot !== state.shootFilter) return false;
    if (!f.fn(i)) return false;
    // collapse burst stacks: hide non-best members unless expanded or specifically browsing stacks
    if (i.group && !i.groupBest && state.filter !== 'stacks' && !state.expanded.has(i.group)) return false;
    return true;
  });
}

// ---------------------------------------------------------------- rendering
function fmtShutter(s) { return s ? (s < 1 ? '1/' + Math.round(1 / s) + 's' : s + 's') : null; }
function fmtDur(s) {
  if (s == null) return '';
  s = Math.round(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function fmtBytes(b) { return b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB'; }
function stars(n) { return '★'.repeat(n); }

function renderHeadStats() {
  const t = state.items.length;
  const p = state.items.filter(i => i.pick).length;
  const r = state.items.filter(i => i.reject);
  const rb = r.reduce((a, i) => a + i.size, 0);
  $('#headstats').innerHTML = t
    ? `<b>${t.toLocaleString()}</b> items · <b class="hpick">${p}</b> picks · <b class="hrej">${r.length}</b> rejects${rb > 0 ? ' (' + fmtBytes(rb) + ')' : ''}`
    : '';
}

function renderSidebar() {
  const counts = {};
  for (const f of FILTERS) counts[f.key] = state.items.filter(i => f.fn(i)).length;
  $('#filters').innerHTML = FILTERS.map(f =>
    `<button data-f="${f.key}" class="${state.filter === f.key ? 'on' : ''}">
       <span>${f.label}</span><span class="cnt">${counts[f.key].toLocaleString()}</span>
     </button>`).join('');
  $('#filters').querySelectorAll('button').forEach(b =>
    b.onclick = () => { state.filter = b.dataset.f; refresh(); });

  $('#shootList').innerHTML =
    `<button data-s="" style="${!state.shootFilter ? 'color:var(--text)' : ''}"><span>All shoots</span></button>` +
    state.shoots.map(s =>
      `<button data-s="${s.id}" style="${state.shootFilter === s.id ? 'color:var(--text)' : ''}">
         <span>${s.label}</span><span class="cnt">${s.count}</span>
       </button>`).join('');
  $('#shootList').querySelectorAll('button').forEach(b =>
    b.onclick = () => { state.shootFilter = b.dataset.s || null; refresh(); });
}

function cellHTML(i, idx) {
  const badges = [];
  if (i.error) badges.push('<span class="badge err">UNREADABLE</span>');
  if (i.type === 'vid') badges.push(`<span class="badge vid">VIDEO ${fmtDur(i.video && i.video.dur)}</span>`);
  if (i.flags && i.flags.blurry) badges.push('<span class="badge blur">BLUR</span>');
  if (i.flags && i.flags.under) badges.push('<span class="badge exp">DARK</span>');
  if (i.flags && i.flags.over) badges.push('<span class="badge exp">BRIGHT</span>');
  if (i.group && i.groupBest && !state.expanded.has(i.group)) {
    const n = state.items.filter(x => x.group === i.group).length;
    badges.push(`<span class="badge stack" data-g="${i.group}">${n} SIMILAR</span>`);
  } else if (i.group && state.expanded.has(i.group) && i.groupBest) {
    badges.push('<span class="badge best">SHARPEST</span>');
  }
  return `<div class="cell ${i.pick ? 'pick' : ''} ${i.reject ? 'rej' : ''} ${idx === state.sel ? 'sel' : ''}" data-idx="${idx}" data-id="${i.id}">
    <img loading="lazy" src="/api/thumb/${i.id}" alt="">
    <div class="badges">${badges.join('')}</div>
    <div class="cellmeta"><span class="nm">${i.name}</span><span class="st">${stars(i.stars || 0)}</span></div>
  </div>`;
}

function renderGrid() {
  computeFiltered();
  const grid = $('#grid');
  if (!state.filtered.length) {
    grid.innerHTML = `<div class="empty">Nothing in this view.<small>Try another filter on the left.</small></div>`;
    return;
  }
  if (state.sel >= state.filtered.length) state.sel = state.filtered.length - 1;
  const byShoot = new Map();
  for (let k = 0; k < state.filtered.length; k++) {
    const i = state.filtered[k];
    if (!byShoot.has(i.shoot)) byShoot.set(i.shoot, []);
    byShoot.get(i.shoot).push([i, k]);
  }
  let html = '';
  for (const [sid, list] of byShoot) {
    const s = state.shoots.find(x => x.id === sid);
    html += `<div class="shoot-head"><b>${s ? s.label : 'Shoot'}</b> · ${list.length} shown</div>`;
    html += `<div class="cells">` + list.map(([i, k]) => cellHTML(i, k)).join('') + `</div>`;
  }
  grid.innerHTML = html;
}

function refresh() { renderSidebar(); renderGrid(); renderHeadStats(); }

function updateCell(idx) {
  const el = $(`#grid .cell[data-idx="${idx}"]`);
  if (!el) { renderGrid(); return; }
  const i = state.filtered[idx];
  el.classList.toggle('pick', i.pick);
  el.classList.toggle('rej', i.reject);
  el.classList.toggle('sel', idx === state.sel);
  el.querySelector('.st').textContent = stars(i.stars || 0);
  renderHeadStats();
}

// ---------------------------------------------------------------- selection & flags
function select(idx, scroll = true) {
  if (!state.filtered.length) return;
  idx = Math.max(0, Math.min(idx, state.filtered.length - 1));
  const old = state.sel;
  state.sel = idx;
  if (old >= 0) updateCell(old);
  updateCell(idx);
  if (scroll) {
    const el = $(`#grid .cell[data-idx="${idx}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
  if (state.loupeOpen) openLoupe(idx);
}

async function flag(patch) {
  if (state.sel < 0) return;
  const it = state.filtered[state.sel];
  if (!it) return;
  const r = await fetch('/api/flag', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: it.id, patch }),
  }).then(r => r.json());
  it.pick = r.pick; it.reject = r.reject; it.stars = r.stars; it.look = r.look;
  updateCell(state.sel);
  if (state.loupeOpen) renderLoupeInfo(it);
}

// ---------------------------------------------------------------- loupe
function renderLoupeInfo(i) {
  $('#loupeName').textContent = i.name;
  const fl = [];
  if (i.flags && i.flags.blurry) fl.push('<span class="badge blur">BLUR</span>');
  if (i.flags && i.flags.under) fl.push('<span class="badge exp">DARK</span>');
  if (i.flags && i.flags.over) fl.push('<span class="badge exp">BRIGHT</span>');
  if (i.group) fl.push(`<span class="badge stack">${i.groupBest ? 'SHARPEST OF BURST' : 'IN BURST'}</span>`);
  if (i.blur != null) fl.push(`<span class="badge">SHARPNESS ${Math.round(i.blur)}</span>`);
  $('#loupeFlags').innerHTML = fl.join('');
  $('#lpick').classList.toggle('on', i.pick);
  $('#lreject').classList.toggle('on', i.reject);
  $('#lstars').innerHTML = [1, 2, 3, 4, 5].map(n =>
    `<span class="${i.stars >= n ? 'on' : ''}" data-n="${n}">★</span>`).join('');
  $('#lstars').querySelectorAll('span').forEach(s =>
    s.onclick = () => flag({ stars: +s.dataset.n === i.stars ? 0 : +s.dataset.n }));

  // per-photo edit look chips — tapping one previews it right in the big view
  if (i.type === 'img' && state.looks.length) {
    const active = i.look || state.defaultLook;
    $('#llooks').innerHTML = state.looks.map(l =>
      `<button data-look="${l.key}" class="${l.key === active ? 'on' : ''}">${l.label}</button>`).join('');
    $('#llooks').querySelectorAll('button').forEach(b => b.onclick = async () => {
      await flag({ look: b.dataset.look });
      const img = $('#loupeMedia img');
      if (img) img.src = `/api/look/${i.id}?name=${b.dataset.look}&t=${Date.now()}`;
    });
    $('#llooks').hidden = false; $('.llookshead').hidden = false;
  } else {
    $('#llooks').hidden = true; $('.llookshead').hidden = true;
  }

  const e = i.exif || {};
  const rows = [
    ['Taken', new Date(i.ts).toLocaleString()],
    ['Camera', e.camera],
    ['Lens', e.lens],
    ['Settings', [e.iso && 'ISO ' + e.iso, fmtShutter(e.shutter), e.aperture && 'f/' + e.aperture, e.focal && Math.round(e.focal) + 'mm'].filter(Boolean).join(' · ') || null],
    ['Size', (e.w && e.h ? e.w + '×' + e.h + ' · ' : '') + fmtBytes(i.size)],
    i.type === 'vid' && i.video ? ['Video', [fmtDur(i.video.dur), i.video.w && i.video.w + '×' + i.video.h, i.video.fps && i.video.fps + ' fps'].filter(Boolean).join(' · ')] : null,
    ['Folder', i.rel.includes('/') ? i.rel.slice(0, i.rel.lastIndexOf('/')) : '(top level)'],
  ].filter(r => r && r[1]);
  $('#loupeExif').innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
  $('#lzoom').style.display = i.type === 'img' ? '' : 'none';
}

function openLoupe(idx) {
  state.sel = idx;
  const i = state.filtered[idx];
  if (!i) return;
  state.loupeOpen = true;
  state.zoomed = false;
  $('#loupe').hidden = false;
  const media = $('#loupeMedia');
  media.classList.remove('zoomed');
  if (i.type === 'vid') {
    media.innerHTML = `<video src="/api/media/${i.id}" controls autoplay muted playsinline></video>`;
  } else {
    media.innerHTML = `<img src="/api/preview/${i.id}" alt="">`;
  }
  renderLoupeInfo(i);
}

function closeLoupe() {
  state.loupeOpen = false;
  $('#loupe').hidden = true;
  $('#loupeMedia').innerHTML = '';
  $('#grid').focus();
}

function toggleZoom() {
  const i = state.filtered[state.sel];
  if (!i || i.type !== 'img') return;
  state.zoomed = !state.zoomed;
  const media = $('#loupeMedia');
  media.classList.toggle('zoomed', state.zoomed);
  $('#lzoom').textContent = state.zoomed ? 'Fit to screen' : 'Zoom 100%';
  if (state.zoomed) { media.scrollLeft = (media.scrollWidth - media.clientWidth) / 2; media.scrollTop = (media.scrollHeight - media.clientHeight) / 2; }
}

// ---------------------------------------------------------------- toasts & modal
function toast(msg, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.bad ? ' bad' : '');
  el.innerHTML = `<span>${msg}</span>`;
  if (opts.action) {
    const b = document.createElement('button');
    b.textContent = opts.action;
    b.onclick = () => { el.remove(); opts.onAction && opts.onAction(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.sticky ? 30000 : 7000);
}

function confirmModal(title, body, okLabel = 'Do it') {
  return new Promise(resolve => {
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = body;
    $('#modalOk').textContent = okLabel;
    $('#modal').hidden = false;
    const done = (v) => { $('#modal').hidden = true; resolve(v); };
    $('#modalOk').onclick = () => done(true);
    $('#modalCancel').onclick = () => done(false);
  });
}

// ---------------------------------------------------------------- screens
function show(screen) {
  $('#welcome').hidden = screen !== 'welcome';
  $('#progress').hidden = screen !== 'progress';
  $('#studio').hidden = screen !== 'studio';
}

async function loadLibrary() {
  const lib = await fetch('/api/library').then(r => r.json());
  state.items = (lib.items || []).sort((a, b) => a.ts - b.ts || a.name.localeCompare(b.name));
  state.shoots = lib.shoots || [];
  state.byId = new Map(state.items.map(i => [i.id, i]));
  $('#proj').hidden = !lib.root;
  $('#proj').textContent = lib.root || '';
  const hid = lib.hiddenCount || 0;
  $('#unhideAllBtn').hidden = !hid;
  if (hid) $('#unhideAllBtn').textContent = `Restore ${hid} removed photo${hid > 1 ? 's' : ''}`;
  if (lib.status === 'ready' && state.items.length) {
    show('studio');
    if (state.sel < 0) state.sel = 0;
    refresh();
    $('#grid').focus();
  } else if (lib.status === 'scanning') {
    state.scanning = true;
    show('progress');
  } else {
    show('welcome');
  }
}

function onProgress(p) {
  if (p.status === 'scanning') {
    state.scanning = true;
    show('progress');
    const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    $('#progFill').style.width = pct + '%';
    $('#progCount').textContent = p.total ? `${p.done.toLocaleString()} of ${p.total.toLocaleString()} · ${pct}%` : 'Finding files…';
    $('#progFile').textContent = p.current || '';
    $('#progTitle').textContent = p.total ? 'Checking every shot for blur, exposure & duplicates…' : 'Reading your files…';
  }
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('progress', (e) => onProgress(JSON.parse(e.data)));
  es.addEventListener('done', async () => {
    state.scanning = false;
    await loadLibrary();
    toast('Scan finished. Arrow keys to move, P pick, X reject — or hit Auto-Cull.', { sticky: true });
  });
  es.addEventListener('scanerror', (e) => {
    state.scanning = false;
    const d = JSON.parse(e.data);
    show('welcome');
    toast(d.message || 'Scan failed.', { bad: true, sticky: true });
  });
}

async function scanPath(p) {
  const r = await fetch('/api/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p }),
  });
  const j = await r.json();
  if (!r.ok) { toast(j.error || 'Could not scan that folder.', { bad: true, sticky: true }); return; }
  show('progress');
}

// ---------------------------------------------------------------- drag & drop import
async function entriesFromDrop(dt) {
  const files = [];
  const walkers = [];
  const walkEntry = (entry, base) => new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(f => { files.push({ file: f, rel: base + entry.name }); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readAll = () => reader.readEntries(async (batch) => {
        if (!batch.length) return resolve();
        await Promise.all(batch.map(e => walkEntry(e, base + entry.name + '/')));
        readAll();
      }, () => resolve());
      readAll();
    } else resolve();
  });
  for (const item of dt.items) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) walkers.push(walkEntry(entry, ''));
  }
  await Promise.all(walkers);
  return files;
}

const MEDIA_RE = /\.(jpe?g|png|webp|tiff?|heic|heif|dng|cr2|cr3|nef|arw|raf|orf|rw2|srw|pef|mp4|mov|m4v|avi|mts|m2ts|mkv|webm)$/i;

async function handleDrop(dt) {
  const all = await entriesFromDrop(dt);
  const media = all.filter(f => MEDIA_RE.test(f.rel));
  if (!media.length) { toast('No photos or videos in that drop.', { bad: true }); return; }
  const batch = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '-drop';
  show('progress');
  $('#progTitle').textContent = 'Copying files in…';
  $('#progFill').style.width = '0%';
  let done = 0, dir = null;
  const queue = [...media];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const f = queue.shift();
      const r = await fetch(`/api/upload?batch=${encodeURIComponent(batch)}&rel=${encodeURIComponent(f.rel)}`, {
        method: 'PUT', body: f.file,
      }).then(r => r.json()).catch(() => null);
      if (r && r.dir) dir = r.dir;
      done++;
      $('#progFill').style.width = Math.round(done / media.length * 100) + '%';
      $('#progCount').textContent = `Copied ${done} of ${media.length}`;
      $('#progFile').textContent = f.rel;
    }
  });
  await Promise.all(workers);
  if (!dir) { show('welcome'); toast('Import failed.', { bad: true }); return; }
  await scanPath(dir);
}

// ---------------------------------------------------------------- workflow buttons
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Failed.');
  return j;
}

function wireActions() {
  $('#autocullBtn').onclick = async () => {
    const ok = await confirmModal('Auto-Cull',
      'DropCull will:\n· reject every blurry shot\n· stack near-duplicate bursts and pick the sharpest of each\n\nNothing is moved or deleted — flags only, and you can undo.', 'Run Auto-Cull');
    if (!ok) return;
    try {
      const r = await post('/api/autocull');
      await loadLibrary();
      toast(`Auto-Cull: ${r.rejected} blurry rejected, ${r.picked} burst winners picked, ${r.stacked} duplicates stacked. Roughly ${r.estMinutes} min of clicking saved.`,
        { sticky: true, action: 'Undo', onAction: async () => { await post('/api/undo-autocull'); loadLibrary(); } });
    } catch (e) { toast(e.message, { bad: true }); }
  };

  $('#ratingsBtn').onclick = async () => {
    const n = state.items.filter(i => i.stars > 0 || i.pick).length;
    if (!n) return toast('Pick or star some shots first.', { bad: true });
    const ok = await confirmModal('Send ratings to Lightroom',
      `Writes star ratings for ${n} shots so Lightroom / Capture One see them on import.\n· RAW files get a small .xmp sidecar next to them (original untouched)\n· JPEGs & videos get the rating written into their metadata (pixels untouched)\n· Picks without stars are written as 3 stars`, 'Write ratings');
    if (!ok) return;
    toast('Writing ratings…');
    try {
      const r = await post('/api/export/ratings');
      toast(`Ratings written: ${r.sidecars} sidecars, ${r.embedded} embedded.${r.errorCount ? ' ' + r.errorCount + ' failed.' : ''}`, { sticky: true, bad: !!r.errorCount });
    } catch (e) { toast(e.message, { bad: true }); }
  };

  $('#selectsBtn').onclick = async () => {
    const n = state.items.filter(i => i.pick).length;
    if (!n) return toast('No picks yet — hit P on your keepers first.', { bad: true });
    const ok = await confirmModal('Copy picks to Selects', `Copies your ${n} picks into _DropCull/Selects, sorted by shoot. Originals stay where they are.`, 'Copy');
    if (!ok) return;
    try {
      const r = await post('/api/export/selects');
      toast(`${r.copied} picks copied to Selects.`, { sticky: true, action: 'Open folder', onAction: () => fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: r.dir }) }) });
    } catch (e) { toast(e.message, { bad: true }); }
  };

  $('#proofsBtn').onclick = async () => {
    const n = state.items.filter(i => i.pick && i.type === 'img').length;
    if (!n) return toast('No picked photos yet.', { bad: true });
    const ok = await confirmModal('Client proof JPEGs', `Makes ${n} web-sized JPEGs (2048px, lightly sharpened) from your picks — ready to send a client for approval before you edit.`, 'Make proofs');
    if (!ok) return;
    toast('Building proofs…');
    try {
      const r = await post('/api/export/proofs');
      toast(`${r.made} proof JPEGs ready.`, { sticky: true, action: 'Open folder', onAction: () => fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: r.dir }) }) });
    } catch (e) { toast(e.message, { bad: true }); }
  };

  $('#editsBtn').onclick = async () => {
    const n = state.items.filter(i => i.pick && i.type === 'img').length;
    if (!n) return toast('No picked photos yet.', { bad: true });
    const ok = await confirmModal('Auto-edit picks', `Batch-edits all ${n} picks and saves full-resolution JPEGs to _DropCull/Edited.\n\nEach photo uses the look you chose for it in the big view (Costa Rica if you didn't choose one). Originals are never touched. Big batches take a few minutes.`, 'Auto-edit');
    if (!ok) return;
    toast(`Auto-editing ${n} photos… hang tight.`);
    try {
      const r = await post('/api/export/edits');
      const msg = r.errorCount ? `${r.made} edited, ${r.errorCount} skipped.` : `${r.made} photos edited.`;
      toast(msg, { sticky: true, action: 'Open folder', onAction: () => fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: r.dir }) }) });
    } catch (e) { toast(e.message, { bad: true }); }
  };

  $('#rejectsBtn').onclick = async () => {
    const r = state.items.filter(i => i.reject && !i.inRejects);
    if (!r.length) return toast('No rejects to sweep.', { bad: true });
    const gb = (r.reduce((a, i) => a + i.size, 0) / 1e9).toFixed(2);
    const ok = await confirmModal('Sweep rejects',
      `Moves ${r.length} rejected files (${gb} GB) into _DropCull/Rejects inside this folder.\n\nNothing is deleted — "Bring rejects back" reverses it completely.`, 'Sweep');
    if (!ok) return;
    try {
      const res = await post('/api/export/rejects');
      await loadLibrary();
      toast(`${res.moved} rejects swept aside (${res.gb} GB out of your way).`, { sticky: true });
    } catch (e) { toast(e.message, { bad: true }); }
  };

  $('#unhideAllBtn').onclick = async () => {
    try {
      const r = await post('/api/unhide-all');
      await loadLibrary();
      toast(`${r.restored} photo${r.restored === 1 ? '' : 's'} back in the library.`);
    } catch (e) { toast(e.message, { bad: true }); }
  };

  $('#undoMoveBtn').onclick = async () => {
    try {
      const r = await post('/api/undo-rejects');
      await loadLibrary();
      toast(`${r.restored} files moved back where they were.`);
    } catch (e) { toast(e.message, { bad: true }); }
  };

  $('#newBtn').onclick = async () => {
    const ok = await confirmModal('Open a different folder', 'Your flags on this folder are saved — reopening it later brings everything back.', 'Continue');
    if (!ok) return;
    await post('/api/reset');
    state.items = []; state.shoots = []; state.sel = -1; state.filter = 'all'; state.shootFilter = null;
    $('#proj').hidden = true;
    show('welcome');
  };
}

// ---------------------------------------------------------------- keyboard
function onKey(e) {
  if (!$('#modal').hidden) { if (e.key === 'Escape') $('#modalCancel').click(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ($('#studio').hidden && !state.loupeOpen) return;

  const k = e.key;
  if (k === 'ArrowRight') { e.preventDefault(); select(state.sel + 1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); select(state.sel - 1); }
  else if (k === 'ArrowDown' && !state.loupeOpen) { e.preventDefault(); select(state.sel + gridCols()); }
  else if (k === 'ArrowUp' && !state.loupeOpen) { e.preventDefault(); select(state.sel - gridCols()); }
  else if (k === 'p' || k === 'P') { const it = state.filtered[state.sel]; flag({ pick: !(it && it.pick) }); }
  else if (k === 'x' || k === 'X') { const it = state.filtered[state.sel]; flag({ reject: !(it && it.reject) }); }
  else if (k === 'u' || k === 'U') flag({ pick: false, reject: false });
  else if (k >= '0' && k <= '5') flag({ stars: +k });
  else if (k === 'Enter' && !state.loupeOpen) { if (state.sel < 0) select(0); openLoupe(Math.max(0, state.sel)); }
  else if (k === 'Escape' && state.loupeOpen) closeLoupe();
  else if (k === ' ' && state.loupeOpen) { e.preventDefault(); toggleZoom(); }
  else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); hideCurrent(); }
}

// Remove the selected photo from DropCull's library — the file on disk is untouched.
async function hideCurrent() {
  const it = state.filtered[state.sel];
  if (!it) return;
  if (state.loupeOpen) closeLoupe();
  try {
    const r = await post('/api/hide', { id: it.id });
    const keep = state.sel;
    await loadLibrary();
    select(Math.min(keep, state.filtered.length - 1));
    toast(`${r.name} removed from DropCull — the file itself is untouched.`,
      { sticky: true, action: 'Undo', onAction: async () => { await post('/api/unhide', { id: r.id }); loadLibrary(); } });
  } catch (e) { toast(e.message, { bad: true }); }
}

function gridCols() {
  const cells = $('#grid .cells');
  if (!cells) return 1;
  const style = getComputedStyle(cells);
  return style.gridTemplateColumns.split(' ').length || 1;
}

// ---------------------------------------------------------------- wiring
function init() {
  show('welcome');
  connectSSE();
  wireActions();
  fetch('/api/looks').then(r => r.json())
    .then(j => { state.looks = j.looks || []; state.defaultLook = j.default || 'costa-rica'; })
    .catch(() => {});
  loadLibrary();

  // grid interactions
  $('#grid').addEventListener('click', (e) => {
    const stackBadge = e.target.closest('.badge.stack');
    if (stackBadge && stackBadge.dataset.g) {
      state.expanded.add(stackBadge.dataset.g);
      renderGrid();
      e.stopPropagation();
      return;
    }
    const cell = e.target.closest('.cell');
    if (cell) select(+cell.dataset.idx);
  });
  $('#grid').addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) openLoupe(+cell.dataset.idx);
  });

  // loupe controls
  $('#lclose').onclick = closeLoupe;
  $('#lprev').onclick = () => select(state.sel - 1);
  $('#lnext').onclick = () => select(state.sel + 1);
  $('#lpick').onclick = () => { const it = state.filtered[state.sel]; flag({ pick: !(it && it.pick) }); };
  $('#lreject').onclick = () => { const it = state.filtered[state.sel]; flag({ reject: !(it && it.reject) }); };
  $('#lzoom').onclick = toggleZoom;
  $('#lhide').onclick = () => hideCurrent();
  $('#lreveal').onclick = () => {
    const it = state.filtered[state.sel];
    if (it) fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: it.id }) });
  };

  // platform polish — server always runs on this same machine
  if (navigator.platform.startsWith('Win')) {
    $('#lreveal').textContent = 'Show in Explorer';
    $('#pathInput').placeholder = 'C:\\Photos\\Shoot-July';
  }

  // folder picking
  $('#pickBtn').onclick = async () => {
    const r = await fetch('/api/pick-folder', { method: 'POST' }).then(r => r.json());
    if (r.path) scanPath(r.path);
    else if (r.error) toast(r.error, { bad: true });
  };
  $('#pathGo').onclick = () => { const p = $('#pathInput').value.trim(); if (p) scanPath(p); };
  $('#pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pathGo').click(); });

  // drag & drop anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('#dropOverlay').hidden = false; });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
    if (state.scanning) return;
    handleDrop(e.dataTransfer);
  });

  window.addEventListener('keydown', onKey);
}

init();
