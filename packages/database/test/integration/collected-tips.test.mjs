import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  reconcileAttempts,
  tipStatusView,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// The provider took the money but has not said who paid its processing fee, so TipMe cannot
// book the tip yet. The receipt says the payment went through, rather than "not confirmed".

async function startedTip(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const quote = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 500000n,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await markAttemptInitiated(database.db, {
    attemptId,
    provider: 'bachs',
    providerReference: 'acct_ada:chk_collected',
  });
  const check = (answer) =>
    reconcileAttempts({
      db: database.db,
      provider: { verifyTransaction: async () => answer },
      now: new Date(),
      minAgeMs: 0,
      attemptId,
    });
  const state = async () =>
    (await tipStatusView(database.db, tipId, new Date())).state;
  return { check, state };
}

const pending = {
  status: 'pending',
  amountMinor: 500000n,
  currency: 'NGN',
  feeMinor: 7500n,
  feePaidBy: 'unknown',
};

test('money taken but fee details not final: the receipt says collected', async (t) => {
  const { check, state } = await startedTip(t);
  assert.equal(await state(), 'waiting');
  await check({ ...pending, collected: true });
  assert.equal(await state(), 'collected');
  // It stays collected while the details are still missing.
  await check({ ...pending, collected: true });
  assert.equal(await state(), 'collected');
});

test('a plain pending answer is not called collected', async (t) => {
  const { check, state } = await startedTip(t);
  await check({ ...pending, feeMinor: 0n });
  assert.equal(await state(), 'waiting');
});

test('once the provider confirms, the receipt says paid', async (t) => {
  const { check, state } = await startedTip(t);
  await check({ ...pending, collected: true });
  await check({ ...pending, status: 'succeeded', feePaidBy: 'platform' });
  assert.equal(await state(), 'paid');
});
