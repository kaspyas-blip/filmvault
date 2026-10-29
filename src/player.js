import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@lng2004/discord.js-selfbot-v13';
import { BaseMediaConnection, Streamer, playStream } from '@dank074/discord-video-stream';
import { config } from './config.js';
import { buildFfmpegArgs, hdrTransfer } from './ffmpeg.js';
import { DEFAULT_QUALITY, QUALITIES } from './quality.js';
import { raiseTimerResolution } from './timer.js';
import {
  audioTracks, downloadSubtitle, durationSeconds, itemLabel, mediaSource, streamUrl, subtitleTracks,
} from './jellyfin.js';

const SUBTITLE_FILE = 'tmp/subtitles.ass';
const JOIN_TIMEOUT_MS = 20_000;
const HARDWARE_RETRY_WINDOW_MS = 15_000;
// ffmpeg forces a keyframe every second; sending starts at the second one after a restart.
const RESTART_SKIP_KEYFRAMES = 2;
// Receivers may buffer up to this much (10 ms units) so resent packets arrive in time.
// Viewers' stats show Discord does not pass a minimum on (Minimum Playout Delay 0 ms).
const PLAYOUT_DELAY_MAX = 600;
// Logs how evenly video frames go out, once a minute; a gap is a frame this late.
const PACE_REPORT_MS = 60_000;
const PACE_GAP_MS = 150;
// Video goes out at most this many times the chosen bitrate (ffmpeg's maxrate is 1.4x).
const SEND_RATE_FACTOR = 1.5;

/**
 * libdatachannel hands incoming RTCP to a track by the SSRCs in the session
 * description, and the library never puts ours there. So every resend request
 * (NACK) from Discord was dropped: each lost packet froze the viewers' picture
 * until the next keyframe (a third of the time on a line losing ~1 % of packets).
 * The SSRCs come in Discord's ready message, before the tracks are created.
 */
const handleReady = BaseMediaConnection.prototype.handleReady;
BaseMediaConnection.prototype.handleReady = function (d) {
  handleReady.call(this, d);
  const { audioSsrc, videoSsrc } = this._webRtcParams;
  const wrapper = this._webRtcWrapper;
  for (const [description, ssrc] of [[wrapper._audioDef, audioSsrc], [wrapper._videoDef, videoSsrc]]) {
    if (!description || !ssrc) continue;
    for (const old of description.getSSRCs()) description.removeSSRC(old);
    description.addSSRC(ssrc, 'filmvault');
  }
};

/** True for an Annex B H.264 access unit containing an IDR slice. */
function isH264Keyframe(frame) {
  for (let i = 0; i + 3 < frame.length; i++) {
    if (frame[i] !== 0 || frame[i + 1] !== 0 || frame[i + 2] !== 1) continue;
    const type = frame[i + 3] & 0x1f;
    if (type === 5) return true;
    if (type === 1) return false;
    i += 2;
  }
  return false;
}

/**
 * Packetizers on the Go Live connection (WebRtcConnWrapper) are created once, so
 * RTP sequence numbers keep running across seeks; fresh ones trip SRTP replay
 * protection on the reused stream.
 *
 * The library advances RTP timestamps only by frame durations. A seek or resume
 * leaves a few seconds without frames, so the first frames afterwards look seconds
 * late to receivers, and Discord stutters and shows blocky video until its jitter
 * buffer re-adapts. On each restart the clock is moved forward by the real gap.
 *
 * Viewers also showed a blocky second after each restart: their decoder starts
 * without the first keyframe. So restarts keep the video signalled as on (no
 * off/on toggle), and video is held back until the second keyframe (~1 s later):
 * a short freeze, then a clean picture.
 *
 * The library caps the receivers' playout delay at 100 ms (video) and 10 ms
 * (audio). A lost packet is resent on NACK, but the resend arrives after that,
 * so each loss froze the picture until the next keyframe (~0.5 s on average).
 * Watching a film could afford more, but Discord passes on only the maximum.
 *
 * The library paces video at 1.25x the last 250 ms, so a big frame raised the rate
 * with it: 20 ms bursts reached 7 Mbit/s at 2.5 Mbit/s on average. The uplink drops
 * what is over its limit, and lost packets sat mostly in those bursts (2.4 % of all).
 * Pacing at a fixed rate from the chosen bitrate spreads them out.
 * videoBitrate: () => kbit/s of the current quality.
 */
function patchConnection(conn, isRestarting, videoBitrate) {
  conn._bitrateCalculator = { addSample: () => (videoBitrate() * 1000 * SEND_RATE_FACTOR) / 1.25 };
  const setPacketizer = conn.setPacketizer.bind(conn);
  let codec = null;
  const tracks = [
    { send: 'sendVideoFrame', packetizer: '_videoPacketizer', lastSent: null, restarted: false, video: true },
    { send: 'sendAudioFrame', packetizer: '_audioPacketizer', lastSent: null, restarted: false },
  ];
  let keyframesToSkip = 0;
  conn.setPacketizer = videoCodec => {
    for (const track of tracks) track.restarted = true;
    if (tracks[0].lastSent !== null) keyframesToSkip = RESTART_SKIP_KEYFRAMES;
    if (codec === videoCodec) return;
    codec = videoCodec;
    setPacketizer(videoCodec);
    for (const track of tracks) conn[track.packetizer].rtpConfig.playoutDelayMax = PLAYOUT_DELAY_MAX;
    conn._videoTrack?.onMessage(countFeedback);
  };
  const media = conn.mediaConnection;
  for (const name of ['setSpeaking', 'setVideoAttributes']) {
    const original = media[name].bind(media);
    media[name] = (enabled, ...rest) => (enabled === false && isRestarting() ? undefined : original(enabled, ...rest));
  }
  // Sending side of a stutter: video frames handed over late (ffmpeg not keeping up)
  // show up here as gaps and as falling behind the film's own clock.
  const pace = { start: 0, media: 0, last: 0, frames: 0, gaps: 0, maxGap: 0, maxBehind: 0, reported: 0 };
  // What Discord asks of the sender: resends (NACK, packets lost on our uplink),
  // keyframes (PLI/FIR) and the bitrate it estimates it can carry (REMB).
  const feedback = { packets: 0, nacked: 0, keyframes: 0, remb: null };
  function countFeedback(message) {
    if (!Buffer.isBuffer(message)) return;
    for (let at = 0; at + 4 <= message.length;) {
      feedback.packets++;
      const format = message[at] & 0x1f;
      const type = message[at + 1];
      const end = at + (message.readUInt16BE(at + 2) + 1) * 4;
      if (type === 205 && format === 1) {
        for (let fci = at + 12; fci + 4 <= end; fci += 4) {
          let lostAfter = message.readUInt16BE(fci + 2);
          feedback.nacked++;
          for (; lostAfter; lostAfter &= lostAfter - 1) feedback.nacked++;
        }
      } else if (type === 206 && (format === 1 || format === 4)) {
        feedback.keyframes++;
      } else if (type === 206 && format === 15 && end <= message.length && message.toString('ascii', at + 12, at + 16) === 'REMB') {
        const exponent = message[at + 17] >> 2;
        const mantissa = ((message[at + 17] & 3) << 16) | message.readUInt16BE(at + 18);
        feedback.remb = mantissa * 2 ** exponent;
      }
      if (end <= at) break;
      at = end;
    }
  }
  function watchPace(now, frametime, restarted) {
    if (restarted || !pace.start) Object.assign(pace, { start: now, media: 0, last: now, reported: now });
    const gap = now - pace.last;
    pace.media += frametime;
    pace.frames++;
    pace.last = now;
    if (gap > PACE_GAP_MS) pace.gaps++;
    pace.maxGap = Math.max(pace.maxGap, gap);
    pace.maxBehind = Math.max(pace.maxBehind, now - pace.start - pace.media);
    if (now - pace.reported < PACE_REPORT_MS) return;
    const line = `Video pace: ${pace.frames} frames, ${pace.gaps} gaps over ${PACE_GAP_MS} ms, longest ${Math.round(pace.maxGap)} ms, behind by up to ${Math.round(pace.maxBehind)} ms; `
      + `${feedback.packets} RTCP packets in: Discord asked to resend ${feedback.nacked} packets, for ${feedback.keyframes} keyframes`
      + (feedback.remb ? `, estimates ${Math.round(feedback.remb / 1000)} kbit/s` : '');
    Object.assign(feedback, { packets: 0, nacked: 0, keyframes: 0, remb: null });
    (pace.gaps ? console.warn : console.log)(line);
    Object.assign(pace, { frames: 0, gaps: 0, maxGap: 0, maxBehind: 0, reported: now });
  }
  for (const track of tracks) {
    const send = conn[track.send].bind(conn);
    conn[track.send] = (frame, frametime) => {
      if (track.video && keyframesToSkip > 0) {
        if (isH264Keyframe(frame)) keyframesToSkip--;
        if (keyframesToSkip > 0) return undefined;
      }
      const now = performance.now();
      if (track.restarted && track.lastSent !== null) {
        const gapMs = now - track.lastSent - frametime;
        const { rtpConfig } = conn[track.packetizer];
        if (gapMs > 0) rtpConfig.timestamp += Math.round((gapMs * rtpConfig.clockRate) / 1000);
      }
      if (track.video) watchPace(now, frametime, track.restarted);
      track.restarted = false;
      track.lastSent = now;
      return send(frame, frametime);
    };
  }
  return conn;
}

/**
 * Each playStream gets its own view of the shared Go Live connection. After an
 * abort the old pipeline still flushes seconds of buffered frames; mixed with
 * the new session's frames they corrupted the picture, so they are dropped.
 */
function sessionView(conn, signal) {
  const view = Object.create(conn);
  for (const name of ['sendVideoFrame', 'sendAudioFrame']) {
    view[name] = (frame, frametime) => (signal.aborted ? undefined : conn[name](frame, frametime));
  }
  return view;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Owns the selfbot account: voice connection, Go Live stream and the ffmpeg
 * process feeding it. All state changes go through run() so button spam
 * cannot interleave two restarts.
 *
 * Events: 'ended' (item), 'failed' (item, message, positionSeconds),
 * 'stopped' ({ item, position, finished, startedAt, audio, subtitle }) whenever an item stops
 * playing for any reason, emitted before 'ended'/'failed'.
 */
export class Player extends EventEmitter {
  constructor() {
    super();
    this.streamer = new Streamer(new Client());
    this.guildId = null;
    this.channelId = null;
    this.item = null;
    this.itemStartedAt = null;
    this.source = null;
    this.audioIndex = null;
    this.subtitleIndex = null;
    this.subtitle = null;
    this.quality = DEFAULT_QUALITY;
    this.session = null;
    this.paused = false;
    this.pausedPosition = 0;
    this.liveConn = null;
    this.keepLive = false;
    this.idleTimer = null;
    this.queue = Promise.resolve();
    this.patchStreamer();
  }

  // Seeking restarts ffmpeg; keeping the Go Live session open means viewers
  // do not get kicked out of the stream view on every seek or pause.
  patchStreamer() {
    const create = this.streamer.createStream.bind(this.streamer);
    const stop = this.streamer.stopStream.bind(this.streamer);
    this.streamer.createStream = async () => {
      const signal = this.session?.ac.signal ?? AbortSignal.abort();
      this.liveConn ??= patchConnection(
        await create(),
        () => this.keepLive,
        () => (QUALITIES[this.quality] ?? QUALITIES[DEFAULT_QUALITY]).bitrate,
      );
      return sessionView(this.liveConn, signal);
    };
    this.streamer.stopStream = () => {
      if (this.keepLive) return;
      this.liveConn = null;
      stop();
    };
  }

  async login() {
    await raiseTimerResolution();
    await this.streamer.client.login(config.streamerToken);
    return this.streamer.client.user;
  }

  run(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  get active() {
    return this.item !== null;
  }

  get duration() {
    return this.item ? durationSeconds(this.item) : null;
  }

  position() {
    if (!this.item) return 0;
    if (this.paused || !this.session) return this.pausedPosition;
    const { startSeconds, startedAt } = this.session;
    return startedAt ? startSeconds + (Date.now() - startedAt) / 1000 : startSeconds;
  }

  get audioTrack() {
    if (!this.source) return null;
    const tracks = audioTracks(this.source);
    return tracks.find(t => t.Index === this.audioIndex) ?? tracks.find(t => t.IsDefault) ?? tracks[0] ?? null;
  }

  get subtitleTrack() {
    if (!this.source || this.subtitleIndex === null) return null;
    return subtitleTracks(this.source).find(t => t.Index === this.subtitleIndex) ?? null;
  }

  play({ item, channelId, startSeconds = 0, audioIndex = null, subtitleIndex = null }) {
    return this.run(async () => {
      const source = mediaSource(item);
      const subtitle = await this.prepareSubtitle(item, source, subtitleIndex);
      this.emitStopped(false);
      this.endSession({ keepLive: true });
      await this.ensureVoice(channelId);
      clearTimeout(this.idleTimer);
      Object.assign(this, { item, source, audioIndex, subtitleIndex, subtitle, itemStartedAt: Date.now() });
      this.startSession(this.clamp(startSeconds));
    });
  }

  pause() {
    return this.run(async () => {
      if (!this.item || this.paused) return;
      const position = this.position();
      this.endSession({ keepLive: true });
      this.paused = true;
      this.pausedPosition = position;
    });
  }

  resume() {
    return this.run(async () => {
      if (!this.item || !this.paused) return;
      this.startSession(this.pausedPosition);
    });
  }

  seek(seconds) {
    return this.run(async () => {
      if (!this.item) return;
      const target = this.clamp(seconds);
      if (this.paused) {
        this.pausedPosition = target;
        return;
      }
      this.endSession({ keepLive: true });
      this.startSession(target);
    });
  }

  setTracks({ audioIndex = this.audioIndex, subtitleIndex = this.subtitleIndex }) {
    return this.run(async () => {
      if (!this.item) return;
      const subtitle = subtitleIndex === this.subtitleIndex
        ? this.subtitle
        : await this.prepareSubtitle(this.item, this.source, subtitleIndex);
      const position = this.position();
      Object.assign(this, { audioIndex, subtitleIndex, subtitle });
      if (this.paused) return;
      this.endSession({ keepLive: true });
      this.startSession(position);
    });
  }

  /** quality: a key of QUALITIES. Restarts the stream where it is, like a track change. */
  setQuality(quality) {
    return this.run(async () => {
      this.quality = quality;
      if (!this.item || this.paused) return;
      const position = this.position();
      this.endSession({ keepLive: true });
      this.startSession(position);
    });
  }

  stop() {
    return this.run(async () => this.reset());
  }

  leave() {
    return this.run(async () => {
      this.reset();
      clearTimeout(this.idleTimer);
      this.streamer.leaveVoice();
      this.channelId = null;
    });
  }

  clamp(seconds) {
    const max = this.duration ? Math.max(0, this.duration - 5) : Infinity;
    return Math.min(Math.max(0, seconds), max);
  }

  async prepareSubtitle(item, source, subtitleIndex) {
    if (subtitleIndex === null) return null;
    const stream = subtitleTracks(source).find(t => t.Index === subtitleIndex);
    if (!stream) throw new UserError('Tyhle titulky ve filmu nejsou.');
    if (stream.IsTextSubtitleStream) {
      await mkdir('tmp', { recursive: true });
      await writeFile(SUBTITLE_FILE, await downloadSubtitle(item, source, stream));
      return { kind: 'text', file: SUBTITLE_FILE };
    }
    if (stream.IsExternal) throw new UserError('Externí obrázkové titulky zatím neumím.');
    return { kind: 'image', index: stream.Index };
  }

  async ensureVoice(channelId) {
    if (this.channelId === channelId && this.streamer.voiceConnection) return;
    if (this.streamer.voiceConnection) {
      this.streamer.stopStream();
      this.streamer.leaveVoice();
    }
    this.channelId = null;
    await withTimeout(
      this.streamer.joinVoice(this.guildId, channelId),
      JOIN_TIMEOUT_MS,
      'Nepodařilo se připojit do hovoru (vypršel čas).',
    );
    this.channelId = channelId;
  }

  startSession(startSeconds, { softwareFallback = false } = {}) {
    const video = this.source.MediaStreams.find(s => s.Type === 'Video');
    const args = buildFfmpegArgs({
      url: streamUrl(this.item, this.source),
      videoCodec: video?.Codec ?? null,
      hdr: hdrTransfer(video),
      startSeconds,
      audioIndex: this.audioTrack?.Index ?? null,
      subtitle: this.subtitle,
      softwareFallback,
      sourceFps: video?.RealFrameRate ?? video?.AverageFrameRate ?? null,
      quality: QUALITIES[this.quality] ?? QUALITIES[DEFAULT_QUALITY],
    });
    const ac = new AbortController();
    const ff = spawn(config.ffmpegPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const session = { ac, ff, startSeconds, startedAt: null, createdAt: Date.now() };
    this.session = session;
    this.paused = false;
    this.pausedPosition = startSeconds;

    let stderr = '';
    ff.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    ff.stdout.once('data', () => { session.startedAt = Date.now(); });
    const exited = new Promise(resolve => {
      ff.once('close', code => resolve(code));
      ff.once('error', error => { stderr += `\n${error.message}`; resolve(-1); });
    });
    ac.signal.addEventListener('abort', () => {
      ff.stdout.destroy();
      ff.kill();
    }, { once: true });

    const item = this.item;
    console.log(`Streaming ${itemLabel(item)} from ${Math.round(startSeconds)}s${softwareFallback ? ' (software encoder)' : ''}`);

    const settle = async error => {
      if (ac.signal.aborted || this.session !== session) return;
      const code = await withTimeout(exited, 5000, 'ffmpeg did not exit').catch(() => null);
      if (this.session !== session) return;
      if (!error && code === 0) {
        console.log(`Finished ${itemLabel(item)}`);
        this.run(async () => {
          if (this.session !== session) return;
          this.reset({ finished: true });
          this.emit('ended', item);
        });
        return;
      }
      const detail = (error?.message ?? '') + (stderr.trim() ? `\n${stderr.trim()}` : '');
      console.error(`Stream failed (ffmpeg exit ${code}): ${detail}`);
      const failedEarly = Date.now() - session.createdAt < HARDWARE_RETRY_WINDOW_MS;
      if (failedEarly && !softwareFallback && config.encoder !== 'libx264') {
        console.warn('Retrying with software encoder');
        this.run(async () => {
          if (this.session !== session) return;
          this.endSession({ keepLive: true });
          this.startSession(startSeconds, { softwareFallback: true });
        });
        return;
      }
      this.run(async () => {
        if (this.session !== session) return;
        const position = this.position();
        this.reset();
        this.emit('failed', item, stderr.trim().split('\n').pop() || error?.message || 'neznámá chyba', position);
      });
    };

    playStream(ff.stdout, this.streamer, { type: 'go-live' }, ac.signal)
      .then(() => settle(null), error => settle(error));
  }

  endSession({ keepLive }) {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.keepLive = keepLive;
    try {
      session.ac.abort();
    } finally {
      this.keepLive = false;
    }
  }

  emitStopped(finished) {
    if (!this.item) return;
    this.emit('stopped', {
      item: this.item,
      position: finished ? this.duration ?? this.position() : this.position(),
      finished,
      startedAt: this.itemStartedAt,
      audio: this.audioTrack,
      subtitle: this.subtitleTrack,
    });
  }

  reset({ finished = false } = {}) {
    this.emitStopped(finished);
    this.endSession({ keepLive: false });
    this.streamer.stopStream();
    Object.assign(this, {
      item: null, source: null, audioIndex: null, subtitleIndex: null, subtitle: null, paused: false, pausedPosition: 0,
    });
    this.scheduleIdleLeave();
  }

  scheduleIdleLeave() {
    clearTimeout(this.idleTimer);
    if (!this.channelId) return;
    this.idleTimer = setTimeout(() => {
      if (!this.item) this.leave().catch(error => console.error('Idle leave failed:', error));
    }, config.idleLeaveMinutes * 60_000);
  }
}

export class UserError extends Error {}
