import assert from 'node:assert/strict';
import http from 'node:http';
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
  const stop = createShutdown(started.app, readiness, DRAIN_MS, {
    flushTelemetry: async () => {},
  });
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
    {
      flushTelemetry: async () => {
        flushes += 1;
      },
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

/** Answers /hang never, ahead of Nest, to stand in for a request that does not finish. */
function addHangingRoute(app) {
  const server = app.getHttpServer();
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (request.url === '/hang') return;
    for (const listener of listeners) listener.call(server, request, response);
  });
}

test('a request that never finishes is cut at the close deadline and telemetry still flushes once', async (t) => {
  let flushes = 0;
  const { app, origin } = await startApp(t);
  addHangingRoute(app);
  const stop = createShutdown(app, app.get(ReadinessService), 50, {
    closeDeadlineMs: 300,
    flushTelemetry: async () => {
      flushes += 1;
    },
  });
  const hung = fetch(`${origin}/hang`).then(
    () => 'responded',
    () => 'cut',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const begun = performance.now();
  await stop();
  const took = performance.now() - begun;
  assert.ok(took >= 300 && took < 2000, `stop took ${took} ms`);
  assert.equal(await hung, 'cut');
  assert.equal(flushes, 1);
});

test('an idle keep-alive connection does not delay close once draining is over', async (t) => {
  const { app, origin } = await startApp(t);
  const stop = createShutdown(app, app.get(ReadinessService), 50, {
    flushTelemetry: async () => {},
  });
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  await new Promise((resolve, reject) => {
    http
      .get(`${origin}/health/live`, { agent }, (response) => {
        response.resume();
        response.on('end', resolve);
      })
      .on('error', reject);
  });
  const begun = performance.now();
  await stop();
  assert.ok(
    performance.now() - begun < 1500,
    'stop must not wait out the 5 s keep-alive timeout',
  );
});

test('a failure while closing still flushes telemetry once and is reported by stop', async (t) => {
  let flushes = 0;
  const { app } = await startApp(t);
  // Nest's app is a proxy that ignores reassigned methods, so wrap the two calls shutdown makes.
  const failing = {
    getHttpServer: () => app.getHttpServer(),
    close: async () => {
      await app.close();
      throw new Error('close failed');
    },
  };
  const stop = createShutdown(failing, app.get(ReadinessService), 0, {
    flushTelemetry: async () => {
      flushes += 1;
    },
  });
  await assert.rejects(stop(), /close failed/);
  assert.equal(flushes, 1);
});
