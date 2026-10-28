// Runs the real ffmpeg pipeline on a Jellyfin item for 30 s and reports encoding speed.
// Usage: node tools/stream-bench.mjs "search term" [subtitleIndex]
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const { config } = await import('../src/config.js');
const { buildFfmpegArgs } = await import('../src/ffmpeg.js');
const { searchItems, getItem, itemLabel, mediaSource, streamUrl, subtitleTracks, downloadSubtitle } = await import('../src/jellyfin.js');

const [hit] = await searchItems(process.argv[2] ?? '', 1);
const item = await getItem(hit.Id);
const source = mediaSource(item);
let subtitle = null;
if (process.argv[3]) {
  const stream = subtitleTracks(source).find(t => t.Index === Number(process.argv[3]));
  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/bench.ass', await downloadSubtitle(item, source, stream));
  subtitle = { kind: 'text', file: 'tmp/bench.ass' };
}
const videoCodec = source.MediaStreams.find(s => s.Type === 'Video')?.Codec;
const args = buildFfmpegArgs({ url: streamUrl(item, source), videoCodec, startSeconds: 600, subtitle });
args.splice(args.indexOf('-f'), 0, '-progress', 'pipe:2');
console.log(`${itemLabel(item)} | decode=${config.hwDecode ?? 'cpu'} encoder=${config.encoder} subtitles=${!!subtitle}`);

const started = Date.now();
const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
ff.stdout.resume();
let frames = 0;
let firstFrameAt = null;
let errors = '';
ff.stderr.on('data', chunk => {
  for (const line of String(chunk).split('\n')) {
    const m = /^frame=(\d+)/.exec(line);
    if (m) { frames = Number(m[1]); if (frames > 0) firstFrameAt ??= Date.now(); }
    else if (!/^\w+=/.test(line) && line.trim()) errors += line + '\n';
  }
});
await new Promise(r => setTimeout(r, 30_000));
ff.kill();
const runSeconds = (Date.now() - (firstFrameAt ?? started)) / 1000;
console.log(`startup ${((firstFrameAt ?? Date.now()) - started) / 1000}s, ${frames} frames in ${runSeconds.toFixed(1)}s => ${(frames / config.fps / runSeconds).toFixed(2)}x realtime`);
if (errors.trim()) console.log(`stderr: ${errors.trim().slice(0, 800)}`);
