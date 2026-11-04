import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, GatewayIntentBits,
  MessageFlags, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { config } from './config.js';
import { loadGuilds, saveGuilds } from './guilds.js';
import { keepHelpLast } from './help.js';
import { createHistory, entryKey } from './history.js';
import {
  SORTS, audioTracks, authHeader, defaultTracks, downloadPoster, durationSeconds, getItem, isCzech, itemLabel, listEpisodes, listGenres,
  listLibrary, listSeasons, mediaSource, nextEpisode, resumeSeconds, saveProgress, searchItems, subtitleTracks, trackLabel,
} from './jellyfin.js';
import { movieInfoEnabled } from './movieinfo.js';
import { UserError } from './player.js';
import { DEFAULT_QUALITY, QUALITIES, createQualityStore, qualityLabel } from './quality.js';
import { episodeSegments } from './segments.js';
import { SOUND_MODES, createSettings } from './settings.js';
import { PERIODS, computeStats, periodRange, personEmbed, personKeyFor, serverEmbed } from './stats.js';
import { formatTime, parseTime, parseWhen } from './time.js';
import { isLink, isWebUrl, updateYtDlp, webItem } from './web.js';
import { createWishlist } from './wishlist.js';

// The streaming account is on one call at a time, so one film plays across all servers.
const BUSY = 'Kino teď promítá na jiném serveru, zkus to později.';
const YTDLP_UPDATE_MS = 24 * 60 * 60_000;

const ALONE_LEAVE_MS = 2 * 60_000;
const ITEM_CACHE_MS = 60_000;
const ITEM_ID = /^[0-9a-f]{32}$/i;
const SUBTITLES_OFF = 'off';
const LIST_PAGE_SIZE = 20;
const EPISODE_PAGE_SIZE = 25;
const HISTORY_PAGE_SIZE = 15;
const PROGRESS_SAVE_MS = 60_000;
const CZECH_LIST_CACHE_MS = 5 * 60_000;
const GENRE_CACHE_MS = 10 * 60_000;
const SLOW_LIST_MS = Number(process.env.SLOW_LIST_MS ?? 1500);
// Played this close to the end counts as watched (credits).
const WATCHED_TAIL = 0.92;
const POSTER_FILE = 'poster.jpg';
const AUTOPLAY_FILE = 'autoplay.json';
const AUTOPLAY_MAX_AGE_MS = 10 * 60_000;
// What is playing, kept on disk so a crashed or restarted bot can clean up its old
// message and carry on where it was.
const NOW_PLAYING_FILE = 'nowplaying.json';
const NOW_PLAYING_SAVE_MS = 15_000;
// People in the voice room are counted this often for the statistics.
// (Often, so a pause or a start between two counts adds little error.)
const VIEWER_TICK_MS = 5000;
// A failed stream is started again where it fell, this many times within the window.
const RECOVERY_ATTEMPTS = 3;
const RECOVERY_WINDOW_MS = 10 * 60_000;
const RECOVERY_DELAYS_MS = [3000, 15_000, 45_000];
const SUMMARY_CHECK_MS = 60 * 60_000;
const SUMMARY_HOUR = 12;

const commands = [
  new SlashCommandBuilder().setName('pust').setDescription('Pustí film nebo díl do kina')
    .addStringOption(o => o.setName('film').setDescription('Název filmu, nebo odkaz na YouTube či Kick').setRequired(true).setAutocomplete(true))
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
  new SlashCommandBuilder().setName('kvalita').setDescription('Změní kvalitu vysílání pro všechny (bez volby ukáže aktuální)')
    .addStringOption(o => o.setName('uroven').setDescription('Nižší kvalita pomůže, když se obraz seká')
      .addChoices(...Object.keys(QUALITIES).map(key => ({ name: qualityLabel(key), value: key })))),
  new SlashCommandBuilder().setName('hlasitost').setDescription('Režim zvuku pro všechny (bez volby ukáže aktuální)')
    .addStringOption(o => o.setName('rezim').setDescription('Vyrovnaný: dialogy hlasitější, výbuchy tišší')
      .addChoices(...Object.entries(SOUND_MODES).map(([value, name]) => ({ name, value })))),
  new SlashCommandBuilder().setName('statistiky').setDescription('Kdo kouká nejvíc, co nejčastěji, rekordy a odznaky')
    .addUserOption(o => o.setName('kdo').setDescription('Osobní statistiky tohoto člověka'))
    .addStringOption(o => o.setName('obdobi').setDescription('Za jaké období (výchozí celkově)')
      .addChoices(...Object.entries(PERIODS).map(([value, { label }]) => ({ name: label, value })))),
  new SlashCommandBuilder().setName('stav').setDescription('Jak se daří kinu: MiniPC, Jellyfin, vysílání'),
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

// The only command on a server without a cinema yet.
const setupCommand = new SlashCommandBuilder().setName('nastavit').setDescription('Nastaví kino na tomhle serveru (jen pro správce)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(o => o.setName('textovy').setDescription('Kanál, kde se kino ovládá').setRequired(true)
    .addChannelTypes(ChannelType.GuildText))
  .addChannelOption(o => o.setName('hlasovy').setDescription('Hlasový kanál, kam se vysílá').setRequired(true)
    .addChannelTypes(ChannelType.GuildVoice))
  .addChannelOption(o => o.setName('seznam').setDescription('Roomka „Chceme vidět“ (nepovinné)')
    .addChannelTypes(ChannelType.GuildText))
  .addRoleOption(o => o.setName('role').setDescription('Jen tahle role smí ovládat kino (nepovinné, jinak všichni)'))
  .toJSON();

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

/**
 * The cinema of one server: its channels, data and what it plays. All cinemas share
 * the player. busyElsewhere: () => whether another server's cinema holds it.
 */
function createCinema({ client, player, guild, setup, busyElsewhere }) {
  const { textChannelId, voiceChannelId, wishlistChannelId, allowedRole, announceRole, dir } = setup;
  const guildId = guild.id;
  const nowPlayingFile = `${dir}/${NOW_PLAYING_FILE}`;
  const { history, addWatch, recordWatch, removeWatch } = createHistory(dir);
  const { loadSettings, updateSettings } = createSettings(dir);
  const { loadQuality, saveQuality } = createQualityStore(dir);
  let quality = DEFAULT_QUALITY;
  let sound = 'normal';
  let starting = 0; // playbacks being started (the subtitles can take a minute)
  let wishlist = null;
  const itemCache = new Map();
  const czechListCache = new Map();
  let genreCache = null;
  let nowPlaying = null; // { message, requestedBy, requestedById, resumedFrom, poster, next, skipNext }
  let lastTracks = null; // track languages of the item that just stopped, for the next episode
  // Played time and who was in the voice room, for the item now playing (statistics).
  let watching = null; // { itemId, watched, viewers: { id: { name, seconds } }, at }
  const recoveries = new Map(); // item ID -> times it was started again after failing
  let recovery = null; // { item, current } while a failed stream waits to be started again
  const startedAt = Date.now();
  let aloneTimer = null;

  /** Something of this server is playing (the player may be on another server's film). */
  const playing = () => player.active && player.guildId === guildId;

  /** Holds the player: it plays here, or is about to, also between two episodes. */
  const busy = () => starting > 0 || !!recovery || (player.guildId === guildId && (player.active || player.countdown !== null));

  const loadItem = id => (isWebUrl(id) ? webItem(id) : getItem(id));

  async function cachedItem(id) {
    const hit = itemCache.get(id);
    if (hit && hit.expires > Date.now()) return hit.item;
    const item = await loadItem(id);
    itemCache.set(id, { item, expires: Date.now() + ITEM_CACHE_MS });
    return item;
  }

  async function resolveItem(value) {
    if (ITEM_ID.test(value) || isWebUrl(value)) return cachedItem(value.trim());
    if (isLink(value)) throw new UserError('Odkazy umím jen z YouTube a Kicku.');
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
      if (isLink(focused.value)) {
        // A choice's value holds 100 characters; a longer link is sent as written.
        const link = focused.value.trim();
        choices = isWebUrl(link) && link.length <= 100 ? [{ name: choiceName(`▶ ${link}`), value: link }] : [];
      } else {
        const items = await searchItems(focused.value, 25);
        choices = items.map(item => ({ name: choiceName(itemLabel(item)), value: item.Id }));
      }
    } else if (interaction.commandName === 'pust') {
      const film = interaction.options.getString('film');
      if (film && ITEM_ID.test(film)) {
        const source = mediaSource(await cachedItem(film));
        choices = trackChoices(source, focused.name === 'zvuk' ? 'audio' : 'subtitle', focused.value);
      }
    } else if (playing() && player.source) {
      choices = trackChoices(player.source, interaction.commandName === 'zvuk' ? 'audio' : 'subtitle', focused.value);
    }
    await interaction.respond(choices.slice(0, 25));
  }

  function controls(disabled = false) {
    const button = (id, label, style = ButtonStyle.Secondary) =>
      new ButtonBuilder().setCustomId(`fv:${id}`).setLabel(label).setStyle(style).setDisabled(disabled);
    // A live stream cannot be moved.
    const live = player.item?.web?.live;
    const rows = [new ActionRowBuilder().addComponents(
      ...(live ? [] : [button('back60', '−1 min')]),
      button('toggle', player.paused ? '▶ Pokračovat' : '⏸ Pauza', ButtonStyle.Primary),
      ...(live ? [] : [button('fwd60', '+1 min'), button('fwd600', '+10 min')]),
      button('stop', '⏹ Stop', ButtonStyle.Danger),
    )];
    const extra = [];
    if (nowPlaying?.resumedFrom) extra.push(button('restart', '⏮ Pustit od začátku'));
    if (player.segments?.intro) {
      extra.push(player.autoSkipIntro
        ? button('keepintro', '⏭ Úvody se přeskakují · vypnout')
        : button('skipintro', '⏭ Přeskočit úvod', ButtonStyle.Success));
    }
    if (nowPlaying?.next) {
      extra.push(nowPlaying.skipNext
        ? button('next', '▶ Pak pustit další díl')
        : button('nonext', '✖ Nepouštět další díl'));
    }
    if (extra.length) rows.push(new ActionRowBuilder().addComponents(...extra));
    return rows;
  }

  /** poster: image URL for the thumbnail, 'attachment://poster.jpg' for the uploaded one. */
  function nowPlayingEmbed({ poster = null } = {}) {
    const { item } = player;
    const embed = new EmbedBuilder()
      .setColor(player.paused ? 0xf0b232 : 0x5865f2)
      .setTitle(itemLabel(item))
      .addFields(
        { name: 'Stav', value: player.paused ? '⏸ Pozastaveno' : '▶ Hraje', inline: true },
        { name: 'Čas', value: item.web?.live ? '🔴 živě' : `${formatTime(player.position())} / ${formatTime(player.duration)}`, inline: true },
        {
          name: 'Zvuk',
          value: (player.audioTrack ? trackLabel(player.audioTrack) : item.web ? 'z videa' : '—') + (player.sound === 'night' ? ' · 🌙 vyrovnaný' : ''),
          inline: false,
        },
        { name: 'Titulky', value: player.subtitleTrack ? trackLabel(player.subtitleTrack) : 'vypnuto', inline: false },
        { name: 'Kvalita', value: qualityLabel(player.quality), inline: false },
      );
    if (item.Overview) embed.setDescription(item.Overview.length > 300 ? `${item.Overview.slice(0, 299)}…` : item.Overview);
    const thumbnail = item.web?.thumbnail ?? poster;
    if (thumbnail) embed.setThumbnail(thumbnail);
    if (nowPlaying?.next) {
      embed.addFields({ name: 'Potom', value: nowPlaying.skipNext ? 'nic, další díl se nepustí' : itemLabel(nowPlaying.next), inline: false });
    }
    if (nowPlaying?.requestedBy) embed.setFooter({ text: `Spustil(a): ${nowPlaying.requestedBy}` });
    return embed;
  }

  function endedEmbed(item, text) {
    return new EmbedBuilder().setColor(0x4e5058).setTitle(itemLabel(item)).setDescription(text);
  }

  async function retireNowPlaying(item, text, { remove = false } = {}) {
    const message = nowPlaying?.message;
    nowPlaying = null;
    await forgetNowPlaying();
    if (!message) return;
    if (remove) await message.delete().catch(() => {});
    else await message.edit({ content: '', embeds: [endedEmbed(item, text)], components: [], attachments: [] }).catch(() => {});
  }

  // ---- Surviving crashes and restarts -------------------------------------

  // Saves and removals of the file run one after another, so a save that was under way
  // cannot bring the file back after /stop removed it.
  let nowPlayingWrites = Promise.resolve();
  function onNowPlayingFile(task) {
    const result = nowPlayingWrites.then(task);
    nowPlayingWrites = result.catch(() => {});
    return result;
  }

  function saveNowPlaying() {
    const current = nowPlaying;
    if (!current?.message || current.itemId !== player.item?.Id) return Promise.resolve();
    const state = {
      messageId: current.message.id,
      itemId: current.itemId,
      position: Math.round(player.position()),
      by: current.requestedBy,
      byId: current.requestedById ?? null,
      audioIndex: player.audioIndex,
      subtitleIndex: player.subtitleIndex,
      savedAt: Date.now(),
    };
    return onNowPlayingFile(async () => {
      if (nowPlaying !== current) return;
      await mkdir(dir, { recursive: true });
      await writeFile(`${nowPlayingFile}.tmp`, JSON.stringify(state));
      await rename(`${nowPlayingFile}.tmp`, nowPlayingFile);
    });
  }

  function forgetNowPlaying() {
    return onNowPlayingFile(() => rm(nowPlayingFile, { force: true })).catch(() => {});
  }

  /** Ends the message of `current`, also when another now-playing replaced it meanwhile. */
  async function retireMessage(current, item, text) {
    if (nowPlaying === current) return retireNowPlaying(item, text);
    await current?.message?.edit({ content: '', embeds: [endedEmbed(item, text)], components: [], attachments: [] }).catch(() => {});
  }

  /**
   * Stops a recovery that is waiting to start the stream again (/stop, /odejdi,
   * everyone left). Returns whether there was one.
   */
  function cancelRecovery(text) {
    if (!recovery) return false;
    const { item, current } = recovery;
    recovery = null;
    retireMessage(current, item, text).catch(() => {});
    return true;
  }

  /**
   * Now-playing messages whose buttons no longer work (the bot died or restarted
   * while something played) are deleted, so nobody clicks on a dead film.
   */
  async function deleteDeadMessages(keepId = null) {
    const channel = textChannel();
    const recent = await channel?.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent) return;
    const dead = recent.filter(m => m.author.id === client.user.id && m.id !== keepId
      && m.components.some(row => row.components?.some(c => c.customId?.startsWith('fv:'))));
    for (const message of dead.values()) await message.delete().catch(() => {});
    if (dead.size) console.log(`Deleted ${dead.size} now-playing message(s) left from before the restart`);
  }

  /**
   * Starts a failed item again where it fell, a few times, then gives up as before.
   * current: the now-playing of the failed item (kept across retries).
   */
  async function recoverPlayback(item, message, position, current = nowPlaying, tracks = null) {
    const now = Date.now();
    const attempts = (recoveries.get(item.Id) ?? []).filter(at => now - at < RECOVERY_WINDOW_MS);
    const giveUp = () => retireMessage(current, item,
      `⚠️ Přehrávání spadlo v čase ${formatTime(position)}: ${message}\nZkus znovu \`/pust\`, naváže od místa, kde to spadlo.`);
    if (attempts.length >= RECOVERY_ATTEMPTS || !peopleInVoice()) return giveUp();
    recoveries.set(item.Id, [...attempts, now]);
    tracks ??= { audioIndex: lastTracks?.audio?.Index ?? null, subtitleIndex: lastTracks?.subtitle?.Index ?? null };
    console.warn(`Recovering ${itemLabel(item)} at ${Math.round(position)}s (attempt ${attempts.length + 1}): ${message}`);
    const token = { item, current };
    recovery = token;
    await new Promise(resolve => setTimeout(resolve, RECOVERY_DELAYS_MS[attempts.length]));
    // Cancelled by /stop, /odejdi or everyone leaving; they retired the message.
    if (recovery !== token) return undefined;
    recovery = null;
    // Someone started something else meanwhile: only the dead message goes.
    if (playing() || nowPlaying !== current) return current?.message?.delete().catch(() => {});
    if (!peopleInVoice()) return giveUp();
    try {
      const fresh = await loadItem(item.Id);
      await beginPlayback(fresh, { startSeconds: Math.max(0, position - 5), tracks, byId: current?.requestedById },
        current?.requestedBy ?? 'FilmVault', payload => textChannel().send(payload),
        `⚠️ Vysílání spadlo, navázáno od ${formatTime(Math.max(0, position - 5))}.`);
      if (current?.message) await current.message.delete().catch(() => {});
    } catch (error) {
      console.error('Recovery failed:', error.message);
      // A half-started attempt (e.g. its message failed to send) is undone first.
      if (playing() && player.item.Id === item.Id) await player.stop().catch(() => {});
      nowPlaying = current;
      return recoverPlayback(item, error.message, position, current, tracks);
    }
  }

  /**
   * Each edit uploads the poster again in place of the old one, exactly like the
   * first send. Referring to the existing attachment instead either left it as a
   * separate image above the message or dropped the thumbnail. Edits run one at a
   * time, so quick clicks cannot cross.
   */
  function refreshNowPlaying() {
    const current = nowPlaying;
    if (!current?.message) return Promise.resolve();
    current.editing = (current.editing ?? Promise.resolve()).then(async () => {
      if (nowPlaying !== current || !playing()) return;
      const { poster } = current;
      await current.message.edit({
        embeds: [nowPlayingEmbed({ poster: poster && `attachment://${POSTER_FILE}` })],
        components: controls(),
        attachments: [],
        files: poster ? [new AttachmentBuilder(poster, { name: POSTER_FILE })] : [],
      }).catch(error => console.warn('Now-playing message edit failed:', error.message));
    });
    return current.editing;
  }

  function allowed(interaction) {
    const wanted = allowedRole;
    if (!wanted) return true;
    const roles = interaction.member?.roles?.cache;
    return !!roles?.some(role => role.id === wanted || role.name.toLowerCase() === wanted.toLowerCase());
  }

  function requireActive() {
    if (!playing()) throw new UserError(busyElsewhere() ? BUSY : 'Teď nic nehraje. Pusť něco přes /pust.');
  }

  function requireSeekable() {
    requireActive();
    if (player.item.web?.live) throw new UserError('Živý přenos posouvat nejde.');
  }

  function userName(interaction) {
    return interaction.member?.displayName ?? interaction.user.username;
  }

  async function handlePlay(interaction) {
    const od = interaction.options.getString('od');
    const start = od ? parseTime(od) : null;
    if (od && (!start || start.relative)) throw new UserError('Čas začátku zadej třeba jako 1:20:00 nebo 45 (minut).');
    if (busyElsewhere()) throw new UserError(BUSY);
    await interaction.deferReply();
    const item = await resolveItem(interaction.options.getString('film', true));
    await startPlayback(interaction, item, {
      startSeconds: start?.seconds ?? null,
      zvuk: interaction.options.getString('zvuk'),
      titulky: interaction.options.getString('titulky'),
    });
  }

  // Expects a deferred reply; it becomes the now-playing message.
  function startPlayback(interaction, item, options = {}) {
    return beginPlayback(item, { ...options, byId: interaction.user.id }, userName(interaction), payload => interaction.editReply(payload));
  }

  /**
   * Intro and credits come from segments.js; the first episode of an evening may get
   * them a few seconds after it started. The next episode is analysed meanwhile.
   */
  function loadSegments(item, next) {
    episodeSegments(item)
      .then(async segments => {
        if (!segments || player.item?.Id !== item.Id) return;
        player.setSegments(item, segments);
        await refreshNowPlaying();
      })
      .catch(error => console.warn('Segment detection failed:', error.message))
      .then(() => next && getItem(next.Id).then(episodeSegments))
      .catch(error => console.warn('Segment detection of the next episode failed:', error.message));
  }

  /**
   * startSeconds null = resume where it was left off. Tracks not chosen explicitly
   * default to Czech audio, else Czech subtitles (see defaultTracks). byId: Discord ID
   * of requestedBy; note: extra line for the message.
   */
  async function beginPlayback(item, options, requestedBy, send, note) {
    // Checked and held in one step, so two servers cannot start at the same moment.
    if (busyElsewhere()) throw new UserError(BUSY);
    if (player.streamer.client.guilds.cache.size && !player.streamer.client.guilds.cache.has(guildId)) {
      throw new UserError('Streamovací účet na tomhle serveru není, správce ho musí pozvat.');
    }
    starting++;
    try {
      return await startItem(item, options, requestedBy, send, note);
    } finally {
      starting--;
    }
  }

  /** Where a video from the web was left off; Jellyfin keeps this only for its own films. */
  async function webResume(item) {
    if (item.web.live) return null;
    const last = (await history()).find(entry => entry.id === item.Id);
    return last && !last.finished && last.position >= 60 ? Math.max(0, last.position - 5) : null;
  }

  async function startItem(item, { startSeconds = null, zvuk = null, titulky = null, tracks = null, byId = null } = {}, requestedBy, send, note = '') {
    const source = mediaSource(item);
    const defaults = tracks ?? defaultTracks(source, zvuk && zvuk !== SUBTITLES_OFF ? Number(zvuk) : null);
    const resumedFrom = startSeconds === null ? (item.web ? await webResume(item) : resumeSeconds(item)) : null;
    const previous = playing() ? player.item : null;
    const next = await findNextEpisode(item);
    try {
      await player.play({
        autoSkipIntro: !!item.SeriesId && (await loadSettings()).skipIntro.includes(item.SeriesId),
        countdown: next ? itemLabel(next) : null,
        item,
        guildId,
        quality,
        sound,
        channelId: voiceChannelId,
        startSeconds: resumedFrom ?? startSeconds ?? 0,
        audioIndex: defaults.audioIndex,
        subtitleIndex: titulky ? (titulky === SUBTITLES_OFF ? null : Number(titulky)) : defaults.subtitleIndex,
      });
    } catch (error) {
      // The previous film was stopped for this one (joining the call failed): its buttons go.
      if (previous && !playing()) await retireNowPlaying(previous, '⏹ Zastaveno, nové přehrávání se nepodařilo spustit.');
      throw error;
    }
    if (previous) await retireNowPlaying(previous, 'Přepnuto na jiný film.');

    loadSegments(item, next);
    const poster = item.web ? null : await downloadPoster(item);
    nowPlaying = { message: null, itemId: item.Id, requestedBy, requestedById: byId, resumedFrom, poster, next, skipNext: false };
    const resumeNote = resumedFrom ? ` Navazuje od ${formatTime(resumedFrom)}, kde jste skončili.` : '';
    nowPlaying.message = await send({
      content: `🍿 Běží v <#${voiceChannelId}>. Připoj se a klikni na živé vysílání.${resumeNote}${note ? `\n${note}` : ''}`,
      embeds: [nowPlayingEmbed({ poster: poster && `attachment://${POSTER_FILE}` })],
      components: controls(),
      files: poster ? [new AttachmentBuilder(poster, { name: POSTER_FILE })] : [],
    });
    await saveNowPlaying().catch(error => console.warn('Could not save now playing:', error.message));
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

  async function findNextEpisode(item) {
    if (item.Type !== 'Episode') return null;
    return nextEpisode(item).catch(error => {
      console.error('Next episode lookup failed:', error.message);
      return null;
    });
  }

  /**
   * An episode ended: the next one starts right away, in the Go Live stream the
   * player kept open (the video showed a countdown for the last 30 s). Without a
   * next one, or with nobody listening, the stream is closed.
   */
  async function continueWithNext(item) {
    const current = nowPlaying;
    const next = current?.skipNext ? null : current?.next;
    if (!next || !peopleInVoice()) {
      await player.closeLive();
      return retireNowPlaying(item, next ? '🎬 Dohráno. Nikdo není v hovoru, další díl se nepustil.' : '🎬 Dohráno.');
    }
    await retireNowPlaying(item, `🎬 Dohráno. ▶ Pokračuje **${itemLabel(next)}**.`);
    const channel = textChannel();
    try {
      const fresh = await getItem(next.Id);
      await beginPlayback(fresh, { tracks: carryTracks(mediaSource(fresh), lastTracks), byId: current.requestedById },
        current.requestedBy, payload => channel.send(payload));
    } catch (error) {
      await player.closeLive();
      await channel?.send(`Další díl se nepodařilo pustit: ${error.message}`).catch(() => {});
      throw error;
    }
  }

  // ---- Progress -----------------------------------------------------------

  /** Adds the time since the last count to the item playing and to everyone in the voice room. */
  function countViewers() {
    const now = Date.now();
    if (!playing() || player.paused || !player.session?.startedAt) {
      if (watching) watching.at = now;
      return;
    }
    if (watching?.itemId !== player.item.Id) {
      watching = { itemId: player.item.Id, watched: 0, viewers: {}, at: Math.min(now, player.session.startedAt) };
    }
    const seconds = Math.min(now - watching.at, VIEWER_TICK_MS * 2) / 1000;
    watching.at = now;
    watching.watched += seconds;
    const channel = client.channels.cache.get(voiceChannelId);
    const streamerId = player.streamer.client.user?.id;
    for (const member of channel?.members?.values() ?? []) {
      if (member.user.bot || member.id === streamerId) continue;
      const viewer = watching.viewers[member.id] ??= { name: member.displayName, seconds: 0 };
      viewer.name = member.displayName;
      viewer.seconds += seconds;
    }
  }

  async function storeProgress({ item, position, finished, startedAt, audio, subtitle }, requestedBy, requestedById) {
    itemCache.delete(item.Id);
    lastTracks = { audio, subtitle };
    if (watching?.itemId === item.Id) countViewers();
    const seen = watching?.itemId === item.Id ? watching : { watched: 0, viewers: {} };
    watching = null;
    for (const viewer of Object.values(seen.viewers)) viewer.seconds = Math.round(viewer.seconds);
    const duration = durationSeconds(item);
    // A live stream has nothing to go back to: leaving it counts as done.
    const watched = finished || item.web?.live || (duration && position >= duration * WATCHED_TAIL);
    await Promise.all([
      recordWatch({
        id: item.Id, label: itemLabel(item), by: requestedBy, byId: requestedById, startedAt, position, duration, finished: !!watched,
        watched: seen.watched, viewers: seen.viewers,
      }),
      !item.web && (position >= 60 || watched)
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
    // Select menu values must be unique and hold 100 characters (a web address can be long).
    const removable = [...new Map(shown.map(e => [entryKey(e), e])).values()].filter(e => entryKey(e).length <= 100);
    if (removable.length) {
      components.unshift(selectRow(`fh:del:${page}`, '🗑 Odebrat z historie…', removable.map(e => ({
        label: choiceName(e.label), description: formatDate(e.endedAt), value: entryKey(e),
      }))));
    }
    const unfinished = [...new Map(shown.filter(e => !e.finished && e.id.length <= 100).map(e => [e.id, e])).values()];
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
    requireSeekable();
    await player.seek(player.position() + delta);
  }

  async function handleSeek(interaction) {
    requireSeekable();
    const parsed = parseTime(interaction.options.getString('cas', true));
    if (!parsed) throw new UserError('Nerozumím času. Zkus 1:20:00, +5, -2 nebo +30s.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = parsed.relative ? player.position() + parsed.seconds : parsed.seconds;
    await player.seek(target);
    await refreshNowPlaying();
    await interaction.editReply(`⏩ Posunuto na ${formatTime(player.position())}.`);
  }

  /** Everyone watches the same stream, so a change is announced in the channel. */
  async function handleQuality(interaction) {
    const wanted = interaction.options.getString('uroven');
    if (!wanted) {
      return interaction.reply({ content: `📺 Kvalita: ${qualityLabel(quality)}`, flags: MessageFlags.Ephemeral });
    }
    if (wanted === quality) {
      return interaction.reply({ content: `📺 Kvalita už je ${qualityLabel(wanted)}.`, flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    quality = wanted;
    if (playing()) await player.setQuality(wanted);
    await saveQuality(wanted).catch(error => console.error('Could not save quality setting:', error.message));
    await refreshNowPlaying();
    const note = playing() && !player.paused ? ' Obraz se na chvilku zastaví a naváže.' : '';
    await interaction.editReply(`📺 Kvalita: **${qualityLabel(wanted)}** (${userName(interaction)}).${note}`);
  }

  async function handleSound(interaction) {
    const wanted = interaction.options.getString('rezim');
    if (!wanted || wanted === sound) {
      return interaction.reply({ content: `🔊 Režim zvuku: ${SOUND_MODES[sound]}`, flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    sound = wanted;
    if (playing()) await player.setSound(wanted);
    await updateSettings({ sound: wanted });
    await refreshNowPlaying();
    const note = playing() && !player.paused ? ' Obraz se na chvilku zastaví a naváže.' : '';
    await interaction.editReply(`🔊 Režim zvuku: **${SOUND_MODES[wanted]}** (${userName(interaction)}).${note}`);
  }

  async function statsFor(period, now = Date.now()) {
    const [from, to] = periodRange(period, now);
    const stats = await computeStats({ entries: await history(), wishes: await wishlist?.entries(), from, to });
    // Current server nicknames. Fetched one by one: the whole member list needs a
    // privileged intent the bot does not have (it hung for two minutes).
    const guild = client.guilds.cache.get(guildId);
    const ids = [...stats.perPerson.keys()].filter(key => /^\d{17,20}$/.test(key) && !guild?.members.cache.has(key));
    await Promise.all(ids.map(id => guild?.members.fetch({ user: id, force: false }).catch(() => null)));
    const stored = stats.nameOf;
    stats.nameOf = key => guild?.members.cache.get(key)?.displayName ?? stored(key);
    return stats;
  }

  /** Everyone's ranking in public (we are competitive); with `kdo` one person's card. */
  async function handleStats(interaction) {
    const period = interaction.options.getString('obdobi') ?? 'vse';
    const user = interaction.options.getUser('kdo');
    await interaction.deferReply();
    const stats = await statsFor(period);
    const label = PERIODS[period].label;
    if (!user) return interaction.editReply({ embeds: [serverEmbed(stats, label)] });
    const member = interaction.options.getMember('kdo');
    const key = personKeyFor(stats, user.id, [member?.displayName, user.username, user.globalName]);
    return interaction.editReply({ embeds: [personEmbed(stats, key, member?.displayName ?? user.username, label)] });
  }

  /** First of the month: last month's statistics in the cinema room, once. */
  async function postMonthlySummary() {
    const now = Date.now();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
    const month = `${parts.year}-${parts.month}`;
    const settings = await loadSettings();
    if (Number(parts.day) !== 1 || Number(parts.hour) < SUMMARY_HOUR || settings.summaryMonth === month) return;
    const stats = await statsFor('minuly', now);
    // Marked done only once sent (or with nothing to send), so a failure retries next hour.
    if (stats.titles) await textChannel().send({ content: '📅 **Jak jsme koukali minulý měsíc**', embeds: [serverEmbed(stats, 'minulý měsíc')] });
    await updateSettings({ summaryMonth: month });
  }

  async function cpuUsage() {
    const sample = () => os.cpus().reduce((sum, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
    }, { idle: 0, total: 0 });
    const a = sample();
    await new Promise(resolve => setTimeout(resolve, 500));
    const b = sample();
    return Math.round(100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)));
  }

  async function handleStatus(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const jellyfinStart = Date.now();
    const jellyfin = await fetch(`${config.jellyfinUrl}/System/Info/Public`, {
      headers: { Authorization: authHeader }, signal: AbortSignal.timeout(5000),
    }).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(
      info => `✅ ${info.Version}, odpověď za ${Date.now() - jellyfinStart} ms`,
      error => `❌ ${error.message}`,
    );
    const report = player.liveConn?.lastReport;
    const stream = !playing() ? (busyElsewhere() ? 'promítá se na jiném serveru' : 'nic nehraje')
      : `${player.paused ? '⏸' : '▶'} ${itemLabel(player.item)} · ${formatTime(player.position())}`
        + (report ? `\nza poslední minutu: ${report.frames} snímků, ${report.gaps} zaseknutí, Discord chtěl znovu ${report.nacked} paketů`
          + (report.remb ? `, odhad linky ${Math.round(report.remb / 1000)} kbit/s` : '') : '');
    const memory = process.memoryUsage().rss / 2 ** 20;
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🩺 Stav kina').addFields(
      { name: 'Vysílání', value: stream, inline: false },
      { name: 'Jellyfin', value: jellyfin, inline: true },
      { name: 'Discord', value: client.ws.ping >= 0 ? `odezva ${client.ws.ping} ms` : 'odezva se ještě měří', inline: true },
      {
        name: 'MiniPC',
        value: `CPU ${await cpuUsage()} % · volná paměť ${(os.freemem() / 2 ** 30).toFixed(1)} / ${(os.totalmem() / 2 ** 30).toFixed(1)} GB`
          + `\nbot: ${Math.round(memory)} MB, běží ${formatTime((Date.now() - startedAt) / 1000)}`,
        inline: false,
      },
      { name: 'Nastavení', value: `📺 ${qualityLabel(quality)}\n🔊 ${SOUND_MODES[sound]}`, inline: false },
    );
    return interaction.editReply({ embeds: [embed] });
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
    await addWatch({ id: item.Id, label: itemLabel(item), by: userName(interaction), byId: interaction.user.id, endedAt, position, duration, finished });
    // Jellyfin shows it as seen (or where to go on) too.
    if (!item.web) await saveProgress(item.Id, { seconds: position, played: finished }).catch(error => console.error('Saving progress failed:', error.message));
    wishlist?.refresh();
    const state = finished ? 'jako dokoukané' : `se skončením v ${formatTime(position)}`;
    return interaction.editReply(`✍️ Zapsáno do historie: **${itemLabel(item)}**, ${formatDate(endedAt)}, ${state}. Odebrat jde v /videli.`);
  }

  async function handleCommand(interaction) {
    switch (interaction.commandName) {
      case 'pust':
        return handlePlay(interaction);
      // Deferred first everywhere the player is awaited: it may be busy (joining the call)
      // for longer than the 3 s Discord gives for an answer.
      case 'pauza':
        requireActive();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await player.pause();
        await refreshNowPlaying();
        return interaction.editReply(`⏸ Pozastaveno na ${formatTime(player.position())}.`);
      case 'pokracuj':
        requireActive();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await player.resume();
        await refreshNowPlaying();
        return interaction.editReply('▶ Pokračuje se.');
      case 'posun':
        return handleSeek(interaction);
      case 'kvalita':
        return handleQuality(interaction);
      case 'hlasitost':
        return handleSound(interaction);
      case 'statistiky':
        return handleStats(interaction);
      case 'stav':
        return handleStatus(interaction);
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
        if (!playing() && cancelRecovery(`⏹ Zastaveno (${userName(interaction)}).`)) {
          return interaction.reply({ content: '⏹ Zastaveno, kino už se znovu nepustí.', flags: MessageFlags.Ephemeral });
        }
        requireActive();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const item = player.item;
        await player.stop();
        await retireNowPlaying(item, `⏹ Zastaveno (${userName(interaction)}).`);
        return interaction.editReply('⏹ Zastaveno.');
      }
      case 'odejdi': {
        // Must not end what plays on the other server, or the call it waits in there.
        if (busyElsewhere()) throw new UserError(BUSY);
        if (player.channelId && player.guildId !== guildId) throw new UserError('Kino teď v tomhle hovoru není.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        player.guildId = guildId;
        const item = player.item;
        cancelRecovery('⏹ Zastaveno, odpojeno z hovoru.');
        await player.leave();
        if (item) await retireNowPlaying(item, '⏹ Zastaveno, odpojeno z hovoru.');
        return interaction.editReply('👋 Odpojeno.');
      }
    }
  }

  async function handleButton(interaction) {
    const action = interaction.customId.slice(3);
    // Stop on a stream that fell and waits to be started again.
    if (action === 'stop' && recovery?.current?.message?.id === interaction.message.id && !playing()) {
      cancelRecovery(`⏹ Zastaveno (${userName(interaction)}).`);
      return interaction.deferUpdate();
    }
    if (!playing() || nowPlaying?.message?.id !== interaction.message.id) {
      return interaction.reply({ content: 'Tohle přehrávání už skončilo.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferUpdate();
    // The item may have ended while the click was on its way.
    if (!playing() || nowPlaying?.message?.id !== interaction.message.id) return undefined;
    if (action === 'stop') {
      const item = player.item;
      await player.stop();
      return retireNowPlaying(item, `⏹ Zastaveno (${interaction.member?.displayName ?? interaction.user.username}).`);
    }
    if (action === 'restart') {
      requireSeekable();
      nowPlaying.resumedFrom = null;
      await player.seek(0);
    } else if (action === 'skipintro' || action === 'keepintro') {
      // Remembered per series: once skipped, every later episode skips it by itself.
      const seriesId = player.item.SeriesId;
      const settings = await loadSettings();
      const skip = action === 'skipintro';
      await updateSettings({ skipIntro: [...settings.skipIntro.filter(id => id !== seriesId), ...(skip ? [seriesId] : [])] });
      player.autoSkipIntro = skip;
      const intro = player.segments?.intro;
      if (skip && intro && player.position() < intro[1] - 1) {
        player.introSkipped = true;
        await player.seek(intro[1]);
      }
    } else if (action === 'nonext' || action === 'next') {
      nowPlaying.skipNext = action === 'nonext';
      await player.setCountdown(nowPlaying.skipNext ? null : itemLabel(nowPlaying.next));
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
    const here = player.channelId && player.guildId === guildId;
    const channel = here && client.channels.cache.get(player.channelId);
    const streamerId = player.streamer.client.user?.id;
    const people = channel?.members?.filter(m => !m.user.bot && m.id !== streamerId).size ?? 0;
    if (!here || people > 0) {
      clearTimeout(aloneTimer);
      aloneTimer = null;
      return;
    }
    aloneTimer ??= setTimeout(async () => {
      aloneTimer = null;
      // The account may have moved to another server meanwhile.
      if (player.guildId !== guildId) return;
      const item = player.item;
      cancelRecovery('👋 Všichni odešli, přehrávání zastaveno.');
      await player.leave().catch(error => console.error('Leave failed:', error));
      if (item) await retireNowPlaying(item, '👋 Všichni odešli, přehrávání zastaveno.');
    }, ALONE_LEAVE_MS);
  }

  // What the player reports about this server's item (startBot passes them on).
  const onPlayer = {
    stopped(event) {
      storeProgress(event, nowPlaying?.requestedBy, nowPlaying?.requestedById).catch(error => console.error('Recording progress failed:', error));
    },
    ended(item) {
      continueWithNext(item).catch(error => console.error('Finishing playback failed:', error));
    },
    failed(item, message, position) {
      recoverPlayback(item, message, position).catch(error => console.error('Recovery failed:', error));
    },
    introSkipped() {
      refreshNowPlaying();
    },
  };

  setInterval(countViewers, VIEWER_TICK_MS).unref();
  setInterval(() => {
    if (playing()) saveNowPlaying().catch(error => console.warn('Could not save now playing:', error.message));
  }, NOW_PLAYING_SAVE_MS).unref();

  // Keep the resume position fresh in case the MiniPC or bot dies mid-film.
  let lastSaved = null;
  setInterval(() => {
    if (!playing() || player.paused || player.item.web) return;
    const position = player.position();
    if (position < 60 || lastSaved === Math.round(position)) return;
    lastSaved = Math.round(position);
    saveProgress(player.item.Id, { seconds: position }).catch(error => console.error('Saving progress failed:', error.message));
  }, PROGRESS_SAVE_MS).unref();

  async function handleInteraction(interaction) {
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
    if (!interaction.isChatInputCommand() && !isList && !(interaction.isButton() && interaction.customId.startsWith('fv:'))) return;
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
  }

  // Optional: without a TMDB key or the room, the rest of the cinema works as before.
  // Returns the room's channel ID, or null when the wishlist is off.
  async function startWishlist() {
    if (!movieInfoEnabled() || !wishlistChannelId) {
      console.log(`Wishlist off in ${guild.name}: ${wishlistChannelId ? 'no TMDB_API_KEY' : 'no room set'}`);
      return null;
    }
    try {
      const room = client.channels.cache.get(wishlistChannelId);
      if (!room) throw new Error(`Channel ${wishlistChannelId} not found`);
      wishlist = createWishlist({
        client,
        channelId: room.id,
        allowed,
        userName,
        play: (item, requestedBy, byId) => beginPlayback(item, { byId }, requestedBy, payload => textChannel().send(payload)),
        dir,
        addWatch,
        history,
        announceRole,
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

  /** A JSON file younger than AUTOPLAY_MAX_AGE_MS, read once and deleted; null otherwise. */
  async function takeFile(path) {
    try {
      const { mtimeMs } = await stat(path);
      const data = Date.now() - mtimeMs < AUTOPLAY_MAX_AGE_MS ? JSON.parse(await readFile(path, 'utf8')) : null;
      await rm(path, { force: true });
      return data;
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`${path} unreadable:`, error.message);
      return null;
    }
  }

  /**
   * After a crash or restart: the old now-playing message goes, and what played goes
   * on where it was (data/nowplaying.json, saved every few seconds), as long as somebody
   * is still in the voice room. data/autoplay.json ({ "itemId", "by" }, from the deploy
   * script) is the fallback; it resumes from Jellyfin's saved position.
   */
  async function playAfterRestart() {
    const state = await takeFile(nowPlayingFile);
    const request = await takeFile(`${dir}/${AUTOPLAY_FILE}`);
    await deleteDeadMessages();
    const itemId = state?.itemId ?? request?.itemId;
    if (!itemId) return;
    // Another server went on with its film (the deploy script's autoplay is for the first server).
    if (busyElsewhere()) {
      console.log('Not resuming after restart: the cinema plays on another server');
      return;
    }
    if (!peopleInVoice()) {
      console.log('Not resuming after restart: nobody in the voice room');
      return;
    }
    try {
      const item = await loadItem(itemId);
      console.log(`Playing ${itemLabel(item)} again after restart`);
      const send = payload => textChannel().send(payload);
      if (state) {
        const startSeconds = Math.max(0, state.position - 5);
        await beginPlayback(item, {
          startSeconds, tracks: { audioIndex: state.audioIndex, subtitleIndex: state.subtitleIndex }, byId: state.byId,
        }, state.by ?? 'FilmVault', send, `🔄 Kino se restartovalo, navázáno od ${formatTime(startSeconds)}.`);
      } else {
        await beginPlayback(item, {}, request.by ?? 'restart', send);
      }
    } catch (error) {
      console.error('Autoplay after restart failed:', error);
    }
  }

  async function start() {
    const text = client.channels.cache.get(textChannelId);
    const voice = client.channels.cache.get(voiceChannelId);
    if (!text || !voice) throw new Error(`Channels of ${guild.name} not found`);
    quality = await loadQuality();
    sound = (await loadSettings()).sound;
    await guild.commands.set([...commands, setupCommand]);
    console.log(`Registered ${commands.length + 1} slash commands in ${guild.name}; text #${text.name}, voice ${voice.name}`);
    const room = await startWishlist();
    await keepHelpLast(client, text, voice.id, room, allowedRole).catch(error => console.error('Help message failed:', error.message));
    await playAfterRestart();
    setInterval(() => postMonthlySummary().catch(error => console.error('Monthly summary failed:', error)), SUMMARY_CHECK_MS).unref();
    postMonthlySummary().catch(error => console.error('Monthly summary failed:', error));
  }

  return { start, busy, handleInteraction, checkAlone, onPlayer };
}

export function startBot(player) {
  // Message content is for the wishlist room, where people just write movie titles.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    // Replies quote what people wrote ("@everyone" as a film title); only messages that
    // name their mentions explicitly ping anyone.
    allowedMentions: { parse: [], repliedUser: false },
  });
  const cinemas = new Map(); // server ID -> cinema
  let setups = {};

  function startCinema(guild, setup) {
    const cinema = createCinema({
      client,
      player,
      guild,
      setup,
      busyElsewhere: () => [...cinemas.values()].some(other => other !== cinema && other.busy()),
    });
    cinemas.set(guild.id, cinema);
    return cinema.start();
  }

  /** From before there were several servers: .env names the channels of the first one. */
  async function setupFromEnv(guilds) {
    const id = config.guildId ?? (guilds.size === 1 ? guilds.first().id : null);
    if (!id) {
      console.warn(`Bot is on ${guilds.size} servers and none is set up: use /nastavit, or GUILD_ID in .env`);
      return;
    }
    const guild = await client.guilds.fetch(id);
    await guild.channels.fetch();
    let wishlistChannelId = null;
    try {
      wishlistChannelId = findChannel(guild, config.wishlistChannel, false).id;
    } catch (error) {
      console.error('Wishlist room:', error.message);
    }
    setups[id] = {
      textChannelId: findChannel(guild, config.textChannel, false).id,
      voiceChannelId: findChannel(guild, config.voiceChannel, true).id,
      wishlistChannelId,
      allowedRole: config.allowedRole,
      announceRole: config.announceRole,
      dir: 'data',
    };
    await saveGuilds(setups);
  }

  async function handleSetup(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'Kino nastavuje jen správce serveru.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.guildId;
    const old = setups[id];
    setups[id] = {
      textChannelId: interaction.options.getChannel('textovy', true).id,
      voiceChannelId: interaction.options.getChannel('hlasovy', true).id,
      wishlistChannelId: interaction.options.getChannel('seznam')?.id ?? old?.wishlistChannelId ?? null,
      allowedRole: interaction.options.getRole('role')?.id ?? old?.allowedRole ?? null,
      announceRole: old?.announceRole ?? null,
      dir: old?.dir ?? `data/guilds/${id}`,
    };
    await saveGuilds(setups);
    const notes = [];
    if (!player.streamer.client.guilds.cache.has(id)) {
      notes.push('⚠️ Streamovací účet na tomhle serveru není. Pozvi ho, a musí vidět hlasový kanál, jinak se film nepustí.');
    }
    if (cinemas.has(id)) {
      notes.unshift('✅ Uloženo. Projeví se po příštím restartu bota.');
    } else {
      const guild = await client.guilds.fetch(id);
      await guild.channels.fetch();
      await startCinema(guild, setups[id]);
      notes.unshift('✅ Kino je nastavené, návod najdeš v textovém kanálu.');
    }
    return interaction.editReply(notes.join('\n'));
  }

  // Only one cinema has the player at a time, the one it plays for.
  for (const event of ['stopped', 'ended', 'failed', 'introSkipped']) {
    player.on(event, (...args) => cinemas.get(player.guildId)?.onPlayer[event](...args));
  }

  client.on('voiceStateUpdate', (_, state) => cinemas.get(state.guild.id)?.checkAlone());

  client.on('interactionCreate', async interaction => {
    if (!interaction.guildId) return undefined;
    if (interaction.isChatInputCommand() && interaction.commandName === 'nastavit') {
      return handleSetup(interaction).catch(error => {
        console.error('Setup failed:', error);
        const answer = { content: `Nastavení se nepovedlo: ${error.message}`, flags: MessageFlags.Ephemeral };
        return (interaction.deferred ? interaction.followUp(answer) : interaction.reply(answer)).catch(() => {});
      });
    }
    const cinema = cinemas.get(interaction.guildId);
    if (cinema) return cinema.handleInteraction(interaction);
    if (interaction.isRepliable()) {
      return interaction.reply({ content: 'Kino tu ještě není nastavené. Správce ho nastaví přes /nastavit.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return undefined;
  });

  // Invited to a new server: it can be set up right away.
  client.on('guildCreate', guild => {
    const setup = setups[guild.id];
    const started = !setup || cinemas.has(guild.id)
      ? guild.commands.set([setupCommand])
      : guild.channels.fetch().then(() => startCinema(guild, setup));
    started.catch(error => console.error(`Setting up ${guild.name} failed:`, error));
  });

  client.once('clientReady', async () => {
    console.log(`Control bot ready as ${client.user.tag}`);
    try {
      const guilds = await client.guilds.fetch();
      setups = await loadGuilds();
      if (!Object.keys(setups).length) await setupFromEnv(guilds);
      const ready = [];
      for (const [id, setup] of Object.entries(setups)) {
        if (!guilds.has(id)) {
          console.warn(`Bot is no longer on server ${id}, its cinema stays off`);
          continue;
        }
        const guild = await client.guilds.fetch(id);
        await guild.channels.fetch();
        // A call the account was left in before the restart (or a Discord outage) blocks the next join.
        player.guildId = id;
        if (player.streamer.client.guilds.cache.has(id)) player.leaveVoice();
        ready.push([guild, setup]);
      }
      // The first server last: it takes the deploy script's autoplay, which is only for
      // when no other server has gone on with what it played.
      ready.sort(([, a], [, b]) => (a.dir === 'data') - (b.dir === 'data'));
      let started = 0;
      for (const [guild, setup] of ready) {
        try {
          await startCinema(guild, setup);
          started++;
        } catch (error) {
          console.error(`Cinema of ${guild.name} failed to start:`, error);
        }
      }
      if (ready.length && !started) throw new Error('No cinema started');
      for (const { id, name } of guilds.values()) {
        if (!setups[id]) {
          await client.guilds.fetch(id).then(guild => guild.commands.set([setupCommand]));
          console.log(`Server ${name} has no cinema yet: /nastavit`);
        }
      }
      const update = () => updateYtDlp().catch(error => console.warn('yt-dlp update failed:', error.message));
      update();
      setInterval(update, YTDLP_UPDATE_MS).unref();
    } catch (error) {
      console.error('Startup failed:', error);
      process.exit(1);
    }
  });

  return client.login(config.botToken).then(() => client);
}
