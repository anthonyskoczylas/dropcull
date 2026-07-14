#!/usr/bin/env node
/**
 * DropCull — free, local, private photo & video culling studio.
 * Drop a card dump in, auto-flag the junk, fly through review, export keepers.
 * Everything runs on this machine. Nothing is uploaded anywhere.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const sharp = require('sharp');
const exifr = require('exifr');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

// ---------------------------------------------------------------- config
const PORT = process.env.DROPCULL_PORT ? Number(process.env.DROPCULL_PORT) : 4621;
const PREVIEW_PX = 2560;   // long edge of cached previews
const THUMB_PX = 420;      // grid thumbnails
const CONCURRENCY = 4;     // files processed in parallel
const BLUR_FLAG = 45;      // laplacian variance below this => flagged blurry
const BURST_GAP_S = 8;     // max seconds between shots to be a burst
const HAMMING_BURST = 10;  // max dHash distance to be "near duplicate"
const SHOOT_GAP_H = 3;     // hours of silence => new shoot
const MAX_FILES = 25000;   // sanity cap so nobody scans their whole disk

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.heic', '.heif',
  '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.srw', '.pef']);
const RAW_EXTS = new Set(['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.srw', '.pef']);
const SHARP_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
const VID_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mts', '.m2ts', '.mkv', '.webm']);

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const SETTINGS_FILE = path.join(os.homedir(), '.dropcull.json');
const INBOX_DIR = path.join(os.homedir(), 'Pictures', 'DropCull Inbox');

// ---------------------------------------------------------------- state
const lib = {
  root: null,
  status: 'idle', // idle | scanning | ready | error
  message: '',
  total: 0,
  done: 0,
  current: '',
  items: [],      // see makeItem()
  shoots: [],     // {id,label,start,end,count}
};
let autocullBackup = null; // flag snapshot for undo
let scanToken = 0;         // invalidates a scan when a new one starts
const sseClients = new Set();

// ---------------------------------------------------------------- small utils
const extOf = (p) => path.extname(p).toLowerCase();
const idFor = (rel) => crypto.createHash('md5').update(rel).digest('hex').slice(0, 12);
const appDir = (root) => path.join(root, '_DropCull');
const prevDir = (root) => path.join(appDir(root), 'previews');
const thumbDir = (root) => path.join(appDir(root), 'thumbs');
const indexFile = (root) => path.join(appDir(root), 'index.json');
const moveManifestFile = (root) => path.join(appDir(root), 'last-move.json');
const sanitize = (s) => String(s).replace(/[\/\\:*?"<>|]+/g, '-').trim() || 'untitled';

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)}: ${String(stderr || err.message).slice(0, 400)}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function pool(items, n, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function safeMove(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') { await fsp.copyFile(from, to); await fsp.unlink(from); }
    else throw e;
  }
}

async function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
  for (let n = 2; ; n++) {
    const cand = path.join(dir, `${base}-${n}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s)); } catch { /* non-fatal */ }
}

let saveTimer = null;
function saveIndexSoon() {
  if (!lib.root) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = { root: lib.root, savedAt: new Date().toISOString(), items: lib.items, shoots: lib.shoots };
    fsp.writeFile(indexFile(lib.root), JSON.stringify(data)).catch(() => {});
  }, 500);
}

// ---------------------------------------------------------------- scanning
async function walk(dir, out, depth = 0) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '_DropCull' || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 12) await walk(abs, out, depth + 1);
    } else if (e.isFile()) {
      const ext = extOf(e.name);
      if (IMG_EXTS.has(ext) || VID_EXTS.has(ext)) out.push(abs);
      if (out.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files in that folder — point DropCull at one shoot or one card dump, not a whole drive.`);
    }
  }
}

function makeItem(root, abs, stat) {
  const rel = path.relative(root, abs);
  const ext = extOf(abs);
  return {
    id: idFor(rel),
    rel,
    abs,
    name: path.basename(abs),
    ext,
    type: VID_EXTS.has(ext) ? 'vid' : 'img',
    raw: RAW_EXTS.has(ext),
    size: stat.size,
    ts: stat.mtimeMs,
    exif: null,
    video: null,        // {dur,w,h,fps}
    blur: null,         // laplacian variance (higher = sharper)
    meanLum: null,
    clipLo: null,       // % of pixels crushed to black
    clipHi: null,       // % of pixels blown to white
    hash: null,         // dHash hex
    flags: { blurry: false, under: false, over: false },
    group: null,        // burst group id
    groupBest: false,   // sharpest of its burst
    shoot: null,
    pick: false,
    reject: false,
    stars: 0,
    inRejects: false,
    error: null,
  };
}

async function makePreview(item, root) {
  const dst = path.join(prevDir(root), item.id + '.jpg');
  if (fs.existsSync(dst)) return dst;

  if (item.type === 'vid') {
    const dur = item.video && item.video.dur ? item.video.dur : 4;
    const at = Math.max(0.5, Math.min(dur * 0.25, dur - 0.2)).toFixed(2);
    await run(ffmpegPath, ['-ss', at, '-i', item.abs, '-frames:v', '1',
      '-vf', 'scale=1280:-2', '-q:v', '3', '-y', dst]);
    return dst;
  }

  if (SHARP_EXTS.has(item.ext)) {
    await sharp(item.abs, { failOn: 'none' }).rotate()
      .resize(PREVIEW_PX, PREVIEW_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 }).toFile(dst);
    return dst;
  }

  // RAW / HEIC: macOS converts natively via sips (handles CR3, NEF, ARW, DNG, HEIC…)
  if (IS_MAC) {
    try {
      await run('sips', ['-s', 'format', 'jpeg', '-Z', String(PREVIEW_PX), item.abs, '--out', dst]);
      if (fs.existsSync(dst)) return dst;
    } catch { /* fall through to embedded previews */ }
  }
  // Any platform: pull the full-size JPEG the camera embeds inside the RAW —
  // no RAW decoding needed, and it's the only RAW path on Windows/Linux.
  const extracted = dst + '.extract.jpg';
  for (const method of ['extractJpgFromRaw', 'extractPreview']) {
    try {
      await getExiftool()[method](item.abs, extracted);
      await sharp(extracted, { failOn: 'none' }).rotate()
        .resize(PREVIEW_PX, PREVIEW_PX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 }).toFile(dst);
      return dst;
    } catch { /* try next method */ } finally {
      await fsp.unlink(extracted).catch(() => {});
    }
  }
  // Last resort: the small EXIF thumbnail inside the file
  const thumb = await exifr.thumbnail(item.abs);
  if (!thumb) throw new Error('no preview available for this format');
  await sharp(Buffer.from(thumb), { failOn: 'none' }).rotate()
    .resize(PREVIEW_PX, PREVIEW_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 }).toFile(dst);
  return dst;
}

async function analyzeImage(previewPath) {
  // Blur: variance of the Laplacian (edge energy). Low variance = soft/blurry.
  const lap = await sharp(previewPath).grayscale()
    .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
    .raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < lap.length; i++) sum += lap[i];
  const mean = sum / lap.length;
  let vs = 0;
  for (let i = 0; i < lap.length; i++) { const d = lap[i] - mean; vs += d * d; }
  const blur = vs / lap.length;

  // Exposure: mean luminance + clipped shadow/highlight percentages.
  const tiny = await sharp(previewPath).grayscale()
    .resize(320, 320, { fit: 'inside' }).raw().toBuffer();
  let lum = 0, lo = 0, hi = 0;
  for (let i = 0; i < tiny.length; i++) {
    const v = tiny[i];
    lum += v;
    if (v < 10) lo++;
    else if (v > 245) hi++;
  }
  const meanLum = lum / tiny.length;
  const clipLo = lo / tiny.length;
  const clipHi = hi / tiny.length;

  // dHash: 64-bit perceptual fingerprint for duplicate/burst detection.
  const h = await sharp(previewPath).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bits = (bits << 1n) | (h[y * 9 + x] < h[y * 9 + x + 1] ? 1n : 0n);
  }
  const hash = bits.toString(16).padStart(16, '0');

  return { blur, meanLum, clipLo, clipHi, hash };
}

function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

async function probeVideo(abs) {
  const { stdout } = await run(ffprobePath, ['-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', abs]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
  let fps = null;
  if (v.r_frame_rate && v.r_frame_rate.includes('/')) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d) fps = Math.round((n / d) * 10) / 10;
  }
  const created = j.format && j.format.tags && (j.format.tags.creation_time || j.format.tags.com_apple_quicktime_creationdate);
  return {
    dur: j.format && j.format.duration ? Number(j.format.duration) : null,
    w: v.width || null, h: v.height || null, fps,
    created: created ? Date.parse(created) : null,
  };
}

async function processFile(item, root) {
  try {
    if (item.type === 'img') {
      try {
        const ex = await exifr.parse(item.abs, {
          pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'LensModel',
            'ISO', 'ExposureTime', 'FNumber', 'FocalLength', 'ExifImageWidth', 'ExifImageHeight'],
        });
        if (ex) {
          const taken = ex.DateTimeOriginal || ex.CreateDate;
          if (taken instanceof Date && !isNaN(taken)) item.ts = taken.getTime();
          item.exif = {
            camera: [ex.Make, ex.Model].filter(Boolean).join(' ').replace(/(\S+)\s+\1/i, '$1') || null,
            lens: ex.LensModel || null,
            iso: ex.ISO || null,
            shutter: ex.ExposureTime || null,
            aperture: ex.FNumber || null,
            focal: ex.FocalLength || null,
            w: ex.ExifImageWidth || null,
            h: ex.ExifImageHeight || null,
          };
        }
      } catch { /* EXIF optional */ }

      const prev = await makePreview(item, root);
      const a = await analyzeImage(prev);
      Object.assign(item, a);
      item.flags.under = a.meanLum < 35 || (a.meanLum < 60 && a.clipLo > 0.20);
      item.flags.over = a.meanLum > 220 || (a.meanLum > 195 && a.clipHi > 0.12);
      // a crushed-dark frame has no edge energy left — call it dark, not blurry
      item.flags.blurry = a.blur < BLUR_FLAG && !item.flags.under;

      const meta = await sharp(prev).metadata();
      if (!item.exif) item.exif = {};
      if (!item.exif.w) { item.exif.w = meta.width; item.exif.h = meta.height; }

      await sharp(prev).resize(THUMB_PX, THUMB_PX, { fit: 'inside' })
        .jpeg({ quality: 72 }).toFile(path.join(thumbDir(root), item.id + '.jpg'));
    } else {
      item.video = await probeVideo(item.abs);
      if (item.video.created) item.ts = item.video.created;
      const prev = await makePreview(item, root);
      await sharp(prev).resize(THUMB_PX, THUMB_PX, { fit: 'inside' })
        .jpeg({ quality: 72 }).toFile(path.join(thumbDir(root), item.id + '.jpg'));
    }
  } catch (e) {
    item.error = String(e.message || e).slice(0, 200);
  }
}

function buildGroups(items) {
  for (const i of items) { i.group = null; i.groupBest = false; }
  const imgs = items.filter(i => i.type === 'img' && i.hash && !i.error).sort((a, b) => a.ts - b.ts);
  let gid = 0;
  let current = null; // array of members
  const close = () => {
    if (current && current.length > 1) {
      const id = 'g' + (++gid);
      let best = current[0];
      for (const m of current) if ((m.blur || 0) > (best.blur || 0)) best = m;
      for (const m of current) { m.group = id; m.groupBest = m === best; }
    }
    current = null;
  };
  for (const img of imgs) {
    if (current) {
      const last = current[current.length - 1];
      const dt = (img.ts - last.ts) / 1000;
      if (dt <= BURST_GAP_S && hamming(img.hash, last.hash) <= HAMMING_BURST) {
        current.push(img);
        continue;
      }
      close();
    }
    current = [img];
  }
  close();
}

function timeOfDayLabel(d) {
  const h = d.getHours();
  if (h >= 5 && h < 11) return 'Morning';
  if (h >= 11 && h < 17) return 'Afternoon';
  if (h >= 17 && h < 21) return 'Evening';
  return 'Night';
}

function buildShoots(items) {
  const sorted = [...items].sort((a, b) => a.ts - b.ts);
  const shoots = [];
  let cur = null;
  for (const it of sorted) {
    if (!cur || it.ts - cur.end > SHOOT_GAP_H * 3600e3) {
      const d = new Date(it.ts);
      cur = {
        id: 's' + (shoots.length + 1),
        label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + timeOfDayLabel(d),
        start: it.ts, end: it.ts, count: 0,
      };
      shoots.push(cur);
    }
    cur.end = Math.max(cur.end, it.ts);
    cur.count++;
    it.shoot = cur.id;
  }
  return shoots;
}

async function startScan(root) {
  root = path.resolve(root);
  const st = await fsp.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('That folder does not exist: ' + root);
  if (root === os.homedir() || root === '/') throw new Error('Pick a photo folder, not your whole home folder.');

  const token = ++scanToken;
  lib.root = root;
  lib.status = 'scanning';
  lib.message = '';
  lib.items = [];
  lib.shoots = [];
  lib.done = 0;
  lib.total = 0;
  lib.current = 'Looking for photos and videos…';
  saveSettings({ lastRoot: root });
  broadcast('progress', progressPayload());

  (async () => {
    try {
      await fsp.mkdir(prevDir(root), { recursive: true });
      await fsp.mkdir(thumbDir(root), { recursive: true });

      // Carry over flags from a previous session on the same folder.
      let oldFlags = new Map();
      try {
        const old = JSON.parse(await fsp.readFile(indexFile(root), 'utf8'));
        for (const it of old.items || []) oldFlags.set(it.rel + '|' + it.size, it);
      } catch { /* first run */ }

      const files = [];
      await walk(root, files);
      if (token !== scanToken) return;
      if (!files.length) throw new Error('No photos or videos found in that folder.');

      const items = [];
      for (const abs of files) {
        const stat = await fsp.stat(abs).catch(() => null);
        if (stat) items.push(makeItem(root, abs, stat));
      }
      lib.total = items.length;
      lib.items = items;
      broadcast('progress', progressPayload());

      await pool(items, CONCURRENCY, async (item) => {
        if (token !== scanToken) return;
        lib.current = item.name;
        await processFile(item, root);
        const old = oldFlags.get(item.rel + '|' + item.size);
        if (old) {
          item.pick = !!old.pick; item.reject = !!old.reject;
          item.stars = old.stars || 0; item.inRejects = !!old.inRejects;
          item.hidden = !!old.hidden;
        }
        lib.done++;
        if (lib.done % 5 === 0 || lib.done === lib.total) broadcast('progress', progressPayload());
      });
      if (token !== scanToken) return;

      buildGroups(lib.items);
      lib.shoots = buildShoots(lib.items);
      lib.status = 'ready';
      lib.current = '';
      saveIndexSoon();
      broadcast('done', { total: lib.total });
    } catch (e) {
      if (token !== scanToken) return;
      lib.status = 'error';
      lib.message = String(e.message || e);
      broadcast('scanerror', { message: lib.message });
    }
  })();
}

function progressPayload() {
  return { status: lib.status, done: lib.done, total: lib.total, current: lib.current, message: lib.message };
}

// ---------------------------------------------------------------- exports
function ratingFor(item) {
  if (item.stars > 0) return item.stars;
  if (item.pick) return 3;
  return 0;
}

function xmpSidecar(rating) {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="DropCull 1.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmp:Rating="${rating}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

let _exiftool = null;
function getExiftool() {
  if (!_exiftool) _exiftool = require('exiftool-vendored').exiftool;
  return _exiftool;
}

async function exportRatings() {
  const targets = lib.items.filter(i => !i.error && !i.inRejects && !i.hidden && ratingFor(i) > 0);
  let sidecars = 0, embedded = 0;
  const errors = [];
  for (const it of targets) {
    const rating = ratingFor(it);
    try {
      if (it.raw) {
        const side = it.abs.slice(0, -path.extname(it.abs).length) + '.xmp';
        await fsp.writeFile(side, xmpSidecar(rating), 'utf8');
        sidecars++;
      } else {
        const et = getExiftool();
        try {
          await et.write(it.abs, { Rating: rating }, { writeArgs: ['-overwrite_original'] });
        } catch (e) {
          // older exiftool-vendored versions take writeArgs as an array
          if (/writeArgs|options|argument/i.test(String(e))) {
            await et.write(it.abs, { Rating: rating }, ['-overwrite_original']);
          } else throw e;
        }
        embedded++;
      }
    } catch (e) {
      errors.push(it.name + ': ' + String(e.message || e).slice(0, 120));
    }
  }
  return { sidecars, embedded, errors: errors.slice(0, 5), errorCount: errors.length };
}

async function exportRejects() {
  const root = lib.root;
  const targets = lib.items.filter(i => i.reject && !i.inRejects && !i.error);
  const moved = [];
  let bytes = 0;
  for (const it of targets) {
    const dst = path.join(appDir(root), 'Rejects', it.rel);
    await safeMove(it.abs, dst);
    moved.push({ id: it.id, from: it.abs, to: dst });
    // Drag any sidecar along with its photo.
    const side = it.abs.slice(0, -path.extname(it.abs).length) + '.xmp';
    if (fs.existsSync(side)) {
      const sideDst = dst.slice(0, -path.extname(dst).length) + '.xmp';
      await safeMove(side, sideDst);
      moved.push({ id: null, from: side, to: sideDst });
    }
    it.abs = dst;
    it.inRejects = true;
    bytes += it.size;
  }
  await fsp.writeFile(moveManifestFile(root), JSON.stringify({ movedAt: new Date().toISOString(), moved }));
  saveIndexSoon();
  return { moved: targets.length, gb: +(bytes / 1e9).toFixed(2) };
}

async function undoRejects() {
  const root = lib.root;
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(moveManifestFile(root), 'utf8')); }
  catch { throw new Error('Nothing to undo.'); }
  let back = 0;
  for (const m of manifest.moved.reverse()) {
    if (!fs.existsSync(m.to)) continue;
    await safeMove(m.to, m.from);
    if (m.id) {
      const it = lib.items.find(i => i.id === m.id);
      if (it) { it.abs = m.from; it.inRejects = false; }
      back++;
    }
  }
  await fsp.unlink(moveManifestFile(root)).catch(() => {});
  saveIndexSoon();
  return { restored: back };
}

async function exportSelects() {
  const root = lib.root;
  const shootLabel = Object.fromEntries(lib.shoots.map(s => [s.id, sanitize(s.label)]));
  const targets = lib.items.filter(i => i.pick && !i.error && !i.inRejects);
  let copied = 0;
  for (const it of targets) {
    const dst = await uniquePath(path.join(appDir(root), 'Selects', shootLabel[it.shoot] || 'Shoot', it.name));
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(it.abs, dst);
    copied++;
  }
  return { copied, dir: path.join(appDir(root), 'Selects') };
}

async function exportProofs() {
  const root = lib.root;
  const shootLabel = Object.fromEntries(lib.shoots.map(s => [s.id, sanitize(s.label)]));
  const targets = lib.items.filter(i => i.pick && i.type === 'img' && !i.error);
  let made = 0;
  for (const it of targets) {
    const prev = path.join(prevDir(root), it.id + '.jpg');
    if (!fs.existsSync(prev)) continue;
    const base = it.name.slice(0, -path.extname(it.name).length) + '.jpg';
    const dst = await uniquePath(path.join(appDir(root), 'Proofs', shootLabel[it.shoot] || 'Shoot', base));
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await sharp(prev).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .sharpen({ sigma: 0.8 }).jpeg({ quality: 85, mozjpeg: true }).toFile(dst);
    made++;
  }
  return { made, dir: path.join(appDir(root), 'Proofs') };
}

// One-click batch edit: full-resolution auto-enhance for every pick.
// Gray-world white balance + gentle levels + saturation + sharpen.
// Originals are never touched — edited copies land in _DropCull/Edited.
// Luminance percentiles from a small grayscale render — drives the per-photo decisions.
async function measureTones(src) {
  const buf = await sharp(src, { failOn: 'none' }).rotate().grayscale()
    .resize(500, 500, { fit: 'inside' }).raw().toBuffer();
  const h = new Array(256).fill(0);
  for (const v of buf) h[v]++;
  const n = buf.length;
  const pct = (q) => { let c = 0; for (let i = 0; i < 256; i++) { c += h[i]; if (c >= n * q) return i; } return 255; };
  return { p1: pct(0.01), p50: pct(0.5), p99: pct(0.99) };
}

// Philosophy: do less. A good auto-edit is invisible — polish, never a makeover.
// Deliberately NO white-balance meddling (it murders sunsets and skin tones) and
// NO hard histogram stretch (it crushes moody light). Tuned on real photos.
async function enhanceOne(src, dst) {
  const m = await measureTones(src);
  // Soft black/white point: map [bp,wp] → [8,248] with the slope capped at 1.10,
  // so hazy/flat shots get cleaned but nothing ever turns crunchy.
  const bp = Math.min(m.p1, 20), wp = Math.max(m.p99, 235);
  let a = (248 - 8) / Math.max(1, wp - bp);
  a = Math.max(1.0, Math.min(1.10, a));
  const b = 8 - a * bp;
  let pipe = sharp(src, { failOn: 'none' }).rotate();
  if (a > 1.005 || Math.abs(b) > 1.5) pipe = pipe.linear([a, a, a], [b, b, b]);
  // Underexposed shot: gamma the midtones toward healthy (118), capped at 2.0.
  // Healthy shots (median ≥ 80) are left alone. g solves (p50/255)^(1/g) = 118/255.
  if (m.p50 < 80) {
    const g = Math.min(2.0, Math.log(Math.max(8, m.p50) / 255) / Math.log(118 / 255));
    if (g > 1.05) pipe = pipe.gamma(1.0, g);
  }
  await pipe
    .modulate({ saturation: 1.06 })                 // whisper of pop
    .sharpen({ sigma: 0.6 })
    .withMetadata()                                 // keep camera EXIF in the copy
    .jpeg({ quality: 90, mozjpeg: true }).toFile(dst);
}

async function exportEdits() {
  const root = lib.root;
  const shootLabel = Object.fromEntries(lib.shoots.map(s => [s.id, sanitize(s.label)]));
  const targets = lib.items.filter(i => i.pick && i.type === 'img' && !i.error && !i.inRejects);
  let made = 0;
  const errors = [];
  await pool(targets, 3, async (it) => {
    try {
      const base = it.name.slice(0, -path.extname(it.name).length) + '.jpg';
      const dst = await uniquePath(path.join(appDir(root), 'Edited', shootLabel[it.shoot] || 'Shoot', base));
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (SHARP_EXTS.has(it.ext)) {
        await enhanceOne(it.abs, dst);               // full original resolution
      } else {
        // RAW: enhance the biggest JPEG we can get out of the file.
        const tmp = dst + '.extract.jpg';
        let got = false;
        for (const method of ['extractJpgFromRaw', 'extractPreview']) {
          try { await getExiftool()[method](it.abs, tmp); got = true; break; } catch { /* next */ }
        }
        const src = got ? tmp : path.join(prevDir(root), it.id + '.jpg');
        if (!fs.existsSync(src)) throw new Error('no source available');
        await enhanceOne(src, dst);
        await fsp.unlink(tmp).catch(() => {});
      }
      made++;
    } catch (e) {
      errors.push(`${it.name}: ${e.message}`);
    }
  });
  return { made, errorCount: errors.length, errors: errors.slice(0, 5), dir: path.join(appDir(root), 'Edited') };
}

function reportCSV() {
  const shootLabel = Object.fromEntries(lib.shoots.map(s => [s.id, s.label]));
  const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const rows = [['file', 'folder', 'type', 'shoot', 'pick', 'reject', 'stars', 'sharpness', 'blurry', 'too_dark', 'too_bright', 'burst_group', 'camera', 'lens', 'iso', 'shutter', 'aperture', 'size_mb', 'taken'].join(',')];
  for (const it of lib.items) {
    if (it.hidden) continue;
    rows.push([
      it.name, path.dirname(it.rel), it.type === 'vid' ? 'video' : 'photo', shootLabel[it.shoot] || '',
      it.pick ? 'yes' : '', it.reject ? 'yes' : '', it.stars || '',
      it.blur != null ? Math.round(it.blur) : '',
      it.flags.blurry ? 'yes' : '', it.flags.under ? 'yes' : '', it.flags.over ? 'yes' : '',
      it.group || '',
      it.exif && it.exif.camera || '', it.exif && it.exif.lens || '', it.exif && it.exif.iso || '',
      it.exif && it.exif.shutter ? (it.exif.shutter < 1 ? '1/' + Math.round(1 / it.exif.shutter) : it.exif.shutter + 's') : '',
      it.exif && it.exif.aperture ? 'f/' + it.exif.aperture : '',
      (it.size / 1e6).toFixed(1),
      new Date(it.ts).toLocaleString('en-US'),
    ].map(esc).join(','));
  }
  return rows.join('\n');
}

function autocull() {
  autocullBackup = lib.items.map(i => ({ id: i.id, pick: i.pick, reject: i.reject }));
  let rejected = 0, picked = 0, stacked = 0;
  for (const it of lib.items) {
    if (it.type !== 'img' || it.error || it.hidden) continue;
    if (it.flags.blurry && !it.pick && !it.reject) { it.reject = true; rejected++; }
  }
  const groups = new Map();
  for (const it of lib.items) if (it.group) {
    if (!groups.has(it.group)) groups.set(it.group, []);
    groups.get(it.group).push(it);
  }
  for (const members of groups.values()) {
    const best = members.find(m => m.groupBest);
    if (best && !best.reject && !best.pick) { best.pick = true; picked++; }
    stacked += members.length - 1;
  }
  saveIndexSoon();
  // ~4s saved per junk shot he never has to eyeball, ~3s per burst twin skipped
  const estMinutes = Math.round((rejected * 4 + stacked * 3) / 60);
  return { rejected, picked, stacked, estMinutes };
}

function undoAutocull() {
  if (!autocullBackup) throw new Error('Nothing to undo.');
  const map = new Map(autocullBackup.map(b => [b.id, b]));
  for (const it of lib.items) {
    const b = map.get(it.id);
    if (b) { it.pick = b.pick; it.reject = b.reject; }
  }
  autocullBackup = null;
  saveIndexSoon();
  return { ok: true };
}

// ---------------------------------------------------------------- server
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ah = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e);
  res.status(500).json({ error: String(e.message || e) });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  const beat = setInterval(() => res.write(': beat\n\n'), 25000);
  req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
});

app.get('/api/state', (req, res) => res.json(progressPayload()));

app.get('/api/library', (req, res) => {
  const visible = lib.items.filter(i => !i.hidden);
  res.json({
    root: lib.root, status: lib.status, message: lib.message,
    done: lib.done, total: lib.total,
    hiddenCount: lib.items.length - visible.length,
    shoots: lib.shoots.map(s => ({ ...s, count: visible.filter(i => i.shoot === s.id).length })),
    items: visible.map(({ abs, ...rest }) => rest), // keep absolute paths server-side
  });
});

app.post('/api/pick-folder', ah(async (req, res) => {
  if (IS_MAC) {
    try {
      const { stdout } = await run('osascript', ['-e',
        'POSIX path of (choose folder with prompt "Pick the folder with your photos & videos")']);
      return res.json({ path: stdout.trim() });
    } catch {
      return res.json({ path: null }); // user hit cancel
    }
  }
  if (IS_WIN) {
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-STA', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Pick the folder with your photos & videos'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }"]);
      return res.json({ path: stdout.trim() || null });
    } catch {
      return res.json({ path: null });
    }
  }
  res.status(400).json({ error: 'No native folder picker on this system. Type the folder path instead.' });
}));

app.post('/api/scan', ah(async (req, res) => {
  const p = req.body && req.body.path;
  if (!p) return res.status(400).json({ error: 'No folder given.' });
  if (lib.status === 'scanning') return res.status(409).json({ error: 'Already scanning.' });
  await startScan(p);
  res.json({ ok: true });
}));

app.post('/api/reset', (req, res) => {
  scanToken++;
  lib.root = null; lib.status = 'idle'; lib.items = []; lib.shoots = [];
  lib.done = 0; lib.total = 0; lib.message = '';
  saveSettings({ lastRoot: null });
  res.json({ ok: true });
});

// Browser drag-and-drop lands here, one file per request, streamed to the Inbox.
app.put('/api/upload', (req, res) => {
  const batch = sanitize(String(req.query.batch || 'drop'));
  const relRaw = String(req.query.rel || 'file');
  const rel = relRaw.split(/[\\/]/).map(s => sanitize(s)).filter(s => s && s !== '..').join(path.sep);
  const dst = path.join(INBOX_DIR, batch, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const out = fs.createWriteStream(dst);
  req.pipe(out);
  out.on('finish', () => res.json({ ok: true, dir: path.join(INBOX_DIR, batch) }));
  out.on('error', (e) => res.status(500).json({ error: String(e.message) }));
});

app.get('/api/thumb/:id', (req, res) => {
  if (!lib.root) return res.status(404).end();
  res.sendFile(path.join(thumbDir(lib.root), req.params.id + '.jpg'), (err) => { if (err) res.status(404).end(); });
});

app.get('/api/preview/:id', (req, res) => {
  if (!lib.root) return res.status(404).end();
  res.sendFile(path.join(prevDir(lib.root), req.params.id + '.jpg'), (err) => { if (err) res.status(404).end(); });
});

// Full original file, with Range support so videos scrub smoothly.
app.get('/api/media/:id', ah(async (req, res) => {
  const it = lib.items.find(i => i.id === req.params.id);
  if (!it) return res.status(404).end();
  const st = await fsp.stat(it.abs).catch(() => null);
  if (!st) return res.status(404).end();
  const types = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  const type = types[it.ext] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? parseInt(m[1]) : 0;
    let end = m[2] ? parseInt(m[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    });
    fs.createReadStream(it.abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(it.abs).pipe(res);
  }
}));

// "Remove from DropCull" — the photo disappears from the library and all exports,
// but the FILE on disk is completely untouched. Reversible via /api/unhide.
app.post('/api/hide', ah(async (req, res) => {
  const it = lib.items.find(i => i.id === (req.body && req.body.id));
  if (!it) return res.status(404).json({ error: 'Unknown item.' });
  it.hidden = true;
  it.pick = false; it.reject = false; it.stars = 0; // out of every workflow
  saveIndexSoon();
  res.json({ ok: true, id: it.id, name: it.name });
}));

app.post('/api/unhide', ah(async (req, res) => {
  const it = lib.items.find(i => i.id === (req.body && req.body.id));
  if (!it) return res.status(404).json({ error: 'Unknown item.' });
  it.hidden = false;
  saveIndexSoon();
  res.json({ ok: true, id: it.id });
}));

app.post('/api/unhide-all', ah(async (req, res) => {
  let restored = 0;
  for (const it of lib.items) if (it.hidden) { it.hidden = false; restored++; }
  saveIndexSoon();
  res.json({ restored });
}));

app.post('/api/flag', ah(async (req, res) => {
  const { id, patch } = req.body || {};
  const it = lib.items.find(i => i.id === id);
  if (!it) return res.status(404).json({ error: 'Unknown item.' });
  if (patch.pick !== undefined) { it.pick = !!patch.pick; if (it.pick) it.reject = false; }
  if (patch.reject !== undefined) { it.reject = !!patch.reject; if (it.reject) it.pick = false; }
  if (patch.stars !== undefined) it.stars = Math.max(0, Math.min(5, patch.stars | 0));
  saveIndexSoon();
  res.json({ pick: it.pick, reject: it.reject, stars: it.stars });
}));

app.post('/api/autocull', ah(async (req, res) => res.json(autocull())));
app.post('/api/undo-autocull', ah(async (req, res) => res.json(undoAutocull())));
app.post('/api/export/rejects', ah(async (req, res) => res.json(await exportRejects())));
app.post('/api/undo-rejects', ah(async (req, res) => res.json(await undoRejects())));
app.post('/api/export/selects', ah(async (req, res) => res.json(await exportSelects())));
app.post('/api/export/proofs', ah(async (req, res) => res.json(await exportProofs())));
app.post('/api/export/edits', ah(async (req, res) => res.json(await exportEdits())));
app.post('/api/export/ratings', ah(async (req, res) => res.json(await exportRatings())));

app.get('/api/export/report', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="dropcull-report.csv"');
  res.send(reportCSV());
});

app.post('/api/open', ah(async (req, res) => {
  if (!IS_MAC && !IS_WIN) return res.status(400).json({ error: 'Not supported on this system.' });
  const p = req.body && req.body.path;
  const it = req.body && req.body.id ? lib.items.find(i => i.id === req.body.id) : null;
  if (!it && !(p && p.startsWith(appDir(lib.root || '///none')))) return res.status(400).json({ error: 'Bad path.' });
  if (IS_MAC) {
    if (it) await run('open', ['-R', it.abs]);
    else await run('open', [p]);
  } else {
    // explorer.exe often exits non-zero even on success — fire and forget.
    const args = it ? ['/select,' + it.abs] : [p];
    spawn('explorer', args, { detached: true, stdio: 'ignore' }).unref();
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- boot
(async () => {
  // Reopen the last project automatically so Byron picks up where he left off.
  const { lastRoot } = loadSettings();
  if (lastRoot && fs.existsSync(indexFile(lastRoot))) {
    try {
      const data = JSON.parse(await fsp.readFile(indexFile(lastRoot), 'utf8'));
      lib.root = lastRoot;
      lib.items = (data.items || []).map(it => ({ ...it, abs: path.join(lastRoot, it.inRejects ? path.join('_DropCull', 'Rejects', it.rel) : it.rel) }));
      lib.shoots = data.shoots || [];
      lib.status = 'ready';
      lib.total = lib.items.length;
      lib.done = lib.items.length;
      console.log(`Restored last project: ${lastRoot} (${lib.items.length} items)`);
    } catch { /* fresh start */ }
  }

  const url = `http://localhost:${PORT}`;
  const openBrowser = () => {
    if (IS_MAC) spawn('open', [url]);
    else if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  };
  app.listen(PORT, '127.0.0.1', () => {
    let ver = '';
    try { ver = ' v' + fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch { /* optional */ }
    console.log(`\nDropCull${ver} running → ${url}\n`);
    if (process.argv.includes('--open')) openBrowser();
  }).on('error', (e) => {
    // Double-clicked the launcher while DropCull is already running:
    // don't crash with a scary error — just bring the app up in the browser.
    if (e.code === 'EADDRINUSE') {
      console.log('\nDropCull is already running — opening it in your browser.\n');
      openBrowser();
      setTimeout(() => process.exit(0), 1500);
    } else throw e;
  });
})();

process.on('SIGINT', async () => {
  if (_exiftool) await _exiftool.end().catch(() => {});
  process.exit(0);
});
