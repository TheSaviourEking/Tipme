import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  balanceOf,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
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

// Per-provider balances, Task 5: the quote across the active `mock` and the test-only withdraw-only
// `mock_alt`. Users see amounts and states only, never a provider's name.

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
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000', ...roles },
    workerEnv: roles,
  });
  redis = new Redis(REDIS_URL);
});
after(async () => {
  await redis.quit();
  await stack.stop();
  await database.close();
});

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

test('one quote across both providers, with no provider named', async () => {
  await tip('mock_alt');
  await tip('mock');
  const ledger = (await balanceOf(database.db, TOBI.id)).availableMinor;
  const each = ledger / 2n;
  // The old provider holds exactly its own tip's net; the active one is the pretend figure.
  await createMockProvider({
    redis,
    prefix: stack.prefix,
    name: 'mock_alt',
  }).markPayoutBalance(TOBI.id, each);
  const { cookie } = await signIn(stack.api, TOBI.phone);
  const response = await fetch(`${stack.api}/v1/me/withdrawal-quote`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const quote = JSON.parse(body).data;
  assert.equal(quote.state, 'ready');
  assert.deepEqual(quote.capsMinor, [each.toString(), each.toString()]);
  assert.equal(quote.withdrawableMinor, ledger.toString());
  assert.equal(quote.partial, false);
  assert.equal(quote.bankDetailsNeeded, false);
  assert.equal(quote.heldElsewhere, false);
  assert.doesNotMatch(body, /mock_alt/);
  assert.doesNotMatch(body, /mock/);

  // The dashboard's question before an amount is typed: a configured provider took the tips.
  const summary = (
    await (
      await fetch(`${stack.api}/v1/me/dashboard`, { headers: { cookie } })
    ).json()
  ).data;
  assert.equal(summary.withdrawalsAvailable, true);
});

test('one request paid as two parts, with amounts only and no provider named', async () => {
  // The tips from the test above: each provider holds exactly its own tip's net.
  const ledger = (await balanceOf(database.db, TOBI.id)).availableMinor;
  const each = ledger / 2n;
  for (const name of ['mock', 'mock_alt'])
    await createMockProvider({
      redis,
      prefix: stack.prefix,
      name,
    }).markPayoutBalance(TOBI.id, each);
  const { cookie } = await signIn(stack.api, TOBI.phone);
  const key = randomUUID();
  const amount = each + 200000n;
  const withdraw = () =>
    fetch(`${stack.api}/v1/me/withdrawals`, {
      method: 'POST',
      headers: browserHeaders(cookie, { 'idempotency-key': key }),
      body: JSON.stringify({ amountMinor: amount.toString() }),
    });
  const response = await withdraw();
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.doesNotMatch(text, /mock/);
  const result = JSON.parse(text).data;
  assert.match(result.groupId, /^[0-9a-f-]{36}$/);
  assert.equal(result.status, 'REQUESTED');
  assert.deepEqual(
    result.parts.map((part) => part.amountMinor),
    [each.toString(), '200000'],
  );
  assert.equal(result.payoutId, result.parts[0].payoutId);
  // A retry of the same key returns the same group.
  const again = (await (await withdraw()).json()).data;
  assert.equal(again.groupId, result.groupId);
  assert.deepEqual(
    again.parts.map((part) => part.payoutId),
    result.parts.map((part) => part.payoutId),
  );
  // The list shows one row for the request, its total and its parts.
  const listed = await fetch(`${stack.api}/v1/me/withdrawals`, {
    headers: { cookie },
  });
  const listText = await listed.text();
  assert.doesNotMatch(listText, /mock/);
  const rows = JSON.parse(listText).data.items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payoutId, result.payoutId);
  assert.equal(rows[0].amountMinor, amount.toString());
  assert.deepEqual(
    rows[0].parts.map((part) => part.amountMinor),
    [each.toString(), '200000'],
  );
});
