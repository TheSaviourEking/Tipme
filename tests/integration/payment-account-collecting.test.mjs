import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import {
  mailSealing,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { TOBI } from '../../packages/database/test/integration/helpers.mjs';

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
