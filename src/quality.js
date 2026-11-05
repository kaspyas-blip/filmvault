import { config } from './config.js';
import { tIn } from './i18n.js';
import { jsonFile } from './store.js';

// One stream for everyone, so this is the whole cinema's setting. "vysoka" (high) is the
// .env setup; the others are for evenings when the line cannot carry it.
export const QUALITIES = {
  vysoka: { height: config.height, bitrate: config.bitrate },
  stredni: { height: Math.min(720, config.height), bitrate: Math.round(config.bitrate * 0.6) },
  nizka: { height: Math.min(480, config.height), bitrate: Math.round(config.bitrate * 0.32) },
};
export const DEFAULT_QUALITY = 'vysoka';

// Web videos and live streams are mostly games: fast, full of small text, and already
// compressed once. On a 30 s sample from Kick at 720p, 1 s keyframes and a 0.5 s buffer spent
// most of the bits on keyframes. These settings left about a third of the error (SSIM 0.9725
// to 0.9904), with the largest keyframe still out in about 0.1 s at SEND_RATE_FACTOR.
// Films keep the settings of QUALITIES.
const WEB_BITRATE_FACTOR = 1.4;
const WEB_KEYFRAME_SECONDS = 2;
const WEB_BUFFER_SECONDS = 1;

/** What a stream is encoded with: key is a key of QUALITIES, web whether it is a video from the web. */
export function streamQuality(key, web = false) {
  const quality = QUALITIES[key] ?? QUALITIES[DEFAULT_QUALITY];
  if (!web) return quality;
  return {
    ...quality,
    bitrate: Math.round(quality.bitrate * WEB_BITRATE_FACTOR),
    keyframeSeconds: WEB_KEYFRAME_SECONDS,
    bufferSeconds: WEB_BUFFER_SECONDS,
  };
}

export function qualityLabel(key, language = config.language) {
  const { height, bitrate } = QUALITIES[key] ?? QUALITIES[DEFAULT_QUALITY];
  return `${tIn(language, `quality.${QUALITIES[key] ? key : DEFAULT_QUALITY}`)} (${height}p, ${bitrate} kb/s)`;
}

/** The saved choice of a server's cinema (<dir>/quality.json). */
export function createQualityStore(dir) {
  const file = jsonFile(`${dir}/quality.json`);
  return {
    /** The saved choice, or the default when there is none. */
    async loadQuality() {
      const quality = (await file.read())?.quality;
      return QUALITIES[quality] ? quality : DEFAULT_QUALITY;
    },
    saveQuality: quality => file.write({ quality }),
  };
}
