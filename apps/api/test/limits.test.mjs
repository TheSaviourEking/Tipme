import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';

test('oversized JSON bodies are refused and slow requests are bounded', async (t) => {
  const { app, origin } = await startApp(t);
  const response = await fetch(`${origin}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(20 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.equal(app.getHttpServer().requestTimeout, 10000);
});
