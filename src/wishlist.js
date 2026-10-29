import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { history } from './history.js';
import { getItem, listLibrary } from './jellyfin.js';
import { findMovie, imdbUrl, movieDetails, normalizeTitle, tmdbUrl } from './movieinfo.js';
import { formatTime } from './time.js';

/**
 * The wishlist room: people write movie titles, the bot looks them up and keeps one
 * list message at the bottom of the room. Each film shows whether it is in Jellyfin;
 * once the cinema finishes it, it drops off (it is in /videli by then). The dice
 * picks a random film that can be played right away.
 */

const FILE = 'data/wishlist.json';
const LIST_TITLE = '🎬 Chceme vidět';
const LIBRARY_CACHE_MS = 10 * 60_000;
const PERIODIC_REFRESH_MS = 15 * 60_000;
const REFRESH_DEBOUNCE_MS = 1500;
const NOT_FOUND_TTL_MS = 30_000;
const MAX_LINES_PER_MESSAGE = 10;
const MAX_TITLE_LENGTH = 80;
const IMPORT_MESSAGES = 200;
const DESCRIPTION_LIMIT = 4000;


function formatDate(ms) {
  return new Date(ms).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric' });
}

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
  let state = null; // { listMessageId, imported, films: [...] }
  let writing = Promise.resolve();
  let library = null; // { expires, byImdb, byTmdb, byTitle }
  let refreshTimer = null;
  let refreshing = Promise.resolve();

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
    const { items } = await listLibrary('Movie', undefined, undefined, { fields: 'ProductionYear,ProviderIds,OriginalTitle' });
    const index = { expires: Date.now() + LIBRARY_CACHE_MS, byImdb: new Map(), byTmdb: new Map(), byTitle: new Map() };
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
      ?? null;
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

  /** Each film with its Jellyfin item and watch state; drops films finished after they were added. */
  async function currentFilms() {
    const list = await load();
    const watch = await watchIndex();
    const rows = [];
    const done = [];
    for (const film of list.films) {
      const item = await jellyfinItem(film);
      const finishedAt = item && watch.finished.get(item.Id);
      if (finishedAt && finishedAt > film.addedAt) {
        done.push(film);
        continue;
      }
      const latest = item && watch.latest.get(item.Id);
      rows.push({ film, item, started: latest && !latest.finished ? latest.position : null, seenAt: finishedAt ?? null });
    }
    if (done.length) {
      list.films = list.films.filter(f => !done.includes(f));
      await save();
      console.log(`Wishlist: removed watched ${done.map(f => f.title).join(', ')}`);
    }
    return rows;
  }

  // ---- Messages -----------------------------------------------------------

  function filmLabel(film) {
    return film.year ? `${film.title} (${film.year})` : film.title;
  }

  function filmLine({ film, item, started }) {
    const mark = !item ? '❌' : started ? '⏸' : '✅';
    const link = imdbUrl(film.imdbId) ?? tmdbUrl(film.tmdbId);
    const parts = [`${mark} [${filmLabel(film)}](${link})`];
    if (film.rating) parts.push(`⭐ ${film.rating}`);
    if (started) parts.push(`skončili jste v ${formatTime(started)}`);
    else if (!item) parts.push('nemáme');
    if (film.addedBy) parts.push(film.addedBy);
    return parts.join(' · ');
  }

  function listPayload(rows) {
    const sorted = [...rows].sort((a, b) => (!!b.item - !!a.item) || a.film.addedAt - b.film.addedAt);
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
    const available = rows.filter(r => r.item).length;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${LIST_TITLE} (${rows.length})`)
      .setDescription(lines.join('\n') || 'Seznam je prázdný. Napiš sem název filmu a přidám ho.')
      .setFooter({ text: `✅ máme (${available}) · ❌ nemáme · ⏸ rozkoukané · Přidáš ho napsáním názvu do této roomky` });
    const components = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fw:roll').setLabel('🎲 Hodit kostkou').setStyle(ButtonStyle.Primary).setDisabled(!available),
    )];
    if (rows.length) {
      components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('fw:del').setPlaceholder('🗑 Odebrat ze seznamu…')
        .addOptions(sorted.slice(0, 25).map(({ film }) => ({ label: filmLabel(film).slice(0, 100), value: String(film.tmdbId) })))));
    }
    return { embeds: [embed], components };
  }

  function cardEmbed(details, { item, seenAt, addedBy }) {
    const embed = new EmbedBuilder()
      .setColor(item ? 0x57f287 : 0x4e5058)
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
    const status = item ? '✅ Máme v Jellyfinu' : '❌ Nemáme v Jellyfinu';
    fields.push({ name: 'Stav', value: seenAt ? `${status} · 👀 už jste viděli ${formatDate(seenAt)}` : status, inline: false });
    embed.addFields(fields);
    if (addedBy) embed.setFooter({ text: `Přidal(a): ${addedBy}` });
    return embed;
  }

  /** Keeps the list message as the last message in the room. */
  async function renderList() {
    const room = channel();
    if (!room) return;
    const list = await load();
    const payload = listPayload(await currentFilms());
    const old = list.listMessageId && await room.messages.fetch(list.listMessageId).catch(() => null);
    if (old && room.lastMessageId === old.id) {
      await old.edit(payload);
      return;
    }
    const sent = await room.send(payload);
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

  async function addFilm(tmdbId, addedBy) {
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
      addedBy,
      addedAt: Date.now(),
    };
    if (!existing) {
      list.films.push(film);
      await save();
    }
    const item = await jellyfinItem(film);
    const seenAt = item ? (await watchIndex()).finished.get(item.Id) ?? null : null;
    return { film, details, existing: !!existing, embed: cardEmbed(details, { item, seenAt, addedBy: film.addedBy }) };
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
          const added = await addFilm(match.tmdbId, by);
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
        const { film, existing } = await addFilm(pick.tmdbId, by).catch(() => ({}));
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

  async function rollPayload() {
    const candidates = (await currentFilms()).filter(r => r.item);
    if (!candidates.length) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const details = await movieDetails(pick.film.tmdbId);
    const embed = cardEmbed(details, { item: pick.item, seenAt: pick.seenAt, addedBy: pick.film.addedBy });
    const note = pick.started ? ` Rozkoukané, naváže od ${formatTime(pick.started)}.` : '';
    return {
      content: `🎲 Kostka vybrala z ${candidates.length} filmů, které máme:${note}`,
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fw:play:${pick.item.Id}`).setLabel('▶ Pustit').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('fw:roll').setLabel('🎲 Hodit znovu').setStyle(ButtonStyle.Secondary),
      )],
    };
  }

  async function handleInteraction(interaction) {
    const [, action, value] = interaction.customId.split(':');
    const ephemeral = content => ({ content, flags: MessageFlags.Ephemeral });

    if (action === 'roll') {
      // From the list: a new message. From a dice message: roll that one again.
      const fromList = interaction.message.embeds[0]?.title?.startsWith(LIST_TITLE);
      if (fromList) await interaction.deferReply();
      else await interaction.deferUpdate();
      const payload = await rollPayload();
      if (!payload) return interaction.editReply({ content: 'Na seznamu není žádný film, který máme v Jellyfinu.', embeds: [], components: [] });
      await interaction.editReply(payload);
      return refresh();
    }

    if (action === 'pick') {
      await interaction.deferUpdate();
      const added = await addFilm(Number(interaction.values[0]), userName(interaction));
      await interaction.editReply({ content: addedText(added), embeds: [added.embed], components: [] });
      return refresh();
    }

    if (!allowed(interaction)) return interaction.reply(ephemeral('Na tohle nemáš oprávnění.'));

    if (action === 'del') {
      const list = await load();
      const tmdbId = Number(interaction.values[0]);
      const film = list.films.find(f => f.tmdbId === tmdbId);
      list.films = list.films.filter(f => f.tmdbId !== tmdbId);
      await save();
      await interaction.reply(ephemeral(film ? `🗑 Odebráno ze seznamu: **${filmLabel(film)}**` : 'Ten už na seznamu není.'));
      return refresh();
    }

    if (action === 'play') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const item = await getItem(value);
      await play(item, userName(interaction));
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
    await renderList();
    setInterval(refresh, PERIODIC_REFRESH_MS).unref();
  }

  return { start, refresh, handleInteraction };
}
