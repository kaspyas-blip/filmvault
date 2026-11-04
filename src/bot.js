import { Client, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createCinema } from './cinema.js';
import { setupCommand } from './commands.js';
import { config } from './config.js';
import { loadGuilds, saveGuilds } from './guilds.js';
import { t } from './i18n.js';
import { updateYtDlp } from './web.js';

const YTDLP_UPDATE_MS = 24 * 60 * 60_000;
const CINEMA_RETRY_MS = 5 * 60_000;

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

  function addCinema(guild, setup) {
    const cinema = createCinema({
      client,
      player,
      guild,
      setup,
      busyElsewhere: () => [...cinemas.values()].some(other => other !== cinema && other.busy()),
    });
    cinemas.set(guild.id, cinema);
    return cinema;
  }

  /**
   * One server's trouble stays there: the others run, /nastavit stays usable, and a
   * failed start (Discord or Jellyfin down) is tried again.
   */
  async function startCinema(guild, cinema) {
    try {
      await cinema.start();
    } catch (error) {
      console.error(`Cinema of ${guild.name} failed to start:`, error.message);
      if (cinemas.get(guild.id) === cinema) cinemas.delete(guild.id);
      await cinema.close().catch(() => {});
      await guild.commands.set([setupCommand]).catch(setError => console.error(`Commands of ${guild.name}:`, setError.message));
      const retry = setTimeout(() => {
        const setup = setups[guild.id];
        if (setup && !cinemas.has(guild.id)) {
          guild.channels.fetch().then(() => startCinema(guild, addCinema(guild, setup))).catch(fetchError => console.error(`Retrying ${guild.name}:`, fetchError.message));
        }
      }, CINEMA_RETRY_MS);
      retry.unref();
      throw error;
    }
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
    const channel = (wanted, isVoice) => {
      try {
        return findChannel(guild, wanted, isVoice).id;
      } catch (error) {
        console.error(`${guild.name}: ${error.message}. Use /nastavit.`);
        return null;
      }
    };
    const textChannelId = channel(config.textChannel, false);
    const voiceChannelId = channel(config.voiceChannel, true);
    if (!textChannelId || !voiceChannelId) return;
    let wishlistChannelId = null;
    try {
      wishlistChannelId = findChannel(guild, config.wishlistChannel, false).id;
    } catch (error) {
      console.error('Wishlist room:', error.message);
    }
    setups[id] = {
      textChannelId,
      voiceChannelId,
      wishlistChannelId,
      allowedRole: config.allowedRole,
      announceRole: config.announceRole,
      dir: 'data',
    };
    await saveGuilds(setups);
  }

  async function handleSetup(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: t('bot.notAdmin'), flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.guildId;
    const old = setups[id];
    const running = cinemas.get(id);
    if (running?.busy()) return interaction.editReply(t('bot.busyHere'));
    const { options } = interaction;
    setups[id] = {
      textChannelId: options.getChannel('textovy', true).id,
      voiceChannelId: options.getChannel('hlasovy', true).id,
      wishlistChannelId: options.getBoolean('bez_seznamu') ? null : options.getChannel('seznam')?.id ?? old?.wishlistChannelId ?? null,
      allowedRole: options.getBoolean('pro_vsechny') ? null : options.getRole('role')?.id ?? old?.allowedRole ?? null,
      announceRole: old?.announceRole ?? null,
      dir: old?.dir ?? `data/guilds/${id}`,
    };
    await saveGuilds(setups);
    const notes = [];
    if (!player.streamer.client.guilds.cache.has(id)) {
      notes.push(t('bot.noStreamer'));
    }
    if (running) {
      cinemas.delete(id);
      await running.close();
    }
    const guild = await client.guilds.fetch(id);
    await guild.channels.fetch();
    await startCinema(guild, addCinema(guild, setups[id]));
    notes.unshift(t('bot.setupDone'));
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
        const answer = { content: t('bot.setupFailed', { error: error.message }), flags: MessageFlags.Ephemeral };
        return (interaction.deferred ? interaction.followUp(answer) : interaction.reply(answer)).catch(() => {});
      });
    }
    const cinema = cinemas.get(interaction.guildId);
    if (cinema) return cinema.handleInteraction(interaction);
    if (interaction.isRepliable()) {
      return interaction.reply({ content: t('bot.notSetUp'), flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return undefined;
  });

  // Invited to a new server: it can be set up right away. Back on an old one: it goes on.
  client.on('guildCreate', guild => {
    const setup = setups[guild.id];
    const started = setup
      ? guild.channels.fetch().then(() => startCinema(guild, addCinema(guild, setup)))
      : guild.commands.set([setupCommand]);
    started.catch(error => console.error(`Setting up ${guild.name} failed:`, error.message));
  });

  // Thrown out of a server: its film ends, or other servers would hear "plays elsewhere" for hours.
  client.on('guildDelete', guild => {
    const cinema = cinemas.get(guild.id);
    if (!cinema) return;
    console.warn(`The bot left ${guild.name}, its cinema stops`);
    cinemas.delete(guild.id);
    cinema.close().catch(error => console.error(`Closing ${guild.name} failed:`, error.message));
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
        try {
          const guild = await client.guilds.fetch(id);
          await guild.channels.fetch();
          // A call the account was left in before the restart (or a Discord outage) blocks the next join.
          player.guildId = id;
          if (player.streamer.client.guilds.cache.has(id)) player.leaveVoice();
          ready.push([guild, setup]);
        } catch (error) {
          console.error(`Server ${id} cannot be loaded:`, error.message);
        }
      }
      // All known before any starts, so that /nastavit meanwhile does not make a second one.
      // The first server last: it takes the deploy script's autoplay, which is only for
      // when no other server has gone on with what it played.
      ready.sort(([, a], [, b]) => (a.dir === 'data') - (b.dir === 'data'));
      const added = ready.map(([guild, setup]) => [guild, addCinema(guild, setup)]);
      // Not one that /nastavit replaced meanwhile.
      for (const [guild, cinema] of added) if (cinemas.get(guild.id) === cinema) await startCinema(guild, cinema).catch(() => {});
      for (const { id, name } of guilds.values()) {
        if (!setups[id]) {
          await client.guilds.fetch(id).then(guild => guild.commands.set([setupCommand]))
            .catch(error => console.error(`Commands of ${name}:`, error.message));
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
