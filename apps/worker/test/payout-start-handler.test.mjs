import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { handlePayoutStart } from '../dist/handlers/payout-start.js';
import {
  parkedPayoutProviders,
  workerPaymentProviders,
  workerProviderFor,
} from '../dist/job-worker.js';

test('a payload without a payout id is not retried and reaches no provider', () => {
  for (const data of [null, {}, { payoutId: 'not-a-uuid' }]) {
    assert.throws(
      () =>
        handlePayoutStart(data, {
          db: {},
          provider: () => {
            throw new Error('no provider may be asked');
          },
        }),
      (error) =>
        error instanceof UnrecoverableError &&
        error.message === 'invalid_payload',
    );
  }
});

// Per-provider balances (Task 4): a payout starts only through the provider recorded on it.
const PAYOUT_ID = '7d1f3a52-5a43-4c1e-9a55-1b2c3d4e5f60';

/** No database here: a stand-in that answers each query in turn and notes every write. */
function scriptedDb(results) {
  const queries = [];
  const query = (kind) => {
    const chain = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'then') {
            queries.push(kind);
            const next = results.shift();
            return (resolve, reject) =>
              (next instanceof Error
                ? Promise.reject(next)
                : Promise.resolve(next)
              ).then(resolve, reject);
          }
          return () => chain;
        },
      },
    );
    return chain;
  };
  const db = {
    select: () => query('select'),
    update: () => query('update'),
    insert: () => query('insert'),
    delete: () => query('delete'),
    execute: async () => ({ rows: [] }),
    transaction: async (fn) => fn(db),
  };
  return { db, queries };
}

const requestedPayout = (provider) => ({
  id: PAYOUT_ID,
  profileId: '0b4a8f3e-1d2c-4b5a-9e8f-7a6b5c4d3e2f',
  businessId: null,
  provider,
  status: 'REQUESTED',
  providerReference: null,
  startUncertainAt: null,
  accountReference: null,
  destinationId: null,
  currency: 'NGN',
  amountMinor: 100000n,
  feeMinor: 0n,
  feePayer: 'tipme',
  createdAt: new Date(),
});

const fakeRedis = {};
const workerConfig = (withdrawOnly) => ({
  PAYMENT_PROVIDER: 'mock',
  PAYMENT_WITHDRAW_ONLY_PROVIDERS: withdrawOnly,
  QUEUE_PREFIX: 'tipme-test',
});

/** Every adapter's initiatePayout replaced with a recorder. */
function spyStarts(providers) {
  const started = [];
  for (const [name, adapter] of providers.byRecordedName)
    adapter.initiatePayout = async (input) => {
      started.push({ name, payoutId: input.payoutId });
      throw new Error('stop after the call: what matters is who was asked');
    };
  return started;
}

test('a payout at a provider no longer configured is never started through another', async () => {
  const providers = workerPaymentProviders(workerConfig([]), fakeRedis);
  assert.deepEqual([...providers.byRecordedName.keys()], ['mock']);
  const started = spyStarts(providers);
  const resolverErrors = [];
  const providerFor = workerProviderFor(providers);
  const { db, queries } = scriptedDb([[requestedPayout('mock_alt')]]);
  await assert.rejects(
    handlePayoutStart(
      { payoutId: PAYOUT_ID },
      {
        db,
        provider: (name) => {
          try {
            return providerFor(name);
          } catch (error) {
            resolverErrors.push(error.message);
            throw error;
          }
        },
      },
    ),
  );
  assert.deepEqual(resolverErrors, ['Unsupported persisted payment provider']);
  assert.deepEqual(started, [], 'no provider was asked to pay');
  // Only the read of the row: no mark, no step, no outcome. It stays REQUESTED.
  assert.deepEqual(queries, ['select']);
});

test('payouts at mock_alt start through mock_alt', async () => {
  const providers = workerPaymentProviders(
    workerConfig(['mock_alt']),
    fakeRedis,
  );
  assert.deepEqual([...providers.byRecordedName.keys()].sort(), [
    'mock',
    'mock_alt',
  ]);
  assert.equal(providers.byRecordedName.get('mock_alt').name, 'mock_alt');
  assert.deepEqual(providers.withdrawalRoles, {
    active: 'mock',
    withdrawOnly: ['mock_alt'],
  });
  const started = spyStarts(providers);
  const { db } = scriptedDb([
    [requestedPayout('mock_alt')], // the row, locked
    [], // no hold
    [{ paused: false, changedAt: null }], // withdrawals on
    undefined, // the start mark
    [{ id: PAYOUT_ID }], // the step
  ]);
  const outcome = await handlePayoutStart(
    { payoutId: PAYOUT_ID },
    { db, provider: workerProviderFor(providers) },
  );
  assert.equal(outcome, 'uncertain');
  assert.deepEqual(started, [{ name: 'mock_alt', payoutId: PAYOUT_ID }]);
});

test('mock_alt keeps its own keys beside mock, on the worker queue prefix', async () => {
  const keys = [];
  const redis = {
    hget: async (key) => {
      keys.push(key);
      return null;
    },
  };
  const providers = workerPaymentProviders(workerConfig(['mock_alt']), redis);
  await providers.byRecordedName.get('mock_alt').fetchPayoutStatus('r1');
  await providers.byRecordedName.get('mock').fetchPayoutStatus('r1');
  assert.equal(keys.length, 2);
  assert.match(keys[0], /tipme-test:mock_alt/);
  assert.doesNotMatch(keys[1], /mock_alt/);
});

test('parked Bachs events are always swept, even on a copy with no Bachs adapter', () => {
  const providers = workerPaymentProviders(workerConfig([]), fakeRedis);
  assert.equal(providers.byRecordedName.has('bachs'), false);
  // Swept for the read-free checks (unexpected, conflicts, the age cap); a read fails as an error.
  assert.deepEqual(parkedPayoutProviders(providers), ['bachs']);
  assert.throws(
    () => workerProviderFor(providers)('bachs'),
    /Unsupported persisted payment provider/,
  );
  const withAlt = workerPaymentProviders(workerConfig(['mock_alt']), fakeRedis);
  assert.deepEqual(parkedPayoutProviders(withAlt), ['bachs']);
});
