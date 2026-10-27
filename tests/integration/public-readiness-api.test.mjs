import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import { PublicProfileController } from '../../apps/api/dist/profiles/public-profile.controller.js';
import {
  beginPaymentAccountCreation,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { TOBI } from '../../packages/database/test/integration/helpers.mjs';

const TOBI_USER = '00000000-0000-7000-8000-000000007b11';
const logger = { info() {}, warn() {}, error() {} };
const bachsConfig = {
  PAYMENT_PROVIDER: 'bachs-sandbox',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
};

async function databaseFor(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  return database;
}

const publicPage = (db, config) =>
  new PublicProfileController({ db }, config).profile('tobi', {
    status() {
      return this;
    },
    setHeader() {},
  });

test('the public page tells supporters whether the owner can take a tip yet', async (t) => {
  const database = await databaseFor(t);
  // Test payments need no account of the owner's own.
  assert.equal(
    (await publicPage(database.db, { PAYMENT_PROVIDER: 'mock' })).data
      .acceptingTips,
    true,
  );
  // Bachs: checkout would refuse the tip, so the page says so first.
  assert.equal(
    (await publicPage(database.db, bachsConfig)).data.acceptingTips,
    false,
  );
});

test('finishing payment setup refreshes the cached public page at once', async (t) => {
  const database = await databaseFor(t);
  // Payment setup needs a confirmed email.
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
  const refreshed = [];
  const accounts = new PaymentAccountsController(
    bachsConfig,
    { db: database.db },
    {
      async getRecipientAccount(reference) {
        return {
          accountReference: reference,
          active: true,
          ngnCardCollectionStatus: 'active',
          bankTransferStatus: 'active',
          feeCollector: 'platform',
          requirementsDue: [],
        };
      },
    },
    logger,
    { revalidate: (handle) => refreshed.push(handle) },
  );
  const result = await accounts.onboard(
    { userId: TOBI_USER },
    { country: 'NG', entityType: 'individual' },
  );
  assert.equal(result.data.status, 'ACTIVE');
  assert.deepEqual(refreshed, ['tobi']);
  assert.equal(
    (await publicPage(database.db, bachsConfig)).data.acceptingTips,
    true,
  );
});
