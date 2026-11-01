import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { checkProduction } from '../../scripts/watch-production.mjs';
import { Redis, REDIS_URL, uniquePrefix } from './helpers.mjs';

// The real API and worker processes, started as production with bachs-live and payments on. Bachs
// is a local stand-in (no-real-provider.mjs): nothing here can reach api.bachs.io.
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const API_MAIN = path('../../apps/api/dist/main.js');
const WORKER_MAIN = path('../../apps/worker/dist/main.js');
const GUARD = path('./no-real-provider.mjs');
const VERSION = 'abcdef1';
const ALERT_PATH = '/hooks.example.test/services/T0/B0/very-secret-token';
const FAR = 46 * 60_000;

let database;
let standIn;
let standInOrigin;
const requests = [];
let balance = '500.00'; // below the ₦1,000 alert level
const alerts = [];
const children = [];

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  standIn = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === ALERT_PATH) {
        alerts.push(JSON.parse(body));
        return response.end('{}');
      }
      if (request.url === '/') return response.end('the web app stand-in');
      if (request.url.startsWith('/api.bachs.io/v1/balances'))
        return response.end(
          JSON.stringify({
            balances: [
              {
                currency: 'NGN',
                available_balance: balance,
                pending_balance: '0.00',
              },
            ],
          }),
        );
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: 'not_found' } }));
    });
  });
  standIn.listen(0, '127.0.0.1');
  await once(standIn, 'listening');
  standInOrigin = `http://127.0.0.1:${standIn.address().port}`;
});
after(async () => {
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGKILL');
  standIn.closeAllConnections();
  await new Promise((resolve) => standIn.close(resolve));
  await database.close();
});

const shared = () => ({
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  DEPLOYMENT_MODE: 'production',
  PAYMENT_PROVIDER: 'bachs-live',
  PAYMENTS_LIVE_ENABLED: 'true',
  BACHS_LIVE_API_KEY: 'sk_live_stand_in_only',
  DATABASE_URL: database.url,
  REDIS_URL,
  GIT_SHA: VERSION,
  STAND_IN_ORIGIN: standInOrigin,
  MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  MAIL_DEFAULT_PROVIDER: 'ses',
  MAIL_FROM_DOMAIN: 'mail.example.test',
  SES_CONFIGURATION_SET: 'tipme-tracked',
  SES_CONFIGURATION_SET_UNTRACKED: 'tipme-untracked',
  SES_SNS_TOPIC_ARN: 'arn:aws:sns:eu-north-1:123456789012:tipme-ses',
  WEB_ORIGIN: 'https://web.example.test',
  API_ORIGIN: 'https://api.example.test',
});

function start(main, env) {
  const child = spawn(process.execPath, ['--import', GUARD, main], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const process_ = { child, out: '', err: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => (process_.out += c));
  child.stderr.setEncoding('utf8').on('data', (c) => (process_.err += c));
  return process_;
}

async function until(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startApi(port) {
  const api = start(API_MAIN, {
    ...shared(),
    PORT: String(port),
    HOST: '127.0.0.1',
    BACHS_LIVE_WEBHOOK_SECRET: 'l'.repeat(32),
    STATUS_TOKEN_SECRET: 's'.repeat(32),
    AUTH_CODE_SECRET: 'a'.repeat(32),
    WEB_REVALIDATE_SECRET: 'r'.repeat(32),
    OPS_TOTP_KEY: Buffer.alloc(32, 1).toString('base64'),
  });
  const origin = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (api.child.exitCode !== null)
      throw new Error(`API exited: ${api.err || api.out}`);
    return fetch(`${origin}/health/release`).then(
      (r) => r.ok,
      () => false,
    );
  }, 'the API to answer');
  return { ...api, origin, process: api };
}

const stop = async (running) => {
  const exited = once(running.child, 'exit');
  running.child.kill('SIGTERM');
  await exited;
};

const data = async (url) => (await (await fetch(url)).json()).data;
const watch = (api, log = () => undefined) =>
  checkProduction({
    web: standInOrigin,
    api: api.origin,
    expectLive: 'true',
    log,
  });
const freePort = async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};
const rows = (sql) => database.pool.query(sql).then((r) => r.rows);

test('a worker with payments on and no alert address refuses to start, before calling anyone', async () => {
  const before = requests.length;
  const worker = start(WORKER_MAIN, {
    ...shared(),
    QUEUE_PREFIX: uniquePrefix(),
  });
  const [code] = await once(worker.child, 'exit');
  assert.equal(code, 1);
  assert.match(worker.err, /Invalid configuration: ALERT_WEBHOOK_URL/);
  assert.equal(requests.length, before);
});

test(
  'live payments started for real: recorded once, stale until checks run, then the watcher quiet, then stale again',
  { timeout: 90_000 },
  async () => {
    const port = await freePort();
    let api = await startApi(port);

    // It reports itself as live, and the boot was recorded.
    const release = await data(`${api.origin}/health/release`);
    assert.equal(release.paymentsLive, true);
    assert.equal(release.paymentProvider, 'bachs-live');
    assert.equal(release.deploymentMode, 'production');
    assert.deepEqual(
      await rows('SELECT live, provider, version FROM live_payment_switches'),
      [{ live: true, provider: 'bachs-live', version: VERSION }],
    );

    // No worker has read the reserve: the watcher raises exactly that, and the webhook still refuses.
    assert.equal((await data(`${api.origin}/health/payments`)).stale, true);
    const unsigned = await fetch(`${api.origin}/v1/webhooks/bachs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(unsigned.status, 401);
    const stopped = await watch(api);
    assert.equal(stopped.length, 1, stopped.join('\n'));
    assert.match(stopped[0], /reserve checks have stopped/);

    // A restart with no change records nothing.
    await stop(api);
    api = await startApi(port);
    assert.equal(
      (await rows('SELECT id FROM live_payment_switches')).length,
      1,
    );

    // The worker starts with the address, reads the stand-in, and alerts on the low balance.
    const worker = start(WORKER_MAIN, {
      ...shared(),
      QUEUE_PREFIX: uniquePrefix(),
      ALERT_WEBHOOK_URL: `https://hooks.example.test/services/T0/B0/very-secret-token`,
    });
    await until(
      async () =>
        (await rows('SELECT id FROM payment_reserve_readings')).length > 0,
      'the first reserve reading',
      40_000,
    );
    const [reading] = await rows(
      'SELECT provider, available_minor, low FROM payment_reserve_readings',
    );
    assert.equal(reading.provider, 'bachs-live');
    assert.equal(String(reading.available_minor), '50000');
    assert.equal(reading.low, true);
    await until(() => alerts.length === 1, 'the low alert');
    assert.match(alerts[0].text, /Payment reserve \(bachs-live\) is low: ₦500/);
    assert.ok(
      requests.some(
        (r) =>
          r.url === '/api.bachs.io/v1/balances' &&
          r.authorization === 'Bearer sk_live_stand_in_only',
      ),
    );
    assert.doesNotMatch(worker.out + worker.err, /very-secret-token/);
    assert.doesNotMatch(worker.out + worker.err, /sk_live_/);

    // Low is the worker's to announce: the watcher only notes it.
    const notes = [];
    assert.deepEqual(await watch(api, (m) => notes.push(m)), []);
    assert.match(notes.join('\n'), /is low/);
    const health = await data(`${api.origin}/health/payments`);
    assert.equal(health.stale, false);
    assert.equal(health.reserveLow, true);

    // The setup sweep ran beside it.
    await until(
      () => worker.out.includes('payout_setup.swept'),
      'the setup sweep',
    );

    // The worker stops and its last reading ages: the watcher raises it again.
    await stop(worker);
    await database.pool.query(
      `UPDATE payment_reserve_readings SET read_at = now() - interval '${FAR} milliseconds'`,
    );
    assert.equal((await data(`${api.origin}/health/payments`)).stale, true);
    const again = await watch(api);
    assert.equal(again.length, 1, again.join('\n'));
    assert.match(again[0], /reserve checks have stopped/);
    await stop(api);

    // No request anywhere but the stand-in's own paths for Bachs and the alert address.
    for (const request of requests)
      assert.match(
        request.url,
        /^\/(api\.bachs\.io\/|hooks\.example\.test\/|$)/,
      );
  },
);

test(
  'a setup sweep still running makes the next one skip, in the real worker',
  { timeout: 60_000 },
  async () => {
    const prefix = uniquePrefix();
    const redis = new Redis(REDIS_URL);
    const key = `${prefix}:lock:payment-accounts.payout-setup`;
    try {
      await redis.set(key, 'another-run', 'PX', 60_000);
      const worker = start(WORKER_MAIN, {
        ...shared(),
        QUEUE_PREFIX: prefix,
        ALERT_WEBHOOK_URL:
          'https://hooks.example.test/services/T0/B0/very-secret-token',
      });
      await until(
        () => worker.out.includes('payout_setup.skipped_running'),
        'the skip',
        40_000,
      );
      assert.doesNotMatch(worker.out, /payout_setup\.swept/);
      assert.equal(
        await redis.get(key),
        'another-run',
        'the other run keeps its lock',
      );
      await stop(worker);
    } finally {
      await redis.del(key);
      redis.disconnect();
    }
  },
);
