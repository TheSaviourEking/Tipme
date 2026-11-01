import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Redis } from 'ioredis';
import {
  UncertainProviderOutcomeError,
  createMockProvider,
  signWebhook,
} from '../../dist/index.js';

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

const payoutInput = (scenario) => ({
  payoutId: randomUUID(),
  accountRef: 'mock_account',
  destinationRef: 'mock_dest',
  amountMinor: 150000n,
  currency: 'NGN',
  idempotencyKey: `payout.${randomUUID()}`,
  ...(scenario ? { scenario } : {}),
});

test('payout-paid starts pending, then settles as paid', async () => {
  const mock = createMockProvider({ redis, prefix: prefix() });
  const started = await mock.initiatePayout(payoutInput('payout-paid'));
  assert.equal(started.status, 'pending');
  await mock.settlePayout(started.providerReference);
  assert.deepEqual(await mock.fetchPayoutStatus(started.providerReference), {
    status: 'paid',
  });
});

test('payout-failed settles as failed with a reason', async () => {
  const mock = createMockProvider({ redis, prefix: prefix() });
  const started = await mock.initiatePayout(payoutInput('payout-failed'));
  await mock.settlePayout(started.providerReference);
  assert.deepEqual(await mock.fetchPayoutStatus(started.providerReference), {
    status: 'failed',
    failureReason: 'other',
  });
});

test('payout-review stays in review', async () => {
  const mock = createMockProvider({ redis, prefix: prefix() });
  const started = await mock.initiatePayout(payoutInput('payout-review'));
  assert.equal(started.status, 'review');
  await mock.settlePayout(started.providerReference);
  assert.deepEqual(await mock.fetchPayoutStatus(started.providerReference), {
    status: 'review',
  });
});

test('payout-timeout creates the payout but raises an uncertain outcome', async () => {
  const mock = createMockProvider({ redis, prefix: prefix() });
  const input = payoutInput('payout-timeout');
  await assert.rejects(
    mock.initiatePayout(input),
    UncertainProviderOutcomeError,
  );
  // The money really is on its way: the same key finds the one payout it made.
  const replay = await mock.initiatePayout(input);
  assert.equal(replay.status, 'pending');
  await mock.settlePayout(replay.providerReference);
  assert.equal(
    (await mock.fetchPayoutStatus(replay.providerReference)).status,
    'paid',
  );
});

test('the pretend provider offers the rest of the payout port', async () => {
  const mock = createMockProvider({ redis, prefix: prefix() });
  assert.equal(mock.capabilities.payouts, true);
  assert.deepEqual(await mock.payoutCapability('mock_account'), {
    status: 'active',
    requirementsDue: [],
  });
  assert.ok((await mock.listBanks('NG')).length > 0);
  assert.ok(
    await mock.resolveBankAccount({
      accountNumber: '0123456789',
      bankCode: '058',
    }),
  );
  // A number ending 0000 does not resolve, so the name-typing path can be tested.
  assert.equal(
    await mock.resolveBankAccount({
      accountNumber: '0123450000',
      bankCode: '058',
    }),
    null,
  );
  const destination = await mock.addPayoutDestination('mock_account', {
    accountNumber: '0123456789',
    accountName: 'ADA OKAFOR',
    bankCode: '058',
  });
  assert.equal(destination.usable, true);
  assert.equal(destination.status, 'usable');
  assert.doesNotMatch(destination.destinationRef, /0123456789/);
  assert.ok(
    (await mock.payoutBalance('mock_account', 'NGN')).availableMinor > 0n,
  );
  assert.ok((await mock.platformBalance('NGN')).availableMinor > 0n);
  assert.deepEqual(await mock.quotePayoutFee('mock_account', 150000n, 'NGN'), {
    feeMinor: 5000n,
    exact: false,
  });
  const fee = {
    accountRef: 'mock_account',
    feeMinor: 5000n,
    currency: 'NGN',
    idempotencyKey: 'payout-fee.p1',
  };
  assert.deepEqual(
    await mock.coverPayoutFee(fee),
    await mock.coverPayoutFee(fee),
  );
  await mock.setManualPayouts('mock_account');
  await mock.requestPayoutCapabilities('mock_account');
});

test('the pretend provider finds a payout by reference, even after a timeout', async () => {
  const mock = createMockProvider({ redis, prefix: prefix() });
  const input = payoutInput('payout-timeout');
  assert.equal(
    await mock.findPayoutByReference(input.accountRef, input.payoutId),
    null,
  );
  await assert.rejects(
    mock.initiatePayout(input),
    UncertainProviderOutcomeError,
  );
  const found = await mock.findPayoutByReference(
    input.accountRef,
    input.payoutId,
  );
  assert.equal(found.status, 'pending');
  await mock.settlePayout(found.providerReference);
  assert.deepEqual(
    await mock.findPayoutByReference(input.accountRef, input.payoutId),
    { providerReference: found.providerReference, status: 'paid' },
  );

  const failed = payoutInput('payout-failed');
  const started = await mock.initiatePayout(failed);
  await mock.settlePayout(started.providerReference);
  assert.deepEqual(
    await mock.findPayoutByReference(failed.accountRef, failed.payoutId),
    {
      providerReference: started.providerReference,
      status: 'failed',
      failureReason: 'other',
    },
  );
});
