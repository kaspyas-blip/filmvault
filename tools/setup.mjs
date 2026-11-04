// npm run setup: asks for what the cinema needs, writes .env, then runs the doctor.
// An existing .env is kept and only what it lacks is asked for; nothing is overwritten.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const QUESTIONS = [
  ['LANGUAGE', 'Language of the bot, en or cs', 'en'],
  ['PREFERRED_LANGUAGE', 'Audio and subtitle language to prefer (ISO code: en, cs, de...)', 'en'],
  ['TIMEZONE', 'Time zone (IANA name)', Intl.DateTimeFormat().resolvedOptions().timeZone],
  ['BOT_TOKEN', 'Control bot token (Developer Portal > your application > Bot)', ''],
  ['STREAMER_TOKEN', 'Token of the streaming account. USE A THROWAWAY ACCOUNT: selfbots break Discord\'s Terms of Service and it can get banned', ''],
  ['JELLYFIN_URL', 'Jellyfin address', 'http://localhost:8096'],
  ['JELLYFIN_API_KEY', 'Jellyfin API key (Dashboard > API Keys)', ''],
  ['TEXT_CHANNEL', 'Text channel for the commands (name or ID)', 'filmsearch'],
  ['VOICE_CHANNEL', 'Voice channel to stream to (name or ID)', 'film'],
  ['TMDB_API_KEY', 'TMDB key for the wishlist room (optional)', ''],
];
const REQUIRED = new Set(['BOT_TOKEN', 'STREAMER_TOKEN', 'JELLYFIN_URL', 'JELLYFIN_API_KEY']);

/** The values of an env file, as written. */
export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

/** The example file with the answers filled in, its comments and order kept. */
export function fillEnv(example, answers) {
  const left = new Set(Object.keys(answers));
  const lines = example.split(/\r?\n/).map(line => {
    const match = /^\s*([A-Z_]+)=/.exec(line);
    if (!match || !left.has(match[1])) return line;
    left.delete(match[1]);
    return `${match[1]}=${answers[match[1]]}`;
  });
  return [...lines, ...[...left].map(name => `${name}=${answers[name]}`)].join('\n');
}

function encoderGuess() {
  const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '';
  // Tried for real, not only listed: a listed encoder may have no hardware behind it.
  for (const encoder of ['h264_nvenc', 'h264_qsv']) {
    if (!encoders.includes(encoder)) continue;
    const pixel = encoder === 'h264_qsv' ? 'nv12' : 'yuv420p';
    const test = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=1', '-pix_fmt', pixel, '-c:v', encoder, '-f', 'null', '-'], { timeout: 30_000 });
    if (test.status === 0) return encoder;
  }
  return 'libx264';
}

async function main() {
  const existing = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answers = { ...existing };
  console.log(`FilmVault setup. Press Enter to take the value in brackets.${existsSync('.env') ? ' Existing values in .env are kept.' : ''}\n`);
  for (const [name, question, fallback] of QUESTIONS) {
    if (existing[name]) continue;
    let answer = '';
    do {
      answer = (await prompt.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
      if (!answer && REQUIRED.has(name)) console.log('  This one is needed.');
    } while (!answer && REQUIRED.has(name));
    answers[name] = answer;
  }
  prompt.close();
  if (!existing.VIDEO_ENCODER) {
    answers.VIDEO_ENCODER = encoderGuess();
    if (!existing.HW_DECODE) answers.HW_DECODE = answers.VIDEO_ENCODER === 'libx264' ? '0' : process.platform === 'win32' ? 'd3d11va' : answers.VIDEO_ENCODER === 'h264_nvenc' ? 'cuda' : 'vaapi';
    console.log(`\nEncoder for this machine: ${answers.VIDEO_ENCODER}`);
  }
  const example = readFileSync('.env.example', 'utf8');
  // Over an existing file: its other lines stay as they are.
  writeFileSync('.env', fillEnv(existsSync('.env') ? readFileSync('.env', 'utf8') : example, answers), { mode: 0o600 });
  console.log('Saved to .env (keep it private).\n');
  const doctor = spawnSync(process.execPath, ['tools/doctor.mjs'], { stdio: 'inherit' });
  process.exit(doctor.status ?? 1);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/setup.mjs')) await main();
