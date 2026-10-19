import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./mock-pay.mjs', import.meta.url));
const run = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
      REDIS_URL: 'redis://127.0.0.1:6379',
      ...env,
    },
  });

test('unknown scenarios are refused with the valid list', () => {
  const result = run(['--scenario', 'explode']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /succeed, decline/);
});

test('a non-local database is refused', () => {
  const result = run(['--scenario', 'succeed'], {
    DATABASE_URL: 'postgres://u:p@db.example.com/x',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-local/);
});
