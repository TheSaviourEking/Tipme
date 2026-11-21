import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import {
  beginPaymentAccountCreation,
  mailSealing,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { TOBI } from '../../packages/database/test/integration/helpers.mjs';
import { setSwitch } from './helpers.mjs';

/*
 * You collect (plan Task 14, re-review 1 point 3): GET /v1/me/payment-account says whether the
 * recipient is on You collect (`collecting`), the same way the balance decides it, so the dashboard
 * shell needs no read of its own to leave out payment set-up notices. Undecided (null) is direct.
 */

const TOBI_USER = '00000000-0000-7000-8000-000000007b11';
const sealing = mailSealing(Buffer.alloc(32, 7));
const logger = { info() {}, warn() {}, error() {} };

const controller = (db, config, provider) =>
  new PaymentAccountsController(
    { WEB_ORIGIN: 'http://127.0.0.1:3000', ...config },
    { db },
    provider,
    logger,
    { revalidate() {} },
    sealing,
  );

test('the payment account read says whether the recipient is on You collect, with or without a partner account', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  await setSwitch(database.pool, 'you_collect', false);
  const views = [
    // A partner that needs an account of the recipient's own.
    controller(
      database.db,
      { PAYMENT_PROVIDER: 'bachs-sandbox' },
      { environment: 'sandbox' },
    ),
    // Test payments: no account to set up.
    controller(database.db, { PAYMENT_PROVIDER: 'mock' }, null),
  ];
  const collecting = async () =>
    Promise.all(
      views.map(
        async (view) =>
          (await view.status({ userId: TOBI_USER })).data.collecting,
      ),
    );
  const mode = (value) =>
    database.pool.query(
      `UPDATE profiles SET collection_mode = $1 WHERE id = $2`,
      [value, TOBI],
    );

  // Undecided reads as direct, as does direct.
  await mode(null);
  assert.deepEqual(await collecting(), [false, false]);
  await mode('direct');
  assert.deepEqual(await collecting(), [false, false]);
  // On You collect: true, so the shell leaves out payment set-up notices.
  await mode('collect');
  assert.deepEqual(await collecting(), [true, true]);
});

test('with the switch on, an undecided recipient whose first quote would go to collect reads as collecting, and nothing is written', async (t) => {
  const database = await openTestDatabase();
  t.after(async () => {
    await setSwitch(database.pool, 'you_collect', false);
    await database.close();
  });
  await database.reset();
  await seedDemoProfiles(database.db);
  const partner = controller(
    database.db,
    { PAYMENT_PROVIDER: 'bachs-sandbox' },
    { environment: 'sandbox' },
  );
  const pretend = controller(database.db, { PAYMENT_PROVIDER: 'mock' }, null);
  const read = async () => [
    (await partner.status({ userId: TOBI_USER })).data.collecting,
    (await pretend.status({ userId: TOBI_USER })).data.collecting,
  ];
  const stored = async () =>
    (
      await database.pool.query(
        `SELECT collection_mode FROM profiles WHERE id = $1`,
        [TOBI],
      )
    ).rows[0].collection_mode;
  await database.pool.query(
    `UPDATE profiles SET collection_mode = NULL WHERE id = $1`,
    [TOBI],
  );

  // Switch off: undecided is direct, as today.
  await setSwitch(database.pool, 'you_collect', false);
  assert.deepEqual(await read(), [false, false]);
  // Switch on, no payment account: the next quote would put them on collect (P22), so they read as
  // collecting now. The preview writes nothing: the row stays undecided.
  await setSwitch(database.pool, 'you_collect', true);
  assert.deepEqual(await read(), [true, true]);
  assert.equal(await stored(), null);

  // An active account of their own on this partner: the next quote would keep them direct.
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
    providerAccountReference: 'acct_tobi_active',
    status: 'ACTIVE',
    chargesEnabled: true,
    payoutsEnabled: true,
    feeCollector: 'platform',
    requirementsDue: [],
  });
  // Test payments route through no account of theirs, so that copy would still put them on collect.
  assert.deepEqual(await read(), [false, true]);
  assert.equal(await stored(), null);
});
