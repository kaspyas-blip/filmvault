import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { config } from './config.js';

// One stream for everyone, so this is the whole cinema's setting. "Vysoká" is the
// .env setup; the others are for evenings when the line cannot carry it.
export const QUALITIES = {
  vysoka: { label: 'Vysoká', height: config.height, bitrate: config.bitrate },
  stredni: { label: 'Střední', height: Math.min(720, config.height), bitrate: Math.round(config.bitrate * 0.6) },
  nizka: { label: 'Nízká', height: Math.min(480, config.height), bitrate: Math.round(config.bitrate * 0.32) },
};
export const DEFAULT_QUALITY = 'vysoka';

export function qualityLabel(key) {
  const { label, height, bitrate } = QUALITIES[key] ?? QUALITIES[DEFAULT_QUALITY];
  return `${label} (${height}p, ${bitrate} kb/s)`;
}

/** The saved choice of a server's cinema (<dir>/quality.json). */
export function createQualityStore(dir) {
  const file = `${dir}/quality.json`;
  return {
    /** The saved choice, or the default when there is none. */
    async loadQuality() {
      try {
        const { quality } = JSON.parse(await readFile(file, 'utf8'));
        return QUALITIES[quality] ? quality : DEFAULT_QUALITY;
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('Could not read quality setting:', error.message);
        return DEFAULT_QUALITY;
      }
    },
    async saveQuality(quality) {
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify({ quality }));
      await rename(`${file}.tmp`, file);
    },
  };
}
