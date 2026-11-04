import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

const HELP_TITLE = '🎬 Kino FilmVault – jak na to';
const BUTTONS_PER_ROW = 3;
const COLOR = 0x5865f2;

// Opened by the buttons, for whoever clicked; wishlist: needs the room.
const TOPICS = {
  pust: {
    label: '🍿 Pouštění',
    lines: () => [
      '`/pust` – pustí film nebo díl, název se našeptává. Místo názvu můžeš vložit odkaz na YouTube video, přenos nebo Kick kanál.',
      '· `od` – odkud: `1:20:00`, `45` = minut, `0` = od začátku',
      '· `zvuk`, `titulky` – která stopa',
      '',
      '`/filmy` – všechny filmy po 20 na stranu, film pustíš z nabídky pod seznamem.',
      '· `zanr` – jen tento žánr',
      '· `rok` – `2005` nebo `1990-1999`',
      '· `cesky` – jen s českým dabingem',
      '· `razeni` – název, naposledy přidané, nejnovější, hodnocení',
      '',
      '`/serialy` – vybereš seriál, sérii a díl.',
      '',
      'Film běží jako živé vysílání účtu **filmvault**. Živé přenosy jdou pauzovat, ale ne posouvat.',
    ],
  },
  ovladani: {
    label: '⏯️ Během filmu',
    lines: () => [
      '**Tlačítka pod zprávou filmu:** −1 min, pauza, +1 min, +10 min, stop',
      '`/posun` – `1:20:00` na čas, `+5` / `-2` minuty, `+30s` sekundy',
      '`/pauza`, `/pokracuj` – pozastaví, pustí dál',
      '`/zvuk`, `/titulky` – změní zvukovou stopu nebo titulky, titulky jdou i vypnout',
      '`/kvalita` – vysoká, střední, nízká; když se obraz seká (mění se všem)',
      '`/hlasitost` – vyrovnaný zvuk na noc: hlasitější dialogy, tišší výbuchy',
      '`/hraje` – co hraje a v jakém čase',
      '`/stop` – zastaví',
      '`/odejdi` – zastaví a kino odejde z hovoru',
    ],
  },
  historie: {
    label: '📊 Historie',
    lines: () => [
      '`/videli` – co jste viděli, kdy, kdo to pustil a kde jste skončili. Nedokoukané jde pustit dál, omylem zapsané odebrat z nabídky 🗑.',
      '',
      '`/zapsat` – ručně zapíše, co jste viděli jinde.',
      '· `kdy` – `včera`, `28.10. 21:30`',
      '· `skoncili` – `1:20:00`, jinak se bere jako dokoukané',
      '',
      '`/statistiky` – žebříčky, rekordy a odznaky.',
      '· `kdo` – osobní statistiky',
      '· `obdobi` – tento měsíc, minulý měsíc, letos, celkově',
      '',
      'Prvního v měsíci přijde souhrn.',
    ],
  },
  seznam: {
    label: '🎲 Chceme vidět',
    wishlist: true,
    lines: ({ wishlistChannelId }) => [
      `Napiš název filmu do <#${wishlistChannelId}> a bot ho přidá na seznam s info z IMDb.`,
      '🎲 vybere náhodně film, který máte',
      '✏️ upraví film: že ho máte jinde (YouTube), že jste ho viděli, nebo ho odebere',
      '',
      'Když film přibude do Jellyfinu, bot to v roomce ohlásí.',
    ],
  },
  samo: {
    label: '✨ Co umí samo',
    lines: () => [
      '**Navazování** – `/pust` pokračuje, kde jste skončili; tlačítko *Pustit od začátku* to vrátí na začátek.',
      '**Další díl** – 25 s před závěrečnými titulky běží v rohu odpočet a po 5 s titulků hned naváže další díl (i do další série) se stejným jazykem. Potitulkové scény se nepřeskakují. Zrušit jde tlačítkem *Nepouštět další díl*.',
      '**Úvodní znělka** – tlačítko *Přeskočit úvod*; seriál si to pamatuje a u dalších dílů ji přeskočí sám.',
      '**Čeština** – bez výběru stopy se bere český dabing, a když není, české titulky.',
      '**Pády** – když vysílání nebo bot spadne, kino samo naváže, kde to bylo, a starou zprávu smaže.',
      '**Úklid** – když všichni odejdou z hovoru, kino po 2 min přestane vysílat; bez přehrávání odejde po 5 min.',
    ],
  },
  pomoc: {
    label: '❓ Když něco nejde',
    lines: () => [
      '**Nejde obraz** – počkej pár sekund, načítá se',
      '**Seká se** – `/kvalita`',
      '**Spadlo to** – `/pust` naváže, kde to spadlo; `/stav` ukáže, jak se kinu daří',
      '**Hraje jinde** – kino umí jen jeden server naráz, po dohrání je zase volné',
      '**Telefon zní jako hovor** – to dělá Discord; pomůžou sluchátka nebo PC',
    ],
  },
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
      `**\`/pust\` + název filmu nebo odkaz** a běží to v <#${voiceChannelId}>.`,
      'Připoj se do hovoru a klikni na živé vysílání. Ovládání je pod zprávou filmu.',
      wishlistChannelId && `Co chcete vidět, pište do <#${wishlistChannelId}>.`,
      role && `Ovládat kino smí role ${role}.`,
    ].filter(Boolean).join('\n'));
}

function helpButtons(wishlistChannelId) {
  const buttons = shownTopics(wishlistChannelId).map(([key, { label }]) =>
    new ButtonBuilder().setCustomId(`help:${key}`).setLabel(label).setStyle(ButtonStyle.Secondary));
  const rows = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + BUTTONS_PER_ROW)));
  }
  return rows;
}

/** What a help button opens, or null when it is not one of ours (from an older version). */
export function helpTopic(customId, wishlistChannelId) {
  const topic = TOPICS[customId.split(':')[1]];
  if (!topic || (topic.wishlist && !wishlistChannelId)) return null;
  return new EmbedBuilder().setColor(COLOR).setTitle(topic.label).setDescription(topic.lines({ wishlistChannelId }).join('\n'));
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
  embed.setFooter({ text: `Podrobnosti pod tlačítky, vidíš je jen ty · ${version}` });
  const payload = { embeds: [embed], components };

  const isHelp = m => m.author.id === client.user.id && m.embeds[0]?.title === HELP_TITLE;
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
  client.on('messageCreate', message => {
    if (message.channelId === channel.id && message.id !== current?.id) schedule();
  });
  if (!current) await repost();
}
