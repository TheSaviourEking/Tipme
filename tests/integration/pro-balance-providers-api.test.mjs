import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  grantCashReward,
  markAttemptInitiated,
  recordProviderEvent,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { createMockProvider } from '../../packages/payments/dist/index.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  browserHeaders,
  signIn,
  startStack,
} from './helpers.mjs';

// Per-provider balances, Task 7 (spec §8, P10) through the API: Pro paid from the balance of an
// owner whose money sits at the active `mock` and the test-only withdraw-only `mock_alt`. Exactly one
// provider pays, the first in drain order that covers the price alone. No provider is ever named.

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const TOBI = DEMO_PROFILES[1];
let database;
let stack;
let redis;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  const roles = { PAYMENT_WITHDRAW_ONLY_PROVIDERS: 'mock_alt' };
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      PRO_BILLING_ENABLED: 'true',
      PRO_PAY_FROM_BALANCE: 'on',
      ...roles,
    },
    workerEnv: roles,
  });
  redis = new Redis(REDIS_URL);
});
after(async () => {
  await redis.quit();
  await stack.stop();
  await database.close();
});

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

/** One ₦4,000 tip to Tobi collected through `provider`, recorded as its webhook would. */
async function tip(provider) {
  const { db } = database;
  const quote = await createQuote(db, {
    handle: 'tobi',
    tipMinor: 400000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `${provider}_pay_${randomUUID()}`;
  await markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider,
    providerReference: reference,
  });
  await recordProviderEvent(db, {
    provider,
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 400000n,
    currency: 'NGN',
    providerFeeMinor: 3000n,
    signatureVerified: true,
    payload: {},
  });
}

const buyFromBalance = (cookie) =>
  fetch(`${stack.api}/v1/me/pro/purchases`, {
    method: 'POST',
    headers: browserHeaders(cookie, { 'idempotency-key': randomUUID() }),
    body: JSON.stringify({ expectedAmountMinor: '500000', method: 'balance' }),
  });

test('Pro from the balance of an owner with money at mock and mock_alt: one provider pays, never named', async () => {
  await tip('mock_alt');
  await tip('mock');
  await grantCashReward(database.db, {
    profileId: TOBI.id,
    amountMinor: 1_500_000n,
    currency: 'NGN',
    operationKey: `reward.api.${randomUUID()}`,
  });
  const alt = createMockProvider({
    redis,
    prefix: stack.prefix,
    name: 'mock_alt',
  });
  const active = createMockProvider({ redis, prefix: stack.prefix });
  const { cookie } = await signIn(stack.api, TOBI.phone);

  // Both cover ₦5,000: the withdraw-only provider, first in drain order, pays.
  await alt.markPayoutBalance(TOBI.id, 600000n);
  await active.markPayoutBalance(TOBI.id, 600000n);
  const first = await buyFromBalance(cookie);
  assert.equal(first.status, 201);
  const firstText = await first.text();
  const firstBody = JSON.parse(firstText).data;
  assert.equal(firstBody.status, 'PAID');
  assert.doesNotMatch(firstText, /mock/);
  const [firstRow] = await q(
    `SELECT provider, account_reference FROM pro_purchases WHERE id = $1`,
    [firstBody.purchaseId],
  );
  assert.deepEqual(firstRow, {
    provider: 'mock_alt',
    account_reference: TOBI.id,
  });

  // The next month: mock_alt holds only ₦1,000 now, so the active provider pays it alone.
  await q(`DELETE FROM pro_periods`);
  await alt.markPayoutBalance(TOBI.id, 100000n);
  const second = await buyFromBalance(cookie);
  assert.equal(second.status, 201);
  const secondText = await second.text();
  const secondBody = JSON.parse(secondText).data;
  assert.equal(secondBody.status, 'PAID');
  assert.doesNotMatch(secondText, /mock/);
  const [secondRow] = await q(
    `SELECT provider FROM pro_purchases WHERE id = $1`,
    [secondBody.purchaseId],
  );
  assert.equal(secondRow.provider, 'mock');

  // Neither covers it alone (₦1,000 + ₦1,000): refused as too little money, nothing opened.
  await q(`DELETE FROM pro_periods`);
  await active.markPayoutBalance(TOBI.id, 100000n);
  const before = (await q(`SELECT 1 FROM pro_purchases`)).length;
  const third = await buyFromBalance(cookie);
  const thirdText = await third.text();
  assert.equal(third.status >= 400, true);
  assert.match(thirdText, /INSUFFICIENT_BALANCE/);
  assert.doesNotMatch(thirdText, /mock/);
  assert.equal((await q(`SELECT 1 FROM pro_purchases`)).length, before);
});
