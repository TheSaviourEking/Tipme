import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  createPaymentIntent,
  createPayout,
  createQuote,
  markAttemptInitiated,
  markPayoutInitiated,
  seedDemoProfiles,
  tipProof,
} from '../../packages/database/dist/index.js';
import {
  createMockProvider,
  planPayoutScenario,
  planScenario,
  runScenario,
} from '../../packages/payments/dist/index.js';
import { REDIS_URL, Redis, WEBHOOK_SECRET, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
let database;
let stack;
let redis;
let mock;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    workerEnv: { RECONCILE_INTERVAL_MS: '600000' },
  });
  redis = new Redis(REDIS_URL);
  mock = createMockProvider({
    redis,
    secret: WEBHOOK_SECRET,
    prefix: stack.prefix,
  });
});
after(async () => {
  await stack.stop();
  await redis.quit();
  await database.close();
});

const q = (sql, params) =>
  database.pool.query(sql, params).then((result) => result.rows);
const hook = () => `${stack.api}/v1/webhooks/mock`;

async function play(scenario) {
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
    scenario,
  });
  await markAttemptInitiated(database.db, {
    attemptId,
    provider: 'mock',
    providerReference,
  });
  const payment = {
    reference: providerReference,
    attemptId,
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
  };
  const statuses = await runScenario({
    plan: planScenario(scenario, payment),
    webhookUrl: hook(),
    secret: WEBHOOK_SECRET,
  });
  await mock.settle(providerReference);
  const [tip] = await q('SELECT status FROM tips WHERE id = $1', [tipId]);
  const [attempt] = await q(
    'SELECT status FROM payment_attempts WHERE id = $1',
    [attemptId],
  );
  const ledger = (
    await q(
      `SELECT count(*)::int AS n FROM ledger_transactions WHERE tip_id = $1`,
      [tipId],
    )
  )[0].n;
  const outbox = (
    await q(
      'SELECT dedupe_key FROM outbox_events WHERE aggregate_id IN ($1, $2)',
      [tipId, attemptId],
    )
  ).map((row) => row.dedupe_key);
  const history = (
    await q(
      `SELECT to_status FROM status_transitions WHERE entity_id = $1 ORDER BY created_at, id`,
      [tipId],
    )
  ).map((row) => row.to_status);
  return {
    tipId,
    attemptId,
    statuses,
    tip: tip.status,
    attempt: attempt.status,
    ledger,
    outbox,
    history,
  };
}

test('1. succeed: paid, booked, receipt queued', async () => {
  const r = await play('succeed');
  assert.deepEqual(
    [r.tip, r.attempt, r.ledger],
    ['SUCCEEDED', 'VERIFIED_SUCCEEDED', 1],
  );
  assert.ok(r.outbox.includes(`tip.succeeded.${r.tipId}`));
});

test('2. decline: failed, nothing booked', async () => {
  const r = await play('decline');
  assert.deepEqual(
    [r.tip, r.attempt, r.ledger],
    ['FAILED', 'VERIFIED_FAILED', 0],
  );
});

test('3. pending then succeeds later', async () => {
  const r = await play('pending-then-succeed');
  assert.deepEqual(r.history, [
    'AWAITING_PAYMENT',
    'PENDING_VERIFICATION',
    'SUCCEEDED',
  ]);
  assert.equal(r.ledger, 1);
});

test('4. duplicate delivery: applied once', async () => {
  const r = await play('duplicate');
  assert.deepEqual(
    [
      r.tip,
      r.ledger,
      r.outbox.filter((key) => key.startsWith('tip.succeeded')).length,
    ],
    ['SUCCEEDED', 1, 1],
  );
});

test('5. out of order: nothing goes backwards', async () => {
  const r = await play('out-of-order');
  assert.equal(r.tip, 'SUCCEEDED');
  assert.equal(r.history.at(-1), 'SUCCEEDED');
  assert.equal(r.ledger, 1);
});

test('6. wrong amount: flagged, never booked', async () => {
  const r = await play('wrong-amount');
  assert.deepEqual(
    [r.tip, r.attempt, r.ledger],
    ['AWAITING_PAYMENT', 'UNKNOWN', 0],
  );
  assert.ok(
    r.outbox.some((key) => key.startsWith(`payment.mismatch.${r.attemptId}.`)),
  );
});

test('7. no reply: nothing happens until reconciliation asks', async () => {
  const r = await play('no-reply');
  assert.deepEqual(
    [r.statuses, r.tip, r.attempt, r.ledger],
    [[], 'AWAITING_PAYMENT', 'INITIATED', 0],
  );
  assert.equal(
    (
      await mock.verifyTransaction(
        (
          await q(
            'SELECT provider_reference FROM payment_attempts WHERE id = $1',
            [r.attemptId],
          )
        )[0].provider_reference,
      )
    ).status,
    'succeeded',
  );
});

test('8. forged: rejected, nothing changes', async () => {
  const r = await play('forged');
  assert.deepEqual(r.statuses, [401]);
  assert.deepEqual(
    [r.tip, r.attempt, r.ledger],
    ['AWAITING_PAYMENT', 'INITIATED', 0],
  );
});

for (const scenario of ['payout-paid', 'payout-failed']) {
  test(`9. ${scenario}: the second proof`, async () => {
    const { tipId } = await play('succeed');
    const ada = DEMO_PROFILES[0].id;
    const { payoutId, amountMinor, currency } = await createPayout(
      database.db,
      { profileId: ada, tipIds: [tipId], idempotencyKey: randomUUID() },
    );
    const { providerReference } = await mock.initiatePayout({
      payoutId,
      amountMinor,
      currency,
      scenario,
    });
    await markPayoutInitiated(database.db, {
      payoutId,
      provider: 'mock',
      providerReference,
    });
    const statuses = await runScenario({
      plan: planPayoutScenario(scenario, {
        reference: providerReference,
        payoutId,
        amountMinor,
        currency,
      }),
      webhookUrl: hook(),
      secret: WEBHOOK_SECRET,
    });
    assert.deepEqual(statuses, [200, 200]);
    const proof = await tipProof(database.db, tipId);
    assert.equal(
      proof.payout.status,
      scenario === 'payout-paid' ? 'PAID' : 'FAILED',
    );
    assert.equal(proof.payout.providerReference, providerReference);
  });
}
