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
import { REDIS_URL, Redis, WEBHOOK_SECRET, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
let database;
let stack;
let redis;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    workerEnv: {
      MOCK_PROVIDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
      RECONCILE_INTERVAL_MS: '500',
      RECONCILE_MIN_AGE_MS: '0',
    },
  });
  redis = new Redis(REDIS_URL);
});
after(async () => {
  await stack.stop();
  await redis.quit();
  await database.close();
});

test('a payment the provider never reported is found by the background check', async () => {
  const mock = createMockProvider({
    redis,
    secret: WEBHOOK_SECRET,
    prefix: stack.prefix,
  });
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  const { providerReference } = await mock.initializePayment({
    attemptId,
    amountMinor: 100000n,
    currency: 'NGN',
    scenario: 'no-reply',
  });
  await markAttemptInitiated(database.db, {
    attemptId,
    provider: 'mock',
    providerReference,
  });
  const deadline = Date.now() + 8000;
  let status;
  while (Date.now() < deadline) {
    status = (
      await database.pool.query('SELECT status FROM tips WHERE id = $1', [
        tipId,
      ])
    ).rows[0].status;
    if (status === 'SUCCEEDED') break;
    await sleep(200);
  }
  assert.equal(status, 'SUCCEEDED');
  // The worker logs the run just after committing it: give the log line a moment.
  const logged = () =>
    stack.logs.some(
      (line) => line.event === 'reconcile.completed' && line.applied >= 1,
    );
  for (let i = 0; i < 20 && !logged(); i += 1) await sleep(100);
  assert.ok(logged());
  // The same run also expires never-paid tips, and reports it.
  const run = stack.logs.find((line) => line.event === 'reconcile.completed');
  assert.deepEqual(
    [typeof run.expired, typeof run.expired_paid, typeof run.expire_errors],
    ['number', 'number', 'number'],
  );
});
