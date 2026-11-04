import { jsonFile } from './store.js';

// Statistics read the whole history, so it is kept long (a few hundred bytes each).
const MAX_ENTRIES = 5000;
const MIN_WATCH_MS = 2 * 60_000;
// Stopping and restarting the same title within this window updates one entry.
const MERGE_MS = 3 * 60 * 60_000;

/** Stable identifier of one entry, used by the remove menu. */
export function entryKey(entry) {
  return `${entry.id}:${entry.startedAt}`;
}

/** Adds up two { userId: { name, seconds } } maps. */
function mergeViewers(a = {}, b = {}) {
  const merged = structuredClone(a);
  for (const [id, { name, seconds }] of Object.entries(b)) {
    merged[id] = { name: name ?? merged[id]?.name, seconds: (merged[id]?.seconds ?? 0) + seconds };
  }
  return merged;
}

/** The watch history of a server's cinema (<dir>/history.json). */
export function createHistory(dir) {
  const file = jsonFile(`${dir}/history.json`);
  let entries = null;
  let loading = null;

  // Two callers at once must share one list, or the second overwrites the first's entry.
  function load() {
    if (entries) return Promise.resolve(entries);
    loading ??= file.read().then(saved => {
      entries = saved ?? [];
      return entries;
    }).finally(() => { loading = null; });
    return loading;
  }

  const save = () => file.write(entries);

  return {
    /** Newest first: { id, label, by, byId?, startedAt, endedAt, position, duration, finished, watched?, viewers?, manual? } */
    history: load,

    /** Adds an entry by hand (watched outside the cinema), keeping the list newest first. */
    async addWatch({ id, label, by, byId, endedAt, position, duration, finished }) {
      const list = await load();
      const watched = finished ? duration ?? 0 : position;
      const entry = {
        id, label, by, byId, startedAt: endedAt - Math.round(watched * 1000), endedAt, position: Math.round(position), duration, finished, manual: true,
      };
      const index = list.findIndex(e => e.endedAt < endedAt);
      list.splice(index === -1 ? list.length : index, 0, entry);
      list.length = Math.min(list.length, MAX_ENTRIES);
      await save();
      return entry;
    },

    /** Removes the entry with this key; returns it, or null when it is already gone. */
    async removeWatch(key) {
      const list = await load();
      const index = list.findIndex(e => entryKey(e) === key);
      if (index === -1) return null;
      const [removed] = list.splice(index, 1);
      await save();
      return removed;
    },

    /**
     * watched: seconds actually played (pauses not counted); viewers: { userId: { name, seconds } }
     * of the people in the voice room meanwhile; byId: Discord ID of who started it.
     */
    async recordWatch({ id, label, by, byId, startedAt, position, duration, finished, watched = 0, viewers = {} }) {
      if (!finished && Date.now() - startedAt < MIN_WATCH_MS) return;
      const list = await load();
      const entry = {
        id, label, by, byId, startedAt, endedAt: Date.now(), position: Math.round(position), duration, finished, watched: Math.round(watched), viewers,
      };
      const last = list[0];
      if (last?.id === id && !last.manual && entry.endedAt - last.endedAt < MERGE_MS) {
        list[0] = {
          ...entry, startedAt: last.startedAt, by: last.by, byId: last.byId ?? byId, finished: finished || last.finished,
          watched: (last.watched ?? 0) + entry.watched, viewers: mergeViewers(last.viewers, viewers),
        };
      } else {
        list.unshift(entry);
        list.length = Math.min(list.length, MAX_ENTRIES);
      }
      await save();
    },
  };
}
