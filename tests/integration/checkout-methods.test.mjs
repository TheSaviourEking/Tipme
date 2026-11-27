import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import {
  grantOwner,
  setCardCosts,
  setPagePlan,
  setPlanFeeRates,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';
import {
  newUser,
  recordingProviders,
  seedPages,
  services,
  signUpRoute,
} from './collect-checkout-support.mjs';
import { setSwitch } from './helpers.mjs';

// Profit guards, Part 2: each tip checkout offers card only when TipMe's quoted share covers the
// card cost (as it stood when the quote was made); bank transfer is always offered.

let database;
let staff;
before(async () => {
  database = await openTestDatabase();
});
after(async () => {
  await setSwitch(database.pool, 'you_collect', false);
  await database.close();
});
beforeEach(async () => {
  await seedPages(database);
  await setSwitch(database.pool, 'you_collect', false);
  ({ userId: staff } = await grantOwner(database.db, {
    phone: '+2348000007791',
  }));
});

const BOTH = ['bank_transfer', 'card'];
const TRANSFER = ['bank_transfer'];
const naira = (n) => ({
  amountMinor: String(n * 100),
  currency: 'NGN',
});
// Rows are stamped by the database clock: a short gap keeps "before" and "after" apart.
const tick = () => new Promise((done) => setTimeout(done, 25));

const makePro = (profileId) =>
  setPagePlan(database.db, {
    staffUserId: staff,
    profileId,
    plan: 'pro',
    reason: 'Plan for the checkout methods test',
  });
const setMargin = (marginMinor) =>
  database.db.transaction((tx) =>
    setCardCosts(tx, {
      cost: { rateBps: 200n, fixedMinor: 4500n, marginMinor },
      actorId: staff,
      approvedBy: null,
      reason: 'Card cost for the checkout methods test',
      now: new Date(),
    }),
  );
const methodsOf = (calls) =>
  calls
    .filter(([name]) => name.includes('.initialize'))
    .map(([, input]) => input.paymentMethods);

/** Quotes a tip to `handle` and starts its checkout; returns the provider calls it made. */
async function tip(checkout, providers, handle, amount) {
  const quote = await checkout.quote({ handle, ...naira(amount) });
  await checkout.createIntent({ quoteId: quote.quoteId }, randomUUID());
  return { quote, calls: providers.calls.splice(0) };
}

/** A new live page that, with You collect on, is a collect page. */
async function collectPage(handle) {
  await setSwitch(database.pool, 'you_collect', true);
  const userId = await newUser(database.pool);
  await signUpRoute(database.db).claim({ userId }, { handle }, undefined);
  const {
    rows: [row],
  } = await database.pool.query(
    `UPDATE profiles SET page_state = 'live' WHERE user_id = $1 RETURNING id`,
    [userId],
  );
  return row.id;
}

test('a Pro tip of ₦5,000 starts a checkout with bank transfer only', async () => {
  await makePro(ADA);
  const providers = recordingProviders();
  const { bachs } = services(database.db, providers);
  const small = await tip(bachs, providers, 'ada', 5_000);
  assert.deepEqual(methodsOf(small.calls), [TRANSFER]);
  const [[, input]] = small.calls;
  // The share and amount are the quote's, as tipmeShareMinor has always been.
  assert.equal(
    input.tipmeShareMinor,
    BigInt(small.quote.platformFeeMinor) + BigInt(small.quote.providerFeeMinor),
  );
  assert.equal(input.amountMinor, BigInt(small.quote.payerTotalMinor));
  const large = await tip(bachs, providers, 'ada', 10_000);
  assert.deepEqual(methodsOf(large.calls), [BOTH]);
});

test('a You collect tip uses the same rule', async () => {
  const profileId = await collectPage('newcomer');
  await makePro(profileId);
  const providers = recordingProviders();
  const { bachs } = services(database.db, providers);
  const small = await tip(bachs, providers, 'newcomer', 5_000);
  assert.equal(small.quote.collectedByTipMe, true);
  assert.equal(small.calls[0][0], 'bachs.initializeCollectCheckout');
  assert.deepEqual(methodsOf(small.calls), [TRANSFER]);
  const large = await tip(bachs, providers, 'newcomer', 10_000);
  assert.deepEqual(methodsOf(large.calls), [BOTH]);
});

test('the methods follow the quoted share, not today’s rate', async () => {
  await makePro(ADA);
  const providers = recordingProviders();
  const { bachs } = services(database.db, providers);
  const quote = await bachs.quote({ handle: 'ada', ...naira(10_000) });
  // At 2%, ₦10,000 would give TipMe ₦200, under the ₦260 card cost: card would go.
  await database.db.transaction((tx) =>
    setPlanFeeRates(tx, {
      freeBps: 500n,
      proBps: 200n,
      staffUserId: staff,
      approvedBy: null,
      reason: 'Pro rate for the checkout methods test',
      now: new Date(),
    }),
  );
  await bachs.createIntent({ quoteId: quote.quoteId }, randomUUID());
  assert.deepEqual(methodsOf(providers.calls), [BOTH]);
});

test('a fee-free tip offers bank transfer only', async () => {
  await database.pool.query(
    `INSERT INTO fee_free_credits (profile_id, remaining) VALUES ($1, 1)`,
    [ADA],
  );
  const providers = recordingProviders();
  const { bachs } = services(database.db, providers);
  const { quote, calls } = await tip(bachs, providers, 'ada', 50_000);
  assert.equal(quote.feeFree, true);
  assert.deepEqual(methodsOf(calls), [TRANSFER]);
});

test('a retried start sends the same list', async () => {
  // The pretend collect path has no claim: a start that throws leaves the attempt CREATED, so
  // the same draft starts the same attempt again, with the same idempotency key.
  await collectPage('newcomer');
  const providers = recordingProviders();
  let fail = true;
  const collect = providers.mock.initializeCollectCheckout;
  providers.mock.initializeCollectCheckout = async (input) => {
    if (fail) {
      fail = false;
      providers.calls.push(['mock.initializeCollectCheckout', input]);
      throw new Error('connection reset');
    }
    return collect(input);
  };
  const { mock } = services(database.db, providers);
  const quote = await mock.quote({ handle: 'newcomer', ...naira(10_000) });
  assert.equal(quote.collectedByTipMe, true);
  const key = randomUUID();
  await assert.rejects(mock.createIntent({ quoteId: quote.quoteId }, key));
  await tick();
  await setMargin(50_000n);
  await mock.createIntent({ quoteId: quote.quoteId }, key);
  const starts = providers.calls.filter(([name]) =>
    name.includes('.initialize'),
  );
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0][1].paymentMethods, BOTH);
  assert.deepEqual(starts[1][1].paymentMethods, BOTH);
  assert.equal(starts[0][1].idempotencyKey, starts[1][1].idempotencyKey);
  assert.equal(starts[0][1].attemptId, starts[1][1].attemptId);
});

test('a card cost change applies to tips quoted after it', async () => {
  await makePro(ADA);
  await setMargin(50_000n);
  await tick();
  const providers = recordingProviders();
  const { bachs } = services(database.db, providers);
  const { calls } = await tip(bachs, providers, 'ada', 10_000);
  assert.deepEqual(methodsOf(calls), [TRANSFER]);
});

test('a database error reading the card cost fails the start, with no checkout asked for', async (t) => {
  const providers = recordingProviders();
  const { bachs } = services(database.db, providers);
  const quote = await bachs.quote({ handle: 'ada', ...naira(10_000) });
  // This file's own database copy: the table is put back whatever happens.
  await database.pool.query(
    `ALTER TABLE card_cost_settings RENAME TO card_cost_settings_away`,
  );
  t.after(() =>
    database.pool.query(
      `ALTER TABLE IF EXISTS card_cost_settings_away RENAME TO card_cost_settings`,
    ),
  );
  await assert.rejects(
    bachs.createIntent({ quoteId: quote.quoteId }, randomUUID()),
    { name: 'PersistenceError' },
  );
  assert.deepEqual(providers.calls, []);
  const {
    rows: [attempt],
  } = await database.pool.query(
    `SELECT a.status FROM payment_attempts a
       JOIN payment_intents i ON i.id = a.intent_id WHERE i.quote_id = $1`,
    [quote.quoteId],
  );
  assert.equal(attempt.status, 'CREATED');
});
