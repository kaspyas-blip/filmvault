import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { jsonFile } from '../src/store.js';

const dir = mkdtempSync(join(tmpdir(), 'filmvault-store-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const quiet = console.error;

test('reads what was written, undefined when nothing was', async () => {
  const file = jsonFile(join(dir, 'a', 'one.json'));
  assert.equal(await file.read(), undefined);
  await file.write({ n: 1 });
  assert.deepEqual(await file.read(), { n: 1 });
});

test('writes in order, the last one wins, the one before is the backup', async () => {
  const path = join(dir, 'order.json');
  const file = jsonFile(path);
  for (let n = 1; n <= 20; n++) file.write({ n });
  await file.write({ n: 21 });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { n: 21 });
  assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, 'utf8')), { n: 20 });
  assert.equal(existsSync(`${path}.tmp`), false);
});

test('a corrupt file is kept, never overwritten, and the backup takes over', async () => {
  console.error = () => {};
  const path = join(dir, 'corrupt.json');
  const file = jsonFile(path);
  await file.write({ n: 1 });
  await file.write({ n: 2 });
  writeFileSync(path, '{"n": 2, broken');
  assert.deepEqual(await file.read(), { n: 1 });
  const kept = readdirSync(dir).find(name => name.startsWith('corrupt.json.corrupt-'));
  assert.equal(readFileSync(join(dir, kept), 'utf8'), '{"n": 2, broken');
  console.error = quiet;
});

test('a corrupt file does not become the backup', async () => {
  console.error = () => {};
  const path = join(dir, 'nobackup.json');
  const file = jsonFile(path);
  await file.write({ good: true });
  await file.write({ good: 'yes' });
  writeFileSync(path, 'garbage');
  await file.write({ fresh: true });
  assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, 'utf8')), { good: true });
  console.error = quiet;
});

test('a missing file falls back to its backup', async () => {
  const path = join(dir, 'lost.json');
  writeFileSync(`${path}.bak`, '{"saved":1}');
  assert.deepEqual(await jsonFile(path).read(), { saved: 1 });
});

test('a file that cannot be opened is not taken for empty', async () => {
  // A folder in its place stands in for a file locked by another program.
  const path = join(dir, 'locked.json');
  mkdirSync(path);
  await assert.rejects(jsonFile(path).read());
});

test('corrupt with no backup starts empty', async () => {
  console.error = () => {};
  const path = join(dir, 'gone.json');
  writeFileSync(path, 'x');
  assert.equal(await jsonFile(path).read(), undefined);
  console.error = quiet;
});
