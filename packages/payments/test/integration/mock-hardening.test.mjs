import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Redis } from 'ioredis';
import { createMockProvider, signWebhook } from '../../dist/index.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
after(() => redis.quit());
const prefix = () => `h-${randomUUID().slice(0, 8)}`;

test('a mock without a secret rejects every webhook, even one signed with an empty key', () => {
  const mock = createMockProvider({ redis, prefix: prefix() });
  const body = '{"id":"evt_1"}';
  const verdict = mock.verifyWebhook(Buffer.from(body), {
    'x-mock-signature': signWebhook(body, '', new Date()),
  });
  assert.deepEqual(verdict, { ok: false, reason: 'bad_signature' });
});

test('a corrupt stored status is treated as pending, never acted on', async () => {
  const p = prefix();
  const mock = createMockProvider({ redis, prefix: p });
  const { providerReference } = await mock.initializePayment({
    attemptId: randomUUID(),
    amountMinor: 1000n,
    currency: 'NGN',
  });
  await redis.hset(`mockprovider:${p}:payment:${providerReference}`, {
    status: 'weird',
  });
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'pending',
  );
});

test('payout status can be fetched and follows its scenario', async () => {
  const mock = createMockProvider({ redis, prefix: prefix() });
  const payoutId = randomUUID();
  const idempotencyKey = randomUUID();
  const { providerReference } = await mock.initiatePayout({
    payoutId,
    idempotencyKey,
    amountMinor: 1000n,
    currency: 'NGN',
    scenario: 'payout-failed',
  });
  const replay = await mock.initiatePayout({
    payoutId,
    idempotencyKey,
    amountMinor: 1000n,
    currency: 'NGN',
    scenario: 'payout-failed',
  });
  assert.equal(replay.providerReference, providerReference);
  await assert.rejects(
    mock.initiatePayout({
      payoutId,
      idempotencyKey,
      amountMinor: 2000n,
      currency: 'NGN',
      scenario: 'payout-failed',
    }),
    /different payout details/,
  );
  assert.equal(
    (await mock.fetchPayoutStatus(providerReference)).status,
    'pending',
  );
  await mock.settlePayout(providerReference);
  assert.equal(
    (await mock.fetchPayoutStatus(providerReference)).status,
    'failed',
  );
  assert.equal(
    (await mock.fetchPayoutStatus('mock_out_nope')).status,
    'not_found',
  );
});
