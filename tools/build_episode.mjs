#!/usr/bin/env node
/**
 * Meiju English Learning - episode material builder (tools/build_episode.mjs)
 *
 * Turns one episode (video + bilingual .ass subtitles) into learning material:
 *   - assets/video.mp4                stream-copied h264 video + stereo aac audio (no subtitle stream)
 *   - assets/clips/segNNNN.mp3        one short mp3 per bilingual dialogue segment (original audio)
 *   - assets/full.mp3                 concatenation of the kept (untrimmed) audio intervals
 *   - material.json                   schema described in CONTRACT.md (v2: every segment also
 *                                     carries audioStart/audioEnd mapped into the trimmed full.mp3)
 *
 * Usage:
 *   node tools/build_episode.mjs --episode s01e01 --video <mkv> --subtitle <ass>
 *        --data <dataDir> [--title-en "..."] [--title-zh "..."] [--force]
 *        [--theme-gap-min <seconds>] [--season <n>] [--number <n>]
 *
 * stdout: exactly one JSON object per line:
 *   {"stage":"...","pct":N,"message":"..."}
 *   final: {"stage":"done","pct":100,"result":{...}}
 * Errors: JSON error line on stdout + human readable message on stderr, exit code 1.
 *
 * No external dependencies (Node builtins only). All child processes are spawned
 * with argument arrays (never shell:true) so Windows paths are safe.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Tunables / constants
// ---------------------------------------------------------------------------

const BUNDLED_FFMPEG_DIR = 'D:\\ffmpeg\\bin';

const MIN_SEGMENT_SEC = 0.4;          // segments shorter than this are dropped
const MERGE_TOLERANCE_SEC = 0.5;      // excluded interval merge tolerance
const CLIP_MAX_SEC = 15;              // clip duration cap before the +0.18 tail
const CLIP_LEAD_SEC = 0.06;           // clip seeks slightly before the segment
const CLIP_TAIL_SEC = 0.18;           // clip runs slightly after the segment
const CLIP_CONCURRENCY = 3;           // at most 3 concurrent ffmpeg clip jobs
const CLIP_PROGRESS_EVERY = 25;       // stdout progress cadence for clips

const CREDITS_TAIL_WINDOW_SEC = 90;   // 歌词/note cue inside the last 90s => end credits
const CREDITS_LEAD_IN_SEC = 1;        // end credits cue time minus 1s
const CREDITS_FALLBACK_TAIL_SEC = 4;  // no credits cue => last segment end + 4s

const THEME_SEARCH_WINDOW_SEC = 480;  // opening-theme gap must start within first 8 minutes
const THEME_GAP_MIN_SEC = 15;         // opening-theme gap must be at least 15 seconds

const NON_DIALOGUE_STYLES = new Set([
  'f6-标题', 'f6-英文字体', '片头', '片头曲', '歌词', '滚动', 'name', 'note',
  'op', 'ed', 'title', 'credits', 'credit', 'sign', 'logo', 'staff', 'comment',
]);

// Styles that describe the opening theme / show title.
const THEME_STYLES = new Set(['片头', '片头曲', 'f6-标题']);
// Styles that describe the closing credit roll.
const ROLL_STYLES = new Set(['滚动']);
// Styles that may mark the start of the end credits when found in the last 90s.
const CREDITS_TAIL_STYLES = new Set(['歌词', 'note']);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const HAS_LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;

const DEFAULT_EVENT_FIELDS = [
  'layer', 'start', 'end', 'style', 'name',
  'marginl', 'marginr', 'marginv', 'effect', 'text',
];

// ---------------------------------------------------------------------------
// stdout protocol helpers
// ---------------------------------------------------------------------------

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function progress(stage, pct, message) {
  emitJson({ stage, pct: Math.max(0, Math.min(100, Math.round(pct))), message: String(message) });
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function fixed3(n) {
  return Number(round2(n)).toFixed(2);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function tail(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s.trim();
  return ('...' + s.slice(-maxChars)).trim();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isNonEmptyFile(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function fileBytes(file) {
  return fs.statSync(file).size;
}

function relPosix(baseDir, target) {
  return path.relative(baseDir, target).split(path.sep).join('/');
}

function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows fallback: replace in place if rename is not possible.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    fs.writeFileSync(file, content, 'utf8');
  }
}

function normStyle(style) {
  return String(style || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const USAGE = [
  'usage: node tools/build_episode.mjs --episode <id> --video <mkv> --subtitle <ass> --data <dataDir>',
  '       [--title-en "..."] [--title-zh "..."] [--force]',
  '       [--theme-gap-min <seconds>] [--season <n>] [--number <n>]',
  '',
  'Builds data/episodes/<id>/{assets/video.mp4,assets/full.mp3,assets/clips/segNNNN.mp3,material.json}.',
  'Prints one JSON progress object per line on stdout.',
].join('\n');

function parseArgs(argv) {
  const out = {
    episode: '',
    video: '',
    subtitle: '',
    data: '',
    titleEn: '',
    titleZh: '',
    season: null,
    number: null,
    themeGapMin: null,
    force: false,
    help: false,
  };

  const valueOptions = {
    'episode': 'episode',
    'video': 'video',
    'subtitle': 'subtitle',
    'data': 'data',
    'title-en': 'titleEn',
    'title-zh': 'titleZh',
    'season': 'season',
    'number': 'number',
    'theme-gap-min': 'themeGapMin',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (typeof raw !== 'string' || raw === '') continue;
    if (!raw.startsWith('--')) {
      throw new Error(`unexpected argument "${raw}"\n${USAGE}`);
    }
    let key = raw.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key === 'force') {
      if (value !== undefined) throw new Error('option --force does not take a value');
      out.force = true;
      continue;
    }
    if (key === 'help' || key === 'h') {
      out.help = true;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(valueOptions, key)) {
      throw new Error(`unknown option --${key}\n${USAGE}`);
    }
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
        throw new Error(`option --${key} requires a value\n${USAGE}`);
      }
      i += 1;
    }
    out[valueOptions[key]] = value;
  }

  return out;
}

function requireFile(value, optionName) {
  if (!value) throw new Error(`missing required option --${optionName}\n${USAGE}`);
  const resolved = path.resolve(String(value));
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error(`--${optionName} file not found: ${resolved}`);
  }
  if (!st.isFile() || st.size <= 0) {
    throw new Error(`--${optionName} is not a readable file: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Child process / ffmpeg / ffprobe
// ---------------------------------------------------------------------------

function resolveBinary(name) {
  const envPath = process.env[name.toUpperCase() + '_PATH'];
  if (envPath && fs.existsSync(envPath)) return envPath;
  const bundled = path.join(BUNDLED_FFMPEG_DIR, name + '.exe');
  if (fs.existsSync(bundled)) return bundled;
  return name; // rely on PATH
}

function runCommand(bin, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60 * 60 * 1000;
  const label = options.label || bin;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`failed to start ${label}: ${err && err.message ? err.message : String(err)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
      if (stdout.length > 8_000_000) stdout = stdout.slice(-4_000_000);
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    child.on('error', (err) => {
      const hint = err && err.code === 'ENOENT'
        ? ' - install ffmpeg or set FFMPEG_PATH / FFPROBE_PATH'
        : '';
      finish(reject, new Error(`${label} could not start (${bin}): ${err && err.message ? err.message : String(err)}${hint}`));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      let why;
      if (timedOut) why = `timed out after ${timeoutMs}ms`;
      else if (signal) why = `was killed (${signal})`;
      else why = `exited with code ${code}`;
      finish(reject, new Error(`${label} ${why}\nstderr tail:\n${tail(stderr, 2000)}`));
    });
  });
}

async function probeFile(ffprobeBin, file) {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,duration',
    '-of', 'json',
    file,
  ];
  const { stdout } = await runCommand(
    ffprobeBin,
    args,
    { timeoutMs: 120000, label: `ffprobe ${path.basename(file)}` },
  );

  let data;
  try {
    data = JSON.parse(String(stdout || '').trim() || '{}');
  } catch {
    throw new Error(`ffprobe returned invalid JSON for ${file}: ${String(stdout).slice(0, 500)}`);
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const videoStream = streams.find((s) => s && s.codec_type === 'video') || null;
  const audioStream = streams.find((s) => s && s.codec_type === 'audio') || null;

  let duration = Number(data.format && data.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    const streamDurations = streams
      .map((s) => Number(s && s.duration))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (streamDurations.length) duration = Math.max(...streamDurations);
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`could not determine duration of ${file}`);
  }

  return { duration, videoStream, audioStream, hasAudio: !!audioStream };
}

// ---------------------------------------------------------------------------
// .ass parsing
// ---------------------------------------------------------------------------

function parseAssTime(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return NaN;
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s);
  if (m) {
    const frac = m[4] ? Number('0.' + m[4]) : 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Split on a separator but keep at most `limit` fields (the last one keeps the rest). */
function splitLimited(str, sep, limit) {
  const out = [];
  let start = 0;
  for (let i = 0; i < str.length && out.length < limit - 1; i += 1) {
    if (str[i] === sep) {
      out.push(str.slice(start, i));
      start = i + 1;
    }
  }
  out.push(str.slice(start));
  return out;
}

/** Strip ASS override blocks, line breaks, leftover escapes and html-ish tags. */
function cleanText(input) {
  let t = String(input == null ? '' : input);
  t = t.replace(/\{[^}]*\}/g, ' ');       // {\...} override blocks (also malformed "{{\\...}")
  t = t.replace(/\\[Nn]/g, ' ');          // explicit line breaks
  t = t.replace(/\\h/g, ' ');             // hard space
  t = t.replace(/\\[a-zA-Z]+(?:\([^)]*\))?/g, ' '); // other stray drawing/override escapes
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');        // <i>...</i> etc.
  t = t.replace(/[{}]/g, ' ');            // stray braces
  t = t.replace(/[\u00a0\u3000]/g, ' ');
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

/**
 * Parse an .ass file into referenced style names and timed dialogue cues.
 * @returns {{styles: Set<string>, cues: Array<{start:number,end:number,style:string,name:string,text:string}>}}
 */
function parseAss(text) {
  const styles = new Set();
  const cues = [];
  let section = '';
  let eventFields = DEFAULT_EVENT_FIELDS.slice();

  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('!')) continue;

    if (line.startsWith('[')) {
      const m = /^\[([^\]]+)\]/.exec(line);
      section = m ? m[1].trim().toLowerCase() : '';
      continue;
    }

    if (section === 'v4+ styles' || section === 'v4 styles') {
      if (/^style\s*:/i.test(line)) {
        const body = line.slice(line.indexOf(':') + 1);
        const name = (body.split(',')[0] || '').trim();
        if (name) styles.add(name);
      }
      continue;
    }

    if (section !== 'events') continue;

    if (/^format\s*:/i.test(line)) {
      const names = line.slice(line.indexOf(':') + 1)
        .split(',')
        .map((s) => s.trim().toLowerCase());
      if (names.includes('start') && names.includes('end')) eventFields = names;
      continue;
    }

    // Only real Dialogue lines; skip Comment:/Picture:/Sound:/Movie:/Command:.
    if (!/^dialogue\s*:/i.test(line)) continue;

    const body = line.slice(line.indexOf(':') + 1);
    const parts = splitLimited(body, ',', Math.max(eventFields.length, 1));
    const field = (fieldName) => {
      const idx = eventFields.indexOf(fieldName);
      return idx >= 0 ? String(parts[idx] == null ? '' : parts[idx]) : '';
    };

    const start = parseAssTime(field('start'));
    const end = parseAssTime(field('end'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    cues.push({
      start,
      end,
      style: field('style').trim(),
      name: field('name').trim(),
      text: field('text'),
    });
  }

  return { styles, cues };
}

/** Decide which dialogue lane a cue belongs to ('zh' | 'en' | null = not dialogue). */
function laneOf(style, cleanedText) {
  const s = normStyle(style);
  if (!s || NON_DIALOGUE_STYLES.has(s)) return null;
  if (/(chinese|chs|cht|chi|zh|中文|简体|繁体|汉语)/.test(s)) return 'zh';
  if (/(english|eng|英文|^en$)/.test(s)) return 'en';
  // Unknown style names: fall back to the script used by the line.
  return CJK_RE.test(cleanedText) ? 'zh' : 'en';
}

// ---------------------------------------------------------------------------
// Segment construction
// ---------------------------------------------------------------------------

function overlapSeconds(a, b) {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Build dialogue segments: pair every eng cue with the chinese cue that overlaps it
 * the most; cues without a partner are kept in their own language.
 */
function buildSegments(cues) {
  const items = [];
  for (const cue of cues) {
    const text = cleanText(cue.text);
    if (!text) continue;
    if (!HAS_LETTER_OR_NUMBER_RE.test(text)) continue; // drop "■", punctuation-only graphics
    const lane = laneOf(cue.style, text);
    if (!lane) continue;
    items.push({ start: cue.start, end: cue.end, lane, text });
  }

  const eng = items.filter((it) => it.lane === 'en');
  const zh = items.filter((it) => it.lane === 'zh');

  const zhSorted = zh.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const zhStarts = zhSorted.map((z) => z.start);
  const maxZhDuration = zh.reduce((acc, z) => Math.max(acc, z.end - z.start), 0);

  const candidates = [];
  for (let ei = 0; ei < eng.length; ei += 1) {
    const e = eng[ei];
    const from = lowerBound(zhStarts, e.start - maxZhDuration - 0.001);
    for (let zi = from; zi < zhSorted.length; zi += 1) {
      const z = zhSorted[zi];
      if (z.start >= e.end) break;
      const ov = overlapSeconds(e, z);
      if (ov > 0.001) candidates.push({ ei, zi, ov });
    }
  }
  candidates.sort((a, b) => (b.ov - a.ov) || (a.zi - b.zi) || (a.ei - b.ei));

  const usedEng = new Set();
  const usedZh = new Set();
  const segments = [];

  for (const cand of candidates) {
    if (usedEng.has(cand.ei) || usedZh.has(cand.zi)) continue;
    usedEng.add(cand.ei);
    usedZh.add(cand.zi);
    const e = eng[cand.ei];
    const z = zhSorted[cand.zi];
    segments.push({
      start: Math.min(e.start, z.start),
      end: Math.max(e.end, z.end),
      en: e.text,
      zh: z.text,
      paired: true,
    });
  }
  for (let i = 0; i < eng.length; i += 1) {
    if (usedEng.has(i)) continue;
    const e = eng[i];
    segments.push({ start: e.start, end: e.end, en: e.text, zh: '', paired: false });
  }
  for (let i = 0; i < zhSorted.length; i += 1) {
    const z = zhSorted[i];
    if (usedZh.has(i)) continue;
    segments.push({ start: z.start, end: z.end, en: '', zh: z.text, paired: false });
  }

  segments.sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const kept = [];
  for (const seg of segments) {
    if (!(seg.end - seg.start >= MIN_SEGMENT_SEC)) continue;
    if (!seg.en && !seg.zh) continue;
    kept.push({
      start: round2(seg.start),
      end: round2(seg.end),
      en: seg.en,
      zh: seg.zh,
      paired: seg.paired,
    });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Trim detection
// ---------------------------------------------------------------------------

function mergeRanges(list, tolerance) {
  const tol = Number.isFinite(tolerance) ? tolerance : MERGE_TOLERANCE_SEC;
  const sorted = list
    .filter((r) => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0])
    .map((r) => [r[0], r[1]])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range[0] - last[1] <= tol) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      out.push([range[0], range[1]]);
    }
  }
  return out;
}

function complementIntervals(intervals, total) {
  const kept = [];
  let cursor = 0;
  for (const range of intervals) {
    const start = Math.max(0, range[0]);
    const end = Math.min(total, range[1]);
    if (start > cursor + 0.004) kept.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (total > cursor + 0.004) kept.push([cursor, total]);
  return kept.filter(([a, b]) => b - a > 0.005);
}

/**
 * Map an ORIGINAL video/audio timestamp into the trimmed full.mp3 timeline (CONTRACT v2 s1).
 * Strict mapping, no clamping:
 *   audioTime = t - sum(duration of excluded intervals whose end <= t), rounded to 2 decimals.
 * For S01E01 the excluded intervals are [0,49.96] and [1361.6,1368.37], so segment 1
 * (start 49.96) maps to 0.00 and the last segment (start 1355.1 -> 1305.14).
 */
function mapToAudioTime(originalTime, excludedIntervals) {
  let removed = 0;
  for (const [a, b] of excludedIntervals) {
    if (b <= originalTime + 1e-9) removed += (b - a);
  }
  return round2(originalTime - removed);
}

/**
 * Find the opening theme as the largest subtitle gap in the first part of the episode
 * (the theme song / fountain credits are normally not subtitled at all).
 */
function findThemeGap(segments, firstStart, minGapSec, searchWindowSec) {
  const sorted = segments.slice().sort((a, b) => a.start - b.start);
  const limit = firstStart + searchWindowSec;
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    const gap = next.start - prev.end;
    if (gap <= 0) continue;
    if (prev.end < firstStart - 0.01) continue;
    if (prev.end > limit) continue;
    gaps.push({ start: round2(prev.end), end: round2(next.start), gap });
  }
  gaps.sort((a, b) => (b.gap - a.gap) || (a.start - b.start));
  const qualified = gaps.filter((g) => g.gap >= minGapSec);
  return { chosen: qualified.length ? qualified[0] : null, candidates: gaps.slice(0, 6) };
}

function detectTrim(cues, segments, duration, themeGapMinSec) {
  const excludedReasons = [];
  const themeIntervals = [];
  const notes = [];

  // --- head: 0 .. first (bilingual, if possible) dialogue segment -----------
  const firstPair = segments.find((s) => s.en && s.zh);
  let headEnd = 0;
  if (firstPair) headEnd = firstPair.start;
  else if (segments.length) headEnd = segments[0].start;
  headEnd = clamp(headEnd, 0, duration);
  if (headEnd > 0.05) {
    excludedReasons.push({ start: 0, end: round2(headEnd), reason: 'fansub bumper / head' });
  } else {
    headEnd = 0;
  }

  // --- opening theme: explicit theme styles (片头 / F6-标题) where present ---
  const themeStyleCues = cues.filter((c) => THEME_STYLES.has(normStyle(c.style)));
  const styleRanges = mergeRanges(themeStyleCues.map((c) => [c.start, c.end]), MERGE_TOLERANCE_SEC)
    .filter(([a, b]) => !(a >= -0.001 && b <= headEnd + MERGE_TOLERANCE_SEC))
    .map(([a, b]) => [clamp(a, 0, duration), clamp(b, 0, duration)]);

  // --- opening theme: largest unsubtitled gap (theme song is not subtitled) --
  const { chosen: themeGap, candidates: gapCandidates } = findThemeGap(
    segments, headEnd, themeGapMinSec, THEME_SEARCH_WINDOW_SEC,
  );

  for (const [a, b] of styleRanges) {
    if (b - a > 0.05) themeIntervals.push([a, b]);
  }
  if (themeGap) {
    const a = clamp(themeGap.start, 0, duration);
    const b = clamp(themeGap.end, 0, duration);
    if (b - a > 0.05) themeIntervals.push([a, b]);
  }

  const innerLyrics = cues.filter((c) => {
    const st = normStyle(c.style);
    if (st !== '歌词' && st !== 'note') return false;
    return themeIntervals.some(([a, b]) => c.start >= a - 0.05 && c.end <= b + 0.05);
  });
  if (innerLyrics.length) {
    notes.push(`theme window contains ${innerLyrics.length} 歌词/note cue(s) (already excluded)`);
  }

  for (const [a, b] of themeIntervals) {
    excludedReasons.push({ start: round2(a), end: round2(b), reason: 'opening theme' });
  }

  // --- end credits ----------------------------------------------------------
  const rollCues = cues.filter((c) => ROLL_STYLES.has(normStyle(c.style)));
  let creditsStart = null;
  let creditsHow = '';
  if (rollCues.length) {
    creditsStart = Math.min(...rollCues.map((c) => c.start));
    creditsHow = 'first 滚动 cue';
  } else {
    const tailCues = cues.filter(
      (c) => CREDITS_TAIL_STYLES.has(normStyle(c.style))
        && c.start >= duration - CREDITS_TAIL_WINDOW_SEC,
    );
    if (tailCues.length) {
      creditsStart = Math.min(...tailCues.map((c) => c.start));
      creditsHow = '歌词/note cue in last 90s';
    }
  }

  const lastSegmentEnd = segments.length ? segments[segments.length - 1].end : 0;
  if (creditsStart == null) {
    creditsStart = Math.min(duration, lastSegmentEnd + CREDITS_FALLBACK_TAIL_SEC);
    creditsHow = `fallback: last segment end + ${CREDITS_FALLBACK_TAIL_SEC}s`;
  } else {
    creditsStart = Math.max(0, creditsStart - CREDITS_LEAD_IN_SEC);
  }
  creditsStart = clamp(creditsStart, 0, duration);

  let creditsInterval = null;
  if (creditsStart > headEnd + 1 && creditsStart < duration - 0.05) {
    creditsInterval = [creditsStart, duration];
    excludedReasons.push({ start: round2(creditsStart), end: round2(duration), reason: 'end credits' });
  }

  // --- merge everything -----------------------------------------------------
  const rawExcluded = [];
  if (headEnd > 0.05) rawExcluded.push([0, headEnd]);
  for (const interval of themeIntervals) rawExcluded.push(interval);
  if (creditsInterval) rawExcluded.push(creditsInterval);

  const total = round2(duration);
  const excludedIntervals = mergeRanges(rawExcluded, MERGE_TOLERANCE_SEC)
    .map(([a, b]) => [clamp(round2(a), 0, total), clamp(round2(b), 0, total)])
    .filter(([a, b]) => b - a > 0.01);

  const keptIntervals = complementIntervals(excludedIntervals, total)
    .map(([a, b]) => [round2(a), round2(b)])
    .filter(([a, b]) => b - a > 0.01);

  excludedReasons.sort((a, b) => a.start - b.start);

  return {
    headEnd: round2(headEnd),
    themeIntervals,
    themeGap: themeGap ? { start: round2(themeGap.start), end: round2(themeGap.end), gap: round2(themeGap.gap) } : null,
    gapCandidates: gapCandidates.map((g) => ({ start: round2(g.start), end: round2(g.end), gap: round2(g.gap) })),
    creditsStart: creditsInterval ? round2(creditsStart) : null,
    creditsHow,
    innerLyricCount: innerLyrics.length,
    excludedIntervals,
    keptIntervals,
    excludedReasons,
    notes,
  };
}

// ---------------------------------------------------------------------------
// ffmpeg argument builders
// ---------------------------------------------------------------------------

function buildVideoProxyArgs(sourceVideo, outputVideo, hasAudio) {
  const args = [
    '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', sourceVideo,
    '-map', '0:v:0',
  ];
  if (hasAudio) args.push('-map', '0:a:0');
  args.push('-c:v', 'copy');
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push('-movflags', '+faststart', '-sn', outputVideo);
  return args;
}

function buildFullAudioArgs(sourceVideo, outputMp3, keptIntervals) {
  const ranges = keptIntervals.filter((r) => r[1] - r[0] > 0.01);
  if (!ranges.length) {
    throw new Error('internal error: no kept audio intervals remain after trimming');
  }

  let filter;
  if (ranges.length === 1) {
    filter = `[0:a]atrim=start=${fixed3(ranges[0][0])}:end=${fixed3(ranges[0][1])},asetpts=PTS-STARTPTS[out]`;
  } else {
    const chains = ranges.map(
      ([a, b], i) => `[0:a]atrim=start=${fixed3(a)}:end=${fixed3(b)},asetpts=PTS-STARTPTS[a${i}]`,
    );
    const labels = ranges.map((_, i) => `[a${i}]`).join('');
    filter = chains.join(';') + ';' + `${labels}concat=n=${ranges.length}:v=0:a=1[out]`;
  }

  return [
    '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', sourceVideo,
    '-filter_complex', filter,
    '-map', '[out]', '-vn',
    '-ac', '2', '-ar', '44100',
    '-c:a', 'libmp3lame', '-b:a', '128k',
    outputMp3,
  ];
}

function buildClipArgs(sourceVideo, outputMp3, start, duration) {
  const seek = Math.max(0, start - CLIP_LEAD_SEC);
  const length = Math.min(CLIP_MAX_SEC, duration) + CLIP_TAIL_SEC;
  return [
    '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-ss', seek.toFixed(3),
    '-t', length.toFixed(3),
    '-i', sourceVideo,
    '-vn',
    '-ac', '2', '-ar', '44100',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-q:a', '6',
    outputMp3,
  ];
}

// ---------------------------------------------------------------------------
// Bounded-concurrency helper
// ---------------------------------------------------------------------------

async function runPool(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;

  const runner = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { error: err };
      }
      done += 1;
      if (typeof onProgress === 'function') onProgress(done, items.length);
    }
  };

  const runners = [];
  const count = Math.min(Math.max(1, limit), items.length);
  for (let i = 0; i < count; i += 1) runners.push(runner());
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(USAGE + '\n');
    return;
  }

  const episodeId = String(args.episode || '').trim();
  if (!episodeId) throw new Error(`missing required option --episode\n${USAGE}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(episodeId) || episodeId.includes('..')) {
    throw new Error(`invalid --episode id "${episodeId}" (letters, digits, dot, dash, underscore only)`);
  }

  const videoFile = requireFile(args.video, 'video');
  const subtitleFile = requireFile(args.subtitle, 'subtitle');
  if (!args.data) throw new Error(`missing required option --data\n${USAGE}`);

  const dataDir = path.resolve(String(args.data));
  const episodeDir = path.join(dataDir, 'episodes', episodeId);
  const assetsDir = path.join(episodeDir, 'assets');
  const clipsDir = path.join(assetsDir, 'clips');
  ensureDir(clipsDir);

  const materialFile = path.join(episodeDir, 'material.json');
  const videoOut = path.join(assetsDir, 'video.mp4');
  const audioOut = path.join(assetsDir, 'full.mp3');

  const seasonFromId = /^s(\d{1,2})e(\d{1,3})$/i.exec(episodeId);
  let season = seasonFromId ? Number(seasonFromId[1]) : 0;
  let number = seasonFromId ? Number(seasonFromId[2]) : 0;
  if (String(args.season ?? '') !== '') {
    if (!Number.isInteger(Number(args.season))) {
      throw new Error(`--season must be an integer, got "${args.season}"`);
    }
    season = Number(args.season);
  }
  if (String(args.number ?? '') !== '') {
    if (!Number.isInteger(Number(args.number))) {
      throw new Error(`--number must be an integer, got "${args.number}"`);
    }
    number = Number(args.number);
  }

  let themeGapMin = THEME_GAP_MIN_SEC;
  if (String(args.themeGapMin ?? '') !== '') {
    const parsedGapMin = Number(args.themeGapMin);
    if (!Number.isFinite(parsedGapMin) || parsedGapMin <= 0) {
      throw new Error(`--theme-gap-min must be a positive number of seconds, got "${args.themeGapMin}"`);
    }
    themeGapMin = parsedGapMin;
  }

  const force = !!args.force;
  const ffmpegBin = resolveBinary('ffmpeg');
  const ffprobeBin = resolveBinary('ffprobe');

  progress('start', 1, `building ${episodeId} -> ${episodeDir}`);

  // -- probe ---------------------------------------------------------------
  const info = await probeFile(ffprobeBin, videoFile);
  const duration = round2(info.duration);
  const width = info.videoStream && Number.isFinite(Number(info.videoStream.width))
    ? Number(info.videoStream.width) : 0;
  const height = info.videoStream && Number.isFinite(Number(info.videoStream.height))
    ? Number(info.videoStream.height) : 0;

  if (!info.videoStream) throw new Error(`no video stream found in ${videoFile}`);
  if (!info.hasAudio) throw new Error(`no audio stream found in ${videoFile} (full.mp3 / clips need audio)`);

  progress(
    'probe', 3,
    `duration=${duration}s video=${width}x${height} audio=${info.audioStream && info.audioStream.codec_name ? info.audioStream.codec_name : 'yes'}`,
  );

  // -- subtitles -----------------------------------------------------------
  const assText = fs.readFileSync(subtitleFile, 'utf8');
  const ass = parseAss(assText);
  if (!ass.cues.length) throw new Error(`no Dialogue lines parsed from ${subtitleFile}`);
  progress('subtitles', 6, `parsed ${ass.cues.length} dialogue cue(s), ${ass.styles.size} style(s)`);

  // -- segments ------------------------------------------------------------
  let segments = buildSegments(ass.cues);
  if (!segments.length) throw new Error(`no dialogue segments found in ${subtitleFile}`);
  const bilingualCount = segments.filter((s) => s.en && s.zh).length;
  progress(
    'segments', 9,
    `${segments.length} candidate segment(s) (${bilingualCount} bilingual, ${segments.length - bilingualCount} single-language)`,
  );

  // -- trim detection ------------------------------------------------------
  const trim = detectTrim(ass.cues, segments, duration, themeGapMin);

  const gapText = trim.gapCandidates.length
    ? trim.gapCandidates.map((g) => `${g.start}-${g.end} (${g.gap}s)`).join(', ')
    : 'none';
  progress(
    'trim', 11,
    `head=0-${trim.headEnd} theme=${trim.themeGap ? `${trim.themeGap.start}-${trim.themeGap.end} (${trim.themeGap.gap}s gap)` : 'none'} ` +
    `credits=${trim.creditsStart != null ? `${trim.creditsStart}-${duration} (${trim.creditsHow})` : 'none'}`,
  );
  progress('trim', 12, `theme-gap candidates (end->start, >=${themeGapMin}s needed): ${gapText}`);
  if (trim.notes.length) progress('trim', 12, trim.notes.join('; '));
  progress(
    'trim', 13,
    `excludedIntervals=${JSON.stringify(trim.excludedIntervals)} keptIntervals=${JSON.stringify(trim.keptIntervals)}`,
  );

  // -- drop segments inside trimmed regions --------------------------------
  const isInsideExcluded = (start) => trim.excludedIntervals.some(
    ([a, b]) => start >= a - 1e-6 && start < b - 1e-6,
  );
  const beforeTrim = segments.length;
  segments = segments.filter((s) => !isInsideExcluded(s.start));
  if (!segments.length) throw new Error('all dialogue segments fall inside the trimmed regions - refusing to build empty material');
  if (segments.length !== beforeTrim) {
    progress('segments', 15, `dropped ${beforeTrim - segments.length} segment(s) inside trimmed regions -> ${segments.length} kept`);
  } else {
    progress('segments', 15, `${segments.length} dialogue segment(s) kept`);
  }
  segments.forEach((seg, i) => { seg.index = i + 1; });

  // -- video proxy ---------------------------------------------------------
  let videoBytes;
  if (!force && isNonEmptyFile(videoOut)) {
    videoBytes = fileBytes(videoOut);
    progress('video', 40, `video.mp4 already exists (${videoBytes} bytes) - reusing (pass --force to rebuild)`);
  } else {
    progress('video', 25, 'copying video stream + encoding stereo aac audio -> assets/video.mp4');
    await runCommand(
      ffmpegBin,
      buildVideoProxyArgs(videoFile, videoOut, info.hasAudio),
      { timeoutMs: 45 * 60 * 1000, label: 'ffmpeg (video proxy)' },
    );
    if (!isNonEmptyFile(videoOut)) throw new Error(`video proxy output was not created: ${videoOut}`);
    videoBytes = fileBytes(videoOut);
    progress('video', 40, `video.mp4 done (${videoBytes} bytes)`);
  }

  // -- full.mp3 ------------------------------------------------------------
  let audioBytes;
  if (!force && isNonEmptyFile(audioOut)) {
    progress('audio', 65, 'full.mp3 already exists - reusing (pass --force to rebuild)');
  } else {
    progress('audio', 45, `building full.mp3 from ${trim.keptIntervals.length} kept interval(s)`);
    await runCommand(
      ffmpegBin,
      buildFullAudioArgs(videoFile, audioOut, trim.keptIntervals),
      { timeoutMs: 60 * 60 * 1000, label: 'ffmpeg (full.mp3)' },
    );
    if (!isNonEmptyFile(audioOut)) throw new Error(`full.mp3 was not created: ${audioOut}`);
    progress('audio', 65, 'full.mp3 done');
  }

  const audioProbe = await probeFile(ffprobeBin, audioOut);
  const audioDuration = round2(audioProbe.duration);
  audioBytes = fileBytes(audioOut);
  progress('audio', 66, `full.mp3 duration=${audioDuration}s bytes=${audioBytes}`);

  // -- trimmed-audio timeline mapping (CONTRACT v2 section 1) --------------
  // audioStart/audioEnd = position inside full.mp3. Excluded intervals before the
  // first kept interval are the "timelineOffset" (49.96s for S01E01).
  const firstKeptStart = trim.keptIntervals.length ? trim.keptIntervals[0][0] : 0;
  let timelineOffset = 0;
  for (const [a, b] of trim.excludedIntervals) {
    if (b <= firstKeptStart + 1e-9) timelineOffset += (b - a);
  }
  timelineOffset = round2(timelineOffset);
  const firstSegmentAudioStart = segments.length
    ? mapToAudioTime(segments[0].start, trim.excludedIntervals)
    : 0;
  progress(
    'timeline', 67,
    `timelineOffset=${timelineOffset}s audioDuration=${audioDuration}s firstSegmentAudioStart=${firstSegmentAudioStart}s`,
  );

  // -- clips ---------------------------------------------------------------
  const total = segments.length;
  progress('clips', 68, `generating ${total} clip(s) (${CLIP_CONCURRENCY} concurrent)`);

  const clipResults = await runPool(
    segments,
    CLIP_CONCURRENCY,
    async (seg) => {
      const base = 'seg' + String(seg.index).padStart(4, '0');
      const clipFile = path.join(clipsDir, base + '.mp3');
      const clipRel = relPosix(dataDir, clipFile);

      if (!force && isNonEmptyFile(clipFile)) {
        return { seg, clip: clipRel, clipBytes: fileBytes(clipFile), built: false };
      }

      try {
        await runCommand(
          ffmpegBin,
          buildClipArgs(videoFile, clipFile, seg.start, seg.end - seg.start),
          { timeoutMs: 3 * 60 * 1000, label: `ffmpeg (clip ${base})` },
        );
        if (!isNonEmptyFile(clipFile)) throw new Error(`clip output was not created: ${clipFile}`);
        return { seg, clip: clipRel, clipBytes: fileBytes(clipFile), built: true };
      } catch (err) {
        // Never leave a partial clip behind: it would be silently reused next run.
        try { fs.rmSync(clipFile, { force: true }); } catch { /* ignore */ }
        throw err;
      }
    },
    (done, totalCount) => {
      if (done === totalCount || done % CLIP_PROGRESS_EVERY === 0) {
        const pct = 68 + Math.round((24 * done) / Math.max(1, totalCount));
        progress('clips', pct, `${done}/${totalCount} clip(s)`);
      }
    },
  );

  const surviving = [];
  const failures = [];
  clipResults.forEach((result, i) => {
    if (result && result.clip && !result.error) {
      surviving.push({
        index: segments[i].index,
        start: segments[i].start,
        end: segments[i].end,
        en: segments[i].en,
        zh: segments[i].zh,
        paired: segments[i].paired,
        clip: result.clip,
        clipBytes: result.clipBytes,
      });
    } else {
      failures.push({ segment: segments[i], error: result && result.error ? result.error : new Error('unknown clip failure') });
    }
  });

  for (const failure of failures.slice(0, 5)) {
    const msg = failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error);
    progress('clips', 93, `clip failed for segment ${failure.segment.index}: ${msg}`);
  }
  if (failures.length) {
    progress('clips', 93, `dropped ${failures.length} segment(s) whose clip could not be produced (kept ${surviving.length})`);
    surviving.forEach((seg, i) => { seg.index = i + 1; });
  }
  segments = surviving;
  if (!segments.length) throw new Error('no clips were produced - refusing to write empty material');

  const clipCount = segments.length;
  const clipsBuilt = clipResults.filter((result) => result && result.built === true).length;
  progress('clips', 94, `${clipCount} clip(s) ready (built=${clipsBuilt}, reused=${clipCount - clipsBuilt})`);

  // -- material.json -------------------------------------------------------
  progress('material', 95, 'writing material.json');

  const wordCount = segments.reduce((acc, seg) => {
    if (!seg.en) return acc;
    return acc + seg.en.split(/\s+/).filter(Boolean).length;
  }, 0);

  const videoRel = relPosix(dataDir, videoOut);
  const audioRel = relPosix(dataDir, audioOut);

  const material = {
    episodeId,
    season,
    number,
    titleEn: String(args.titleEn || ''),
    titleZh: String(args.titleZh || ''),
    generatedAt: new Date().toISOString(),
    source: {
      video: videoFile,
      subtitle: subtitleFile,
      duration,
    },
    video: {
      file: videoRel,
      duration,
      width,
      height,
      bytes: videoBytes,
    },
    audio: {
      full: audioRel,
      duration: audioDuration,
      audioDuration,
      timelineOffset,
      bytes: audioBytes,
      keptIntervals: trim.keptIntervals,
      excludedIntervals: trim.excludedIntervals,
      excludedReasons: trim.excludedReasons,
    },
    segments: segments.map((seg) => ({
      index: seg.index,
      start: seg.start,
      end: seg.end,
      audioStart: mapToAudioTime(seg.start, trim.excludedIntervals),
      audioEnd: mapToAudioTime(seg.end, trim.excludedIntervals),
      en: seg.en,
      zh: seg.zh,
      style: 'dialogue',
      clip: seg.clip,
      clipBytes: seg.clipBytes,
    })),
    stats: {
      segmentCount: segments.length,
      wordCount,
      durationSec: audioDuration,
    },
  };

  writeFileAtomic(materialFile, JSON.stringify(material, null, 2) + '\n');
  progress('material', 98, `material.json written: ${materialFile}`);

  emitJson({
    stage: 'done',
    pct: 100,
    result: {
      episodeId,
      materialFile,
      segmentCount: segments.length,
      clipCount,
    },
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
  await main();
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  emitJson({ stage: 'error', pct: 0, message });
  process.stderr.write(`build_episode: ${message}\n`);
  process.exitCode = 1;
}
