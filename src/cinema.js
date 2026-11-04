import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
} from 'discord.js';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { choiceName, createBrowser, formatDate } from './browse.js';
import { commands, setupCommand } from './commands.js';
import { config } from './config.js';
import { helpTopic, keepHelpLast } from './help.js';
import { createHistory } from './history.js';
import {
  audioTracks, authHeader, defaultTracks, downloadPoster, durationSeconds, getItem, isCzech, itemLabel,
  mediaSource, nextEpisode, resumeSeconds, saveProgress, searchItems, subtitleTracks, trackLabel,
} from './jellyfin.js';
import { movieInfoEnabled } from './movieinfo.js';
import { UserError } from './player.js';
import { DEFAULT_QUALITY, createQualityStore, qualityLabel } from './quality.js';
import { episodeSegments } from './segments.js';
import { SOUND_MODES, createSettings } from './settings.js';
import { PERIODS, computeStats, periodRange, personEmbed, personKeyFor, serverEmbed } from './stats.js';
import { formatTime, parseTime, parseWhen } from './time.js';
import { isLink, isWebUrl, webAddress, webItem } from './web.js';
import { createWishlist } from './wishlist.js';

// The streaming account is on one call at a time, so one film plays across all servers.
const BUSY = 'Kino teď promítá na jiném serveru, zkus to později.';

const ALONE_LEAVE_MS = 2 * 60_000;
const ITEM_CACHE_MS = 60_000;
const ITEM_ID = /^[0-9a-f]{32}$/i;
const SUBTITLES_OFF = 'off';
const PROGRESS_SAVE_MS = 60_000;
const SLOW_LIST_MS = Number(process.env.SLOW_LIST_MS ?? 1500);
// Played this close to the end counts as watched (credits).
const WATCHED_TAIL = 0.92;
// The button on a stopped item's message: this barely started means from the beginning,
// otherwise it goes back this much, for people to catch up.
const RESUME_MIN_SECONDS = 60;
const RESUME_REWIND_SECONDS = 5;
const DEFAULT_TRACKS = 'd';
const LIVE_ENDED = /not currently live|is offline|has ended|not live/i;
const BACKFILL_MESSAGES = 1000;
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

/**
 * The cinema of one server: its channels, data and what it plays. All cinemas share
 * the player. busyElsewhere: () => whether another server's cinema holds it.
 */
export function createCinema({ client, player, guild, setup, busyElsewhere }) {
  const { textChannelId, voiceChannelId, wishlistChannelId, allowedRole, announceRole, dir } = setup;
  const guildId = guild.id;
  const nowPlayingFile = `${dir}/${NOW_PLAYING_FILE}`;
  // Jellyfin has one account for the cinema, so only the first server keeps its progress
  // there; the others go on from their own history, or they would pick up each other's.
  const jellyfinProgress = dir === 'data';
  const { history, addWatch, recordWatch, removeWatch } = createHistory(dir);
  const { loadSettings, updateSettings } = createSettings(dir);
  const { loadQuality, saveQuality } = createQualityStore(dir);
  let quality = DEFAULT_QUALITY;
  let sound = 'normal';
  let starting = 0; // playbacks being started (the subtitles can take a minute)
  let wishlist = null;
  let helpWishlistId = null; // the wishlist room once it runs, for the help
  let stopHelp = null;
  const itemCache = new Map();
  let nowPlaying = null; // { message, requestedBy, requestedById, resumedFrom, poster, next, skipNext }
  let lastTracks = null; // track languages of the item that just stopped, for the next episode
  let lastStop = null; // where the item that just stopped was, for the button on its message
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

  const savesToJellyfin = item => jellyfinProgress && !item.web;

  async function cachedItem(id) {
    const hit = itemCache.get(id);
    if (hit && hit.expires > Date.now()) return hit.item;
    const item = await loadItem(id);
    for (const [key, entry] of itemCache) if (entry.expires <= Date.now()) itemCache.delete(key);
    itemCache.set(id, { item, expires: Date.now() + ITEM_CACHE_MS });
    return item;
  }

  const { genres, decodeFilter, filterFromOptions, historyList, libraryList, seasonList, episodeList } = createBrowser({ history, cachedItem });

  async function resolveItem(written) {
    const value = webAddress(written);
    if (ITEM_ID.test(value) || isWebUrl(value)) return cachedItem(value);
    if (isLink(value)) throw new UserError('Odkazy umím jen z YouTube a Kicku.');
    const [hit] = await searchItems(value, 1);
    if (!hit) throw new UserError(`Nic jako „${value}“ jsem v Jellyfinu nenašel.`);
    return cachedItem(hit.Id);
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
      const link = webAddress(focused.value);
      if (isLink(link)) {
        // A choice's value holds 100 characters; a longer link is sent as written.
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
        { name: 'Titulky', value: player.subtitleTrack ? trackLabel(player.subtitleTrack) : player.subtitleFailed ? '⚠️ nešly načíst, běží bez nich' : 'vypnuto', inline: false },
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

  /**
   * For a message of something not finished: a button that goes on from where it stopped.
   * The ID carries it all ("fr:<position>:<audio>:<subtitle>:<item>"), so it works after
   * restarts; an ID holds 100 characters, which a long web address may not fit.
   * audio DEFAULT_TRACKS: not known, the usual choice (Czech first) is made when clicked.
   */
  function resumeRow(itemId, position, audio, subtitle, live = false) {
    const id = `fr:${Math.floor(position)}:${audio ?? ''}:${subtitle ?? ''}:${itemId}`;
    if (id.length > 100) return [];
    const label = live ? '▶ Naladit znovu' : position < RESUME_MIN_SECONDS ? '▶ Pustit znovu' : `▶ Pokračovat od ${formatTime(position)}`;
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Primary))];
  }

  function resumeRows(item) {
    if (lastStop?.itemId !== item.Id || lastStop.done) return [];
    return resumeRow(item.Id, lastStop.position, lastStop.audio, lastStop.subtitle, item.web?.live);
  }

  /**
   * Messages from before the button existed get it once, from the history: the newest
   * message of each title, when the title's latest entry is not finished. A message of
   * a stopped item is the one with just a title and text (now-playing ones have fields).
   */
  async function backfillResumeButtons() {
    if ((await loadSettings()).resumeBackfilled) return;
    const latest = new Map();
    for (const entry of await history()) if (!latest.has(entry.label)) latest.set(entry.label, entry);
    const seen = new Set();
    let added = 0;
    let before;
    for (let scanned = 0; scanned < BACKFILL_MESSAGES;) {
      const batch = await textChannel().messages.fetch({ limit: 100, before });
      if (!batch.size) break;
      scanned += batch.size;
      before = batch.last().id;
      for (const message of batch.values()) {
        const embed = message.embeds[0];
        const entry = latest.get(embed?.title);
        if (message.author.id !== client.user.id || !entry || embed.fields.length || seen.has(entry.label)) continue;
        seen.add(entry.label);
        if (entry.finished || message.components.length) continue;
        const components = resumeRow(entry.id, entry.position, DEFAULT_TRACKS, '');
        if (!components.length) continue;
        await message.edit({ components });
        added++;
      }
    }
    await updateSettings({ resumeBackfilled: true });
    console.log(`Added the go-on button to ${added} old message(s) in ${guild.name}`);
  }

  function endedPayload(item, text) {
    return { content: '', embeds: [endedEmbed(item, text)], components: resumeRows(item), attachments: [] };
  }

  async function handleResume(interaction) {
    const [, position, audio, subtitle, ...rest] = interaction.customId.split(':');
    const id = rest.join(':');
    if (busyElsewhere()) throw new UserError(BUSY);
    if (playing() && player.item.Id === id) throw new UserError('Tohle už běží.');
    await interaction.deferReply();
    const seconds = Number(position);
    const index = value => (value === '' ? null : Number(value));
    await startPlayback(interaction, await cachedItem(id), {
      startSeconds: seconds < RESUME_MIN_SECONDS ? 0 : seconds - RESUME_REWIND_SECONDS,
      tracks: audio === DEFAULT_TRACKS ? null : { audioIndex: index(audio), subtitleIndex: index(subtitle) },
    });
    // The new message has the controls now.
    await interaction.message.edit({ components: [] }).catch(() => {});
  }

  async function retireNowPlaying(item, text, { remove = false } = {}) {
    const message = nowPlaying?.message;
    nowPlaying = null;
    await forgetNowPlaying();
    if (!message) return;
    if (remove) await message.delete().catch(() => {});
    else await message.edit(endedPayload(item, text)).catch(() => {});
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
      skipNext: current.skipNext,
      // For the history and the message, when it does not go on after the restart.
      label: itemLabel(player.item),
      startedAt: player.itemStartedAt,
      duration: player.duration,
      live: !!player.item.web?.live,
      watched: watching?.watched ?? 0,
      viewers: watching?.viewers ?? {},
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
    await current?.message?.edit(endedPayload(item, text)).catch(() => {});
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
    // Someone started something else meanwhile: only the dead message goes.
    if (playing() || starting > 0 || nowPlaying !== current) {
      recovery = null;
      return current?.message?.delete().catch(() => {});
    }
    if (!peopleInVoice()) {
      recovery = null;
      return giveUp();
    }
    try {
      // Holds the player until the new start does: loading a web video takes seconds.
      const fresh = await loadItem(item.Id);
      if (recovery !== token) return undefined;
      recovery = null;
      await beginPlayback(fresh, { startSeconds: Math.max(0, position - 5), tracks, byId: current?.requestedById, skipNext: current?.skipNext },
        current?.requestedBy ?? 'FilmVault', payload => textChannel().send(payload),
        `⚠️ Vysílání spadlo, navázáno od ${formatTime(Math.max(0, position - 5))}.`);
      // /stop came while it was getting ready: it does not come back after a restart either.
      if (current && nowPlaying === current) return retireNowPlaying(item, '⏹ Zastaveno.');
      if (current?.message) await current.message.delete().catch(() => {});
    } catch (error) {
      console.error('Recovery failed:', error.message);
      if (recovery === token) recovery = null;
      // The streamer finished: nothing to go back to.
      if (item.web?.live && LIVE_ENDED.test(error.message)) return retireMessage(current, item, '🔴 Přenos skončil.');
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

  /** Where this server left off something Jellyfin does not keep for it (see jellyfinProgress). */
  async function historyResume(item) {
    if (item.web?.live) return null;
    const last = (await history()).find(entry => entry.id === item.Id);
    return last && !last.finished && last.position >= 60 ? Math.max(0, last.position - 5) : null;
  }

  async function startItem(item, { startSeconds = null, zvuk = null, titulky = null, tracks = null, byId = null, skipNext = false } = {}, requestedBy, send, note = '') {
    const source = mediaSource(item);
    const defaults = tracks ?? defaultTracks(source, zvuk && zvuk !== SUBTITLES_OFF ? Number(zvuk) : null);
    const resumedFrom = startSeconds === null ? (savesToJellyfin(item) ? resumeSeconds(item) : await historyResume(item)) : null;
    const previous = playing() ? player.item : null;
    const next = await findNextEpisode(item);
    let started;
    try {
      started = await player.play({
        autoSkipIntro: !!item.SeriesId && (await loadSettings()).skipIntro.includes(item.SeriesId),
        countdown: next && !skipNext ? itemLabel(next) : null,
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
    // /stop, /odejdi or a newer /pust came while this one was getting ready.
    if (!started) {
      await send({ content: '⏹ Tohle puštění bylo zrušeno.', embeds: [], components: [] }).catch(() => {});
      return;
    }
    if (previous) await retireNowPlaying(previous, 'Přepnuto na jiný film.');

    loadSegments(item, next);
    const poster = item.web ? null : await downloadPoster(item);
    if (player.item !== item) {
      await send({ content: '⏹ Zastaveno dřív, než se to stihlo rozběhnout.', embeds: [], components: [] }).catch(() => {});
      return;
    }
    nowPlaying = { message: null, itemId: item.Id, requestedBy, requestedById: byId, resumedFrom, poster, next, skipNext };
    const resumeNote = resumedFrom ? ` Navazuje od ${formatTime(resumedFrom)}, kde jste skončili.` : '';
    const current = nowPlaying;
    try {
      current.message = await send({
        content: `🍿 Běží v <#${voiceChannelId}>. Připoj se a klikni na živé vysílání.${resumeNote}${note ? `\n${note}` : ''}`,
        embeds: [nowPlayingEmbed({ poster: poster && `attachment://${POSTER_FILE}` })],
        components: controls(),
        files: poster ? [new AttachmentBuilder(poster, { name: POSTER_FILE })] : [],
      });
    } catch (error) {
      // Playing with no message would leave nothing to control it with.
      if (nowPlaying === current) await player.stop().catch(() => {});
      throw error;
    }
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
      savesToJellyfin(item) && (position >= 60 || watched)
        ? saveProgress(item.Id, { seconds: position, played: !!watched }).catch(error => console.error('Saving progress failed:', error.message))
        : null,
    ]);
    wishlist?.refresh();
  }

  async function handleListInteraction(interaction) {
    const [prefix, action, ...rest] = interaction.customId.split(':');
    if (interaction.isStringSelectMenu()) {
      const [value] = interaction.values;
      if (prefix === 'fh' && action === 'del') {
        await interaction.deferUpdate();
        const removed = await removeWatch(value);
        if (removed) await wishlist?.restoreWish(removed);
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

  /** From the first of the month: last month's statistics in the cinema room, once. */
  async function postMonthlySummary() {
    const now = Date.now();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
    const month = `${parts.year}-${parts.month}`;
    const settings = await loadSettings();
    if (settings.summaryMonth === month || (Number(parts.day) === 1 && Number(parts.hour) < SUMMARY_HOUR)) return;
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
    if (savesToJellyfin(item)) await saveProgress(item.Id, { seconds: position, played: finished }).catch(error => console.error('Saving progress failed:', error.message));
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
        requireActive();
        await player.pause();
        await refreshNowPlaying();
        return interaction.editReply(`⏸ Pozastaveno na ${formatTime(player.position())}.`);
      case 'pokracuj':
        requireActive();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        requireActive();
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
        if (!playing() && starting > 0) {
          // A full stop: between two episodes the stream stays open waiting for this start.
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await player.stop().catch(() => {});
          return interaction.editReply('⏹ Puštění zrušeno.');
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
        // Another server may have started during the answer above.
        if (busyElsewhere()) throw new UserError(BUSY);
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
    if (error instanceof UserError) console.log(`Refused in ${guild.name}: ${text}`);
    else console.error(error);
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
      const duration = durationSeconds(event.item);
      lastStop = {
        itemId: event.item.Id,
        position: event.position,
        audio: event.audio?.Index ?? null,
        subtitle: event.subtitle?.Index ?? null,
        done: event.finished || (!!duration && event.position >= duration * WATCHED_TAIL),
      };
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

  const timers = [];
  function every(task, ms) {
    const timer = setInterval(task, ms);
    timer.unref();
    timers.push(timer);
  }

  every(countViewers, VIEWER_TICK_MS);
  every(() => {
    if (playing()) saveNowPlaying().catch(error => console.warn('Could not save now playing:', error.message));
  }, NOW_PLAYING_SAVE_MS);

  // Keep the resume position fresh in case the MiniPC or bot dies mid-film.
  let lastSaved = null;
  every(() => {
    if (!playing() || player.paused || !savesToJellyfin(player.item)) return;
    const position = player.position();
    if (position < 60 || lastSaved === Math.round(position)) return;
    lastSaved = Math.round(position);
    saveProgress(player.item.Id, { seconds: position }).catch(error => console.error('Saving progress failed:', error.message));
  }, PROGRESS_SAVE_MS);

  async function handleInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      return autocomplete(interaction).catch(error => {
        console.error('Autocomplete failed:', error.message);
        return interaction.respond([]).catch(() => {});
      });
    }
    // Reading the help takes no role, and the answer is only for whoever clicked.
    if (interaction.isButton() && interaction.customId.startsWith('help:')) {
      const embed = helpTopic(interaction.customId, helpWishlistId);
      const answer = embed ? { embeds: [embed] } : { content: 'Tahle část návodu už není.' };
      return interaction.reply({ ...answer, flags: MessageFlags.Ephemeral }).catch(error => console.warn('Help answer failed:', error.message));
    }
    if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith('fw:')) {
      if (!wishlist) return interaction.reply({ content: 'Seznam filmů teď nefunguje.', flags: MessageFlags.Ephemeral });
      return wishlist.handleInteraction(interaction).catch(error => replyError(interaction, error));
    }
    const isList = (interaction.isButton() || interaction.isStringSelectMenu()) && /^f[lsh]:/.test(interaction.customId);
    const isResume = interaction.isButton() && interaction.customId.startsWith('fr:');
    if (!interaction.isChatInputCommand() && !isList && !isResume && !(interaction.isButton() && interaction.customId.startsWith('fv:'))) return;
    if (interaction.channelId !== textChannelId) {
      console.log(`Refused in ${guild.name}: used outside the cinema's text channel`);
      return interaction.reply({ content: `Kino se ovládá jen v <#${textChannelId}>.`, flags: MessageFlags.Ephemeral });
    }
    if (!allowed(interaction)) {
      console.log(`Refused in ${guild.name}: ${userName(interaction)} lacks the cinema's role`);
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
      else if (isResume) await handleResume(interaction);
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
        jellyfinProgress,
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

  /** A JSON file read once and deleted, with fresh: younger than AUTOPLAY_MAX_AGE_MS; null when there is none. */
  async function takeFile(path) {
    try {
      const { mtimeMs } = await stat(path);
      const data = JSON.parse(await readFile(path, 'utf8'));
      await rm(path, { force: true });
      return { data, fresh: Date.now() - mtimeMs < AUTOPLAY_MAX_AGE_MS };
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
    const saved = await takeFile(nowPlayingFile);
    const state = saved?.data ?? null;
    const taken = await takeFile(`${dir}/${AUTOPLAY_FILE}`);
    const request = taken?.fresh ? taken.data : null;
    await deleteDeadMessages(state?.messageId);
    const fresh = saved?.fresh ? state : null;
    // Too old to go on by itself: what played still counts, and its message offers to go on later.
    if (state && !fresh) await closeInterrupted(state, '⏹ Přerušeno, kino bylo dlouho vypnuté.');
    const itemId = fresh?.itemId ?? request?.itemId;
    const notResuming = reason => (fresh ? closeInterrupted(fresh, reason) : undefined);
    if (!itemId) return undefined;
    // Another server went on with its film (the deploy script's autoplay is for the first server).
    if (busyElsewhere()) {
      console.log('Not resuming after restart: the cinema plays on another server');
      return notResuming('⏹ Přerušeno restartem kina.');
    }
    if (!peopleInVoice()) {
      console.log('Not resuming after restart: nobody in the voice room');
      return notResuming('⏹ Přerušeno restartem kina, v hovoru nikdo nebyl.');
    }
    try {
      const item = await loadItem(itemId);
      console.log(`Playing ${itemLabel(item)} again after restart`);
      const send = payload => textChannel().send(payload);
      if (fresh) {
        const startSeconds = Math.max(0, state.position - 5);
        await beginPlayback(item, {
          startSeconds, tracks: { audioIndex: state.audioIndex, subtitleIndex: state.subtitleIndex }, byId: state.byId, skipNext: state.skipNext,
        }, state.by ?? 'FilmVault', send, `🔄 Kino se restartovalo, navázáno od ${formatTime(startSeconds)}.`);
        await textChannel().messages.delete(state.messageId).catch(() => {});
      } else {
        await beginPlayback(item, {}, request.by ?? 'restart', send);
      }
    } catch (error) {
      console.error('Autoplay after restart failed:', error);
      return notResuming('⏹ Přerušeno restartem kina, nepodařilo se navázat.');
    }
    return undefined;
  }

  /** What was playing when the bot went down, and will not go on by itself. */
  async function closeInterrupted(state, text) {
    if (state.label) {
      const tail = state.duration && state.position >= state.duration * WATCHED_TAIL;
      await recordWatch({
        id: state.itemId,
        label: state.label,
        by: state.by,
        byId: state.byId,
        startedAt: state.startedAt ?? state.savedAt,
        position: state.position,
        duration: state.duration,
        finished: !!tail || state.live,
        watched: state.watched,
        viewers: state.viewers,
      });
    }
    const message = await textChannel().messages.fetch(state.messageId).catch(() => null);
    if (!message) return;
    const title = state.label ?? message.embeds[0]?.title;
    await message.edit({
      content: '',
      embeds: title ? [new EmbedBuilder().setColor(0x4e5058).setTitle(title).setDescription(text)] : [],
      components: resumeRow(state.itemId, state.position, state.audioIndex, state.subtitleIndex, state.live),
      attachments: [],
    }).catch(() => {});
  }

  async function start() {
    const text = client.channels.cache.get(textChannelId);
    const voice = client.channels.cache.get(voiceChannelId);
    if (!text || !voice) throw new Error(`Channels of ${guild.name} not found, /nastavit sets new ones`);
    quality = await loadQuality();
    sound = (await loadSettings()).sound;
    await guild.commands.set([...commands, setupCommand]);
    console.log(`Registered ${commands.length + 1} slash commands in ${guild.name}; text #${text.name}, voice ${voice.name}`);
    helpWishlistId = await startWishlist();
    stopHelp = await keepHelpLast(client, text, voice.id, helpWishlistId, allowedRole).catch(error => {
      console.error('Help message failed:', error.message);
      return null;
    });
    await playAfterRestart();
    backfillResumeButtons().catch(error => console.error('Adding go-on buttons failed:', error.message));
    every(() => postMonthlySummary().catch(error => console.error('Monthly summary failed:', error)), SUMMARY_CHECK_MS);
    postMonthlySummary().catch(error => console.error('Monthly summary failed:', error));
  }

  /** The cinema goes away (the bot left the server, or it gets new channels). */
  async function close() {
    for (const timer of timers) clearInterval(timer);
    clearTimeout(aloneTimer);
    wishlist?.stop();
    stopHelp?.();
    recovery = null;
    if (player.guildId === guildId && (player.channelId || player.active)) await player.leave().catch(() => {});
  }

  return { start, close, busy, handleInteraction, checkAlone, onPlayer };
}
