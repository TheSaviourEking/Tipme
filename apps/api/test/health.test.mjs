import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';

test('HTTP liveness is explicit and unknown/payment routes remain unavailable', async (t) => {
  const { origin } = await startApp(t);
  for (const path of ['/health', '/health/live']) {
    const health = await fetch(`${origin}${path}`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'api' });
  }
  for (const path of ['/missing', '/api/v1/tip-intents']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
});
