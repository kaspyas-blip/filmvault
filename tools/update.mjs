// npm run update: moves a git checkout to the newest version, and back if that fails.
// It never restarts the bot; that stays your call. Stop the bot first: on Windows, a running
// bot holds files that installing has to replace. For automatic updates, schedule the three
// steps (stop, update, start) for a quiet hour.
import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, shell: command === 'npm' && process.platform === 'win32' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

const git = (...args) => run('git', args);

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (!git('rev-parse', '--is-inside-work-tree').ok) stop('This is not a git checkout, so it cannot update itself.');
if (git('status', '--porcelain', '--untracked-files=no').output) stop('The code has local changes. Commit or remove them first.');
const before = git('rev-parse', 'HEAD').output;
const fetched = git('fetch', '--quiet');
if (!fetched.ok) stop(`Could not reach the repository: ${fetched.output}`);
const pulled = git('merge', '--ff-only', '--quiet', '@{u}');
if (!pulled.ok) stop(`Cannot move forward: ${pulled.output}`);
const after = git('rev-parse', 'HEAD').output;
if (after === before) {
  console.log('Already up to date.');
  process.exit(0);
}

function rollBack(why) {
  console.error(`${why}\nGoing back to ${before.slice(0, 7)}.`);
  const reset = git('reset', '--hard', '--quiet', before);
  const reinstalled = reset.ok && run('npm', ['ci', '--omit=dev']).ok;
  if (!reinstalled) console.error('Going back did not finish. Stop the bot, then run: npm ci --omit=dev');
  process.exit(1);
}

const installed = run('npm', ['ci', '--omit=dev']);
if (!installed.ok) rollBack(`Installing failed: ${installed.output.slice(-500)}`);
const doctor = run(process.execPath, ['tools/doctor.mjs']);
if (!doctor.ok) rollBack(`The new version does not pass its checks:\n${doctor.output.slice(-800)}`);
console.log(`Updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}.\n${git('log', '--oneline', `${before}..${after}`).output}\nRestart the bot to use it.`);
