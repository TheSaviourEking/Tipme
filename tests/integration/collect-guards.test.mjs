import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ApiExceptionFilter } from '../../apps/api/dist/http/api-exception.filter.js';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { lagosDayStart } from '../../packages/domain/dist/index.js';
import { createRequire } from 'node:module';
import { setSwitch } from './helpers.mjs';

// The database package's own pg, so every statement it sends can be seen (M4).
const { Client } = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
)('pg');

/** The SQL text of every statement sent while `work` runs. */
async function statements(work) {
  const seen = [];
  const original = Client.prototype.query;
  Client.prototype.query = function (config, ...rest) {
    seen.push(typeof config === 'string' ? config : (config?.text ?? ''));
    return original.call(this, config, ...rest);
  };
  try {
    await work();
  } finally {
    Client.prototype.query = original;
  }
  return seen;
}

/*
 * You collect (plan Task 12, spec §2.1, §8, §9, §10): the guards around money TipMe holds for a
 * recipient who hasn't added bank details. The page pauses at the holding cap (₦50,000 held or 30
 * days, whichever first) and unpauses at once on verification; supporters are told no reason. The
 * recipient is reminded at 7, 21 and 28 days, once each. A collect recipient's first withdrawal is
 * capped, and for their first 30 days a Lagos day's withdrawals are limited. Money on its way is
 * shown and never withdrawable. A direct recipient sees none of this. No partner is called.
 */

const [ADA, TOBI] = ops.DEMO_PROFILES;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GROSS = 1_000_000n; // ₦10,000 on Free: ₦9,500 to the recipient.
const NET = 950_000n;
const NOW = new Date(Math.floor(Date.now() / MIN) * MIN);
const sealing = ops.mailSealing(Buffer.alloc(32, 7));

let database;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
});
after(async () => {
  await setSwitch(database.pool, 'you_collect', false);
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await setSwitch(database.pool, 'you_collect', true);
  // Signed up a week ago: inside the new-account window, outside nothing else here.
  await q(`UPDATE profiles SET created_at = $1`, [
    new Date(NOW.getTime() - 7 * DAY),
  ]);
});

const collect = (profile) =>
  q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    profile.id,
  ]);
const verify = (profile, at = NOW) =>
  q(`UPDATE profiles SET collect_verified_at = $2 WHERE id = $1`, [
    profile.id,
    at,
  ]);

/** A paid collect tip (Task 7's booking: held money and one waiting share), settled at `settledAt`. */
async function collectTip(profile, settledAt, tipMinor = GROSS) {
  const { db } = database;
  await collect(profile);
  const quote = await ops.createQuote(db, {
    handle: profile.handle,
    tipMinor,
    currency: 'NGN',
    now: settledAt,
  });
  assert.equal(quote.collectionMode, 'collect');
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    now: settledAt,
  });
  const reference = `platform:cs_${randomUUID().slice(0, 8)}`;
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: reference,
  });
  await q(`UPDATE payment_attempts SET created_at = $2 WHERE id = $1`, [
    intent.attemptId,
    new Date(settledAt.getTime() - MIN),
  ]);
  const result = await ops.reconcileAttempts({
    db,
    provider: {
      environment: 'sandbox',
      async verifyTransaction() {
        return {
          status: 'succeeded',
          amountMinor: tipMinor,
          currency: 'NGN',
          feeMinor: 20_000n,
          feePaidBy: 'platform',
          method: 'NGN_CARD',
          chargeReference: `ch_${randomUUID().slice(0, 8)}`,
        };
      },
    },
    now: settledAt,
    minAgeMs: 0,
    attemptId: intent.attemptId,
  });
  assert.equal(result.applied, 1);
  return intent.tipId;
}

/**
 * A supporter's intent for a quote, at `at`: a live tip (AWAITING_PAYMENT, attempt CREATED), from
 * the supporter address `addressKey` when given (the API's keyed hash of the rate-limit subject).
 */
const intentFor = (quote, at = NOW, addressKey) =>
  ops.createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    now: at,
    ...(addressKey ? { addressKey } : {}),
  });

/** The supporter opens the checkout: the attempt is INITIATED at the partner. */
const openCheckout = (intent) =>
  ops.markAttemptInitiated(database.db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
  });

/** The partner confirms an intent's payment at `at`, however late (a checkout lives 30 minutes). */
async function payAt(intent, tipMinor, at) {
  await openCheckout(intent);
  await settleAt(intent, tipMinor, at);
}

/** The partner confirms an intent whose checkout is already open. */
async function settleAt(intent, tipMinor, at) {
  const result = await ops.reconcileAttempts({
    db: database.db,
    provider: {
      environment: 'sandbox',
      async verifyTransaction() {
        return {
          status: 'succeeded',
          amountMinor: tipMinor,
          currency: 'NGN',
          feeMinor: 20_000n,
          feePaidBy: 'platform',
          method: 'NGN_CARD',
          chargeReference: `ch_${randomUUID().slice(0, 8)}`,
        };
      },
    },
    now: at,
    minAgeMs: 0,
    attemptId: intent.attemptId,
  });
  assert.equal(result.applied, 1);
}

/** A paid direct tip on the recipient's own partner account (today's flow). */
async function directTip(profile, tipMinor) {
  const { db } = database;
  const quote = await ops.createQuote(db, {
    handle: profile.handle,
    tipMinor,
    currency: 'NGN',
  });
  assert.equal(quote.collectionMode, 'direct');
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `acct_${profile.handle}:chk_${randomUUID().slice(0, 8)}`;
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: reference,
  });
  await ops.recordProviderEvent(db, {
    provider: 'bachs',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: tipMinor,
    currency: 'NGN',
    providerFeeMinor: 3000n,
    signatureVerified: true,
    payload: {},
  });
}

/** The recipient's own account with manual payouts and a usable bank: a withdrawal can go. */
async function payoutRoute(profile) {
  await q(
    `INSERT INTO payment_accounts
       (id, profile_id, provider, environment, provider_account_reference, status,
        charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
     VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, 'platform', now())`,
    [randomUUID(), profile.id, `acct_${profile.handle}`],
  );
  await q(
    `INSERT INTO payout_destinations
       (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
     VALUES ($1, $2, 'bachs', $3, '058', 'Guaranty Trust Bank', '4321', 'usable')`,
    [randomUUID(), profile.id, `ba_${profile.handle}`],
  );
}

/** The partner's side of a withdrawal: plenty in the account, ₦50 fee. Never moves money here. */
const partner = () => ({
  name: 'bachs-sandbox',
  capabilities: { connectedAccounts: true },
  async payoutCapability() {
    return { status: 'active', requirementsDue: [] };
  },
  async payoutBalance() {
    return { availableMinor: 1_000_000_000n };
  },
  async quotePayoutFee() {
    return { feeMinor: 5000n, exact: false };
  },
  async initiatePayout() {
    throw new Error('a request never starts a payout');
  },
  async coverPayoutFee() {
    throw new Error('a request never moves the fee');
  },
});

/** A withdrawal asked at `at`, recorded at that moment (a request stamps the real clock). */
async function withdraw(profile, amountMinor, at = NOW) {
  const result = await ops.requestWithdrawal(database.db, {
    profileId: profile.id,
    amountMinor,
    idempotencyKey: randomUUID(),
    provider: partner(),
    now: at,
  });
  await q(`UPDATE payouts SET created_at = $2 WHERE id = $1`, [
    result.payoutId,
    at,
  ]);
  return result;
}

const refusal = async (work) => {
  try {
    await work();
  } catch (error) {
    return error.code ?? error.name;
  }
  return 'allowed';
};

/** What the API's error filter answers for `error`: its status and body. */
function answered(error) {
  let sent;
  const response = {
    locals: {},
    getHeader: () => undefined,
    setHeader() {},
    status(code) {
      sent = { status: code };
      return this;
    },
    json(body) {
      sent.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ route: { path: '/v1/test' } }),
    }),
  };
  new ApiExceptionFilter({ error() {}, warn() {}, info() {} }).catch(
    error,
    host,
  );
  return sent;
}

/** A holding cap in force from `at` (the other settings at their defaults). */
const capFrom = (capMinor, at) =>
  q(
    `INSERT INTO collect_settings (id, cap_minor, cap_days, reminder_days, delay_hours, delay_for_days,
       first_withdrawal_cap_minor, new_daily_limit_minor, new_daily_limit_days,
       reserve_warning_minor, reserve_critical_minor, effective_from, reason)
     VALUES (gen_random_uuid(), $1, 30, '{7,21,28}', 24, 7, 5000000, 20000000, 30,
       50000000, 25000000, $2, 'Set in a test')`,
    [String(capMinor), at],
  );

// ₦52,631 on Free: the recipient's ₦49,999.45 is just under the ₦50,000 cap.
const NEAR_CAP_TIP = 5_263_100n;

/** A waiting spell's name in a reminder's key: its first tip's Lagos calendar day. */
const spellOf = (at) =>
  new Date(at.getTime() + HOUR).toISOString().slice(0, 10);

const quoteAt = (profile, now, tipMinor = GROSS) =>
  ops.createQuote(database.db, {
    handle: profile.handle,
    tipMinor,
    currency: 'NGN',
    now,
  });

test('the holding cap pauses the page at ₦50,000 held or after 30 days, whichever comes first', async () => {
  // Amount: ₦49,999.45 held. No tip may take it past ₦50,000 (P31): ₦100,000 is refused, and so is
  // the smallest tip, as the room left is 55 kobo. One refusal for every case (fix round 2).
  await collectTip(TOBI, new Date(NOW.getTime() - 10 * MIN), NEAR_CAP_TIP);
  let status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.mode, 'collect');
  assert.equal(status.verified, false);
  const held = status.heldMinor;
  assert.ok(held < 5_000_000n && held > 4_999_000n, String(held));
  assert.deepEqual([status.paused, status.pausedReason], [false, null]);
  assert.equal(
    await refusal(() => quoteAt(TOBI, NOW, 10_000_000n)),
    'PAGE_PAUSED',
  );
  assert.equal(
    await refusal(() => quoteAt(TOBI, NOW, 200_000n)),
    'PAGE_PAUSED',
  );
  // Nothing was written for the refused quotes.
  assert.equal((await q(`SELECT count(*)::int AS n FROM tip_quotes`))[0].n, 1);

  // Days: one small tip 30 days ago pauses the page on day 30, to the minute, not before.
  const first = new Date(NOW.getTime() - 30 * DAY + HOUR);
  await collectTip(ADA, first);
  status = await ops.collectStatus(database.db, ADA.id, NOW);
  assert.equal(status.firstWaitingAt.getTime(), first.getTime());
  assert.equal(status.pauseOn.getTime(), first.getTime() + 30 * DAY);
  assert.equal(status.paused, false);
  const day30 = new Date(first.getTime() + 30 * DAY);
  status = await ops.collectStatus(database.db, ADA.id, day30);
  assert.deepEqual([status.paused, status.pausedReason], [true, 'days']);
  assert.equal(await refusal(() => quoteAt(ADA, day30)), 'PAGE_PAUSED');
  assert.equal(
    (await quoteAt(ADA, new Date(day30.getTime() - MIN))).collectionMode,
    'collect',
  );

  // At the cap the page pauses: here a cap lowered under what is held.
  await capFrom(1_000_000n, new Date(NOW.getTime() - 2 * MIN));
  status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.deepEqual([status.paused, status.pausedReason], [true, 'amount']);
  assert.equal(await refusal(() => quoteAt(TOBI, NOW)), 'PAGE_PAUSED');

  // The cap is an admin setting, read when used: raised, Tobi takes tips again.
  await capFrom(10_000_000n, new Date(NOW.getTime() - MIN));
  assert.equal((await quoteAt(TOBI, NOW)).collectionMode, 'collect');
});

test('bare quotes never block a page; live intents count, and concurrent intents never overshoot the cap', async () => {
  await collect(TOBI);
  // A burst of unpaid quotes, ₦95,000 to Tobi in all: anonymous and free, so none holds room.
  const burst = [];
  for (let i = 0; i < 5; i += 1)
    burst.push(await quoteAt(TOBI, NOW, 2_000_000n));
  // Another supporter's quote still goes through.
  assert.equal(
    (await quoteAt(TOBI, NOW, 2_000_000n)).collectionMode,
    'collect',
  );
  // The binding check is the intent's, under the lock: of three at once (₦19,000 each to Tobi), two
  // fit under ₦50,000 and the third is refused.
  const at = new Date(NOW.getTime() + MIN);
  const results = await Promise.allSettled(
    burst.slice(0, 3).map((quote) => intentFor(quote, at)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [
    'fulfilled',
    'fulfilled',
    'rejected',
  ]);
  assert.equal(
    results.find((r) => r.status === 'rejected').reason.code,
    'PAGE_PAUSED',
  );
  // Those two live tips now count at the quote too: ₦19,000 more doesn't fit in ₦12,000...
  assert.equal(
    await refusal(() => quoteAt(TOBI, at, 2_000_000n)),
    'PAGE_PAUSED',
  );
  // ...while ₦1,900 does.
  assert.equal((await quoteAt(TOBI, at, 200_000n)).collectionMode, 'collect');
  // A direct page is never counted.
  for (let i = 0; i < 4; i += 1)
    assert.equal(
      (await quoteAt(ADA, NOW, 2_000_000n)).collectionMode,
      'direct',
    );
});

test('a slow payer with a checkout open still holds their room after the quote expires', async () => {
  await collect(TOBI);
  // ₦40,000 at t=0: ₦38,000 to Tobi, its checkout open (it lives 30 minutes, the quote 15).
  const first = await intentFor(await quoteAt(TOBI, NOW, 4_000_000n));
  await openCheckout(first);
  // At 16 minutes the quote has expired, but the tip may still be paid: a second supporter's
  // ₦20,000 (₦19,000 more) would take the total past ₦50,000, so it is refused.
  const later = new Date(NOW.getTime() + 16 * MIN);
  assert.equal(
    await refusal(() => quoteAt(TOBI, later, 2_000_000n)),
    'PAGE_PAUSED',
  );
  // The first pays at 20 minutes and is booked: held stays under the cap.
  await settleAt(first, 4_000_000n, new Date(NOW.getTime() + 20 * MIN));
  const status = await ops.collectStatus(
    database.db,
    TOBI.id,
    new Date(NOW.getTime() + 21 * MIN),
  );
  assert.equal(status.heldMinor, 3_800_000n);
  assert.ok(status.heldMinor <= 5_000_000n);
});

test('an abandoned intent (no checkout opened) stops counting when its quote expires', async () => {
  await collect(TOBI);
  // ₦40,000 at t=0, ₦38,000 to Tobi: an intent made, its checkout never opened (attempt CREATED).
  const abandoned = await intentFor(await quoteAt(TOBI, NOW, 4_000_000n));
  // While its quote lives it holds its room: ₦19,000 more doesn't fit.
  const during = new Date(NOW.getTime() + 10 * MIN);
  assert.equal(
    await refusal(() => quoteAt(TOBI, during, 2_000_000n)),
    'PAGE_PAUSED',
  );
  // Once the quote has expired no checkout can open for it, so the page takes tips again.
  const expired = new Date(NOW.getTime() + 16 * MIN);
  const next = await quoteAt(TOBI, expired, 2_000_000n);
  assert.equal(next.collectionMode, 'collect');
  assert.ok((await intentFor(next, expired)).tipId);
  assert.equal(
    (
      await q(`SELECT status FROM payment_attempts WHERE id = $1`, [
        abandoned.attemptId,
      ])
    )[0].status,
    'CREATED',
  );
});

test('no checkout opens for a collect intent whose quote has expired, so a late retry never overshoots the cap', async () => {
  await collect(TOBI);
  // ₦40,000 at t=0, ₦38,000 to Tobi: the intent is made, then the provider blips and its attempt
  // stays CREATED (no checkout opened).
  const key = randomUUID();
  const a = await ops.createPaymentIntent(database.db, {
    quoteId: (await quoteAt(TOBI, NOW, 4_000_000n)).quoteId,
    idempotencyKey: key,
    now: NOW,
  });
  // At 16 minutes A's quote has expired and A stops counting, so B's ₦20,000 (₦19,000) is taken,
  // its checkout opened and paid.
  const at16 = new Date(NOW.getTime() + 16 * MIN);
  const b = await intentFor(await quoteAt(TOBI, at16, 2_000_000n), at16);
  const claimB = await ops.claimAttemptStart(database.db, {
    attemptId: b.attemptId,
    provider: 'bachs',
    now: at16,
  });
  assert.equal(claimB.outcome, 'claimed');
  await openCheckout(b);
  await settleAt(b, 2_000_000n, new Date(NOW.getTime() + 17 * MIN));
  // At 20 minutes A retries with the same key: the tip replays, but no checkout may open for it,
  // on the partner's path (the claim) or the pretend provider's (straight to INITIATED).
  const at20 = new Date(NOW.getTime() + 20 * MIN);
  const replayed = await ops.createPaymentIntent(database.db, {
    quoteId: (
      await q(`SELECT quote_id FROM payment_intents WHERE id = $1`, [
        a.intentId,
      ])
    )[0].quote_id,
    idempotencyKey: key,
    now: at20,
  });
  assert.equal(replayed.replayed, true);
  assert.equal(
    await refusal(() =>
      ops.claimAttemptStart(database.db, {
        attemptId: a.attemptId,
        provider: 'bachs',
        now: at20,
      }),
    ),
    'QUOTE_EXPIRED',
  );
  assert.equal(
    await refusal(() =>
      ops.markAttemptInitiated(database.db, {
        attemptId: a.attemptId,
        provider: 'mock',
        providerReference: `platform:mock_collect_${randomUUID().slice(0, 8)}`,
        opensCheckout: true,
        now: at20,
      }),
    ),
    'QUOTE_EXPIRED',
  );
  const [attempt] = await q(
    `SELECT status, provider, provider_reference FROM payment_attempts WHERE id = $1`,
    [a.attemptId],
  );
  assert.deepEqual(attempt, {
    status: 'CREATED',
    provider: null,
    provider_reference: null,
  });
  const status = await ops.collectStatus(
    database.db,
    TOBI.id,
    new Date(NOW.getTime() + 21 * MIN),
  );
  assert.equal(status.heldMinor, 1_900_000n);
  assert.ok(status.heldMinor <= 5_000_000n);
  // Recording a payment the provider says it did start (the expiry job's lookup) is evidence,
  // not a checkout opening, and is never refused.
  assert.equal(
    await ops.markAttemptInitiated(database.db, {
      attemptId: a.attemptId,
      provider: 'bachs',
      providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
    }),
    'initiated',
  );
});

test('a direct tip’s checkout still opens after its quote expires, as today', async () => {
  const quote = await quoteAt(ADA, NOW);
  assert.equal(quote.collectionMode, 'direct');
  const intent = await intentFor(quote, NOW);
  const claim = await ops.claimAttemptStart(database.db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    now: new Date(NOW.getTime() + 20 * MIN),
  });
  assert.equal(claim.outcome, 'claimed');
  const other = await intentFor(await quoteAt(ADA, NOW), NOW);
  assert.equal(
    await ops.markAttemptInitiated(database.db, {
      attemptId: other.attemptId,
      provider: 'mock',
      providerReference: `mock_${randomUUID().slice(0, 8)}`,
      opensCheckout: true,
      now: new Date(NOW.getTime() + 20 * MIN),
    }),
    'initiated',
  );
});

test('the address key is kept only on unfinished collect intents', async () => {
  // A direct intent never stores it.
  const direct = await intentFor(await quoteAt(ADA, NOW), NOW, 'address-d');
  const keyOf = async (intent) =>
    (
      await q(`SELECT address_key FROM payment_intents WHERE id = $1`, [
        intent.intentId,
      ])
    )[0].address_key;
  assert.equal(await keyOf(direct), null);

  await collect(TOBI);
  const paid = await intentFor(await quoteAt(TOBI, NOW), NOW, 'address-p');
  const abandoned = await intentFor(await quoteAt(TOBI, NOW), NOW, 'address-a');
  const failed = await intentFor(await quoteAt(TOBI, NOW), NOW, 'address-f');
  const at35 = new Date(NOW.getTime() + 35 * MIN);
  const live = await intentFor(await quoteAt(TOBI, at35), at35, 'address-l');
  for (const intent of [paid, abandoned, failed, live])
    assert.notEqual(await keyOf(intent), null);

  await payAt(paid, GROSS, new Date(NOW.getTime() + 2 * MIN));
  await openCheckout(failed);
  const [{ provider_reference: failedRef }] = await q(
    `SELECT provider_reference FROM payment_attempts WHERE id = $1`,
    [failed.attemptId],
  );
  await ops.recordProviderEvent(database.db, {
    provider: 'bachs',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.failed',
    attemptId: failed.attemptId,
    providerReference: failedRef,
    signatureVerified: true,
    payload: {},
  });
  // The expiry job cancels the abandoned one and clears the key of every intent now final, however
  // it finished; the live one keeps its key, as it still counts.
  const result = await ops.expireStaleTips({
    db: database.db,
    provider: {
      name: 'bachs',
      environment: 'sandbox',
      async findPayment() {
        return null;
      },
      async verifyTransaction() {
        throw new Error('nothing here has a reference to ask about');
      },
    },
    now: new Date(NOW.getTime() + 40 * MIN),
  });
  // The direct tip's abandoned intent is cancelled too; it never had a key to clear.
  assert.deepEqual(result, { expired: 2, paid: 0, errors: 0 });
  assert.equal(await keyOf(paid), null);
  assert.equal(await keyOf(abandoned), null);
  assert.equal(await keyOf(failed), null);
  assert.equal(await keyOf(live), 'address-l');
});

test('the address-key sweep clears at most its limit per run and never touches unfinished intents', async () => {
  await collect(TOBI);
  const keyed = [];
  for (const k of ['sweep-1', 'sweep-2', 'sweep-3']) {
    keyed.push(await intentFor(await quoteAt(TOBI, NOW), NOW, k));
  }
  const live = await intentFor(await quoteAt(TOBI, NOW), NOW, 'sweep-live');
  for (const intent of keyed)
    await q(`UPDATE tips SET status = 'CANCELLED' WHERE intent_id = $1`, [
      intent.intentId,
    ]);
  const held = async () =>
    Number(
      (
        await q(
          `SELECT count(*)::int AS n FROM payment_intents
            WHERE address_key LIKE 'sweep-%' AND address_key <> 'sweep-live'`,
        )
      )[0].n,
    );
  assert.equal(await held(), 3);
  assert.equal(await ops.clearFinishedAddressKeys(database.db, 2), 2);
  assert.equal(await held(), 1);
  assert.equal(await ops.clearFinishedAddressKeys(database.db, 2), 1);
  assert.equal(await held(), 0);
  assert.equal(await ops.clearFinishedAddressKeys(database.db, 2), 0);
  const [{ address_key }] = await q(
    `SELECT address_key FROM payment_intents WHERE id = $1`,
    [live.intentId],
  );
  assert.equal(address_key, 'sweep-live');
});

test('one supporter address holds at most 2 unfinished intents on a collect page', async () => {
  await collect(TOBI);
  // ₦10,000 tips (₦9,500 to Tobi): under the cap even all at once, so only the per-address limit
  // can refuse.
  const at = new Date(NOW.getTime() + MIN);
  const quotes = [];
  for (let i = 0; i < 5; i += 1) quotes.push(await quoteAt(TOBI, NOW));
  assert.ok((await intentFor(quotes[0], at, 'address-a')).tipId);
  assert.ok((await intentFor(quotes[1], at, 'address-a')).tipId);
  // A third from the same address is refused like any other cap refusal, and leaves no intent.
  const refused = await intentFor(quotes[2], at, 'address-a').catch((e) => e);
  assert.equal(refused.code, 'PAGE_PAUSED');
  assert.equal(
    (
      await q(
        `SELECT count(*)::int AS n FROM payment_intents WHERE quote_id = $1`,
        [quotes[2].quoteId],
      )
    )[0].n,
    0,
  );
  // Another address still tips.
  assert.ok((await intentFor(quotes[3], at, 'address-b')).tipId);
  // Once one of the first two is paid it is final, and the address may start another.
  const [first] = await q(
    `SELECT pa.id AS "attemptId" FROM payment_attempts pa
       JOIN payment_intents i ON i.id = pa.intent_id
      WHERE i.quote_id = $1`,
    [quotes[0].quoteId],
  );
  await payAt(first, GROSS, new Date(NOW.getTime() + 2 * MIN));
  assert.ok(
    (await intentFor(quotes[4], new Date(NOW.getTime() + 3 * MIN), 'address-a'))
      .tipId,
  );
});

test('a tip booked between the cap check’s two reads is never dropped from both', async () => {
  await collect(TOBI);
  // ₦40,000, ₦38,000 to Tobi, its checkout open: being paid when the next quote is checked.
  const first = await intentFor(await quoteAt(TOBI, NOW, 4_000_000n));
  await openCheckout(first);
  // Right after the check's first read of held money or tips being paid, the partner's success is
  // booked on another connection: the tip leaves "being paid" and enters held money. Bound here,
  // outside the quote's transaction, so the booking takes a connection of its own.
  const book = AsyncResource.bind(() =>
    settleAt(first, 4_000_000n, new Date(NOW.getTime() + 2 * MIN)),
  );
  let fired = false;
  const original = Client.prototype.query;
  Client.prototype.query = function (config, ...rest) {
    const text = typeof config === 'string' ? config : (config?.text ?? '');
    const result = original.call(this, config, ...rest);
    if (
      fired ||
      !/held_for_recipients|pa\.status IN/.test(text) ||
      typeof result?.then !== 'function'
    )
      return result;
    fired = true;
    Client.prototype.query = original;
    return result.then(async (value) => {
      await book();
      return value;
    });
  };
  let answer;
  try {
    // ₦19,000 more would take ₦38,000 past ₦50,000, however the booking interleaves.
    answer = await refusal(() =>
      quoteAt(TOBI, new Date(NOW.getTime() + 2 * MIN), 2_000_000n),
    );
  } finally {
    Client.prototype.query = original;
  }
  assert.ok(fired);
  assert.equal(answer, 'PAGE_PAUSED');
  const status = await ops.collectStatus(
    database.db,
    TOBI.id,
    new Date(NOW.getTime() + 3 * MIN),
  );
  assert.equal(status.heldMinor, 3_800_000n);
});

test('the intent re-checks the cap, refusing a quote that no longer fits', async () => {
  await collect(TOBI);
  const quote = await quoteAt(TOBI, NOW, 2_000_000n);
  // The cap was lowered after the quote: ₦19,000 no longer fits in ₦10,000.
  await capFrom(1_000_000n, NOW);
  const refused = await intentFor(quote, new Date(NOW.getTime() + MIN)).catch(
    (error) => error,
  );
  assert.equal(refused.code, 'PAGE_PAUSED');
  assert.equal(
    (await q(`SELECT count(*)::int AS n FROM payment_intents`))[0].n,
    0,
  );
  // A quote that fits is paid as before.
  await capFrom(5_000_000n, new Date(NOW.getTime() + 30_000));
  const intent = await intentFor(quote, new Date(NOW.getTime() + MIN));
  assert.ok(intent.tipId);
});

test('adding verified bank details unpauses the page at once', async () => {
  await collectTip(TOBI, new Date(NOW.getTime() - 10 * MIN), NEAR_CAP_TIP);
  await capFrom(1_000_000n, new Date(NOW.getTime() - 5 * MIN));
  assert.equal(await refusal(() => quoteAt(TOBI, NOW)), 'PAGE_PAUSED');
  // Task 13 writes this when the name and bank account check out.
  await verify(TOBI);
  const status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.verified, true);
  assert.deepEqual([status.paused, status.pausedReason], [false, null]);
  assert.equal((await quoteAt(TOBI, NOW)).collectionMode, 'collect');
  // A verified page has no holding cap at all: any amount, however old the held money.
  assert.equal(
    (await quoteAt(TOBI, NOW, 10_000_000n)).collectionMode,
    'collect',
  );
  assert.equal(
    (await quoteAt(TOBI, new Date(NOW.getTime() + 40 * DAY))).collectionMode,
    'collect',
  );
});

test('a supporter of a paused page is told only that the person can’t take tips right now', async () => {
  const body = (error) => {
    const sent = answered(error);
    assert.equal(sent.status, 409);
    assert.deepEqual(Object.keys(sent.body.error).sort(), [
      'code',
      'message',
      'reference',
    ]);
    return { code: sent.body.error.code, message: sent.body.error.message };
  };
  // Not enough room: a live ₦38,000 tip, and ₦19,000 more (₦12,000 left).
  await collect(TOBI);
  await intentFor(await quoteAt(TOBI, NOW, 4_000_000n));
  const someRoom = await quoteAt(TOBI, NOW, 2_000_000n).catch((e) => e);
  // Almost no room: ₦49,999.45 held, and the smallest tip.
  await collectTip(ADA, new Date(NOW.getTime() - 10 * MIN), NEAR_CAP_TIP);
  const noRoom = await quoteAt(ADA, NOW, 200_000n).catch((e) => e);
  // Paused: the cap lowered under what Ada holds.
  await capFrom(1_000_000n, new Date(NOW.getTime() - MIN));
  const paused = await quoteAt(ADA, NOW).catch((e) => e);
  // One body for all three, so probing amounts reveals nothing about the room left (fix round 2).
  const expected = {
    code: 'PAGE_PAUSED',
    message: 'This page can’t take tips right now. Please try again later.',
  };
  assert.deepEqual(
    [body(someRoom), body(noRoom), body(paused)],
    [expected, expected, expected],
  );
  assert.doesNotMatch(
    JSON.stringify(body(someRoom)),
    /bank|cap|held|₦|NGN|days|verif|amount|[0-9]/i,
  );
});

test('reminders go once each at 7, 21 and 28 days, and stop once verified', async () => {
  await q(
    `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
    [TOBI.userId, 'tobi.collect@example.com'],
  );
  const first = new Date(NOW.getTime() - 40 * DAY);
  await q(`UPDATE profiles SET created_at = $1`, [
    new Date(first.getTime() - DAY),
  ]);
  await collectTip(TOBI, first);
  await collectTip(TOBI, new Date(first.getTime() + 2 * DAY));
  const at = (days, extra = 0) =>
    new Date(first.getTime() + days * DAY + extra);
  const remind = (now) =>
    ops.sendCollectReminders(database.db, { now, sealing });
  const notices = () =>
    q(
      `SELECT kind, title, body FROM notifications WHERE user_id = $1 ORDER BY created_at, body`,
      [TOBI.userId],
    );
  const mails = () =>
    q(
      `SELECT type, dedupe_key FROM mail_messages WHERE type = 'collect_reminder' ORDER BY created_at, dedupe_key`,
    );

  assert.equal(await remind(at(6, 23 * HOUR)), 0);
  assert.equal(await remind(at(7)), 1);
  assert.equal(await remind(at(7, HOUR)), 0);
  assert.equal(await remind(at(20)), 0);
  assert.equal(await remind(at(21, MIN)), 1);
  assert.equal(await remind(at(21, 2 * MIN)), 0);
  assert.equal(await remind(at(28, 5 * MIN)), 1);
  assert.equal(await remind(at(29)), 0);
  // Past the cap the page has paused; nothing more is sent by the reminder.
  assert.equal(await remind(at(31)), 0);

  const held = '₦19,000';
  const by = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'long',
  }).format(at(30));
  assert.deepEqual(await notices(), [
    {
      kind: 'collect_reminder',
      title: 'Add your bank details',
      body: `You have ${held} in tips waiting. Add your bank details to withdraw it.`,
    },
    {
      kind: 'collect_reminder',
      title: 'Add your bank details',
      body: `You have ${held} in tips waiting. Add your bank details to withdraw it.`,
    },
    {
      kind: 'collect_reminder',
      title: 'Add your bank details',
      body: `Add your bank details by ${by}, or your page will pause new tips.`,
    },
  ]);
  assert.deepEqual(
    (await mails()).map((m) => m.dedupe_key),
    [7, 21, 28].map(
      (day) => `collect_reminder.${TOBI.id}.${spellOf(first)}.${day}`,
    ),
  );
  // The email is rendered from the same words.
  const [mail] = await q(
    `SELECT data_sealed FROM mail_messages WHERE dedupe_key = $1`,
    [`collect_reminder.${TOBI.id}.${spellOf(first)}.28`],
  );
  const data = JSON.parse(ops.openSecret(sealing.key, mail.data_sealed));
  assert.equal(data.kind, 'last');
  assert.equal(data.byDate, by);

  // Ada: reminded at 7, then verified before 21: nothing more.
  await q(
    `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
    [ADA.userId, 'ada.collect@example.com'],
  );
  const adaFirst = new Date(NOW.getTime() - 25 * DAY);
  await collectTip(ADA, adaFirst);
  const adaAt = (days) => new Date(adaFirst.getTime() + days * DAY);
  assert.equal(await remind(adaAt(7)), 1);
  // M6: a new waiting spell (the first spell's share gone, a later tip) is reminded again.
  await q(
    `UPDATE collect_transfers SET status = 'cancelled' WHERE profile_id = $1`,
    [ADA.id],
  );
  const adaSecond = adaAt(12);
  await collectTip(ADA, adaSecond);
  assert.equal(await remind(new Date(adaSecond.getTime() + 7 * DAY)), 1);
  assert.ok(
    (await mails()).some(
      (m) =>
        m.dedupe_key === `collect_reminder.${ADA.id}.${spellOf(adaSecond)}.7`,
    ),
  );
  await verify(ADA, adaAt(20));
  assert.equal(await remind(adaAt(21)), 0);
  assert.equal(
    (
      await q(
        `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`,
        [ADA.userId],
      )
    )[0].n,
    2,
  );
});

test('the last reminder never says the page will pause when it already has, by amount', async () => {
  const first = new Date(NOW.getTime() - 29 * DAY);
  await q(`UPDATE profiles SET created_at = $1`, [
    new Date(first.getTime() - DAY),
  ]);
  await collectTip(TOBI, first);
  await collectTip(TOBI, new Date(first.getTime() + DAY));
  // ₦19,000 held, then the cap is lowered under it: paused by amount before day 28.
  await capFrom(1_000_000n, new Date(first.getTime() + 2 * DAY));
  const day28 = new Date(first.getTime() + 28 * DAY);
  assert.equal(
    (await ops.collectStatus(database.db, TOBI.id, day28)).pausedReason,
    'amount',
  );
  assert.equal(
    await ops.sendCollectReminders(database.db, { now: day28, sealing }),
    1,
  );
  const [notice] = await q(
    `SELECT body FROM notifications WHERE user_id = $1`,
    [TOBI.userId],
  );
  assert.equal(
    notice.body,
    'You have ₦19,000 in tips waiting. Add your bank details to withdraw it.',
  );
});

test('the first withdrawal is capped at ₦50,000', async () => {
  // ₦285,000 to withdraw, from three ₦100,000 tips taken before the recipient was on You collect.
  for (let i = 0; i < 3; i += 1) await directTip(TOBI, 10_000_000n);
  await collect(TOBI);
  await verify(TOBI);
  await payoutRoute(TOBI);
  const status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.firstWithdrawalCapMinor, 5_000_000n);
  assert.equal(status.dailyLimitMinor, 20_000_000n);
  const quote = await ops.withdrawalQuote(database.db, {
    profileId: TOBI.id,
    provider: partner(),
    now: NOW,
  });
  assert.equal(quote.state, 'ready');
  assert.equal(quote.withdrawableMinor, 5_000_000n);
  const over = await withdraw(TOBI, 5_000_001n).catch((error) => error);
  assert.equal(over.code, 'WITHDRAWAL_FIRST_CAP');
  // The spec's words (§10), with the cap in force.
  assert.deepEqual(
    [answered(over).status, answered(over).body.error.message],
    [409, 'New accounts can withdraw up to NGN 50,000 the first time.'],
  );
  assert.equal((await q(`SELECT 1 FROM payouts`)).length, 0);
  assert.equal((await withdraw(TOBI, 5_000_000n)).status, 'REQUESTED');
  // After the first, only the daily limit applies: ₦150,000 more today is ₦200,000 in all.
  assert.equal(
    (await ops.collectStatus(database.db, TOBI.id, NOW))
      .firstWithdrawalCapMinor,
    null,
  );
  assert.equal((await withdraw(TOBI, 6_000_000n)).status, 'REQUESTED');
  // A failed first withdrawal never counted: Ada's first after one failed is still capped.
  for (let i = 0; i < 2; i += 1) await directTip(ADA, 10_000_000n);
  await collect(ADA);
  await verify(ADA);
  await payoutRoute(ADA);
  const failed = await withdraw(ADA, 1_000_000n);
  await q(`UPDATE payouts SET status = 'FAILED' WHERE id = $1`, [
    failed.payoutId,
  ]);
  assert.equal(
    await refusal(() => withdraw(ADA, 6_000_000n)),
    'WITHDRAWAL_FIRST_CAP',
  );
});

test('the daily limit for new accounts counts the Lagos day', async () => {
  for (let i = 0; i < 4; i += 1) await directTip(TOBI, 10_000_000n);
  await collect(TOBI);
  await verify(TOBI, new Date(NOW.getTime() - 5 * DAY));
  await payoutRoute(TOBI);
  const midnight = lagosDayStart(NOW);
  // The first withdrawal, two days ago, so the first-time cap is behind them.
  await withdraw(TOBI, 5_000_000n, new Date(midnight.getTime() - 2 * DAY));
  const late = new Date(midnight.getTime() - 30 * MIN); // 23:30 in Lagos
  const later = new Date(midnight.getTime() - 10 * MIN); // 23:50
  const next = new Date(midnight.getTime() + 10 * MIN); // 00:10 the next day
  assert.equal((await withdraw(TOBI, 15_000_000n, late)).status, 'REQUESTED');
  const over = await withdraw(TOBI, 10_000_000n, later).catch((e) => e);
  assert.equal(over.code, 'WITHDRAWAL_DAILY_LIMIT');
  assert.equal(
    answered(over).body.error.message,
    'New accounts can withdraw up to NGN 200,000 a day.',
  );
  const quote = await ops.withdrawalQuote(database.db, {
    profileId: TOBI.id,
    provider: partner(),
    now: later,
  });
  assert.equal(quote.withdrawableMinor, 5_000_000n);
  assert.equal((await withdraw(TOBI, 10_000_000n, next)).status, 'REQUESTED');
});

test('the daily limit ends 30 days after verification', async () => {
  for (let i = 0; i < 4; i += 1) await directTip(TOBI, 10_000_000n);
  await collect(TOBI);
  // P32: the window runs from verification, not sign-up.
  await verify(TOBI, new Date(NOW.getTime() - 30 * DAY - MIN));
  await payoutRoute(TOBI);
  await withdraw(TOBI, 5_000_000n, new Date(NOW.getTime() - 2 * DAY));
  assert.equal(
    (await ops.collectStatus(database.db, TOBI.id, NOW)).dailyLimitMinor,
    null,
  );
  assert.equal((await withdraw(TOBI, 15_000_000n)).status, 'REQUESTED');
  assert.equal((await withdraw(TOBI, 10_000_000n)).status, 'REQUESTED');
});

test('an account that signed up 40 days ago and verifies today still has the first cap and the daily limit', async () => {
  for (let i = 0; i < 4; i += 1) await directTip(TOBI, 10_000_000n);
  await q(`UPDATE profiles SET created_at = $2 WHERE id = $1`, [
    TOBI.id,
    new Date(NOW.getTime() - 40 * DAY),
  ]);
  // A withdrawal from before You collect is not their first since verification.
  await payoutRoute(TOBI);
  await withdraw(TOBI, 1_000_000n, new Date(NOW.getTime() - 10 * DAY));
  await collect(TOBI);
  await verify(TOBI, new Date(NOW.getTime() - HOUR));
  const status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.firstWithdrawalCapMinor, 5_000_000n);
  assert.equal(status.dailyLimitMinor, 20_000_000n);
  assert.equal(
    await refusal(() => withdraw(TOBI, 6_000_000n)),
    'WITHDRAWAL_FIRST_CAP',
  );
  assert.equal((await withdraw(TOBI, 5_000_000n)).status, 'REQUESTED');
  assert.equal((await withdraw(TOBI, 15_000_000n)).status, 'REQUESTED');
  assert.equal(
    await refusal(() => withdraw(TOBI, 200_000n)),
    'WITHDRAWAL_DAILY_LIMIT',
  );
});

test('money on its way is shown and never withdrawable', async () => {
  await directTip(TOBI, 10_000_000n); // ₦95,000 already in their own account
  await collectTip(TOBI, new Date(NOW.getTime() - HOUR));
  await verify(TOBI, new Date(NOW.getTime() - 3 * DAY));
  await payoutRoute(TOBI);
  await withdraw(TOBI, 1_000_000n, new Date(NOW.getTime() - 2 * DAY));
  const balance = await ops.balanceOf(database.db, TOBI.id);
  assert.deepEqual([balance.keptMinor, balance.onItsWayMinor], [0n, NET]);
  assert.equal(balance.availableMinor, 9_500_000n - 1_000_000n);
  const status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.heldMinor, NET);
  assert.deepEqual([status.keptMinor, status.onItsWayMinor], [0n, NET]);
  const summary = await ops.dashboardSummary(database.db, TOBI.id, NOW);
  assert.deepEqual(
    [summary.keptMinor, summary.onItsWayMinor],
    ['0', String(NET)],
  );
  assert.equal(summary.availableMinor, String(9_500_000n - 1_000_000n));
  const quote = await ops.withdrawalQuote(database.db, {
    profileId: TOBI.id,
    provider: partner(),
    now: NOW,
  });
  assert.equal(quote.withdrawableMinor, 8_500_000n);
  assert.equal(
    await refusal(() => withdraw(TOBI, 8_500_000n + NET)),
    'INSUFFICIENT_BALANCE',
  );
  // An unverified recipient's waiting money is not on its way yet: it is kept for them.
  await collectTip(ADA, new Date(NOW.getTime() - HOUR));
  const ada = await ops.collectStatus(database.db, ADA.id, NOW);
  assert.deepEqual(
    [ada.heldMinor, ada.keptMinor, ada.onItsWayMinor],
    [NET, NET, 0n],
  );
  const adaBalance = await ops.balanceOf(database.db, ADA.id);
  assert.deepEqual(
    [adaBalance.availableMinor, adaBalance.keptMinor, adaBalance.onItsWayMinor],
    [0n, NET, 0n],
  );
  const adaSummary = await ops.dashboardSummary(database.db, ADA.id, NOW);
  assert.deepEqual(
    [adaSummary.keptMinor, adaSummary.onItsWayMinor],
    [String(NET), '0'],
  );
});

test('a direct recipient’s withdrawals and page are unchanged', async () => {
  for (let i = 0; i < 4; i += 1) await directTip(TOBI, 10_000_000n);
  await payoutRoute(TOBI);
  const status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.deepEqual(
    {
      mode: status.mode,
      paused: status.paused,
      heldMinor: status.heldMinor,
      onItsWayMinor: status.onItsWayMinor,
      firstWithdrawalCapMinor: status.firstWithdrawalCapMinor,
      dailyLimitMinor: status.dailyLimitMinor,
    },
    {
      mode: 'direct',
      paused: false,
      heldMinor: 0n,
      onItsWayMinor: 0n,
      firstWithdrawalCapMinor: null,
      dailyLimitMinor: null,
    },
  );
  const quote = await ops.withdrawalQuote(database.db, {
    profileId: TOBI.id,
    provider: partner(),
    now: NOW,
  });
  assert.equal(quote.withdrawableMinor, 38_000_000n);
  // A first withdrawal above ₦50,000 and ₦300,000 in a day: as today, and (M4) without a single
  // read of You collect's settings or transfers on the way.
  const seen = await statements(async () => {
    await ops.withdrawalQuote(database.db, {
      profileId: TOBI.id,
      provider: partner(),
      now: NOW,
    });
    assert.equal((await withdraw(TOBI, 15_000_000n)).status, 'REQUESTED');
  });
  assert.ok(seen.length > 0);
  assert.deepEqual(
    seen.filter((text) => /collect_settings|collect_transfers/.test(text)),
    [],
  );
  assert.equal((await withdraw(TOBI, 15_000_000n)).status, 'REQUESTED');
  const balance = await ops.balanceOf(database.db, TOBI.id);
  assert.deepEqual(balance, {
    availableMinor: 8_000_000n,
    confirmingMinor: 0n,
    keptMinor: 0n,
    onItsWayMinor: 0n,
  });
  // The page takes tips however long ago and however much: nothing is held.
  assert.equal(
    (await quoteAt(TOBI, new Date(NOW.getTime() + 60 * DAY))).collectionMode,
    'direct',
  );
  // The reminder sweep never writes to them.
  assert.equal(
    await ops.sendCollectReminders(database.db, {
      now: new Date(NOW.getTime() + 7 * DAY),
      sealing,
    }),
    0,
  );
});
