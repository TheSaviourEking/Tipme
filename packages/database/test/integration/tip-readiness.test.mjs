import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginPaymentAccountCreation,
  DEMO_PROFILES,
  publicProfile,
  updatePaymentAccountStatus,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [, TOBI] = DEMO_PROFILES;
const bachs = { provider: 'bachs', environment: 'sandbox' };

test('the public page says whether it can take a tip right now, by the rule checkout uses', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;

  // Payments that need no account of the owner's own (the mock): always ready.
  assert.equal((await publicProfile(db, 'tobi')).acceptingTips, true);

  // A provider that needs the owner's own account: not until it is ready.
  const page = (options) =>
    publicProfile(db, 'tobi', { requiredAccount: options });
  assert.equal((await page(bachs)).acceptingTips, false);

  await beginPaymentAccountCreation(db, { profileId: TOBI.id, ...bachs });
  const status = (overrides) =>
    updatePaymentAccountStatus(db, {
      profileId: TOBI.id,
      ...bachs,
      providerAccountReference: 'acct_tobi',
      status: 'ACTIVE',
      chargesEnabled: true,
      payoutsEnabled: false,
      feeCollector: 'platform',
      requirementsDue: [],
      ...overrides,
    });
  await status({ status: 'ONBOARDING', chargesEnabled: false });
  assert.equal((await page(bachs)).acceptingTips, false);
  // Ready on paper but the fee would be charged to the owner: checkout refuses it, so does the page.
  await status({ feeCollector: 'connected_account' });
  assert.equal((await page(bachs)).acceptingTips, false);
  await status({});
  assert.equal((await page(bachs)).acceptingTips, true);
});
