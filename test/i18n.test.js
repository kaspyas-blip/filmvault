import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import cs from '../src/locales/cs.js';
import en from '../src/locales/en.js';
import { testEnv } from './helpers.js';

testEnv();
const { t, tIn, allT } = await import('../src/i18n.js');

// Texts as they were before the catalogs existed (copied from the code of that time).
const WAS = {
  'cinema.busy': "Kino teď promítá na jiném serveru, zkus to později.",
  'bot.noStreamer': "⚠️ Streamovací účet na tomhle serveru není. Pozvi ho, a musí vidět hlasový kanál, jinak se film nepustí.",
  'help.pust.text': "`/pust` – pustí film nebo díl, název se našeptává. Místo názvu můžeš vložit odkaz na YouTube video, přenos nebo Kick kanál.\n· `od` – odkud: `1:20:00`, `45` = minut, `0` = od začátku\n· `zvuk`, `titulky` – která stopa\n\n`/filmy` – všechny filmy po 20 na stranu, film pustíš z nabídky pod seznamem.\n· `zanr` – jen tento žánr\n· `rok` – `2005` nebo `1990-1999`\n· `cesky` – jen s českým dabingem\n· `razeni` – název, naposledy přidané, nejnovější, hodnocení\n\n`/serialy` – vybereš seriál, sérii a díl.\n\nFilm běží jako živé vysílání účtu **filmvault**. Živé přenosy jdou pauzovat, ale ne posouvat.",
  'help.samo.text': "**Navazování** – `/pust` pokračuje, kde jste skončili; tlačítko *Pustit od začátku* to vrátí na začátek. Pod zprávou nedokoukaného filmu je tlačítko *Pokračovat*.\n**Další díl** – 25 s před závěrečnými titulky běží v rohu odpočet a po 5 s titulků hned naváže další díl (i do další série) se stejným jazykem. Potitulkové scény se nepřeskakují. Zrušit jde tlačítkem *Nepouštět další díl*.\n**Úvodní znělka** – tlačítko *Přeskočit úvod*; seriál si to pamatuje a u dalších dílů ji přeskočí sám.\n**Čeština** – bez výběru stopy se bere český dabing, a když není, české titulky.\n**Pády** – když vysílání nebo bot spadne, kino samo naváže, kde to bylo, a starou zprávu smaže.\n**Úklid** – když všichni odejdou z hovoru, kino po 2 min přestane vysílat; bez přehrávání odejde po 5 min.",
  'help.seznam.label': "🎲 Chceme vidět",
  'help.seznam.text|42': "Napiš název filmu do <#42> a bot ho přidá na seznam s info z IMDb.\n🎲 vybere náhodně film, který máte\n✏️ upraví film: že ho máte jinde (YouTube), že jste ho viděli, nebo ho odebere\n\nKdyž film přibude do Jellyfinu, bot to v roomce ohlásí."
};

/** What the bot makes of the given settings, from a process of its own (see i18n-child.mjs). */
function run(env) {
  const result = spawnSync(process.execPath, ['test/i18n-child.mjs'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const czech = run({ LANGUAGE: 'cs' });
const english = run({ LANGUAGE: 'en' });

test('both catalogs have the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(cs).sort());
});

test('the same placeholders and the same kind of value in both languages', () => {
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [key, value] of Object.entries(cs)) {
    assert.equal(typeof en[key], typeof value, key);
    if (typeof value === 'string') assert.deepEqual(placeholders(en[key]), placeholders(value), key);
  }
});

test('Czech texts are as they were', () => {
  assert.equal(WAS['cinema.busy'], 'Kino teď promítá na jiném serveru, zkus to později.');
  assert.equal(t('cinema.busy'), WAS['cinema.busy']);
  assert.equal(czech.busy, WAS['cinema.busy']);
  assert.equal(t('bot.noStreamer'), WAS['bot.noStreamer']);
  assert.equal(t('help.pust.text'), WAS['help.pust.text']);
  assert.equal(t('help.samo.text'), WAS['help.samo.text']);
  assert.equal(t('help.seznam.label'), WAS['help.seznam.label']);
  assert.equal(t('help.seznam.text', { channel: 42 }), WAS['help.seznam.text|42']);
  assert.equal(czech.help.topics.pust.description, WAS['help.pust.text']);
  assert.equal(czech.help.topics.samo.description, WAS['help.samo.text']);
  assert.equal(czech.help.topics.seznam.title, WAS['help.seznam.label']);
  assert.equal(czech.help.topics.seznam.description, WAS['help.seznam.text|42'].replace('<#42>', '<#222>'));
  assert.equal(czech.help.hiddenTopic, null);
  assert.match(czech.quality, /^Vysoká \(\d+p, \d+ kb\/s\)$/);
  assert.match(english.quality, /^High \(\d+p, \d+ kb\/s\)$/);
});

test('plurals follow the rules of each language', () => {
  assert.deepEqual(czech.plurals, ['0 filmů', '1 film', '2 filmy', '4 filmy', '5 filmů', '11 filmů', '21 filmů']);
  assert.deepEqual(english.plurals, ['0 films', '1 film', '2 films', '4 films', '5 films', '11 films', '21 films']);
  assert.equal(tIn('en', 'plural.dil', { n: 1 }), '1 episode');
  assert.equal(tIn('en', 'plural.dil', { n: 3 }), '3 episodes');
  assert.equal(tIn('cs', 'plural.dil', { n: 3 }), '3 díly');
  assert.equal(tIn('en', 'wishlist.arrivalHeader', { n: 1 }), '🍿 1 new film has arrived in the cinema!');
  assert.equal(tIn('en', 'wishlist.arrivalHeader', { n: 3 }), '🍿 3 new films have arrived in the cinema!');
  assert.equal(tIn('cs', 'wishlist.arrivalHeader', { n: 3 }), '🍿 V kině přibyly **3 nové filmy**!');
  assert.match(tIn('en', 'stats.wishesOpen', { n: 1 }), /^📝 1 film is waiting/);
  assert.match(tIn('en', 'stats.wishesOpen', { n: 2 }), /^📝 2 films are waiting/);
});

test('a key a language lacks falls back to Czech, a key nobody has stays visible', () => {
  assert.equal(tIn('de', 'cinema.busy'), cs['cinema.busy']);
  assert.equal(tIn('en', 'no.such.key'), 'no.such.key');
  assert.equal(tIn('en', 'cinema.seeked', { time: '1:00' }), '⏩ Moved to 1:00.');
  assert.equal(tIn('en', 'cinema.seeked'), '⏩ Moved to {time}.');
  // Inserted text is not read for placeholders again, nor for "$" patterns.
  assert.equal(tIn('en', 'cinema.seeked', { time: '{time} $&' }), '⏩ Moved to {time} $&.');
});

test('texts that find our own old messages exist in every language', () => {
  assert.deepEqual(allT('help.title'), [cs['help.title'], en['help.title']]);
  assert.deepEqual(allT('wishlist.title'), [cs['wishlist.title'], en['wishlist.title']]);
  assert.equal(t('wishlist.title'), '🎬 Chceme vidět');
});

test('the language of a process comes from LANGUAGE, Czech without it', () => {
  assert.equal(czech.language, 'cs');
  assert.equal(english.language, 'en');
  assert.equal(run({ LANGUAGE: '' }).language, 'cs');
  assert.equal(run({ LANGUAGE: 'en_US:en' }).language, 'en');
  // No catalog: Czech texts
  assert.equal(run({ LANGUAGE: 'de' }).busy, cs['cinema.busy']);
  assert.equal(english.busy, en['cinema.busy']);
});

function localized(entries) {
  return entries.flatMap(({ name, name_localizations, description, description_localizations, options = [], choices = [] }) => [
    { name, name_localizations, description, description_localizations, choices },
    ...localized(options),
  ]);
}

for (const [language, result] of [['cs', czech], ['en', english]]) {
  test(`commands are valid for Discord (${language})`, () => {
    const all = [...result.commands, result.setupCommand];
    assert.equal(new Set(all.map(c => c.name)).size, all.length);
    for (const command of all) {
      for (const level of [command, ...(command.options ?? [])]) {
        assert.match(level.name, /^[-_a-z0-9]{1,32}$/);
        const names = (level.options ?? []).map(o => o.name_localizations['en-US']);
        assert.equal(new Set(names).size, names.length, `${command.name} option names`);
      }
      for (const entry of localized([command])) {
        assert.ok(entry.description.length >= 1 && entry.description.length <= 100, `${entry.name}: ${entry.description}`);
        for (const locale of ['en-US', 'en-GB', 'cs']) {
          assert.match(entry.name_localizations?.[locale] ?? '', /^[-_a-z0-9]{1,32}$/, `${entry.name} ${locale}`);
          const text = entry.description_localizations?.[locale] ?? '';
          assert.ok(text.length >= 1 && text.length <= 100, `${entry.name} ${locale}: ${text}`);
        }
        for (const choice of entry.choices) {
          assert.ok(choice.name.length >= 1 && choice.name.length <= 100, choice.name);
          for (const locale of ['en-US', 'en-GB', 'cs']) {
            assert.ok(choice.name_localizations[locale].length <= 100, choice.name_localizations[locale]);
          }
        }
      }
    }
  });
}

test('commands are registered in the configured language, and clients see their own', () => {
  const names = result => result.commands.map(c => c.name);
  assert.deepEqual(names(english), czech.commands.map(c => c.name_localizations['en-US']));
  assert.deepEqual(english.commands.map(c => c.name_localizations.cs), names(czech));
  assert.equal(names(english)[0], 'play');
  assert.equal(english.setupCommand.name, 'setup');
  assert.deepEqual(english.commands[0].options.map(o => o.name), ['movie', 'from', 'audio', 'subtitles']);
  assert.equal(english.commands[0].description_localizations.cs, 'Pustí film nebo díl do kina');
  assert.deepEqual(names(czech), ['pust', 'pauza', 'pokracuj', 'posun', 'zvuk', 'titulky', 'kvalita', 'hlasitost', 'statistiky', 'stav', 'filmy', 'serialy', 'videli', 'zapsat', 'hraje', 'stop', 'odejdi']);
  assert.equal(czech.setupCommand.name, 'nastavit');
  assert.deepEqual(czech.commands.map(c => c.name_localizations['en-GB']), ['play', 'pause', 'resume', 'seek', 'audio', 'subtitles', 'quality', 'sound', 'stats', 'status', 'movies', 'series', 'watched', 'log', 'nowplaying', 'stop', 'leave']);
  assert.equal(czech.setupCommand.name_localizations['en-US'], 'setup');
  // The registered names are the ones of the Czech catalog
  for (const command of czech.commands) assert.equal(cs[`cmd.${command.name}.name`], command.name);
  const play = czech.commands[0];
  assert.deepEqual(play.options.map(o => o.name), ['film', 'od', 'zvuk', 'titulky']);
  assert.deepEqual(play.options.map(o => o.name_localizations['en-US']), ['movie', 'from', 'audio', 'subtitles']);
  assert.equal(play.description, 'Pustí film nebo díl do kina');
  assert.equal(english.commands[0].description, 'Plays a movie or episode in the cinema');
  assert.equal(czech.commands[0].description_localizations['en-US'], 'Plays a movie or episode in the cinema');
  const quality = czech.commands.find(c => c.name === 'kvalita').options[0];
  assert.deepEqual(quality.choices.map(c => c.value), ['vysoka', 'stredni', 'nizka']);
  assert.deepEqual(quality.choices.map(c => c.name.replace(/ \(.*/, '')), ['Vysoká', 'Střední', 'Nízká']);
  assert.deepEqual(quality.choices.map(c => c.name_localizations['en-GB'].replace(/ \(.*/, '')), ['High', 'Medium', 'Low']);
});

test('a command arrives under its registered name and the code reads its own', () => {
  assert.deepEqual(english.incoming, { commandName: 'pust', od: '45', focused: 'film', movie: null });
  assert.deepEqual(english.incomingSetup, { commandName: 'nastavit', role: 'kino' });
  assert.deepEqual(english.incomingSound, { commandName: 'hlasitost', rezim: 'night' });
  assert.deepEqual(czech.incoming, { commandName: 'pust', od: '45', focused: 'film', movie: null });
});

for (const [language, result] of [['cs', czech], ['en', english]]) {
  test(`the help fits in Discord's limits (${language})`, () => {
    const embeds = [...result.help.withWishlist.embeds, ...result.help.withoutWishlist.embeds, ...Object.values(result.help.topics)];
    assert.equal(Object.keys(result.help.topics).length, 6);
    for (const embed of embeds) {
      assert.ok(embed.title.length <= 256, embed.title);
      assert.ok(embed.description.length <= 4096, embed.title);
      assert.ok((embed.footer?.text.length ?? 0) <= 2048);
      for (const field of embed.fields ?? []) {
        assert.ok(field.name.length <= 256 && field.value.length <= 1024, field.name);
      }
      const total = embed.title.length + embed.description.length + (embed.footer?.text.length ?? 0)
        + (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
      assert.ok(total <= 6000, embed.title);
    }
    for (const message of [result.help.withWishlist, result.help.withoutWishlist]) {
      assert.ok(message.components.length <= 5);
      for (const row of message.components) {
        assert.ok(row.components.length <= 5);
        for (const button of row.components) assert.ok(button.label.length >= 1 && button.label.length <= 80, button.label);
      }
    }
    // The wishlist topic only shows with a wishlist room
    assert.equal(result.help.withWishlist.components.flatMap(r => r.components).length, 6);
    assert.equal(result.help.withoutWishlist.components.flatMap(r => r.components).length, 5);
    assert.equal(result.help.hiddenTopic, null);
    assert.ok(result.help.withWishlist.embeds[0].description.includes('<#222>'));
    assert.ok(result.help.withWishlist.embeds[0].description.includes('**Kino**'));
  });
}

test('the help is in the language of the process, under a title both languages recognise', () => {
  assert.equal(czech.help.withWishlist.embeds[0].title, cs['help.title']);
  assert.equal(english.help.withWishlist.embeds[0].title, en['help.title']);
  assert.match(english.help.withWishlist.embeds[0].footer.text, / · [0-9a-f]{8}$/);
  assert.notEqual(english.help.withWishlist.embeds[0].footer.text.slice(-8), czech.help.withWishlist.embeds[0].footer.text.slice(-8));
  assert.ok(english.help.topics.pust.description.startsWith('`/play`'));
});

test('English dates and yesterday', () => {
  assert.equal(english.date, '28/10, 20:30');
  assert.equal(czech.yesterday, true);
  assert.equal(english.yesterday, true);
});

test('the preferred language comes from PREFERRED_LANGUAGE, Czech without it', () => {
  // Czech stream, Czech title, Polish stream, Polish title, unknown code stream and title, nothing
  assert.deepEqual(czech.preferred, [true, true, false, false, false, false, false]);
  assert.deepEqual(run({ PREFERRED_LANGUAGE: 'pl' }).preferred, [false, false, true, true, false, false, false]);
  assert.deepEqual(run({ PREFERRED_LANGUAGE: 'PL' }).preferred, [false, false, true, true, false, false, false]);
  // Not in the table: streams carrying exactly that code
  assert.deepEqual(run({ PREFERRED_LANGUAGE: 'xx' }).preferred, [false, false, false, false, true, false, false]);
});

test('months start in the configured time zone', () => {
  assert.equal(new Date(czech.firstOfJune).toISOString(), '2026-05-31T22:00:00.000Z');
  assert.equal(new Date(run({ TIMEZONE: 'America/New_York' }).firstOfJune).toISOString(), '2026-06-01T04:00:00.000Z');
  assert.equal(new Date(run({ TIMEZONE: 'Asia/Kolkata' }).firstOfJune).toISOString(), '2026-05-31T18:30:00.000Z');
  assert.equal(new Date(run({ TIMEZONE: 'UTC' }).firstOfJune).toISOString(), '2026-06-01T00:00:00.000Z');
});
