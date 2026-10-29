import { createHash } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { config } from './config.js';

const HELP_TITLE = '🎬 Kino FilmVault – jak na to';

function helpEmbed(voiceChannelId, wishlistChannelId) {
  const role = config.allowedRole && !/^\d+$/.test(config.allowedRole) ? `roli **${config.allowedRole}**` : 'oprávněnou roli';
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(HELP_TITLE)
    .setDescription([
      `Filmy se pouštějí tady, běží v <#${voiceChannelId}> jako živé vysílání účtu **filmvault**.`,
      'Připoj se do hovoru a klikni na vysílání. Ovládat kino můžou lidi s ' + role + '.',
    ].join('\n'))
    .addFields(
      {
        name: '🍿 Výběr a puštění',
        value: [
          '`/pust film` – pustí film nebo díl, název se našeptává. Volitelně `od` (`1:20:00`, `45` = minut, `0` = od začátku), `zvuk` a `titulky`.',
          '`/filmy` – všechny filmy po 20 na stranu. Filtry: `zanr`, `rok` (`2005` nebo `1990-1999`), `cesky` (jen s dabingem), `razeni` (název, naposledy přidané, nejnovější, hodnocení). Film pustíš z nabídky pod seznamem.',
          '`/serialy` – vybereš seriál → sérii → díl.',
          '`/videli` – co jsme viděli, kdy, kdo to pustil a kde jsme skončili. Nedokoukané jde pustit dál, omylem zapsané odebrat z nabídky 🗑.',
          '`/zapsat film` – ručně zapíše do historie, co jste viděli jinde. Volitelně `kdy` (`včera`, `28.10. 21:30`) a `skoncili` (`1:20:00`, jinak dokoukáno).',
          wishlistChannelId && `**Chceme vidět** – napiš název filmu do <#${wishlistChannelId}> a bot ho přidá na seznam s info z IMDb. 🎲 vybere náhodně film, který máme; přes ✏️ jde nastavit, že film máme jinde (YouTube).`,
        ].filter(Boolean).join('\n'),
      },
      {
        name: '⏯️ Během přehrávání',
        value: [
          '`/pauza`, `/pokracuj` – pozastaví / pustí dál',
          '`/posun cas` – `1:20:00` na čas, `+5` / `-2` o minuty, `+30s` o sekundy',
          '`/zvuk`, `/titulky` – změní zvukovou stopu nebo titulky (i vypnout)',
          '`/hraje` – co hraje a v jakém čase',
          '`/stop` – zastaví · `/odejdi` – zastaví a kino odejde z hovoru',
          'Tlačítka pod zprávou: **−1 min · pauza · +1 min · +10 min · stop**',
        ].join('\n'),
      },
      {
        name: '✨ Samo od sebe',
        value: [
          '**Navazování** – `/pust` pokračuje tam, kde jste skončili; tlačítko *Pustit od začátku* to vrátí na začátek.',
          '**Další díl** – po dohrání dílu se za 15 s pustí další (i do další série) se stejným jazykem. Jde to zrušit.',
          '**Čeština** – bez výběru stopy se bere český dabing, a když není, české titulky.',
          '**Úklid** – když všichni odejdou z hovoru, kino po 2 min přestane vysílat; bez přehrávání odejde po 5 min.',
        ].join('\n'),
      },
      {
        name: '❓ Když něco nejde',
        value: [
          'Obraz se načítá pár sekund, chvilku počkej. Když přehrávání spadne, napiš znovu `/pust` – naváže, kde to spadlo.',
          'Na telefonu zní zvuk jako hovor (Discord to tak dělá v každém hlasovém kanálu), sluchátka nebo PC pomůžou.',
        ].join('\n'),
      },
    );
}

/** Posts the help message into the text channel and pins it; edits it in place when the text changes. */
/** wishlistChannelId: the "want to watch" room, or null when it is off. */
export async function ensureHelpPinned(client, channel, voiceChannelId, wishlistChannelId = null) {
  const embed = helpEmbed(voiceChannelId, wishlistChannelId);
  const version = createHash('sha1').update(JSON.stringify(embed.toJSON())).digest('hex').slice(0, 8);
  embed.setFooter({ text: `Návod se aktualizuje sám · ${version}` });

  const isHelp = m => m.author.id === client.user.id && m.embeds[0]?.title === HELP_TITLE;
  const pins = await channel.messages.fetchPins();
  // Not pinned yet (e.g. the bot lacked the permission last time): look among recent messages.
  let message = pins.items.map(p => p.message).find(isHelp)
    ?? (await channel.messages.fetch({ limit: 50 })).find(isHelp);
  if (!message) {
    message = await channel.send({ embeds: [embed] });
    console.log('Help message posted');
  } else if (!message.embeds[0].footer?.text?.endsWith(version)) {
    await message.edit({ embeds: [embed] });
    console.log('Help message updated');
  }
  if (message.pinned) return;
  try {
    await message.pin();
    console.log('Help message pinned');
  } catch (error) {
    console.warn(`Help message not pinned (${error.message}); give the bot "Pin Messages" in #${channel.name}`);
  }
}
