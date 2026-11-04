import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { redact } from '../tools/diagnostics.mjs';
import { fillEnv, parseEnv } from '../tools/setup.mjs';

test('diagnostics hide secrets but keep what helps', () => {
  const env = { BOT_TOKEN: 'abcdefghijkl', JELLYFIN_API_KEY: 'deadbeefcafe', VIDEO_ENCODER: 'h264_qsv' };
  const out = redact([
    'token abcdefghijkl and key deadbeefcafe', 'encoder h264_qsv', 'Token="zzz"', 'https://api.themoviedb.org/3/x?api_key=123&language=cs',
    'https://rr1---x.googlevideo.com/videoplayback?sig=1', 'http://192.168.0.181:8096', 'C:\\Users\\pc\\Documents',
    `MTU2NDc3MzIzMTkzODc2OTAyOA.${'a'.repeat(6)}.${'b'.repeat(30)}`,
  ].join('\n'), env);
  for (const secret of ['abcdefghijkl', 'deadbeefcafe', 'zzz', '=123', 'googlevideo', '192.168', 'Users\\pc', 'MTU2NDc3']) assert.equal(out.includes(secret), false, secret);
  assert.ok(out.includes('h264_qsv'));
  assert.ok(out.includes('<BOT_TOKEN>'));
});

test('setup fills the example, keeps its comments and order', () => {
  const filled = fillEnv('# comment\nBOT_TOKEN=\nFFMPEG_PATH=ffmpeg\n', { BOT_TOKEN: 'x', NEW_ONE: 'y' });
  assert.equal(filled, '# comment\nBOT_TOKEN=x\nFFMPEG_PATH=ffmpeg\n\nNEW_ONE=y');
  assert.deepEqual(parseEnv('# c\nA_B=1\r\nC= 2 \nnot valid'), { A_B: '1', C: '2' });
});

test('update moves to the new version, and refuses local changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'filmvault-update-'));
  const tools = resolve('tools');
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    const clone = join(root, 'clone');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);
    git(work, 'checkout', '-q', '-b', 'main');
    const lock = '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"x","version":"1.0.0"}}}';
    writeFileSync(join(work, 'package.json'), '{"name":"x","version":"1.0.0"}');
    writeFileSync(join(work, 'package-lock.json'), lock);
    spawnSync('git', ['-C', work, 'add', '.']);
    git(work, 'commit', '-q', '-m', 'one');
    git(work, 'push', '-q', '-u', 'origin', 'main');
    git(root, 'clone', '-q', origin, clone);
    const update = () => spawnSync(process.execPath, [join(tools, 'update.mjs')], { cwd: clone, encoding: 'utf8', timeout: 120_000 });

    assert.match(update().stdout, /up to date/);
    const first = git(clone, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'new.txt'), 'x');
    spawnSync('git', ['-C', work, 'add', '.']);
    git(work, 'commit', '-q', '-m', 'two');
    git(work, 'push', '-q');

    writeFileSync(join(clone, 'package.json'), '{"changed":1}');
    assert.match(update().stderr, /local changes/);
    git(clone, 'checkout', '-q', '--', 'package.json');

    // The clone has no tools/doctor.mjs, so the checks fail: it must come back.
    const failed = update();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Going back/);
    assert.equal(git(clone, 'rev-parse', 'HEAD'), first);
    assert.ok(readFileSync(join(clone, 'package.json'), 'utf8').includes('"x"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
