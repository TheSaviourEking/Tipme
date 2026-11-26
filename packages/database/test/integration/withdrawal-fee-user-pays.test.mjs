import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  businessWithdrawalQuote,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  recordPayoutOutcome,
  recordProviderEvent,
  requestBusinessWithdrawal,
  requestWithdrawal,
  setFeatureSwitch,
  startPayout,
  withdrawalQuote,
} from '../../dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;
const ACCOUNT = 'acct_tobi_user_pays';

// The owner, 25 Nov 2026: a person pays the partner's ₦50 withdrawal fee from the amount on every
// withdrawal (it replaces 18 Nov's two free a day). The one exception is an unused top-up TipMe
// already sent to their account, which pays the fee first. A business is unchanged.

/** A partner with connected accounts, as the real one has; it records every money call. */
function partner() {
  const calls = { covers: [], payouts: [] };
  return {
    calls,
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: true },
    payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
    payoutBalance: async () => ({ availableMinor: 100_000_000n }),
    quotePayoutFee: async () => ({ feeMinor: 5000n, exact: false }),
    coverPayoutFee: async (input) => {
      calls.covers.push(input);
      return { transferRef: `tr_${randomUUID().slice(0, 8)}` };
    },
    initiatePayout: async (input) => {
      calls.payouts.push(input);
      return { providerReference: `po_${randomUUID()}`, status: 'pending' };
    },
    findPayoutByReference: async () => null,
    fetchPayoutStatus: async () => ({ status: 'not_found' }),
  };
}

async function setup(t) {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  await database.fresh();
  await q(
    `INSERT INTO payment_accounts
       (id, profile_id, provider, environment, provider_account_reference, status,
        charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
     VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, 'platform', now())`,
    [randomUUID(), TOBI.id, ACCOUNT],
  );
  const destinationId = randomUUID();
  await q(
    `INSERT INTO payout_destinations
       (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
     VALUES ($1, $2, 'bachs', $3, '058', 'Guaranty Trust Bank', '4321', 'usable')`,
    [destinationId, TOBI.id, `ba_${destinationId.slice(0, 8)}`],
  );
  /** A ₦10,000 tip collected on Tobi's account: ₦9,500 to Tobi on Free (5%). */
  const tip = async () => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: 1_000_000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const reference = `${ACCOUNT}:chk_${randomUUID().slice(0, 8)}`;
    await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'bachs',
      providerReference: reference,
    });
    await recordProviderEvent(db, {
      provider: 'bachs',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: 1_000_000n,
      currency: 'NGN',
      providerFeeMinor: 15_000n,
      signatureVerified: true,
      payload: {},
    });
  };
  const withdraw = (provider, amountMinor, extra = {}) =>
    requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor,
      idempotencyKey: randomUUID(),
      providers: { active: provider, withdrawOnly: [] },
      ...extra,
    });
  const quote = (provider) =>
    withdrawalQuote(db, {
      profileId: TOBI.id,
      providers: { active: provider, withdrawOnly: [] },
    });
  const payout = async (id) =>
    (await q('SELECT * FROM payouts WHERE id = $1', [id]))[0];
  const codeOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code ?? String(error);
    }
  };
  return { database, db, q, tip, withdraw, quote, payout, codeOf };
}

test('a person’s first withdrawal of the day pays the fee from the amount', async (t) => {
  const s = await setup(t);
  await s.tip();
  await s.tip();
  const provider = partner();
  const before = await s.quote(provider);
  assert.equal(before.feePaidBy, 'user');
  assert.equal(before.freePerDay, 0);
  assert.equal(before.feeMinor, 5000n);
  const { payoutId } = await s.withdraw(provider, 1_000_000n);
  const row = await s.payout(payoutId);
  assert.equal(row.fee_payer, 'user');
  assert.equal(row.user_fee_minor, '5000');
  assert.equal(row.amount_minor, '995000');
});

test('an unused top-up on the person’s account pays the fee first', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const old = await s.withdraw(provider, 300_000n);
  await s.q(`UPDATE payouts SET status = 'FAILED' WHERE id = $1`, [
    old.payoutId,
  ]);
  await s.q(
    `INSERT INTO provider_fee_credits (account_reference, provider, currency, amount_minor, transfer_reference, payout_id)
     VALUES ($1, 'bachs', 'NGN', 5000, 'tr_leftover', $2)`,
    [ACCOUNT, old.payoutId],
  );
  assert.equal((await s.quote(provider)).feePaidBy, 'tipme');
  const { payoutId } = await s.withdraw(provider, 500_000n);
  const row = await s.payout(payoutId);
  assert.equal(row.fee_payer, 'tipme');
  assert.equal(row.user_fee_minor, '0');
  assert.equal(row.amount_minor, '500000');
  await startPayout(s.db, { payoutId, provider });
  // The leftover top-up pays it: nothing new leaves the reserve.
  assert.equal(provider.calls.covers.length, 0);
  await recordPayoutOutcome(s.db, {
    payoutId,
    provider: 'bachs',
    providerEventId: `evt_out_${randomUUID()}`,
    providerReference: (await s.payout(payoutId)).provider_reference,
    outcome: 'paid',
    signatureVerified: true,
    payload: {},
  });
  const [credit] = await s.q(
    `SELECT used_by_payout_id FROM provider_fee_credits WHERE transfer_reference = 'tr_leftover'`,
  );
  assert.equal(credit.used_by_payout_id, payoutId);
});

test('two TipMe-paid withdrawals earlier today do not change the third: the person pays', async (t) => {
  const s = await setup(t);
  await s.tip();
  await s.tip();
  const provider = partner();
  const one = await s.withdraw(provider, 300_000n);
  const two = await s.withdraw(provider, 300_000n);
  // Sets up pre-release payouts (TipMe paid the fee); skips the ledger on purpose.
  await s.q(
    `UPDATE payouts SET fee_payer = 'tipme', user_fee_minor = 0, amount_minor = 300000
      WHERE id = ANY($1)`,
    [[one.payoutId, two.payoutId]],
  );
  const third = await s.quote(provider);
  assert.equal(third.feePaidBy, 'user');
  assert.equal(third.freePerDay, 0);
  const { payoutId } = await s.withdraw(provider, 300_000n);
  const row = await s.payout(payoutId);
  assert.equal(row.fee_payer, 'user');
  assert.equal(row.user_fee_minor, '5000');
});

test('a whole balance of ₦1,500 withdraws with ₦50 off', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  await s.withdraw(provider, 800_000n);
  const whole = await s.quote(provider);
  assert.equal(whole.withdrawableMinor, 150_000n);
  const { payoutId } = await s.withdraw(provider, 150_000n);
  const row = await s.payout(payoutId);
  assert.equal(row.fee_payer, 'user');
  assert.equal(row.user_fee_minor, '5000');
  assert.equal(row.amount_minor, '145000');
});

test('a balance of ₦50 is refused: nothing would be left after the fee', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  await s.withdraw(provider, 945_000n);
  assert.equal((await s.quote(provider)).withdrawableMinor, 5_000n);
  assert.equal(
    await s.codeOf(s.withdraw(provider, 5_000n)),
    'WITHDRAWAL_BELOW_FEE',
  );
});

test('a payout requested before this release with fee_payer tipme still gets its top-up', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const { payoutId } = await s.withdraw(provider, 500_000n);
  // As the previous release wrote it: TipMe pays, the whole amount is sent. This UPDATE sets up a
  // pre-release payout and skips the ledger on purpose.
  await s.q(
    `UPDATE payouts SET fee_payer = 'tipme', user_fee_minor = 0, amount_minor = 500000 WHERE id = $1`,
    [payoutId],
  );
  assert.equal(await startPayout(s.db, { payoutId, provider }), 'started');
  assert.equal(provider.calls.covers.length, 1);
  assert.equal(provider.calls.covers[0].feeMinor, 5000n);
  assert.equal(provider.calls.payouts[0].amountMinor, 500_000n);
});

test('a business is unchanged: it pays, unless staff switch on TipMe paying its fee', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const OWNER = ADA.userId;
  await database.fresh();
  const { businessId, locations } = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI.id,
  });
  const { agreementId } = await seedAgreement(database, {
    memberId,
    businessBps: 5000,
  });
  const quote = await createQuote(db, {
    handle: 'tobi',
    tipMinor: 4_000_000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    businessMemberId: memberId,
  });
  const [{ net }] = await q(
    `SELECT q.recipient_net_minor::text AS net FROM payment_intents i
       JOIN tip_quotes q ON q.id = i.quote_id WHERE i.id = (SELECT intent_id FROM tips WHERE id = $1)`,
    [intent.tipId],
  );
  await q(
    `INSERT INTO tip_business_shares (tip_id, agreement_id, business_id, business_bps, share_minor)
     VALUES ($1, $2, $3, 5000, $4)`,
    [
      intent.tipId,
      agreementId,
      businessId,
      ((BigInt(net) * 5000n) / 10000n).toString(),
    ],
  );
  const reference = `mock_pay_${randomUUID()}`;
  await markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await recordProviderEvent(db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 4_000_000n,
    currency: 'NGN',
    providerFeeMinor: 6000n,
    signatureVerified: true,
    payload: {},
  });
  const mock = () => ({
    name: 'mock',
    capabilities: { connectedAccounts: false },
    payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
    payoutBalance: async () => ({ availableMinor: 200_000_000n }),
    quotePayoutFee: async () => ({ feeMinor: 5000n, exact: false }),
  });
  const providers = () => ({ active: mock(), withdrawOnly: [] });
  const feePayerOf = async () =>
    (
      await businessWithdrawalQuote(db, {
        businessId,
        userId: OWNER,
        providers: providers(),
      })
    ).feePaidBy;
  const request = async () => {
    const { payoutId } = await requestBusinessWithdrawal(db, {
      businessId,
      userId: OWNER,
      amountMinor: 500_000n,
      idempotencyKey: randomUUID(),
      providers: providers(),
    });
    return (
      await q('SELECT fee_payer FROM payouts WHERE id = $1', [payoutId])
    )[0].fee_payer;
  };
  assert.equal(await feePayerOf(), 'user');
  assert.equal(await request(), 'user');
  await db.transaction((tx) =>
    setFeatureSwitch(tx, {
      key: 'business_payout_fee_absorbed',
      on: true,
      staffUserId: OWNER,
      approvedBy: null,
      reason: 'Switched for the user-pays test',
      now: new Date(),
    }),
  );
  assert.equal(await feePayerOf(), 'tipme');
  assert.equal(await request(), 'tipme');
});
