import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { Client } from '@lng2004/discord.js-selfbot-v13';
import { BaseMediaConnection, GatewayOpCodes, Streamer, playStream } from '@dank074/discord-video-stream';
import { config } from './config.js';
import { buildFfmpegArgs, hdrTransfer } from './ffmpeg.js';
import { t } from './i18n.js';
import { DEFAULT_QUALITY, QUALITIES } from './quality.js';
import { raiseTimerResolution } from './timer.js';
import {
  audioTracks, downloadSubtitle, durationSeconds, itemLabel, mediaSource, streamUrl, subtitleTracks,
} from './jellyfin.js';

// Jellyfin needs about a minute to extract a track from a big file, so each one is kept
// in tmp/ (restarts and recoveries reuse it); a track it could not extract is not tried
// again for a while.
const SUBTITLE_RETRY_MS = 30 * 60_000;
const subtitleFiles = new Map(); // "<item>-<index>" -> Promise of the file path
// Text drawn in the corner of the video. ffmpeg reads it again twice a second, so the
// countdown appears and goes without restarting the stream (an empty file draws nothing).
const OVERLAY_FILE = 'tmp/overlay.txt';
const COUNTDOWN_SECONDS = 30;
// With known end credits an episode is cut this long after they start; the countdown
// then shows for the 25 s before them and these 5 s.
const CREDITS_SHOWN_SECONDS = 5;
const CREDITS_TO_END_SECONDS = 20;
// Auto skip only when the intro has at least this much left.
const INTRO_SKIP_MIN_LEFT = 5;
const TICK_MS = 250;
// No frame from ffmpeg for this long while playing: the stream is restarted where it was.
const STALL_MS = 15_000;
// Restarts after a stall in a row before the stream counts as failed.
const STALL_RESTARTS = 3;
const JOIN_TIMEOUT_MS = 20_000;
const JOIN_RETRY_DELAY_MS = 3000;
const HARDWARE_RETRY_WINDOW_MS = 15_000;
// ffmpeg forces a keyframe every second; sending starts at the second one after a restart.
const RESTART_SKIP_KEYFRAMES = 2;
// Sound waits for the picture after a restart, but not longer than this.
const AUDIO_HOLD_MAX_MS = 3000;
// A web video played from its start holds the first frame this long. Viewers' picture takes
// a moment to catch on (see patchConnection), and unlike a film's logos, its first words count.
const WEB_LEAD_IN_SECONDS = 5;
// A stream that stops this close to the item's length counts as played to the end
// (the length Jellyfin reports and the file's real one differ by seconds).
const END_TOLERANCE_SECONDS = 60;
// Receivers may buffer up to this much (10 ms units) so resent packets arrive in time.
// Viewers' stats show Discord does not pass a minimum on (Minimum Playout Delay 0 ms).
const PLAYOUT_DELAY_MAX = 600;
// Logs how evenly video frames go out, once a minute; a gap is a frame this late.
const PACE_REPORT_MS = 60_000;
const PACE_GAP_MS = 150;
// Video goes out at most this many times the chosen bitrate. At 1.5x a keyframe took
// up to 0.3 s to leave; Discord then kept retiming the sound to the late video and it
// dropped out for a moment. At 4x a keyframe is out in well under 0.1 s.
const SEND_RATE_FACTOR = 4;

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
 * Pacing at a fixed rate from the chosen bitrate keeps the peak known. The loss turned
 * out not to depend on it (1.25x lost as much; pings past the router are lost too),
 * so the rate is set for keyframes to leave quickly (see SEND_RATE_FACTOR).
 * videoBitrate: () => kbit/s of the current quality.
 */
function patchConnection(conn, isRestarting, videoBitrate) {
  conn._bitrateCalculator = { addSample: () => (videoBitrate() * 1000 * SEND_RATE_FACTOR) / 1.25 };
  const setPacketizer = conn.setPacketizer.bind(conn);
  let codec = null;
  const tracks = [
    { send: 'sendVideoFrame', packetizer: '_videoPacketizer', lastSent: null, restarted: false, residual: 0, video: true },
    { send: 'sendAudioFrame', packetizer: '_audioPacketizer', lastSent: null, restarted: false, residual: 0 },
  ];
  let keyframesToSkip = 0;
  let restartedAt = 0;
  conn.setPacketizer = videoCodec => {
    for (const track of tracks) track.restarted = true;
    if (tracks[0].lastSent !== null) {
      keyframesToSkip = RESTART_SKIP_KEYFRAMES;
      restartedAt = performance.now();
    }
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
    // For /stav.
    conn.lastReport = { frames: pace.frames, gaps: pace.gaps, nacked: feedback.nacked, remb: feedback.remb, at: Date.now() };
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
      // While the picture waits for its keyframe, viewers still see the last frame from
      // before. With the next episode's sound under it, that looked like a stuck episode,
      // so the sound waits too (it loses about a second, usually a logo or silence).
      if (!track.video && keyframesToSkip > 0 && performance.now() - restartedAt < AUDIO_HOLD_MAX_MS) return undefined;
      const now = performance.now();
      if (track.restarted && track.lastSent !== null) {
        const gapMs = now - track.lastSent - frametime;
        const { rtpConfig } = conn[track.packetizer];
        if (gapMs > 0) rtpConfig.timestamp += Math.round((gapMs * rtpConfig.clockRate) / 1000);
      }
      if (track.video) watchPace(now, frametime, track.restarted);
      track.restarted = false;
      track.lastSent = now;
      const result = send(frame, frametime);
      // The library advances the RTP clock by the rounded frame time: 3754 instead of
      // 3753.75 ticks at 23.976 fps, so video ran 0.24 s an hour ahead of audio. The
      // stream stays open across episodes, and after a few the sound slipped for good.
      // The rounding error is carried and paid back.
      const { rtpConfig } = conn[track.packetizer];
      const exact = (frametime * rtpConfig.clockRate) / 1000;
      track.residual += exact - Math.round(exact);
      const whole = Math.trunc(track.residual);
      if (whole) {
        rtpConfig.timestamp += whole;
        track.residual -= whole;
      }
      return result;
    };
  }
  return conn;
}

/**
 * Each playStream gets its own view of the shared Go Live connection. After an
 * abort the old pipeline still flushes seconds of buffered frames; mixed with
 * the new session's frames they corrupted the picture, so they are dropped.
 */
function sessionView(conn, session) {
  const view = Object.create(conn);
  const { signal } = session.ac;
  view.sendAudioFrame = (frame, frametime) => (signal.aborted ? undefined : conn.sendAudioFrame(frame, frametime));
  view.sendVideoFrame = (frame, frametime) => {
    if (signal.aborted) return undefined;
    session.lastFrameAt = Date.now();
    session.mediaMs = (session.mediaMs ?? 0) + frametime;
    return conn.sendVideoFrame(frame, frametime);
  };
  return view;
}

/** Name of an incident Discord reports right now, or null (also when the page cannot be reached). */
async function discordIncident() {
  try {
    const res = await fetch('https://discordstatus.com/api/v2/incidents/unresolved.json', { signal: AbortSignal.timeout(5000) });
    const { incidents } = await res.json();
    return incidents?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

function subtitleFile(item, source, stream) {
  const key = `${item.Id}-${stream.Index}`;
  const file = `tmp/subtitles-${key}.ass`;
  if (!subtitleFiles.has(key)) {
    const job = (async () => {
      const existing = await stat(file).catch(() => null);
      if (existing?.size) return file;
      await mkdir('tmp', { recursive: true });
      await writeFile(`${file}.new`, await downloadSubtitle(item, source, stream));
      await rename(`${file}.new`, file);
      return file;
    })();
    subtitleFiles.set(key, job);
    job.catch(error => {
      console.warn(`Subtitle download of ${item.Name} track ${stream.Index} failed:`, error.message);
      setTimeout(() => subtitleFiles.delete(key), SUBTITLE_RETRY_MS).unref();
    });
  }
  return subtitleFiles.get(key).then(async done => {
    // Someone cleaned tmp/ meanwhile: ffmpeg would fail on the missing file.
    if (await stat(done).then(() => true, () => false)) return done;
    subtitleFiles.delete(key);
    return subtitleFile(item, source, stream);
  }, () => {
    throw new UserError(t('player.subtitlesFailed'));
  });
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
 * Events: 'ended' (item), 'failed' (item, message, positionSeconds), 'introSkipped' (item),
 * 'stopped' ({ item, position, finished, startedAt, audio, subtitle }) whenever an item stops
 * playing for any reason, emitted before 'ended'/'failed'.
 */
export class Player extends EventEmitter {
  /** streamer, startProcess, startStream: the outside world, replaced in tests. */
  constructor({ streamer = new Streamer(new Client()), startProcess = spawn, startStream = playStream } = {}) {
    super();
    this.streamer = streamer;
    this.startProcess = startProcess;
    this.startStream = startStream;
    // Raised by every play, stop and leave: a play still waiting for its subtitles
    // when a newer request comes in does nothing.
    this.request = 0;
    this.subtitleRequest = 0;
    this.softwareItemId = null; // the item whose hardware encoding failed
    this.subtitleFailed = false;
    this.guildId = null;
    this.channelId = null;
    this.item = null;
    this.itemStartedAt = null;
    this.source = null;
    this.audioIndex = null;
    this.subtitleIndex = null;
    this.subtitle = null;
    this.quality = DEFAULT_QUALITY;
    // 'normal', or 'night': quieter explosions, louder dialogue (see ffmpeg.js).
    this.sound = 'normal';
    // Label of the episode that follows, or null. Shown as a countdown at the end,
    // and keeps the Go Live stream open after the end so the next one follows on.
    this.countdown = null;
    // Detected intro and end credits of the item: { intro: [start, end] | null, credits: [start, end] | null }.
    this.segments = null;
    // Skip the intro by itself (the viewers chose so for this series).
    this.autoSkipIntro = false;
    this.introSkipped = false;
    this.overlayText = null;
    this.session = null;
    this.paused = false;
    this.pausedPosition = 0;
    this.liveConn = null;
    this.keepLive = false;
    this.idleTimer = null;
    this.queue = Promise.resolve();
    this.patchStreamer();
    this.streamer.client?.on?.('voiceStateUpdate', (_, state) => this.onOwnVoiceState(state));
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref();
  }

  /** Thrown out of the call (a moderator, a Discord hiccup): frames would go nowhere. */
  onOwnVoiceState(state) {
    if (state.id !== this.streamer.client.user?.id || state.channelId || !this.channelId || state.guild?.id !== this.guildId) return;
    console.warn('The streaming account was disconnected from the call');
    this.run(async () => {
      if (!this.channelId) return;
      const item = this.item;
      const position = this.position();
      this.reset();
      this.leaveVoice();
      this.channelId = null;
      if (item) this.emit('failed', item, t('player.disconnected'), position);
    }).catch(error => console.error('Handling the disconnect failed:', error));
  }

  // Seeking restarts ffmpeg; keeping the Go Live session open means viewers
  // do not get kicked out of the stream view on every seek or pause.
  patchStreamer() {
    const create = this.streamer.createStream.bind(this.streamer);
    const stop = this.streamer.stopStream.bind(this.streamer);
    this.streamer.createStream = async () => {
      const session = this.session ?? { ac: { signal: AbortSignal.abort() } };
      // A restart during the first, slow create shares it instead of opening a second stream.
      if (!this.liveConn && !this.liveCreating) {
        const creating = create().then(conn => {
          const patched = patchConnection(
            conn,
            () => this.holdingLive,
            () => (QUALITIES[this.quality] ?? QUALITIES[DEFAULT_QUALITY]).bitrate,
          );
          if (this.liveCreating === creating) this.liveConn = patched;
          return patched;
        }).finally(() => {
          if (this.liveCreating === creating) this.liveCreating = null;
        });
        this.liveCreating = creating;
      }
      return sessionView(this.liveCreating ? await this.liveCreating : this.liveConn, session);
    };
    this.streamer.stopStream = () => {
      if (this.holdingLive) return;
      this.liveConn = null;
      // The library's create never settles after a stop: the next stream starts its own.
      this.liveCreating = null;
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

  /** Go Live stays open across restarts and from an episode's end to the next one. */
  get holdingLive() {
    return this.keepLive || this.countdown !== null;
  }

  get duration() {
    return this.item ? durationSeconds(this.item) : null;
  }

  /**
   * Where the item stops: with a next episode and known end credits, shortly after
   * they start, so the next one follows sooner. Credits that end well before the
   * end have a scene after them (Marvel), so those episodes play to the end.
   */
  get endAt() {
    const { duration } = this;
    const credits = this.segments?.credits;
    if (!duration || !this.countdown || !credits) return duration;
    const [start, end] = credits;
    if (start > duration - CREDITS_SHOWN_SECONDS || end < duration - CREDITS_TO_END_SECONDS) return duration;
    return start + CREDITS_SHOWN_SECONDS;
  }

  position() {
    if (!this.item) return 0;
    if (this.paused || !this.session) return this.pausedPosition;
    // The film's own time of the frames sent: ffmpeg starts at the whole second, and
    // a hiccup in its output does not move the position on (the credits cut relies on it).
    const { startSeconds, mediaMs } = this.session;
    return Math.max(0, mediaMs ? Math.floor(startSeconds) + mediaMs / 1000 : startSeconds);
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

  /** countdown: label of the episode that follows (see this.countdown), or null. */
  /** autoSkipIntro: skip this item's intro by itself (see tick). */
  /** guildId, quality, sound: of the server it plays for (the account is on one call at a time). */
  async play({ item, guildId = this.guildId, channelId, quality = this.quality, sound = this.sound, startSeconds = 0, audioIndex = null, subtitleIndex = null, countdown = null, autoSkipIntro = false }) {
    const request = ++this.request;
    clearTimeout(this.idleTimer);
    // Outside the queue: the download can take a minute, and pause or stop must not wait for it.
    const source = mediaSource(item);
    let subtitle;
    let subtitleFailed = false;
    try {
      subtitle = await this.prepareSubtitle(item, source, subtitleIndex);
    } catch (error) {
      // Jellyfin cannot extract some tracks (an empty forced track): play without them.
      console.warn(`Subtitles of ${item.Name} failed, playing without them:`, error.message);
      subtitle = null;
      subtitleIndex = null;
      subtitleFailed = true;
    }
    return this.run(async () => {
      if (request !== this.request) return false;
      this.emitStopped(false);
      this.endSession({ keepLive: true });
      try {
        await this.ensureVoice(channelId, guildId);
      } catch (error) {
        // The previous item is stopped already; without this it stayed "playing" with no stream.
        this.item = null;
        this.reset();
        throw error;
      }
      clearTimeout(this.idleTimer);
      // Stopped or left while joining the call.
      if (request !== this.request) {
        this.item = null;
        this.reset();
        return false;
      }
      Object.assign(this, {
        item, source, audioIndex, subtitleIndex, subtitle, subtitleFailed, countdown, quality, sound, itemStartedAt: Date.now(), segments: null,
        introSkipped: false, autoSkipIntro, stallRestarts: 0,
      });
      try {
        this.startSession(this.clamp(startSeconds));
      } catch (error) {
        this.item = null;
        this.reset();
        throw error;
      }
      return true;
    });
  }

  /** Whatever waits to start (subtitles, joining the call) will not. */
  cancelPending() {
    this.request++;
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

  /** Only what is given changes; a slower older subtitle choice does not undo a newer one. */
  async setTracks({ audioIndex, subtitleIndex }) {
    const { item, source } = this;
    if (!item) return;
    const changes = audioIndex === undefined ? {} : { audioIndex };
    const subtitleRequest = subtitleIndex === undefined ? null : ++this.subtitleRequest;
    // Prepared outside the queue, like in play().
    const subtitle = subtitleRequest ? await this.prepareSubtitle(item, source, subtitleIndex) : null;
    await this.run(async () => {
      if (this.item !== item) return;
      if (subtitleRequest === this.subtitleRequest) Object.assign(changes, { subtitleIndex, subtitle, subtitleFailed: false });
      if (!Object.keys(changes).length) return;
      const position = this.position();
      Object.assign(this, changes);
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

  /** sound: 'normal' or 'night'. Restarts the stream where it is. */
  setSound(sound) {
    return this.run(async () => {
      this.sound = sound;
      if (!this.item || this.paused) return;
      const position = this.position();
      this.endSession({ keepLive: true });
      this.startSession(position);
    });
  }

  /** Drops (null) or sets the next episode's label; the overlay follows within a tick. */
  setCountdown(countdown) {
    return this.run(async () => {
      this.countdown = countdown;
      this.tick();
    });
  }

  /** Intro and credits found for this item (see segments.js), possibly after it started. */
  setSegments(item, segments) {
    if (this.item?.Id !== item.Id) return;
    this.segments = segments;
    this.tick();
  }

  /** Ends the Go Live stream kept open after an episode when no next one follows. */
  closeLive() {
    return this.run(async () => {
      this.countdown = null;
      if (!this.item) this.streamer.stopStream();
    });
  }

  stop() {
    this.cancelPending();
    return this.run(async () => this.reset());
  }

  leave() {
    this.cancelPending();
    return this.run(async () => this.leaveNow());
  }

  leaveNow() {
    this.reset();
    clearTimeout(this.idleTimer);
    this.leaveVoice();
    this.channelId = null;
  }

  /**
   * The library's leave sends guild_id null, which does not take the account out of a
   * server call it is left in from before (after a Discord outage it stayed there and
   * every join timed out); this one names the server.
   */
  leaveVoice() {
    this.streamer.stopStream();
    this.streamer.leaveVoice();
    this.streamer.sendOpcode(GatewayOpCodes.VOICE_STATE_UPDATE, {
      guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false, self_video: false,
    });
  }

  async joinVoice(channelId) {
    try {
      await withTimeout(this.streamer.joinVoice(this.guildId, channelId), JOIN_TIMEOUT_MS, 'join timed out');
    } catch (error) {
      // The pending connection stays registered and keeps its listeners otherwise.
      const status = this.streamer.voiceConnection?.status ?? {};
      this.leaveVoice();
      throw Object.assign(error, { status });
    }
  }

  async ensureVoice(channelId, guildId) {
    if (this.channelId === channelId && this.streamer.voiceConnection) return;
    // Leaves the old call under the server it is on, before moving to the new one.
    if (this.streamer.voiceConnection) {
      this.countdown = null;
      this.leaveVoice();
    }
    this.channelId = null;
    this.guildId = guildId;
    try {
      await this.joinVoice(channelId);
    } catch (error) {
      const { hasSession, hasToken, started } = error.status ?? {};
      console.warn(`Joining the call failed (session ${!!hasSession}, voice server ${!!hasToken}, connecting ${!!started}), leaving and trying again`);
      await new Promise(resolve => setTimeout(resolve, JOIN_RETRY_DELAY_MS));
      try {
        await this.joinVoice(channelId);
      } catch (retryError) {
        const s = retryError.status ?? {};
        console.error(`Joining the call failed again (session ${!!s.hasSession}, voice server ${!!s.hasToken}, connecting ${!!s.started})`);
        const incident = await discordIncident();
        throw new UserError(incident ? t('player.joinIncident', { incident }) : t('player.joinTimeout'));
      }
    }
    this.channelId = channelId;
  }

  clamp(seconds) {
    const max = this.duration ? Math.max(0, this.duration - 5) : Infinity;
    return Math.min(Math.max(0, seconds), max);
  }

  async prepareSubtitle(item, source, subtitleIndex) {
    if (subtitleIndex === null) return null;
    const stream = subtitleTracks(source).find(t => t.Index === subtitleIndex);
    if (!stream) throw new UserError(t('player.noSuchSubtitles'));
    if (stream.IsTextSubtitleStream) return { kind: 'text', file: await subtitleFile(item, source, stream) };
    if (stream.IsExternal) throw new UserError(t('player.imageSubtitles'));
    return { kind: 'image', index: stream.Index };
  }

  /**
   * The corner text: "next episode in N s" for the last COUNTDOWN_SECONDS before
   * endAt, else nothing. ffmpeg counts down by itself; its clock starts at 0 at the
   * whole second the session started from.
   */
  overlayFor(session, position) {
    const { endAt } = this;
    if (!this.countdown || !endAt || position < endAt - COUNTDOWN_SECONDS) return '';
    const left = endAt - Math.floor(session.startSeconds);
    const label = this.countdown.replace(/[%\\]/g, '');
    return `${t('player.nextEpisodeIn', { countdown: `%{eif:max(1,ceil(${left.toFixed(2)}-t)):d}` })}\n${label}`;
  }

  /** Replaces the overlay file in one step, so ffmpeg never reads half of it. */
  writeOverlay(text) {
    if (text === this.overlayText) return;
    try {
      mkdirSync('tmp', { recursive: true });
      writeFileSync(`${OVERLAY_FILE}.new`, text);
      renameSync(`${OVERLAY_FILE}.new`, OVERLAY_FILE);
      this.overlayText = text;
    } catch (error) {
      // ffmpeg may have the file open this instant on Windows; the next tick retries.
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') console.warn('Overlay write failed:', error.message);
    }
  }

  /**
   * Runs four times a second: draws or clears the countdown, ends an episode at its
   * credits, skips the intro when the viewers chose so, and restarts a stalled stream.
   */
  tick() {
    const { session } = this;
    if (!this.item || !session || this.paused) return;
    const position = this.position();
    this.writeOverlay(this.overlayFor(session, position));
    if (session.ending) return;
    // Nothing from ffmpeg for a while (also when it never started): start it again
    // where it was, and after a few tries in a row let the bot's recovery take over.
    const lastFrame = session.lastFrameAt ?? session.createdAt;
    if (Date.now() - lastFrame > STALL_MS) {
      session.ending = true;
      const item = this.item;
      this.stallRestarts = (this.stallRestarts ?? 0) + 1;
      console.warn(`No video from ffmpeg for ${Math.round((Date.now() - lastFrame) / 1000)} s, restarting at ${Math.round(position)}s`);
      this.run(async () => {
        if (this.session !== session) return;
        if (this.stallRestarts > STALL_RESTARTS) {
          this.reset();
          this.emit('failed', item, t('player.stalled'), position);
          return;
        }
        this.endSession({ keepLive: true });
        this.startSession(position);
      });
      return;
    }
    if (!session.mediaMs) return;
    if (session.mediaMs > STALL_MS) this.stallRestarts = 0;
    const { endAt, duration } = this;
    if (endAt && duration && endAt < duration && position >= endAt) {
      session.ending = true;
      const item = this.item;
      this.run(async () => {
        if (this.session !== session) return;
        console.log(`Finished ${itemLabel(item)} at the credits`);
        this.reset({ finished: true });
        this.emit('ended', item);
      });
      return;
    }
    const intro = this.segments?.intro;
    if (intro && this.autoSkipIntro && !this.introSkipped && position >= intro[0] && position < intro[1] - INTRO_SKIP_MIN_LEFT) {
      this.introSkipped = true;
      session.ending = true;
      const item = this.item;
      // Queued: by the time it runs another item may be playing, then it does nothing.
      this.run(async () => {
        if (this.session !== session) return;
        console.log(`Skipping the intro of ${itemLabel(item)} to ${Math.round(intro[1])}s`);
        this.endSession({ keepLive: true });
        this.startSession(intro[1]);
        this.emit('introSkipped', item);
      }).catch(error => console.error('Intro skip failed:', error));
    }
  }

  /** Whether the stream stopped at the item's real end, not just somewhere in it. */
  reachedEnd() {
    if (this.item?.web?.live) return false;
    const { duration } = this;
    return !duration || this.position() >= duration - END_TOLERANCE_SECONDS;
  }

  startSession(startSeconds, { softwareFallback = this.softwareItemId === this.item.Id } = {}) {
    const video = this.source.MediaStreams.find(s => s.Type === 'Video');
    // ffmpeg needs the file to exist. The old ffmpeg may still hold it for a moment;
    // then the old text stays and the next tick replaces it.
    this.overlayText = null;
    this.writeOverlay(this.overlayFor({ startSeconds }, startSeconds));
    if (this.overlayText === null) {
      try {
        writeFileSync(OVERLAY_FILE, '', { flag: 'a' });
      } catch {}
    }
    const { web } = this.item;
    const leadIn = web && !web.live && startSeconds === 0 ? WEB_LEAD_IN_SECONDS : 0;
    const args = buildFfmpegArgs({
      leadIn,
      url: web?.videoUrl ?? streamUrl(this.item, this.source),
      ...(web ? { audioUrl: web.audioUrl, headers: web.headers } : {}),
      videoCodec: video?.Codec ?? null,
      hdr: hdrTransfer(video),
      // A live stream always plays from now.
      startSeconds: web?.live ? 0 : startSeconds,
      audioIndex: this.audioTrack?.Index ?? null,
      subtitle: this.subtitle,
      softwareFallback,
      sourceFps: video?.RealFrameRate ?? video?.AverageFrameRate ?? null,
      quality: QUALITIES[this.quality] ?? QUALITIES[DEFAULT_QUALITY],
      overlayFile: OVERLAY_FILE,
      sound: this.sound,
    });
    const ac = new AbortController();
    const ff = this.startProcess(config.ffmpegPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // The held frame is not part of the video: its time starts when the frame moves on.
    const session = { ac, ff, startSeconds: startSeconds - leadIn, startedAt: null, createdAt: Date.now() };
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
      // ffmpeg exits with 0 also when its input breaks (Jellyfin restarted, a web address
      // expired, a live stream cut off). Finished means it really got to the end.
      const cleanExit = !error && code === 0;
      if (cleanExit && this.reachedEnd()) {
        console.log(`Finished ${itemLabel(item)}`);
        this.run(async () => {
          if (this.session !== session) return;
          this.reset({ finished: true });
          this.emit('ended', item);
        });
        return;
      }
      const detail = (error?.message ?? '') + (stderr.trim() ? `\n${stderr.trim()}` : '');
      console.error(`Stream failed (ffmpeg exit ${code}, at ${Math.round(this.position())}s): ${detail}`);
      const failedEarly = Date.now() - session.createdAt < HARDWARE_RETRY_WINDOW_MS;
      if (!cleanExit && failedEarly && !softwareFallback && config.encoder !== 'libx264') {
        console.warn('Retrying with software encoder');
        this.softwareItemId = item.Id;
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
        const message = cleanExit ? t('player.sourceCut') : stderr.trim().split('\n').pop() || error?.message || t('player.unknownError');
        this.emit('failed', item, message, position);
      });
    };

    this.startStream(ff.stdout, this.streamer, { type: 'go-live' }, ac.signal)
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

  /** After a finished episode with a next one (countdown set) the stream stays open. */
  reset({ finished = false } = {}) {
    if (!finished) this.countdown = null;
    this.emitStopped(finished);
    this.endSession({ keepLive: false });
    this.streamer.stopStream();
    Object.assign(this, {
      item: null, source: null, audioIndex: null, subtitleIndex: null, subtitle: null, paused: false, pausedPosition: 0, segments: null,
    });
    this.scheduleIdleLeave();
  }

  scheduleIdleLeave() {
    clearTimeout(this.idleTimer);
    if (!this.channelId) return;
    this.idleTimer = setTimeout(() => {
      // Checked in the queue: something may be starting ahead of this.
      this.run(async () => {
        if (!this.item) this.leaveNow();
      }).catch(error => console.error('Idle leave failed:', error));
    }, config.idleLeaveMinutes * 60_000);
  }
}

export class UserError extends Error {}
