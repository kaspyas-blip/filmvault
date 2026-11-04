// Started by i18n.test.js with LANGUAGE, PREFERRED_LANGUAGE and TIMEZONE of its own: the
// language is fixed when the bot starts, so each one needs a process. Prints what the
// modules make of them as JSON.
const { config } = await import('../src/config.js');
const { t } = await import('../src/i18n.js');
const { CommandInteractionOptionResolver } = await import('discord.js');
const { commands, setupCommand, useCodeNames } = await import('../src/commands.js');
const { helpTopic, keepHelpLast } = await import('../src/help.js');
const { isPreferred } = await import('../src/jellyfin.js');
const { formatDate } = await import('../src/browse.js');
const { parseWhen } = await import('../src/time.js');
const { periodRange, plural } = await import('../src/stats.js');
const { qualityLabel } = await import('../src/quality.js');

async function helpMessage(wishlistChannelId, allowedRole) {
  const sent = [];
  const channel = {
    id: 'channel',
    lastMessageId: null,
    messages: { fetchPins: async () => ({ items: [] }), fetch: async () => new Map() },
    send: async payload => {
      sent.push(payload);
      return { id: 'message' };
    },
  };
  const stop = await keepHelpLast({ user: { id: 'me' }, on() {}, off() {} }, channel, '111', wishlistChannelId, allowedRole);
  stop();
  return { embeds: sent[0].embeds.map(e => e.toJSON()), components: sent[0].components.map(row => row.toJSON()) };
}

const topics = {};
for (const key of ['pust', 'ovladani', 'historie', 'seznam', 'samo', 'pomoc']) topics[key] = helpTopic(`help:${key}`, '222').toJSON();

// As Discord reports a command: under its registered names, read by the real resolver of discord.js.
function arrives(key, options) {
  const interaction = {
    commandName: t(`cmd.${key}.name`),
    options: new CommandInteractionOptionResolver({}, options.map(([optionKey, value, focused]) => ({
      name: t(`cmd.${key}.${optionKey}.name`), type: 3, value, ...(focused ? { focused } : {}),
    })), {}),
  };
  useCodeNames(interaction);
  return interaction;
}
const play = arrives('pust', [['od', '45'], ['film', 'Du', true]]);
const setup = arrives('nastavit', [['role', 'kino']]);
const sound = arrives('hlasitost', [['rezim', 'night']]);

const now = new Date(2026, 9, 29, 12, 0);
console.log(JSON.stringify({
  language: config.language,
  busy: t('cinema.busy'),
  commands,
  setupCommand,
  incoming: { commandName: play.commandName, od: play.options.getString('od'), focused: play.options.getFocused(true).name, movie: play.options.get('movie') },
  incomingSetup: { commandName: setup.commandName, role: setup.options.getString('role') },
  incomingSound: { commandName: sound.commandName, rezim: sound.options.getString('rezim') },
  help: {
    withWishlist: await helpMessage('222', 'Kino'),
    withoutWishlist: await helpMessage(null, null),
    topics,
    hiddenTopic: helpTopic('help:seznam', null),
  },
  plurals: [0, 1, 2, 4, 5, 11, 21].map(n => plural('film', n)),
  quality: qualityLabel('vysoka'),
  // Czech streams, then Polish ones, then a code no table knows
  preferred: [{ Language: 'ces' }, { Title: 'Česky 5.1' }, { Language: 'pol' }, { Title: 'Polski' }, { Language: 'xx' }, { Title: 'xx' }, {}].map(isPreferred),
  firstOfJune: periodRange('mesic', Date.UTC(2026, 5, 15))[0],
  date: formatDate(Date.UTC(2026, 9, 28, 19, 30)),
  yesterday: parseWhen('yesterday', now) === parseWhen('včera', now),
}));
