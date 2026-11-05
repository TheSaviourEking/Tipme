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
  recordProviderEvent,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { REDIS_URL, Redis, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({ databaseUrl: database.url });
});
after(async () => {
  await stack.stop();
  await database.close();
});

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error('timed out');
}

test('a paid tip reaches the worker through the outbox, carrying its trace, exactly once', async () => {
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    attemptId,
    providerReference: `ref-${attemptId}`,
    amountMinor: 200000n,
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: {},
  });
  const [row] = (
    await database.pool.query(
      `SELECT trace FROM outbox_events WHERE dedupe_key = $1`,
      [`tip.succeeded.${tipId}`],
    )
  ).rows;
  const traceId = row.trace.traceparent.split('-')[1];
  const received = () =>
    stack.logs.filter(
      (line) =>
        line.event === 'domain_event.received' && line.name === 'tip.succeeded',
    );
  await waitFor(() => received().length === 1);
  assert.equal(received()[0].trace_id, traceId);
  assert.ok(
    !JSON.stringify(received()).includes('200000'),
    'amounts are not logged',
  );

  // Simulate a relay that published but crashed before marking: the same job ID dedupes it.
  await database.pool.query(
    `UPDATE outbox_events SET published_at = NULL WHERE dedupe_key = $1`,
    [`tip.succeeded.${tipId}`],
  );
  await sleep(2500);
  assert.equal(received().length, 1);
});

test('the relay publishes tips.changed only after the claim commits', async (t) => {
  const subscriber = new Redis(REDIS_URL);
  t.after(() => subscriber.quit());
  const seen = [];
  subscriber.on('message', (_channel, raw) => {
    const message = JSON.parse(raw);
    // Read published_at the moment the signal arrives.
    seen.push(
      database.pool
        .query(
          `SELECT published_at FROM outbox_events
            WHERE event_type = 'tip.succeeded' AND payload->>'profileId' = $1
            ORDER BY created_at DESC LIMIT 1`,
          [message.to.profile],
        )
        .then(({ rows }) => ({ message, publishedAt: rows[0]?.published_at })),
    );
  });
  await subscriber.subscribe(`${stack.prefix}:live:v1`);
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { attemptId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    attemptId,
    providerReference: `ref-${attemptId}`,
    amountMinor: 200000n,
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: {},
  });
  await waitFor(() => seen.length > 0);
  const [first] = await Promise.all(seen);
  assert.equal(first.message.type, 'tips.changed');
  assert.ok(first.publishedAt, 'published_at was set before the signal');
});
