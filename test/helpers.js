import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Before anything imports config.js. Nothing here talks to Discord or Jellyfin.
// The tests read Czech texts: the language settings of a .env do not leak in.
export function testEnv() {
  Object.assign(process.env, {
    BOT_TOKEN: 'test', STREAMER_TOKEN: 'test', JELLYFIN_URL: 'http://jellyfin.test', JELLYFIN_API_KEY: 'secret-jellyfin-key', VIDEO_ENCODER: 'h264_qsv',
    LANGUAGE: 'cs', PREFERRED_LANGUAGE: 'cs', TIMEZONE: 'Europe/Prague',
  });
}

/** A Streamer that only remembers what was asked of it. */
export function fakeStreamer() {
  const calls = [];
  const streamer = {
    calls,
    voiceConnection: null,
    client: Object.assign(new EventEmitter(), { user: { id: 'me' }, guilds: { cache: new Map() } }),
    joinDelay: 0,
    joinError: null,
    async joinVoice(guildId, channelId) {
      calls.push(`join ${guildId}/${channelId}`);
      if (streamer.joinDelay) await new Promise(resolve => setTimeout(resolve, streamer.joinDelay));
      if (streamer.joinError) throw streamer.joinError;
      streamer.voiceConnection = { status: {} };
    },
    leaveVoice() {
      calls.push('leave');
      streamer.voiceConnection = null;
    },
    sendOpcode(_, data) {
      calls.push(`opcode ${data.guild_id}`);
    },
    async createStream() {
      calls.push('createStream');
      return {};
    },
    stopStream() {
      calls.push('stopStream');
    },
  };
  return streamer;
}

/** ffmpeg as a process that does nothing until told how to end. */
export function fakeProcesses() {
  const started = [];
  const startProcess = (_, args) => {
    const ff = new EventEmitter();
    ff.args = args;
    ff.stdout = new PassThrough();
    ff.stderr = new PassThrough();
    ff.kill = () => ff.emit('close', null);
    started.push(ff);
    return ff;
  };
  return { started, startProcess };
}

/** playStream that runs until the test ends it, or until it is aborted. */
export function fakeStreams() {
  const running = [];
  const startStream = (_, __, ___, signal) => new Promise((resolve, reject) => {
    const stream = { signal, end: resolve, fail: reject };
    running.push(stream);
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  return { running, startStream };
}

export const nextTick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

/** Repeats a check until it holds: for what is written to disk in the background, however slow the disk. */
export async function eventually(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await nextTick(10);
    }
  }
}

export function film({ id = 'a'.repeat(32), name = 'Film', minutes = 100, subtitles = [] } = {}) {
  return {
    Id: id,
    Type: 'Movie',
    Name: name,
    RunTimeTicks: minutes * 60 * 10_000_000,
    MediaSources: [{ Id: id, MediaStreams: [{ Type: 'Video', Codec: 'h264', RealFrameRate: 24 }, { Type: 'Audio', Index: 1 }, ...subtitles] }],
  };
}
