import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/**
 * Small choices the cinema remembers across restarts (data/settings.json):
 * sound: 'normal' | 'night'
 * skipIntro: series IDs whose intros are skipped by themselves
 * summaryMonth: 'YYYY-MM' of the last monthly statistics post
 */
const FILE = 'data/settings.json';
const DEFAULTS = { sound: 'normal', skipIntro: [], summaryMonth: null };

let settings = null;
let writing = Promise.resolve();

export async function loadSettings() {
  if (settings) return settings;
  try {
    settings = { ...DEFAULTS, ...JSON.parse(await readFile(FILE, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read settings:', error.message);
    settings = { ...DEFAULTS };
  }
  return settings;
}

export async function updateSettings(patch) {
  Object.assign(await loadSettings(), patch);
  const data = JSON.stringify(settings, null, 1);
  writing = writing.then(async () => {
    await mkdir('data', { recursive: true });
    await writeFile(`${FILE}.tmp`, data);
    await rename(`${FILE}.tmp`, FILE);
  }).catch(error => console.error('Could not save settings:', error.message));
  return writing;
}

export const SOUND_MODES = {
  normal: 'Normální',
  night: 'Vyrovnaný (noční): hlasitější dialogy, tišší výbuchy',
};
