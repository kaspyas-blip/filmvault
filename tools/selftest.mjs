// Offline pipeline check: generates a test movie, serves it over HTTP like
// Jellyfin would, and runs the real ffmpeg arguments into the stream demuxer.
// Usage: node tools/selftest.mjs [text|none]
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

process.env.BOT_TOKEN ||= 'x';
process.env.STREAMER_TOKEN ||= 'x';
process.env.GUILD_ID ||= 'x';
process.env.JELLYFIN_API_KEY ||= 'x';
const { config } = await import('../src/config.js');
const { buildFfmpegArgs } = await import('../src/ffmpeg.js');
const { demux } = await import('@dank074/discord-video-stream');

const mode = process.argv[2] ?? 'text';
mkdirSync('tmp', { recursive: true });
const movie = 'tmp/selftest.mkv';
if (!existsSync(movie)) {
  writeFileSync('tmp/selftest.srt', '1\n00:00:01,000 --> 00:00:20,000\nŽluťoučký kůň úpěl ďábelské ódy\n');
  const gen = spawnSync(config.ffmpegPath, [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-i', 'tmp/selftest.srt', '-t', '20', '-map', '0', '-map', '1', '-map', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt', movie,
  ], { stdio: 'inherit' });
  if (gen.status !== 0) process.exit(1);
}
spawnSync(config.ffmpegPath, ['-y', '-loglevel', 'error', '-i', 'tmp/selftest.srt', 'tmp/subtitles.ass'], { stdio: 'inherit' });

const server = createServer((req, res) => {
  const size = statSync(movie).size;
  const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  res.writeHead(range ? 206 : 200, {
    'Content-Length': size - start, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska',
    ...(range ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}),
  });
  createReadStream(movie, { start }).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));

const subtitle = mode === 'text' ? { kind: 'text', file: 'tmp/subtitles.ass' } : null;
const args = buildFfmpegArgs({ url: `http://127.0.0.1:${server.address().port}/movie.mkv`, startSeconds: 3, subtitle });
console.log(`encoder=${config.encoder} subtitles=${mode}`);
const started = performance.now();
const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
ff.stderr.on('data', d => { stderr += d; });
const closed = new Promise(r => ff.once('close', r));
const { video, audio } = await demux(ff.stdout, { format: 'nut' }).catch(async error => {
  console.log(`demux failed: ${error.message}\nffmpeg exit=${await closed}\nargs: ${JSON.stringify(args)}\nstderr: ${stderr}`);
  process.exit(1);
});
console.log(`video codec=${video?.codec} ${video?.width}x${video?.height} audio=${audio ? 'yes' : 'no'}`);
let frames = 0;
let audioPackets = 0;
video.stream.on('data', () => { frames++; });
audio?.stream.on('data', () => { audioPackets++; });
const code = await closed;
await new Promise(r => setTimeout(r, 500));
const seconds = (performance.now() - started) / 1000;
console.log(`ffmpeg exit=${code} frames=${frames} audioPackets=${audioPackets} took=${seconds.toFixed(1)}s for 17s of video`);
if (stderr.trim()) console.log(`stderr: ${stderr.trim()}`);
server.close();
process.exit(code === 0 && frames > 0 ? 0 : 1);
