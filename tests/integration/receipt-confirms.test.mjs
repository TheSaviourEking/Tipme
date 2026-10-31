import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StatusController } from '../../apps/api/dist/checkout/status.controller.js';
import { createStatusToken } from '../../apps/api/dist/checkout/status-token.js';
import {
  beginPaymentAccountCreation,
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';

// A supporter back from Bachs' checkout watches the receipt. TipMe reads the payment from Bachs
// then, rather than waiting for a webhook (which may never come) or the worker's next round.

const SECRET = 'receipt-status-token-secret-32-characters';
const REFERENCE = 'acct_ada123:chk_paid';
const response = { setHeader() {} };

async function startedTip(t, provider = 'bachs') {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const { db } = database;
  await beginPaymentAccountCreation(db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_ada123',
    status: 'ACTIVE',
    chargesEnabled: true,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });
  const quote = await createQuote(db, {
    handle: 'ada',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await markAttemptInitiated(db, {
    attemptId,
    provider,
    providerReference: provider === 'bachs' ? REFERENCE : `mock_pay_${tipId}`,
  });
  return { db, tipId };
}

const paid = {
  status: 'succeeded',
  amountMinor: 100000n,
  currency: 'NGN',
  feeMinor: 1500n,
};

function receipt(db, tipId, bachs) {
  const controller = new StatusController(
    { STATUS_TOKEN_SECRET: SECRET },
    { db },
    bachs,
  );
  return () =>
    controller
      .status(tipId, `Bearer ${createStatusToken(SECRET, tipId)}`, response)
      .then((result) => result.data.state);
}

test('the receipt asks Bachs at once, so a paid tip shows paid without a webhook', async (t) => {
  const { db, tipId } = await startedTip(t);
  const asked = [];
  const status = receipt(db, tipId, {
    async verifyTransaction(reference, expectation) {
      asked.push(reference);
      assert.deepEqual(expectation, { platformFeeMinor: 10000n });
      return paid;
    },
  });
  assert.equal(await status(), 'paid');
  assert.deepEqual(asked, [REFERENCE]);
});

test('a receipt polled every second asks Bachs at most once every few seconds', async (t) => {
  const { db, tipId } = await startedTip(t);
  let asked = 0;
  const status = receipt(db, tipId, {
    async verifyTransaction() {
      asked += 1;
      return { ...paid, status: 'pending', feeMinor: 0n };
    },
  });
  // Two tabs at once, then again straight away: one question to Bachs.
  await Promise.all([status(), status()]);
  assert.equal(await status(), 'waiting');
  assert.equal(asked, 1);
});

test('when Bachs cannot be reached the receipt still answers, and stays waiting', async (t) => {
  const { db, tipId } = await startedTip(t);
  const status = receipt(db, tipId, {
    async verifyTransaction() {
      throw Object.assign(new Error('no response'), {
        name: 'BachsTransportError',
      });
    },
  });
  assert.equal(await status(), 'waiting');
});

test('pretend payments and copies without Bachs never ask Bachs', async (t) => {
  const { db, tipId } = await startedTip(t, 'mock');
  let asked = 0;
  const bachs = {
    async verifyTransaction() {
      asked += 1;
      return paid;
    },
  };
  assert.equal(await receipt(db, tipId, bachs)(), 'waiting');
  assert.equal(asked, 0);
  const bachsTip = await startedTip(t);
  assert.equal(await receipt(bachsTip.db, bachsTip.tipId, null)(), 'waiting');
});
