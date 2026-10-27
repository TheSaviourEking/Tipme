import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CheckoutService } from '../../apps/api/dist/checkout/checkout.service.js';
import {
  beginPaymentAccountCreation,
  createQuote,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  BachsApiError,
  UncertainProviderOutcomeError,
} from '../../packages/payments/dist/index.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';

// Starting a Bachs checkout: a definite refusal fails the tip so the supporter can try again;
// anything that may have reached Bachs stays UNKNOWN and is never retried.

const logger = { info() {}, warn() {}, error() {} };

async function serviceThatFailsWith(t, error) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  await beginPaymentAccountCreation(database.db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(database.db, {
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
  const bachs = {
    name: 'bachs',
    async initializePayment() {
      throw error;
    },
  };
  const service = new CheckoutService(
    {
      WEB_ORIGIN: 'http://127.0.0.1:3000',
      STATUS_TOKEN_SECRET: 'test-only-status-token-secret-32-characters',
    },
    { db: database.db },
    { name: 'bachs' },
    null,
    bachs,
    logger,
  );
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const statuses = async () =>
    (
      await database.pool.query(
        `SELECT a.status AS attempt, t.status AS tip
           FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id`,
      )
    ).rows[0];
  return { service, quoteId, statuses };
}

test('a definite Bachs refusal fails the tip and says nothing was charged', async (t) => {
  const { service, quoteId, statuses } = await serviceThatFailsWith(
    t,
    new BachsApiError(422, 'CAPABILITY_INACTIVE'),
  );
  const key = randomUUID();
  await assert.rejects(service.createIntent({ quoteId }, key), {
    code: 'PAYMENT_START_REJECTED',
  });
  assert.deepEqual(await statuses(), {
    attempt: 'VERIFIED_FAILED',
    tip: 'FAILED',
  });
  // The same draft again: refused as unpayable, never a second provider write.
  await assert.rejects(service.createIntent({ quoteId }, key), {
    code: 'TIP_NOT_PAYABLE',
  });
});

for (const [label, error] of [
  ['a timeout', new UncertainProviderOutcomeError('a', 'no response')],
  ['a 503', new UncertainProviderOutcomeError('a', 'Bachs returned HTTP 503')],
]) {
  test(`${label} leaves the start UNKNOWN for reconciliation`, async (t) => {
    const { service, quoteId, statuses } = await serviceThatFailsWith(
      t,
      error,
    );
    await assert.rejects(service.createIntent({ quoteId }, randomUUID()), {
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
    assert.deepEqual(await statuses(), {
      attempt: 'UNKNOWN',
      tip: 'AWAITING_PAYMENT',
    });
  });
}
