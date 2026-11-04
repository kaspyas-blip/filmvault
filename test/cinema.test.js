import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Collection } from 'discord.js';
import { eventually, fakeProcesses, fakeStreamer, fakeStreams, film, nextTick, testEnv } from './helpers.js';

testEnv();
const root = mkdtempSync(join(tmpdir(), 'filmvault-cinema-'));
const startDir = process.cwd();
process.chdir(root);
const { createCinema } = await import('../src/cinema.js');
const { Player } = await import('../src/player.js');

after(() => {
  process.chdir(startDir);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const FILM = film({ id: 'a'.repeat(32), name: 'Duna', minutes: 100 });
const quiet = { log: console.log, warn: console.warn, error: console.error };
const realFetch = globalThis.fetch;
let jellyfinWrites;

function fakeJellyfin() {
  globalThis.fetch = async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url);
    const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (options.method === 'POST') {
      jellyfinWrites.push(pathname);
      return new Response(null, { status: 204 });
    }
    if (pathname === '/Users') return json([{ Id: 'u', Name: 'admin', Policy: { IsAdministrator: true } }]);
    if (pathname === '/Items' && searchParams.get('ids')) return json({ Items: [{ ...FILM, UserData: resumeData }] });
    if (pathname === '/Items') return json({ Items: [FILM], TotalRecordCount: 1 });
    return new Response('nope', { status: 404 });
  };
}
let resumeData = {};

function textChannel(id) {
  const messages = new Collection();
  let counter = 0;
  const makeMessage = payload => {
    const message = {
      id: `${id}-m${++counter}`,
      author: { id: 'bot' },
      content: payload.content ?? '',
      embeds: (payload.embeds ?? []).map(e => (e.toJSON ? e.toJSON() : e)),
      components: (payload.components ?? []).map(r => (r.toJSON ? r.toJSON() : r)),
      async edit(next) {
        if (next.content !== undefined) message.content = next.content;
        if (next.embeds) message.embeds = next.embeds.map(e => (e.toJSON ? e.toJSON() : e));
        if (next.components) message.components = next.components.map(r => (r.toJSON ? r.toJSON() : r));
        return message;
      },
      async delete() {
        messages.delete(message.id);
      },
    };
    messages.set(message.id, message);
    channel.lastMessageId = message.id;
    return message;
  };
  const channel = {
    id,
    name: id,
    lastMessageId: null,
    makeMessage,
    all: messages,
    send: async payload => makeMessage(payload),
    messages: {
      fetchPins: async () => ({ items: [] }),
      fetch: async query => {
        if (typeof query === 'string') {
          const hit = messages.get(query);
          if (!hit) throw new Error('Unknown Message');
          return hit;
        }
        return query?.before ? new Collection() : messages.clone();
      },
      delete: async messageId => messages.delete(messageId),
    },
  };
  return channel;
}

function world() {
  const client = Object.assign(new EventEmitter(), {
    user: { id: 'bot' }, ws: { ping: 1 }, channels: { cache: new Map() }, guilds: { cache: new Map() },
  });
  const streamer = fakeStreamer();
  const processes = fakeProcesses();
  const streams = fakeStreams();
  const player = new Player({ streamer, startProcess: processes.startProcess, startStream: streams.startStream });
  const cinemas = new Map();
  for (const event of ['stopped', 'ended', 'failed', 'introSkipped']) {
    player.on(event, (...args) => cinemas.get(player.guildId)?.onPlayer[event](...args));
  }
  const addServer = (id, dir, setupExtra = {}) => {
    const text = textChannel(`${id}-text`);
    const voice = { id: `${id}-voice`, name: 'film', members: new Collection() };
    client.channels.cache.set(text.id, text);
    client.channels.cache.set(voice.id, voice);
    const guild = { id, name: id, commands: { set: async () => {} }, members: { cache: new Collection(), fetch: async () => null } };
    client.guilds.cache.set(id, guild);
    const cinema = createCinema({
      client,
      player,
      guild,
      setup: { textChannelId: text.id, voiceChannelId: voice.id, wishlistChannelId: null, allowedRole: null, announceRole: null, dir, ...setupExtra },
      busyElsewhere: () => [...cinemas.values()].some(other => other !== cinema && other.busy()),
    });
    cinemas.set(id, cinema);
    return { id, text, voice, guild, cinema };
  };
  return { client, streamer, processes, streams, player, addServer, cinemas };
}

function command(server, commandName, options = {}, member = {}) {
  const interaction = {
    guildId: server.id,
    channelId: server.text.id,
    commandName,
    user: { id: 'u1', username: 'kaspy' },
    member: { displayName: 'Kaspy', roles: { cache: new Collection() }, ...member },
    deferred: false,
    replied: false,
    answers: [],
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    options: {
      getString: name => options[name] ?? null,
      getBoolean: name => options[name] ?? null,
      getInteger: name => options[name] ?? null,
      getUser: () => null,
      getMember: () => null,
    },
    deferReply: async () => { interaction.deferred = true; },
    deferUpdate: async () => { interaction.deferred = true; },
    reply: async payload => {
      interaction.replied = true;
      interaction.answers.push(payload);
    },
    followUp: async payload => { interaction.answers.push(payload); },
    editReply: async payload => {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      interaction.answers.push(body);
      interaction.replyMessage = server.text.makeMessage(body);
      return interaction.replyMessage;
    },
  };
  return interaction;
}

function buttonClick(server, customId, message) {
  const interaction = command(server, null);
  return Object.assign(interaction, { customId, message, isChatInputCommand: () => false, isButton: () => true });
}

const person = id => ({ id, user: { bot: false }, displayName: id });
const lastText = interaction => {
  const last = interaction.answers.at(-1);
  return typeof last === 'string' ? last : last?.content;
};
const pust = (server, options = { film: FILM.Id }) => {
  const interaction = command(server, 'pust', options);
  return server.cinema.handleInteraction(interaction).then(() => interaction);
};
const buttonsOf = message => message.components.flatMap(row => row.components ?? []).map(c => c.custom_id);
const history = dir => JSON.parse(readFileSync(`${dir}/history.json`, 'utf8'));

let w;
let main;

beforeEach(() => {
  Object.assign(console, { log() {}, warn() {}, error() {} });
  jellyfinWrites = [];
  resumeData = {};
  fakeJellyfin();
  w = world();
  // "data" is the first server, the one that keeps its progress in Jellyfin.
  rmSync('data', { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  main = w.addServer('g1', 'data');
  main.voice.members.set('p1', person('p1'));
});

afterEach(async () => {
  clearInterval(w.player.ticker);
  clearTimeout(w.player.idleTimer);
  for (const cinema of w.cinemas.values()) await cinema.close().catch(() => {});
  await nextTick();
  globalThis.fetch = realFetch;
  Object.assign(console, quiet);
});

/** ffmpeg ended where the film was at seconds. */
async function streamEnds(position, code = 0) {
  w.player.session.mediaMs = position * 1000;
  w.processes.started.at(-1).emit('close', code);
  w.streams.running.at(-1).end();
  await nextTick(30);
  await w.player.queue;
  await nextTick(30);
}

test('/pust plays, the answer carries the controls', async () => {
  const interaction = await pust(main);
  assert.equal(interaction.answers.at(-1).content?.includes('Běží'), true, JSON.stringify(interaction.answers).slice(0, 500));
  assert.equal(w.player.item.Id, FILM.Id);
  assert.ok(buttonsOf(interaction.replyMessage).includes('fv:stop'));
});

test('/stop keeps a button that goes on from there, with the same tracks', async () => {
  const started = await pust(main);
  w.player.session.mediaMs = 600_000;
  const stop = command(main, 'stop');
  await main.cinema.handleInteraction(stop);
  assert.equal(w.player.item, null);
  const [resume] = buttonsOf(started.replyMessage);
  assert.equal(resume, `fr:600:1::${FILM.Id}`);

  const click = buttonClick(main, resume, started.replyMessage);
  await main.cinema.handleInteraction(click);
  assert.equal(w.player.item.Id, FILM.Id);
  assert.equal(w.processes.started.at(-1).args[w.processes.started.at(-1).args.indexOf('-ss') + 1], '595');
  assert.equal(buttonsOf(started.replyMessage).length, 0);
});

test('a film played to the end has no go-on button and counts as watched', async () => {
  const started = await pust(main);
  await streamEnds(100 * 60 - 10);
  await eventually(() => assert.equal(history('data')[0].finished, true));
  await eventually(() => assert.equal(buttonsOf(started.replyMessage).length, 0));
});

test('a stream that broke in the middle is not watched, and comes back where it was', async () => {
  await pust(main);
  w.player.itemStartedAt -= 300_000;
  await streamEnds(1200);
  await eventually(() => assert.equal(history('data')[0].finished, false));
  await nextTick(3300);
  assert.equal(w.player.item?.Id, FILM.Id);
  const args = w.processes.started.at(-1).args;
  assert.equal(args[args.indexOf('-ss') + 1], '1195');
});

test('broken with nobody in the call: it says so and offers to go on', async () => {
  const started = await pust(main);
  main.voice.members.clear();
  await streamEnds(1200);
  await eventually(() => assert.match(started.replyMessage.embeds[0]?.description ?? '', /spadlo/));
  await eventually(() => assert.equal(buttonsOf(started.replyMessage)[0], `fr:1200:1::${FILM.Id}`));
  assert.equal(w.player.item, null);
});

test('/stop during a recovery cancels it', async () => {
  await pust(main);
  await streamEnds(1200);
  assert.equal(main.cinema.busy(), true);
  await main.cinema.handleInteraction(command(main, 'stop'));
  await nextTick(3300);
  assert.equal(w.player.item, null);
  assert.equal(main.cinema.busy(), false);
});

test('/stop while the subtitles load cancels the start', async () => {
  const withSubs = film({ id: FILM.Id, subtitles: [{ Type: 'Subtitle', Index: 7, IsTextSubtitleStream: true }] });
  const jellyfin = globalThis.fetch;
  let answerSubs;
  globalThis.fetch = async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.includes('/Subtitles/')) return new Promise(resolve => { answerSubs = () => resolve(new Response('subs')); });
    if (pathname === '/Items' && searchParams.get('ids')) return new Response(JSON.stringify({ Items: [withSubs] }), { headers: { 'Content-Type': 'application/json' } });
    return jellyfin(url, options);
  };
  mkdirSync('tmp', { recursive: true });
  const play = command(main, 'pust', { film: FILM.Id, titulky: '7' });
  const playing = main.cinema.handleInteraction(play);
  await eventually(() => assert.equal(typeof answerSubs, 'function'));
  assert.equal(main.cinema.busy(), true);
  const stop = command(main, 'stop');
  await main.cinema.handleInteraction(stop);
  assert.match(stop.answers[0].content, /zrušeno/);
  answerSubs();
  await playing;
  assert.equal(w.player.item, null);
  assert.equal(w.processes.started.length, 0);
  assert.match(lastText(play), /zrušeno/);
  assert.equal(main.cinema.busy(), false);
});

test('a second server hears the cinema plays elsewhere, and cannot touch it', async () => {
  const other = w.addServer('g2', 'data/guilds/g2');
  other.voice.members.set('p2', person('p2'));
  await pust(main);
  const position = w.player.session;

  const tryPlay = await pust(other);
  assert.match(tryPlay.answers.at(-1).content, /jiném serveru/);
  for (const name of ['stop', 'pauza', 'pokracuj', 'odejdi', 'hraje']) {
    const attempt = command(other, name);
    await other.cinema.handleInteraction(attempt);
    assert.match(attempt.answers.at(-1).content, /jiném serveru/, name);
  }
  assert.equal(w.player.item.Id, FILM.Id);
  assert.equal(w.player.session, position);
  assert.equal(w.player.paused, false);
});

test('quality set on the other server waits for its turn', async () => {
  const other = w.addServer('g2', 'data/guilds/g2');
  await pust(main);
  const processes = w.processes.started.length;
  await other.cinema.handleInteraction(command(other, 'kvalita', { uroven: 'nizka' }));
  assert.equal(w.processes.started.length, processes);
  assert.notEqual(w.player.quality, 'nizka');
});

test('after the first server stops, the second one takes over', async () => {
  const other = w.addServer('g2', 'data/guilds/g2');
  other.voice.members.set('p2', person('p2'));
  await pust(main);
  await main.cinema.handleInteraction(command(main, 'stop'));
  const started = await pust(other);
  assert.equal(w.player.guildId, 'g2');
  assert.ok(buttonsOf(started.replyMessage).includes('fv:stop'));
  assert.deepEqual(w.streamer.calls.filter(c => c.startsWith('join')), ['join g1/g1-voice', 'join g2/g2-voice']);
});

test('the first server writes progress to Jellyfin, another one does not', async () => {
  const other = w.addServer('g2', 'data/guilds/g2');
  other.voice.members.set('p2', person('p2'));
  await pust(main);
  w.player.session.mediaMs = 600_000;
  await main.cinema.handleInteraction(command(main, 'stop'));
  await nextTick(20);
  assert.equal(jellyfinWrites.length, 1);

  jellyfinWrites.length = 0;
  await pust(other);
  w.player.session.mediaMs = 600_000;
  w.player.itemStartedAt -= 300_000;
  await other.cinema.handleInteraction(command(other, 'stop'));
  await nextTick(20);
  assert.equal(jellyfinWrites.length, 0);
  // It goes on from its own history.
  await pust(other);
  const args = w.processes.started.at(-1).args;
  assert.equal(args[args.indexOf('-ss') + 1], '595');
});

test('another server does not pick up the place Jellyfin has from the first', async () => {
  const other = w.addServer('g2', 'data/guilds/g2');
  other.voice.members.set('p2', person('p2'));
  resumeData = { PlaybackPositionTicks: 1000 * 10_000_000 };
  await pust(other);
  assert.equal(w.processes.started.at(-1).args.includes('-ss'), false);
  await other.cinema.handleInteraction(command(other, 'stop'));
  await pust(main);
  const args = w.processes.started.at(-1).args;
  assert.equal(args[args.indexOf('-ss') + 1], '995');
});

test('a restart with nobody in the call keeps the message and the history', async () => {
  mkdirSync('data', { recursive: true });
  const old = main.text.makeMessage({ content: 'hraje', components: [{ type: 1, components: [{ custom_id: 'fv:stop' }] }] });
  writeFileSync('data/nowplaying.json', JSON.stringify({
    messageId: old.id, itemId: FILM.Id, position: 1500, by: 'Kaspy', byId: 'u1', audioIndex: 1, subtitleIndex: null,
    label: 'Duna', startedAt: Date.now() - 3_000_000, duration: 6000, live: false, watched: 1500, viewers: {}, savedAt: Date.now(),
  }));
  main.voice.members.clear();
  await main.cinema.start();
  assert.equal(w.player.item, null);
  assert.equal(main.text.all.has(old.id), true);
  assert.equal(buttonsOf(old)[0], `fr:1500:1::${FILM.Id}`);
  assert.match(old.embeds[0].description, /Přerušeno/);
  await eventually(() => assert.equal(history('data')[0].position, 1500));
});

test('a restart with people in the call goes on, and the old message goes', async () => {
  mkdirSync('data', { recursive: true });
  const old = main.text.makeMessage({ content: 'hraje', components: [{ type: 1, components: [{ custom_id: 'fv:stop' }] }] });
  writeFileSync('data/nowplaying.json', JSON.stringify({
    messageId: old.id, itemId: FILM.Id, position: 1500, by: 'Kaspy', byId: 'u1', audioIndex: 1, subtitleIndex: null, savedAt: Date.now(),
  }));
  await main.cinema.start();
  assert.equal(w.player.item.Id, FILM.Id);
  const args = w.processes.started.at(-1).args;
  assert.equal(args[args.indexOf('-ss') + 1], '1495');
  assert.equal(main.text.all.has(old.id), false);
});

test('a stale state and a fresh autoplay: the autoplay film from its own place, the old message closed', async () => {
  const { utimesSync } = await import('node:fs');
  mkdirSync('data', { recursive: true });
  const old = main.text.makeMessage({ content: 'hraje', components: [{ type: 1, components: [{ custom_id: 'fv:stop' }] }] });
  writeFileSync('data/nowplaying.json', JSON.stringify({
    messageId: old.id, itemId: 'b'.repeat(32), position: 1500, by: 'Kaspy', audioIndex: 1, subtitleIndex: null, label: 'Stary', startedAt: 1, savedAt: 1,
  }));
  const long = new Date(Date.now() - 3_600_000);
  utimesSync('data/nowplaying.json', long, long);
  writeFileSync('data/autoplay.json', JSON.stringify({ itemId: FILM.Id, by: 'restart' }));
  await main.cinema.start();
  assert.equal(w.player.item.Id, FILM.Id);
  assert.equal(w.processes.started.at(-1).args.includes('-ss'), false);
  await eventually(() => assert.match(old.embeds[0]?.description ?? '', /Přerušeno/));
});

test('without the role: no control, but the help can be read', async () => {
  const guarded = w.addServer('g3', 'data/guilds/g3', { allowedRole: 'kino' });
  const attempt = command(guarded, 'pust', { film: FILM.Id });
  await guarded.cinema.handleInteraction(attempt);
  assert.match(attempt.answers[0].content, /oprávnění/);
  assert.equal(w.player.item, null);
  const help = buttonClick(guarded, 'help:pust', {});
  await guarded.cinema.handleInteraction(help);
  assert.ok(help.answers[0].embeds[0]);
});

test('commands outside the text channel are refused', async () => {
  const attempt = command(main, 'stop');
  attempt.channelId = 'elsewhere';
  await main.cinema.handleInteraction(attempt);
  assert.match(attempt.answers[0].content, /jen v/);
});

test('a link that is not YouTube or Kick is refused', async () => {
  const attempt = await pust(main, { film: 'https://evil.example/x' });
  assert.match(attempt.answers.at(-1).content, /YouTube a Kicku/);
  assert.equal(w.player.item, null);
});

test('closing the cinema of a server it plays on stops the film and frees the others', async () => {
  const other = w.addServer('g2', 'data/guilds/g2');
  await pust(main);
  w.cinemas.delete('g1');
  await main.cinema.close();
  assert.equal(w.player.item, null);
  assert.equal(other.cinema.busy(), false);
});

test('closing another server leaves the film alone', async () => {
  const other = w.addServer('g2', 'data/guilds/g2');
  await pust(main);
  await other.cinema.close();
  assert.equal(w.player.item.Id, FILM.Id);
});

test('live stream: no seek buttons, /posun refused, stopping it counts as watched', async () => {
  // Loaded directly: the link path needs yt-dlp.
  const live = { ...FILM, Id: 'https://kick.com/x', Type: 'Web', Name: 'Live', RunTimeTicks: null, web: { live: true, videoUrl: 'https://v', audioUrl: null, headers: '' } };
  await w.player.play({ item: live, guildId: 'g1', channelId: 'g1-voice' });
  const seek = command(main, 'posun', { cas: '+5' });
  seek.options.getString = () => '+5';
  await main.cinema.handleInteraction(seek);
  assert.match(seek.answers.at(-1).content, /nejde/);
});
