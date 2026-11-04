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
