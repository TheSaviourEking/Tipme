import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BusinessPublicController } from '../../apps/api/dist/business/business-public.controller.js';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import { PublicProfileController } from '../../apps/api/dist/profiles/public-profile.controller.js';
import {
  beginPaymentAccountCreation,
  collectStatus,
  reconcileAttempts,
  seedDemoProfiles,
  updatePaymentAccountStatus,
  mailSealing,
} from '../../packages/database/dist/index.js';

const sealing = mailSealing(Buffer.alloc(32, 7));
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { TOBI } from '../../packages/database/test/integration/helpers.mjs';
import {
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { recordingProviders, services } from './collect-checkout-support.mjs';
import { setSwitch } from './helpers.mjs';

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
  const refreshed = [];
  const accounts = new PaymentAccountsController(
    bachsConfig,
    { db: database.db },
    {
      environment: 'sandbox',
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
    sealing,
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

test('a public page says whether its own tipping is open, from the same rule checkout uses', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const open = async (config) =>
    (await publicPage(database.db, config)).data.tippingOpen;
  const live = { PAYMENT_PROVIDER: 'bachs-live', WEB_ORIGIN: 'https://x.test' };
  // Off: closed for all, whatever the list says.
  assert.equal(
    await open({
      ...live,
      PAYMENTS_LIVE_ENABLED: false,
      LIVE_CHECKOUT_HANDLES: ['tobi'],
    }),
    false,
  );
  const on = { ...live, PAYMENTS_LIVE_ENABLED: true };
  assert.equal(await open({ ...on, LIVE_CHECKOUT_HANDLES: [] }), false);
  assert.equal(await open({ ...on, LIVE_CHECKOUT_HANDLES: ['ada'] }), false);
  assert.equal(await open({ ...on, LIVE_CHECKOUT_HANDLES: ['tobi'] }), true);
  assert.equal(await open({ ...on, LIVE_CHECKOUT_HANDLES: '*' }), true);
  // Test copies never close for this reason.
  assert.equal(await open({ PAYMENT_PROVIDER: 'mock' }), true);
});

/*
 * You collect (Task 14, re-review 3 R3-C1). On a copy using the partner (here bachs-sandbox, with
 * no network: the controllers are called directly, and checkout uses the recording stand-ins), a
 * recipient whose tips TipMe collects needs no partner account of their own. Their page must take
 * tips exactly when checkout can: the mode is the same read-only preview the quote fixes
 * (effectiveCollectionMode). A direct recipient keeps today's rule. The holding-cap pause is told
 * at the quote (PAGE_PAUSED), not on the page, the same on every provider.
 */

/** As databaseFor, turning You collect off again before the database closes. */
async function collectDatabaseFor(t) {
  const database = await openTestDatabase();
  t.after(async () => {
    await setSwitch(database.pool, 'you_collect', false);
    await database.close();
  });
  await database.reset();
  await seedDemoProfiles(database.db);
  return database;
}

const collectTipAt = (db) => services(db, recordingProviders()).bachs;

const modeOf = async (pool) =>
  (
    await pool.query(`SELECT collection_mode FROM profiles WHERE id = $1`, [
      TOBI,
    ])
  ).rows[0].collection_mode;

const setMode = (pool, value) =>
  pool.query(`UPDATE profiles SET collection_mode = $1 WHERE id = $2`, [
    value,
    TOBI,
  ]);

/** A supporter's tip to Tobi on the partner, as far as the checkout opening. */
async function tipTobi(db, amountMinor = '200000') {
  const checkout = collectTipAt(db);
  const quote = await checkout.quote({
    handle: 'tobi',
    amountMinor,
    currency: 'NGN',
  });
  const intent = await checkout.createIntent(
    { quoteId: quote.quoteId },
    randomUUID(),
  );
  return { quote, intent };
}

test('on the partner, a You collect recipient with no account of their own takes tips, as checkout does', async (t) => {
  const database = await collectDatabaseFor(t);
  await setSwitch(database.pool, 'you_collect', false);
  await setMode(database.pool, 'collect');
  // Stored collect: ready whatever the switch says (spec §12.5), and checkout agrees.
  assert.equal(
    (await publicPage(database.db, bachsConfig)).data.acceptingTips,
    true,
  );
  const { quote, intent } = await tipTobi(database.db);
  assert.equal(quote.collectedByTipMe, true);
  assert.match(intent.checkoutUrl, /^https:\/\/checkout\.bachs\.test\//);
});

test('on the partner, an undecided recipient the next quote would put on You collect takes tips only while the switch is on', async (t) => {
  const database = await collectDatabaseFor(t);
  assert.equal(await modeOf(database.pool), null);
  // Switch off: today's rule, no account of his own, no tips.
  await setSwitch(database.pool, 'you_collect', false);
  assert.equal(
    (await publicPage(database.db, bachsConfig)).data.acceptingTips,
    false,
  );
  await assert.rejects(tipTobi(database.db), {
    code: 'PAYMENT_ACCOUNT_REQUIRED',
  });
  // Switch on: the preview says collect, so the page takes tips. Reading it writes nothing.
  await setSwitch(database.pool, 'you_collect', true);
  assert.equal(
    (await publicPage(database.db, bachsConfig)).data.acceptingTips,
    true,
  );
  assert.equal(await modeOf(database.pool), null);
  // And checkout takes the tip: the quote fixes collect, the checkout opens on TipMe's account.
  const { quote, intent } = await tipTobi(database.db);
  assert.equal(quote.collectedByTipMe, true);
  assert.match(intent.checkoutUrl, /^https:\/\/checkout\.bachs\.test\//);
  assert.equal(await modeOf(database.pool), 'collect');
});

test('on the partner, a direct recipient keeps today’s rule, switch on or off', async (t) => {
  const database = await collectDatabaseFor(t);
  for (const on of [false, true]) {
    await setSwitch(database.pool, 'you_collect', on);
    // Decided direct, no account: not ready, and checkout refuses.
    await setMode(database.pool, 'direct');
    assert.equal(
      (await publicPage(database.db, bachsConfig)).data.acceptingTips,
      false,
      `switch ${on}`,
    );
    await assert.rejects(tipTobi(database.db), {
      code: 'PAYMENT_ACCOUNT_REQUIRED',
    });
  }
  // An undecided recipient with an account the partner refused (RESTRICTED) is direct even with
  // the switch on (P22): still not ready.
  await setMode(database.pool, null);
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
    status: 'RESTRICTED',
    chargesEnabled: false,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });
  assert.equal(
    (await publicPage(database.db, bachsConfig)).data.acceptingTips,
    false,
  );
  // Direct and ready: takes tips, as today.
  await setMode(database.pool, 'direct');
  await updatePaymentAccountStatus(database.db, {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_tobi123',
    status: 'ACTIVE',
    chargesEnabled: true,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });
  assert.equal(
    (await publicPage(database.db, bachsConfig)).data.acceptingTips,
    true,
  );
});

test('on the partner, a paused You collect page shows its form and the quote refuses with PAGE_PAUSED, as on every provider', async (t) => {
  const database = await collectDatabaseFor(t);
  await setSwitch(database.pool, 'you_collect', true);
  await setMode(database.pool, 'collect');
  // One paid collect tip, then a holding cap below what is held: the page is paused by amount.
  const { intent } = await tipTobi(database.db, '2000000');
  const [attempt] = (
    await database.pool.query(
      `SELECT id FROM payment_attempts WHERE intent_id =
         (SELECT intent_id FROM tips WHERE id = $1)`,
      [intent.tipId],
    )
  ).rows;
  await database.pool.query(
    `UPDATE payment_attempts SET created_at = now() - interval '1 minute' WHERE id = $1`,
    [attempt.id],
  );
  const booked = await reconcileAttempts({
    db: database.db,
    provider: {
      environment: 'sandbox',
      async verifyTransaction() {
        return {
          status: 'succeeded',
          amountMinor: 2_000_000n,
          currency: 'NGN',
          feeMinor: 20_000n,
          feePaidBy: 'platform',
          method: 'NGN_CARD',
          chargeReference: 'ch_paused1',
        };
      },
    },
    now: new Date(),
    minAgeMs: 0,
    attemptId: attempt.id,
  });
  assert.equal(booked.applied, 1);
  await database.pool.query(
    `INSERT INTO collect_settings (id, cap_minor, cap_days, reminder_days, delay_hours, delay_for_days,
       first_withdrawal_cap_minor, new_daily_limit_minor, new_daily_limit_days,
       reserve_warning_minor, reserve_critical_minor, effective_from, reason)
     VALUES (gen_random_uuid(), 1000000, 30, '{7,21,28}', 24, 7, 5000000, 20000000, 30,
       50000000, 25000000, now() - interval '1 minute', 'Set in a test')`,
  );
  const status = await collectStatus(database.db, TOBI, new Date());
  assert.deepEqual([status.paused, status.pausedReason], [true, 'amount']);
  // The page shows its form, as with the pretend provider; the quote then refuses.
  assert.equal(
    (await publicPage(database.db, bachsConfig)).data.acceptingTips,
    true,
  );
  assert.equal(
    (await publicPage(database.db, { PAYMENT_PROVIDER: 'mock' })).data
      .acceptingTips,
    true,
  );
  await assert.rejects(tipTobi(database.db), { code: 'PAGE_PAUSED' });
});

test('on the partner, a business staff page lists a You collect member and shows their form, by the same rule', async (t) => {
  const database = await collectDatabaseFor(t);
  await setSwitch(database.pool, 'you_collect', false);
  const business = await seedBusiness(database, {
    locations: [{ slug: 'vi', name: 'Victoria Island' }],
  });
  await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: TOBI,
    shownName: 'Tobi',
  });
  const controller = new BusinessPublicController(
    { db: database.db },
    bachsConfig,
  );
  const read = async () => {
    const staff = await controller.staff(business.slug, 'vi', 'tobi');
    const location = await controller.location(business.slug, 'vi');
    const search = await controller.search(business.slug, { q: 'tob' });
    return [
      staff.data.profile.acceptingTips,
      location.data.people.length,
      search.data.length,
    ];
  };
  // Undecided, switch off: today's rule, no account, nobody listed.
  assert.deepEqual(await read(), [false, 0, 0]);
  // Undecided, switch on: the preview says collect.
  await setSwitch(database.pool, 'you_collect', true);
  assert.deepEqual(await read(), [true, 1, 1]);
  // Direct: today's rule again.
  await setMode(database.pool, 'direct');
  assert.deepEqual(await read(), [false, 0, 0]);
  // Stored collect, switch off: still collect.
  await setMode(database.pool, 'collect');
  await setSwitch(database.pool, 'you_collect', false);
  assert.deepEqual(await read(), [true, 1, 1]);
});
