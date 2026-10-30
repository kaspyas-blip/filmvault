import { config } from './config.js';

export const authHeader =
  `MediaBrowser Client="FilmVault", Device="MiniPC", DeviceId="filmvault-bot", Version="1.0.0", Token="${config.jellyfinApiKey}"`;

const ITEM_FIELDS = 'ProductionYear,Overview,MediaSources,MediaStreams,RunTimeTicks';

let userIdPromise;

async function request(path, params = {}, { raw = false, method = 'GET', body } = {}) {
  const url = new URL(config.jellyfinUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(raw ? 120_000 : 15_000),
  });
  if (!res.ok) throw new Error(`Jellyfin ${res.status} ${res.statusText} for ${path}`);
  if (raw) return res;
  return res.status === 204 || method !== 'GET' ? null : res.json();
}

// Library queries need a user context; the API key alone sees nothing on some versions.
// Resume positions and "played" marks are stored for this user too.
function getUserId() {
  userIdPromise ??= request('/Users').then(users => {
    const wanted = config.jellyfinUser?.toLowerCase();
    const named = wanted && users.find(u => u.Name.toLowerCase() === wanted);
    if (wanted && !named) console.warn(`Jellyfin user "${config.jellyfinUser}" not found, using the administrator`);
    const user = named || users.find(u => u.Policy?.IsAdministrator) || users[0];
    if (!user) throw new Error('Jellyfin has no users');
    return user.Id;
  }).catch(error => {
    userIdPromise = undefined;
    throw error;
  });
  return userIdPromise;
}

export async function searchItems(query, limit = 25) {
  const term = query.trim();
  const data = await request('/Items', {
    userId: await getUserId(),
    searchTerm: term || undefined,
    includeItemTypes: 'Movie,Episode',
    recursive: true,
    limit,
    fields: 'ProductionYear',
    sortBy: term ? undefined : 'DateCreated',
    sortOrder: term ? undefined : 'Descending',
  });
  return data.Items ?? [];
}

export const SORTS = {
  nazev: { label: 'podle názvu', sortBy: 'SortName', sortOrder: 'Ascending' },
  pridano: { label: 'naposledy přidané', sortBy: 'DateCreated,SortName', sortOrder: 'Descending,Ascending' },
  rok: { label: 'od nejnovějších', sortBy: 'ProductionYear,SortName', sortOrder: 'Descending,Ascending' },
  hodnoceni: { label: 'podle hodnocení', sortBy: 'CommunityRating,SortName', sortOrder: 'Descending,Ascending' },
};

function yearList(from, to) {
  if (!from) return undefined;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i).join(',');
}

// type: 'Movie' or 'Series'. Without limit returns everything (used for local filtering).
export async function listLibrary(type, startIndex, limit, { genreId, yearFrom, yearTo, sort = 'nazev', fields = 'ProductionYear' } = {}) {
  const { sortBy, sortOrder } = SORTS[sort] ?? SORTS.nazev;
  const data = await request('/Items', {
    userId: await getUserId(),
    includeItemTypes: type,
    recursive: true,
    sortBy,
    sortOrder,
    genreIds: genreId,
    years: yearList(yearFrom, yearTo ?? yearFrom),
    startIndex,
    limit,
    fields,
  });
  return { items: data.Items ?? [], total: data.TotalRecordCount ?? 0 };
}

export async function listGenres(type) {
  const data = await request('/Genres', { userId: await getUserId(), includeItemTypes: type, recursive: true, sortBy: 'SortName' });
  return data.Items ?? [];
}

/** Next episode across seasons, or null after the last one. */
export async function nextEpisode(episode) {
  if (!episode.SeriesId) return null;
  const all = await listEpisodes(episode.SeriesId);
  const index = all.findIndex(e => e.Id === episode.Id);
  return index >= 0 ? all[index + 1] ?? null : null;
}

/** Stores the resume position, or marks the item played (position 0). */
export async function saveProgress(itemId, { seconds = 0, played = false }) {
  await request(`/UserItems/${itemId}/UserData`, { userId: await getUserId() }, {
    method: 'POST',
    body: {
      PlaybackPositionTicks: played ? 0 : Math.round(seconds * 10_000_000),
      Played: played,
      LastPlayedDate: new Date().toISOString(),
    },
  });
}

/** Where to resume, or null when unwatched, finished, or barely started. */
export function resumeSeconds(item) {
  const seconds = (item.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000;
  const duration = durationSeconds(item);
  if (item.UserData?.Played || seconds < 60 || (duration && seconds > duration - 60)) return null;
  return Math.max(0, seconds - 5);
}

const CZECH = /^(ces|cze|cs|czech|čeština)$/i;

export function isCzech(stream) {
  return CZECH.test(stream.Language ?? '') || /česk|czech/i.test(stream.Title ?? '');
}

/**
 * Czech audio when the file has it (plus Czech forced subtitles if any); otherwise
 * the chosen/default audio with full Czech subtitles. Image subtitles in external
 * files are skipped because the player cannot burn them in.
 */
export function defaultTracks(source, audioIndex = null) {
  const audio = audioTracks(source);
  const subs = subtitleTracks(source);
  const chosen = audio.find(t => t.Index === audioIndex) ?? audio.find(isCzech) ?? audio.find(t => t.IsDefault) ?? audio[0];
  const czechSubs = subs.filter(t => isCzech(t) && (t.IsTextSubtitleStream || !t.IsExternal));
  const subtitle = chosen && isCzech(chosen)
    ? czechSubs.find(t => t.IsForced)
    : czechSubs.find(t => !t.IsForced && t.IsTextSubtitleStream)
      ?? czechSubs.find(t => !t.IsForced)
      ?? subs.find(t => t.IsForced && t.IsDefault);
  return { audioIndex: chosen?.Index ?? null, subtitleIndex: subtitle?.Index ?? null };
}

export async function listSeasons(seriesId) {
  const data = await request(`/Shows/${seriesId}/Seasons`, { userId: await getUserId(), fields: 'ChildCount' });
  return data.Items ?? [];
}

export async function listEpisodes(seriesId, seasonId) {
  const data = await request(`/Shows/${seriesId}/Episodes`, { userId: await getUserId(), seasonId });
  return data.Items ?? [];
}

export async function getItem(id) {
  const data = await request('/Items', { userId: await getUserId(), ids: id, fields: ITEM_FIELDS });
  const item = data.Items?.[0];
  if (!item) throw new Error(`Jellyfin item ${id} not found`);
  return item;
}

/** Type, genres and series of many items at once; IDs Jellyfin does not know are left out. */
export async function itemsMeta(ids) {
  const items = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await request('/Items', { userId: await getUserId(), ids: ids.slice(i, i + 100).join(','), fields: 'Genres' });
    items.push(...(data.Items ?? []));
  }
  return items;
}

export function itemLabel(item) {
  if (item.Type === 'Episode') {
    const season = String(item.ParentIndexNumber ?? 0).padStart(2, '0');
    const episode = String(item.IndexNumber ?? 0).padStart(2, '0');
    return `${item.SeriesName ?? 'Seriál'} S${season}E${episode} – ${item.Name}`;
  }
  return item.ProductionYear ? `${item.Name} (${item.ProductionYear})` : item.Name;
}

export function mediaSource(item) {
  const source = item.MediaSources?.[0];
  if (!source) throw new Error(`${itemLabel(item)} has no playable media`);
  return source;
}

export function audioTracks(source) {
  return source.MediaStreams.filter(s => s.Type === 'Audio');
}

export function subtitleTracks(source) {
  return source.MediaStreams.filter(s => s.Type === 'Subtitle');
}

export function trackLabel(stream) {
  const name = stream.DisplayTitle || stream.Title || stream.Language || `Stopa ${stream.Index}`;
  return stream.IsExternal ? `${name} (externí)` : name;
}

export function durationSeconds(item) {
  return item.RunTimeTicks ? item.RunTimeTicks / 10_000_000 : null;
}

export function streamUrl(item, source) {
  return `${config.jellyfinUrl}/Videos/${item.Id}/stream?static=true&mediaSourceId=${source.Id}`;
}

export async function downloadSubtitle(item, source, stream) {
  const res = await request(`/Videos/${item.Id}/${source.Id}/Subtitles/${stream.Index}/Stream.ass`, {}, { raw: true });
  return Buffer.from(await res.arrayBuffer());
}

export async function downloadPoster(item) {
  const id = item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id;
  try {
    const res = await request(`/Items/${id}/Images/Primary`, { maxHeight: 360, quality: 85 }, { raw: true });
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
