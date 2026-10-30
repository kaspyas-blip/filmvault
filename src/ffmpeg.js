import { config } from './config.js';
import { authHeader } from './jellyfin.js';

const ENCODER_OPTIONS = {
  h264_qsv: { pixFmt: 'nv12', options: ['-preset', 'veryfast', '-look_ahead', '0', '-forced_idr', '1'] },
  h264_nvenc: { pixFmt: 'yuv420p', options: ['-preset', 'p4', '-forced-idr', '1'] },
  libx264: { pixFmt: 'yuv420p', options: ['-preset', 'superfast', '-tune', 'film', '-forced-idr', '1'] },
};

// Codecs the UHD 630 can decode; anything else (AV1) goes to the CPU.
const HW_DECODABLE = new Set(['h264', 'hevc', 'mpeg2video', 'vc1', 'vp9']);
// Font for the next-episode countdown (colon escaped for the filter graph); elsewhere fontconfig picks one.
const FONT = process.platform === 'win32' ? 'C\\:/Windows/Fonts/segoeuib.ttf' : null;
// Night sound: the centre channel (dialogue in 5.1 films) goes into the stereo mix at
// full level instead of -3 dB, and a compressor without look-ahead (no added delay)
// tames loud scenes, with the quiet ones raised. The limiter keeps peaks from clipping.
const NIGHT_SOUND = [
  '-center_mix_level', '1',
  '-af', 'acompressor=threshold=0.06:ratio=4:attack=15:release=400:makeup=2.5,alimiter=limit=0.9:level=false',
];
// NTSC rates as exact fractions, so frames are not dropped or repeated over time.
const EXACT_RATES = [[24000 / 1001, '24000/1001'], [30000 / 1001, '30000/1001']];

/**
 * Sends a film at its own frame rate: 24 fps films sent at 30 repeated every
 * fourth frame, and pans juddered. Faster sources (50/60 fps) are halved until
 * they fit under the configured maximum.
 * Returns { rate: ffmpeg fps value, fps: number }.
 */
export function outputRate(sourceFps) {
  let fps = sourceFps > 0 ? sourceFps : config.fps;
  while (fps > config.fps + 0.5) fps /= 2;
  if (fps < 10) fps = config.fps;
  const exact = EXACT_RATES.find(([value]) => Math.abs(value - fps) < 0.01);
  if (exact) return { rate: exact[1], fps: exact[0] };
  const rounded = Math.round(fps * 1000) / 1000;
  return { rate: String(rounded), fps: rounded };
}

// Jellyfin VideoRangeType -> input transfer for tone mapping. Pure Dolby Vision
// (profile 5) has no HDR10 base layer and cannot be mapped this way.
const HDR_TRANSFER = {
  HDR10: 'smpte2084', HDR10Plus: 'smpte2084', DOVIWithHDR10: 'smpte2084', DOVIWithHDR10Plus: 'smpte2084',
  HLG: 'arib-std-b67', DOVIWithHLG: 'arib-std-b67',
};

export function hdrTransfer(video) {
  return video ? HDR_TRANSFER[video.VideoRangeType] ?? null : null;
}

/**
 * Builds ffmpeg arguments that turn a Jellyfin stream into Discord friendly
 * H.264 + Opus in a NUT container on stdout.
 *
 * subtitle: null | { kind: 'text', file } (relative .ass path) | { kind: 'image', index }
 * hdr: input transfer ('smpte2084' / 'arib-std-b67') to tone map to SDR, or null
 * sourceFps: the film's frame rate (see outputRate)
 * quality: { height, bitrate } (see quality.js)
 * overlayFile: text file drawn in the corner, read again twice a second (empty = nothing), or null
 * sound: 'normal', or 'night' (dialogue louder, loud scenes compressed)
 */
export function buildFfmpegArgs({
  url, videoCodec = null, startSeconds = 0, audioIndex = null, subtitle = null, softwareFallback = false, hdr = null,
  sourceFps = null, quality = { height: config.height, bitrate: config.bitrate }, overlayFile = null, sound = 'normal',
}) {
  const encoderName = softwareFallback ? 'libx264' : config.encoder;
  const encoder = ENCODER_OPTIONS[encoderName] ?? ENCODER_OPTIONS.libx264;
  const start = Math.max(0, Math.floor(startSeconds));
  const { bitrate } = quality;
  const { rate, fps } = outputRate(sourceFps);

  const args = ['-hide_banner', '-loglevel', 'error', '-nostats'];
  const codec = videoCodec?.toLowerCase();
  if (codec === 'av1') args.push('-c:v', 'libdav1d');
  else if (config.hwDecode && !softwareFallback && (!codec || HW_DECODABLE.has(codec))) args.push('-hwaccel', config.hwDecode);
  args.push(
    '-headers', `Authorization: ${authHeader}\r\n`,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
  );
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', url);

  // Never upscale; keep width even for the encoder. HDR is tone mapped after
  // downscaling, where it is cheap enough for the CPU (it looks washed out otherwise).
  let scale = `scale=w=-2:h='min(${quality.height},ih)'`;
  if (hdr) {
    scale += `,zscale=tin=${hdr}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,`
      + 'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
  }
  let tail = `fps=${rate},format=${encoder.pixFmt}`;
  if (overlayFile) {
    // Bottom right, on top of everything, sized to the output height. Re-read every
    // half second; an empty file draws no box either.
    const size = Math.round(Math.min(quality.height, 720) / 26);
    tail = `drawtext=${FONT ? `fontfile='${FONT}':` : ''}textfile=${overlayFile}:reload=${Math.max(1, Math.round(fps / 2))}:expansion=normal`
      + `:fontsize=${size}:fontcolor=white:line_spacing=${Math.round(size / 4)}`
      + `:box=1:boxcolor=black@0.6:boxborderw=${Math.round(size / 2)}:x=w-tw-${size * 2}:y=h-th-${size * 2},${tail}`;
  }
  let graph;
  if (subtitle?.kind === 'image') {
    graph = `[0:v:0][0:${subtitle.index}]overlay=eof_action=pass,${scale},${tail}[v]`;
  } else if (subtitle?.kind === 'text') {
    // Input seeking resets timestamps to zero, so shift them back for libass.
    graph = `[0:v:0]${scale},setpts=PTS+${start}/TB,subtitles=filename=${subtitle.file},setpts=PTS-STARTPTS,${tail}[v]`;
  } else {
    graph = `[0:v:0]${scale},${tail}[v]`;
  }

  args.push(
    '-filter_complex', graph,
    '-map', '[v]',
    '-map', audioIndex === null ? '0:a:0?' : `0:${audioIndex}`,
    '-c:v', encoderName, ...encoder.options,
    '-b:v', `${bitrate}k`,
    '-maxrate:v', `${Math.round(bitrate * 1.4)}k`,
    '-bufsize:v', `${Math.round(bitrate / 2)}k`,
    '-bf', '0',
    '-g', String(Math.round(fps * 2)),
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
    ...(sound === 'night' ? NIGHT_SOUND : []),
    '-ac', '2', '-lfe_mix_level', '1', '-ar', '48000',
    '-c:a', 'libopus', '-b:a', `${config.audioBitrate}k`,
    '-f', 'nut', 'pipe:1',
  );
  return args;
}
