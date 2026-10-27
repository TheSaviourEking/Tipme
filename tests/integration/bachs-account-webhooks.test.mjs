import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import {
  beginPaymentAccountCreation,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';

// An account or capability event only triggers a fresh read from Bachs; what Bachs then
// reports decides readiness, so a later restriction stops new checkouts.

async function activeAccount(t) {
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
  return database;
}

const restricted = {
  async getRecipientAccount(reference) {
    return {
      accountReference: reference,
      active: true,
      ngnCardCollectionStatus: 'restricted',
      bankTransferStatus: 'active',
      feeCollector: 'platform',
      requirementsDue: ['individual.id_number'],
    };
  },
};

const event = (eventId, accountReference = 'acct_ada123') => ({
  kind: 'account',
  eventId,
  eventType: 'capability.updated',
  accountReference,
});

test('a capability event re-reads the account and a restriction stops checkouts, even when repeated', async (t) => {
  const database = await activeAccount(t);
  const webhooks = new WebhookService({ db: database.db });
  assert.equal(
    await webhooks.applyBachs(event('evt_cap_1'), restricted),
    'account_refreshed',
  );
  assert.equal(
    await webhooks.applyBachs(event('evt_cap_1'), restricted),
    'account_refreshed',
  );
  const account = (
    await database.pool.query(
      `SELECT status, charges_enabled, requirements_due FROM payment_accounts WHERE profile_id = $1`,
      [ADA],
    )
  ).rows[0];
  assert.deepEqual(account, {
    status: 'RESTRICTED',
    charges_enabled: false,
    requirements_due: ['individual.id_number'],
  });
});

test('an event for an account TipMe does not know is kept as unmatched and reads nothing', async (t) => {
  const database = await activeAccount(t);
  let reads = 0;
  const webhooks = new WebhookService({ db: database.db });
  assert.equal(
    await webhooks.applyBachs(event('evt_cap_2', 'acct_stranger'), {
      async getRecipientAccount() {
        reads += 1;
        throw new Error('must not be called');
      },
    }),
    'unmatched',
  );
  assert.equal(reads, 0);
});
