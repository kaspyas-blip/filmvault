import assert from 'node:assert/strict';
import { test } from 'node:test';
import { film, testEnv } from './helpers.js';

testEnv();
const { parseTime, parseWhen, formatTime } = await import('../src/time.js');
const { titlesIn } = await import('../src/wishlist.js');
const { normalizeTitle, parseQuery, titleSimilarity } = await import('../src/movieinfo.js');
const { isLink, isWebUrl, webAddress, itemFromYtDlp } = await import('../src/web.js');
const { buildFfmpegArgs, outputRate } = await import('../src/ffmpeg.js');
const { defaultTracks, resumeSeconds } = await import('../src/jellyfin.js');
const { computeStats, periodRange } = await import('../src/stats.js');
const { sharedStretch } = await import('../src/segments.js');

test('parseTime', () => {
  assert.equal(parseTime('1:20:00').seconds, 4800);
  assert.equal(parseTime('45').seconds, 2700);
  assert.deepEqual(parseTime('+5'), { seconds: 300, relative: true });
  assert.deepEqual(parseTime('-30s'), { seconds: -30, relative: true });
  assert.equal(parseTime('1,5h').seconds, 5400);
  assert.equal(parseTime('90:00').seconds, 5400);
  assert.equal(parseTime('abc'), null);
  assert.equal(parseTime('1:99'), null);
});

test('formatTime', () => {
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(null), '0:00');
});

test('parseWhen', () => {
  const now = new Date(2026, 10, 4, 22, 0);
  assert.equal(parseWhen('', now), now.getTime());
  assert.equal(new Date(parseWhen('včera', now)).getDate(), 3);
  assert.equal(parseWhen('31.2.', now), null);
  assert.equal(parseWhen('25:00', now), null);
  assert.equal(parseWhen('nesmysl', now), null);
  assert.equal(new Date(parseWhen('28.12.', now)).getFullYear(), 2025);
});

test('titlesIn takes titles, not chatter', () => {
  assert.deepEqual(titlesIn('- Duna\n2. Shrek\nco dneska?\n// poznamka'), ['Duna', 'Shrek']);
  assert.equal(titlesIn(Array(20).fill('x').join('\n')).length, 10);
});

test('titles', () => {
  assert.equal(normalizeTitle('Mizerové II'), 'mizerove 2');
  assert.equal(parseQuery('Duna (2021)').year, 2021);
  assert.equal(parseQuery('Mizerové 1,2,3').title, 'Mizerové');
  assert.equal(titleSimilarity('kryci jmeni zohan', 'Zohan: Krycí jméno Kadeřník'), 1);
  assert.equal(normalizeTitle('鬼滅の刃'), '');
});

test('only https links of the two sites', () => {
  for (const good of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://kick.com/x', 'https://m.youtube.com/watch?v=x']) assert.ok(isWebUrl(good), good);
  for (const bad of ['http://kick.com/x', 'https://kick.com.evil.com/', 'https://kick.com@evil.com/', 'https://evil.com/kick.com', 'file:///c:/x', 'Avengers', 'javascript:alert(1)']) assert.ok(!isWebUrl(bad), bad);
});

test('links written without https://', () => {
  assert.equal(webAddress(' kick.com/xqc '), 'https://kick.com/xqc');
  assert.equal(webAddress('youtu.be/abc'), 'https://youtu.be/abc');
  assert.equal(webAddress('Kick-Ass'), 'Kick-Ass');
  assert.equal(isLink(webAddress('kick.com.evil.com/x')), false);
});

test('what yt-dlp says becomes an item', () => {
  const live = itemFromYtDlp({ title: 'Stream 2026-11-04 02:13', uploader: 'xQc', is_live: true, webpage_url: 'https://kick.com/xqc', url: 'https://hls/x.m3u8', vcodec: 'avc1.64', acodec: 'mp4a', fps: 60 }, 'https://kick.com/xqc');
  assert.equal(live.Name, '🔴 xQc: Stream');
  assert.equal(live.web.live, true);
  assert.equal(live.RunTimeTicks, null);
  const video = itemFromYtDlp({
    title: 'Video', duration: 100, webpage_url: 'https://www.youtube.com/watch?v=x',
    requested_formats: [{ url: 'https://v', vcodec: 'avc1.64', fps: 30, http_headers: { 'User-Agent': 'UA', Cookie: 'no' } }, { url: 'https://a', vcodec: 'none' }],
  }, 'https://youtu.be/x');
  assert.equal(video.web.audioUrl, 'https://a');
  assert.equal(video.web.headers, 'User-Agent: UA\r\n');
  assert.equal(video.Id, 'https://www.youtube.com/watch?v=x');
  assert.throws(() => itemFromYtDlp({ _type: 'playlist' }, 'x'), /Playlisty/);
  assert.throws(() => itemFromYtDlp({ url: 'file:///etc/passwd', vcodec: 'x' }, 'x'), /nedá/);
});

test('ffmpeg arguments', () => {
  assert.equal(outputRate(60).fps, 30);
  assert.equal(outputRate(23.976).rate, '24000/1001');
  const web = buildFfmpegArgs({ url: 'https://v', audioUrl: 'https://a', headers: 'User-Agent: x\r\n', startSeconds: 30 });
  assert.equal(web.filter(a => a === '-i').length, 2);
  assert.equal(web.filter(a => a === '-ss').length, 2);
  assert.ok(web.includes('1:a:0'));
  assert.equal(web.join(' ').includes('secret-jellyfin-key'), false);
  const night = buildFfmpegArgs({ url: 'https://v', headers: '', sound: 'night', leadIn: 5 });
  assert.ok(night[night.indexOf('-af') + 1].includes('acompressor'));
  assert.ok(night[night.indexOf('-af') + 1].includes('adelay=delays=5000'));
  assert.equal(night.filter(a => a === '-af').length, 1);
  assert.ok(night.includes('-center_mix_level'));
  assert.equal(buildFfmpegArgs({ url: 'http://j' }).join(' ').includes('secret-jellyfin-key'), true);
});

test('default tracks', () => {
  const streams = (...s) => ({ MediaStreams: s });
  const czech = { Type: 'Audio', Index: 1, Language: 'cze', Title: 'CZ' };
  const english = { Type: 'Audio', Index: 2, Language: 'eng', IsDefault: true };
  const commentary = { Type: 'Audio', Index: 3, Language: 'cze', Title: 'Komentář režiséra' };
  const forced = { Type: 'Subtitle', Index: 4, Language: 'cze', IsForced: true, IsTextSubtitleStream: true };
  const full = { Type: 'Subtitle', Index: 5, Language: 'cze', IsTextSubtitleStream: true };
  assert.deepEqual(defaultTracks(streams(english, czech, forced, full)), { audioIndex: 1, subtitleIndex: 4 });
  assert.deepEqual(defaultTracks(streams(english, full)), { audioIndex: 2, subtitleIndex: 5 });
  assert.equal(defaultTracks(streams(commentary, english)).audioIndex, 2);
  assert.deepEqual(defaultTracks(streams()), { audioIndex: null, subtitleIndex: null });
});

test('resume position', () => {
  const at = seconds => ({ ...film({ minutes: 100 }), UserData: { PlaybackPositionTicks: seconds * 10_000_000 } });
  assert.equal(resumeSeconds(at(30)), null);
  assert.equal(resumeSeconds(at(1000)), 995);
  assert.equal(resumeSeconds(at(5990)), null);
  assert.equal(resumeSeconds({ ...at(1000), UserData: { PlaybackPositionTicks: 1e10, Played: true } }), null);
});

test('statistics', async () => {
  const entry = (label, extra = {}) => ({
    id: extra.id ?? 'x', label, by: 'A', byId: '11111111111111111', startedAt: Date.UTC(2026, 9, 30, 19), endedAt: Date.UTC(2026, 9, 30, 21),
    position: 7200, duration: 7200, finished: true, watched: 7200, viewers: { "11111111111111111": { name: 'A', seconds: 7200 }, "22222222222222222": { name: 'B', seconds: 60 } }, ...extra,
  });
  const stats = await computeStats({ entries: [entry('Film'), entry('YouTube', { id: 'https://youtu.be/x' })], wishes: { open: [], done: [] } });
  assert.equal(stats.films, 1);
  assert.equal(stats.perPerson.get('11111111111111111').films, 1);
  assert.equal(stats.perPerson.get('22222222222222222').films, 0);
  assert.equal(stats.replays.size, 2);
  const unfinished = await computeStats({ entries: [entry('Film', { finished: false })], wishes: { open: [], done: [] } });
  assert.equal(unfinished.replays.size, 0);
});

test('month ranges in Prague time, also over the new year', () => {
  const [from, to] = periodRange('minuly', Date.UTC(2026, 0, 15));
  assert.equal(new Date(from).toISOString(), '2025-11-30T23:00:00.000Z');
  assert.equal(new Date(to).toISOString(), '2025-12-31T23:00:00.000Z');
});

test('shared stretch of two fingerprints', () => {
  const noise = (n, seed = n) => { let x = seed * 2654435761 >>> 0; return Uint32Array.from({ length: n }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; }); };
  const theme = Uint32Array.from({ length: 300 }, (_, i) => (Math.imul(i + 7, 40503) ^ 0x5bd1e995) >>> 0);
  const a = Uint32Array.from([...noise(100), ...theme, ...noise(50)]);
  const b = Uint32Array.from([...noise(211), ...theme, ...noise(80)]);
  const shared = sharedStretch(a, b);
  const point = 4096 / 11025 / 3;
  assert.ok(Math.abs(shared.a[0] - 100 * point) < 1);
  assert.ok(Math.abs(shared.a[1] - 400 * point) < 1);
  assert.equal(sharedStretch(noise(100), noise(77)), null);
});
