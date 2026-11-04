import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/**
 * Small choices a server's cinema remembers across restarts (<dir>/settings.json):
 * sound: 'normal' | 'night'
 * skipIntro: series IDs whose intros are skipped by themselves
 * summaryMonth: 'YYYY-MM' of the last monthly statistics post
 * resumeBackfilled: old messages have got their go-on buttons
 */
const DEFAULTS = { sound: 'normal', skipIntro: [], summaryMonth: null };

export function createSettings(dir) {
  const file = `${dir}/settings.json`;
  let settings = null;
  let writing = Promise.resolve();

  async function loadSettings() {
    if (settings) return settings;
    try {
      settings = { ...DEFAULTS, ...JSON.parse(await readFile(file, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read settings:', error.message);
      settings = { ...DEFAULTS };
    }
    return settings;
  }

  async function updateSettings(patch) {
    Object.assign(await loadSettings(), patch);
    const data = JSON.stringify(settings, null, 1);
    writing = writing.then(async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, data);
      await rename(`${file}.tmp`, file);
    }).catch(error => console.error('Could not save settings:', error.message));
    return writing;
  }

  return { loadSettings, updateSettings };
}

export const SOUND_MODES = {
  normal: 'Normální',
  night: 'Vyrovnaný (noční): hlasitější dialogy, tišší výbuchy',
};
