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

/** Newest first: { id, label, by, startedAt, endedAt, position, duration, finished, manual? } */
export async function history() {
  return load();
}

/** Stable identifier of one entry, used by the remove menu. */
export function entryKey(entry) {
  return `${entry.id}:${entry.startedAt}`;
}

/** Adds an entry by hand (watched outside the cinema), keeping the list newest first. */
export async function addWatch({ id, label, by, endedAt, position, duration, finished }) {
  const list = await load();
  const watched = finished ? duration ?? 0 : position;
  const entry = { id, label, by, startedAt: endedAt - Math.round(watched * 1000), endedAt, position: Math.round(position), duration, finished, manual: true };
  const index = list.findIndex(e => e.endedAt < endedAt);
  list.splice(index === -1 ? list.length : index, 0, entry);
  list.length = Math.min(list.length, MAX_ENTRIES);
  await save();
  return entry;
}

/** Removes the entry with this key; returns it, or null when it is already gone. */
export async function removeWatch(key) {
  const list = await load();
  const index = list.findIndex(e => entryKey(e) === key);
  if (index === -1) return null;
  const [removed] = list.splice(index, 1);
  await save();
  return removed;
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
