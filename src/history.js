import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const FILE = 'data/history.json';
const MAX_ENTRIES = 300;
const MIN_WATCH_MS = 2 * 60_000;
// Stopping and restarting the same title within this window updates one entry.
const MERGE_MS = 3 * 60 * 60_000;

let entries = null;
let writing = Promise.resolve();

async function load() {
  if (entries) return entries;
  try {
    entries = JSON.parse(await readFile(FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read watch history:', error.message);
    entries = [];
  }
  return entries;
}

function save() {
  const data = JSON.stringify(entries, null, 1);
  writing = writing.then(async () => {
    await mkdir('data', { recursive: true });
    await writeFile(`${FILE}.tmp`, data);
    await rename(`${FILE}.tmp`, FILE);
  }).catch(error => console.error('Could not save watch history:', error.message));
  return writing;
}

/** Newest first: { id, label, by, startedAt, endedAt, position, duration, finished } */
export async function history() {
  return load();
}

export async function recordWatch({ id, label, by, startedAt, position, duration, finished }) {
  if (!finished && Date.now() - startedAt < MIN_WATCH_MS) return;
  const list = await load();
  const entry = { id, label, by, startedAt, endedAt: Date.now(), position: Math.round(position), duration, finished };
  const last = list[0];
  if (last?.id === id && entry.endedAt - last.endedAt < MERGE_MS) {
    list[0] = { ...entry, startedAt: last.startedAt, by: last.by, finished: finished || last.finished };
  } else {
    list.unshift(entry);
    list.length = Math.min(list.length, MAX_ENTRIES);
  }
  await save();
}
