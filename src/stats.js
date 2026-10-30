import { EmbedBuilder } from 'discord.js';
import { itemsMeta } from './jellyfin.js';

const ZONE = 'Europe/Prague';
const ITEM_ID = /^[0-9a-f]{32}$/i;
// Titles played less than this far apart count as one sitting (a marathon).
const SITTING_GAP_MS = 30 * 60_000;
// A night out ends at 6 in the morning: what ends at 1:30 belongs to the evening before.
const DAY_STARTS_HOUR = 6;
const META_CACHE_MS = 60 * 60_000;
const MEDALS = ['🥇', '🥈', '🥉', '4.', '5.'];
const WEEKDAYS = ['v neděli', 'v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu'];
// Restarts and recoveries start titles in the bot's own name; they are nobody's.
const BOT_NAME = /^FilmVault\b|^restart$/i;

/** Czech count: plural(2, 'film', 'filmy', 'filmů') = "2 filmy". */
export function plural(n, one, few, many) {
  return `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
}
// Viewers in the voice room are counted from this release on.
export const VIEWERS_SINCE = Date.UTC(2026, 9, 30);

export const PERIODS = {
  mesic: { label: 'tento měsíc' },
  minuly: { label: 'minulý měsíc' },
  rok: { label: 'letos' },
  vse: { label: 'celkově' },
};

let metaCache = { at: 0, byId: new Map() };

function pragueParts(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

/** Start of a Prague month as a timestamp (month 1-12, may overflow into the next year). */
function monthStart(year, month) {
  const guess = Date.UTC(year, month - 1, 1);
  // Prague is UTC+1 or +2; step back until the local date is the 1st at 00:00.
  for (const offset of [1, 2]) {
    const ms = guess - offset * 3600_000;
    const p = pragueParts(ms);
    if (p.day === 1 && p.hour === 0) return ms;
  }
  return guess;
}

/** [from, to) of a period key, `now` given for the monthly summary. */
export function periodRange(key, now = Date.now()) {
  const { year, month } = pragueParts(now);
  if (key === 'mesic') return [monthStart(year, month), Infinity];
  if (key === 'minuly') return [monthStart(year, month - 1), monthStart(year, month)];
  if (key === 'rok') return [monthStart(year, 1), Infinity];
  return [0, Infinity];
}

function eveningOf(ms) {
  const p = pragueParts(ms - DAY_STARTS_HOUR * 3600_000);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Seconds actually played: measured since viewers are tracked, estimated before. */
function playedSeconds(entry) {
  if (entry.watched) return entry.watched;
  const span = Math.max(0, (entry.endedAt - entry.startedAt) / 1000);
  const shown = entry.finished ? entry.duration ?? span : entry.position ?? span;
  return Math.min(span || shown, shown || span);
}

export function formatHours(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function top(map, count = 5) {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, count);
}

function ranking(rows, format) {
  if (!rows.length) return '—';
  return rows.map(([key, value], i) => `${MEDALS[i]} ${key} · ${format(value)}`).join('\n');
}

async function metaFor(ids) {
  if (Date.now() - metaCache.at > META_CACHE_MS) metaCache = { at: Date.now(), byId: new Map() };
  const missing = [...new Set(ids)].filter(id => ITEM_ID.test(id) && !metaCache.byId.has(id));
  if (missing.length) {
    const items = await itemsMeta(missing).catch(error => {
      console.warn('Statistics: Jellyfin lookup failed:', error.message);
      return null;
    });
    // Jellyfin down: no genres this time, asked again next time.
    if (!items) return metaCache.byId;
    for (const item of items) metaCache.byId.set(item.Id, item);
    // Episodes take their genres from the series.
    const series = [...new Set(items.filter(i => i.Type === 'Episode' && i.SeriesId).map(i => i.SeriesId))]
      .filter(id => !metaCache.byId.has(id));
    if (series.length) for (const item of await itemsMeta(series).catch(() => [])) metaCache.byId.set(item.Id, item);
    for (const id of missing) if (!metaCache.byId.has(id)) metaCache.byId.set(id, null);
  }
  return metaCache.byId;
}

/**
 * Everything the statistics show, for entries ending in [from, to).
 * entries: watch history; wishes: { open, done } from the wishlist.
 * Person keys are Discord IDs where known, else names (older history).
 */
export async function computeStats({ entries, wishes, from = 0, to = Infinity }) {
  const inPeriod = entries.filter(e => e.endedAt >= from && e.endedAt < to);
  const meta = await metaFor(inPeriod.map(e => e.id));
  // Older entries know only a name; it is matched to an ID seen with that name anywhere.
  const names = new Map();
  const idByName = new Map();
  const remember = (id, name) => {
    if (!id || !name) return;
    names.set(id, name);
    idByName.set(name.toLowerCase(), id);
  };
  for (const entry of entries) {
    remember(entry.byId, entry.by);
    for (const [id, viewer] of Object.entries(entry.viewers ?? {})) remember(id, viewer.name);
  }
  for (const film of [...(wishes?.open ?? []), ...(wishes?.done ?? [])]) remember(film.addedById, film.addedBy);
  const nameOf = key => names.get(key) ?? key;
  const personKey = (id, name) => id || idByName.get(name?.toLowerCase()) || name || '?';

  const stats = {
    seconds: 0, films: 0, episodes: 0, evenings: new Set(), titles: inPeriod.length,
    viewers: new Map(), viewerTitles: new Map(), starters: new Map(), adders: new Map(), fulfilled: new Map(),
    series: new Map(), genres: new Map(), weekdays: new Array(7).fill(0), replays: new Map(),
    marathon: null, latest: null, perPerson: new Map(),
  };
  const person = key => {
    if (!stats.perPerson.has(key)) {
      stats.perPerson.set(key, {
        seconds: 0, started: 0, added: 0, fulfilled: 0, episodes: 0, films: 0, nightOwl: false, maxSitting: 0,
        genres: new Map(), series: new Map(), first: null,
      });
    }
    return stats.perPerson.get(key);
  };

  for (const entry of inPeriod) {
    const seconds = playedSeconds(entry);
    const item = meta.get(entry.id);
    const isEpisode = item?.Type === 'Episode' || /S\d{2}E\d{2}/.test(entry.label);
    const genres = (isEpisode ? meta.get(item?.SeriesId)?.Genres : item?.Genres) ?? [];
    if (!entry.manual) {
      stats.seconds += seconds;
      stats.evenings.add(eveningOf(entry.startedAt));
      stats.weekdays[pragueParts(entry.startedAt - DAY_STARTS_HOUR * 3600_000).weekday]++;
    }
    if (entry.finished) isEpisode ? stats.episodes++ : stats.films++;
    const seriesName = isEpisode ? item?.SeriesName ?? entry.label.replace(/\s+S\d{2}E\d{2}.*$/, '') : null;
    if (seriesName) stats.series.set(seriesName, (stats.series.get(seriesName) ?? 0) + 1);
    if (!entry.manual) for (const genre of genres) stats.genres.set(genre, (stats.genres.get(genre) ?? 0) + seconds);
    stats.replays.set(entry.label, (stats.replays.get(entry.label) ?? new Set()).add(eveningOf(entry.startedAt)));

    if (!BOT_NAME.test(entry.by ?? '') || entry.byId) {
      const starter = personKey(entry.byId, entry.by);
      stats.starters.set(starter, (stats.starters.get(starter) ?? 0) + 1);
      person(starter).started++;
    }

    const end = pragueParts(entry.endedAt);
    if (!entry.manual && end.hour >= 0 && end.hour < DAY_STARTS_HOUR) {
      const lateness = end.hour * 60 + end.minute;
      if (!stats.latest || lateness > stats.latest.lateness) stats.latest = { lateness, entry, time: `${end.hour}:${String(end.minute).padStart(2, '0')}` };
    }
    for (const [id, viewer] of Object.entries(entry.viewers ?? {})) {
      const key = personKey(id, viewer.name);
      stats.viewers.set(key, (stats.viewers.get(key) ?? 0) + viewer.seconds);
      stats.viewerTitles.set(key, (stats.viewerTitles.get(key) ?? 0) + 1);
      const p = person(key);
      p.seconds += viewer.seconds;
      if (entry.finished) isEpisode ? p.episodes++ : p.films++;
      if (end.hour >= 2 && end.hour < DAY_STARTS_HOUR) p.nightOwl = true;
      for (const genre of genres) p.genres.set(genre, (p.genres.get(genre) ?? 0) + viewer.seconds);
      if (seriesName) p.series.set(seriesName, (p.series.get(seriesName) ?? 0) + 1);
      p.first = Math.min(p.first ?? Infinity, entry.startedAt);
    }
  }

  // Sittings: titles back to back. The longest is the marathon record.
  const played = inPeriod.filter(e => !e.manual).sort((a, b) => a.startedAt - b.startedAt);
  let sitting = null;
  const closeSitting = () => {
    if (!sitting) return;
    if (!stats.marathon || sitting.seconds > stats.marathon.seconds) stats.marathon = sitting;
    for (const key of sitting.people) {
      const p = person(key);
      p.maxSitting = Math.max(p.maxSitting, sitting.count);
    }
  };
  for (const entry of played) {
    if (!sitting || entry.startedAt - sitting.endedAt > SITTING_GAP_MS) {
      closeSitting();
      sitting = { startedAt: entry.startedAt, endedAt: entry.endedAt, seconds: 0, count: 0, people: new Set() };
    }
    sitting.seconds += playedSeconds(entry);
    sitting.count++;
    sitting.endedAt = Math.max(sitting.endedAt, entry.endedAt);
    for (const id of Object.keys(entry.viewers ?? {})) sitting.people.add(id);
  }
  closeSitting();

  const allWishes = [...(wishes?.open ?? []), ...(wishes?.done ?? [])];
  for (const film of allWishes.filter(f => (f.addedAt ?? 0) >= from && (f.addedAt ?? 0) < to)) {
    const key = personKey(film.addedById, film.addedBy);
    stats.adders.set(key, (stats.adders.get(key) ?? 0) + 1);
    person(key).added++;
  }
  for (const film of (wishes?.done ?? []).filter(f => f.seenAt >= from && f.seenAt < to)) {
    const key = personKey(film.addedById, film.addedBy);
    stats.fulfilled.set(key, (stats.fulfilled.get(key) ?? 0) + 1);
    person(key).fulfilled++;
  }

  return { ...stats, nameOf, wishesOpen: wishes?.open?.length ?? 0 };
}

function named(stats, rows) {
  return rows.map(([key, value]) => [stats.nameOf(key), value]);
}

/** Badges a person has earned in the period. */
function badges(p, rank) {
  const list = [];
  if (rank === 0 && p.seconds > 0) list.push('👑 Král(ovna) kina');
  if (p.seconds >= 50 * 3600) list.push('🎞️ Filmový maniak (50 h)');
  else if (p.seconds >= 10 * 3600) list.push('🍿 Štamgast (10 h)');
  if (p.maxSitting >= 4) list.push(`🏃 Maratonec (${p.maxSitting} v kuse)`);
  if (p.nightOwl) list.push('🦉 Noční sova (po 2. ráno)');
  if (p.episodes >= 25) list.push('📺 Seriálový nadšenec (25 dílů)');
  if (p.started >= 20) list.push('🎬 Promítač (20 puštění)');
  if (p.added >= 10) list.push('📝 Kurátor (10 přání)');
  if (p.fulfilled >= 3) list.push('🎯 Trefa (3 splněná přání)');
  return list;
}

export function serverEmbed(stats, periodLabel) {
  const weekday = stats.weekdays.some(Boolean) ? WEEKDAYS[stats.weekdays.indexOf(Math.max(...stats.weekdays))] : null;
  const replay = [...stats.replays].map(([label, days]) => [label, days.size]).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])[0];
  const records = [
    stats.marathon && stats.marathon.count > 1
      && `🏃 Nejdelší maraton: **${plural(stats.marathon.count, 'titul', 'tituly', 'titulů')}**, ${formatHours(stats.marathon.seconds)} v kuse`,
    stats.latest && `🦉 Nejpozději do noci: do **${stats.latest.time}** (${stats.latest.entry.label})`,
    replay && `🔁 Nejvíc opakované: **${replay[0]}** (${replay[1]}×)`,
    weekday && `📅 Nejčastěji koukáme **${weekday}**`,
  ].filter(Boolean);
  return new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle(`📊 Statistiky kina · ${periodLabel}`)
    .setDescription([
      `**${formatHours(stats.seconds)}** v kině · **${plural(stats.evenings.size, 'večer', 'večery', 'večerů')}**`,
      `✅ Dokoukáno ${plural(stats.films, 'film', 'filmy', 'filmů')} a ${plural(stats.episodes, 'díl', 'díly', 'dílů')}`
        + ` · ${plural(stats.titles, 'puštění', 'puštění', 'puštění')} celkem`,
      `📝 Na seznamu přání ${stats.wishesOpen >= 2 && stats.wishesOpen <= 4 ? 'čekají' : 'čeká'} ${plural(stats.wishesOpen, 'film', 'filmy', 'filmů')}`,
    ].join('\n'))
    .addFields(
      { name: '👀 Nejvíc času v kině', value: ranking(named(stats, top(stats.viewers)), formatHours), inline: true },
      { name: '🎬 Nejčastěji pouští', value: ranking(named(stats, top(stats.starters)), n => `${n}×`), inline: true },
      { name: '​', value: '​', inline: false },
      { name: '📝 Nejvíc přání', value: ranking(named(stats, top(stats.adders)), n => plural(n, 'film', 'filmy', 'filmů')), inline: true },
      { name: '🎯 Splněná přání', value: ranking(named(stats, top(stats.fulfilled)), n => `${n}×`), inline: true },
      { name: '​', value: '​', inline: false },
      { name: '📺 Seriály', value: ranking(top(stats.series), n => plural(n, 'díl', 'díly', 'dílů')), inline: true },
      { name: '🎭 Žánry', value: ranking(top(stats.genres), formatHours), inline: true },
      { name: '🏅 Rekordy', value: records.join('\n') || '—', inline: false },
    )
    .setFooter({ text: 'Čas diváků se měří od 30. 10. 2026 · /statistiky kdo:@někdo ukáže osobní' });
}

export function personEmbed(stats, key, displayName, periodLabel) {
  const p = stats.perPerson.get(key);
  const embed = new EmbedBuilder().setColor(0x57f287).setTitle(`👤 ${displayName} · ${periodLabel}`);
  if (!p) return embed.setDescription('Zatím tu nic není. Přijď do kina! 🍿');
  const rank = top(stats.viewers, Infinity).findIndex(([k]) => k === key);
  const starterRank = top(stats.starters, Infinity).findIndex(([k]) => k === key);
  const adderRank = top(stats.adders, Infinity).findIndex(([k]) => k === key);
  const favourite = map => top(map, 1)[0]?.[0] ?? '—';
  const place = (index, of) => (index >= 0 ? `${index + 1}. z ${of}` : '—');
  const earned = badges(p, rank);
  embed.addFields(
    { name: '👀 V kině', value: `**${formatHours(p.seconds)}**\n${place(rank, stats.viewers.size)}`, inline: true },
    { name: '🎬 Pustil(a)', value: `**${p.started}×**\n${place(starterRank, stats.starters.size)}`, inline: true },
    { name: '📝 Přání', value: `**${p.added}** přidáno\n🎯 ${p.fulfilled} splněno · ${place(adderRank, stats.adders.size)}`, inline: true },
    { name: '✅ Dokoukáno', value: `${plural(p.films, 'film', 'filmy', 'filmů')} · ${plural(p.episodes, 'díl', 'díly', 'dílů')}`, inline: true },
    { name: '🎭 Oblíbený žánr', value: favourite(p.genres), inline: true },
    { name: '📺 Oblíbený seriál', value: favourite(p.series), inline: true },
    { name: '🏅 Odznaky', value: earned.join('\n') || 'Zatím žádné. Další film to spraví!', inline: false },
  );
  if (p.first) embed.setFooter({ text: `Poprvé v kině (od měření) ${new Date(p.first).toLocaleDateString('cs-CZ', { timeZone: ZONE })}` });
  return embed;
}

/** Finds a person's key in the stats: their Discord ID, or a name from older history. */
export function personKeyFor(stats, id, names) {
  if (stats.perPerson.has(id)) return id;
  const wanted = names.filter(Boolean).map(n => n.toLowerCase());
  return [...stats.perPerson.keys()].find(k => wanted.includes(String(k).toLowerCase())) ?? id;
}
