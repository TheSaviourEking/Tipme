import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { createMockProvider } from '../../packages/payments/dist/index.js';
import { RELAY_JOB_RETRIES } from '../../apps/worker/dist/job-retry.js';
import { startPgGate } from './pg-gate.mjs';
import {
  REDIS_URL,
  Redis,
  WEBHOOK_SECRET,
  bullmq,
  openEventStream,
  signIn,
  startStack,
} from './helpers.mjs';
import { PG_POOL } from '../../apps/api/dist/infra/infra.module.js';

// The whole stack at production's default sizes (one connection per API process, two per worker),
// with short waits so the waiting tests stay quick. Behind a door that can answer as a full server.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
const generous = '100000';
let database;
let apiGate;
let workerGate;
let stack;
let redis;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  apiGate = await startPgGate(database.url);
  workerGate = await startPgGate(database.url);
  stack = await startStack({
    databaseUrl: apiGate.url,
    apiEnv: {
      DATABASE_POOL_MAX: '1',
      DATABASE_POOL_CONNECT_TIMEOUT_MS: '500',
      RATE_LIMIT_QUOTES_PER_MIN: generous,
      RATE_LIMIT_INTENTS_PER_MIN: generous,
      LIVE_UPDATES_ENABLED: 'true',
    },
    workerEnv: {
      DATABASE_URL: workerGate.url,
      DATABASE_POOL_MAX: '2',
      DATABASE_POOL_CONNECT_TIMEOUT_MS: '500',
      RECONCILE_INTERVAL_MS: '300',
      RECONCILE_MIN_AGE_MS: '0',
    },
  });
  redis = new Redis(REDIS_URL);
});
after(async () => {
  await stack.stop();
  await redis.quit();
  await apiGate.close();
  await workerGate.close();
  await database.close();
});

const post = async (path, body, headers = {}) => {
  const response = await fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const quote = () =>
  post('/v1/tip-quotes', {
    handle: 'ada',
    amountMinor: '200000',
    currency: 'NGN',
  });
const count = async (sql, params = []) =>
  (await database.pool.query(sql, params)).rows[0].n;
const until = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  return null;
};
const ready = () => fetch(`${stack.api}/health/ready`);

/** Holds a lock that blocks new quotes, so the API's only connection stays in use. */
async function withQuotesBlocked(work) {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE tip_quotes IN ACCESS EXCLUSIVE MODE');
    return await work();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('concurrent money requests all succeed on one connection, and it stays one', async () => {
  // Its own stack at production's real wait: the others shorten it to stay quick.
  const gate = await startPgGate(database.url);
  const surge = await startStack({
    databaseUrl: gate.url,
    workerEnv: { DATABASE_POOL_MAX: '2' },
    apiEnv: {
      DATABASE_POOL_MAX: '1',
      RATE_LIMIT_QUOTES_PER_MIN: generous,
      RATE_LIMIT_INTENTS_PER_MIN: generous,
    },
  });
  try {
    const send = (path, body, headers = {}) =>
      fetch(`${surge.api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const quotes = await Promise.all(
      Array.from({ length: 30 }, () =>
        send('/v1/tip-quotes', {
          handle: 'ada',
          amountMinor: '200000',
          currency: 'NGN',
        }),
      ),
    );
    assert.deepEqual([...new Set(quotes.map((q) => q.status))], [201]);
    // Fifteen different tips, each asked for twice at once with one key: fifteen tips.
    const asked = quotes.slice(0, 15).flatMap((q) => {
      const key = randomUUID();
      const body = { quoteId: q.body.data.quoteId };
      return [
        send('/v1/tip-intents', body, { 'idempotency-key': key }),
        send('/v1/tip-intents', body, { 'idempotency-key': key }),
      ];
    });
    const probes = asked.map(() => fetch(`${surge.api}/health/ready`));
    const intents = await Promise.all(asked);
    assert.ok(
      intents.every((answer) => answer.status < 300),
      JSON.stringify(intents.map((answer) => answer.status)),
    );
    assert.equal(new Set(intents.map((a) => a.body.data.tipId)).size, 15);
    const statuses = (await Promise.all(probes)).map((r) => r.status);
    assert.ok(
      statuses.every((status) => status === 200),
      String(statuses),
    );
    assert.ok(gate.peak <= 3, `peak ${gate.peak}`); // API 1, worker 2: startStack runs both here.
  } finally {
    await surge.stop();
    await gate.close();
  }
});

test('a request that cannot get a connection gets a clean 503, writes nothing, and a retry works', async () => {
  const tips = await count('SELECT count(*)::int AS n FROM tips');
  const { body: ok } = await quote();
  const key = randomUUID();
  const held = await withQuotesBlocked(async () => {
    const holder = quote(); // Takes the only connection and waits on the lock.
    await sleep(100);
    const waited = await post(
      '/v1/tip-intents',
      { quoteId: ok.data.quoteId },
      { 'idempotency-key': key },
    );
    assert.equal(waited.status, 503);
    assert.equal(waited.body.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(await count('SELECT count(*)::int AS n FROM tips'), tips);
    // Busy, not broken: the edge must not take this copy out for its queue.
    assert.equal((await ready()).status, 200);
    return { holder };
  });
  assert.equal((await held.holder).status, 201);
  const line = stack.logs.findLast(
    (entry) => entry.event === 'http.dependency_unavailable',
  );
  assert.equal(line.cause, 'pool_wait_timeout');
  assert.ok(line.reference);
  const retried = await post(
    '/v1/tip-intents',
    { quoteId: ok.data.quoteId },
    { 'idempotency-key': key },
  );
  assert.ok(retried.status < 300);
  assert.equal(await count('SELECT count(*)::int AS n FROM tips'), tips + 1);
});

test('a full server (53300) gives a 503 that names the cause, without secrets, and recovers', async () => {
  apiGate.fill();
  try {
    const refused = await quote();
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'DEPENDENCY_UNAVAILABLE');
    const line = stack.logs.findLast(
      (entry) => entry.event === 'http.dependency_unavailable',
    );
    assert.equal(line.sql_state, '53300');
    assert.equal(line.cause, 'sqlstate');
    assert.equal((await ready()).status, 503);
    assert.equal(
      stack.logs.findLast((entry) => entry.event === 'readiness.postgres_down')
        ?.sql_state,
      '53300',
    );
    assert.ok(!JSON.stringify(stack.logs).includes('tipme_local_password'));
  } finally {
    apiGate.drain();
  }
  // It backs off a full server for a moment, then comes back on its own.
  assert.ok(await until(async () => (await ready()).status === 200));
  assert.equal((await quote()).status, 201);
});

test('reconcile.payments failing on 53300 tries again and applies the payment exactly once', async () => {
  const mock = createMockProvider({
    redis,
    secret: WEBHOOK_SECRET,
    prefix: stack.prefix,
  });
  workerGate.fill();
  const failuresBefore = stack.logs.length;
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  const { providerReference } = await mock.initializePayment({
    attemptId,
    amountMinor: 200000n,
    currency: 'NGN',
    scenario: 'no-reply',
  });
  await markAttemptInitiated(database.db, {
    attemptId,
    provider: 'mock',
    providerReference,
  });
  const status = () =>
    database.pool
      .query('SELECT status FROM tips WHERE id = $1', [tipId])
      .then((r) => r.rows[0].status);
  const failed = await until(() =>
    stack.logs
      .slice(failuresBefore)
      .find(
        (line) =>
          line.event === 'job.failed' &&
          line.job_name === 'reconcile.payments' &&
          line.sql_state === '53300',
      ),
  );
  assert.ok(failed, 'the job should fail while the server is full');
  assert.notEqual(await status(), 'SUCCEEDED');
  workerGate.drain();
  assert.ok(await until(async () => (await status()) === 'SUCCEEDED'));
  // Several more runs: the same payment is never posted again.
  await sleep(1000);
  assert.equal(
    await count(
      `SELECT count(*)::int AS n FROM provider_events WHERE attempt_id = $1`,
      [attemptId],
    ),
    1,
  );
  assert.equal(
    await count(
      `SELECT count(DISTINCT operation_key)::int AS n FROM ledger_transactions WHERE tip_id = $1`,
      [tipId],
    ),
    1,
  );
});

test('an outbox job failing on 53300 is tried again, not lost', async () => {
  const { JOB_QUEUE } = await import('../../packages/contracts/dist/index.js');
  const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const jobs = new bullmq.Queue(JOB_QUEUE, {
    connection,
    prefix: stack.prefix,
  });
  try {
    workerGate.fill();
    const job = await jobs.add(
      'payment.conflict',
      { tipId: randomUUID() },
      { ...RELAY_JOB_RETRIES, jobId: `budget-${randomUUID()}` },
    );
    assert.ok(
      await until(async () => (await jobs.getJob(job.id)).attemptsMade >= 1),
    );
    workerGate.drain();
    const settled = await until(async () => {
      const state = await jobs.getJobState(job.id);
      return state === 'completed' || state === 'failed' ? state : null;
    }, 20_000);
    assert.equal(
      settled,
      'completed',
      JSON.stringify([
        await jobs.getJobState(job.id),
        await jobs.getJobCounts(),
        (await jobs.getJob(job.id)).attemptsMade,
        stack.logs
          .slice(-12)
          .map((l) => [
            l.event,
            l.job_name,
            l.sql_state,
            l.db_failure,
            l.pool_max_now,
          ]),
      ]),
    );
    assert.ok((await jobs.getJob(job.id)).attemptsMade >= 2);
  } finally {
    workerGate.drain();
    await jobs.close();
    await connection.quit();
  }
});

test('the API alone never opens more than its pool', () => {
  // Every other test in this file has run against this door, the API's only way in.
  assert.equal(apiGate.peak, 1);
  assert.ok(workerGate.peak <= 2, `worker peak ${workerGate.peak}`);
});

test('an open stream holds no pool connection', async () => {
  const { cookie } = await signIn(stack.api, '+2348033300001');
  const pool = stack.app.get(PG_POOL);
  const idleBefore = await until(() => pool.idleCount >= 1 && pool.idleCount);
  const stream = await openEventStream(`${stack.api}/v1/me/events`, {
    cookie,
    origin: 'http://localhost:3000',
  });
  await stream.waitFor(/^data: \{"type":"ready"\}$/);
  try {
    // The connect's two queries are done and their connection is back, while the stream stays open.
    assert.equal(await until(() => pool.idleCount === idleBefore), true);
    // With one connection in the whole pool, an ordinary read still gets it.
    const sessions = await fetch(`${stack.api}/v1/me/sessions`, {
      headers: { cookie },
    });
    assert.equal(sessions.status, 200);
    assert.equal(stream.frames.includes('data: {"type":"ready"}'), true);
  } finally {
    stream.close();
  }
});
