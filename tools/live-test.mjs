// Streams a Jellyfin item into the voice channel for N seconds and prints how many
// bytes the machine actually sends each 5 s. Stop the bot task first (same account).
// Usage: node tools/live-test.mjs "search term" [seconds] [startSeconds]
import { execFileSync } from 'node:child_process';

const { config } = await import('../src/config.js');
const { Player } = await import('../src/player.js');
const { searchItems, getItem } = await import('../src/jellyfin.js');

const seconds = Number(process.argv[3] ?? 40);
const startSeconds = Number(process.argv[4] ?? 600);

function bytesSent() {
  const out = execFileSync('netstat', ['-e'], { encoding: 'utf8' });
  const line = out.split('\n').find(l => /^\s*Bytes/.test(l));
  return Number(line.trim().split(/\s+/).pop());
}

if (process.env.DC_LOG) {
  // Summarise libdatachannel log lines (numbers stripped) instead of printing thousands.
  const { initLogger } = await import('@lng2004/node-datachannel');
  const counts = new Map();
  let datagramBytes = 0;
  const started = Date.now();
  initLogger(process.env.DC_LOG, (level, message) => {
    const sent = /Sending datagram, size=(\d+)/.exec(message);
    if (sent) datagramBytes += Number(sent[1]);
    const key = `${level} ${message.replace(/\d+/g, 'N').slice(0, 140)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  process.on('exit', () => {
    console.log(`libdatachannel datagrams: ${(datagramBytes * 8 / 1e6).toFixed(1)} Mbit in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(n).padStart(7)} ${key}`);
  });
}

process.on('unhandledRejection',error => console.log('UNHANDLED', error?.message ?? error));
setTimeout(() => { console.log('hard timeout'); process.exit(1); }, (seconds + 40) * 1000).unref();

const player = new Player();
await player.login();
const client = player.streamer.client;
const channel = client.channels.cache.find(c => c.isVoice?.() && c.name === config.voiceChannel);
if (!channel) throw new Error(`voice channel ${config.voiceChannel} not found`);
player.guildId = channel.guild.id;

const [hit] = await searchItems(process.argv[2] ?? '', 1);
const item = await getItem(hit.Id);
console.log(`encoder=${config.encoder} bitrate=${config.bitrate}k, streaming ${item.Name} into ${channel.name}`);
player.on('failed', (_item, message) => console.log('FAILED', message));
const before = bytesSent();
await new Promise(r => setTimeout(r, 5000));
console.log(`baseline before streaming: ${((bytesSent() - before) * 8 / 5 / 1e6).toFixed(2)} Mbps sent`);
await player.play({ item, channelId: channel.id, startSeconds });

let payload = 0;
let seekAt = null;
let seekRequested = false;
const firstAfterSeek = {};
while (!player.liveConn) await new Promise(r => setTimeout(r, 50));
const conn0 = player.liveConn;
// Native tracks are frozen; the wrapper only calls sendMessageBinary after setup.
for (const key of ['_videoTrack', '_audioTrack']) {
  const track = conn0[key];
  conn0[key] = {
    sendMessageBinary: buffer => {
      payload += buffer.length;
      return track.sendMessageBinary(buffer);
    },
  };
}
// Video stalls: gaps between consecutive video frames (normal is ~33 ms at 30 fps).
let lastVideoAt = null;
let stalls = [];
const videoTrack = conn0._videoTrack;
conn0._videoTrack = {
  sendMessageBinary: buffer => {
    const now = Date.now();
    if (lastVideoAt && now - lastVideoAt > 150) stalls.push(now - lastVideoAt);
    lastVideoAt = now;
    return videoTrack.sendMessageBinary(buffer);
  },
};
// The new session calls setPacketizer once its ffmpeg output is demuxed; frames after that are new.
let lastOldFrame = null;
let newSessionAt = null;
const setPacketizer = conn0.setPacketizer;
conn0.setPacketizer = codec => {
  if (seekRequested) newSessionAt ??= Date.now();
  return setPacketizer(codec);
};
for (const key of ['_videoTrack', '_audioTrack']) {
  const counted = conn0[key];
  conn0[key] = {
    sendMessageBinary: buffer => {
      if (seekRequested && !newSessionAt) lastOldFrame = Date.now();
      if (newSessionAt) firstAfterSeek[key] ??= Date.now() - newSessionAt;
      return counted.sendMessageBinary(buffer);
    },
  };
}
// Count gateway opcodes the player lets through during the seek (the "off" ones should be swallowed).
const attributeCalls = [];
const ws = conn0.mediaConnection;
const sendOpcode = ws.sendOpcode.bind(ws);
ws.sendOpcode = (code, data) => {
  if (seekRequested && data?.speaking !== undefined) attributeCalls.push(`speaking=${data.speaking}`);
  if (seekRequested && data?.video_ssrc !== undefined) attributeCalls.push(`video=${data.video_ssrc ? 'on' : 'off'}`);
  return sendOpcode(code, data);
};

let last = bytesSent();
for (let t = 5; t <= seconds; t += 5) {
  await new Promise(r => setTimeout(r, 5000));
  const now = bytesSent();
  const conn = player.liveConn;
  const media = conn
    ? `video rtp ${(conn._videoPacketizer.rtpConfig.timestamp / 90000).toFixed(1)}s, audio rtp ${(conn._audioPacketizer.rtpConfig.timestamp / 48000).toFixed(1)}s`
    : 'no conn';
  console.log(`${t}s: ${((now - last) * 8 / 5 / 1e6).toFixed(2)} Mbps sent (payload ${(payload * 8 / 5 / 1e6).toFixed(2)}), position ${player.position().toFixed(0)}s, ${media}`
    + (stalls.length ? `, video stalls ${stalls.join('/')} ms` : ''));
  last = now;
  payload = 0;
  stalls = [];
  if (t === 20) {
    console.log('seeking +60 s');
    seekRequested = true;
    await player.seek(player.position() + 60);
    // Old session is aborted once seek() resolves; count only the new one's packets.
    seekAt = Date.now();
  }
}
if (seekAt) {
  console.log(`after seek: old frames until ${lastOldFrame ? lastOldFrame - seekAt : '-'} ms, new session started ${newSessionAt - seekAt} ms after seek() returned`);
  console.log(`new session: first audio ${firstAfterSeek._audioTrack} ms, first video ${firstAfterSeek._videoTrack} ms (video should lag audio by ~1 s)`);
  console.log(`after seek: attribute calls ${attributeCalls.join(', ') || 'none'}`);
}
await player.leave();
await client.destroy();
process.exit(0);
