// dsh-plugin-meiju-english — Host half.
//
// A local-only JSON API under /api/meiju-english/* for the "美剧英语学习" panel,
// a generate-material job runner (tools/build_episode.mjs), a path-traversal-safe
// media streamer with HTTP Range support, and a small LAN HTTP server so a phone
// on the same Wi-Fi can open a listening page and stream the trimmed audio.
//
// Node builtins only. No external npm packages, no network calls, no writes
// outside the project data root. Everything here is defensive: a broken catalog,
// a missing file or a crashing child process must never take the Host down.
//
// v3 adds pronunciation scoring through the Host's own optional local speech
// engine: the experimental speech-to-text service (SenseVoice, offline) is bound
// in its own inject scope and exposed as /stt-status, /stt-prepare and /stt. The
// exact same three endpoints are also mounted on the LAN server for loopback
// verification of the model download + transcription.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'meiju-english';
export const inject = [];

const BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BUNDLE_DIR, '..');
const DEFAULT_DATA_ROOT = path.join(ROOT, 'data');
const TOOLS_DIR = path.join(ROOT, 'tools');
const BUILDER_SCRIPT = path.join(TOOLS_DIR, 'build_episode.mjs');
const LISTEN_TEMPLATE_FILE = path.join(BUNDLE_DIR, 'listen.html');

const API = '/api/meiju-english';
const DEFAULT_LAN_PORT = 8791;
const LAN_PORT_TRIES = 6;
const JOB_LIMIT = 20;
const LOG_TAIL_LIMIT = 12 * 1024;
const JSON_CACHE_LIMIT = 400;
const LISTEN_SEGMENT_LIMIT = 60;
const SCAN_FILE_LIMIT = 20000;
const SCAN_MAX_DEPTH = 2;
const BODY_LIMIT = 1024 * 1024;

// Local speech-to-text (pronunciation scoring) limits.
const STT_BODY_LIMIT = 8 * 1024 * 1024;
const STT_MAX_AUDIO_SECONDS = 30;
const STT_TIMEOUT_MS = 120000;
const STT_DEFAULT_LANGUAGE = 'en';

// Mount diagnostics: the plugin manager cannot show the Host console, so every
// activation/mount/route-registration outcome is appended here (best effort).
const DIAG_FILE = path.join(ROOT, 'verification', 'mount.log');
function diag(message) {
  try {
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true });
    fs.appendFileSync(DIAG_FILE, `${new Date().toISOString()} pid=${process.pid} ${message}\n`);
  } catch {
    /* diagnostics must never break activation */
  }
}
diag(`module loaded bundle=${BUNDLE_DIR} root=${ROOT} data=${DEFAULT_DATA_ROOT} ffmpeg=${process.env.FFMPEG_PATH || 'default'}`);

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi']);
const SUBTITLE_EXTS = new Set(['.ass', '.ssa', '.srt', '.vtt']);
const VIDEO_EXT_RANK = { '.mkv': 0, '.mp4': 1, '.avi': 2 };
const SUBTITLE_EXT_RANK = { '.ass': 0, '.ssa': 1, '.srt': 2, '.vtt': 3 };

const EPISODE_TOKEN_RE = /s(\d{1,2})e(\d{1,2})/i;
const EPISODE_ID_RE = /^s(\d{1,2})e(\d{1,2})$/i;
const VIRTUAL_IFACE_RE = /vethernet|vmware|virtualbox|vbox|hyper-?v|wsl|docker|tailscale|zerotier|npcap|loopback|hamachi/i;

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
};

const FALLBACK_LISTEN_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}} · 美剧英语磨耳朵</title>
<style>
  body { margin: 0; padding: 24px 18px; background: #171210; color: #f6ecdf; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; line-height: 1.6; }
  h1 { font-size: 24px; color: #f7d9b6; margin: 0 0 6px; }
  .en { color: #b7a390; font-style: italic; margin: 0 0 10px; }
  .show { color: #b7a390; font-size: 13px; }
  audio { width: 100%; margin: 18px 0; }
  .note { padding: 10px 12px; border: 1px dashed rgba(228,87,46,.5); border-radius: 12px; background: rgba(228,87,46,.12); color: #f3c7ac; font-size: 13px; }
  ul { list-style: none; padding: 0; margin: 18px 0 0; }
  li { padding: 10px 12px; margin: 0 0 8px; border-radius: 12px; background: rgba(255,255,255,.04); }
  li.line { cursor: pointer; }
  li.line.active { background: rgba(228,87,46,.16); outline: 1px solid rgba(228,87,46,.55); }
  li.line.active .en { color: #fff; }
  li .idx { color: #e4572e; font-size: 12px; font-weight: 700; }
  li .zh { color: #b7a390; font-size: 13px; }
</style>
</head>
<body>
<h1>{{TITLE}}</h1>
<p class="en">{{TITLE_EN}}</p>
<p class="show">{{SHOW}}</p>
<audio controls preload="metadata" src="{{AUDIO_URL}}"></audio>
<p class="note">手机与电脑连同一个 Wi-Fi 才能打开本页并播放音频。播放时会自动高亮当前句，点句子可跳转。</p>
<ul>{{SENTENCES}}</ul>
<script>
(function () {
  var audio = document.querySelector('audio');
  var nodes = document.querySelectorAll('li[data-start]');
  if (!audio || !nodes.length) return;
  var rows = [];
  for (var i = 0; i < nodes.length; i++) {
    var s = parseFloat(nodes[i].getAttribute('data-start'));
    if (!isNaN(s)) rows.push({ el: nodes[i], start: s });
  }
  var last = null;
  function update() {
    var t = audio.currentTime || 0;
    var active = null;
    for (var i = 0; i < rows.length; i++) {
      if (t >= rows[i].start - 0.15) active = rows[i];
      else break;
    }
    if (active && active !== last) {
      if (last) last.el.classList.remove('active');
      active.el.classList.add('active');
      last = active;
      try { active.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch (e) { try { active.el.scrollIntoView(); } catch (e2) { /* ignore */ } }
    }
  }
  audio.addEventListener('timeupdate', update);
  audio.addEventListener('seeked', update);
  audio.addEventListener('loadedmetadata', update);
  function bind(row) {
    row.el.addEventListener('click', function () {
      try { audio.currentTime = row.start; audio.play(); } catch (e) { /* ignore */ }
    });
  }
  for (var j = 0; j < rows.length; j++) bind(rows[j]);
  update();
})();
</script>
</body>
</html>`;

// Module state. The plugin mounts once per Host; `apply` refreshes the paths.
const state = {
  dataRoot: DEFAULT_DATA_ROOT,
  lanPort: DEFAULT_LAN_PORT,
  disposed: false,
  catalogCache: { mtimeMs: -1, size: -1, raw: null },
  jsonCache: new Map(),
  listenTemplate: null,
  jobs: new Map(),
  episodeJobs: new Map(),
  lanServer: null,
  lanStarting: null,
  // Optional Host speechToText service; bound lazily in its own inject scope and
  // only ever read through route handlers (never via ctx.speechToText).
  stt: null,
};

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(Math.max(0, Number(value) || 0)).padStart(2, '0');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fail(status, message) {
  const error = new Error(String(message == null ? '请求失败' : message));
  error.status = Number.isInteger(status) ? status : 500;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isFile(absolutePath) {
  if (typeof absolutePath !== 'string' || !absolutePath.trim()) return false;
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function pathsEqual(left, right) {
  let a = path.resolve(String(left == null ? '' : left));
  let b = path.resolve(String(right == null ? '' : right));
  if (CASE_INSENSITIVE_FS) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b;
}

function isInside(root, target) {
  let relativePath;
  try {
    relativePath = path.relative(path.resolve(root), path.resolve(target));
  } catch {
    return false;
  }
  if (!relativePath) return false;
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appendTail(current, chunk, limit) {
  const next = String(current || '') + String(chunk || '');
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function safeDecode(value) {
  const text = String(value == null ? '' : value);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function lastMeaningfulLine(text) {
  const lines = String(text || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  return lines[lines.length - 1].slice(0, 600);
}

function normalizeEpisodeId(value) {
  const match = EPISODE_ID_RE.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  return `s${pad2(match[1])}e${pad2(match[2])}`;
}

function episodeKeyFromFilename(filename) {
  const match = EPISODE_TOKEN_RE.exec(String(filename == null ? '' : filename));
  if (!match) return null;
  return `s${pad2(match[1])}e${pad2(match[2])}`;
}

function episodeSeason(episode) {
  const direct = toFiniteNumber(episode && episode.season);
  if (direct !== null) return direct;
  const id = normalizeEpisodeId(episode && episode.episodeId);
  return id ? Number(id.slice(1, 3)) : 0;
}

function episodeNumber(episode) {
  const direct = toFiniteNumber(episode && episode.number);
  if (direct !== null) return direct;
  const id = normalizeEpisodeId(episode && episode.episodeId);
  return id ? Number(id.slice(4)) : 0;
}

function nodeExecutable() {
  try {
    const argv0 = process.argv0;
    if (argv0 && path.isAbsolute(argv0) && fs.existsSync(argv0)) return argv0;
  } catch {
    /* fall through to execPath */
  }
  return process.execPath || 'node';
}

function newJobId() {
  return `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function catalogPath() {
  return path.join(state.dataRoot, 'catalog.json');
}

function episodeDir(episodeId) {
  return path.join(state.dataRoot, 'episodes', episodeId);
}

// ---------------------------------------------------------------------------
// JSON caches (mtime + size guarded; never throw on missing / corrupt files)
// ---------------------------------------------------------------------------

function pruneJsonCache() {
  while (state.jsonCache.size > JSON_CACHE_LIMIT) {
    const oldest = state.jsonCache.keys().next();
    if (oldest.done) return;
    state.jsonCache.delete(oldest.value);
  }
}

function readJsonCached(absoluteFile) {
  let stat;
  try {
    stat = fs.statSync(absoluteFile);
  } catch {
    state.jsonCache.delete(absoluteFile);
    return null;
  }
  if (!stat.isFile()) return null;
  const hit = state.jsonCache.get(absoluteFile);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  let value = null;
  try {
    value = JSON.parse(fs.readFileSync(absoluteFile, 'utf8'));
  } catch {
    value = null;
  }
  state.jsonCache.set(absoluteFile, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  pruneJsonCache();
  return value;
}

function readCatalogRaw() {
  const file = catalogPath();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    state.catalogCache = { mtimeMs: -1, size: -1, raw: null };
    return null;
  }
  if (state.catalogCache.mtimeMs === stat.mtimeMs && state.catalogCache.size === stat.size) {
    return state.catalogCache.raw;
  }
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  if (!isPlainObject(raw)) raw = null;
  state.catalogCache = { mtimeMs: stat.mtimeMs, size: stat.size, raw };
  return raw;
}

function invalidateCatalogCache() {
  state.catalogCache = { mtimeMs: -1, size: -1, raw: null };
}

function persistCatalog(catalog) {
  fs.mkdirSync(state.dataRoot, { recursive: true });
  const file = catalogPath();
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let saved = false;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    saved = true;
  } catch {
    saved = false;
  }
  if (!saved) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* no temp file to remove */
    }
    fs.writeFileSync(file, text, 'utf8');
  }
  invalidateCatalogCache();
}

// ---------------------------------------------------------------------------
// catalog / library views
// ---------------------------------------------------------------------------

function emptyCatalog() {
  return {
    showId: '',
    title: '',
    titleEn: '',
    year: null,
    mediaDir: '',
    subtitleDir: '',
    poster: null,
    episodes: [],
  };
}

function normalizeEpisode(raw) {
  if (!isPlainObject(raw)) return null;
  const episodeId = normalizeEpisodeId(raw.episodeId);
  if (!episodeId) return null;
  return {
    episodeId,
    season: episodeSeason(raw),
    number: episodeNumber(raw),
    titleEn: typeof raw.titleEn === 'string' ? raw.titleEn : '',
    titleZh: typeof raw.titleZh === 'string' ? raw.titleZh : '',
    summaryZh: typeof raw.summaryZh === 'string' ? raw.summaryZh : '',
    summaryEn: typeof raw.summaryEn === 'string' ? raw.summaryEn : '',
    runtimeSec: toFiniteNumber(raw.runtimeSec),
    video: typeof raw.video === 'string' && raw.video ? raw.video : null,
    subtitle: typeof raw.subtitle === 'string' && raw.subtitle ? raw.subtitle : null,
    poster: typeof raw.poster === 'string' && raw.poster ? raw.poster : null,
  };
}

function normalizeCatalog(raw) {
  const catalog = emptyCatalog();
  if (!isPlainObject(raw)) return catalog;
  if (typeof raw.showId === 'string') catalog.showId = raw.showId;
  if (typeof raw.title === 'string') catalog.title = raw.title;
  if (typeof raw.titleEn === 'string') catalog.titleEn = raw.titleEn;
  catalog.year = toFiniteNumber(raw.year);
  if (typeof raw.mediaDir === 'string') catalog.mediaDir = raw.mediaDir;
  if (typeof raw.subtitleDir === 'string') catalog.subtitleDir = raw.subtitleDir;
  if (typeof raw.poster === 'string') catalog.poster = raw.poster;
  if (Array.isArray(raw.episodes)) {
    catalog.episodes = raw.episodes.map(normalizeEpisode).filter(Boolean);
  }
  return catalog;
}

function posterForEpisode(episodeId) {
  const relativePath = `posters/${episodeId}.jpg`;
  try {
    if (fs.statSync(path.join(state.dataRoot, relativePath)).isFile()) return relativePath;
  } catch {
    /* no poster yet */
  }
  return null;
}

function compareEpisodes(left, right) {
  const seasonDiff = episodeSeason(left) - episodeSeason(right);
  if (seasonDiff) return seasonDiff;
  const numberDiff = episodeNumber(left) - episodeNumber(right);
  if (numberDiff) return numberDiff;
  return String((left && left.episodeId) || '').localeCompare(String((right && right.episodeId) || ''));
}

function materialSummary(episodeId) {
  const dir = episodeDir(episodeId);
  const material = readJsonCached(path.join(dir, 'material.json'));
  const quiz = readJsonCached(path.join(dir, 'quiz.json'));
  const hasMaterial = isPlainObject(material);
  let segmentCount = 0;
  if (hasMaterial) {
    const fromStats = toFiniteNumber(material.stats && material.stats.segmentCount);
    segmentCount = fromStats !== null ? fromStats : Array.isArray(material.segments) ? material.segments.length : 0;
  }
  const questions = isPlainObject(quiz) && Array.isArray(quiz.questions) ? quiz.questions : [];
  const audioDuration = hasMaterial
    ? toFiniteNumber(material.audio && material.audio.duration) ??
      toFiniteNumber(material.stats && material.stats.durationSec) ??
      toFiniteNumber(material.source && material.source.duration)
    : null;
  return {
    quiz,
    summary: {
      segmentCount,
      quizCount: questions.length,
      generatedAt: hasMaterial && typeof material.generatedAt === 'string' ? material.generatedAt : null,
      audioDuration,
    },
    available: {
      material: hasMaterial,
      quiz: isPlainObject(quiz),
    },
  };
}

function episodeView(episode) {
  const readiness = materialSummary(episode.episodeId);
  const available = {
    video: isFile(episode.video),
    subtitle: isFile(episode.subtitle),
    material: readiness.available.material,
    quiz: readiness.available.quiz,
  };
  return {
    episodeId: episode.episodeId,
    season: episode.season,
    number: episode.number,
    titleEn: episode.titleEn,
    titleZh: episode.titleZh,
    summaryZh: episode.summaryZh,
    summaryEn: episode.summaryEn,
    runtimeSec: episode.runtimeSec,
    poster: episode.poster || posterForEpisode(episode.episodeId),
    available,
    material: readiness.summary,
    ready: available.video && available.subtitle && available.material,
  };
}

function libraryView() {
  const catalog = normalizeCatalog(readCatalogRaw());
  const episodes = catalog.episodes
    .map(episodeView)
    .sort((left, right) => episodeSeason(left) - episodeSeason(right) || episodeNumber(left) - episodeNumber(right));
  return {
    show: {
      showId: catalog.showId,
      title: catalog.title,
      titleEn: catalog.titleEn,
      year: catalog.year,
      poster: catalog.poster,
    },
    settings: {
      mediaDir: catalog.mediaDir,
      subtitleDir: catalog.subtitleDir,
    },
    episodes,
  };
}

// ---------------------------------------------------------------------------
// directory scan (pair videos with subtitles by SxxEyy)
// ---------------------------------------------------------------------------

function walkFiles(root) {
  const files = [];
  const visit = (dir, depth) => {
    if (files.length >= SCAN_FILE_LIMIT) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= SCAN_FILE_LIMIT) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < SCAN_MAX_DEPTH) visit(full, depth + 1);
        continue;
      }
      if (entry.isFile()) {
        files.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(full).isFile()) files.push(full);
        } catch {
          /* broken symlink */
        }
      }
    }
  };
  visit(root, 0);
  return files;
}

function collectEpisodeFiles(files, target, extensions) {
  for (const full of files) {
    const filename = path.basename(full);
    const extension = path.extname(filename).toLowerCase();
    if (!extensions.has(extension)) continue;
    const key = episodeKeyFromFilename(filename);
    if (!key) continue;
    const list = target.get(key) || [];
    if (!list.some((item) => item.full === full)) {
      list.push({ full, name: filename, dir: path.dirname(full), ext: extension });
      target.set(key, list);
    }
  }
}

function chooseVideo(list, mediaDir) {
  const rank = (item) =>
    (pathsEqual(item.dir, mediaDir) ? 0 : 10) +
    (VIDEO_EXT_RANK[item.ext] ?? 9) +
    (/sample|trailer|preview/i.test(item.name) ? 40 : 0);
  return [...list].sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))[0];
}

function chooseSubtitle(list, video, subtitleDir) {
  const rank = (item) => {
    let dirRank = 2;
    if (pathsEqual(item.dir, video.dir)) dirRank = 0;
    else if (pathsEqual(item.dir, subtitleDir)) dirRank = 1;
    return dirRank * 10 + (SUBTITLE_EXT_RANK[item.ext] ?? 9);
  };
  return [...list].sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))[0];
}

function scanDirectories(mediaDir, subtitleDir) {
  const filesByDir = new Map();
  const filesOf = (dir) => {
    if (!filesByDir.has(dir)) filesByDir.set(dir, walkFiles(dir));
    return filesByDir.get(dir);
  };
  const videos = new Map();
  const subtitles = new Map();
  collectEpisodeFiles(filesOf(mediaDir), videos, VIDEO_EXTS);
  collectEpisodeFiles(filesOf(mediaDir), subtitles, SUBTITLE_EXTS);
  if (!pathsEqual(mediaDir, subtitleDir)) {
    collectEpisodeFiles(filesOf(subtitleDir), subtitles, SUBTITLE_EXTS);
  }
  const found = [];
  for (const [key, list] of videos) {
    const video = chooseVideo(list, mediaDir);
    const subtitleList = subtitles.get(key) || [];
    const subtitle = subtitleList.length ? chooseSubtitle(subtitleList, video, subtitleDir) : null;
    const match = EPISODE_ID_RE.exec(key);
    found.push({
      key,
      season: Number(match[1]),
      number: Number(match[2]),
      video,
      subtitle,
    });
  }
  found.sort((left, right) => left.season - right.season || left.number - right.number);
  return found;
}

function applyScanToCatalog(rawCatalog, found, mediaDir, subtitleDir) {
  const catalog = isPlainObject(rawCatalog) ? deepClone(rawCatalog) : {};
  if (!Array.isArray(catalog.episodes)) catalog.episodes = [];
  catalog.mediaDir = mediaDir;
  catalog.subtitleDir = subtitleDir;

  const byId = new Map();
  for (const entry of catalog.episodes) {
    if (!isPlainObject(entry)) continue;
    const episodeId = normalizeEpisodeId(entry.episodeId);
    if (episodeId) byId.set(episodeId, entry);
  }

  for (const item of found) {
    const existing = byId.get(item.key);
    if (isPlainObject(existing)) {
      existing.episodeId = item.key;
      if (item.video) existing.video = item.video.full;
      if (item.subtitle) existing.subtitle = item.subtitle.full;
      if (!Number.isFinite(toFiniteNumber(existing.season))) existing.season = item.season;
      if (!Number.isFinite(toFiniteNumber(existing.number))) existing.number = item.number;
      if (typeof existing.poster !== 'string' || !existing.poster) existing.poster = posterForEpisode(item.key);
      if (!byId.has(item.key)) byId.set(item.key, existing);
      continue;
    }
    const created = {
      episodeId: item.key,
      season: item.season,
      number: item.number,
      titleEn: '',
      titleZh: '',
      summaryZh: '',
      summaryEn: '',
      runtimeSec: null,
      video: item.video ? item.video.full : null,
      subtitle: item.subtitle ? item.subtitle.full : null,
      poster: posterForEpisode(item.key),
    };
    catalog.episodes.push(created);
    byId.set(item.key, created);
  }

  catalog.episodes = catalog.episodes.filter(isPlainObject).sort(compareEpisodes);
  return catalog;
}

function resolveExistingDir(input, label) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) fail(400, `请填写${label}`);
  const resolved = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(400, `${label}不存在：${resolved}`);
  }
  if (!stat.isDirectory()) fail(400, `${label}不是文件夹：${resolved}`);
  return resolved;
}

function handleScan(body) {
  const mediaDir = resolveExistingDir(body.mediaDir, '视频目录');
  const subtitleDirRaw = typeof body.subtitleDir === 'string' ? body.subtitleDir.trim() : '';
  const subtitleDir = subtitleDirRaw ? resolveExistingDir(subtitleDirRaw, '字幕目录') : mediaDir;
  const found = scanDirectories(mediaDir, subtitleDir);
  const catalog = applyScanToCatalog(readCatalogRaw(), found, mediaDir, subtitleDir);
  persistCatalog(catalog);
  return {
    library: libraryView(),
    scanned: {
      mediaDir,
      subtitleDir,
      episodes: found.length,
      videos: found.filter((item) => !!item.video).length,
      subtitles: found.filter((item) => !!item.subtitle).length,
    },
  };
}

// ---------------------------------------------------------------------------
// generate jobs
// ---------------------------------------------------------------------------

function jobSnapshot(job) {
  const snapshot = {
    id: job.id,
    kind: job.kind,
    episodeId: job.episodeId,
    status: job.status,
    progress: job.progress || null,
    result: job.result || null,
    error: job.error || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
  if (job.status === 'error' && job.errorTail) snapshot.errorTail = job.errorTail.slice(-2000);
  return snapshot;
}

function pruneJobs() {
  const finished = [...state.jobs.values()].filter((job) => job.status !== 'running');
  finished.sort((left, right) => (left.finishedAt || 0) - (right.finishedAt || 0));
  while (finished.length > JOB_LIMIT) {
    const job = finished.shift();
    state.jobs.delete(job.id);
    if (job.episodeId && state.episodeJobs.get(job.episodeId) === job.id) state.episodeJobs.delete(job.episodeId);
  }
}

function finishJob(job, status, error) {
  if (!job || job.status !== 'running') return;
  job.status = status;
  job.error = error ? String(error).slice(0, 2000) : null;
  job.finishedAt = Date.now();
  const previous = job.progress;
  if (status === 'done') {
    job.progress = {
      stage: 'done',
      pct: 100,
      message:
        previous && previous.stage === 'done' && previous.message ? previous.message : '物料生成完成',
    };
  } else {
    job.progress = {
      stage: previous && previous.stage && previous.stage !== 'done' ? previous.stage : 'error',
      pct: previous && Number.isFinite(previous.pct) ? previous.pct : 0,
      message: job.error || (previous && previous.message) || '生成失败',
    };
  }
  if (job.child) {
    try {
      job.child.kill();
    } catch {
      /* already gone */
    }
    job.child = null;
  }
  if (job.episodeId && state.episodeJobs.get(job.episodeId) === job.id) state.episodeJobs.delete(job.episodeId);
  invalidateCatalogCache();
  pruneJobs();
}

function handleProgressLine(job, line) {
  const text = String(line == null ? '' : line).trim();
  if (!text) return;
  job.logTail = appendTail(job.logTail, `${text}\n`, LOG_TAIL_LIMIT);
  if (text.charAt(0) !== '{') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!isPlainObject(message)) return;
  if (isPlainObject(message.result)) job.result = message.result;
  const stage = typeof message.stage === 'string' ? message.stage.trim().slice(0, 64) : '';
  const pctValue = toFiniteNumber(message.pct);
  const pct = pctValue === null ? null : clamp(Math.round(pctValue), 0, 100);
  const textMessage = typeof message.message === 'string' ? message.message.slice(0, 500) : '';
  if (stage === 'error' || typeof message.error === 'string') {
    job.failure =
      typeof message.error === 'string' ? message.error.slice(0, 2000) : textMessage || '生成失败';
  }
  if (stage) {
    job.progress = {
      stage,
      pct: pct === null ? (job.progress && Number.isFinite(job.progress.pct) ? job.progress.pct : 0) : pct,
      message: textMessage,
    };
  } else if (pct !== null && job.progress) {
    job.progress = {
      stage: job.progress.stage,
      pct,
      message: textMessage || job.progress.message,
    };
  }
}

function startGenerate(episode) {
  const runningId = state.episodeJobs.get(episode.episodeId);
  if (runningId) {
    const running = state.jobs.get(runningId);
    if (running && running.status === 'running') return { jobId: running.id, reused: true };
    state.episodeJobs.delete(episode.episodeId);
  }

  if (!episode.subtitle) fail(400, '本集没有字幕文件，暂不能生成物料（请先扫描到与本集视频配对的字幕）');
  if (!isFile(episode.video)) fail(400, `视频文件不存在：${episode.video}`);
  if (!isFile(episode.subtitle)) fail(400, `字幕文件不存在：${episode.subtitle}`);
  if (!isFile(BUILDER_SCRIPT)) fail(500, `物料生成脚本不存在：${BUILDER_SCRIPT}`);

  const job = {
    id: newJobId(),
    kind: 'generate',
    episodeId: episode.episodeId,
    status: 'running',
    progress: { stage: 'init', pct: 0, message: '正在启动物料生成…' },
    result: null,
    error: null,
    errorTail: '',
    logTail: '',
    failure: '',
    startedAt: Date.now(),
    finishedAt: null,
    child: null,
  };
  state.jobs.set(job.id, job);
  state.episodeJobs.set(episode.episodeId, job.id);

  const args = [
    BUILDER_SCRIPT,
    '--episode',
    episode.episodeId,
    '--video',
    episode.video,
    '--subtitle',
    episode.subtitle,
    '--data',
    state.dataRoot,
  ];
  if (episode.titleEn) args.push('--title-en', episode.titleEn);
  if (episode.titleZh) args.push('--title-zh', episode.titleZh);
  if (episode.force === true) args.push('--force');

  let child;
  try {
    child = spawn(nodeExecutable(), args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });
  } catch (error) {
    finishJob(job, 'error', `无法启动生成进程：${String((error && error.message) || error)}`);
    return { jobId: job.id };
  }

  job.child = child;

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) handleProgressLine(job, line);
    });
    child.stdout.on('error', () => {
      /* reading the child's pipe failed; the close event still settles the job */
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      job.errorTail = appendTail(job.errorTail, chunk, LOG_TAIL_LIMIT);
    });
    child.stderr.on('error', () => {
      /* ignore */
    });
  }

  child.on('error', (error) => {
    finishJob(job, 'error', `无法启动生成进程：${String((error && error.message) || error)}`);
  });
  child.on('close', (code, signal) => {
    job.child = null;
    if (job.status !== 'running') return;
    if (code === 0 && !job.failure) {
      finishJob(job, 'done', null);
      return;
    }
    const reason =
      job.failure ||
      lastMeaningfulLine(job.errorTail) ||
      (signal ? `生成进程被信号 ${signal} 终止` : `生成进程退出码 ${code}`);
    finishJob(job, 'error', reason);
  });

  return { jobId: job.id, reused: false };
}

function handleGenerate(body) {
  const episodeId = normalizeEpisodeId(body.episodeId);
  if (!episodeId) fail(400, 'episodeId 无效，应形如 s01e01');
  const catalog = normalizeCatalog(readCatalogRaw());
  const episode = catalog.episodes.find((item) => item.episodeId === episodeId);
  if (!episode) fail(404, `剧集目录里没有 ${episodeId}，请先扫描视频目录`);
  return startGenerate({ ...episode, force: body.force === true });
}

// ---------------------------------------------------------------------------
// media streaming (Range support, path-traversal safe)
// ---------------------------------------------------------------------------

function contentTypeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function parseRangeHeader(header, size) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return { unsatisfiable: true };
  let start;
  let end;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  if (start < 0 || start > end || start >= size) return { unsatisfiable: true };
  if (end > size - 1) end = size - 1;
  return { start, end };
}

function pipeStream(file, options, res) {
  const stream = fs.createReadStream(file, options);
  const destroy = () => {
    try {
      stream.destroy();
    } catch {
      /* already closed */
    }
  };
  stream.on('error', () => {
    try {
      if (!res.headersSent) res.writeHead(404);
    } catch {
      /* headers already flushed */
    }
    try {
      res.destroy();
    } catch {
      /* socket already closed */
    }
  });
  res.on('close', destroy);
  stream.pipe(res);
}

function streamFile(req, res, file, options = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fail(404, '文件不存在');
  }
  if (!stat.isFile()) fail(404, '文件不存在');
  const size = stat.size;
  const headers = {
    'content-type': options.contentType || contentTypeFor(file),
    'accept-ranges': 'bytes',
    'cache-control': options.cacheControl || 'public, max-age=3600',
  };
  const method = String(req.method || 'GET').toUpperCase();
  const range = size > 0 ? parseRangeHeader(req.headers && req.headers.range, size) : null;

  if (range && range.unsatisfiable) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 });
    res.end();
    return;
  }
  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': length,
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    pipeStream(file, { start: range.start, end: range.end }, res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  pipeStream(file, undefined, res);
}

function resolveDataRelative(rawValue) {
  let relative = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!relative) fail(400, '缺少 p 参数（相对于 data 目录的路径）');
  try {
    relative = decodeURIComponent(relative);
  } catch {
    /* keep the raw value; it can only be a malformed escape */
  }
  relative = relative.replace(/\\/g, '/');
  if (!relative) fail(400, '路径为空');
  if (relative.includes('\0')) fail(400, '非法路径');
  if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) fail(400, '不允许绝对路径');
  if (relative.includes(':')) fail(400, '非法路径');
  const segments = relative.split('/').filter(Boolean);
  if (!segments.length) fail(400, '路径为空');
  if (segments.some((segment) => segment === '..' || segment === '.')) fail(400, '非法路径');
  const resolved = path.resolve(state.dataRoot, ...segments);
  if (!isInside(state.dataRoot, resolved)) fail(400, '不允许访问 data 目录以外的文件');
  if (!isFile(resolved)) fail(404, '文件不存在');
  return resolved;
}

function serveMedia(req, res, url) {
  const file = resolveDataRelative(url.searchParams.get('p'));
  streamFile(req, res, file);
}

// ---------------------------------------------------------------------------
// LAN listening server
// ---------------------------------------------------------------------------

function pickLanIp() {
  let bestIp = '';
  let bestScore = -Infinity;
  let fallbackIp = '';
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    interfaces = {};
  }
  for (const [ifaceName, addresses] of Object.entries(interfaces || {})) {
    for (const address of addresses || []) {
      if (!address || address.family !== 'IPv4' || address.internal) continue;
      const ip = String(address.address || '');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
      if (!fallbackIp && !ip.startsWith('169.254.')) fallbackIp = ip;
      if (ip.startsWith('169.254.')) continue;
      let score = 1;
      if (/^192\.168\./.test(ip)) score = 30;
      else if (/^10\./.test(ip)) score = 20;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 10;
      if (VIRTUAL_IFACE_RE.test(String(ifaceName || ''))) score -= 5;
      if (score > bestScore) {
        bestScore = score;
        bestIp = ip;
      }
    }
  }
  return bestIp || fallbackIp || '127.0.0.1';
}

function stopLanServer() {
  const server = state.lanServer;
  state.lanServer = null;
  state.lanStarting = null;
  if (!server) return;
  try {
    server.close();
  } catch {
    /* already closed */
  }
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch {
    /* nothing to close */
  }
}

function ensureLanServer() {
  if (state.disposed) return Promise.reject(new Error('插件已卸载，无法启动手机服务'));
  if (state.lanServer) return Promise.resolve(state.lanServer);
  if (state.lanStarting) return state.lanStarting;

  const basePort = Number.isInteger(state.lanPort) && state.lanPort > 0 ? state.lanPort : DEFAULT_LAN_PORT;

  const starting = new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = () => {
      if (state.disposed) {
        reject(new Error('插件已卸载，无法启动手机服务'));
        return;
      }
      const port = basePort + attempt;
      const server = http.createServer((req, res) => {
        Promise.resolve(lanRequest(req, res)).catch((error) => {
          console.error('[meiju-english] LAN handler crashed:', String((error && error.message) || error));
          try {
            res.destroy();
          } catch {
            /* socket already gone */
          }
        });
      });

      const onError = (error) => {
        server.removeListener('listening', onListening);
        try {
          server.close();
        } catch {
          /* never listened */
        }
        const code = error && error.code;
        if (code === 'EADDRINUSE' && attempt < LAN_PORT_TRIES - 1) {
          attempt += 1;
          tryListen();
          return;
        }
        state.lanStarting = null;
        const reason = String((error && error.message) || error);
        reject(new Error(`手机服务启动失败（端口 ${port}）：${reason}`));
      };

      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', (error) => {
          console.error('[meiju-english] LAN server error:', String((error && error.message) || error));
        });
        if (state.disposed) {
          try {
            server.close();
          } catch {
            /* ignore */
          }
          state.lanStarting = null;
          reject(new Error('插件已卸载，无法启动手机服务'));
          return;
        }
        state.lanServer = server;
        state.lanStarting = null;
        resolve(server);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(port, '0.0.0.0');
      } catch (error) {
        onError(error);
      }
    };

    tryListen();
  });

  state.lanStarting = starting;
  return starting;
}

function writeLanText(res, status, text) {
  const body = Buffer.from(String(text == null ? '' : text), 'utf8');
  try {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    try {
      res.end();
    } catch {
      /* socket already gone */
    }
  }
}

function readListenTemplate() {
  try {
    const stat = fs.statSync(LISTEN_TEMPLATE_FILE);
    if (
      state.listenTemplate &&
      state.listenTemplate.mtimeMs === stat.mtimeMs &&
      state.listenTemplate.size === stat.size
    ) {
      return state.listenTemplate.value;
    }
    const value = fs.readFileSync(LISTEN_TEMPLATE_FILE, 'utf8');
    state.listenTemplate = { mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  } catch {
    return FALLBACK_LISTEN_TEMPLATE;
  }
}

function renderSentenceList(material) {
  const segments = isPlainObject(material) && Array.isArray(material.segments) ? material.segments : [];
  const audioInfo = isPlainObject(material) && isPlainObject(material.audio) ? material.audio : {};
  const offset = toFiniteNumber(audioInfo.timelineOffset);
  const items = [];
  for (const segment of segments) {
    if (items.length >= LISTEN_SEGMENT_LIMIT) break;
    if (!isPlainObject(segment)) continue;
    const en = typeof segment.en === 'string' ? segment.en.trim() : '';
    const zh = typeof segment.zh === 'string' ? segment.zh.trim() : '';
    if (!en && !zh) continue;
    const index = segment.index != null ? segment.index : items.length + 1;
    // The phone plays the trimmed full.mp3, so the sync marker must use the
    // trimmed-audio timeline (audioStart), never the original video time.
    let audioStart = toFiniteNumber(segment.audioStart);
    if (audioStart === null) {
      const start = toFiniteNumber(segment.start);
      audioStart = start === null ? null : Math.max(0, start - (offset === null ? 0 : offset));
    }
    const startAttr = audioStart === null ? '' : ` data-start="${audioStart.toFixed(2)}"`;
    items.push(
      `<li class="line"${startAttr}><span class="idx">${escapeHtml(index)}</span><div class="lines">` +
        `<p class="en">${escapeHtml(en)}</p><p class="zh">${escapeHtml(zh)}</p></div></li>`,
    );
  }
  if (!items.length) {
    return '<li class="empty">本集还没有逐句字幕，物料生成后刷新本页即可看到。</li>';
  }
  return items.join('');
}

function renderListenPage(episode, catalog, material) {
  const template = readListenTemplate();
  const values = {
    SHOW: catalog.title || catalog.titleEn || '美剧英语学习',
    TITLE: episode.titleZh || episode.titleEn || episode.episodeId.toUpperCase(),
    TITLE_EN: episode.titleEn || '',
    AUDIO_URL: `/audio/${episode.episodeId}/full.mp3`,
    SENTENCES: renderSentenceList(material),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

function episodeFromMaterial(episodeId, material) {
  if (!isPlainObject(material)) return null;
  const season = toFiniteNumber(material.season);
  const number = toFiniteNumber(material.number);
  return {
    episodeId,
    season: season !== null ? season : Number(episodeId.slice(1, 3)),
    number: number !== null ? number : Number(episodeId.slice(4)),
    titleEn: typeof material.titleEn === 'string' ? material.titleEn : '',
    titleZh: typeof material.titleZh === 'string' ? material.titleZh : '',
    summaryZh: '',
    summaryEn: '',
    runtimeSec: null,
    video: null,
    subtitle: null,
    poster: null,
  };
}

/**
 * Resolve an episode for the phone listen page: prefer the catalog entry, but
 * fall back to a material.json derived record so a stale/missing catalog never
 * hides generated audio from the phone.
 */
function findListenEpisode(catalog, episodeId) {
  const inCatalog = catalog.episodes.find((item) => item.episodeId === episodeId);
  if (inCatalog) return inCatalog;
  const material = readJsonCached(path.join(episodeDir(episodeId), 'material.json'));
  return episodeFromMaterial(episodeId, material);
}

function serveLanListen(req, res, rawEpisodeId) {
  const episodeId = normalizeEpisodeId(rawEpisodeId);
  if (!episodeId) {
    writeLanText(res, 404, '未知剧集');
    return;
  }
  const catalog = normalizeCatalog(readCatalogRaw());
  const episode = findListenEpisode(catalog, episodeId);
  if (!episode) {
    writeLanText(res, 404, '未知剧集');
    return;
  }
  const material = readJsonCached(path.join(episodeDir(episodeId), 'material.json'));
  const html = renderListenPage(episode, catalog, material);
  const body = Buffer.from(html, 'utf8');
  const method = String(req.method || 'GET').toUpperCase();
  try {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    if (method === 'HEAD') res.end();
    else res.end(body);
  } catch {
    try {
      res.end();
    } catch {
      /* socket already gone */
    }
  }
}

function serveLanAudio(req, res, rawEpisodeId, filePart, kind) {
  const episodeId = normalizeEpisodeId(rawEpisodeId);
  if (!episodeId) {
    writeLanText(res, 404, '未知剧集');
    return;
  }
  const assetsDir = path.join(episodeDir(episodeId), 'assets');
  let file;
  if (kind === 'clips') {
    const name = String(filePart == null ? '' : filePart);
    if (!/^[A-Za-z0-9._-]+\.mp3$/i.test(name) || name.includes('..')) {
      writeLanText(res, 404, '音频不存在');
      return;
    }
    file = path.join(assetsDir, 'clips', name);
  } else {
    file = path.join(assetsDir, 'full.mp3');
  }
  if (!isInside(state.dataRoot, file) || !isFile(file)) {
    writeLanText(res, 404, '音频不存在');
    return;
  }
  try {
    streamFile(req, res, file, { contentType: 'audio/mpeg', cacheControl: 'public, max-age=3600' });
  } catch (error) {
    if (!res.headersSent) writeLanText(res, 404, '音频不存在');
    else {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

async function lanRequest(req, res) {
  try {
    let pathname = '/';
    try {
      pathname = new URL(String(req.url || '/'), 'http://127.0.0.1').pathname;
    } catch {
      writeLanText(res, 400, 'Bad Request');
      return;
    }

    // Local-only speech engine routes (also used by a shell on this machine to
    // verify the model download and transcription end-to-end). They accept POST,
    // so they are dispatched before the read-only method gate below.
    if (pathname === '/stt-status' || pathname === '/stt-prepare' || pathname === '/stt') {
      await lanSttRequest(req, res, pathname);
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      writeLanText(res, 405, 'Method Not Allowed');
      return;
    }

    const listenMatch = /^\/listen\/([^/]+)\/?$/i.exec(pathname);
    if (listenMatch) {
      serveLanListen(req, res, safeDecode(listenMatch[1]));
      return;
    }
    const fullAudioMatch = /^\/audio\/([^/]+)\/full\.mp3$/i.exec(pathname);
    if (fullAudioMatch) {
      serveLanAudio(req, res, safeDecode(fullAudioMatch[1]), null, 'full');
      return;
    }
    const clipMatch = /^\/audio\/([^/]+)\/clips\/([^/]+)$/i.exec(pathname);
    if (clipMatch) {
      serveLanAudio(req, res, safeDecode(clipMatch[1]), safeDecode(clipMatch[2]), 'clips');
      return;
    }
    writeLanText(res, 404, '页面不存在');
  } catch (error) {
    console.error('[meiju-english] LAN request failed:', String((error && error.message) || error));
    try {
      if (!res.headersSent) writeLanText(res, 500, '服务器错误');
      else res.destroy();
    } catch {
      /* ignore */
    }
  }
}

function handleLan() {
  return ensureLanServer().then((server) => {
    const address = server.address();
    const port = address && typeof address === 'object' && Number.isInteger(address.port) ? address.port : state.lanPort;
    const ip = pickLanIp();
    return {
      ip,
      port,
      url: `http://${ip}:${port}`,
      listening: server.listening === true,
    };
  });
}

function handleListenInfo(url) {
  const episodeId = normalizeEpisodeId(url.searchParams.get('episodeId'));
  if (!episodeId) fail(400, 'episodeId 无效，应形如 s01e01');
  const catalog = normalizeCatalog(readCatalogRaw());
  const episode = findListenEpisode(catalog, episodeId);
  if (!episode) fail(404, `剧集目录里没有 ${episodeId}`);
  return ensureLanServer().then((server) => {
    const address = server.address();
    const port = address && typeof address === 'object' && Number.isInteger(address.port) ? address.port : state.lanPort;
    const ip = pickLanIp();
    return {
      url: `http://${ip}:${port}/listen/${episodeId}`,
      path: `/listen/${episodeId}`,
      ip,
      port,
      episodeId,
      hasAudio: isFile(path.join(episodeDir(episodeId), 'assets', 'full.mp3')),
    };
  });
}

// ---------------------------------------------------------------------------
// local speech-to-text (SenseVoice behind the optional Host speechToText service)
// ---------------------------------------------------------------------------

function sttError(status, code, message, extra) {
  const error = new Error(String(message == null ? '语音识别失败' : message));
  error.status = Number.isInteger(status) ? status : 500;
  error.code = String(code || 'stt-error');
  if (isPlainObject(extra)) Object.assign(error, extra);
  return error;
}

function sttUnavailableError(message) {
  return sttError(
    503,
    'stt-unavailable',
    message || '本机未启用离线语音识别服务（speechToText），无法自动评分',
  );
}

function getSttService() {
  const service = state.stt;
  if (!service || typeof service !== 'object') return null;
  if (typeof service.snapshot !== 'function' || typeof service.transcribe !== 'function') return null;
  return service;
}

function sttSnapshot() {
  const service = getSttService();
  if (!service) return null;
  try {
    const snapshot = service.snapshot();
    return isPlainObject(snapshot) ? snapshot : null;
  } catch (error) {
    diag(`stt: snapshot failed ${String((error && error.message) || error)}`);
    return null;
  }
}

function sttProviderView(provider) {
  const preparation = isPlainObject(provider && provider.preparation) ? provider.preparation : { phase: 'ready' };
  return {
    id: typeof provider.id === 'string' ? provider.id : '',
    name: typeof provider.name === 'string' ? provider.name : '',
    location: typeof provider.location === 'string' ? provider.location : 'host-local',
    languages: Array.isArray(provider.languages)
      ? provider.languages.filter((language) => typeof language === 'string')
      : [],
    phase: typeof preparation.phase === 'string' ? preparation.phase : 'unknown',
    step: typeof preparation.step === 'string' ? preparation.step : null,
    completedBytes: toFiniteNumber(preparation.completedBytes),
    totalBytes: toFiniteNumber(preparation.totalBytes),
    resource: typeof preparation.resource === 'string' ? preparation.resource : null,
    message: typeof preparation.message === 'string' ? preparation.message : null,
  };
}

function sttStatusView() {
  const snapshot = sttSnapshot();
  const providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers.map(sttProviderView) : [];
  const selection = snapshot && isPlainObject(snapshot.selection)
    ? {
        providerId: typeof snapshot.selection.providerId === 'string' ? snapshot.selection.providerId : '',
        language: typeof snapshot.selection.language === 'string' ? snapshot.selection.language : '',
      }
    : { providerId: '', language: '' };
  if (!providers.length) {
    return {
      available: false,
      reason: '本机没有可用的离线语音识别引擎（speechToText），跟读评分将回退到自评',
      selection,
      providers: [],
    };
  }
  return { available: true, reason: null, selection, providers };
}

function pickSttProviderId(body, snapshot) {
  if (isPlainObject(body) && typeof body.providerId === 'string' && body.providerId.trim()) {
    return body.providerId.trim();
  }
  const selection = snapshot && isPlainObject(snapshot.selection) ? snapshot.selection : null;
  if (selection && typeof selection.providerId === 'string' && selection.providerId.trim()) {
    return selection.providerId.trim();
  }
  const providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [];
  const first = providers.find(
    (provider) => isPlainObject(provider) && typeof provider.id === 'string' && provider.id.length > 0,
  );
  return first ? first.id : '';
}

function findSttProviderView(providers, providerId) {
  return providers.map(sttProviderView).find((provider) => provider.id === providerId) || null;
}

function handleSttStatus() {
  return sttStatusView();
}

function handleSttPrepare(body) {
  const service = getSttService();
  if (!service || typeof service.prepare !== 'function') {
    diag('stt-prepare: speechToText service unavailable');
    throw sttUnavailableError();
  }
  const snapshot = sttSnapshot();
  const providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [];
  if (!providers.length) {
    diag('stt-prepare: no providers');
    throw sttUnavailableError('本机语音识别服务没有可用的识别引擎');
  }
  const providerId = pickSttProviderId(body, snapshot);
  if (!providerId) throw sttError(400, 'stt-invalid', '缺少 providerId，且语音服务没有默认识别引擎');
  const current = findSttProviderView(providers, providerId);
  if (!current) throw sttError(400, 'stt-invalid', `未知的识别引擎：${providerId}`);
  const activePhases = ['downloading', 'checking', 'loading', 'waking', 'cancelling'];
  try {
    // prepare() is idempotent: joining an active preparation or an already
    // loaded worker is fine, and the client only needs the current status back.
    service.prepare(providerId);
  } catch (error) {
    const message = String((error && error.message) || error);
    const busy = activePhases.includes(current.phase) || current.phase === 'ready' || current.phase === 'standby';
    if (!busy) {
      diag(`stt-prepare: provider=${providerId} phase=${current.phase} failed ${message}`);
      throw sttError(503, 'stt-failed', `准备语音模型失败：${message}`, { phase: 'failed' });
    }
    diag(`stt-prepare: provider=${providerId} phase=${current.phase} kept busy (${message})`);
  }
  diag(`stt-prepare: provider=${providerId} phase-before=${current.phase} started`);
  return {
    started: true,
    providerId,
    alreadyReady: current.phase === 'ready' || current.phase === 'standby',
    ...sttStatusView(),
  };
}

function decodeSttAudio(body) {
  const raw = isPlainObject(body) && typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : '';
  if (!raw) throw sttError(400, 'stt-invalid', '缺少音频数据 audioBase64');
  // Strict canonical base64: no whitespace, no lenient characters, full quads.
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw sttError(400, 'stt-invalid', '音频数据不是合法的 base64');
  }
  const audio = Buffer.from(raw, 'base64');
  if (audio.length < 46) throw sttError(400, 'stt-invalid', '音频数据太短，不是有效的 WAV 录音');
  return audio;
}

/**
 * Validate a canonical 16 kHz mono PCM16 WAV recording. The checks mirror
 * `@deepseek-ai/dsh-experimental-speech-to-text/wave` exactly so the local
 * SenseVoice worker never receives bytes it would reject.
 * @returns recording duration in seconds.
 */
function validateSttWav(audio) {
  const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  const invalid = () =>
    sttError(400, 'stt-invalid', '录音必须是 16 kHz 单声道 PCM16 WAV（浏览器录音需先转换成该格式）');
  if (
    bytes.length < 46 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.toString('ascii', 12, 16) !== 'fmt ' ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 16000 ||
    bytes.readUInt32LE(28) !== 32000 ||
    bytes.readUInt16LE(32) !== 2 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString('ascii', 36, 40) !== 'data' ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.readUInt32LE(40) !== bytes.length - 44 ||
    (bytes.length - 44) % 2 !== 0
  ) {
    throw invalid();
  }
  const seconds = (bytes.length - 44) / 32000;
  if (seconds > STT_MAX_AUDIO_SECONDS) {
    throw sttError(400, 'stt-invalid', `录音超过 ${STT_MAX_AUDIO_SECONDS} 秒，请只读这一句`);
  }
  return seconds;
}

async function handleStt(body) {
  const service = getSttService();
  if (!service || typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') {
    diag('stt: speechToText service unavailable');
    throw sttUnavailableError();
  }
  const snapshot = sttSnapshot();
  const providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [];
  if (!providers.length) {
    diag('stt: no providers');
    throw sttUnavailableError('本机语音识别服务没有可用的识别引擎');
  }
  const providerId = pickSttProviderId(body, snapshot);
  if (!providerId) throw sttError(400, 'stt-invalid', '缺少 providerId，且语音服务没有默认识别引擎');
  const current = findSttProviderView(providers, providerId);
  if (!current) throw sttError(400, 'stt-invalid', `未知的识别引擎：${providerId}`);

  const audio = decodeSttAudio(body);
  const recordingSeconds = validateSttWav(audio);

  if (current.phase === 'failed') {
    diag(`stt: provider=${providerId} phase=failed message=${current.message || ''}`);
    throw sttError(
      503,
      'stt-failed',
      current.message ? `语音模型准备失败：${current.message}` : '语音模型准备失败，请重新准备模型',
      { phase: current.phase },
    );
  }
  if (current.phase !== 'ready' && current.phase !== 'standby') {
    diag(`stt: provider=${providerId} phase=${current.phase} audioSeconds=${recordingSeconds.toFixed(2)} not-ready`);
    throw sttError(409, 'stt-not-ready', '语音模型尚未就绪，请先准备模型', { phase: current.phase });
  }

  const language =
    isPlainObject(body) && typeof body.language === 'string' && body.language.trim()
      ? body.language.trim()
      : STT_DEFAULT_LANGUAGE;
  let spec;
  try {
    spec = service.resolve({ audio, language, providerId });
  } catch (error) {
    const message = String((error && error.message) || error);
    diag(`stt: resolve failed provider=${providerId} language=${language} ${message}`);
    throw sttError(400, 'stt-invalid', `无法使用该识别引擎：${message}`);
  }

  const startedAt = Date.now();
  let transcript;
  try {
    transcript = await service.transcribe(spec, AbortSignal.timeout(STT_TIMEOUT_MS));
  } catch (error) {
    const message = String((error && error.message) || error);
    diag(`stt: transcribe failed provider=${providerId} phase=${current.phase} audioSeconds=${recordingSeconds.toFixed(2)} error=${message}`);
    throw sttError(502, 'stt-error', `本地语音识别失败：${message}`);
  }

  const text = transcript && typeof transcript.text === 'string' ? transcript.text : '';
  const reportedAudioSeconds = toFiniteNumber(transcript && transcript.audioSeconds);
  const reportedInferenceSeconds = toFiniteNumber(transcript && transcript.inferenceSeconds);
  const inferenceSeconds =
    reportedInferenceSeconds === null ? clamp((Date.now() - startedAt) / 1000, 0, 3600) : reportedInferenceSeconds;
  diag(`stt: ok provider=${providerId} phase=${current.phase} audioSeconds=${recordingSeconds.toFixed(2)} textLength=${text.length} inferenceSeconds=${inferenceSeconds.toFixed(2)}`);
  return {
    text,
    audioSeconds: reportedAudioSeconds === null ? recordingSeconds : reportedAudioSeconds,
    inferenceSeconds,
    providerId,
  };
}

function isLoopbackAddress(address) {
  const value = String(address == null ? '' : address);
  return value === '::1' || value === '127.0.0.1' || value === '::ffff:127.0.0.1' || /^127\./.test(value);
}

/**
 * Whether an address is one of this machine's own IPv4 interface addresses.
 * A shell that connects to `http://<own-LAN-ip>:8791/...` is routed locally and
 * therefore appears as that interface address instead of 127.0.0.1; a real LAN
 * peer always appears with its own address and is still rejected.
 */
function isOwnInterfaceAddress(address) {
  const value = String(address == null ? '' : address);
  const ipv4 = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipv4)) return false;
  try {
    const interfaces = os.networkInterfaces();
    for (const list of Object.values(interfaces || {})) {
      for (const item of list || []) {
        if (item && item.family === 'IPv4' && String(item.address) === ipv4) return true;
      }
    }
  } catch {
    /* interface enumeration is best effort */
  }
  return false;
}

function lanSttLoopbackOnly(req) {
  const address = String((req.socket && req.socket.remoteAddress) || '');
  return isLoopbackAddress(address) || isOwnInterfaceAddress(address);
}

/**
 * The LAN twin of the three speech routes: same handlers, same JSON envelopes,
 * but reachable only from this machine (the phone page must not use it).
 */
async function lanSttRequest(req, res, pathname) {
  const method = String(req.method || 'GET').toUpperCase();
  if (!lanSttLoopbackOnly(req)) {
    const address = String((req.socket && req.socket.remoteAddress) || '');
    diag(`lan-stt: rejected non-loopback ${address} ${pathname}`);
    writeJson(res, 403, {
      ok: false,
      code: 'stt-forbidden',
      error: '仅允许本机访问语音识别接口',
      message: '仅允许本机访问语音识别接口',
    }, method === 'HEAD');
    return;
  }
  try {
    if (pathname === '/stt-status') {
      if (method !== 'GET' && method !== 'HEAD') {
        writeJson(res, 405, { ok: false, code: 'stt-method', error: '该接口只支持 GET', message: '该接口只支持 GET' }, false);
        return;
      }
      diag('lan-stt: stt-status requested');
      writeJson(res, 200, { ok: true, ...sttStatusView() }, method === 'HEAD');
      return;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'stt-method', error: '该接口只支持 POST', message: '该接口只支持 POST' }, false);
      return;
    }
    const body = await readJsonBody(req, pathname === '/stt' ? STT_BODY_LIMIT : BODY_LIMIT);
    const result = pathname === '/stt-prepare' ? handleSttPrepare(body) : await handleStt(body);
    writeJson(res, 200, { ok: true, ...result }, false);
  } catch (error) {
    const status = Number.isInteger(error && error.status) ? error.status : 500;
    const message = String((error && error.message) || error);
    const payload = { ok: false, error: message, message };
    if (typeof (error && error.code) === 'string') payload.code = error.code;
    if (error && error.phase !== undefined) payload.phase = error.phase;
    diag(`lan-stt: ${pathname} -> ${status} ${String(payload.code || '')} ${message}`);
    writeJson(res, status, payload, false);
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing (API)
// ---------------------------------------------------------------------------

function isLoopback(req) {
  const address = String((req.socket && req.socket.remoteAddress) || '');
  const socketOk =
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    /^127\./.test(address);
  if (!socketOk) return false;
  const host = String((req.headers && req.headers.host) || '');
  if (!host) return true;
  return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?$/i.test(host);
}

function writeJson(res, status, value, head) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    body = JSON.stringify({ ok: false, error: '无法序列化响应' });
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    if (head) res.end();
    else res.end(body);
  } catch {
    try {
      res.end();
    } catch {
      /* socket already gone */
    }
  }
}

async function readJsonBody(req, limit = BODY_LIMIT) {
  const maxBytes = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : BODY_LIMIT;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) fail(413, '请求内容太大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(400, '请求体不是合法 JSON');
  }
  if (!isPlainObject(value)) fail(400, '请求体必须是 JSON 对象');
  return value;
}

function handleMaterial(url) {
  const episodeId = normalizeEpisodeId(url.searchParams.get('episodeId'));
  if (!episodeId) fail(400, 'episodeId 无效，应形如 s01e01');
  const dir = episodeDir(episodeId);
  const material = readJsonCached(path.join(dir, 'material.json'));
  const quiz = readJsonCached(path.join(dir, 'quiz.json'));
  return {
    episodeId,
    material: isPlainObject(material) ? material : null,
    quiz: isPlainObject(quiz) ? quiz : null,
  };
}

function handleJob(url) {
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) fail(400, '缺少 id 参数');
  const job = state.jobs.get(id);
  if (!job) fail(404, `未知的任务 id：${id}`);
  return { job: jobSnapshot(job) };
}

const API_ROUTES = [
  {
    path: '/',
    methods: ['GET', 'HEAD'],
    run: async () => ({
      name,
      api: API,
      routes: [
        'GET /library',
        'GET /material?episodeId=s01e01',
        'POST /scan {mediaDir, subtitleDir}',
        'POST /generate {episodeId}',
        'GET /job?id=',
        'GET /media?p=episodes/s01e01/assets/full.mp3',
        'GET /lan',
        'GET /listen-info?episodeId=s01e01',
        'GET /stt-status',
        'POST /stt-prepare {providerId?}',
        'POST /stt {audioBase64, language?}',
      ],
    }),
  },
  { path: '/library', methods: ['GET', 'HEAD'], run: async () => libraryView() },
  { path: '/material', methods: ['GET', 'HEAD'], run: async (req, res, url) => handleMaterial(url) },
  { path: '/scan', methods: ['POST'], run: async (req) => handleScan(await readJsonBody(req)) },
  { path: '/generate', methods: ['POST'], run: async (req) => handleGenerate(await readJsonBody(req)) },
  { path: '/job', methods: ['GET', 'HEAD'], run: async (req, res, url) => handleJob(url) },
  {
    path: '/media',
    methods: ['GET', 'HEAD'],
    run: async (req, res, url) => {
      serveMedia(req, res, url);
      return undefined;
    },
  },
  { path: '/lan', methods: ['GET', 'HEAD'], run: async () => handleLan() },
  { path: '/listen-info', methods: ['GET', 'HEAD'], run: async (req, res, url) => handleListenInfo(url) },
  { path: '/stt-status', methods: ['GET', 'HEAD'], run: async () => handleSttStatus() },
  { path: '/stt-prepare', methods: ['POST'], run: async (req) => handleSttPrepare(await readJsonBody(req)) },
  {
    path: '/stt',
    methods: ['POST'],
    run: async (req) => handleStt(await readJsonBody(req, STT_BODY_LIMIT)),
  },
];

async function dispatchInner(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  let url;
  try {
    url = new URL(String(req.url || '/'), 'http://127.0.0.1');
  } catch {
    writeJson(res, 400, { ok: false, error: '请求地址无效' }, method === 'HEAD');
    return;
  }
  const pathname = url.pathname;

  if (!isLoopback(req)) {
    writeJson(res, 403, { ok: false, error: '仅允许本机访问该接口' }, method === 'HEAD');
    return;
  }
  if (state.disposed) {
    writeJson(res, 503, { ok: false, error: '插件已卸载' }, method === 'HEAD');
    return;
  }
  if (pathname !== API && !pathname.startsWith(`${API}/`)) {
    writeJson(res, 404, { ok: false, error: '未知接口' }, method === 'HEAD');
    return;
  }
  const subPath = pathname.slice(API.length) || '/';
  const route = API_ROUTES.find((item) => item.path === subPath);
  if (!route) {
    writeJson(res, 404, { ok: false, error: `未知接口：${subPath}` }, method === 'HEAD');
    return;
  }
  if (!route.methods.includes(method)) {
    try {
      res.setHeader('allow', route.methods.join(', '));
    } catch {
      /* ignore */
    }
    writeJson(res, 405, { ok: false, error: `该接口只支持 ${route.methods.join(', ')}` }, false);
    return;
  }

  try {
    const result = await route.run(req, res, url);
    if (result !== undefined && !res.writableEnded) {
      writeJson(res, 200, { ok: true, ...result }, method === 'HEAD');
    }
  } catch (error) {
    const status = Number.isInteger(error && error.status) ? error.status : 500;
    const message = String((error && error.message) || error);
    const payload = { ok: false, error: message, message };
    if (typeof (error && error.code) === 'string') payload.code = error.code;
    if (error && error.phase !== undefined) payload.phase = error.phase;
    if (status >= 500) console.error('[meiju-english] route failed:', message);
    if (!res.headersSent && !res.writableEnded) {
      writeJson(res, status, payload, method === 'HEAD');
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}

function dispatch(req, res) {
  dispatchInner(req, res).catch((error) => {
    console.error('[meiju-english] dispatch failed:', String((error && error.stack) || error));
    try {
      if (!res.headersSent && !res.writableEnded) writeJson(res, 500, { ok: false, error: '服务器内部错误' }, false);
      else if (!res.writableEnded) res.end();
    } catch {
      /* ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// cordis entry
// ---------------------------------------------------------------------------

function applyOptions(ctx, config) {
  const candidates = [];
  if (isPlainObject(config)) candidates.push(config);
  // Cordis throws when a service-like property is read without being injected,
  // so the optional context sources are probed defensively.
  try {
    if (ctx && isPlainObject(ctx.config)) candidates.push(ctx.config);
  } catch {
    /* config is not injected for this fiber */
  }
  try {
    if (ctx && isPlainObject(ctx.options)) candidates.push(ctx.options);
  } catch {
    /* options is not injected for this fiber */
  }
  for (const candidate of candidates) {
    if (typeof candidate.dataRoot === 'string' && candidate.dataRoot.trim()) {
      state.dataRoot = path.resolve(candidate.dataRoot.trim());
    }
    const port = Number(candidate.lanPort);
    if (Number.isInteger(port) && port > 0 && port < 65536) state.lanPort = port;
  }
}

function mount(ctx) {
  const webServer = ctx && ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    diag('mount: webServer service unavailable');
    console.warn('[meiju-english] webServer service unavailable; API routes not mounted');
    return () => {};
  }
  diag('mount: start');

  state.disposed = false;
  try {
    fs.mkdirSync(state.dataRoot, { recursive: true });
  } catch {
    /* the data root is created by the project setup; requests surface real errors */
  }

  const disposers = [];
  const register = (route) => {
    try {
      const dispose = webServer.register(route);
      if (typeof dispose === 'function') disposers.push(dispose);
      else if (dispose && typeof dispose.dispose === 'function') disposers.push(() => dispose.dispose());
      diag(`route registered kind=${route.kind} path=${route.path}`);
    } catch (error) {
      diag(`route register FAILED kind=${route.kind} path=${route.path}: ${String((error && error.message) || error)}`);
      console.error(
        `[meiju-english] failed to register route ${route && route.path}:`,
        String((error && error.message) || error),
      );
    }
  };

  register({ kind: 'prefix', path: API, handler: dispatch });

  // Start the LAN server eagerly: the phone listen link and the loopback-only
  // speech diagnostics (/stt-status, /stt-prepare, /stt) must work without a
  // browser request having to trigger the server first.
  try {
    ensureLanServer().then(
      (server) => {
        let port = state.lanPort;
        try {
          const address = server.address();
          if (address && typeof address === 'object' && Number.isInteger(address.port)) port = address.port;
        } catch {
          /* keep the configured port */
        }
        diag(`lan: eager start ok port=${port} ip=${pickLanIp()}`);
      },
      (error) => {
        diag(`lan: eager start FAILED ${String((error && error.message) || error)}`);
      },
    );
  } catch (error) {
    diag(`lan: eager start threw ${String((error && error.message) || error)}`);
  }

  return () => {
    state.disposed = true;
    for (const job of state.jobs.values()) {
      if (job.status !== 'running') continue;
      try {
        if (job.child) job.child.kill();
      } catch {
        /* already gone */
      }
      job.child = null;
      job.status = 'error';
      job.error = '插件已卸载';
      job.finishedAt = Date.now();
      job.progress = { stage: 'error', pct: 0, message: '插件已卸载' };
    }
    state.episodeJobs.clear();
    stopLanServer();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}

export function apply(ctx, config) {
  try {
    diag('apply: called');
    applyOptions(ctx, config);
    const scope = (deps, fn) => {
      try {
        if (ctx && typeof ctx.inject === 'function') {
          diag('apply: ctx.inject available');
          ctx.inject(deps, (scoped) => {
            // Probe only for diagnostics: reading an undeclared service on a
            // scoped context throws in Cordis, so never let this line break the
            // mount of an unrelated scope (e.g. the optional speechToText one).
            let webServerProbe = 'not-in-scope';
            try {
              webServerProbe = String(!!(scoped && scoped.webServer));
            } catch {
              webServerProbe = 'unreadable';
            }
            diag(`apply: inject callback reached deps=${deps.join(',')} webServer=${webServerProbe}`);
            const dispose = fn(scoped || ctx);
            if (typeof dispose === 'function') ctx.effect(() => dispose);
          });
        } else {
          diag('apply: ctx.inject NOT available');
          const dispose = fn(ctx);
          if (typeof dispose === 'function') ctx.effect(() => dispose);
        }
      } catch (error) {
        diag('apply: scope failed ' + String((error && error.stack) || error));
        console.error(
          `[meiju-english] mount failed for ${deps.join(',')}:`,
          String((error && error.message) || error),
        );
      }
    };
    scope(['webServer'], mount);
    // Optional local speech engine (SenseVoice through the Host speechToText
    // service). It must be bound in its own inject scope: reading an undeclared
    // Cordis service (e.g. `ctx.speechToText`) outside an injected scope throws.
    scope(['speechToText'], (scoped) => {
      let service = null;
      try {
        service = (scoped && scoped.speechToText) || null;
      } catch (error) {
        diag(`stt: speechToText read failed ${String((error && error.message) || error)}`);
      }
      state.stt = service;
      let providerSummary = '';
      try {
        const snapshot = sttSnapshot();
        const providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers.map(sttProviderView) : [];
        providerSummary = providers.map((provider) => `${provider.id}:${provider.phase}`).join(',');
      } catch {
        providerSummary = '?';
      }
      diag(`stt: speechToText bound=${String(!!state.stt)} providers=${providerSummary || 'none'}`);
      return () => {
        state.stt = null;
        diag('stt: speechToText unbound');
      };
    });
  } catch (error) {
    diag('apply: threw ' + String((error && error.stack) || error));
    console.error('[meiju-english] apply failed:', String((error && error.stack) || error));
  }
}
