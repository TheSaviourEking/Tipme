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

// Withdrawals are free again for a person's own page (owner, 18 Nov 2026: "All the fees are absorbed
// in these - incoming and withdrawal fees"): withdraw ₦X and ₦X arrives. TipMe pays the partner's
// payout fee from the platform payment reserve (a top-up to the account before the payout) and books
// the real fee as its own cost. Payouts requested under the 12 and 14 Nov rule (`fee_payer = 'user'`)
// keep the terms they were asked under: the fee from the amount, and the partner's full fee.
// Businesses are unchanged (business-payouts tests).

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
  /** A ₦10,000 tip collected on Tobi's account: ₦9,500 to Tobi on Free (5%). */
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
  /** Each of the payout's ledger transactions whose debits and credits differ (none, if balanced). */
  const balanced = (id) =>
    q(
      `SELECT t.operation_key
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE t.payout_id = $1
        GROUP BY t.operation_key
       HAVING SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) <> 0`,
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
    balanced,
    codeOf,
  };
}

test('withdraw ₦5,000: the quote shows no fee for Tobi, ₦5,000 arrives, and TipMe tops up the ₦50 from the reserve', async (t) => {
  const s = await setup(t);
  await s.tip();
  assert.equal(await s.available(), 950_000n);
  const provider = partner();
  const quote = await withdrawalQuote(s.database.db, {
    profileId: TOBI.id,
    provider,
  });
  // The partner's fee is known to TipMe; Tobi pays none of it.
  assert.equal(quote.feeMinor, 5000n);
  assert.equal(quote.feePaidBy, 'tipme');
  const { payoutId } = await s.withdraw(provider, 500_000n);
  const row = await s.payout(payoutId);
  assert.equal(row.fee_payer, 'tipme');
  assert.equal(row.user_fee_minor, '0');
  assert.equal(row.amount_minor, '500000');
  assert.equal(await s.available(), 450_000n);
  assert.equal(
    await startPayout(s.database.db, { payoutId, provider }),
    'started',
  );
  // The fee moves from the platform reserve to Tobi's account first, then the whole amount goes.
  assert.equal(provider.calls.covers.length, 1);
  assert.equal(provider.calls.covers[0].feeMinor, 5000n);
  assert.equal(provider.calls.covers[0].accountRef, ACCOUNT);
  assert.equal(provider.calls.payouts[0].amountMinor, 500_000n);
  await s.paid(payoutId);
  assert.equal(await s.available(), 450_000n);
  // The partner's fee is TipMe's cost (provider_fee_expense), never Tobi's payable.
  assert.deepEqual(await s.postings(payoutId), [
    { code: 'provider_clearing', side: 'credit', amount: '5000' },
    { code: 'provider_clearing', side: 'credit', amount: '500000' },
    { code: 'provider_fee_expense', side: 'debit', amount: '5000' },
    { code: 'recipient_payable', side: 'debit', amount: '500000' },
  ]);
  assert.deepEqual(await s.balanced(payoutId), []);
});

test('Everything sends the whole balance and leaves nothing', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const quote = await withdrawalQuote(s.database.db, {
    profileId: TOBI.id,
    provider,
  });
  assert.equal(quote.withdrawableMinor, 950_000n);
  const { payoutId } = await s.withdraw(provider, quote.withdrawableMinor);
  assert.equal((await s.payout(payoutId)).amount_minor, '950000');
  await startPayout(s.database.db, { payoutId, provider });
  await s.paid(payoutId);
  assert.equal(await s.available(), 0n);
  assert.deepEqual(await s.balanced(payoutId), []);
});

test('a small balance (₦50) can be withdrawn whole: no fee comes off it', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  await s.withdraw(provider, 945_000n);
  assert.equal(await s.available(), 5_000n);
  // Part of it is still under the ₦2,000 minimum (the minimum tip).
  assert.equal(
    await s.codeOf(s.withdraw(provider, 4_000n)),
    'WITHDRAWAL_TOO_SMALL',
  );
  const { payoutId } = await s.withdraw(provider, 5_000n);
  assert.equal((await s.payout(payoutId)).amount_minor, '5000');
  assert.equal(await s.available(), 0n);
});

const feeIssues = (s, payoutId) =>
  s.q(
    `SELECT kind, severity FROM issues WHERE subject->>'payoutId' = $1 ORDER BY opened_at`,
    [payoutId],
  );

test('the partner charges ₦70: TipMe books all ₦70 as its cost, Tobi’s balance is untouched, and staff look', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const { payoutId } = await s.withdraw(provider, 500_000n);
  await startPayout(s.database.db, { payoutId, provider });
  await s.paid(payoutId, { actualFeeMinor: 7_000n });
  assert.equal(await s.available(), 450_000n);
  assert.deepEqual(await s.postings(payoutId), [
    { code: 'provider_clearing', side: 'credit', amount: '7000' },
    { code: 'provider_clearing', side: 'credit', amount: '500000' },
    { code: 'provider_fee_expense', side: 'debit', amount: '7000' },
    { code: 'recipient_payable', side: 'debit', amount: '500000' },
  ]);
  assert.deepEqual(await feeIssues(s, payoutId), [
    { kind: 'payout_fee_short', severity: 'money' },
  ]);
  assert.deepEqual(await s.balanced(payoutId), []);
});

test('a payout asked for under the user-pays rule keeps those terms: ₦50 from the amount, no top-up', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const { payoutId } = await s.withdraw(provider, 500_000n);
  // As the previous release wrote it: the user pays, ₦4,950 is sent, ₦50 comes off the payable.
  await s.q(
    `UPDATE payouts SET fee_payer = 'user', user_fee_minor = 5000, amount_minor = 495000 WHERE id = $1`,
    [payoutId],
  );
  assert.equal(
    await startPayout(s.database.db, { payoutId, provider }),
    'started',
  );
  assert.equal(provider.calls.covers.length, 0);
  assert.equal(provider.calls.payouts[0].amountMinor, 495_000n);
  await s.paid(payoutId);
  assert.equal(await s.available(), 450_000n);
  assert.deepEqual(await s.postings(payoutId), [
    { code: 'provider_clearing', side: 'credit', amount: '5000' },
    { code: 'provider_clearing', side: 'credit', amount: '495000' },
    { code: 'recipient_payable', side: 'debit', amount: '5000' },
    { code: 'recipient_payable', side: 'debit', amount: '495000' },
  ]);
  assert.deepEqual(await s.balanced(payoutId), []);
});

test('under the user-pays rule a ₦70 partner fee still takes the ₦20 more from the balance', async (t) => {
  const s = await setup(t);
  await s.tip();
  const provider = partner();
  const { payoutId } = await s.withdraw(provider, 500_000n);
  await s.q(
    `UPDATE payouts SET fee_payer = 'user', user_fee_minor = 5000, amount_minor = 495000 WHERE id = $1`,
    [payoutId],
  );
  await startPayout(s.database.db, { payoutId, provider });
  await s.paid(payoutId, { actualFeeMinor: 7_000n });
  assert.equal(await s.available(), 448_000n);
  assert.deepEqual(await feeIssues(s, payoutId), [
    { kind: 'payout_fee_adjusted', severity: 'info' },
  ]);
  assert.deepEqual(await s.balanced(payoutId), []);
});

test('an unused top-up TipMe already sent pays the next withdrawal’s fee, once; the one after gets its own', async (t) => {
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
  const first = await s.withdraw(provider, 500_000n);
  const second = await s.withdraw(provider, 200_000n);
  assert.equal((await s.payout(first.payoutId)).fee_payer, 'tipme');
  assert.equal((await s.payout(second.payoutId)).fee_payer, 'tipme');
  await startPayout(s.database.db, { payoutId: first.payoutId, provider });
  // The leftover top-up pays the first: nothing new leaves the reserve for it.
  assert.equal(provider.calls.covers.length, 0);
  await s.paid(first.payoutId);
  const [credit] = await s.q(
    `SELECT used_by_payout_id FROM provider_fee_credits WHERE transfer_reference = 'tr_leftover'`,
  );
  assert.equal(credit.used_by_payout_id, first.payoutId);
  await startPayout(s.database.db, { payoutId: second.payoutId, provider });
  assert.equal(provider.calls.covers.length, 1);
  assert.equal(provider.calls.payouts.at(-1).amountMinor, 200_000n);
});
