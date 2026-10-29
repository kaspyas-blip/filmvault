import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits,
  MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { readFile, rm, stat } from 'node:fs/promises';
import { config } from './config.js';
import { keepHelpLast } from './help.js';
import { addWatch, entryKey, history, recordWatch, removeWatch } from './history.js';
import {
  SORTS, audioTracks, defaultTracks, downloadPoster, durationSeconds, getItem, isCzech, itemLabel, listEpisodes, listGenres,
  listLibrary, listSeasons, mediaSource, nextEpisode, resumeSeconds, saveProgress, searchItems, subtitleTracks, trackLabel,
} from './jellyfin.js';
import { movieInfoEnabled } from './movieinfo.js';
import { UserError } from './player.js';
import { formatTime, parseTime, parseWhen } from './time.js';
import { createWishlist } from './wishlist.js';

const ALONE_LEAVE_MS = 2 * 60_000;
const ITEM_CACHE_MS = 60_000;
const ITEM_ID = /^[0-9a-f]{32}$/i;
const SUBTITLES_OFF = 'off';
const LIST_PAGE_SIZE = 20;
const EPISODE_PAGE_SIZE = 25;
const HISTORY_PAGE_SIZE = 15;
const NEXT_EPISODE_DELAY_MS = 15_000;
const PROGRESS_SAVE_MS = 60_000;
const CZECH_LIST_CACHE_MS = 5 * 60_000;
const GENRE_CACHE_MS = 10 * 60_000;
const SLOW_LIST_MS = Number(process.env.SLOW_LIST_MS ?? 1500);
// Played this close to the end counts as watched (credits).
const WATCHED_TAIL = 0.92;
const AUTOPLAY_FILE = 'data/autoplay.json';
const AUTOPLAY_MAX_AGE_MS = 10 * 60_000;

const commands = [
  new SlashCommandBuilder().setName('pust').setDescription('Pustí film nebo díl do kina')
    .addStringOption(o => o.setName('film').setDescription('Název filmu').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('od').setDescription('Odkud začít, např. 1:20:00 nebo 45 (minut); 0 = od začátku'))
    .addStringOption(o => o.setName('zvuk').setDescription('Zvuková stopa').setAutocomplete(true))
    .addStringOption(o => o.setName('titulky').setDescription('Titulky').setAutocomplete(true)),
  new SlashCommandBuilder().setName('pauza').setDescription('Pozastaví přehrávání'),
  new SlashCommandBuilder().setName('pokracuj').setDescription('Pokračuje v přehrávání'),
  new SlashCommandBuilder().setName('posun').setDescription('Posune přehrávání')
    .addStringOption(o => o.setName('cas').setDescription('1:20:00 = na čas, +5 / -2 = o minuty, +30s = o sekundy').setRequired(true)),
  new SlashCommandBuilder().setName('zvuk').setDescription('Změní zvukovou stopu')
    .addStringOption(o => o.setName('stopa').setDescription('Zvuková stopa').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('titulky').setDescription('Zapne, změní nebo vypne titulky')
    .addStringOption(o => o.setName('stopa').setDescription('Titulky').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('filmy').setDescription('Vypíše filmy v Jellyfinu, volitelně s filtrem')
    .addStringOption(o => o.setName('zanr').setDescription('Jen tento žánr').setAutocomplete(true))
    .addStringOption(o => o.setName('rok').setDescription('Rok nebo rozsah, např. 2005 nebo 1990-1999'))
    .addBooleanOption(o => o.setName('cesky').setDescription('Jen filmy s českým dabingem'))
    .addStringOption(o => o.setName('razeni').setDescription('Řazení').addChoices(
      { name: 'podle názvu', value: 'nazev' },
      { name: 'naposledy přidané', value: 'pridano' },
      { name: 'od nejnovějších', value: 'rok' },
      { name: 'podle hodnocení', value: 'hodnoceni' },
    ))
    .addIntegerOption(o => o.setName('strana').setDescription('Číslo strany').setMinValue(1)),
  new SlashCommandBuilder().setName('serialy').setDescription('Vypíše seriály, pak vybereš sérii a díl')
    .addIntegerOption(o => o.setName('strana').setDescription('Číslo strany').setMinValue(1)),
  new SlashCommandBuilder().setName('videli').setDescription('Co jsme už viděli a kde jsme skončili')
    .addIntegerOption(o => o.setName('strana').setDescription('Číslo strany').setMinValue(1)),
  new SlashCommandBuilder().setName('zapsat').setDescription('Ručně zapíše do historie něco, co jste viděli jinde')
    .addStringOption(o => o.setName('film').setDescription('Název filmu nebo dílu').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('kdy').setDescription('Kdy, např. včera, 28.10. nebo 28.10. 21:30; prázdné = teď'))
    .addStringOption(o => o.setName('skoncili').setDescription('Kde jste skončili, např. 1:20:00; prázdné = dokoukáno')),
  new SlashCommandBuilder().setName('hraje').setDescription('Ukáže, co právě hraje'),
  new SlashCommandBuilder().setName('stop').setDescription('Zastaví přehrávání'),
  new SlashCommandBuilder().setName('odejdi').setDescription('Zastaví přehrávání a odpojí se z hovoru'),
].map(c => c.toJSON());

export function startBot(player) {
  // Message content is for the wishlist room, where people just write movie titles.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  let wishlist = null;
  const itemCache = new Map();
  const czechListCache = new Map();
  let genreCache = null;
  let nowPlaying = null; // { message, requestedBy, resumedFrom }
  let nextUp = null; // { message, item, tracks, timer }
  let lastTracks = null; // track languages of the item that just stopped, for the next episode
  let aloneTimer = null;
  let guildId = null;
  let textChannelId = null;
  let voiceChannelId = null;

  // Matches a configured channel by ID, exact name, or a unique partial name (e.g. "🎬・film").
  function findChannel(guild, wanted, isVoice) {
    const candidates = guild.channels.cache.filter(c => (isVoice ? c.isVoiceBased() : c.isTextBased() && !c.isVoiceBased()));
    const byId = candidates.get(wanted);
    if (byId) return byId;
    const name = wanted.toLowerCase();
    const exact = candidates.filter(c => c.name.toLowerCase() === name);
    if (exact.size === 1) return exact.first();
    const partial = candidates.filter(c => c.name.toLowerCase().includes(name));
    if (partial.size === 1) return partial.first();
    throw new Error(`Cannot find ${isVoice ? 'voice' : 'text'} channel "${wanted}" (${exact.size || partial.size} matches)`);
  }

  async function resolveGuild() {
    if (config.guildId) return client.guilds.fetch(config.guildId);
    const guilds = await client.guilds.fetch();
    if (guilds.size !== 1) throw new Error(`Bot is on ${guilds.size} servers, set GUILD_ID in .env`);
    return guilds.first().fetch();
  }

  async function cachedItem(id) {
    const hit = itemCache.get(id);
    if (hit && hit.expires > Date.now()) return hit.item;
    const item = await getItem(id);
    itemCache.set(id, { item, expires: Date.now() + ITEM_CACHE_MS });
    return item;
  }

  async function resolveItem(value) {
    if (ITEM_ID.test(value)) return cachedItem(value);
    const [hit] = await searchItems(value, 1);
    if (!hit) throw new UserError(`Nic jako „${value}“ jsem v Jellyfinu nenašel.`);
    return cachedItem(hit.Id);
  }

  function choiceName(text) {
    return text.length > 100 ? `${text.slice(0, 99)}…` : text;
  }

  function filterTracks(tracks, query) {
    const q = query.toLowerCase();
    return tracks.filter(t => trackLabel(t).toLowerCase().includes(q));
  }

  function trackChoices(source, kind, query) {
    if (kind === 'audio') {
      return filterTracks(audioTracks(source), query).map(t => ({ name: choiceName(trackLabel(t)), value: String(t.Index) }));
    }
    const choices = filterTracks(subtitleTracks(source), query).map(t => ({
      name: choiceName(trackLabel(t)), value: String(t.Index),
    }));
    return [{ name: 'Vypnout titulky', value: SUBTITLES_OFF }, ...choices];
  }

  async function autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    let choices = [];
    if (interaction.commandName === 'filmy') {
      const q = focused.value.toLowerCase();
      choices = (await genres()).filter(g => g.Name.toLowerCase().includes(q)).map(g => ({ name: choiceName(g.Name), value: g.Id }));
    } else if (['pust', 'zapsat'].includes(interaction.commandName) && focused.name === 'film') {
      const items = await searchItems(focused.value, 25);
      choices = items.map(item => ({ name: choiceName(itemLabel(item)), value: item.Id }));
    } else if (interaction.commandName === 'pust') {
      const film = interaction.options.getString('film');
      if (film && ITEM_ID.test(film)) {
        const source = mediaSource(await cachedItem(film));
        choices = trackChoices(source, focused.name === 'zvuk' ? 'audio' : 'subtitle', focused.value);
      }
    } else if (player.source) {
      choices = trackChoices(player.source, interaction.commandName === 'zvuk' ? 'audio' : 'subtitle', focused.value);
    }
    await interaction.respond(choices.slice(0, 25));
  }

  function controls(disabled = false) {
    const button = (id, label, style = ButtonStyle.Secondary) =>
      new ButtonBuilder().setCustomId(`fv:${id}`).setLabel(label).setStyle(style).setDisabled(disabled);
    const rows = [new ActionRowBuilder().addComponents(
      button('back60', '−1 min'),
      button('toggle', player.paused ? '▶ Pokračovat' : '⏸ Pauza', ButtonStyle.Primary),
      button('fwd60', '+1 min'),
      button('fwd600', '+10 min'),
      button('stop', '⏹ Stop', ButtonStyle.Danger),
    )];
    if (nowPlaying?.resumedFrom) rows.push(new ActionRowBuilder().addComponents(button('restart', '⏮ Pustit od začátku')));
    return rows;
  }

  function nowPlayingEmbed({ hasPoster = false } = {}) {
    const { item } = player;
    const embed = new EmbedBuilder()
      .setColor(player.paused ? 0xf0b232 : 0x5865f2)
      .setTitle(itemLabel(item))
      .addFields(
        { name: 'Stav', value: player.paused ? '⏸ Pozastaveno' : '▶ Hraje', inline: true },
        { name: 'Čas', value: `${formatTime(player.position())} / ${formatTime(player.duration)}`, inline: true },
        { name: 'Zvuk', value: player.audioTrack ? trackLabel(player.audioTrack) : '—', inline: false },
        { name: 'Titulky', value: player.subtitleTrack ? trackLabel(player.subtitleTrack) : 'vypnuto', inline: false },
      );
    if (item.Overview) embed.setDescription(item.Overview.length > 300 ? `${item.Overview.slice(0, 299)}…` : item.Overview);
    if (hasPoster) embed.setThumbnail('attachment://poster.jpg');
    if (nowPlaying?.requestedBy) embed.setFooter({ text: `Spustil(a): ${nowPlaying.requestedBy}` });
    return embed;
  }

  function endedEmbed(item, text) {
    return new EmbedBuilder().setColor(0x4e5058).setTitle(itemLabel(item)).setDescription(text);
  }

  async function retireNowPlaying(item, text) {
    const message = nowPlaying?.message;
    nowPlaying = null;
    if (!message) return;
    await message.edit({ content: '', embeds: [endedEmbed(item, text)], components: [], attachments: [] }).catch(() => {});
  }

  async function refreshNowPlaying() {
    if (!nowPlaying?.message || !player.active) return;
    const hasPoster = nowPlaying.message.attachments.size > 0;
    await nowPlaying.message.edit({ embeds: [nowPlayingEmbed({ hasPoster })], components: controls() }).catch(() => {});
  }

  function allowed(interaction) {
    const wanted = config.allowedRole;
    if (!wanted) return true;
    const roles = interaction.member?.roles?.cache;
    return !!roles?.some(role => role.id === wanted || role.name.toLowerCase() === wanted.toLowerCase());
  }

  function requireActive() {
    if (!player.active) throw new UserError('Teď nic nehraje. Pusť něco přes /pust.');
  }

  function userName(interaction) {
    return interaction.member?.displayName ?? interaction.user.username;
  }

  async function handlePlay(interaction) {
    const od = interaction.options.getString('od');
    const start = od ? parseTime(od) : null;
    if (od && (!start || start.relative)) throw new UserError('Čas začátku zadej třeba jako 1:20:00 nebo 45 (minut).');
    await interaction.deferReply();
    const item = await resolveItem(interaction.options.getString('film', true));
    await startPlayback(interaction, item, {
      startSeconds: start?.seconds ?? null,
      zvuk: interaction.options.getString('zvuk'),
      titulky: interaction.options.getString('titulky'),
    });
  }

  // Expects a deferred reply; it becomes the now-playing message.
  function startPlayback(interaction, item, options) {
    return beginPlayback(item, options, userName(interaction), payload => interaction.editReply(payload));
  }

  /**
   * startSeconds null = resume where it was left off. Tracks not chosen explicitly
   * default to Czech audio, else Czech subtitles (see defaultTracks).
   */
  async function beginPlayback(item, { startSeconds = null, zvuk = null, titulky = null, tracks = null } = {}, requestedBy, send) {
    await cancelNextUp('Pustilo se něco jiného.');
    const source = mediaSource(item);
    const defaults = tracks ?? defaultTracks(source, zvuk && zvuk !== SUBTITLES_OFF ? Number(zvuk) : null);
    const resumedFrom = startSeconds === null ? resumeSeconds(item) : null;
    const previous = player.item;
    await player.play({
      item,
      channelId: voiceChannelId,
      startSeconds: resumedFrom ?? startSeconds ?? 0,
      audioIndex: defaults.audioIndex,
      subtitleIndex: titulky ? (titulky === SUBTITLES_OFF ? null : Number(titulky)) : defaults.subtitleIndex,
    });
    if (previous) await retireNowPlaying(previous, 'Přepnuto na jiný film.');

    const poster = await downloadPoster(item);
    nowPlaying = { message: null, requestedBy, resumedFrom };
    const resumeNote = resumedFrom ? ` Navazuje od ${formatTime(resumedFrom)}, kde jste skončili.` : '';
    nowPlaying.message = await send({
      content: `🍿 Běží v <#${voiceChannelId}>. Připoj se a klikni na živé vysílání.${resumeNote}`,
      embeds: [nowPlayingEmbed({ hasPoster: !!poster })],
      components: controls(),
      files: poster ? [new AttachmentBuilder(poster, { name: 'poster.jpg' })] : [],
    });
    checkAlone();
  }

  // ---- Next episode -------------------------------------------------------

  /** Same audio/subtitle languages as the previous episode, falling back to the defaults. */
  function carryTracks(source, previous) {
    const sameAudio = previous?.audio?.Language && audioTracks(source).find(t => t.Language === previous.audio.Language);
    const base = defaultTracks(source, sameAudio?.Index ?? null);
    if (!previous) return base;
    if (!previous.subtitle) {
      // Subtitles were off: stay off, except Czech forced ones under Czech audio.
      const audio = audioTracks(source).find(t => t.Index === base.audioIndex);
      return { ...base, subtitleIndex: audio && isCzech(audio) ? base.subtitleIndex : null };
    }
    const sameSubtitle = subtitleTracks(source).find(t =>
      t.Language === previous.subtitle.Language && !!t.IsForced === !!previous.subtitle.IsForced
      && (t.IsTextSubtitleStream || !t.IsExternal));
    return { ...base, subtitleIndex: sameSubtitle?.Index ?? base.subtitleIndex };
  }

  function textChannel() {
    return client.channels.cache.get(textChannelId);
  }

  function peopleInVoice() {
    const channel = client.channels.cache.get(voiceChannelId);
    const streamerId = player.streamer.client.user?.id;
    return channel?.members?.filter(m => !m.user.bot && m.id !== streamerId).size ?? 0;
  }

  async function offerNextEpisode(item) {
    const next = await nextEpisode(item).catch(error => {
      console.error('Next episode lookup failed:', error.message);
      return null;
    });
    if (!next) return retireNowPlaying(item, '🎬 Dohráno.');
    const message = nowPlaying?.message;
    nowPlaying = null;
    const seconds = NEXT_EPISODE_DELAY_MS / 1000;
    const payload = {
      content: '',
      embeds: [endedEmbed(item, `🎬 Dohráno.\n\n▶ Další díl **${itemLabel(next)}** se pustí za ${seconds} s.`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fn:now').setLabel('▶ Pustit hned').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('fn:cancel').setLabel('✖ Nepouštět').setStyle(ButtonStyle.Secondary),
      )],
      attachments: [],
    };
    const offer = message ? await message.edit(payload).catch(() => null) : await textChannel()?.send(payload).catch(() => null);
    nextUp = {
      message: offer,
      item: next,
      tracks: lastTracks,
      timer: setTimeout(() => playNextUp('automaticky').catch(error => console.error('Next episode failed:', error)), NEXT_EPISODE_DELAY_MS),
    };
  }

  async function cancelNextUp(text) {
    const pending = nextUp;
    if (!pending) return;
    nextUp = null;
    clearTimeout(pending.timer);
    await pending.message?.edit({ embeds: [endedEmbed(pending.item, text)], components: [] }).catch(() => {});
  }

  async function playNextUp(requestedBy) {
    const pending = nextUp;
    if (!pending || player.active) return;
    if (!peopleInVoice()) return cancelNextUp('Nikdo není v hovoru, další díl se nepustil.');
    nextUp = null;
    clearTimeout(pending.timer);
    await pending.message?.edit({ embeds: [endedEmbed(pending.item, '▶ Pouštím další díl.')], components: [] }).catch(() => {});
    const item = await getItem(pending.item.Id);
    const channel = textChannel();
    try {
      await beginPlayback(item, { tracks: carryTracks(mediaSource(item), pending.tracks) }, requestedBy, payload => channel.send(payload));
    } catch (error) {
      await channel?.send(`Další díl se nepodařilo pustit: ${error.message}`).catch(() => {});
      throw error;
    }
  }

  // ---- Progress -----------------------------------------------------------

  async function storeProgress({ item, position, finished, startedAt, audio, subtitle }, requestedBy) {
    itemCache.delete(item.Id);
    lastTracks = { audio, subtitle };
    const duration = durationSeconds(item);
    const watched = finished || (duration && position >= duration * WATCHED_TAIL);
    await Promise.all([
      recordWatch({ id: item.Id, label: itemLabel(item), by: requestedBy, startedAt, position, duration, finished: !!watched }),
      position >= 60 || watched
        ? saveProgress(item.Id, { seconds: position, played: !!watched }).catch(error => console.error('Saving progress failed:', error.message))
        : null,
    ]);
    wishlist?.refresh();
  }

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
      if (!match) throw new UserError(`Žánr „${genre}“ neznám. Vyber ho z nabídky.`);
      filter.genreId = match.Id;
    }
    const year = options.getString('rok')?.trim();
    if (year) {
      const m = /^(\d{4})(?:\s*[-–]\s*(\d{4}))?$/.exec(year);
      if (!m) throw new UserError('Rok zadej jako 2005 nebo 1990-1999.');
      const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])].sort((a, b) => a - b);
      if (to - from > 150) throw new UserError('Takhle velký rozsah let nedává smysl.');
      Object.assign(filter, { yearFrom: from, yearTo: to });
    }
    return filter;
  }

  async function filterTitle(filter) {
    const parts = [];
    if (filter.genreId) parts.push((await genres()).find(g => g.Id === filter.genreId)?.Name ?? 'žánr');
    if (filter.yearFrom) parts.push(filter.yearFrom === filter.yearTo ? String(filter.yearFrom) : `${filter.yearFrom}–${filter.yearTo}`);
    if (filter.czech) parts.push('český dabing');
    return parts.join(' · ');
  }

  // Jellyfin cannot filter by audio language, so the Czech-dub filter loads the
  // matching movies with their streams and pages locally.
  async function czechMovies(filter) {
    const key = encodeFilter(filter);
    const hit = czechListCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.items;
    const { items } = await listLibrary('Movie', undefined, undefined, { ...filter, fields: 'ProductionYear,MediaStreams' });
    const czech = items.filter(item => item.MediaStreams?.some(s => s.Type === 'Audio' && isCzech(s)));
    czechListCache.set(key, { items: czech, expires: Date.now() + CZECH_LIST_CACHE_MS });
    return czech;
  }

  function formatDate(ms) {
    return new Date(ms).toLocaleString('cs-CZ', {
      timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  async function historyList(page, notice = '') {
    const entries = await history();
    const pages = Math.max(1, Math.ceil(entries.length / HISTORY_PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const shown = entries.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE);
    const lines = shown.map(e => {
      const state = e.finished ? '✅ dokoukáno' : `⏸ skončili jsme v ${formatTime(e.position)}${e.duration ? ` / ${formatTime(e.duration)}` : ''}`;
      return `**${e.label}**\n${formatDate(e.endedAt)} · ${state} · ${e.manual ? '✍️ ' : ''}${e.by ?? '?'}`;
    });
    const components = [pageButtons('fh', page, pages)];
    if (shown.length) {
      // Select menu values must be unique.
      const removable = [...new Map(shown.map(e => [entryKey(e), e])).values()];
      components.unshift(selectRow(`fh:del:${page}`, '🗑 Odebrat z historie…', removable.map(e => ({
        label: choiceName(e.label), description: formatDate(e.endedAt), value: entryKey(e),
      }))));
    }
    const unfinished = [...new Map(shown.filter(e => !e.finished).map(e => [e.id, e])).values()];
    if (unfinished.length) {
      components.unshift(selectRow('fh:play', 'Pokračovat ve sledování…',
        unfinished.map(e => ({ label: choiceName(e.label), description: `od ${formatTime(e.position)}`, value: e.id }))));
    }
    const embed = listEmbed('🕒 Co jsme viděli', lines, `Strana ${page} / ${pages}`);
    if (!entries.length) {
      embed.setDescription('Zatím nic. Historie se plní sama, započítá se, co běželo aspoň 2 minuty. Ručně přidáš přes /zapsat.');
    }
    return { content: notice, embeds: [embed], components };
  }

  function selectRow(id, placeholder, options) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id).setPlaceholder(placeholder).addOptions(options));
  }

  function listEmbed(title, lines, footer) {
    return new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(lines.join('\n') || 'Nic tu není.').setFooter({ text: footer });
  }

  const LIBRARIES = {
    movies: { type: 'Movie', prefix: 'fl', select: 'fl:play', title: '🎞️ Filmy v Jellyfinu', placeholder: 'Pustit film z této strany…' },
    series: { type: 'Series', prefix: 'fs:list', select: 'fs:series', title: '📺 Seriály v Jellyfinu', placeholder: 'Vybrat seriál z této strany…' },
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

  const WATCH_LEGEND = ' · ✅ viděli · ⏸ rozkoukané';

  async function libraryList(kind, page, filter = {}) {
    const library = LIBRARIES[kind];
    const start = (page - 1) * LIST_PAGE_SIZE;
    let items;
    let total;
    if (filter.czech) {
      const all = await czechMovies(filter);
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
    return { embeds: [listEmbed(title, lines, `Strana ${page} / ${pages}${sort}${legend}`)], components };
  }

  async function seasonList(seriesId) {
    const seasons = (await listSeasons(seriesId)).slice(0, 25);
    const series = await cachedItem(seriesId);
    const lines = seasons.map(s => `• ${s.Name}${s.ChildCount ? ` (${s.ChildCount} dílů)` : ''}`);
    const components = [new ActionRowBuilder().addComponents(button('fs:list:back:1', '⬅ Seriály'))];
    if (seasons.length) {
      components.unshift(selectRow('fs:season', 'Vybrat sérii…',
        seasons.map(s => ({ label: choiceName(s.Name), value: `${seriesId}:${s.Id}` }))));
    }
    return { embeds: [listEmbed(`📺 ${itemLabel(series)}`, lines, 'Vyber sérii')], components };
  }

  async function episodeList(seriesId, seasonId, page) {
    const episodes = await listEpisodes(seriesId, seasonId);
    const pages = Math.max(1, Math.ceil(episodes.length / EPISODE_PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const shown = episodes.slice((page - 1) * EPISODE_PAGE_SIZE, page * EPISODE_PAGE_SIZE);
    const label = e => `E${String(e.IndexNumber ?? 0).padStart(2, '0')} ${e.Name}`;
    const first = episodes[0];
    const title = first ? `📺 ${first.SeriesName} – ${first.SeasonName}` : '📺 Série';
    const states = await watchStates();
    const components = [pageButtons(`fs:eps:${seriesId}:${seasonId}`, page, pages, [button(`fs:seasons:${seriesId}`, '⬅ Série')])];
    if (shown.length) {
      components.unshift(selectRow('fs:play', 'Pustit díl…', shown.map(e => ({
        label: choiceName(label(e)), value: e.Id, emoji: watchEmoji(states.get(e.Id)),
      }))));
    }
    const lines = shown.map(e => label(e) + watchMark(states.get(e.Id)));
    return { embeds: [listEmbed(title, lines, `Strana ${page} / ${pages}${WATCH_LEGEND}`)], components };
  }

  async function handleListInteraction(interaction) {
    const [prefix, action, ...rest] = interaction.customId.split(':');
    if (interaction.isStringSelectMenu()) {
      const [value] = interaction.values;
      if (prefix === 'fh' && action === 'del') {
        await interaction.deferUpdate();
        const removed = await removeWatch(value);
        wishlist?.refresh();
        const notice = removed
          ? `🗑 Odebráno z historie: **${removed.label}** (${formatDate(removed.endedAt)})`
          : 'Tenhle záznam už v historii není.';
        return interaction.editReply(await historyList(Number(rest[0]), notice));
      }
      if (action === 'play') {
        await interaction.deferReply();
        return startPlayback(interaction, await cachedItem(value));
      }
      await interaction.deferUpdate();
      if (action === 'series') return interaction.editReply(await seasonList(value));
      const [seriesId, seasonId] = value.split(':');
      return interaction.editReply(await episodeList(seriesId, seasonId, 1));
    }
    await interaction.deferUpdate();
    // fl:<nav>:<page>:<filter>, fh:<nav>:<page>
    if (prefix === 'fl') return interaction.editReply(await libraryList('movies', Number(rest[0]), decodeFilter(rest[1])));
    if (prefix === 'fh') return interaction.editReply(await historyList(Number(rest[0])));
    const page = Number(rest.at(-1));
    if (action === 'list') return interaction.editReply(await libraryList('series', page));
    if (action === 'seasons') return interaction.editReply(await seasonList(rest[0]));
    // fs:eps:<seriesId>:<seasonId>:<nav>:<page>
    return interaction.editReply(await episodeList(rest[0], rest[1], page));
  }

  async function seekBy(delta) {
    requireActive();
    await player.seek(player.position() + delta);
  }

  async function handleSeek(interaction) {
    requireActive();
    const parsed = parseTime(interaction.options.getString('cas', true));
    if (!parsed) throw new UserError('Nerozumím času. Zkus 1:20:00, +5, -2 nebo +30s.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = parsed.relative ? player.position() + parsed.seconds : parsed.seconds;
    await player.seek(target);
    await refreshNowPlaying();
    await interaction.editReply(`⏩ Posunuto na ${formatTime(player.position())}.`);
  }

  async function handleTrack(interaction, kind) {
    requireActive();
    const value = interaction.options.getString('stopa', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (kind === 'audio') {
      const index = Number(value);
      if (!audioTracks(player.source).some(t => t.Index === index)) throw new UserError('Takovou zvukovou stopu film nemá.');
      await player.setTracks({ audioIndex: index });
      await interaction.editReply(`🔊 Zvuk: ${trackLabel(player.audioTrack)}`);
    } else {
      const index = value === SUBTITLES_OFF ? null : Number(value);
      await player.setTracks({ subtitleIndex: index });
      await interaction.editReply(player.subtitleTrack ? `💬 Titulky: ${trackLabel(player.subtitleTrack)}` : '💬 Titulky vypnuty.');
    }
    await refreshNowPlaying();
  }

  async function handleAddWatch(interaction) {
    const endedAt = parseWhen(interaction.options.getString('kdy'));
    if (endedAt === null) throw new UserError('Nerozumím datu. Zkus včera, 28.10., 28.10.2026 nebo 28.10. 21:30.');
    if (endedAt > Date.now() + 60_000) throw new UserError('To je v budoucnu. Zapsat jde jen to, co už jste viděli.');
    const stopped = interaction.options.getString('skoncili');
    const parsed = stopped ? parseTime(stopped) : null;
    if (stopped && (!parsed || parsed.relative)) throw new UserError('Kde jste skončili, zadej jako 1:20:00 nebo 45 (minut).');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const item = await resolveItem(interaction.options.getString('film', true));
    const duration = durationSeconds(item);
    const finished = !parsed || (!!duration && parsed.seconds >= duration * WATCHED_TAIL);
    const position = finished ? duration ?? 0 : parsed.seconds;
    await addWatch({ id: item.Id, label: itemLabel(item), by: userName(interaction), endedAt, position, duration, finished });
    wishlist?.refresh();
    const state = finished ? 'jako dokoukané' : `se skončením v ${formatTime(position)}`;
    return interaction.editReply(`✍️ Zapsáno do historie: **${itemLabel(item)}**, ${formatDate(endedAt)}, ${state}. Odebrat jde v /videli.`);
  }

  async function handleCommand(interaction) {
    switch (interaction.commandName) {
      case 'pust':
        return handlePlay(interaction);
      case 'pauza':
        requireActive();
        await player.pause();
        await refreshNowPlaying();
        return interaction.reply({ content: `⏸ Pozastaveno na ${formatTime(player.position())}.`, flags: MessageFlags.Ephemeral });
      case 'pokracuj':
        requireActive();
        await player.resume();
        await refreshNowPlaying();
        return interaction.reply({ content: '▶ Pokračuje se.', flags: MessageFlags.Ephemeral });
      case 'posun':
        return handleSeek(interaction);
      case 'zvuk':
        return handleTrack(interaction, 'audio');
      case 'titulky':
        return handleTrack(interaction, 'subtitle');
      case 'filmy': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const filter = await filterFromOptions(interaction.options);
        return interaction.editReply(await libraryList('movies', interaction.options.getInteger('strana') ?? 1, filter));
      }
      case 'videli':
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await historyList(interaction.options.getInteger('strana') ?? 1));
      case 'zapsat':
        return handleAddWatch(interaction);
      case 'serialy':
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await libraryList('series', interaction.options.getInteger('strana') ?? 1));
      case 'hraje':
        requireActive();
        return interaction.reply({ embeds: [nowPlayingEmbed()], flags: MessageFlags.Ephemeral });
      case 'stop': {
        requireActive();
        const item = player.item;
        await player.stop();
        await retireNowPlaying(item, `⏹ Zastaveno (${interaction.member?.displayName ?? interaction.user.username}).`);
        return interaction.reply({ content: '⏹ Zastaveno.', flags: MessageFlags.Ephemeral });
      }
      case 'odejdi': {
        const item = player.item;
        await cancelNextUp('Další díl se nepustí, kino odešlo z hovoru.');
        await player.leave();
        if (item) await retireNowPlaying(item, '⏹ Zastaveno, odpojeno z hovoru.');
        return interaction.reply({ content: '👋 Odpojeno.', flags: MessageFlags.Ephemeral });
      }
    }
  }

  async function handleButton(interaction) {
    if (!player.active || nowPlaying?.message?.id !== interaction.message.id) {
      return interaction.reply({ content: 'Tohle přehrávání už skončilo.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferUpdate();
    const action = interaction.customId.slice(3);
    if (action === 'stop') {
      const item = player.item;
      await player.stop();
      return retireNowPlaying(item, `⏹ Zastaveno (${interaction.member?.displayName ?? interaction.user.username}).`);
    }
    if (action === 'restart') {
      nowPlaying.resumedFrom = null;
      await player.seek(0);
    } else if (action === 'toggle') await (player.paused ? player.resume() : player.pause());
    else if (action === 'back60') await seekBy(-60);
    else if (action === 'fwd60') await seekBy(60);
    else if (action === 'fwd600') await seekBy(600);
    await refreshNowPlaying();
  }

  async function replyError(interaction, error) {
    const text = error instanceof UserError ? error.message : `Něco se pokazilo: ${error.message}`;
    if (!(error instanceof UserError)) console.error(error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }

  // Leave when everyone else has left the voice channel.
  function checkAlone() {
    const channel = player.channelId && client.channels.cache.get(player.channelId);
    const streamerId = player.streamer.client.user?.id;
    const people = channel?.members?.filter(m => !m.user.bot && m.id !== streamerId).size ?? 0;
    if (!player.channelId || people > 0) {
      clearTimeout(aloneTimer);
      aloneTimer = null;
      return;
    }
    aloneTimer ??= setTimeout(async () => {
      aloneTimer = null;
      const item = player.item;
      await player.leave().catch(error => console.error('Leave failed:', error));
      if (item) await retireNowPlaying(item, '👋 Všichni odešli, přehrávání zastaveno.');
    }, ALONE_LEAVE_MS);
  }

  async function handleNextUpButton(interaction) {
    if (!nextUp || nextUp.message?.id !== interaction.message.id) {
      return interaction.reply({ content: 'Tahle nabídka už neplatí.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferUpdate();
    if (interaction.customId === 'fn:cancel') return cancelNextUp(`Další díl se nepustí (${userName(interaction)}).`);
    return playNextUp(userName(interaction));
  }

  player.on('stopped', event => {
    storeProgress(event, nowPlaying?.requestedBy).catch(error => console.error('Recording progress failed:', error));
  });
  player.on('ended', item => {
    const offer = item.Type === 'Episode' ? offerNextEpisode(item) : retireNowPlaying(item, '🎬 Dohráno.');
    offer.catch(error => console.error('Finishing playback failed:', error));
  });
  player.on('failed', (item, message, position) =>
    retireNowPlaying(item, `⚠️ Přehrávání spadlo v čase ${formatTime(position)}: ${message}\nZkus znovu \`/pust\`, naváže od místa, kde to spadlo.`));

  // Keep the resume position fresh in case the MiniPC or bot dies mid-film.
  let lastSaved = null;
  setInterval(() => {
    if (!player.active || player.paused) return;
    const position = player.position();
    if (position < 60 || lastSaved === Math.round(position)) return;
    lastSaved = Math.round(position);
    saveProgress(player.item.Id, { seconds: position }).catch(error => console.error('Saving progress failed:', error.message));
  }, PROGRESS_SAVE_MS).unref();

  client.on('voiceStateUpdate', () => checkAlone());

  client.on('interactionCreate', async interaction => {
    if (!guildId || interaction.guildId !== guildId) return;
    if (interaction.isAutocomplete()) {
      return autocomplete(interaction).catch(error => {
        console.error('Autocomplete failed:', error.message);
        return interaction.respond([]).catch(() => {});
      });
    }
    if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith('fw:')) {
      if (!wishlist) return interaction.reply({ content: 'Seznam filmů teď nefunguje.', flags: MessageFlags.Ephemeral });
      return wishlist.handleInteraction(interaction).catch(error => replyError(interaction, error));
    }
    const isList = (interaction.isButton() || interaction.isStringSelectMenu()) && /^f[lsh]:/.test(interaction.customId);
    const isNextUp = interaction.isButton() && interaction.customId.startsWith('fn:');
    if (!interaction.isChatInputCommand() && !isList && !isNextUp && !(interaction.isButton() && interaction.customId.startsWith('fv:'))) return;
    if (interaction.channelId !== textChannelId) {
      return interaction.reply({ content: `Kino se ovládá jen v <#${textChannelId}>.`, flags: MessageFlags.Ephemeral });
    }
    if (!allowed(interaction)) {
      return interaction.reply({ content: 'Na ovládání kina nemáš oprávnění.', flags: MessageFlags.Ephemeral });
    }
    const received = Date.now();
    // Each Discord call as "<ms after arrival>+<ms it took>", to tell our work from Discord's.
    const calls = {};
    if (isList) {
      for (const name of ['deferUpdate', 'deferReply', 'editReply']) {
        const call = interaction[name].bind(interaction);
        interaction[name] = async (...args) => {
          const start = Date.now();
          try {
            return await call(...args);
          } finally {
            calls[name] = `${start - received}+${Date.now() - start}`;
          }
        };
      }
    }
    try {
      if (isList) await handleListInteraction(interaction);
      else if (isNextUp) await handleNextUpButton(interaction);
      else if (interaction.isButton()) await handleButton(interaction);
      else await handleCommand(interaction);
    } catch (error) {
      await replyError(interaction, error);
    } finally {
      const handled = Date.now() - received;
      if (isList && handled > SLOW_LIST_MS) {
        const timings = Object.entries(calls).map(([name, t]) => `${name} ${t}`).join(', ');
        console.warn(`Slow list ${interaction.customId}: arrived after ${received - interaction.createdTimestamp} ms, `
          + `handled in ${handled} ms (${timings})`);
      }
    }
  });

  // Optional: without a TMDB key or the room, the rest of the cinema works as before.
  // Returns the room's channel ID, or null when the wishlist is off.
  async function startWishlist(guild) {
    if (!movieInfoEnabled()) {
      console.log('Wishlist off: no TMDB_API_KEY');
      return null;
    }
    try {
      const room = findChannel(guild, config.wishlistChannel, false);
      wishlist = createWishlist({
        client,
        channelId: room.id,
        allowed,
        userName,
        play: (item, requestedBy) => beginPlayback(item, {}, requestedBy, payload => textChannel().send(payload)),
      });
      await wishlist.start();
      console.log(`Wishlist running in #${room.name}`);
      return room.id;
    } catch (error) {
      wishlist = null;
      console.error('Wishlist failed to start:', error);
      return null;
    }
  }

  /**
   * For deploys during a film: data/autoplay.json ({ "itemId": "...", "by": "name" }),
   * written just before a restart, starts that item again where it left off. One-shot,
   * and ignored when older than AUTOPLAY_MAX_AGE_MS.
   */
  async function playAfterRestart() {
    let request;
    try {
      const { mtimeMs } = await stat(AUTOPLAY_FILE);
      request = Date.now() - mtimeMs < AUTOPLAY_MAX_AGE_MS ? JSON.parse(await readFile(AUTOPLAY_FILE, 'utf8')) : null;
      await rm(AUTOPLAY_FILE, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Autoplay file unreadable:', error.message);
      return;
    }
    if (!request?.itemId) return;
    try {
      const item = await getItem(request.itemId);
      console.log(`Playing ${itemLabel(item)} again after restart`);
      await beginPlayback(item, {}, request.by ?? 'restart', payload => textChannel().send(payload));
    } catch (error) {
      console.error('Autoplay after restart failed:', error);
    }
  }

  client.once('clientReady', async () => {
    console.log(`Control bot ready as ${client.user.tag}`);
    try {
      const guild = await resolveGuild();
      await guild.channels.fetch();
      const text = findChannel(guild, config.textChannel, false);
      const voice = findChannel(guild, config.voiceChannel, true);
      textChannelId = text.id;
      voiceChannelId = voice.id;
      guildId = guild.id;
      player.guildId = guild.id;
      await guild.commands.set(commands);
      console.log(`Registered ${commands.length} slash commands in ${guild.name}; text #${text.name}, voice ${voice.name}`);
      const wishlistChannelId = await startWishlist(guild);
      await keepHelpLast(client, text, voice.id, wishlistChannelId).catch(error => console.error('Help message failed:', error.message));
      await playAfterRestart();
    } catch (error) {
      console.error('Startup failed:', error);
      process.exit(1);
    }
  });

  return client.login(config.botToken).then(() => client);
}
