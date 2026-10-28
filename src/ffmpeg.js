import { config } from './config.js';
import { authHeader } from './jellyfin.js';

const ENCODER_OPTIONS = {
  h264_qsv: { pixFmt: 'nv12', options: ['-preset', 'veryfast', '-look_ahead', '0', '-forced_idr', '1'] },
  h264_nvenc: { pixFmt: 'yuv420p', options: ['-preset', 'p4', '-forced-idr', '1'] },
  libx264: { pixFmt: 'yuv420p', options: ['-preset', 'superfast', '-tune', 'film', '-forced-idr', '1'] },
};

// Codecs the UHD 630 can decode; anything else (AV1) goes to the CPU.
const HW_DECODABLE = new Set(['h264', 'hevc', 'mpeg2video', 'vc1', 'vp9']);

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
 */
export function buildFfmpegArgs({
  url, videoCodec = null, startSeconds = 0, audioIndex = null, subtitle = null, softwareFallback = false, hdr = null,
}) {
  const encoderName = softwareFallback ? 'libx264' : config.encoder;
  const encoder = ENCODER_OPTIONS[encoderName] ?? ENCODER_OPTIONS.libx264;
  const start = Math.max(0, Math.floor(startSeconds));
  const bitrate = config.bitrate;

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
  let scale = `scale=w=-2:h='min(${config.height},ih)'`;
  if (hdr) {
    scale += `,zscale=tin=${hdr}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,`
      + 'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
  }
  const tail = `fps=${config.fps},format=${encoder.pixFmt}`;
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
    '-g', String(config.fps * 2),
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-ac', '2', '-lfe_mix_level', '1', '-ar', '48000',
    '-c:a', 'libopus', '-b:a', `${config.audioBitrate}k`,
    '-f', 'nut', 'pipe:1',
  );
  return args;
}
