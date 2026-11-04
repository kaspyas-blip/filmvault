import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { allT, t } from './i18n.js';

const HELP_TITLE = t('help.title');
const BUTTONS_PER_ROW = 3;
const COLOR = 0x5865f2;

// Opened by the buttons, for whoever clicked; wishlist: needs the room. Labels and texts
// are help.<topic>.label and help.<topic>.text in the catalogs.
const TOPICS = {
  pust: {},
  ovladani: {},
  historie: {},
  seznam: { wishlist: true },
  samo: {},
  pomoc: {},
};

function shownTopics(wishlistChannelId) {
  return Object.entries(TOPICS).filter(([, topic]) => !topic.wishlist || wishlistChannelId);
}

/** The short message itself; the details are behind the buttons. */
function helpEmbed(voiceChannelId, wishlistChannelId, allowedRole) {
  const role = !allowedRole ? null : /^\d+$/.test(allowedRole) ? `<@&${allowedRole}>` : `**${allowedRole}**`;
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(HELP_TITLE)
    .setDescription([
      t('help.intro1', { channel: voiceChannelId }),
      t('help.intro2'),
      wishlistChannelId && t('help.introWishlist', { channel: wishlistChannelId }),
      role && t('help.introRole', { role }),
    ].filter(Boolean).join('\n'));
}

function helpButtons(wishlistChannelId) {
  const buttons = shownTopics(wishlistChannelId).map(([key]) =>
    new ButtonBuilder().setCustomId(`help:${key}`).setLabel(t(`help.${key}.label`)).setStyle(ButtonStyle.Secondary));
  const rows = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + BUTTONS_PER_ROW)));
  }
  return rows;
}

/** What a help button opens, or null when it is not one of ours (from an older version). */
export function helpTopic(customId, wishlistChannelId) {
  const key = customId.split(':')[1];
  const topic = TOPICS[key];
  if (!topic || (topic.wishlist && !wishlistChannelId)) return null;
  return new EmbedBuilder().setColor(COLOR).setTitle(t(`help.${key}.label`)).setDescription(t(`help.${key}.text`, { channel: wishlistChannelId }));
}

const REPOST_DELAY_MS = 3000;

/**
 * Keeps the help message as the last message in the text channel, like the wishlist:
 * whenever something else is posted there it is sent again and the old copy deleted.
 * It used to be pinned; old pinned copies are removed on start. Edits itself when the
 * text changes. wishlistChannelId: the "want to watch" room, or null when it is off.
 */
export async function keepHelpLast(client, channel, voiceChannelId, wishlistChannelId = null, allowedRole = null) {
  const embed = helpEmbed(voiceChannelId, wishlistChannelId, allowedRole);
  const components = helpButtons(wishlistChannelId);
  const version = createHash('sha1').update(JSON.stringify([embed.toJSON(), components.map(row => row.toJSON())])).digest('hex').slice(0, 8);
  embed.setFooter({ text: t('help.footer', { version }) });
  const payload = { embeds: [embed], components };

  // Also a copy in the other language, from before LANGUAGE was changed: it is edited into this one.
  const titles = allT('help.title');
  const isHelp = m => m.author.id === client.user.id && titles.includes(m.embeds[0]?.title);
  const pins = await channel.messages.fetchPins().catch(() => ({ items: [] }));
  const recent = await channel.messages.fetch({ limit: 50 });
  const copies = [...new Map([...pins.items.map(p => p.message), ...recent.values()].filter(isHelp).map(m => [m.id, m])).values()];
  let current = copies.find(m => m.id === channel.lastMessageId) ?? null;
  for (const old of copies) if (old !== current) await old.delete().catch(() => {});
  if (current && !current.embeds[0].footer?.text?.endsWith(version)) {
    await current.edit(payload);
    console.log('Help message updated');
  }

  let reposting = Promise.resolve();
  let timer = null;
  async function repost() {
    if (current && channel.lastMessageId === current.id) return;
    const previous = current;
    current = await channel.send(payload);
    await previous?.delete().catch(() => {});
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      reposting = reposting.then(repost).catch(error => console.error('Help message repost failed:', error.message));
    }, REPOST_DELAY_MS);
  };
  const onMessage = message => {
    if (message.channelId === channel.id && message.id !== current?.id) schedule();
  };
  client.on('messageCreate', onMessage);
  if (!current) await repost();
  return () => {
    client.off('messageCreate', onMessage);
    clearTimeout(timer);
  };
}
