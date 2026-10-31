import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadinessService } from '../dist/health/readiness.service.js';
import { createShutdown } from '../dist/shutdown.js';
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

const DRAIN_MS = 300;

async function startDrainApp(t) {
  const started = await startApp(t, { SHUTDOWN_DRAIN_MS: String(DRAIN_MS) });
  const readiness = started.app.get(ReadinessService);
  const stop = createShutdown(started.app, readiness, DRAIN_MS, async () => {});
  return { ...started, stop };
}

test('after SIGTERM readiness answers 503 draining at once, liveness stays 200', async (t) => {
  const { origin, stop } = await startDrainApp(t);
  const stopping = stop();
  const ready = await fetch(`${origin}/health/ready`);
  assert.equal(ready.status, 503);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ready.json(), { status: 'draining' });
  assert.equal((await fetch(`${origin}/health/live`)).status, 200);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  await stopping;
});

test('a request in flight when draining starts still completes', async (t) => {
  const { app, origin, stop } = await startDrainApp(t);
  // A deliberately slow route, answered ahead of Nest, that outlasts the drain window.
  const server = app.getHttpServer();
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (request.url !== '/slow') {
      for (const listener of listeners)
        listener.call(server, request, response);
      return;
    }
    setTimeout(() => response.end('finished'), DRAIN_MS + 400);
  });
  const slow = fetch(`${origin}/slow`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stopping = stop();
  const response = await slow;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'finished');
  await stopping;
});

test('the app closes after the drain window and a second signal does not run shutdown twice', async (t) => {
  let flushes = 0;
  const started = await startApp(t, { SHUTDOWN_DRAIN_MS: String(DRAIN_MS) });
  const stop = createShutdown(
    started.app,
    started.app.get(ReadinessService),
    DRAIN_MS,
    async () => {
      flushes += 1;
    },
  );
  const begun = performance.now();
  await Promise.all([stop(), stop()]);
  assert.ok(
    performance.now() - begun >= DRAIN_MS - 20,
    'stop must wait out the drain window',
  );
  assert.equal(flushes, 1);
  await assert.rejects(fetch(`${started.origin}/health/live`));
});
