import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ApiExceptionFilter } from '../../apps/api/dist/http/api-exception.filter.js';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { lagosDayStart } from '../../packages/domain/dist/index.js';
import { setSwitch } from './helpers.mjs';

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

const quoteAt = (profile, now) =>
  ops.createQuote(database.db, {
    handle: profile.handle,
    tipMinor: GROSS,
    currency: 'NGN',
    now,
  });

test('the holding cap pauses the page at ₦50,000 held or after 30 days, whichever comes first', async () => {
  // Amount first: five ₦9,500 shares are ₦47,500, still taking tips; the sixth makes ₦57,000.
  for (let i = 0; i < 5; i += 1)
    await collectTip(TOBI, new Date(NOW.getTime() - (10 - i) * MIN));
  let status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.mode, 'collect');
  assert.equal(status.verified, false);
  assert.equal(status.heldMinor, 5n * NET);
  assert.equal(status.paused, false);
  assert.equal(status.pausedReason, null);
  await collectTip(TOBI, new Date(NOW.getTime() - 4 * MIN));
  status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.heldMinor, 6n * NET);
  assert.deepEqual([status.paused, status.pausedReason], [true, 'amount']);
  assert.equal(await refusal(() => quoteAt(TOBI, NOW)), 'PAGE_PAUSED');
  // Nothing was written for the refused quote.
  assert.equal((await q(`SELECT count(*)::int AS n FROM tip_quotes`))[0].n, 6);

  // Days: one small tip 30 days ago pauses the page on day 30, to the minute, not before.
  const first = new Date(NOW.getTime() - 30 * DAY + HOUR);
  await collectTip(ADA, first);
  status = await ops.collectStatus(database.db, ADA.id, NOW);
  assert.equal(status.firstWaitingAt.getTime(), first.getTime());
  assert.equal(status.pauseOn.getTime(), first.getTime() + 30 * DAY);
  assert.equal(status.paused, false);
  assert.equal((await quoteAt(ADA, NOW)).collectionMode, 'collect');
  const day30 = new Date(first.getTime() + 30 * DAY);
  status = await ops.collectStatus(database.db, ADA.id, day30);
  assert.deepEqual([status.paused, status.pausedReason], [true, 'days']);
  assert.equal(await refusal(() => quoteAt(ADA, day30)), 'PAGE_PAUSED');
  assert.equal(
    (await quoteAt(ADA, new Date(day30.getTime() - MIN))).collectionMode,
    'collect',
  );

  // The cap is an admin setting, read when used: raised, Tobi takes tips again.
  await q(
    `INSERT INTO collect_settings (id, cap_minor, cap_days, reminder_days, delay_hours, delay_for_days,
       first_withdrawal_cap_minor, new_daily_limit_minor, new_daily_limit_days,
       reserve_warning_minor, reserve_critical_minor, effective_from, reason)
     VALUES (gen_random_uuid(), 10000000, 30, '{7,21,28}', 24, 7, 5000000, 20000000, 30,
       50000000, 25000000, $1, 'Raised in a test')`,
    [new Date(NOW.getTime() - MIN)],
  );
  assert.equal((await quoteAt(TOBI, NOW)).collectionMode, 'collect');
});

test('adding verified bank details unpauses the page at once', async () => {
  for (let i = 0; i < 6; i += 1)
    await collectTip(TOBI, new Date(NOW.getTime() - (10 - i) * MIN));
  assert.equal(await refusal(() => quoteAt(TOBI, NOW)), 'PAGE_PAUSED');
  // Task 13 writes this when the name and bank account check out.
  await verify(TOBI);
  const status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.verified, true);
  assert.deepEqual([status.paused, status.pausedReason], [false, null]);
  assert.equal((await quoteAt(TOBI, NOW)).collectionMode, 'collect');
  // Old held money never pauses a verified page either.
  assert.equal(
    (await quoteAt(TOBI, new Date(NOW.getTime() + 40 * DAY))).collectionMode,
    'collect',
  );
});

test('a supporter of a paused page is told only that the person can’t take tips right now', async () => {
  for (let i = 0; i < 6; i += 1)
    await collectTip(TOBI, new Date(NOW.getTime() - (10 - i) * MIN));
  let thrown;
  try {
    await quoteAt(TOBI, NOW);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'PAGE_PAUSED');
  // What the API answers for it, through the real filter.
  const sent = answered(thrown);
  assert.equal(sent.status, 409);
  assert.deepEqual(Object.keys(sent.body.error).sort(), [
    'code',
    'message',
    'reference',
  ]);
  assert.equal(sent.body.error.code, 'PAGE_PAUSED');
  assert.equal(
    sent.body.error.message,
    'This page can’t take tips right now. Please try again later.',
  );
  assert.doesNotMatch(
    JSON.stringify(sent.body),
    /bank|cap|held|₦|NGN|days|verif/i,
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
    [7, 21, 28].map((day) => `collect_reminder.${TOBI.id}.${day}`),
  );
  // The email is rendered from the same words.
  const [mail] = await q(
    `SELECT data_sealed FROM mail_messages WHERE dedupe_key = $1`,
    [`collect_reminder.${TOBI.id}.28`],
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
  await verify(ADA, adaAt(10));
  assert.equal(await remind(adaAt(21)), 0);
  assert.equal(
    (
      await q(
        `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`,
        [ADA.userId],
      )
    )[0].n,
    1,
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
  await verify(TOBI);
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

test('the daily limit ends after 30 days', async () => {
  for (let i = 0; i < 4; i += 1) await directTip(TOBI, 10_000_000n);
  await collect(TOBI);
  await verify(TOBI);
  await payoutRoute(TOBI);
  await q(`UPDATE profiles SET created_at = $2 WHERE id = $1`, [
    TOBI.id,
    new Date(NOW.getTime() - 30 * DAY - MIN),
  ]);
  await withdraw(TOBI, 5_000_000n, new Date(NOW.getTime() - 2 * DAY));
  assert.equal(
    (await ops.collectStatus(database.db, TOBI.id, NOW)).dailyLimitMinor,
    null,
  );
  assert.equal((await withdraw(TOBI, 15_000_000n)).status, 'REQUESTED');
  assert.equal((await withdraw(TOBI, 10_000_000n)).status, 'REQUESTED');
});

test('money on its way is shown and never withdrawable', async () => {
  await directTip(TOBI, 10_000_000n); // ₦95,000 already in their own account
  await collectTip(TOBI, new Date(NOW.getTime() - HOUR));
  await verify(TOBI);
  await payoutRoute(TOBI);
  await withdraw(TOBI, 1_000_000n, new Date(NOW.getTime() - 2 * DAY));
  const balance = await ops.balanceOf(database.db, TOBI.id);
  assert.equal(balance.onItsWayMinor, NET);
  assert.equal(balance.availableMinor, 9_500_000n - 1_000_000n);
  const status = await ops.collectStatus(database.db, TOBI.id, NOW);
  assert.equal(status.heldMinor, NET);
  assert.equal(status.onItsWayMinor, NET);
  const summary = await ops.dashboardSummary(database.db, TOBI.id, NOW);
  assert.equal(summary.onItsWayMinor, String(NET));
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
  assert.deepEqual([ada.heldMinor, ada.onItsWayMinor], [NET, 0n]);
  assert.equal((await ops.balanceOf(database.db, ADA.id)).availableMinor, 0n);
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
  // A first withdrawal above ₦50,000 and ₦300,000 in a day: as today.
  assert.equal((await withdraw(TOBI, 15_000_000n)).status, 'REQUESTED');
  assert.equal((await withdraw(TOBI, 15_000_000n)).status, 'REQUESTED');
  const balance = await ops.balanceOf(database.db, TOBI.id);
  assert.deepEqual(balance, {
    availableMinor: 8_000_000n,
    confirmingMinor: 0n,
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
