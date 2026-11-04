// npm run doctor: checks everything the cinema needs and says what to fix. Changes nothing.
// Exit code 1 when something required is missing, so it also fits scripts and containers.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

let failed = 0;
const ok = text => console.log(`  ok    ${text}`);
const warn = text => console.log(`  warn  ${text}`);
const fail = text => {
  failed++;
  console.log(`  FAIL  ${text}`);
};
const section = text => console.log(`\n${text}`);

section('Settings (.env)');
if (!existsSync('.env') && !process.env.BOT_TOKEN) {
  fail('No .env file. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`Node.js ${process.versions.node} is too old, 22.4 or newer is needed.`);
else ok(`Node.js ${process.versions.node}`);

let config;
try {
  ({ config } = await import('../src/config.js'));
  ok('required settings are filled in');
} catch (error) {
  fail(`${error.message}. See .env.example.`);
  process.exit(1);
}

section('Programs');
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 26 });
const ffmpeg = run(config.ffmpegPath, ['-hide_banner', '-version']);
if (ffmpeg.error || ffmpeg.status !== 0) {
  fail(`ffmpeg was not found at "${config.ffmpegPath}". Install it, or set FFMPEG_PATH.`);
} else {
  ok(ffmpeg.stdout.split('\n')[0].trim().slice(0, 70));
  const encoders = run(config.ffmpegPath, ['-hide_banner', '-encoders']).stdout ?? '';
  const filters = run(config.ffmpegPath, ['-hide_banner', '-filters']).stdout ?? '';
  const muxers = run(config.ffmpegPath, ['-hide_banner', '-muxers']).stdout ?? '';
  if (!encoders.includes(config.encoder)) fail(`This ffmpeg has no encoder ${config.encoder}. Set VIDEO_ENCODER to one it has (libx264 works everywhere).`);
  else ok(`encoder ${config.encoder} is known to ffmpeg`);
  if (!encoders.includes('libopus')) fail('This ffmpeg has no libopus encoder, which sound needs. Use a full build.');
  for (const [name, list, why] of [['drawtext', filters, 'the next-episode countdown'], ['subtitles', filters, 'burning in subtitles'], ['zscale', filters, 'HDR films'], ['chromaprint', muxers, 'detecting intros and credits']]) {
    if (list.includes(name)) ok(`${name}: available`);
    else warn(`${name} is missing from this ffmpeg: no ${why}. A full build has it.`);
  }
  if (config.encoder !== 'libx264') {
    const test = run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=1', '-pix_fmt', config.encoder === 'h264_qsv' ? 'nv12' : 'yuv420p', '-c:v', config.encoder, '-f', 'null', '-']);
    if (test.status === 0) ok(`${config.encoder} really encodes on this machine`);
    else warn(`${config.encoder} is known but failed to encode here (${(test.stderr ?? '').trim().split('\n').pop()?.slice(0, 70)}). The cinema falls back to the much slower libx264; check the graphics driver, or set VIDEO_ENCODER=libx264.`);
  }
}
const ytDlp = run(config.ytDlpPath, ['--version']);
if (ytDlp.error || ytDlp.status !== 0) warn(`yt-dlp was not found at "${config.ytDlpPath}": YouTube and Kick links will not work. The rest does.`);
else ok(`yt-dlp ${ytDlp.stdout.trim()}`);

section('Files');
try {
  mkdirSync('data', { recursive: true });
  writeFileSync('data/.doctor', 'x');
  rmSync('data/.doctor');
  ok('data/ can be written');
} catch (error) {
  fail(`data/ cannot be written: ${error.message}`);
}

section('Jellyfin');
const { listLibrary } = await import('../src/jellyfin.js');
try {
  const res = await fetch(`${config.jellyfinUrl}/System/Info/Public`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  ok(`${config.jellyfinUrl} answers, version ${(await res.json()).Version}`);
  const { total } = await listLibrary('Movie', 0, 1);
  const series = await listLibrary('Series', 0, 1);
  if (total + series.total) ok(`the API key works: ${total} films, ${series.total} series`);
  else warn('The API key works, but the library looks empty.');
} catch (error) {
  fail(`Jellyfin: ${error.message}. Check JELLYFIN_URL and JELLYFIN_API_KEY.`);
}

section('Discord');
const api = (path, authorization) => fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(10_000) });
try {
  const res = await api('/users/@me', `Bot ${config.botToken}`);
  if (!res.ok) throw new Error(`the token was refused (HTTP ${res.status})`);
  const bot = await res.json();
  ok(`control bot: ${bot.username}`);
  const servers = await (await api('/users/@me/guilds', `Bot ${config.botToken}`)).json();
  if (servers.length) ok(`it is on: ${servers.map(s => s.name).join(', ')}`);
  else warn(`It is on no server yet. Invite it: https://discord.com/oauth2/authorize?client_id=${bot.id}&scope=bot+applications.commands&permissions=117824`);
  const app = await (await api('/applications/@me', `Bot ${config.botToken}`)).json();
  // Bit 19: message content intent, needed for the wishlist room (18: verified bots).
  if (!(app.flags & (1 << 19)) && !(app.flags & (1 << 18))) warn('Message Content Intent looks off in the Developer Portal; without it the start fails.');
  else ok('Message Content Intent is on');
} catch (error) {
  fail(`Control bot: ${error.message}. Check BOT_TOKEN.`);
}
try {
  const res = await api('/users/@me', config.streamerToken);
  if (!res.ok) throw new Error(`the token was refused (HTTP ${res.status})`);
  ok(`streaming account: ${(await res.json()).username}`);
} catch (error) {
  fail(`Streaming account: ${error.message}. Check STREAMER_TOKEN.`);
}

section('Optional');
if (config.tmdbApiKey) ok('TMDB key set: the "Chceme vidět" wishlist room works');
else warn('No TMDB_API_KEY: the wishlist room stays off.');
if (!config.omdbApiKey) warn('No OMDB_API_KEY: ratings come from TMDB instead of IMDb.');

console.log(failed ? `\n${failed} thing(s) to fix before the cinema can run.` : '\nAll set: npm start');
process.exit(failed ? 1 : 0);
