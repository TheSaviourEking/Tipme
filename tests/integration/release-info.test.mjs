import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ReleaseInfoController } from '../../apps/api/dist/release/release.controller.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { setSwitch } from './helpers.mjs';

let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
});
after(() => database.close());

const info = async (config = {}) =>
  (
    await new ReleaseInfoController(
      {
        RELEASE_KIND: 'test',
        DEPLOYMENT_MODE: 'preview',
        NODE_ENV: 'production',
        ...config,
      },
      { db: database.db },
    ).info()
  ).data;

test('a copy names its payment provider, so the release check knows which tip it can complete', async () => {
  assert.equal(
    (await info({ PAYMENT_PROVIDER: 'mock' })).paymentProvider,
    'mock',
  );
  assert.equal(
    (await info({ PAYMENT_PROVIDER: 'bachs-sandbox' })).paymentProvider,
    'bachs-sandbox',
  );
});

// Feature switches (owner, 14 Nov 2026): `business` is the stored switch, set in admin.
test('a copy says whether TipMe for businesses is on, so the web invites people to create one', async () => {
  await setSwitch(database.pool, 'business', true);
  assert.equal((await info()).business, true);
  await setSwitch(database.pool, 'business', false);
  assert.equal((await info()).business, false);
});
