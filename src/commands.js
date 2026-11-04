import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { SORTS } from './jellyfin.js';
import { t, tIn } from './i18n.js';
import { QUALITIES, qualityLabel } from './quality.js';
import { SOUND_MODES } from './settings.js';
import { PERIODS } from './stats.js';

// Commands are registered under the names of the configured language; a Discord client in
// English or Czech is shown its own. Discord always reports the registered name, and the
// code reads the Czech ones, which useCodeNames translates back to.
const LOCALES = { 'en-US': 'en', 'en-GB': 'en', cs: 'cs' };

const localized = text => Object.fromEntries(Object.entries(LOCALES).map(([locale, language]) => [locale, text(language)]));

// Registered name -> the code's name, with the same for the options of each command.
const codeNames = new Map();

// Names and descriptions of a command or option; the default ones are in the configured language.
function described(builder, key) {
  return builder
    .setName(t(`${key}.name`))
    .setNameLocalizations(localized(language => tIn(language, `${key}.name`)))
    .setDescription(t(`${key}.description`))
    .setDescriptionLocalizations(localized(language => tIn(language, `${key}.description`)));
}

// A choice shown in the configured language, and in their own to English and Czech clients.
function choice(value, text) {
  return { name: text(config.language), name_localizations: localized(text), value };
}

function command(name) {
  codeNames.set(t(`cmd.${name}.name`), { name, options: new Map() });
  return described(new SlashCommandBuilder(), `cmd.${name}`);
}

function option(builder, name, key) {
  const [, commandName] = key.split('.');
  codeNames.get(t(`cmd.${commandName}.name`)).options.set(t(`${key}.name`), name);
  return described(builder, key);
}

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
      .addChoices(...Object.keys(QUALITIES).map(key => choice(key, language => qualityLabel(key, language))))),
  command('hlasitost')
    .addStringOption(o => option(o, 'rezim', 'cmd.hlasitost.rezim')
      .addChoices(...Object.keys(SOUND_MODES).map(value => choice(value, language => tIn(language, `sound.${value}`))))),
  command('statistiky')
    .addUserOption(o => option(o, 'kdo', 'cmd.statistiky.kdo'))
    .addStringOption(o => option(o, 'obdobi', 'cmd.statistiky.obdobi')
      .addChoices(...Object.keys(PERIODS).map(value => choice(value, language => tIn(language, `period.${value}`))))),
  command('stav'),
  command('filmy')
    .addStringOption(o => option(o, 'zanr', 'cmd.filmy.zanr').setAutocomplete(true))
    .addStringOption(o => option(o, 'rok', 'cmd.filmy.rok'))
    .addBooleanOption(o => option(o, 'cesky', 'cmd.filmy.cesky'))
    .addStringOption(o => option(o, 'razeni', 'cmd.filmy.razeni').addChoices(
      ...Object.keys(SORTS).map(value => choice(value, language => tIn(language, `sort.${value}`))),
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

/** Turns a command that came in under its registered names into the names the code reads. */
export function useCodeNames(interaction) {
  const known = codeNames.get(interaction.commandName);
  if (!known) return;
  for (const given of interaction.options.data) given.name = known.options.get(given.name) ?? given.name;
  interaction.commandName = known.name;
}
