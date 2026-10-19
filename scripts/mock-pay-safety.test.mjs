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
      MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
      ...env,
    },
  });

test('the signed webhooks only go to a local API', () => {
  const result = run(['--scenario', 'succeed', '--api', 'https://example.com']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--api must be a local address/);
});

test('a non-local Redis is refused', () => {
  const result = run(['--scenario', 'succeed'], {
    REDIS_URL: 'redis://cache.example.com:6379',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-local Redis/);
});
