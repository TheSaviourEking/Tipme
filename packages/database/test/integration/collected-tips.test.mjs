import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  autoResolveIssues,
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
  const issues = async () =>
    (
      await database.pool.query(
        `SELECT kind, severity, subject->>'tipId' AS "tipId", subject->>'attemptId' AS "attemptId"
           FROM issues WHERE kind <> 'stuck_tip' AND status = 'open'`,
      )
    ).rows;
  const resolve = () => autoResolveIssues(database.db, new Date());
  return { check, state, issues, resolve, tipId, attemptId };
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

test('a tip the provider settled in another currency opens one money issue', async (t) => {
  const { check, state, issues, tipId, attemptId } = await startedTip(t);
  const settledInUsd = {
    ...pending,
    collected: true,
    settlementCurrency: 'USD',
  };
  await check(settledInUsd);
  await check(settledInUsd);
  assert.equal(await state(), 'collected');
  assert.deepEqual(await issues(), [
    {
      kind: 'payment_settlement_currency',
      severity: 'money',
      tipId,
      attemptId,
    },
  ]);
});

test('a collected tip settled in its own currency opens no issue', async (t) => {
  const { check, issues } = await startedTip(t);
  await check({ ...pending, collected: true });
  assert.deepEqual(await issues(), []);
});

test('the settlement issue closes itself once the tip is confirmed', async (t) => {
  const { check, issues, resolve } = await startedTip(t);
  await check({ ...pending, collected: true, settlementCurrency: 'USD' });
  await resolve();
  assert.equal((await issues()).length, 1, 'still open while unconfirmed');
  await check({ ...pending, status: 'succeeded', feePaidBy: 'platform' });
  await resolve();
  assert.deepEqual(await issues(), []);
});
