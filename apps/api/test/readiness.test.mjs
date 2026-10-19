import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';

test('readiness reports unreachable dependencies quickly while liveness stays up', async (t) => {
  const { origin } = await startApp(t);
  const started = performance.now();
  const response = await fetch(`${origin}/health/ready`);
  assert.ok(
    performance.now() - started < 3000,
    'readiness must answer within 3 s',
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    status: 'unavailable',
    checks: { postgres: 'down', redis: 'down' },
  });
  assert.equal((await fetch(`${origin}/health`)).status, 200);
});
