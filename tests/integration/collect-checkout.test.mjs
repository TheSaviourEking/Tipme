import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import {
  createPaymentIntent,
  tipStatusView,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { UncertainProviderOutcomeError } from '../../packages/payments/dist/index.js';
import {
  newUser,
  recordingProviders,
  seedPages,
  services,
  signUpRoute,
  WEB_ORIGIN,
} from './collect-checkout-support.mjs';
import { setSwitch } from './helpers.mjs';
import { casesOf } from './collect-direct-cases.mjs';

// You collect (plan Task 6, ruling R7): each recipient's collection mode, fixed on every quote, and
// the checkout branch that takes a collect tip on TipMe's own account. The switch is off in
// production; these tests turn it on by writing its row, as the tip_refunds tests do (R12).

let database;
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
});

const QUOTE = (handle) => ({ handle, amountMinor: '200000', currency: 'NGN' });
const modeOf = async (handle) =>
  (
    await database.pool.query(
      `SELECT collection_mode FROM profiles WHERE handle = $1`,
      [handle],
    )
  ).rows[0].collection_mode;
const quoteModeOf = async (quoteId) =>
  (
    await database.pool.query(
      `SELECT collection_mode FROM tip_quotes WHERE id = $1`,
      [quoteId],
    )
  ).rows[0].collection_mode;
const attemptOf = async (tipId) =>
  (
    await database.pool.query(
      `SELECT a.id, a.status, a.provider, a.provider_reference
         FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
        WHERE t.id = $1`,
      [tipId],
    )
  ).rows[0];
const namesOf = (calls) => calls.map(([name]) => name);

// The direct path (plan Task 16): these cases live in collect-direct-cases.mjs, so the switch-off
// rerun (you-collect-switch-off.test.mjs) imports the very same ones.
for (const directCase of casesOf(6))
  test(directCase.name, () =>
    directCase.run({
      database,
      switchOn: true,
      setYouCollect: (on) => setSwitch(database.pool, 'you_collect', on),
    }),
  );

test('switch on: a new sign-up is collect and can be tipped with no payment account', async () => {
  await setSwitch(database.pool, 'you_collect', true);
  const userId = await newUser(database.pool);
  await signUpRoute(database.db).claim(
    { userId },
    { handle: 'newcomer' },
    undefined,
  );
  assert.equal(await modeOf('newcomer'), 'collect');
  await database.pool.query(
    `UPDATE profiles SET page_state = 'live' WHERE user_id = $1`,
    [userId],
  );

  const providers = recordingProviders();
  const checkout = services(database.db, providers);
  const quote = await checkout.bachs.quote(QUOTE('newcomer'));
  assert.equal(quote.collectedByTipMe, true);
  assert.equal(await quoteModeOf(quote.quoteId), 'collect');
  const created = await checkout.bachs.createIntent(
    { quoteId: quote.quoteId },
    randomUUID(),
  );
  const attempt = await attemptOf(created.tipId);
  // No partner account was needed, and none was asked for: TipMe's own checkout.
  assert.deepEqual(providers.calls, [
    [
      'bachs.initializeCollectCheckout',
      {
        attemptId: attempt.id,
        amountMinor: 200000n,
        currency: 'NGN',
        successUrl: `${WEB_ORIGIN}/tip/${created.tipId}`,
        cancelUrl: `${WEB_ORIGIN}/tip/${created.tipId}`,
        idempotencyKey: `tipme-checkout-${attempt.id}`,
        // Profit guards: a ₦2,000 Free tip's share covers the card cost.
        paymentMethods: ['bank_transfer', 'card'],
      },
    ],
  ]);
  assert.equal(attempt.status, 'INITIATED');
  assert.equal(attempt.provider, 'bachs');
  assert.match(attempt.provider_reference, /^platform:cs_\d+$/);
  assert.match(created.checkoutUrl, /^https:\/\/checkout\.bachs\.test\//);

  // The pretend provider takes it on its collect branch too.
  const mockQuote = await checkout.mock.quote(QUOTE('newcomer'));
  const mockTip = await checkout.mock.createIntent(
    { quoteId: mockQuote.quoteId },
    randomUUID(),
  );
  assert.deepEqual(namesOf(providers.calls.slice(1)), [
    'mock.initializeCollectCheckout',
  ]);
  const mockAttempt = await attemptOf(mockTip.tipId);
  assert.equal(mockAttempt.provider, 'mock');
  assert.match(mockAttempt.provider_reference, /^platform:mock_collect_\d+$/);
  assert.equal(
    mockTip.checkoutUrl,
    `${WEB_ORIGIN}/mock-checkout/${encodeURIComponent(mockAttempt.provider_reference)}`,
  );
});

test('switch on: an existing recipient with an active account stays direct; one without becomes collect once', async () => {
  await setSwitch(database.pool, 'you_collect', true);
  const providers = recordingProviders();
  const checkout = services(database.db, providers);

  const ada = await checkout.bachs.quote(QUOTE('ada'));
  assert.equal(ada.collectedByTipMe, undefined);
  assert.equal(await quoteModeOf(ada.quoteId), 'direct');
  assert.equal(await modeOf('ada'), 'direct');
  const tobi = await checkout.bachs.quote(QUOTE('tobi'));
  assert.equal(tobi.collectedByTipMe, true);
  assert.equal(await quoteModeOf(tobi.quoteId), 'collect');
  assert.equal(await modeOf('tobi'), 'collect');

  // Decided once: Ada losing her account, or Tobi gaining one, rewrites nothing.
  await database.pool.query(
    `UPDATE payment_accounts SET status = 'RESTRICTED' WHERE provider_account_reference = 'acct_ada123'`,
  );
  await database.pool.query(
    `UPDATE payment_accounts SET profile_id = (SELECT id FROM profiles WHERE handle = 'tobi'), status = 'ACTIVE'`,
  );
  const adaAgain = await checkout.bachs.quote(QUOTE('ada'));
  const tobiAgain = await checkout.bachs.quote(QUOTE('tobi'));
  assert.equal(await quoteModeOf(adaAgain.quoteId), 'direct');
  assert.equal(await quoteModeOf(tobiAgain.quoteId), 'collect');
  assert.equal(await modeOf('ada'), 'direct');
  assert.equal(await modeOf('tobi'), 'collect');

  // Off again: nobody new is put on it, and Tobi keeps collect (§12.5).
  await setSwitch(database.pool, 'you_collect', false);
  const tobiOff = await checkout.bachs.quote(QUOTE('tobi'));
  assert.equal(tobiOff.collectedByTipMe, true);
  assert.equal(await quoteModeOf(tobiOff.quoteId), 'collect');
  assert.equal(await modeOf('tobi'), 'collect');
  const userId = await newUser(database.pool);
  await signUpRoute(database.db).claim(
    { userId },
    { handle: 'later' },
    undefined,
  );
  assert.equal(await modeOf('later'), null);
  assert.deepEqual(providers.calls, []);
});

test("the mode on the quote is honoured after the person's mode changes", async () => {
  await setSwitch(database.pool, 'you_collect', true);
  const providers = recordingProviders();
  const checkout = services(database.db, providers);
  const quote = await checkout.bachs.quote(QUOTE('tobi'));
  assert.equal(await quoteModeOf(quote.quoteId), 'collect');
  await database.pool.query(
    `UPDATE profiles SET collection_mode = 'direct' WHERE handle = 'tobi'`,
  );
  await checkout.bachs.createIntent({ quoteId: quote.quoteId }, randomUUID());
  assert.deepEqual(namesOf(providers.calls), [
    'bachs.initializeCollectCheckout',
  ]);

  // And the other way: a direct quote stays direct after the person moves to collect.
  const adaQuote = await checkout.bachs.quote(QUOTE('ada'));
  await database.pool.query(
    `UPDATE profiles SET collection_mode = 'collect' WHERE handle = 'ada'`,
  );
  await checkout.bachs.createIntent(
    { quoteId: adaQuote.quoteId },
    randomUUID(),
  );
  assert.deepEqual(namesOf(providers.calls.slice(1)), [
    'bachs.initializePayment',
  ]);
});

test('a collect checkout start that times out stays unknown and is never retried blindly', async () => {
  await setSwitch(database.pool, 'you_collect', true);
  const providers = recordingProviders({
    collectError: new UncertainProviderOutcomeError('a', 'no response'),
  });
  const checkout = services(database.db, providers);
  const quote = await checkout.bachs.quote(QUOTE('tobi'));
  const key = randomUUID();
  await assert.rejects(
    checkout.bachs.createIntent({ quoteId: quote.quoteId }, key),
    { code: 'PROVIDER_OUTCOME_UNKNOWN' },
  );
  const { rows } = await database.pool.query(
    `SELECT a.status AS attempt, t.status AS tip
       FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id`,
  );
  assert.deepEqual(rows, [{ attempt: 'UNKNOWN', tip: 'AWAITING_PAYMENT' }]);
  // The same draft again: still unknown, and the partner is not asked a second time.
  await assert.rejects(
    checkout.bachs.createIntent({ quoteId: quote.quoteId }, key),
    { code: 'PROVIDER_OUTCOME_UNKNOWN' },
  );
  assert.deepEqual(namesOf(providers.calls), [
    'bachs.initializeCollectCheckout',
  ]);
});

/**
 * An intent made with `key` whose checkout never opened (the API stopped after making it), its
 * quote then aged past expiry: a retry with the same key is all that is left.
 */
async function staleCreatedIntent(checkout, handle, key) {
  const quote = await checkout.quote(QUOTE(handle));
  await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: key,
  });
  await database.pool.query(
    `UPDATE tip_quotes SET expires_at = now() - interval '5 minutes' WHERE id = $1`,
    [quote.quoteId],
  );
  return quote;
}

test('a collect checkout never opens once its quote has expired, on the partner or the pretend provider', async () => {
  await setSwitch(database.pool, 'you_collect', true);
  const providers = recordingProviders();
  const checkout = services(database.db, providers);
  for (const path of ['bachs', 'mock']) {
    const key = randomUUID();
    const quote = await staleCreatedIntent(checkout[path], 'tobi', key);
    assert.equal(await quoteModeOf(quote.quoteId), 'collect');
    await assert.rejects(
      checkout[path].createIntent({ quoteId: quote.quoteId }, key),
      { code: 'QUOTE_EXPIRED' },
    );
    const { rows } = await database.pool.query(
      `SELECT a.status, a.provider, a.provider_reference
         FROM payment_attempts a JOIN payment_intents i ON i.id = a.intent_id
        WHERE i.quote_id = $1`,
      [quote.quoteId],
    );
    assert.deepEqual(rows, [
      { status: 'CREATED', provider: null, provider_reference: null },
    ]);
  }
  // No checkout was asked for on either path.
  assert.deepEqual(providers.calls, []);
});

test('the tip status says a collect tip is collected by TipMe, and says nothing for a direct one', async () => {
  await setSwitch(database.pool, 'you_collect', true);
  const checkout = services(database.db, recordingProviders());
  const collect = await checkout.bachs.createIntent(
    { quoteId: (await checkout.bachs.quote(QUOTE('tobi'))).quoteId },
    randomUUID(),
  );
  const direct = await checkout.bachs.createIntent(
    { quoteId: (await checkout.bachs.quote(QUOTE('ada'))).quoteId },
    randomUUID(),
  );
  const now = new Date();
  assert.equal(
    (await tipStatusView(database.db, collect.tipId, now)).collectedByTipMe,
    true,
  );
  assert.equal(
    'collectedByTipMe' in (await tipStatusView(database.db, direct.tipId, now)),
    false,
  );
});

// Rulings P22 and P23: the first quote while the switch is on decides by the status of the
// person's payment account on this provider and environment.
const BY_STATUS = [
  // [status, mode written, quote's mode]
  [null, 'collect', 'collect'],
  ['CREATING', 'collect', 'collect'],
  ['ONBOARDING', 'collect', 'collect'],
  ['ACTIVE', 'direct', 'direct'],
  // Restricted or failed by the partner: kept direct, so still blocked as today.
  ['RESTRICTED', 'direct', 'direct'],
  ['FAILED', 'direct', 'direct'],
  // The account may exist at the partner: left undecided, and the quote is direct.
  ['UNKNOWN', null, 'direct'],
];

for (const [status, written, quoted] of BY_STATUS) {
  test(`switch on: a first quote with ${status ?? 'no'} payment account writes ${written ?? 'nothing'} and quotes ${quoted}`, async () => {
    await setSwitch(database.pool, 'you_collect', true);
    await database.pool.query(`DELETE FROM payment_accounts`);
    if (status)
      await database.pool.query(
        `INSERT INTO payment_accounts (id, profile_id, provider, environment, status, charges_enabled)
         VALUES (gen_random_uuid(), (SELECT id FROM profiles WHERE handle = 'tobi'), 'bachs', 'sandbox', $1, $2)`,
        [status, status === 'ACTIVE'],
      );
    const providers = recordingProviders();
    const checkout = services(database.db, providers);
    const quote = await checkout.bachs.quote(QUOTE('tobi'));
    assert.equal(await modeOf('tobi'), written);
    assert.equal(await quoteModeOf(quote.quoteId), quoted);
    assert.equal(
      quote.collectedByTipMe,
      quoted === 'collect' ? true : undefined,
    );
    if (quoted === 'direct' && status !== 'ACTIVE') {
      // No ready account: refused before any partner call, exactly as today.
      await assert.rejects(
        checkout.bachs.createIntent({ quoteId: quote.quoteId }, randomUUID()),
        { code: 'PAYMENT_ACCOUNT_REQUIRED' },
      );
      assert.deepEqual(providers.calls, []);
    }
  });
}

test('switch on: an account whose creation outcome was unknown is decided once its status is known', async () => {
  await setSwitch(database.pool, 'you_collect', true);
  await database.pool.query(`DELETE FROM payment_accounts`);
  await database.pool.query(
    `INSERT INTO payment_accounts (id, profile_id, provider, environment, status)
     VALUES (gen_random_uuid(), (SELECT id FROM profiles WHERE handle = 'tobi'), 'bachs', 'sandbox', 'UNKNOWN')`,
  );
  const checkout = services(database.db, recordingProviders());
  await checkout.bachs.quote(QUOTE('tobi'));
  await checkout.bachs.quote(QUOTE('tobi'));
  assert.equal(await modeOf('tobi'), null);
  await database.pool.query(
    `UPDATE payment_accounts SET status = 'ONBOARDING'`,
  );
  const decided = await checkout.bachs.quote(QUOTE('tobi'));
  assert.equal(await modeOf('tobi'), 'collect');
  assert.equal(await quoteModeOf(decided.quoteId), 'collect');
});
