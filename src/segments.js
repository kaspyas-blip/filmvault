import { spawn } from 'node:child_process';
import { config } from './config.js';
import { authHeader, durationSeconds, itemLabel, listEpisodes, mediaSource, streamUrl } from './jellyfin.js';
import { jsonFile } from './store.js';

/**
 * Finds the intro and the end credits of an episode the way Jellyfin's Intro Skipper
 * does, without the plugin: the theme tune and the credits music are the same in
 * neighbouring episodes. ffmpeg's chromaprint muxer turns the audio into one 32-bit
 * point per ~0.124 s; the longest stretch where two episodes' points (nearly) agree
 * at a fixed offset is the shared part. Results are kept in data/segments.json.
 */
const VERSION = 3;
const POINT_SECONDS = 4096 / 11025 / 3;
// The intro is looked for in the first 10 minutes (at most 40 % of the episode),
// the credits in the last 4.
const INTRO_WINDOW = 600;
const CREDITS_WINDOW = 240;
const MIN_INTRO = 10;
const MAX_INTRO = 150;
const MIN_CREDITS = 12;
// Points agree when at most this many of their 32 bits differ.
const MAX_BIT_DIFF = 6;
// A stretch may have short gaps of disagreement (talk over the music).
const MAX_GAP_POINTS = Math.round(3.5 / POINT_SECONDS);
// An intro this close to the start is skipped from the very beginning.
const INTRO_FROM_START = 5;
const FINGERPRINT_TIMEOUT_MS = 180_000;
// Credits by picture: a sample counts as black when this share of its pixels is dark
// (white text on black is ~95 %), and the run may break for this long (a logo card).
const BLACK_PERCENT = 92;
const BLACK_GAP_SECONDS = 3;
// ...and the last seconds before them must be a lit scene: under this share dark.
const LIT_BEFORE_SECONDS = 3;
const LIT_PERCENT = 70;

let store = null;
const file = jsonFile('data/segments.json');
// One analysis at a time, so the MiniPC's disk and CPU stay free for the stream.
let queue = Promise.resolve();
const pending = new Map();
const prints = new Map();

async function load() {
  store ??= (await file.read()) ?? {};
  return store;
}

const save = () => file.write(store);

/** Audio fingerprint of `length` seconds from `start`, as uint32 points. */
function fingerprint(item, start, length) {
  const key = `${item.Id}:${Math.round(start)}:${Math.round(length)}`;
  if (prints.has(key)) return prints.get(key);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-headers', `Authorization: ${authHeader}\r\n`,
    '-ss', String(Math.max(0, Math.floor(start))), '-i', streamUrl(item, mediaSource(item)), '-t', String(Math.round(length)),
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1',
    '-f', 'chromaprint', '-fp_format', 'raw', 'pipe:1',
  ];
  const result = new Promise((resolve, reject) => {
    const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => ff.kill(), FINGERPRINT_TIMEOUT_MS);
    ff.stdout.on('data', chunk => chunks.push(chunk));
    ff.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    ff.once('error', reject);
    ff.once('close', code => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      if (code !== 0 || data.length < 4) return reject(new Error(`chromaprint failed (${code}): ${stderr.trim()}`));
      const points = new Uint32Array(Math.floor(data.length / 4));
      for (let i = 0; i < points.length; i++) points[i] = data.readUInt32LE(i * 4);
      resolve(points);
    });
  });
  prints.set(key, result);
  result.catch(() => prints.delete(key));
  // Only the last few are worth keeping: the neighbour is compared again next time.
  if (prints.size > 8) prints.delete(prints.keys().next().value);
  return result;
}

function bitsSet(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

/**
 * Longest stretch shared by two fingerprints. Offsets come from points that match
 * exactly; for the most common ones the points are compared allowing a few bits off.
 * Returns { a: [start, end], b: [start, end] } in seconds into each, or null.
 */
export function sharedStretch(a, b) {
  const positions = new Map();
  for (let j = 0; j < b.length; j++) {
    const list = positions.get(b[j]);
    if (list) list.push(j);
    else positions.set(b[j], [j]);
  }
  const votes = new Map();
  for (let i = 0; i < a.length; i++) {
    const list = positions.get(a[i]);
    // Points that repeat a lot (silence) would vote for every offset.
    if (!list || list.length > 5) continue;
    for (const j of list) votes.set(j - i, (votes.get(j - i) ?? 0) + 1);
  }
  const shifts = new Set();
  for (const [shift] of [...votes].sort((x, y) => y[1] - x[1]).slice(0, 6)) {
    for (const near of [-1, 0, 1]) shifts.add(shift + near);
  }
  let best = null;
  for (const shift of shifts) {
    let start = -1;
    let last = -1;
    const from = Math.max(0, -shift);
    const to = Math.min(a.length, b.length - shift);
    const close = () => {
      if (start >= 0 && (!best || last - start > best.end - best.start)) best = { start, end: last, shift };
    };
    for (let i = from; i < to; i++) {
      if (bitsSet((a[i] ^ b[i + shift]) >>> 0) > MAX_BIT_DIFF) continue;
      if (start >= 0 && i - last > MAX_GAP_POINTS) close(), start = -1;
      if (start < 0) start = i;
      last = i;
    }
    close();
  }
  if (!best) return null;
  const seconds = index => index * POINT_SECONDS;
  return {
    a: [seconds(best.start), seconds(best.end + 1)],
    b: [seconds(best.start + best.shift), seconds(best.end + 1 + best.shift)],
  };
}

function introWindow(item) {
  const duration = durationSeconds(item) ?? INTRO_WINDOW * 3;
  return Math.min(INTRO_WINDOW, duration * 0.4);
}

async function findIntro(item, neighbour) {
  const [a, b] = await Promise.all([
    fingerprint(item, 0, introWindow(item)),
    fingerprint(neighbour, 0, introWindow(neighbour)),
  ]);
  const shared = sharedStretch(a, b);
  if (!shared) return null;
  let [start, end] = shared.a;
  if (end - start < MIN_INTRO || end - start > MAX_INTRO) return null;
  if (start < INTRO_FROM_START) start = 0;
  return [Math.round(start * 10) / 10, Math.round(end * 10) / 10];
}

async function findCredits(item, neighbour) {
  // Whole seconds, as ffmpeg seeks to them.
  const tail = x => Math.max(0, Math.floor((durationSeconds(x) ?? 0) - CREDITS_WINDOW));
  const [from, neighbourFrom] = [tail(item), tail(neighbour)];
  if (!from || !neighbourFrom) return null;
  const [a, b] = await Promise.all([
    fingerprint(item, from, CREDITS_WINDOW),
    fingerprint(neighbour, neighbourFrom, CREDITS_WINDOW),
  ]);
  const shared = sharedStretch(a, b);
  if (!shared || shared.a[1] - shared.a[0] < MIN_CREDITS) return null;
  return shared.a.map(t => Math.round((from + t) * 10) / 10);
}

/**
 * For credits under a different song in each episode: white text on black. The last
 * 4 minutes are sampled twice a second, without the top and bottom fifth (letterbox
 * bars made dark scenes look black). The last long run of black pictures (short
 * breaks allowed) is taken as the credits: they roll at the very end.
 */
function findCreditsByPicture(item) {
  const duration = durationSeconds(item);
  if (!duration || duration < CREDITS_WINDOW * 2) return Promise.resolve(null);
  const from = Math.floor(duration - CREDITS_WINDOW);
  const args = [
    '-hide_banner', '-loglevel', 'info', '-nostats', '-threads', '2',
    '-headers', `Authorization: ${authHeader}\r\n`,
    ...(config.hwDecode ? ['-hwaccel', config.hwDecode] : []),
    '-ss', String(from), '-i', streamUrl(item, mediaSource(item)), '-t', String(CREDITS_WINDOW),
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', 'fps=2,crop=iw:ih*0.6,scale=160:-2,blackframe=amount=0:threshold=32', '-f', 'null', '-',
  ];
  return new Promise((resolve, reject) => {
    const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const samples = [];
    let rest = '';
    const timer = setTimeout(() => ff.kill(), FINGERPRINT_TIMEOUT_MS);
    ff.stderr.on('data', chunk => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        const m = /pblack:(\d+).*?\bt:([\d.]+)/.exec(line);
        if (m) samples.push({ t: Number(m[2]), dark: Number(m[1]), black: Number(m[1]) >= BLACK_PERCENT });
      }
    });
    ff.once('error', reject);
    ff.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !samples.length) return reject(new Error(`blackframe failed (${code})`));
      let best = null;
      let start = null;
      let last = null;
      const close = () => {
        if (start !== null && last - start >= MIN_CREDITS) best = { start, end: last };
      };
      for (const { t, black } of samples) {
        if (!black) continue;
        if (start !== null && t - last > BLACK_GAP_SECONDS) close(), start = null;
        start ??= t;
        last = t;
      }
      close();
      // The credits must follow a lit scene. When the picture was dark before them too
      // (a night scene running into them), their start is unsure, and the episode is
      // better not cut there.
      const before = best && samples.filter(s => s.t >= best.start - LIT_BEFORE_SECONDS && s.t < best.start);
      if (!before?.length || before.some(s => s.dark >= LIT_PERCENT)) return resolve(null);
      resolve([best.start, best.end + 0.5].map(t => Math.round((from + t) * 10) / 10));
    });
  });
}

async function analyse(item) {
  const episodes = await listEpisodes(item.SeriesId);
  const index = episodes.findIndex(e => e.Id === item.Id);
  // The next episode first, the previous one when there is no next (or no match).
  const neighbours = [episodes[index + 1], episodes[index - 1]].filter(Boolean);
  const result = { v: VERSION, intro: null, credits: null, at: Date.now(), ticks: item.RunTimeTicks ?? null };
  // A step that failed (Jellyfin or ffmpeg hiccup) leaves the result unsaved, so the
  // episode is analysed again next time instead of keeping "nothing found".
  let failed = false;
  const attempt = (promise, what) => promise.catch(error => {
    failed = true;
    console.warn(`${what} search failed:`, error.message);
    return null;
  });
  for (const stub of neighbours) {
    const neighbour = { ...stub, MediaSources: stub.MediaSources ?? [{ Id: stub.Id }] };
    result.intro ??= await attempt(findIntro(item, neighbour), 'Intro');
    result.credits ??= await attempt(findCredits(item, neighbour), 'Credits');
    if (result.intro && result.credits) break;
  }
  result.credits ??= await attempt(findCreditsByPicture(item), 'Credits');
  return { result, failed };
}

/** What is known already for this episode, or undefined. */
export async function knownSegments(item) {
  const entry = (await load())[item.Id];
  // A replaced file (other length) has other cut times.
  if (entry?.ticks && item.RunTimeTicks && entry.ticks !== item.RunTimeTicks) return undefined;
  return entry?.v === VERSION ? entry : undefined;
}

/**
 * Intro and credits of an episode: { intro: [start, end] | null, credits: [start, end] | null }.
 * Analysed once (a few seconds of ffmpeg per episode) and then remembered.
 * Films and other items give null.
 */
export async function episodeSegments(item) {
  if (item.Type !== 'Episode' || !item.SeriesId) return null;
  const known = await knownSegments(item);
  if (known) return known;
  if (pending.has(item.Id)) return pending.get(item.Id);
  const job = queue.then(async () => {
    const started = Date.now();
    const { result, failed } = await analyse(item);
    if (!failed) {
      (await load())[item.Id] = result;
      await save();
    }
    const intro = result.intro ? `${result.intro[0]}-${result.intro[1]}s` : 'none';
    const credits = result.credits ? `${result.credits[0]}-${result.credits[1]}s` : 'none';
    console.log(`Segments of ${itemLabel(item)}: intro ${intro}, credits ${credits} (${Date.now() - started} ms)`);
    return result;
  }).finally(() => pending.delete(item.Id));
  queue = job.catch(() => {});
  pending.set(item.Id, job);
  return job;
}
