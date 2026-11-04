import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { SORTS } from './jellyfin.js';
import { t, tIn } from './i18n.js';
import { QUALITIES, qualityLabel } from './quality.js';
import { SOUND_MODES } from './settings.js';
import { PERIODS } from './stats.js';

// The registered command and option names stay the Czech ones, the code reads them. English
// Discord clients are shown the English names and texts of en.js through the localizations.
const ENGLISH_LOCALES = ['en-US', 'en-GB'];

const english = key => Object.fromEntries(ENGLISH_LOCALES.map(locale => [locale, tIn('en', key)]));

// Names and descriptions of a command or option; the default description is in the configured language.
function described(builder, key) {
  return builder
    .setNameLocalizations(english(`${key}.name`))
    .setDescription(t(`${key}.description`))
    .setDescriptionLocalizations(english(`${key}.description`));
}

// A choice shown in the configured language, and in English to English clients.
function choice(value, name, englishName) {
  return {
    name,
    name_localizations: Object.fromEntries(ENGLISH_LOCALES.map(locale => [locale, englishName])),
    value,
  };
}

const command = name => described(new SlashCommandBuilder().setName(name), `cmd.${name}`);
const option = (builder, name, key) => described(builder.setName(name), key);

export const commands = [
  command('pust')
    .addStringOption(o => option(o, 'film', 'cmd.pust.film').setRequired(true).setAutocomplete(true))
    .addStringOption(o => option(o, 'od', 'cmd.pust.od'))
    .addStringOption(o => option(o, 'zvuk', 'cmd.pust.zvuk').setAutocomplete(true))
    .addStringOption(o => option(o, 'titulky', 'cmd.pust.titulky').setAutocomplete(true)),
  command('pauza'),
  command('pokracuj'),
  command('posun')
    .addStringOption(o => option(o, 'cas', 'cmd.posun.cas').setRequired(true)),
  command('zvuk')
    .addStringOption(o => option(o, 'stopa', 'cmd.zvuk.stopa').setRequired(true).setAutocomplete(true)),
  command('titulky')
    .addStringOption(o => option(o, 'stopa', 'cmd.titulky.stopa').setRequired(true).setAutocomplete(true)),
  command('kvalita')
    .addStringOption(o => option(o, 'uroven', 'cmd.kvalita.uroven')
      .addChoices(...Object.keys(QUALITIES).map(key => choice(key, qualityLabel(key), qualityLabel(key, 'en'))))),
  command('hlasitost')
    .addStringOption(o => option(o, 'rezim', 'cmd.hlasitost.rezim')
      .addChoices(...Object.entries(SOUND_MODES).map(([value, name]) => choice(value, name, tIn('en', `sound.${value}`))))),
  command('statistiky')
    .addUserOption(o => option(o, 'kdo', 'cmd.statistiky.kdo'))
    .addStringOption(o => option(o, 'obdobi', 'cmd.statistiky.obdobi')
      .addChoices(...Object.entries(PERIODS).map(([value, { label }]) => choice(value, label, tIn('en', `period.${value}`))))),
  command('stav'),
  command('filmy')
    .addStringOption(o => option(o, 'zanr', 'cmd.filmy.zanr').setAutocomplete(true))
    .addStringOption(o => option(o, 'rok', 'cmd.filmy.rok'))
    .addBooleanOption(o => option(o, 'cesky', 'cmd.filmy.cesky'))
    .addStringOption(o => option(o, 'razeni', 'cmd.filmy.razeni').addChoices(
      ...Object.entries(SORTS).map(([value, { label }]) => choice(value, label, tIn('en', `sort.${value}`))),
    ))
    .addIntegerOption(o => option(o, 'strana', 'cmd.filmy.strana').setMinValue(1)),
  command('serialy')
    .addIntegerOption(o => option(o, 'strana', 'cmd.serialy.strana').setMinValue(1)),
  command('videli')
    .addIntegerOption(o => option(o, 'strana', 'cmd.videli.strana').setMinValue(1)),
  command('zapsat')
    .addStringOption(o => option(o, 'film', 'cmd.zapsat.film').setRequired(true).setAutocomplete(true))
    .addStringOption(o => option(o, 'kdy', 'cmd.zapsat.kdy'))
    .addStringOption(o => option(o, 'skoncili', 'cmd.zapsat.skoncili')),
  command('hraje'),
  command('stop'),
  command('odejdi'),
].map(c => c.toJSON());

// The only command on a server without a cinema yet.
export const setupCommand = command('nastavit')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(o => option(o, 'textovy', 'cmd.nastavit.textovy').setRequired(true)
    .addChannelTypes(ChannelType.GuildText))
  .addChannelOption(o => option(o, 'hlasovy', 'cmd.nastavit.hlasovy').setRequired(true)
    .addChannelTypes(ChannelType.GuildVoice))
  .addChannelOption(o => option(o, 'seznam', 'cmd.nastavit.seznam')
    .addChannelTypes(ChannelType.GuildText))
  .addRoleOption(o => option(o, 'role', 'cmd.nastavit.role'))
  .addBooleanOption(o => option(o, 'pro_vsechny', 'cmd.nastavit.pro_vsechny'))
  .addBooleanOption(o => option(o, 'bez_seznamu', 'cmd.nastavit.bez_seznamu'))
  .toJSON();
