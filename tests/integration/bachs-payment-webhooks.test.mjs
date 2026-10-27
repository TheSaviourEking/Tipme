import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
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

// A Bachs payment webhook is a trigger: TipMe reads the payment back from Bachs at once, with
// the same checks as the worker, so the supporter's receipt turns paid within seconds.

const REFERENCE = 'acct_ada123:chk_paid';

async function startedTip(t) {
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
  const { attemptId } = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await markAttemptInitiated(db, {
    attemptId,
    provider: 'bachs',
    providerReference: REFERENCE,
  });
  const event = {
    kind: 'payment',
    eventId: `evt_${randomUUID()}`,
    eventType: 'collection.succeeded',
    providerReference: REFERENCE,
    operationReference: attemptId,
    accountReference: 'acct_ada123',
    status: 'pending',
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
    feePaidBy: 'unknown',
  };
  const tipStatus = async () =>
    (
      await database.pool.query(
        `SELECT t.status FROM tips t JOIN payment_attempts a ON a.intent_id = t.intent_id WHERE a.id = $1`,
        [attemptId],
      )
    ).rows[0].status;
  return { db, event, tipStatus };
}

test('a Bachs payment webhook confirms the tip at once, against the quoted share', async (t) => {
  const { db, event, tipStatus } = await startedTip(t);
  const expectations = [];
  const bachs = {
    async verifyTransaction(reference, expectation) {
      assert.equal(reference, REFERENCE);
      expectations.push(expectation);
      return expectation?.platformFeeMinor === 10000n
        ? {
            status: 'succeeded',
            amountMinor: 100000n,
            currency: 'NGN',
            feeMinor: 1500n,
          }
        : {
            status: 'pending',
            amountMinor: 100000n,
            currency: 'NGN',
            feeMinor: 0n,
          };
    },
  };
  await new WebhookService({ db }).applyBachs(event, bachs);
  assert.deepEqual(expectations, [{ platformFeeMinor: 10000n }]);
  assert.equal(await tipStatus(), 'SUCCEEDED');
});

test('when the read fails the tip stays pending for the worker, and the webhook still succeeds', async (t) => {
  const { db, event, tipStatus } = await startedTip(t);
  const outcome = await new WebhookService({ db }).applyBachs(event, {
    async verifyTransaction() {
      throw new Error('Bachs is unavailable');
    },
  });
  assert.equal(typeof outcome, 'string');
  assert.equal(await tipStatus(), 'PENDING_VERIFICATION');
});
