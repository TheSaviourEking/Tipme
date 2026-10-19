import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import {
  createMockProvider,
  planScenario,
  runScenario,
  signWebhook,
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
  stack = await startStack({ databaseUrl: database.url });
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
const count = async (table) =>
  (await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
const hook = () => `${stack.api}/v1/webhooks/mock`;

async function initiatedPayment(scenario = 'succeed') {
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
  return {
    tipId,
    attemptId,
    payment: {
      reference: providerReference,
      attemptId,
      amountMinor: 100000n,
      currency: 'NGN',
      feeMinor: 1500n,
    },
  };
}
const tipStatus = async (tipId) =>
  (await q('SELECT status FROM tips WHERE id = $1', [tipId]))[0].status;
const post = (raw, signature) =>
  fetch(hook(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': signature,
    },
    body: raw,
  });

test('a signed success marks the tip paid', async () => {
  const { tipId, payment } = await initiatedPayment();
  assert.deepEqual(
    await runScenario({
      plan: planScenario('succeed', payment),
      webhookUrl: hook(),
      secret: WEBHOOK_SECRET,
    }),
    [200, 200],
  );
  assert.equal(await tipStatus(tipId), 'SUCCEEDED');
});

test('unsigned or wrongly signed webhooks are rejected before anything is stored', async () => {
  const { tipId, payment } = await initiatedPayment();
  const before = [
    await count('provider_events'),
    await count('unmatched_provider_events'),
  ];
  const raw = JSON.stringify(planScenario('succeed', payment)[1].body);
  for (const response of [
    await fetch(hook(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    }),
    await post(
      raw,
      signWebhook(raw, 'not-the-secret-but-still-32-characters', new Date()),
    ),
  ]) {
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  }
  assert.deepEqual(
    [await count('provider_events'), await count('unmatched_provider_events')],
    before,
  );
  assert.equal(await tipStatus(tipId), 'AWAITING_PAYMENT');
});

test('a correctly signed but malformed body is refused and nothing is stored', async () => {
  const before = await count('provider_events');
  const response = await post(
    'not json',
    signWebhook('not json', WEBHOOK_SECRET, new Date()),
  );
  assert.equal(response.status, 400);
  assert.equal(await count('provider_events'), before);
});

test('control characters in identifiers are refused as malformed, not retried forever', async () => {
  const before =
    (await count('provider_events')) +
    (await count('unmatched_provider_events'));
  const plan = planScenario('succeed', {
    reference: 'mock_pay_x',
    attemptId: randomUUID(),
    amountMinor: 100n,
    currency: 'NGN',
    feeMinor: 2n,
  });
  const raw = JSON.stringify({ ...plan[1].body, id: 'evt_\u0000bad' });
  const response = await post(
    raw,
    signWebhook(raw, WEBHOOK_SECRET, new Date()),
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await count('provider_events')) +
      (await count('unmatched_provider_events')),
    before,
  );
});

test('events are matched by provider reference, never by the attempt ID they claim', async () => {
  const a = await initiatedPayment();
  const b = await initiatedPayment();
  const forgedClaim = { ...planScenario('succeed', a.payment)[1].body };
  forgedClaim.data = { ...forgedClaim.data, attemptId: b.attemptId };
  const raw = JSON.stringify(forgedClaim);
  assert.equal(
    (await post(raw, signWebhook(raw, WEBHOOK_SECRET, new Date()))).status,
    200,
  );
  assert.equal(await tipStatus(a.tipId), 'SUCCEEDED');
  assert.equal(await tipStatus(b.tipId), 'AWAITING_PAYMENT');
});

test('a verified event for an unknown payment is stored for review', async () => {
  const before = await count('unmatched_provider_events');
  const plan = planScenario('succeed', {
    reference: 'mock_pay_unknown',
    attemptId: randomUUID(),
    amountMinor: 100n,
    currency: 'NGN',
    feeMinor: 2n,
  });
  assert.deepEqual(
    await runScenario({
      plan: [plan[1], plan[1]],
      webhookUrl: hook(),
      secret: WEBHOOK_SECRET,
    }),
    [200, 200],
  );
  assert.equal(await count('unmatched_provider_events'), before + 1);
});

test('a duplicate delivery is acknowledged without a second effect', async () => {
  const { attemptId, payment } = await initiatedPayment();
  const plan = planScenario('duplicate', payment);
  const outcomes = [];
  for (const delivery of plan) {
    const raw = JSON.stringify(delivery.body);
    const response = await post(
      raw,
      signWebhook(raw, WEBHOOK_SECRET, new Date()),
    );
    outcomes.push((await response.json()).data.outcome);
  }
  assert.deepEqual(outcomes, ['applied', 'duplicate']);
  assert.equal(
    (
      await q(
        `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_key = $1`,
        [`payment.${attemptId}`],
      )
    )[0].n,
    1,
  );
});

test('when the database is unavailable the provider is asked to retry', async () => {
  const broken = await startStack({
    databaseUrl: 'postgres://tipme:tipme@127.0.0.1:1/none',
  });
  try {
    const plan = planScenario('succeed', {
      reference: 'mock_pay_x',
      attemptId: randomUUID(),
      amountMinor: 100n,
      currency: 'NGN',
      feeMinor: 2n,
    });
    const raw = JSON.stringify(plan[1].body);
    const response = await fetch(`${broken.api}/v1/webhooks/mock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-signature': signWebhook(raw, WEBHOOK_SECRET, new Date()),
      },
      body: raw,
    });
    assert.equal(response.status, 503);
  } finally {
    await broken.stop();
  }
});

test('signed JSON in the wrong shape is refused and nothing is stored', async () => {
  const before =
    (await count('provider_events')) +
    (await count('unmatched_provider_events'));
  const raw = JSON.stringify({
    id: 'evt_shape',
    type: 'payment.succeeded',
    data: { reference: 'x' },
  });
  const response = await post(
    raw,
    signWebhook(raw, WEBHOOK_SECRET, new Date()),
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await count('provider_events')) +
      (await count('unmatched_provider_events')),
    before,
  );
});

test('a database failure part-way through leaves no partial rows and asks for a retry', async () => {
  const { tipId, payment } = await initiatedPayment();
  const before = await count('provider_events');
  // Test-only: make the tip update fail with an availability error (SQLSTATE 57P01) mid-transaction.
  await q(`CREATE FUNCTION tipme_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated shutdown' USING ERRCODE = 'admin_shutdown'; END; $$`);
  await q(
    `CREATE TRIGGER tipme_test_fail BEFORE UPDATE ON tips FOR EACH ROW EXECUTE FUNCTION tipme_test_fail()`,
  );
  try {
    const raw = JSON.stringify(planScenario('succeed', payment)[1].body);
    const response = await post(
      raw,
      signWebhook(raw, WEBHOOK_SECRET, new Date()),
    );
    assert.equal(response.status, 503);
    assert.equal(
      await count('provider_events'),
      before,
      'the event row rolled back with the failure',
    );
    assert.equal(await tipStatus(tipId), 'AWAITING_PAYMENT');
  } finally {
    await q('DROP TRIGGER tipme_test_fail ON tips');
    await q('DROP FUNCTION tipme_test_fail()');
  }
});

test('a late "pending" after success is acknowledged and changes nothing', async () => {
  const { tipId, payment } = await initiatedPayment();
  const plan = planScenario('succeed', payment);
  await runScenario({
    plan: [plan[1]],
    webhookUrl: hook(),
    secret: WEBHOOK_SECRET,
  });
  const raw = JSON.stringify(plan[0].body);
  const response = await post(
    raw,
    signWebhook(raw, WEBHOOK_SECRET, new Date()),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.outcome, 'ignored');
  assert.equal(await tipStatus(tipId), 'SUCCEEDED');
});
