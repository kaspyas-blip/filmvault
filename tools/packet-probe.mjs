// Prints the first demuxed packets exactly as playStream sees them (pts, duration, frametime).
// Usage: node tools/packet-probe.mjs "search term" [startSeconds]
import { spawn } from 'node:child_process';
import { demux } from '@dank074/discord-video-stream';

const { config } = await import('../src/config.js');
const { buildFfmpegArgs } = await import('../src/ffmpeg.js');
const { searchItems, getItem, itemLabel, mediaSource, streamUrl } = await import('../src/jellyfin.js');

const [hit] = await searchItems(process.argv[2] ?? '', 1);
const item = await getItem(hit.Id);
const source = mediaSource(item);
const videoCodec = source.MediaStreams.find(s => s.Type === 'Video')?.Codec;
const args = buildFfmpegArgs({ url: streamUrl(item, source), videoCodec, startSeconds: Number(process.argv[3] ?? 0) });
console.log(`${itemLabel(item)} | encoder=${config.encoder}`);

const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
const { video, audio } = await demux(ff.stdout, { format: 'nut' });
console.log('video stream:', { codec: video.codec, width: video.width, height: video.height, fps: `${video.framerate_num}/${video.framerate_den}` });

function watch(name, stream, limit) {
  let n = 0;
  stream.on('data', p => {
    if (n++ < limit) {
      const ms = (Number(p.duration) / p.timeBase.den) * p.timeBase.num * 1000;
      console.log(`${name} pts=${p.pts} dur=${p.duration} tb=${p.timeBase.num}/${p.timeBase.den} frametime=${ms.toFixed(2)}ms size=${p.data?.length}`);
    }
    p.free?.();
  });
}
watch('V', video.stream, 8);
if (audio) watch('A', audio.stream, 4);
setTimeout(() => { ff.kill(); process.exit(0); }, 6000);
