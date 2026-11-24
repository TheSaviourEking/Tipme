import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createPaymentIntent,
  createQuote,
  mailSealing,
  markAttemptInitiated,
  reconcileAttempts,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { BachsWebhookController } from '../../apps/api/dist/webhooks/bachs-webhook.controller.js';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import {
  createBachsProvider,
  createMockProvider,
  planScenario,
  runScenario,
  signWebhook,
} from '../../packages/payments/dist/index.js';
import {
  REDIS_URL,
  Redis,
  WEBHOOK_SECRET,
  setSwitch,
  startStack,
} from './helpers.mjs';

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
      amountMinor: 200000n,
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

// You collect (plan Task 5): the pretend partner can raise a dispute. Until Task 9 routes disputes,
// its webhook is authenticated and stored for review, and touches no payout, tip or balance.
test('a pretend dispute webhook is stored for review and changes nothing else', async () => {
  const before = await count('unmatched_provider_events');
  const untouched = async () => [
    await count('provider_events'),
    await count('ledger_transactions'),
    await count('payouts'),
  ];
  const others = await untouched();
  const opened = await mock.raiseDispute({
    chargeReference: 'mock_ch_platform:mock_collect_x',
    amountMinor: 100000n,
    currency: 'NGN',
  });
  const decided = await mock.decideDispute(opened.data.disputeId, 'lost');
  assert.deepEqual(
    await runScenario({
      plan: [
        { body: opened, signed: true, delayMs: 0 },
        { body: decided, signed: true, delayMs: 0 },
        { body: decided, signed: false, delayMs: 0 },
      ],
      webhookUrl: hook(),
      secret: WEBHOOK_SECRET,
    }),
    [200, 200, 401],
  );
  assert.equal(await count('unmatched_provider_events'), before + 2);
  assert.deepEqual(
    (
      await q(
        `SELECT event_type, reason FROM unmatched_provider_events
          WHERE provider_event_id = ANY($1) ORDER BY event_type`,
        [[opened.id, decided.id]],
      )
    ).map((row) => [row.event_type, row.reason]),
    [
      ['dispute.created', 'unknown_attempt'],
      ['dispute.updated', 'unknown_attempt'],
    ],
  );
  assert.deepEqual(await untouched(), others);
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

/*
 * You collect (plan Task 9): TipMe's own dispute on a tip it collected, delivered by the partner
 * as its dispute docs show it (https://docs.bachs.io/guides/webhooks/events/dispute-created). It
 * must be signed, is stored once against the tip's payment, and a repeat changes nothing.
 */
test('dispute webhooks are authenticated, stored and deduplicated', async () => {
  const { db } = database;
  const PLATFORM_ORG = 'acct_stWbI4933A4WVqkc';
  const SECRET = 'current-secret-0123456789';
  const adapter = createBachsProvider({
    apiKey: 'sk_sandbox_test',
    environment: 'sandbox',
    webhookSecrets: [SECRET],
    platformOrganizationId: PLATFORM_ORG,
    fetchImpl: async () => {
      throw new Error('no request expected');
    },
  });
  await setSwitch(database.pool, 'you_collect', true);
  try {
    await q(
      `UPDATE profiles SET collection_mode = 'collect' WHERE handle = 'tobi'`,
    );
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: 1_000_000n,
      currency: 'NGN',
    });
    assert.equal(quote.collectionMode, 'collect');
    const { tipId, attemptId } = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    await markAttemptInitiated(db, {
      attemptId,
      provider: 'bachs',
      providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
    });
    const charge = `ch_${randomUUID().slice(0, 12).replace(/-/g, '')}`;
    await reconcileAttempts({
      db,
      provider: {
        environment: 'sandbox',
        async verifyTransaction() {
          return {
            status: 'succeeded',
            amountMinor: 1_000_000n,
            currency: 'NGN',
            feeMinor: 20_000n,
            feePaidBy: 'platform',
            method: 'NGN_CARD',
            chargeReference: charge,
          };
        },
      },
      now: new Date(),
      minAgeMs: 0,
      attemptId,
    });
    const service = new WebhookService(
      { db },
      mailSealing(Buffer.alloc(32, 9)),
      { warn() {} },
    );
    const controller = new BachsWebhookController(
      adapter,
      { info() {}, warn() {} },
      service,
    );
    const body = {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'dispute.created',
      created_at: new Date().toISOString(),
      organization_id: PLATFORM_ORG,
      data: {
        dispute_id: `dsp_${randomUUID().slice(0, 8)}`,
        charge_id: charge,
        amount: '10000.00',
        currency: 'NGN',
        status: 'needs_response',
        reason: 'fraudulent',
        response_deadline_at: new Date(
          Date.now() + 7 * 86_400_000,
        ).toISOString(),
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signed = (secret) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
        .digest('hex');
      return { 'x-bachs-signature-v2': `t=${timestamp},v1=${signature}` };
    };
    // Wrongly signed: refused, nothing stored.
    await assert.rejects(
      controller.receive({
        rawBody,
        headers: signed('another-secret-0123456789'),
      }),
      (error) => error.getStatus?.() === 401,
    );
    assert.deepEqual(await q(`SELECT 1 FROM disputes`), []);
    const first = await controller.receive({
      rawBody,
      headers: signed(SECRET),
    });
    assert.deepEqual(first, { data: { outcome: 'dispute_opened' } });
    const again = await controller.receive({
      rawBody,
      headers: signed(SECRET),
    });
    assert.deepEqual(again, { data: { outcome: 'dispute_duplicate' } });
    assert.deepEqual(
      await q(
        `SELECT event_type, attempt_id, processing_outcome FROM provider_events
          WHERE provider_event_id = $1`,
        [body.id],
      ),
      [
        {
          event_type: 'dispute.created',
          attempt_id: attemptId,
          processing_outcome: 'dispute_opened',
        },
      ],
    );
    assert.deepEqual(
      await q(
        `SELECT tip_id, status, amount_minor::text AS amount FROM disputes`,
      ),
      [{ tip_id: tipId, status: 'open', amount: '1000000' }],
    );
    // Never Pro billing, never a generic stored event.
    assert.deepEqual(
      await q(
        `SELECT 1 FROM unmatched_provider_events WHERE provider_event_id = $1`,
        [body.id],
      ),
      [],
    );
  } finally {
    await setSwitch(database.pool, 'you_collect', false);
  }
});
