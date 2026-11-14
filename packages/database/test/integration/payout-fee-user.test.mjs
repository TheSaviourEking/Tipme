import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  balanceOf,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  recordPayoutOutcome,
  recordProviderEvent,
  requestWithdrawal,
  startPayout,
  withdrawalQuote,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Users pay their own withdrawal fee, taken from the amount (owner, 12 Nov 2026): withdraw ₦X and
// ₦X − ₦50 arrives. Payouts requested before the rule finish with TipMe paying; an unused top-up
// TipMe already sent is spent, never stranded or counted twice; a partner fee above ₦50 is TipMe's.

const TOBI = DEMO_PROFILES[1];
const ACCOUNT = 'acct_tobi_fee';

/** A partner with connected accounts, as the real one has; it records every money call. */
function partner({ balance = 100_000_000n } = {}) {
  const calls = { covers: [], payouts: [] };
  return {
    calls,
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: true },
    payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
    payoutBalance: async () => ({ availableMinor: balance }),
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
  await database.fresh();
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
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
  /** A ₦10,000 tip collected on Tobi's account: ₦9,300 to Tobi on Free. */
  const tip = async () => {
    const quote = await createQuote(database.db, {
      handle: 'tobi',
      tipMinor: 1_000_000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(database.db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const reference = `${ACCOUNT}:chk_${randomUUID().slice(0, 8)}`;
    await markAttemptInitiated(database.db, {
      attemptId: intent.attemptId,
      provider: 'bachs',
      providerReference: reference,
    });
    await recordProviderEvent(database.db, {
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
  const available = async () =>
    (await balanceOf(database.db, TOBI.id)).availableMinor;
  const withdraw = (provider, amountMinor) =>
    requestWithdrawal(database.db, {
      profileId: TOBI.id,
      amountMinor,
      idempotencyKey: randomUUID(),
      provider,
    });
  const payout = async (id) =>
    (await q('SELECT * FROM payouts WHERE id = $1', [id]))[0];
  const paid = async (id, extra = {}) => {
    const row = await payout(id);
    return recordPayoutOutcome(database.db, {
      payoutId: id,
      provider: 'bachs',
      providerEventId: `evt_out_${randomUUID()}`,
      providerReference: row.provider_reference,
      outcome: 'paid',
      signatureVerified: true,
      payload: {},
      ...extra,
    });
  };
  const postings = (id) =>
    q(
      `SELECT a.code, e.side, e.amount_minor::text AS amount
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE t.payout_id = $1 ORDER BY a.code, e.side, e.amount_minor`,
      [id],
    );
  const codeOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code ?? String(error);
    }
  };
  return {
    database,
    q,
    tip,
    available,
    withdraw,
    payout,
    paid,
    postings,
    codeOf,
  };
}

test('withdraw ₦5,000: ₦4,950 is sent, the ₦50 comes off Tobi’s balance, and TipMe sends no top-up', async (t) => {
  const s = await setup(t);
  await s.tip();
  assert.equal(await s.available(), 930_000n);
  const provider = partner();
  const quote = await withdrawalQuote(s.database.db, {
    profileId: TOBI.id,
    provider,
  });
  assert.equal(quote.feeMinor, 5000n);
  assert.equal(quote.feePaidBy, 'user');
  const { payoutId } = await s.withdraw(provider, 500_000n);
  const row = await s.payout(payoutId);
  assert.equal(row.fee_payer, 'user');
  assert.equal(row.user_fee_minor, '5000');
  assert.equal(row.amount_minor, '495000');
  // Reserved at once: what Tobi chose, all of it.
  assert.equal(await s.available(), 430_000n);
  assert.equal(
    await startPayout(s.database.db, { payoutId, provider }),
    'started',
  );
  assert.equal(provider.calls.covers.length, 0);
  assert.equal(provider.calls.payouts[0].amountMinor, 495_000n);
  await s.paid(payoutId);
  assert.equal(await s.available(), 430_000n);
  assert.deepEqual(await s.postings(payoutId), [
    { code: 'provider_clearing', side: 'credit', amount: '5000' },
    { code: 'provider_clearing', side: 'credit', amount: '495000' },
    { code: 'recipient_payable', side: 'debit', amount: '5000' },
    { code: 'recipient_payable', side: 'debit', amount: '495000' },
  ]);
});

test('a payout requested before the rule is still topped up by TipMe and booked as TipMe’s cost', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const { payoutId } = await s.withdraw(provider, 500_000n);
  // As the previous release wrote it: TipMe pays, the whole amount is sent.
  await s.q(
    `UPDATE payouts SET fee_payer = 'tipme', user_fee_minor = 0, amount_minor = 500000 WHERE id = $1`,
    [payoutId],
  );
  assert.equal(
    await startPayout(s.database.db, { payoutId, provider }),
    'started',
  );
  assert.equal(provider.calls.covers.length, 1);
  assert.equal(provider.calls.covers[0].feeMinor, 5000n);
  assert.equal(provider.calls.payouts[0].amountMinor, 500_000n);
  await s.paid(payoutId);
  assert.equal(await s.available(), 430_000n);
  assert.deepEqual(await s.postings(payoutId), [
    { code: 'provider_clearing', side: 'credit', amount: '5000' },
    { code: 'provider_clearing', side: 'credit', amount: '500000' },
    { code: 'provider_fee_expense', side: 'debit', amount: '5000' },
    { code: 'recipient_payable', side: 'debit', amount: '500000' },
  ]);
});

test('Everything takes the whole balance: what arrives is the balance less ₦50, and nothing is left', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const quote = await withdrawalQuote(s.database.db, {
    profileId: TOBI.id,
    provider,
  });
  assert.equal(quote.withdrawableMinor, 930_000n);
  const { payoutId } = await s.withdraw(provider, quote.withdrawableMinor);
  assert.equal((await s.payout(payoutId)).amount_minor, '925000');
  assert.equal(await s.available(), 0n);
  await startPayout(s.database.db, { payoutId, provider });
  await s.paid(payoutId);
  assert.equal(await s.available(), 0n);
});

test('a balance of ₦50 or less can’t be withdrawn: refused with its own reason', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  await s.withdraw(provider, 925_000n);
  assert.equal(await s.available(), 5_000n);
  assert.equal(
    await s.codeOf(s.withdraw(provider, 5_000n)),
    'WITHDRAWAL_BELOW_FEE',
  );
  // Part of it is under the ₦2,000 minimum anyway.
  assert.equal(
    await s.codeOf(s.withdraw(provider, 4_000n)),
    'WITHDRAWAL_TOO_SMALL',
  );
  assert.equal(await s.available(), 5_000n);
});

test('a partner fee above ₦50: Tobi pays ₦50, TipMe absorbs the rest, and staff are alerted', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const { payoutId } = await s.withdraw(provider, 500_000n);
  await startPayout(s.database.db, { payoutId, provider });
  await s.paid(payoutId, { actualFeeMinor: 7_000n });
  assert.equal(await s.available(), 430_000n);
  assert.deepEqual(await s.postings(payoutId), [
    { code: 'provider_clearing', side: 'credit', amount: '2000' },
    { code: 'provider_clearing', side: 'credit', amount: '5000' },
    { code: 'provider_clearing', side: 'credit', amount: '495000' },
    { code: 'provider_fee_expense', side: 'debit', amount: '2000' },
    { code: 'recipient_payable', side: 'debit', amount: '5000' },
    { code: 'recipient_payable', side: 'debit', amount: '495000' },
  ]);
  const issues = await s.q(`SELECT kind FROM issues WHERE dedupe_key = $1`, [
    `payout_fee_short.${payoutId}`,
  ]);
  assert.deepEqual(issues, [{ kind: 'payout_fee_short' }]);
  // What Tobi was charged never changes, whatever the partner reports.
  assert.equal((await s.payout(payoutId)).user_fee_minor, '5000');
});

test('an unused top-up TipMe already sent pays the next withdrawal’s fee, once', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  // An older payout, under the old rule, whose ₦50 top-up went out before it failed.
  const old = await s.withdraw(provider, 300_000n);
  await s.q(
    `UPDATE payouts SET fee_payer = 'tipme', user_fee_minor = 0, amount_minor = 300000,
       status = 'FAILED' WHERE id = $1`,
    [old.payoutId],
  );
  await s.q(
    `INSERT INTO provider_fee_credits (account_reference, provider, currency, amount_minor, transfer_reference, payout_id)
     VALUES ($1, 'bachs', 'NGN', 5000, 'tr_leftover', $2)`,
    [ACCOUNT, old.payoutId],
  );
  assert.equal(await s.available(), 930_000n);
  const quote = await withdrawalQuote(s.database.db, {
    profileId: TOBI.id,
    provider,
  });
  assert.equal(quote.feePaidBy, 'tipme');
  const first = await s.withdraw(provider, 500_000n);
  const row = await s.payout(first.payoutId);
  assert.equal(row.fee_payer, 'tipme');
  assert.equal(row.amount_minor, '500000');
  // While that one is in flight the top-up is spoken for: the next pays its own fee.
  const second = await s.withdraw(provider, 200_000n);
  assert.equal((await s.payout(second.payoutId)).fee_payer, 'user');
  await startPayout(s.database.db, { payoutId: first.payoutId, provider });
  assert.equal(provider.calls.covers.length, 0);
  await s.paid(first.payoutId);
  const [credit] = await s.q(
    `SELECT used_by_payout_id FROM provider_fee_credits WHERE transfer_reference = 'tr_leftover'`,
  );
  assert.equal(credit.used_by_payout_id, first.payoutId);
  assert.equal(
    (await withdrawalQuote(s.database.db, { profileId: TOBI.id, provider }))
      .feePaidBy,
    'user',
  );
});
