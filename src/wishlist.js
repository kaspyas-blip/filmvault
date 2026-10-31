import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { config } from './config.js';
import { addWatch, history } from './history.js';
import { durationSeconds, getItem, listLibrary, saveProgress } from './jellyfin.js';
import { findMovie, imdbUrl, movieDetails, normalizeTitle, titleSimilarity, tmdbUrl } from './movieinfo.js';
import { formatTime } from './time.js';

/**
 * The wishlist room: people write movie titles, the bot looks them up and keeps one
 * list message at the bottom of the room. Each film shows whether it is in Jellyfin;
 * once the cinema finishes it, it drops off (it is in /videli by then). The dice
 * picks a random film that can be played right away. Films newly added to Jellyfin
 * are announced here, one message per batch.
 */

const FILE = 'data/wishlist.json';
const LIST_TITLE = '🎬 Chceme vidět';
// Films added to Jellyfin turn ✅ within about five minutes.
const LIBRARY_CACHE_MS = 2 * 60_000;
const PERIODIC_REFRESH_MS = 5 * 60_000;
const REFRESH_DEBOUNCE_MS = 1500;
const NOT_FOUND_TTL_MS = 30_000;
const MAX_LINES_PER_MESSAGE = 10;
const MAX_TITLE_LENGTH = 80;
const IMPORT_MESSAGES = 200;
const DESCRIPTION_LIMIT = 4000;
const DICE_MEMORY = 20;
const NICKNAME_CACHE_MS = 10 * 60_000;
// New films are announced once Jellyfin has added nothing for this long, so a batch
// copied in over several minutes ends up in one message (with metadata filled in).
const ARRIVALS_QUIET_MS = 10 * 60_000;
const ARRIVALS_PLAY_OPTIONS = 25;
const MAX_EMBEDS = 10;

function formatDate(ms) {
  return new Date(ms).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric' });
}

const byTitle = (a, b) => a.film.title.localeCompare(b.film.title, 'cs') || (a.film.year ?? 0) - (b.film.year ?? 0);

function formatRuntime(minutes) {
  if (!minutes) return null;
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** Titles in a message: one per line, list bullets stripped, chatter skipped. */
export function titlesIn(text) {
  return text.split('\n')
    .map(line => line.replace(/^\s*(?:[-*•>]|\d+[.)])\s*/, '').replace(/[*_~`|]/g, '').trim())
    .filter(line => line && line.length <= MAX_TITLE_LENGTH && !line.startsWith('//') && !line.endsWith('?'))
    .slice(0, MAX_LINES_PER_MESSAGE);
}

export function createWishlist({ client, channelId, allowed, userName, play }) {
  let state = null; // { listMessageId, imported, films, done, knownMovies, arrivals }
  let writing = Promise.resolve();
  let library = null; // { expires, byImdb, byTmdb, byTitle }
  let refreshTimer = null;
  let refreshing = Promise.resolve();
  let lastRendered = null;
  const nicknames = new Map(); // user ID -> { name, expires }

  const channel = () => client.channels.cache.get(channelId);

  async function load() {
    if (state) return state;
    try {
      state = JSON.parse(await readFile(FILE, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read wishlist:', error.message);
      state = { listMessageId: null, imported: false, films: [] };
    }
    return state;
  }

  function save() {
    const data = JSON.stringify(state, null, 1);
    writing = writing.then(async () => {
      await mkdir('data', { recursive: true });
      await writeFile(`${FILE}.tmp`, data);
      await rename(`${FILE}.tmp`, FILE);
    }).catch(error => console.error('Could not save wishlist:', error.message));
    return writing;
  }

  // ---- Jellyfin matching ----------------------------------------------------

  async function libraryIndex() {
    if (library && library.expires > Date.now()) return library;
    const { items } = await listLibrary('Movie', undefined, undefined, { fields: 'ProductionYear,ProviderIds,OriginalTitle,Genres' });
    const index = { expires: Date.now() + LIBRARY_CACHE_MS, byImdb: new Map(), byTmdb: new Map(), byTitle: new Map(), items };
    for (const item of items) {
      const ids = item.ProviderIds ?? {};
      if (ids.Imdb) index.byImdb.set(ids.Imdb, item);
      if (ids.Tmdb) index.byTmdb.set(String(ids.Tmdb), item);
      for (const name of [item.Name, item.OriginalTitle]) {
        if (name) index.byTitle.set(`${normalizeTitle(name)}|${item.ProductionYear ?? ''}`, item);
      }
    }
    library = index;
    return index;
  }

  async function jellyfinItem(film) {
    const index = await libraryIndex();
    return (film.imdbId && index.byImdb.get(film.imdbId))
      ?? index.byTmdb.get(String(film.tmdbId))
      ?? [film.title, film.originalTitle].map(t => index.byTitle.get(`${normalizeTitle(t)}|${film.year ?? ''}`)).find(Boolean)
      ?? looseMatch(index.items, film);
  }

  /**
   * Films Jellyfin never identified have no IMDb/TMDB IDs and often a file-like name
   * ("Dannyho parťáci 1"): same year and every word of the title is enough.
   */
  function looseMatch(items, film) {
    if (!film.year) return null;
    return items.find(item => Math.abs((item.ProductionYear ?? 0) - film.year) <= 1
      && [film.title, film.originalTitle].some(title => title && [item.Name, item.OriginalTitle].some(name => titleSimilarity(title, name) === 1)))
      ?? null;
  }

  // ---- Who added it ----------------------------------------------------------

  /** The name people use on the server now (server nickname), not the Discord username. */
  async function adderName(film) {
    if (!film.addedById) return film.addedBy ?? null;
    const hit = nicknames.get(film.addedById);
    if (hit && hit.expires > Date.now()) return hit.name;
    const member = await channel()?.guild.members.fetch(film.addedById).catch(() => null);
    const name = member?.displayName ?? film.addedBy ?? null;
    nicknames.set(film.addedById, { name, expires: Date.now() + NICKNAME_CACHE_MS });
    return name;
  }

  /** Films added before user IDs were stored only have a username: look it up once. */
  async function resolveAdderIds() {
    const list = await load();
    const guild = channel().guild;
    let changed = false;
    for (const name of new Set(list.films.filter(f => !f.addedById && f.addedBy).map(f => f.addedBy))) {
      const found = await guild.members.search({ query: name, limit: 10 }).catch(() => null);
      const member = found?.find(m => [m.user.username, m.displayName, m.user.globalName].includes(name));
      if (!member) continue;
      for (const film of list.films.filter(f => !f.addedById && f.addedBy === name)) film.addedById = member.id;
      changed = true;
    }
    if (changed) await save();
  }

  // ---- Watch state --------------------------------------------------------

  /** Latest history entry per Jellyfin item, and when it was last finished. */
  async function watchIndex() {
    const latest = new Map();
    const finished = new Map();
    for (const entry of await history()) {
      if (!latest.has(entry.id)) latest.set(entry.id, entry);
      if (entry.finished && !finished.has(entry.id)) finished.set(entry.id, entry.endedAt);
    }
    return { latest, finished };
  }

  /** History ID of a film: its Jellyfin item, or "tmdb:<id>" when watched elsewhere (YouTube…). */
  function historyId(film, item) {
    return item?.Id ?? `tmdb:${film.tmdbId}`;
  }

  /**
   * Each film with its Jellyfin item and watch state; drops films finished after they
   * were added. "elsewhere" is a link or note set by hand for films outside Jellyfin.
   */
  async function currentFilms() {
    const list = await load();
    const watch = await watchIndex();
    const rows = [];
    const done = [];
    for (const film of list.films) {
      const item = await jellyfinItem(film);
      const id = historyId(film, item);
      const finishedAt = watch.finished.get(id);
      if (finishedAt && finishedAt > film.addedAt) {
        done.push({ ...film, seenAt: finishedAt });
        continue;
      }
      const latest = item && watch.latest.get(id);
      rows.push({
        film,
        item,
        elsewhere: !item && film.elsewhere ? film.elsewhere : null,
        started: latest && !latest.finished ? latest.position : null,
        seenAt: finishedAt ?? null,
        by: await adderName(film),
      });
    }
    if (done.length) {
      // Kept for the statistics (whose wishes came true).
      list.done = [...(list.done ?? []), ...done];
      const doneIds = new Set(done.map(f => f.tmdbId));
      list.films = list.films.filter(f => !doneIds.has(f.tmdbId));
      await save();
      console.log(`Wishlist: removed watched ${done.map(f => f.title).join(', ')}`);
    }
    return rows;
  }

  // ---- New in Jellyfin -----------------------------------------------------

  /** Item ID plus TMDB/IMDb IDs, so a film Jellyfin re-adds under a new ID is not news. */
  function movieKeys(item) {
    const ids = item.ProviderIds ?? {};
    return [item.Id, ids.Tmdb && `tmdb:${ids.Tmdb}`, ids.Imdb && `imdb:${ids.Imdb}`].filter(Boolean);
  }

  /** The role to ping: ID or name from the config, or null. */
  function announceRole() {
    const wanted = config.announceRole;
    if (!wanted) return null;
    const role = channel().guild.roles.cache.find(r => r.id === wanted || r.name.toLowerCase() === wanted.toLowerCase());
    if (!role) console.warn(`Announce role "${wanted}" not found, announcing without a ping`);
    else if (!role.mentionable && !channel().permissionsFor(client.user)?.has(PermissionFlagsBits.MentionEveryone)) {
      console.warn(`Announce role "${role.name}" is not mentionable and the bot may not mention roles: nobody gets notified`);
    }
    return role ?? null;
  }

  const itemTitle = item => (item.ProductionYear ? `${item.Name} (${item.ProductionYear})` : item.Name);

  function arrivalLine(item, wishers) {
    const ids = item.ProviderIds ?? {};
    const url = ids.Imdb ? imdbUrl(ids.Imdb) : ids.Tmdb ? tmdbUrl(ids.Tmdb) : null;
    const parts = [url ? `[${itemTitle(item)}](${url})` : itemTitle(item)];
    const runtime = formatRuntime(Math.round((durationSeconds(item) ?? 0) / 60));
    if (runtime) parts.push(runtime);
    if (item.CommunityRating) parts.push(`⭐ ${item.CommunityRating.toFixed(1)}`);
    if (item.Genres?.length) parts.push(item.Genres.slice(0, 2).join(', '));
    if (wishers.length) parts.push(`🙌 přání: ${wishers.map(w => w.name).join(', ')}`);
    return `🎬 ${parts.join(' · ')}`;
  }

  async function announceArrivals(items) {
    const list = await load();
    // Whose wish came true: wishlist entries that now match one of the new films.
    const wishers = new Map(items.map(item => [item.Id, []]));
    for (const film of list.films) {
      const item = await jellyfinItem(film);
      if (item && wishers.has(item.Id)) wishers.get(item.Id).push({ name: await adderName(film) ?? film.addedBy, id: film.addedById });
    }
    const sorted = [...items].sort((a, b) => a.Name.localeCompare(b.Name, 'cs'));
    const chunks = [[]];
    let length = 0;
    for (const item of sorted) {
      const line = arrivalLine(item, wishers.get(item.Id));
      if (length + line.length + 1 > DESCRIPTION_LIMIT) {
        chunks.push([]);
        length = 0;
      }
      chunks.at(-1).push(line);
      length += line.length + 1;
    }
    const n = items.length;
    const count = `${n} ${n === 1 ? 'nový film' : n < 5 ? 'nové filmy' : 'nových filmů'}`;
    const role = announceRole();
    const wishedIds = [...new Set([...wishers.values()].flat().map(w => w.id).filter(Boolean))];
    const content = [
      `${role ? `${role} ` : ''}🍿 V kině ${n === 1 ? 'přibyl' : 'přibyly'} **${count}**!`,
      wishedIds.length ? `🙌 Splněná přání: ${wishedIds.map(id => `<@${id}>`).join(' ')}` : null,
    ].filter(Boolean).join('\n');
    const menu = new StringSelectMenuBuilder().setCustomId('fw:playnew').setPlaceholder('▶ Pustit některý z nich…')
      .addOptions(sorted.slice(0, ARRIVALS_PLAY_OPTIONS).map(item => ({ label: itemTitle(item).slice(0, 100), value: item.Id })));
    // A message holds at most 10 embeds; only a huge first import would be cut short.
    await channel().send({
      content,
      embeds: chunks.slice(0, MAX_EMBEDS).map((lines, i) => new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(i ? null : `🆕 Nově v Jellyfinu (${n})`)
        .setDescription(lines.join('\n'))),
      components: [new ActionRowBuilder().addComponents(menu)],
      allowedMentions: { roles: role ? [role.id] : [], users: wishedIds },
    });
    console.log(`Announced ${n} new film(s): ${sorted.map(i => i.Name).join(', ')}`);
  }

  /**
   * Notes which films Jellyfin has; new ones wait until a quiet period ends the batch,
   * then go out in one message. The very first run only takes note of the library.
   */
  async function checkArrivals() {
    const list = await load();
    const index = await libraryIndex();
    if (!list.knownMovies) {
      list.knownMovies = index.items.flatMap(movieKeys);
      await save();
      return;
    }
    const known = new Set(list.knownMovies);
    const fresh = index.items.filter(item => !movieKeys(item).some(key => known.has(key)));
    list.arrivals ??= { ids: [], lastAt: 0 };
    const added = fresh.filter(item => !list.arrivals.ids.includes(item.Id));
    if (added.length) {
      list.arrivals.ids.push(...added.map(item => item.Id));
      list.arrivals.lastAt = Date.now();
      await save();
    }
    if (!list.arrivals.ids.length || Date.now() - list.arrivals.lastAt < ARRIVALS_QUIET_MS) return;
    // Films removed again meanwhile are no longer in `fresh`; a failed send is retried next time.
    if (fresh.length) await announceArrivals(fresh);
    list.knownMovies = [...known, ...fresh.flatMap(movieKeys)];
    list.arrivals = { ids: [], lastAt: 0 };
    await save();
  }

  // ---- Messages -----------------------------------------------------------

  function filmLabel(film) {
    return film.year ? `${film.title} (${film.year})` : film.title;
  }

  /** "na YouTube" with the link when there is one. */
  function elsewhereText(elsewhere) {
    const note = elsewhere.note || 'odkaz';
    return elsewhere.url ? `[${note}](${elsewhere.url})` : note;
  }

  const playable = row => !!(row.item || row.elsewhere);

  /** One short line per film, so it does not wrap: status, title (IMDb link), rating, who added it. */
  function filmLine({ film, item, elsewhere, started, by }) {
    const mark = item ? (started ? '⏸️' : '✅') : elsewhere ? '📺' : '❌';
    const parts = [`${mark} [${filmLabel(film)}](${imdbUrl(film.imdbId) ?? tmdbUrl(film.tmdbId)})`];
    if (film.rating) parts.push(`⭐ ${film.rating.toFixed(1)}`);
    if (elsewhere) parts.push(elsewhereText(elsewhere));
    if (by) parts.push(by);
    return parts.join(' · ');
  }

  function listPayload(rows) {
    const sorted = [...rows].sort(byTitle);
    const lines = [];
    let length = 0;
    for (const row of sorted) {
      const line = filmLine(row);
      if (length + line.length + 1 > DESCRIPTION_LIMIT) {
        lines.push(`…a dalších ${sorted.length - lines.length}`);
        break;
      }
      lines.push(line);
      length += line.length + 1;
    }
    const available = rows.filter(playable).length;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${LIST_TITLE} (${rows.length})`)
      .setDescription(lines.join('\n') || 'Seznam je prázdný. Napiš sem název filmu a přidám ho.')
      .setFooter({ text: `✅ máme · 📺 máme jinde · ❌ nemáme · ⏸ rozkoukané · Přidáš ho napsáním názvu do této roomky` });
    const components = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fw:roll').setLabel('🎲 Hodit kostkou').setStyle(ButtonStyle.Primary).setDisabled(!available),
    )];
    if (rows.length) {
      components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('fw:edit').setPlaceholder('✏️ Upravit nebo odebrat…')
        .addOptions(sorted.slice(0, 25).map(({ film }) => ({ label: filmLabel(film).slice(0, 100), value: String(film.tmdbId) })))));
    }
    return { embeds: [embed], components };
  }

  function cardEmbed(details, { item, elsewhere, seenAt, addedBy }) {
    const embed = new EmbedBuilder()
      .setColor(item || elsewhere ? 0x57f287 : 0x4e5058)
      .setTitle(filmLabel(details))
      .setURL(imdbUrl(details.imdbId) ?? tmdbUrl(details.tmdbId));
    const original = details.originalTitle && details.originalTitle !== details.title ? `*${details.originalTitle}*\n` : '';
    const overview = details.overview.length > 350 ? `${details.overview.slice(0, 349)}…` : details.overview;
    if (original || overview) embed.setDescription(original + overview);
    if (details.poster) embed.setThumbnail(details.poster);
    const fields = [];
    if (details.rating) {
      fields.push({ name: `⭐ ${details.ratingSource}`, value: `${details.rating}/10${details.votes ? ` (${details.votes} hlasů)` : ''}`, inline: true });
    }
    const runtime = formatRuntime(details.runtime);
    if (runtime) fields.push({ name: '⏱ Délka', value: runtime, inline: true });
    if (details.genres.length) fields.push({ name: '🎭 Žánr', value: details.genres.slice(0, 3).join(', '), inline: true });
    if (details.director) fields.push({ name: '🎬 Režie', value: details.director, inline: true });
    if (details.trailer) fields.push({ name: '📺 Trailer', value: `[YouTube](${details.trailer})`, inline: true });
    const status = item ? '✅ Máme v Jellyfinu' : elsewhere ? `📺 Máme jinde: ${elsewhereText(elsewhere)}` : '❌ Nemáme v Jellyfinu';
    fields.push({ name: 'Stav', value: seenAt ? `${status} · 👀 už jste viděli ${formatDate(seenAt)}` : status, inline: false });
    embed.addFields(fields);
    if (addedBy) embed.setFooter({ text: `Přidal(a): ${addedBy}` });
    return embed;
  }

  /** Keeps the list message as the last message in the room. */
  async function renderList() {
    const room = channel();
    if (!room) return;
    // Before the list, so the list is posted again below an announcement.
    await checkArrivals().catch(error => console.error('New film check failed:', error));
    const list = await load();
    const payload = listPayload(await currentFilms());
    const rendered = JSON.stringify(payload);
    const old = list.listMessageId && await room.messages.fetch(list.listMessageId).catch(() => null);
    if (old && room.lastMessageId === old.id) {
      // The periodic refresh mostly finds nothing new; skip the edit then.
      if (rendered !== lastRendered) await old.edit(payload);
      lastRendered = rendered;
      return;
    }
    const sent = await room.send(payload);
    lastRendered = rendered;
    list.listMessageId = sent.id;
    await save();
    await old?.delete().catch(() => {});
  }

  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshing = refreshing.then(renderList).catch(error => console.error('Wishlist refresh failed:', error));
    }, REFRESH_DEBOUNCE_MS);
  }

  // ---- Adding ---------------------------------------------------------------

  /** adder: { name, id } of whoever added it. */
  async function addFilm(tmdbId, adder) {
    const list = await load();
    const existing = list.films.find(f => f.tmdbId === tmdbId);
    const details = await movieDetails(tmdbId);
    const film = existing ?? {
      tmdbId,
      imdbId: details.imdbId,
      title: details.title,
      originalTitle: details.originalTitle,
      year: details.year,
      rating: details.rating,
      addedBy: adder.name,
      addedById: adder.id,
      addedAt: Date.now(),
    };
    if (!existing) {
      list.films.push(film);
      await save();
    }
    const item = await jellyfinItem(film);
    const seenAt = (await watchIndex()).finished.get(historyId(film, item)) ?? null;
    const elsewhere = !item ? film.elsewhere ?? null : null;
    return { film, details, existing: !!existing, embed: cardEmbed(details, { item, elsewhere, seenAt, addedBy: await adderName(film) }) };
  }

  function addedText({ film, existing }) {
    return existing ? `ℹ️ **${filmLabel(film)}** už na seznamu je.` : `➕ Přidáno na seznam: **${filmLabel(film)}**`;
  }

  async function temporaryReply(message, content) {
    const reply = await message.reply({ content, allowedMentions: { repliedUser: false } });
    setTimeout(() => reply.delete().catch(() => {}), NOT_FOUND_TTL_MS).unref();
  }

  async function handleMessage(message) {
    if (message.author.bot || message.channelId !== channelId || message.system) return;
    const by = message.member?.displayName ?? message.author.username;
    let notFound = false;
    for (const title of titlesIn(message.content)) {
      try {
        const { match, choices } = await findMovie(title);
        if (match) {
          const added = await addFilm(match.tmdbId, { name: by, id: message.author.id });
          await message.reply({ content: addedText(added), embeds: [added.embed], allowedMentions: { repliedUser: false } });
        } else if (choices) {
          const menu = new StringSelectMenuBuilder().setCustomId('fw:pick').setPlaceholder('Vyber film…')
            .addOptions(choices.map(c => ({
              label: filmLabel(c).slice(0, 100),
              description: c.originalTitle && c.originalTitle !== c.title ? c.originalTitle.slice(0, 100) : undefined,
              value: String(c.tmdbId),
            })));
          await message.reply({
            content: `🤔 „${title}“ může být víc filmů. Který myslíš?`,
            components: [new ActionRowBuilder().addComponents(menu)],
            allowedMentions: { repliedUser: false },
          });
        } else {
          // People also chat here, so no reply: just a reaction in case it was a typo.
          notFound = true;
        }
      } catch (error) {
        console.error(`Wishlist lookup for "${title}" failed:`, error);
        await temporaryReply(message, `⚠️ Film „${title}“ se nepodařilo dohledat: ${error.message}`).catch(() => {});
      }
    }
    if (notFound) await message.react('🤷').catch(() => {});
    refresh();
  }

  /** First start: turn titles people already wrote into the room into the list, without replies. */
  async function importExisting() {
    const list = await load();
    if (list.imported) return;
    const room = channel();
    const messages = [];
    let before;
    while (messages.length < IMPORT_MESSAGES) {
      const batch = await room.messages.fetch({ limit: 100, before });
      if (!batch.size) break;
      messages.push(...batch.values());
      before = batch.last().id;
    }
    const added = [];
    const skipped = [];
    for (const message of messages.reverse()) {
      if (message.author.bot || message.system) continue;
      const by = message.member?.displayName ?? message.author.username;
      for (const title of titlesIn(message.content)) {
        const { match, choices } = await findMovie(title).catch(() => ({}));
        const pick = match ?? choices?.[0];
        if (!pick) {
          skipped.push(title);
          continue;
        }
        const { film, existing } = await addFilm(pick.tmdbId, { name: by, id: message.author.id }).catch(() => ({}));
        if (film && !existing) {
          film.addedAt = message.createdTimestamp;
          added.push(`${title} -> ${filmLabel(film)}${match ? '' : ' (guess)'}`);
        }
      }
    }
    list.imported = true;
    await save();
    console.log(`Wishlist import: ${added.length} added${added.length ? `: ${added.join('; ')}` : ''}`);
    if (skipped.length) console.log(`Wishlist import: not found: ${skipped.join('; ')}`);
  }

  // ---- Buttons and menus ----------------------------------------------------

  /**
   * One dice message goes through the whole list before repeating: "offered" holds
   * the films it already showed. Returns { payload, offered } or null.
   */
  async function roll(offered = []) {
    const candidates = (await currentFilms()).filter(playable);
    if (!candidates.length) return null;
    let fresh = candidates.filter(r => !offered.includes(r.film.tmdbId));
    let restarted = false;
    if (!fresh.length) {
      // Everything was offered: start over, but not with the film just shown.
      fresh = candidates.length > 1 ? candidates.filter(r => r.film.tmdbId !== offered.at(-1)) : candidates;
      offered = [];
      restarted = true;
    }
    const pick = fresh[Math.floor(Math.random() * fresh.length)];
    offered = [...offered, pick.film.tmdbId];
    const details = await movieDetails(pick.film.tmdbId);
    const embed = cardEmbed(details, { item: pick.item, elsewhere: pick.elsewhere, seenAt: pick.seenAt, addedBy: pick.by });
    let note = pick.started ? ` Rozkoukané, naváže od ${formatTime(pick.started)}.` : '';
    const buttons = [];
    if (pick.item) {
      buttons.push(new ButtonBuilder().setCustomId(`fw:play:${pick.item.Id}`).setLabel('▶ Pustit').setStyle(ButtonStyle.Success));
    } else {
      note = ` Tenhle není v Jellyfinu, je ${pick.elsewhere.note ? `na ${pick.elsewhere.note}` : 'jinde'}.`;
      if (pick.elsewhere.url) buttons.push(new ButtonBuilder().setURL(pick.elsewhere.url).setLabel('🔗 Otevřít').setStyle(ButtonStyle.Link));
      buttons.push(new ButtonBuilder().setCustomId(`fw:seen:${pick.film.tmdbId}`).setLabel('✅ Viděli jsme').setStyle(ButtonStyle.Success));
    }
    buttons.push(new ButtonBuilder().setCustomId('fw:roll').setLabel('🎲 Hodit znovu').setStyle(ButtonStyle.Secondary));
    const round = restarted ? ' Všechny filmy už padly, jedeme znovu od začátku.' : '';
    return {
      offered,
      payload: {
        content: `🎲 Kostka náhodně vybrala z ${fresh.length} filmů, které ještě nepadly (máme jich ${candidates.length}):${note}${round}`,
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(buttons)],
      },
    };
  }

  // ---- Editing one film -----------------------------------------------------

  function editPanel(film, notice = '') {
    const buttons = [
      new ButtonBuilder().setCustomId(`fw:where:${film.tmdbId}`).setLabel(film.elsewhere ? '📺 Změnit, kde ho máme' : '📺 Máme jinde (odkaz)')
        .setStyle(ButtonStyle.Primary),
    ];
    if (film.elsewhere) buttons.push(new ButtonBuilder().setCustomId(`fw:nowhere:${film.tmdbId}`).setLabel('↩ Zrušit „máme jinde“').setStyle(ButtonStyle.Secondary));
    buttons.push(
      new ButtonBuilder().setCustomId(`fw:seen:${film.tmdbId}`).setLabel('✅ Viděli jsme').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`fw:del:${film.tmdbId}`).setLabel('🗑 Odebrat').setStyle(ButtonStyle.Danger),
    );
    const where = film.elsewhere ? `\nTeď: 📺 ${elsewhereText(film.elsewhere)}` : '';
    return {
      content: `${notice ? `${notice}\n\n` : ''}✏️ **${filmLabel(film)}**${where}\n`
        + '*Máme jinde* = film není v Jellyfinu, ale pustíte ho jinde (YouTube…); počítá se pak do kostky. '
        + '*Viděli jsme* ho zapíše do /videli a ze seznamu zmizí.',
      components: [new ActionRowBuilder().addComponents(buttons)],
      flags: MessageFlags.Ephemeral,
    };
  }

  function whereModal(film) {
    const url = new TextInputBuilder().setCustomId('url').setLabel('Odkaz (nepovinný)').setStyle(TextInputStyle.Short)
      .setRequired(false).setMaxLength(300).setPlaceholder('https://www.youtube.com/watch?v=…');
    const note = new TextInputBuilder().setCustomId('note').setLabel('Kde to je (nepovinné)').setStyle(TextInputStyle.Short)
      .setRequired(false).setMaxLength(60).setPlaceholder('YouTube režiséra');
    if (film.elsewhere?.url) url.setValue(film.elsewhere.url);
    if (film.elsewhere?.note) note.setValue(film.elsewhere.note);
    return new ModalBuilder().setCustomId(`fw:wheresave:${film.tmdbId}`).setTitle(`Kde máme ${filmLabel(film)}`.slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(url), new ActionRowBuilder().addComponents(note));
  }

  /** Records a film as watched now (also when it was not in Jellyfin) so it drops off the list. */
  async function markSeen(film, by, byId) {
    const item = await jellyfinItem(film);
    const full = item ? await getItem(item.Id).catch(() => null) : null;
    const duration = full ? durationSeconds(full) : null;
    await addWatch({ id: historyId(film, item), label: filmLabel(film), by, byId, endedAt: Date.now(), position: duration ?? 0, duration, finished: true });
    if (item) await saveProgress(item.Id, { played: true }).catch(error => console.error('Marking played in Jellyfin failed:', error.message));
  }

  async function handleInteraction(interaction) {
    const [, action, value] = interaction.customId.split(':');
    const ephemeral = content => ({ content, flags: MessageFlags.Ephemeral });

    if (action === 'roll') {
      // From the list: a new message. From a dice message: roll that one again.
      const fromList = interaction.message.embeds[0]?.title?.startsWith(LIST_TITLE);
      if (fromList) await interaction.deferReply();
      else await interaction.deferUpdate();
      const list = await load();
      list.dice ??= {};
      const result = await roll(fromList ? [] : list.dice[interaction.message.id]);
      if (!result) return interaction.editReply({ content: 'Na seznamu není žádný film, který můžeme pustit.', embeds: [], components: [] });
      const message = await interaction.editReply(result.payload);
      delete list.dice[interaction.message.id];
      list.dice[message.id] = result.offered;
      // Only recent dice messages are worth remembering.
      for (const id of Object.keys(list.dice).slice(0, -DICE_MEMORY)) delete list.dice[id];
      await save();
      return refresh();
    }

    if (action === 'pick') {
      await interaction.deferUpdate();
      const added = await addFilm(Number(interaction.values[0]), { name: userName(interaction), id: interaction.user.id });
      await interaction.editReply({ content: addedText(added), embeds: [added.embed], components: [] });
      return refresh();
    }

    if (!allowed(interaction)) return interaction.reply(ephemeral('Na tohle nemáš oprávnění.'));

    if (action === 'playnew') {
      // From the announcement of new films; the menu stays for the others.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await play(await getItem(interaction.values[0]), userName(interaction), interaction.user.id);
      return interaction.editReply('🍿 Pouštím. Ovládání je v kanálu s příkazy.');
    }

    const list = await load();
    // Select menus carry the film in their value, panel buttons and the modal in the ID.
    const tmdbId = Number(interaction.isStringSelectMenu() ? interaction.values[0] : value);
    const film = list.films.find(f => f.tmdbId === tmdbId);
    // Panel buttons replace the panel; the dice message stays as it is.
    const fromPanel = interaction.message?.flags?.has(MessageFlags.Ephemeral);
    const answer = payload => (fromPanel ? interaction.update(payload) : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }));
    if (action !== 'play' && !film) return answer({ content: 'Ten film už na seznamu není.', components: [] });

    if (action === 'edit') return interaction.reply(editPanel(film));

    if (action === 'where') return interaction.showModal(whereModal(film));

    if (action === 'wheresave') {
      const url = interaction.fields.getTextInputValue('url').trim() || null;
      const note = interaction.fields.getTextInputValue('note').trim() || null;
      if (url && !/^https?:\/\/\S+$/i.test(url)) return interaction.reply(ephemeral('Odkaz musí začínat http:// nebo https://.'));
      if (!url && !note) return interaction.reply(ephemeral('Vyplň aspoň odkaz, nebo kde film je.'));
      film.elsewhere = { url, note };
      await save();
      refresh();
      const done = `📺 Uloženo: **${filmLabel(film)}** máme jinde (${elsewhereText(film.elsewhere)}).`;
      return interaction.isFromMessage() ? interaction.update(editPanel(film, done)) : interaction.reply(editPanel(film, done));
    }

    if (action === 'nowhere') {
      delete film.elsewhere;
      await save();
      refresh();
      return answer(editPanel(film, '↩ Zrušeno, film je zase vedený jako „nemáme“.'));
    }

    if (action === 'seen') {
      await markSeen(film, userName(interaction), interaction.user.id);
      refresh();
      if (!fromPanel) await interaction.message.edit({ components: [] }).catch(() => {});
      return answer({ content: `✅ **${filmLabel(film)}** je zapsaný v /videli a ze seznamu zmizí.`, components: [] });
    }

    if (action === 'del') {
      list.films = list.films.filter(f => f !== film);
      await save();
      refresh();
      return answer({ content: `🗑 Odebráno ze seznamu: **${filmLabel(film)}**`, components: [] });
    }

    if (action === 'play') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const item = await getItem(value);
      await play(item, userName(interaction), interaction.user.id);
      await interaction.message.edit({ components: [] }).catch(() => {});
      return interaction.editReply('🍿 Pouštím. Ovládání je v kanálu s příkazy.');
    }
  }

  async function start() {
    if (!channel()) throw new Error('Wishlist channel not found');
    client.on('messageCreate', message => {
      handleMessage(message).catch(error => console.error('Wishlist message failed:', error));
    });
    await importExisting();
    await resolveAdderIds();
    await renderList();
    setInterval(refresh, PERIODIC_REFRESH_MS).unref();
  }

  /** For the statistics: films still wished for, and those watched since ({ ...film, seenAt }). */
  async function entries() {
    const list = await load();
    return { open: list.films, done: list.done ?? [] };
  }

  return { start, refresh, handleInteraction, entries };
}
