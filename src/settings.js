import { jsonFile } from './store.js';

/**
 * Small choices a server's cinema remembers across restarts (<dir>/settings.json):
 * sound: 'normal' | 'night'
 * skipIntro: series IDs whose intros are skipped by themselves
 * summaryMonth: 'YYYY-MM' of the last monthly statistics post
 * resumeBackfilled: old messages have got their go-on buttons
 */
const DEFAULTS = { sound: 'normal', skipIntro: [], summaryMonth: null };

export function createSettings(dir) {
  const file = jsonFile(`${dir}/settings.json`);
  let settings = null;

  async function loadSettings() {
    settings ??= { ...DEFAULTS, ...await file.read() };
    return settings;
  }

  async function updateSettings(patch) {
    Object.assign(await loadSettings(), patch);
    return file.write(settings);
  }

  return { loadSettings, updateSettings };
}

export const SOUND_MODES = {
  normal: 'Normální',
  night: 'Vyrovnaný (noční): hlasitější dialogy, tišší výbuchy',
};
