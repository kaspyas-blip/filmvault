import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const load = TIMEZONE => spawnSync(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./src/config.js'); console.log(config.timezone, process.env.TZ, new Date(2026, 0, 1, 12).toISOString())"], {
  encoding: 'utf8', env: { ...process.env, BOT_TOKEN: 'x', STREAMER_TOKEN: 'x', JELLYFIN_URL: 'http://x', JELLYFIN_API_KEY: 'x', TIMEZONE, TZ: 'UTC' },
}).stdout.trim();

test('the time zone setting decides how written times are read', () => {
  assert.equal(load('Asia/Tokyo'), 'Asia/Tokyo Asia/Tokyo 2026-01-01T03:00:00.000Z');
});

test('an unknown time zone falls back at the start', () => {
  assert.ok(load('Bogus/Zone').includes('Europe/Prague Europe/Prague'));
});
