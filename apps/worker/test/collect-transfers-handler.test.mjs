import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectTransferProviders,
  handleCollectTransfers,
  handleDisputeSteps,
} from '../dist/handlers/collect-transfers.js';

// You collect (plan Task 8): the 2-minute sweep releases waiting shares, then runs the transfer
// machine for each provider that can make collect transfers. Database calls are replaced here; the
// machine itself is proven against Postgres in tests/integration/collect-transfers.test.mjs.

const NOW = new Date('2026-11-20T10:00:00.000Z');
const db = Symbol('db');
const capable = (name) => ({
  name,
  async sendCollectTransfer() {
    throw new Error('not called here');
  },
  async listAccountTransfers() {
    return [];
  },
  async payoutCapability() {
    return { status: 'active', requirementsDue: [] };
  },
});
const zero = { sent: 0, paid: 0, retried: 0, review: 0 };

test('only providers that can send, list and read capability are used, called on themselves', async () => {
  const calls = [];
  const bachs = {
    ...capable('bachs-sandbox'),
    async sendCollectTransfer(input) {
      calls.push(['send', this === bachs, input.idempotencyKey]);
      return { transferRef: 'tr_1', status: 'paid' };
    },
  };
  const old = { name: 'bachs-live', async payoutCapability() {} };
  const providers = collectTransferProviders([bachs, null, undefined, old]);
  assert.deepEqual(
    providers.map((provider) => provider.name),
    ['bachs-sandbox'],
  );
  // Detached, as the machine may call it: still the adapter's own method.
  const { sendCollectTransfer } = providers[0];
  await sendCollectTransfer({ idempotencyKey: 'tipme-collect-x' });
  assert.deepEqual(calls, [['send', true, 'tipme-collect-x']]);
});

test('waiting shares are released first, then each provider runs, and the totals add up', async () => {
  const order = [];
  const outcome = await handleCollectTransfers({
    db,
    providers: [capable('mock'), capable('bachs-sandbox')],
    now: NOW,
    log: () => order.push('log'),
    release: async (database, input) => {
      assert.equal(database, db);
      assert.deepEqual(input, { now: NOW });
      order.push('release');
      return 3;
    },
    run: async (database, input) => {
      assert.equal(database, db);
      assert.equal(input.now, NOW);
      order.push(`run ${input.provider.name}`);
      return input.provider.name === 'mock'
        ? { sent: 1, paid: 1, retried: 0, review: 0 }
        : { sent: 2, paid: 1, retried: 1, review: 1 };
    },
  });
  assert.deepEqual(order, ['release', 'run mock', 'run bachs-sandbox']);
  assert.deepEqual(outcome, {
    released: 3,
    sent: 3,
    paid: 2,
    retried: 1,
    review: 1,
    failed: 0,
  });
});

test("staff's pause or TipMe's debt stops every provider; TipMe's key stops only its own", async () => {
  for (const stopped of ['paused', 'in_debt']) {
    const ran = [];
    const outcome = await handleCollectTransfers({
      db,
      providers: [capable('mock'), capable('bachs-sandbox')],
      now: NOW,
      log() {},
      release: async () => 0,
      run: async (_db, input) => {
        ran.push(input.provider.name);
        return { ...zero, stopped };
      },
    });
    assert.deepEqual(ran, ['mock'], stopped);
    assert.equal(outcome.stopped, stopped);
  }
  const ran = [];
  const outcome = await handleCollectTransfers({
    db,
    providers: [capable('bachs-sandbox'), capable('mock')],
    now: NOW,
    log() {},
    release: async () => 0,
    run: async (_db, input) => {
      ran.push(input.provider.name);
      return input.provider.name === 'mock'
        ? zero
        : { ...zero, stopped: 'platform' };
    },
  });
  assert.deepEqual(ran, ['bachs-sandbox', 'mock']);
  assert.equal(outcome.stopped, 'platform');
});

test('a failure is logged by name and counted, never thrown, and never stops the next provider', async () => {
  const logged = [];
  const ran = [];
  const outcome = await handleCollectTransfers({
    db,
    providers: [capable('bachs-sandbox'), capable('mock')],
    now: NOW,
    log: (entry) => logged.push(entry),
    release: async () => {
      throw new TypeError('connection to acct_secret refused');
    },
    run: async (_db, input) => {
      ran.push(input.provider.name);
      if (input.provider.name === 'bachs-sandbox')
        throw new RangeError('acct_secret');
      return { ...zero, paid: 1 };
    },
  });
  assert.deepEqual(ran, ['bachs-sandbox', 'mock']);
  assert.equal(outcome.failed, 2);
  assert.equal(outcome.paid, 1);
  assert.deepEqual(logged, [
    { event: 'collect_transfers.release_failed', error: 'TypeError' },
    {
      event: 'collect_transfers.run_failed',
      provider: 'bachs-sandbox',
      error: 'RangeError',
    },
  ]);
  assert.ok(!JSON.stringify(logged).includes('acct_secret'));
});

test('a lost dispute’s transfer back is the adapter’s collectToPlatform, on itself, named for the dispute (Task 9)', async () => {
  const calls = [];
  const bachs = {
    ...capable('bachs-sandbox'),
    async collectToPlatform(input) {
      calls.push([this === bachs, input]);
      return { transferRef: 'tr_back', status: 'paid' };
    },
  };
  const [withBack, without] = collectTransferProviders([
    bachs,
    capable('mock'),
  ]);
  const { collectBack } = withBack;
  assert.deepEqual(
    await collectBack({
      accountRef: 'acct_x',
      amountMinor: 5n,
      currency: 'NGN',
      idempotencyKey: 'tipme-collect-back-x',
    }),
    { transferRef: 'tr_back', status: 'paid' },
  );
  assert.deepEqual(calls, [
    [
      true,
      {
        accountRef: 'acct_x',
        amountMinor: 5n,
        currency: 'NGN',
        idempotencyKey: 'tipme-collect-back-x',
        description: 'TipMe dispute',
      },
    ],
  ]);
  assert.equal(without.collectBack, undefined);
});

test('the dispute steps run on the sweep, and a failure is logged by name and never thrown (Task 9)', async () => {
  assert.deepEqual(
    await handleDisputeSteps({
      db,
      now: NOW,
      log: () => assert.fail('nothing to log'),
      steps: async (database, input) => {
        assert.equal(database, db);
        assert.deepEqual(input, { now: NOW });
        return { reminded: 1, advanced: 2, failed: 0 };
      },
    }),
    { reminded: 1, advanced: 2, failed: 0 },
  );
  const logged = [];
  class SecretError extends Error {
    name = 'OperationError';
  }
  assert.deepEqual(
    await handleDisputeSteps({
      db,
      now: NOW,
      log: (entry) => logged.push(entry),
      steps: async () => {
        throw new SecretError('acct_secret');
      },
    }),
    { reminded: 0, advanced: 0, failed: 1 },
  );
  assert.deepEqual(logged, [
    { event: 'collect_disputes.run_failed', error: 'OperationError' },
  ]);
});
