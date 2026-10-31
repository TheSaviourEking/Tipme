import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import {
  beginPaymentAccountCreation,
  seedDemoProfiles,
  updatePaymentAccountStatus,
  mailSealing,
} from '../../packages/database/dist/index.js';

const sealing = mailSealing(Buffer.alloc(32, 7));
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { TOBI } from '../../packages/database/test/integration/helpers.mjs';

// A new Bachs account holds only USD, and Bachs converts a naira tip to an account without NGN,
// after which it never says who paid the fee. Setting up payments makes the account hold NGN.

const TOBI_USER = '00000000-0000-7000-8000-000000007b11';
const bachsConfig = {
  PAYMENT_PROVIDER: 'bachs-sandbox',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
};

async function existingAccount(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  await database.pool.query(
    `UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`,
    ['sandbox-recipient@example.test', TOBI_USER],
  );
  await beginPaymentAccountCreation(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(database.db, {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_tobi123',
    status: 'ONBOARDING',
    chargesEnabled: false,
    payoutsEnabled: false,
    feeCollector: 'unknown',
    requirementsDue: [],
  });
  return database;
}

const remote = (reference, holdsLocalCurrency) => ({
  accountReference: reference,
  active: true,
  ngnCardCollectionStatus: 'active',
  bankTransferStatus: 'active',
  feeCollector: 'platform',
  requirementsDue: [],
  holdsLocalCurrency,
});

function onboard(db, provider, warnings = []) {
  return new PaymentAccountsController(
    bachsConfig,
    { db },
    provider,
    { info() {}, warn: (entry) => warnings.push(entry), error() {} },
    { revalidate() {} },
    sealing,
  ).onboard({ userId: TOBI_USER }, { country: 'NG', entityType: 'individual' });
}

test('setting up payments makes an account without naira hold it', async (t) => {
  const database = await existingAccount(t);
  const held = [];
  const result = await onboard(database.db, {
    getRecipientAccount: async (reference) => remote(reference, false),
    holdLocalCurrency: async (reference) => {
      held.push(reference);
      return remote(reference, true);
    },
  });
  assert.equal(result.data.status, 'ACTIVE');
  assert.deepEqual(held, ['acct_tobi123']);
});

test('an account already holding naira is not changed', async (t) => {
  const database = await existingAccount(t);
  const held = [];
  await onboard(database.db, {
    getRecipientAccount: async (reference) => remote(reference, true),
    holdLocalCurrency: async (reference) => {
      held.push(reference);
      return remote(reference, true);
    },
  });
  assert.deepEqual(held, []);
});

test('if Bachs refuses the currency change, setup still finishes and it is logged', async (t) => {
  const database = await existingAccount(t);
  const warnings = [];
  const result = await onboard(
    database.db,
    {
      getRecipientAccount: async (reference) => remote(reference, false),
      holdLocalCurrency: async () => {
        throw new Error('Bachs is down');
      },
    },
    warnings,
  );
  assert.equal(result.data.status, 'ACTIVE');
  assert.deepEqual(
    warnings.map((w) => w.event),
    ['payment_account.local_currency_failed'],
  );
});
