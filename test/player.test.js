import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { eventually, fakeProcesses, fakeStreamer, fakeStreams, film, nextTick, testEnv } from './helpers.js';

testEnv();
const { Player, UserError } = await import('../src/player.js');
const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');

const quiet = { log: console.log, warn: console.warn, error: console.error };
let player;
let streamer;
let processes;
let streams;
const events = [];

beforeEach(() => {
  Object.assign(console, { log() {}, warn() {}, error() {} });
  streamer = fakeStreamer();
  processes = fakeProcesses();
  streams = fakeStreams();
  player = new Player({ streamer, startProcess: processes.startProcess, startStream: streams.startStream });
  events.length = 0;
  for (const name of ['stopped', 'ended', 'failed']) player.on(name, (...args) => events.push([name, ...args]));
});

afterEach(() => {
  clearInterval(player.ticker);
  clearTimeout(player.idleTimer);
  Object.assign(console, quiet);
});

const play = (item = film(), options = {}) => player.play({ item, guildId: 'g1', channelId: 'c1', ...options });

/** ffmpeg stops with this exit code after the stream ran to position seconds. */
async function stopStreamAt(position, code = 0) {
  player.session.mediaMs = position * 1000;
  processes.started.at(-1).emit('close', code);
  streams.running.at(-1).end();
  await nextTick();
  await player.queue;
}

test('exit 0 at the end of a film finishes it', async () => {
  await play();
  await stopStreamAt(100 * 60 - 20);
  assert.deepEqual(events.map(e => e[0]), ['stopped', 'ended']);
  assert.equal(events[0][1].finished, true);
});

test('exit 0 in the middle is a failure, not "finished" (a broken input)', async () => {
  await play();
  await stopStreamAt(1200);
  assert.deepEqual(events.map(e => e[0]), ['stopped', 'failed']);
  assert.equal(events[0][1].finished, false);
  assert.equal(events[1][3], 1200);
});

test('a live stream never finishes by itself', async () => {
  await play({ ...film(), RunTimeTicks: null, web: { live: true, videoUrl: 'https://x', audioUrl: null, headers: '' } });
  await stopStreamAt(50);
  assert.deepEqual(events.map(e => e[0]), ['stopped', 'failed']);
});

test('without a known length, exit 0 is the end', async () => {
  await play({ ...film(), RunTimeTicks: null });
  await stopStreamAt(50);
  assert.deepEqual(events.map(e => e[0]), ['stopped', 'ended']);
});

test('a real ffmpeg failure early retries in software, and stays there for the film', async () => {
  await play();
  processes.started[0].emit('close', 1);
  streams.running[0].fail(new Error('boom'));
  await nextTick();
  await player.queue;
  assert.equal(processes.started.length, 2);
  assert.ok(processes.started[1].args.includes('libx264'));
  await player.seek(600);
  assert.ok(processes.started.at(-1).args.includes('libx264'));
});

test('a broken input right at the start does not retry in software', async () => {
  await play();
  await stopStreamAt(5);
  assert.equal(processes.started.length, 1);
  assert.equal(events.at(-1)[0], 'failed');
});

test('stop while a play waits for its subtitles cancels it', async () => {
  mkdirSync('tmp', { recursive: true });
  const fetchBack = globalThis.fetch;
  let answer;
  globalThis.fetch = () => new Promise(resolve => { answer = resolve; });
  try {
    const item = film({ id: 'b'.repeat(32), subtitles: [{ Type: 'Subtitle', Index: 5, IsTextSubtitleStream: true }] });
    const starting = play(item, { subtitleIndex: 5 });
    await eventually(() => assert.equal(typeof answer, 'function'));
    await player.stop();
    answer(new Response('subs'));
    assert.equal(await starting, false);
    assert.equal(player.item, null);
    assert.equal(processes.started.length, 0);
    assert.equal(streamer.calls.some(c => c.startsWith('join')), false);
  } finally {
    globalThis.fetch = fetchBack;
    rmSync(`tmp/subtitles-${'b'.repeat(32)}-5.ass`, { force: true });
  }
});

test('the newer of two plays wins, whichever finishes loading first', async () => {
  const first = play(film({ id: 'c'.repeat(32), name: 'First' }));
  const second = play(film({ id: 'd'.repeat(32), name: 'Second' }));
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.equal(player.item.Name, 'Second');
  assert.equal(processes.started.length, 1);
});

test('stop while joining the call does not leave a film playing', async () => {
  streamer.joinDelay = 20;
  const starting = play();
  await nextTick();
  await player.stop();
  assert.equal(await starting, false);
  assert.equal(player.item, null);
  assert.equal(processes.started.length, 0);
});

test('stop between two episodes, while the next waits for its subtitles, closes everything', async () => {
  mkdirSync('tmp', { recursive: true });
  const fetchBack = globalThis.fetch;
  let answer;
  globalThis.fetch = () => new Promise(resolve => { answer = resolve; });
  const id = '2'.repeat(32);
  try {
    await play(film(), { countdown: 'Další díl' });
    player.session.mediaMs = (100 * 60 - 10) * 1000;
    processes.started[0].emit('close', 0);
    streams.running[0].end();
    await nextTick();
    await player.queue;
    await eventually(() => assert.equal(player.countdown, 'Další díl'));
    const next = play(film({ id, subtitles: [{ Type: 'Subtitle', Index: 5, IsTextSubtitleStream: true }] }), { subtitleIndex: 5 });
    await eventually(() => assert.equal(typeof answer, 'function'));
    await player.stop();
    answer(new Response('subs'));
    assert.equal(await next, false);
    assert.equal(player.countdown, null);
    assert.equal(player.holdingLive, false);
    assert.ok(player.idleTimer);
    assert.ok(streamer.calls.includes('stopStream'));
  } finally {
    globalThis.fetch = fetchBack;
    rmSync(`tmp/subtitles-${id}-5.ass`, { force: true });
  }
});

test('a stop during the first stream creation does not block the next stream', async () => {
  let creates = 0;
  const realCreate = streamer.createStream;
  streamer.createStream = () => {
    creates++;
    return creates === 1 ? new Promise(() => {}) : realCreate();
  };
  const fresh = new Player({ streamer, startProcess: processes.startProcess, startStream: streams.startStream });
  clearInterval(fresh.ticker);
  fresh.streamer.createStream();
  await nextTick();
  fresh.streamer.stopStream();
  assert.equal(fresh.liveCreating, null);
  await Promise.race([fresh.streamer.createStream().catch(() => {}), nextTick(20)]);
  assert.equal(creates, 2);
});

test('a failed join leaves nothing marked as playing and reports the old film once', async () => {
  await play();
  streamer.joinError = new Error('join timed out');
  const other = player.play({ item: film({ id: 'e'.repeat(32) }), guildId: 'g1', channelId: 'c2' });
  await assert.rejects(other, UserError);
  assert.equal(player.item, null);
  assert.equal(player.session, null);
  assert.equal(events.filter(e => e[0] === 'stopped').length, 1);
});

test('moving to another server leaves the old call under the old server', async () => {
  await play();
  await player.stop();
  await player.play({ item: film(), guildId: 'g2', channelId: 'c9' });
  const order = streamer.calls.filter(c => c.startsWith('opcode') || c.startsWith('join'));
  assert.deepEqual(order, ['join g1/c1', 'opcode g1', 'join g2/c9']);
  assert.equal(player.guildId, 'g2');
});

test('quality and sound come from the server that plays', async () => {
  await player.play({ item: film(), guildId: 'g1', channelId: 'c1', quality: 'nizka', sound: 'night' });
  assert.equal(player.quality, 'nizka');
  assert.equal(player.sound, 'night');
  assert.ok(processes.started[0].args.includes('-af'));
});

test('being thrown out of the call stops the film and reports where', async () => {
  await play();
  player.session.mediaMs = 300_000;
  streamer.client.emit('voiceStateUpdate', {}, { id: 'me', channelId: null, guild: { id: 'g1' } });
  await nextTick();
  await player.queue;
  assert.equal(player.item, null);
  assert.equal(player.channelId, null);
  assert.equal(events.at(-1)[0], 'failed');
  assert.equal(events.at(-1)[3], 300);
});

test('someone else leaving the call changes nothing', async () => {
  await play();
  streamer.client.emit('voiceStateUpdate', {}, { id: 'other', channelId: null, guild: { id: 'g1' } });
  await nextTick();
  assert.ok(player.item);
});

test('a track change touches only what was asked', async () => {
  const item = film();
  item.MediaSources[0].MediaStreams.push({ Type: 'Audio', Index: 2 });
  await play(item, { audioIndex: 1, subtitleIndex: null });
  await player.setTracks({ audioIndex: 2 });
  assert.equal(player.audioIndex, 2);
  assert.equal(player.subtitleIndex, null);
  assert.equal(processes.started.length, 2);
});

test('an older subtitle choice finishing late does not undo a newer one', async () => {
  mkdirSync('tmp', { recursive: true });
  const id = 'f'.repeat(32);
  writeFileSync(`tmp/subtitles-${id}-6.ass`, 'x');
  const fetchBack = globalThis.fetch;
  let answer;
  globalThis.fetch = () => new Promise(resolve => { answer = resolve; });
  try {
    const subtitles = [{ Type: 'Subtitle', Index: 5, IsTextSubtitleStream: true }, { Type: 'Subtitle', Index: 6, IsTextSubtitleStream: true }];
    await play(film({ id, subtitles }));
    const older = player.setTracks({ subtitleIndex: 5 });
    await eventually(() => assert.equal(typeof answer, 'function'));
    await player.setTracks({ subtitleIndex: 6 });
    answer(new Response('subs'));
    await older;
    assert.equal(player.subtitleIndex, 6);
  } finally {
    globalThis.fetch = fetchBack;
    rmSync(`tmp/subtitles-${id}-5.ass`, { force: true });
    rmSync(`tmp/subtitles-${id}-6.ass`, { force: true });
  }
});

test('subtitles that cannot be loaded: it plays without them and says so', async () => {
  const fetchBack = globalThis.fetch;
  globalThis.fetch = async () => new Response('no', { status: 404 });
  const id = '1'.repeat(32);
  try {
    assert.equal(await play(film({ id, subtitles: [{ Type: 'Subtitle', Index: 3, IsTextSubtitleStream: true }] }), { subtitleIndex: 3 }), true);
    assert.equal(player.subtitleIndex, null);
    assert.equal(player.subtitleFailed, true);
  } finally {
    globalThis.fetch = fetchBack;
  }
});

test('a web video from its start holds the first frame, and its time starts after it', async () => {
  await play({ ...film(), web: { live: false, videoUrl: 'https://v', audioUrl: 'https://a', headers: 'User-Agent: x\r\n' } });
  const args = processes.started[0].args;
  assert.ok(args.some(a => a.includes('tpad=start_duration=5')));
  assert.equal(player.position(), 0);
  player.session.mediaMs = 8000;
  assert.equal(player.position(), 3);
});

test('the Jellyfin key never goes to a web address', async () => {
  await play({ ...film(), web: { live: false, videoUrl: 'https://v', audioUrl: 'https://a', headers: 'User-Agent: x\r\n' } });
  assert.equal(processes.started[0].args.join(' ').includes('secret-jellyfin-key'), false);
});

test('a Jellyfin film sends the key', async () => {
  await play();
  assert.ok(processes.started[0].args.join(' ').includes('secret-jellyfin-key'));
});

test('a restart during a slow first stream shares it', async () => {
  let creates = 0;
  let release;
  streamer.createStream = () => {
    creates++;
    return new Promise(resolve => { release = () => resolve({}); });
  };
  const fresh = new Player({ streamer, startProcess: processes.startProcess, startStream: streams.startStream });
  clearInterval(fresh.ticker);
  const a = fresh.streamer.createStream();
  const b = fresh.streamer.createStream();
  release();
  await Promise.all([a, b]).catch(() => {});
  assert.equal(creates, 1);
});
