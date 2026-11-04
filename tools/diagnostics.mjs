// npm run diagnostics: writes diagnostics.txt to attach to a bug report, without secrets.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const LOG_LINES = 300;
const SECRET_NAMES = /TOKEN|KEY|PASSWORD|SECRET/i;

/** Removes the values of secret settings, Discord tokens, signed addresses and private addresses. */
export function redact(text, env = {}) {
  let clean = text;
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAMES.test(name) && value && value.length >= 6) clean = clean.split(value).join(`<${name}>`);
  }
  return clean
    .replace(/[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/g, '<token>')
    .replace(/Token="[^"]*"/g, 'Token="<hidden>"')
    .replace(/(api_key|apikey|token)=[^&\s"']+/gi, '$1=<hidden>')
    .replace(/https:\/\/[^\s"']*(googlevideo|live-video|playlist)[^\s"']*/g, '<stream address>')
    .replace(/\b(10|192\.168|100\.\d+|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+(\.\d+)?\b/g, '<private address>')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/g, '<home>');
}

function main() {
  const env = existsSync('.env') ? Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).map(line => /^([A-Z_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(m => [m[1], m[2].trim()])) : {};
  const settings = Object.entries(env).map(([name, value]) => `${name}=${SECRET_NAMES.test(name) ? (value ? '<set>' : '<empty>') : value}`);
  const doctor = spawnSync(process.execPath, ['tools/doctor.mjs'], { encoding: 'utf8', timeout: 120_000 });
  const log = existsSync('runtime.log') ? readFileSync('runtime.log', 'utf8').split(/\r?\n/).filter(line => !line.includes('Video pace')).slice(-LOG_LINES) : ['(no runtime.log)'];
  const report = [
    `FilmVault diagnostics, ${new Date().toISOString()}`,
    `Node ${process.version}, ${os.platform()} ${os.release()}, ${os.cpus()[0]?.model}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB`,
    '', '== Settings', ...settings,
    '', '== Doctor', doctor.stdout ?? '', doctor.stderr ?? '',
    '', `== Last ${LOG_LINES} log lines`, ...log,
  ].join('\n');
  writeFileSync('diagnostics.txt', redact(report, env));
  console.log('Wrote diagnostics.txt. Secrets are removed, but read it before you share it.');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/diagnostics.mjs')) main();
