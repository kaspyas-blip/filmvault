import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { config } from './config.js';
import { entryKey } from './history.js';
import { t } from './i18n.js';
import {
  SORTS, isPreferred, itemLabel, listEpisodes, listGenres, listLibrary, listSeasons,
} from './jellyfin.js';
import { UserError } from './player.js';
import { formatTime } from './time.js';

const LIST_PAGE_SIZE = 20;
const EPISODE_PAGE_SIZE = 25;
const HISTORY_PAGE_SIZE = 15;
const PREFERRED_LIST_CACHE_MS = 5 * 60_000;
const GENRE_CACHE_MS = 10 * 60_000;

export function choiceName(text) {
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

export function formatDate(ms) {
  return new Date(ms).toLocaleString(t('locale'), {
    timeZone: config.timezone, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** The lists of /filmy, /serialy and /videli. history, cachedItem: of the server's cinema. */
export function createBrowser({ history, cachedItem }) {
  const preferredListCache = new Map();
  let genreCache = null;

  async function genres() {
    if (genreCache && genreCache.expires > Date.now()) return genreCache.items;
    genreCache = { items: await listGenres('Movie'), expires: Date.now() + GENRE_CACHE_MS };
    return genreCache.items;
  }

  // Browsing views. Custom IDs carry the whole state ("fl:…" movies, "fs:…" series),
  // so the ephemeral lists keep working across bot restarts.
  const button = (id, label, disabled = false) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);

  function pageButtons(prefix, page, pages, extra = [], suffix = '') {
    return new ActionRowBuilder().addComponents(
      ...extra,
      button(`${prefix}:first:1${suffix}`, '⏮', page === 1),
      button(`${prefix}:prev:${page - 1}${suffix}`, '◀', page === 1),
      button(`${prefix}:next:${page + 1}${suffix}`, '▶', page === pages),
      button(`${prefix}:last:${pages}${suffix}`, '⏭', page === pages),
    );
  }

  // Movie filter <-> compact string kept in button IDs: "g<genreId>.y1990-1999.c.spridano"
  function encodeFilter({ genreId, yearFrom, yearTo, czech, sort }) {
    return [
      genreId && `g${genreId}`,
      yearFrom && `y${yearFrom}-${yearTo ?? yearFrom}`,
      czech && 'c',
      sort && sort !== 'nazev' && `s${sort}`,
    ].filter(Boolean).join('.');
  }

  function decodeFilter(text = '') {
    const filter = {};
    for (const part of text.split('.').filter(Boolean)) {
      if (part[0] === 'g') filter.genreId = part.slice(1);
      else if (part[0] === 'y') [filter.yearFrom, filter.yearTo] = part.slice(1).split('-').map(Number);
      else if (part === 'c') filter.czech = true;
      else if (part[0] === 's' && SORTS[part.slice(1)]) filter.sort = part.slice(1);
    }
    return filter;
  }

  async function filterFromOptions(options) {
    const filter = { sort: options.getString('razeni') ?? 'nazev', czech: options.getBoolean('cesky') ?? false };
    const genre = options.getString('zanr')?.trim();
    if (genre) {
      const all = await genres();
      const match = all.find(g => g.Id === genre) ?? all.find(g => g.Name.toLowerCase() === genre.toLowerCase());
      if (!match) throw new UserError(t('browse.badGenre', { genre }));
      filter.genreId = match.Id;
    }
    const year = options.getString('rok')?.trim();
    if (year) {
      const m = /^(\d{4})(?:\s*[-–]\s*(\d{4}))?$/.exec(year);
      if (!m) throw new UserError(t('browse.badYear'));
      const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])].sort((a, b) => a - b);
      if (to - from > 150) throw new UserError(t('browse.yearRange'));
      Object.assign(filter, { yearFrom: from, yearTo: to });
    }
    return filter;
  }

  async function filterTitle(filter) {
    const parts = [];
    if (filter.genreId) parts.push((await genres()).find(g => g.Id === filter.genreId)?.Name ?? t('browse.genreFallback'));
    if (filter.yearFrom) parts.push(filter.yearFrom === filter.yearTo ? String(filter.yearFrom) : `${filter.yearFrom}–${filter.yearTo}`);
    if (filter.czech) parts.push(t('browse.preferredDub'));
    return parts.join(' · ');
  }

  // Jellyfin cannot filter by audio language, so the dub filter loads the matching
  // movies with their streams and pages locally.
  async function preferredMovies(filter) {
    const key = encodeFilter(filter);
    const hit = preferredListCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.items;
    const { items } = await listLibrary('Movie', undefined, undefined, { ...filter, fields: 'ProductionYear,MediaStreams' });
    const dubbed = items.filter(item => item.MediaStreams?.some(s => s.Type === 'Audio' && isPreferred(s)));
    preferredListCache.set(key, { items: dubbed, expires: Date.now() + PREFERRED_LIST_CACHE_MS });
    return dubbed;
  }

  async function historyList(page, notice = '') {
    const entries = await history();
    const pages = Math.max(1, Math.ceil(entries.length / HISTORY_PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const shown = entries.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE);
    const lines = shown.map(e => {
      const state = e.finished ? t('browse.finished') : `${t('browse.stoppedAt', { time: formatTime(e.position) })}${e.duration ? ` / ${formatTime(e.duration)}` : ''}`;
      return `**${e.label}**\n${formatDate(e.endedAt)} · ${state} · ${e.manual ? '✍️ ' : ''}${e.by ?? '?'}`;
    });
    const components = [pageButtons('fh', page, pages)];
    // Select menu values must be unique and hold 100 characters (a web address can be long).
    const removable = [...new Map(shown.map(e => [entryKey(e), e])).values()].filter(e => entryKey(e).length <= 100);
    if (removable.length) {
      components.unshift(selectRow(`fh:del:${page}`, t('browse.removeFromHistory'), removable.map(e => ({
        label: choiceName(e.label), description: formatDate(e.endedAt), value: entryKey(e),
      }))));
    }
    const unfinished = [...new Map(shown.filter(e => !e.finished && e.id.length <= 100).map(e => [e.id, e])).values()];
    if (unfinished.length) {
      components.unshift(selectRow('fh:play', t('browse.continueWatching'),
        unfinished.map(e => ({ label: choiceName(e.label), description: t('browse.fromTime', { time: formatTime(e.position) }), value: e.id }))));
    }
    const embed = listEmbed(t('browse.historyTitle'), lines, t('browse.page', { page, pages }));
    if (!entries.length) {
      embed.setDescription(t('browse.historyEmpty'));
    }
    return { content: notice, embeds: [embed], components };
  }

  function selectRow(id, placeholder, options) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id).setPlaceholder(placeholder).addOptions(options));
  }

  function listEmbed(title, lines, footer) {
    return new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(lines.join('\n') || t('browse.nothing')).setFooter({ text: footer });
  }

  const LIBRARIES = {
    movies: { type: 'Movie', prefix: 'fl', select: 'fl:play', title: t('browse.moviesTitle'), placeholder: t('browse.moviesPlaceholder') },
    series: { type: 'Series', prefix: 'fs:list', select: 'fs:series', title: t('browse.seriesTitle'), placeholder: t('browse.seriesPlaceholder') },
  };

  // Latest history entry per item: what /filmy and the episode list mark as seen or started.
  async function watchStates() {
    const states = new Map();
    for (const entry of await history()) if (!states.has(entry.id)) states.set(entry.id, entry);
    return states;
  }

  function watchMark(entry) {
    if (!entry) return '';
    return entry.finished ? ' ✅' : ` ⏸ ${formatTime(entry.position)}`;
  }

  function watchEmoji(entry) {
    if (!entry) return undefined;
    return entry.finished ? '✅' : '⏸️';
  }

  const WATCH_LEGEND = t('browse.legend');

  async function libraryList(kind, page, filter = {}) {
    const library = LIBRARIES[kind];
    const start = (page - 1) * LIST_PAGE_SIZE;
    let items;
    let total;
    if (filter.czech) {
      const all = await preferredMovies(filter);
      [items, total] = [all.slice(start, start + LIST_PAGE_SIZE), all.length];
    } else {
      ({ items, total } = await listLibrary(library.type, start, LIST_PAGE_SIZE, filter));
    }
    const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    if (page > pages) return libraryList(kind, pages, filter);
    const rating = filter.sort === 'hodnoceni';
    const states = kind === 'movies' ? await watchStates() : new Map();
    const lines = items.map((item, i) => `\`${String(start + i + 1).padStart(3)}\` ${itemLabel(item)}`
      + (rating && item.CommunityRating ? ` · ⭐ ${item.CommunityRating.toFixed(1)}` : '')
      + watchMark(states.get(item.Id)));
    const suffix = kind === 'movies' ? `:${encodeFilter(filter)}` : '';
    const components = [pageButtons(library.prefix, page, pages, [], suffix)];
    if (items.length) {
      components.unshift(selectRow(library.select, library.placeholder,
        items.map(item => ({ label: choiceName(itemLabel(item)), value: item.Id, emoji: watchEmoji(states.get(item.Id)) }))));
    }
    const described = await filterTitle(filter);
    const title = `${library.title}${described ? ` · ${described}` : ''} (${total})`;
    const sort = filter.sort && filter.sort !== 'nazev' ? ` · ${SORTS[filter.sort].label}` : '';
    const legend = kind === 'movies' ? WATCH_LEGEND : '';
    return { embeds: [listEmbed(title, lines, `${t('browse.page', { page, pages })}${sort}${legend}`)], components };
  }

  async function seasonList(seriesId) {
    const seasons = (await listSeasons(seriesId)).slice(0, 25);
    const series = await cachedItem(seriesId);
    const lines = seasons.map(s => `• ${s.Name}${s.ChildCount ? ` ${t('browse.episodes', { count: s.ChildCount })}` : ''}`);
    const components = [new ActionRowBuilder().addComponents(button('fs:list:back:1', t('browse.backToSeries')))];
    if (seasons.length) {
      components.unshift(selectRow('fs:season', t('browse.pickSeason'),
        seasons.map(s => ({ label: choiceName(s.Name), value: `${seriesId}:${s.Id}` }))));
    }
    return { embeds: [listEmbed(`📺 ${itemLabel(series)}`, lines, t('browse.pickSeasonFooter'))], components };
  }

  async function episodeList(seriesId, seasonId, page) {
    const episodes = await listEpisodes(seriesId, seasonId);
    const pages = Math.max(1, Math.ceil(episodes.length / EPISODE_PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const shown = episodes.slice((page - 1) * EPISODE_PAGE_SIZE, page * EPISODE_PAGE_SIZE);
    const label = e => `E${String(e.IndexNumber ?? 0).padStart(2, '0')} ${e.Name}`;
    const first = episodes[0];
    const title = first ? `📺 ${first.SeriesName} – ${first.SeasonName}` : t('browse.seasonFallback');
    const states = await watchStates();
    const components = [pageButtons(`fs:eps:${seriesId}:${seasonId}`, page, pages, [button(`fs:seasons:${seriesId}`, t('browse.backToSeasons'))])];
    if (shown.length) {
      components.unshift(selectRow('fs:play', t('browse.pickEpisode'), shown.map(e => ({
        label: choiceName(label(e)), value: e.Id, emoji: watchEmoji(states.get(e.Id)),
      }))));
    }
    const lines = shown.map(e => label(e) + watchMark(states.get(e.Id)));
    return { embeds: [listEmbed(title, lines, `${t('browse.page', { page, pages })}${WATCH_LEGEND}`)], components };
  }

  return { genres, decodeFilter, filterFromOptions, historyList, libraryList, seasonList, episodeList };
}
