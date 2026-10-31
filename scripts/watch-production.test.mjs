import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProduction } from './watch-production.mjs';

const WEB = 'https://tipme.example';
const API = 'https://api.tipme.example';

// A stub fetch keyed by "METHOD path"; a function value is called, an Error is thrown.
function stub(overrides = {}) {
  const routes = {
    'GET https://tipme.example/': { status: 200 },
    'GET https://api.tipme.example/health/ready': { status: 200 },
    'GET https://api.tipme.example/health/release': {
      status: 200,
      body: { data: { version: 'abc', paymentsLive: false } },
    },
    'GET https://api.tipme.example/health/payments': {
      status: 200,
      body: { data: { reserveLow: false } },
    },
    'POST https://api.tipme.example/v1/webhooks/bachs': { status: 401 },
    ...overrides,
  };
  return async (url, init = {}) => {
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    if (!route) throw new Error(`unexpected request ${url}`);
    if (typeof route === 'function') return route(init);
    if (route instanceof Error) throw route;
    return new Response(route.body ? JSON.stringify(route.body) : '', {
      status: route.status,
    });
  };
}
const run = (overrides, expectLive = 'false', extra = {}) =>
  checkProduction({
    web: WEB,
    api: API,
    expectLive,
    fetchImpl: stub(overrides),
    log: () => undefined,
    ...extra,
  });

test('a healthy production reports nothing', async () => {
  assert.deepEqual(await run(), []);
});

test('payments live not matching the activation state is a problem', async () => {
  const live = {
    'GET https://api.tipme.example/health/release': {
      status: 200,
      body: { data: { paymentsLive: true } },
    },
  };
  assert.match((await run(live, 'false'))[0], /payments are LIVE/i);
  assert.deepEqual(await run(live, 'true'), []);
  assert.match((await run(undefined, 'true'))[0], /not live/i);
});

test('an unset or invalid PRODUCTION_PAYMENTS_LIVE is itself a problem', async () => {
  for (const bad of [undefined, '', 'yes']) {
    const problems = await run(undefined, 'false', { expectLive: bad });
    assert.ok(
      problems.some((p) =>
        /PRODUCTION_PAYMENTS_LIVE must be true or false/.test(p),
      ),
    );
  }
});

test('a low reserve is a problem; a missing reserve endpoint is not', async () => {
  const low = await run({
    'GET https://api.tipme.example/health/payments': {
      status: 200,
      body: { data: { reserveLow: true } },
    },
  });
  assert.match(low[0], /reserve is low/i);
  const notes = [];
  const missing = await run(
    { 'GET https://api.tipme.example/health/payments': { status: 404 } },
    'false',
    { log: (m) => notes.push(m) },
  );
  assert.deepEqual(missing, []);
  assert.match(notes.join('\n'), /reserve not watched yet/);
});

test('API not ready and web down are named', async () => {
  const problems = await run({
    'GET https://api.tipme.example/health/ready': { status: 503 },
    'GET https://tipme.example/': { status: 502 },
  });
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /not ready/);
  assert.match(problems.join('\n'), /web app/);
});

test('a webhook endpoint that accepts unsigned calls is a problem', async () => {
  for (const status of [200, 202, 404]) {
    const problems = await run({
      'POST https://api.tipme.example/v1/webhooks/bachs': { status },
    });
    assert.match(problems[0], /webhook .* unsigned/i);
  }
});

test('an API that does not answer within the timeout is a problem, not a hang', async () => {
  const hang = (init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener('abort', () =>
        reject(new DOMException('timed out', 'TimeoutError')),
      ),
    );
  const started = Date.now();
  const problems = await run(
    {
      'GET https://api.tipme.example/health/ready': hang,
      'GET https://api.tipme.example/health/release': hang,
    },
    'false',
    { timeoutMs: 50 },
  );
  assert.ok(Date.now() - started < 2000);
  assert.match(problems.join('\n'), /not ready/);
  assert.match(problems.join('\n'), /release information/);
});
