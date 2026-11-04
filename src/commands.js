import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { QUALITIES, qualityLabel } from './quality.js';
import { SOUND_MODES } from './settings.js';
import { PERIODS } from './stats.js';

export const commands = [
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
export const setupCommand = new SlashCommandBuilder().setName('nastavit').setDescription('Nastaví kino na tomhle serveru (jen pro správce)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(o => o.setName('textovy').setDescription('Kanál, kde se kino ovládá').setRequired(true)
    .addChannelTypes(ChannelType.GuildText))
  .addChannelOption(o => o.setName('hlasovy').setDescription('Hlasový kanál, kam se vysílá').setRequired(true)
    .addChannelTypes(ChannelType.GuildVoice))
  .addChannelOption(o => o.setName('seznam').setDescription('Roomka „Chceme vidět“ (nepovinné)')
    .addChannelTypes(ChannelType.GuildText))
  .addRoleOption(o => o.setName('role').setDescription('Jen tahle role smí ovládat kino (nepovinné, jinak zůstává jak je)'))
  .addBooleanOption(o => o.setName('pro_vsechny').setDescription('Ovládat smí všichni, zruší omezení rolí'))
  .addBooleanOption(o => o.setName('bez_seznamu').setDescription('Vypne roomku „Chceme vidět“'))
  .toJSON();
