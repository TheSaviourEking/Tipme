import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { PlatformRefusalError } from '../../packages/payments/dist/index.js';
import { setSwitch } from './helpers.mjs';

/*
 * You collect (plan Task 11, spec §4 and §6.3, rulings P9, P10, P11): TipMe's own money in its
 * partner balance is what is there less what it holds for recipients (`held_for_recipients`), per
 * currency. Every reserve check records it, warns below ₦500,000, pages staff and emails the owners
 * below ₦250,000, and below zero (the rule broken) opens a money issue and pauses You collect
 * sign-ups. Moves of TipMe's own money ask `ownMoneyAllows` first. No partner is called: stand-ins
 * answer instead.
 */

const [ADA, TOBI] = ops.DEMO_PROFILES;
const GROSS = 1_000_000n; // ₦10,000 on Free: TipMe keeps 5%.
const NET = 950_000n;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date(Math.floor(Date.now() / MIN) * MIN - 3 * DAY);
const at = (ms) => new Date(T0.getTime() + ms);
/** How a quote is made with the switch on (the API passes these). */
const SWITCHED_ON = {
  youCollectOn: true,
  provider: 'bachs',
  environment: 'sandbox',
};
const WARNING = 50_000_000n; // ₦500,000
const CRITICAL = 25_000_000n; // ₦250,000

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
  await q(`UPDATE profiles SET created_at = $1`, [at(-30 * DAY)]);
});

/** A paid collect tip (Task 7): its net is held for the recipient until it is transferred. */
async function paidTip(profile, settledAt = T0) {
  const { db } = database;
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    profile.id,
  ]);
  const quote = await ops.createQuote(db, {
    handle: profile.handle,
    tipMinor: GROSS,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
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
          amountMinor: GROSS,
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
  return { tipId: intent.tipId };
}

/** TipMe's own account at the partner: its balances and its payout schedule, as scripted. */
function platform(balances, schedule = { NGN: 'manual' }) {
  const state = { balances, schedule, reads: 0 };
  return {
    state,
    provider: {
      name: 'bachs-sandbox',
      async platformBalances() {
        state.reads += 1;
        if (state.balances instanceof Error) throw state.balances;
        return state.balances.map(([currency, availableMinor]) => ({
          currency,
          availableMinor,
          pendingMinor: 0n,
        }));
      },
      async platformPayoutSchedule() {
        if (state.schedule instanceof Error) throw state.schedule;
        return state.schedule;
      },
    },
  };
}

/** Runs checks and collects what staff and owners would have been told. */
function told() {
  const alerts = [];
  const emails = [];
  return {
    alerts,
    emails,
    alert: async (text, level) => {
      alerts.push({ text, level });
    },
    emailOwners: async (text) => {
      emails.push(text);
    },
  };
}
const check = (provider, tell, now = new Date()) =>
  ops.checkCollectReserve(database.db, {
    provider,
    alert: tell.alert,
    emailOwners: tell.emailOwners,
    now,
  });
const ngn = (result) => result.perCurrency.find((c) => c.currency === 'NGN');
const openIssues = (kind) =>
  q(`SELECT id, summary FROM issues WHERE kind = $1 AND status = 'open'`, [
    kind,
  ]);

test("TipMe's own money is the balance minus what is held, per currency", async () => {
  await paidTip(TOBI);
  await paidTip(ADA);
  const held = 2n * NET;
  assert.equal(await ops.heldTotal(database.db, 'NGN'), held);
  assert.equal(await ops.heldTotal(database.db, 'USD'), 0n);
  const { provider } = platform([
    ['NGN', 100_000_000n],
    ['USD', 5_000n],
  ]);
  const tell = told();
  const now = new Date();
  const result = await check(provider, tell, now);
  assert.equal(result.autoPayoutOn, false);
  assert.deepEqual(
    result.perCurrency.sort((a, b) => a.currency.localeCompare(b.currency)),
    [
      {
        currency: 'NGN',
        availableMinor: 100_000_000n,
        heldMinor: held,
        ownMinor: 100_000_000n - held,
        level: 'ok',
      },
      {
        currency: 'USD',
        availableMinor: 5_000n,
        heldMinor: 0n,
        ownMinor: 5_000n,
        level: 'ok',
      },
    ],
  );
  assert.deepEqual(tell.alerts, []);
  // One reading per currency (P9: its own table; today's NGN reserve readings are untouched).
  const readings = await q(
    `SELECT currency, available_minor::text AS available, held_minor::text AS held,
            own_minor::text AS own, level
       FROM collect_reserve_readings ORDER BY currency`,
  );
  assert.deepEqual(readings, [
    {
      currency: 'NGN',
      available: '100000000',
      held: String(held),
      own: String(100_000_000n - held),
      level: 'ok',
    },
    { currency: 'USD', available: '5000', held: '0', own: '5000', level: 'ok' },
  ]);
  assert.deepEqual(await q(`SELECT 1 FROM payment_reserve_readings`), []);
  // Moving TipMe's own money asks this reading: what is held is never TipMe's to move.
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 100_000_000n - held,
      currency: 'NGN',
      voluntary: false,
      now,
    }),
    true,
  );
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 100_000_000n - held + 1n,
      currency: 'NGN',
      voluntary: false,
      now,
    }),
    false,
  );
});

test('below ₦500,000 warns, below ₦250,000 pages and emails owners, below held is broken and pauses collect sign-ups', async () => {
  await paidTip(TOBI);
  const held = NET;
  const { provider, state } = platform([['NGN', held + WARNING - 1n]]);
  const tell = told();

  const warned = await check(provider, tell, at(0));
  assert.equal(ngn(warned).level, 'warning');
  assert.equal(tell.alerts.length, 1);
  assert.equal(tell.alerts[0].level, 'warning');
  assert.match(tell.alerts[0].text, /bachs-sandbox/);
  assert.match(tell.alerts[0].text, /₦499,999\.99/);
  assert.deepEqual(tell.emails, []);
  // Voluntary moves still go ahead above the critical line.
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 1_000n,
      currency: 'NGN',
      voluntary: true,
      now: at(0),
    }),
    true,
  );
  // The same level again within 6 hours says nothing more.
  await check(provider, tell, at(15 * MIN));
  assert.equal(tell.alerts.length, 1);

  state.balances = [['NGN', held + CRITICAL - 1n]];
  const critical = await check(provider, tell, at(30 * MIN));
  assert.equal(ngn(critical).level, 'critical');
  assert.equal(tell.alerts.length, 2);
  assert.equal(tell.alerts[1].level, 'critical');
  assert.equal(tell.emails.length, 1);
  assert.match(tell.emails[0], /₦249,999\.99/);
  assert.equal((await openIssues('collect_reserve_low')).length, 1);
  // At critical, voluntary moves of TipMe's own money are refused; owed ones still go.
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 1n,
      currency: 'NGN',
      voluntary: true,
      now: at(30 * MIN),
    }),
    false,
  );
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 5_000n,
      currency: 'NGN',
      voluntary: false,
      now: at(30 * MIN),
    }),
    true,
  );
  assert.equal(await ops.collectSignupsPaused(database.db), false);

  state.balances = [['NGN', held - 1n]];
  const broken = await check(provider, tell, at(45 * MIN));
  assert.equal(ngn(broken).level, 'broken');
  assert.equal(ngn(broken).ownMinor, -1n);
  assert.equal(tell.alerts.length, 3);
  assert.equal(tell.alerts[2].level, 'critical');
  assert.equal(tell.emails.length, 2);
  assert.equal((await openIssues('collect_invariant_broken')).length, 1);
  assert.equal(await ops.collectSignupsPaused(database.db), true);
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 1n,
      currency: 'NGN',
      voluntary: false,
      now: at(45 * MIN),
    }),
    false,
  );
  // Checked again while broken: still one issue, no new alert within 6 hours.
  await check(provider, tell, at(60 * MIN));
  assert.equal((await openIssues('collect_invariant_broken')).length, 1);
  assert.equal(tell.alerts.length, 3);

  // P11: while it is open, a new sign-up is written undecided (null, so direct)...
  const [{ id: userId }] = await q(
    `INSERT INTO users (id, phone_e164) VALUES (gen_random_uuid(), '+2348000009911') RETURNING id`,
  );
  const page = await ops.claimHandle(database.db, {
    userId,
    handle: 'newcomer',
    youCollectOn: true,
  });
  const [signedUp] = await q(
    `SELECT collection_mode FROM profiles WHERE id = $1`,
    [page.profileId],
  );
  assert.equal(signedUp.collection_mode, null);
  // ...and its first quote stays direct, leaving it undecided for a later quote.
  await q(`UPDATE profiles SET page_state = 'live' WHERE id = $1`, [
    page.profileId,
  ]);
  await q(`UPDATE profiles SET collection_mode = NULL WHERE id = $1`, [ADA.id]);
  const quote = await ops.createQuote(database.db, {
    handle: 'ada',
    tipMinor: GROSS,
    currency: 'NGN',
    ...SWITCHED_ON,
  });
  const [quoted] = await q(
    `SELECT collection_mode FROM tip_quotes WHERE id = $1`,
    [quote.quoteId],
  );
  assert.equal(quoted.collection_mode, 'direct');
  const [ada] = await q(`SELECT collection_mode FROM profiles WHERE id = $1`, [
    ADA.id,
  ]);
  assert.equal(ada.collection_mode, null);
  // Recipients already on collect are untouched: their tips are still collected.
  const tobiQuote = await ops.createQuote(database.db, {
    handle: 'tobi',
    tipMinor: GROSS,
    currency: 'NGN',
    ...SWITCHED_ON,
  });
  const [tobiQuoted] = await q(
    `SELECT collection_mode FROM tip_quotes WHERE id = $1`,
    [tobiQuote.quoteId],
  );
  assert.equal(tobiQuoted.collection_mode, 'collect');

  // Staff clear it once topped up: sign-ups resume (and Ada's next quote decides her).
  const [issue] = await openIssues('collect_invariant_broken');
  await q(
    `UPDATE issues SET status = 'resolved', resolved_at = now() WHERE id = $1`,
    [issue.id],
  );
  assert.equal(await ops.collectSignupsPaused(database.db), false);
  const later = await ops.createQuote(database.db, {
    handle: 'ada',
    tipMinor: GROSS,
    currency: 'NGN',
    ...SWITCHED_ON,
  });
  const [laterQuoted] = await q(
    `SELECT collection_mode FROM tip_quotes WHERE id = $1`,
    [later.quoteId],
  );
  assert.equal(laterQuoted.collection_mode, 'collect');
});

test('the sign-up gate is the injected reserve check: a refusal writes null, an allow writes collect', async () => {
  // Runtime, not only by source: mayAssignCollect asks the check it is given.
  assert.equal(
    await ops.mayAssignCollect(database.db, {
      signupsPaused: async () => true,
    }),
    false,
  );
  assert.equal(
    await ops.mayAssignCollect(database.db, {
      signupsPaused: async () => false,
    }),
    true,
  );
  // By default it reads the open collect_invariant_broken issue.
  assert.equal(await ops.mayAssignCollect(database.db), true);
  await ops.openIssue(database.db, {
    dedupeKey: `collect_invariant_broken.${randomUUID()}`,
    kind: 'collect_invariant_broken',
    subject: {},
    now: new Date(),
  });
  assert.equal(await ops.mayAssignCollect(database.db), false);
  assert.equal(await ops.signUpCollectionMode(database.db, true), null);
  assert.equal(await ops.signUpCollectionMode(database.db, false), null);
});

test('the collect preview says direct for undecided recipients while sign-ups are paused (Task 14)', async (t) => {
  // previewCollectionMode arrives with Task 14 (PR #316); it shares the quote's rules through
  // mayAssignCollect, so this runs once both are merged.
  if (typeof ops.previewCollectionMode !== 'function') {
    t.skip('previewCollectionMode is not on this branch yet (Task 14)');
    return;
  }
  const inputs = (profileId) => ({
    profileId,
    switchOn: true,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await q(`UPDATE profiles SET collection_mode = NULL WHERE id = $1`, [ADA.id]);
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    TOBI.id,
  ]);
  assert.equal(
    await ops.previewCollectionMode(database.db, inputs(ADA.id)),
    'collect',
  );
  await ops.openIssue(database.db, {
    dedupeKey: `collect_invariant_broken.${randomUUID()}`,
    kind: 'collect_invariant_broken',
    subject: {},
    now: new Date(),
  });
  assert.equal(
    await ops.previewCollectionMode(database.db, inputs(ADA.id)),
    'direct',
  );
  assert.equal(
    await ops.previewCollectionMode(database.db, inputs(TOBI.id)),
    'collect',
  );
});

test('a negative USD balance pages staff even when NGN is above the line', async () => {
  await paidTip(TOBI);
  const { provider } = platform([
    ['NGN', 900_000_000n],
    ['USD', -1_500n],
  ]);
  const tell = told();
  const result = await check(provider, tell);
  assert.equal(ngn(result).level, 'ok');
  const usd = result.perCurrency.find((c) => c.currency === 'USD');
  assert.deepEqual(usd, {
    currency: 'USD',
    availableMinor: -1_500n,
    heldMinor: 0n,
    ownMinor: -1_500n,
    level: 'critical',
  });
  assert.equal(tell.alerts.length, 1);
  assert.equal(tell.alerts[0].level, 'critical');
  assert.match(tell.alerts[0].text, /USD/);
  assert.match(tell.alerts[0].text, /negative/);
  assert.equal(tell.emails.length, 1);
  // Nothing is held in dollars, so the rule isn't broken: sign-ups go on.
  assert.equal(await ops.collectSignupsPaused(database.db), false);
  const [issue] = await openIssues('collect_reserve_low');
  assert.match(issue.summary, /USD/);
});

test("automatic payouts on TipMe's balance raise a critical alert", async () => {
  await paidTip(TOBI);
  const { provider, state } = platform([['NGN', 900_000_000n]], {
    NGN: 'daily',
  });
  const tell = told();
  const result = await check(provider, tell, at(0));
  assert.equal(result.autoPayoutOn, true);
  assert.equal(tell.alerts.length, 1);
  assert.equal(tell.alerts[0].level, 'critical');
  assert.match(tell.alerts[0].text, /[Aa]utomatic payouts/);
  assert.equal((await openIssues('collect_auto_payout_on')).length, 1);
  // Still on at the next check: one issue, one alert.
  await check(provider, tell, at(15 * MIN));
  assert.equal(tell.alerts.length, 1);
  assert.equal((await openIssues('collect_auto_payout_on')).length, 1);
  // Turned off: nothing more.
  state.schedule = { NGN: 'manual' };
  assert.equal((await check(provider, tell, at(30 * MIN))).autoPayoutOn, false);
  assert.equal(tell.alerts.length, 1);
});

test('two reserve checks at once send one alert', async () => {
  await paidTip(TOBI);
  const { provider } = platform([['NGN', NET + CRITICAL - 1n]]);
  const alerts = [];
  const emails = [];
  const slow = {
    alert: async (text, level) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      alerts.push({ text, level });
    },
    emailOwners: async (text) => {
      emails.push(text);
    },
  };
  const now = new Date();
  await Promise.all([check(provider, slow, now), check(provider, slow, now)]);
  assert.equal(alerts.length, 1);
  assert.equal(emails.length, 1);
  assert.equal((await openIssues('collect_reserve_low')).length, 1);
});

test('an alert that fails is sent again at the next check', async () => {
  await paidTip(TOBI);
  const { provider } = platform([['NGN', NET + WARNING - 1n]]);
  let fail = true;
  const sent = [];
  const tell = {
    alert: async (text) => {
      if (fail) throw new Error('alert_route_unreachable');
      sent.push(text);
    },
    emailOwners: async () => {},
  };
  await check(provider, tell, at(0));
  fail = false;
  await check(provider, tell, at(15 * MIN));
  assert.equal(sent.length, 1);
});

test('an unreadable balance is recorded as unknown, and moves of own money wait on it', async () => {
  await paidTip(TOBI);
  const { provider } = platform(new Error('unreadable'));
  const tell = told();
  const result = await check(provider, tell);
  assert.equal(result.unreadable, true);
  const [reading] = await q(
    `SELECT available_minor, own_minor, level FROM collect_reserve_readings WHERE currency = 'NGN'`,
  );
  assert.deepEqual(reading, {
    available_minor: null,
    own_minor: null,
    level: null,
  });
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 1n,
      currency: 'NGN',
      voluntary: false,
    }),
    false,
  );
});

test('a reading too old to trust refuses a move of own money while money is held', async () => {
  await paidTip(TOBI);
  const { provider } = platform([['NGN', 900_000_000n]]);
  await check(provider, told(), at(0));
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 1n,
      currency: 'NGN',
      voluntary: false,
      now: at(10 * MIN),
    }),
    true,
  );
  assert.equal(
    await ops.ownMoneyAllows(database.db, {
      amountMinor: 1n,
      currency: 'NGN',
      voluntary: false,
      now: at(ops.RESERVE_STALE_AFTER_MS + MIN),
    }),
    false,
  );
});

test('P10: with nothing held, ownMoneyAllows changes nothing and the levels are not applied', async () => {
  // No reading at all, nothing held: every move goes ahead exactly as before You collect.
  assert.equal(await ops.heldTotal(database.db, 'NGN'), 0n);
  for (const voluntary of [true, false])
    assert.equal(
      await ops.ownMoneyAllows(database.db, {
        amountMinor: 10_000_000_000n,
        currency: 'NGN',
        voluntary,
      }),
      true,
    );
  // With the switch off and nothing held, a small balance is not a You collect warning.
  await setSwitch(database.pool, 'you_collect', false);
  const tell = told();
  const result = await check(platform([['NGN', 1_000n]]).provider, tell);
  assert.equal(ngn(result).level, 'ok');
  assert.deepEqual(tell.alerts, []);
});

/* Moves of TipMe's own money: the payout fee it covers, and the fee it returns (non-voluntary, P10). */

const ACCOUNT = 'acct_ada_direct';

/** Ada, direct, with ₦19,000 to withdraw and TipMe paying the payout fee (the previous rule). */
async function directWithdrawal() {
  const { db } = database;
  await q(`UPDATE profiles SET collection_mode = 'direct' WHERE id = $1`, [
    ADA.id,
  ]);
  const quote = await ops.createQuote(db, {
    handle: 'ada',
    tipMinor: 2_000_000n,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `${ACCOUNT}:chk_${randomUUID().slice(0, 8)}`;
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
    amountMinor: 2_000_000n,
    currency: 'NGN',
    providerFeeMinor: 30_000n,
    signatureVerified: true,
    payload: {},
  });
  await q(
    `INSERT INTO payment_accounts
       (id, profile_id, provider, environment, provider_account_reference, status,
        charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
     VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, 'platform', now())`,
    [randomUUID(), ADA.id, ACCOUNT],
  );
  await q(
    `INSERT INTO payout_destinations
       (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
     VALUES ($1, $2, 'bachs', 'ba_ada', '058', 'Guaranty Trust Bank', '4321', 'usable')`,
    [randomUUID(), ADA.id],
  );
  const { payoutId } = await ops.requestWithdrawal(db, {
    profileId: ADA.id,
    amountMinor: 400_000n,
    idempotencyKey: randomUUID(),
    provider: payer(),
  });
  await q(
    `UPDATE payouts SET fee_payer = 'tipme', amount_minor = amount_minor + user_fee_minor,
       user_fee_minor = 0 WHERE id = $1`,
    [payoutId],
  );
  return payoutId;
}

function payer() {
  const provider = {
    name: 'bachs-sandbox',
    environment: 'sandbox',
    capabilities: { connectedAccounts: true },
    calls: [],
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
    async payoutBalance() {
      return { availableMinor: 1_800_000n };
    },
    async quotePayoutFee() {
      return { feeMinor: 5_000n, exact: false };
    },
    async coverPayoutFee(input) {
      provider.calls.push({ call: 'fee', ...input });
      return { transferRef: `tr_${input.idempotencyKey}` };
    },
    async initiatePayout(input) {
      provider.calls.push({ call: 'payout', ...input });
      return {
        providerReference: `${ACCOUNT}:po_${input.payoutId}`,
        status: 'pending',
      };
    },
    async findPayoutByReference() {
      return null;
    },
  };
  return provider;
}

test('a payout-fee cover or fee return that would break the rule is refused and waits', async () => {
  await paidTip(TOBI);
  const payoutId = await directWithdrawal();
  // TipMe's balance holds only Tobi's money, less ₦10: covering a ₦50 fee would spend his.
  const { provider: reader } = platform([['NGN', NET + 1_000n]]);
  await check(reader, told(), new Date());
  const provider = payer();
  assert.equal(
    await ops.startPayout(database.db, { payoutId, provider }),
    'waiting_on_platform',
  );
  // Nothing was asked of the partner, and the withdrawal waits as it does on an empty reserve.
  assert.deepEqual(provider.calls, []);
  const [payout] = await q(
    `SELECT status, start_step, start_uncertain_at, platform_wait_since FROM payouts WHERE id = $1`,
    [payoutId],
  );
  assert.equal(payout.status, 'REQUESTED');
  assert.equal(payout.start_step, null);
  assert.equal(payout.start_uncertain_at, null);
  assert.ok(payout.platform_wait_since);
  assert.equal((await openIssues('reserve_empty')).length, 1);

  // A fee return (a chargeback's: TipMe owes it) waits the same way: no transfer is asked for.
  const tip = await paidTip(ADA);
  await q(
    `INSERT INTO share_transfers (id, tip_id, kind, profile_id, currency, amount_minor, deliver_minor,
       status, provider, partner_reversal_id)
     VALUES ($1, $2, 'fee_return', $3, 'NGN', 50000, 50000, 'out_paid', 'bachs', 'refund.rf_x')`,
    [randomUUID(), tip.tipId, ADA.id],
  );
  const sent = [];
  const mover = {
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: false },
    async payoutBalance() {
      return { availableMinor: 0n };
    },
    async transferToAccount(input) {
      sent.push(input.amountMinor);
      return { transferRef: `tr_${sent.length}`, status: 'paid' };
    },
    async findPlatformCollection() {
      return null;
    },
  };
  const later = new Date(Date.now() + 2 * HOUR);
  await ops.runShareTransfers(database.db, {
    provider: mover,
    now: later,
    settleWaitMs: HOUR,
  });
  assert.deepEqual(sent, []);
  const [feeReturn] = await q(
    `SELECT status FROM share_transfers WHERE kind = 'fee_return'`,
  );
  assert.equal(feeReturn.status, 'out_paid');

  // Topped up: the next reading lets both go (an owed move is allowed below the critical line).
  await check(
    platform([['NGN', 2n * NET + 100_000n]]).provider,
    told(),
    new Date(),
  );
  await q(
    `UPDATE share_transfers SET next_attempt_at = now() - interval '1 minute'`,
  );
  assert.equal(
    await ops.startPayout(database.db, { payoutId, provider }),
    'started',
  );
  assert.deepEqual(
    provider.calls.map((c) => c.call),
    ['fee', 'payout'],
  );
  await ops.runShareTransfers(database.db, {
    provider: mover,
    now: later,
    settleWaitMs: HOUR,
  });
  assert.deepEqual(sent, [50_000n]);
});

test('P10: with nothing held, a payout-fee cover goes ahead with no reading at all', async () => {
  const payoutId = await directWithdrawal();
  const provider = payer();
  assert.equal(
    await ops.startPayout(database.db, { payoutId, provider }),
    'started',
  );
  assert.deepEqual(
    provider.calls.map((c) => c.call),
    ['fee', 'payout'],
  );
  assert.ok(PlatformRefusalError);
});
