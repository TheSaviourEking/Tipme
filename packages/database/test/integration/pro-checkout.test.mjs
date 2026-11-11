import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  buyProByCheckout,
  confirmProCheckout,
  mailSealing,
  openIssueFromEvent,
  reconcileProPurchases,
  startPaidPeriod,
  OperationError,
} from '../../dist/index.js';
import {
  PlatformCheckoutUnavailableError,
  UncertainProviderOutcomeError,
} from '../../../payments/dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

// Paid Pro, plan Task 6 (ADR-0015): a Pro month bought by checkout on TipMe's own account, card or
// bank transfer. A pretend partner stands in: nothing here reaches the network.
const sealing = mailSealing(Buffer.alloc(32, 9));
// After the seeded launch price takes effect (its migration sets it from the real clock).
const NOW = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000);
const later = (ms) => new Date(NOW.getTime() + ms);
const MIN = 60_000;

async function setup(t) {
  const db = await useDatabase(t);
  await db.fresh();
  await db.pool.query(
    `UPDATE users SET email = 'ada@example.com', email_verified_at = now()
       WHERE id = (SELECT user_id FROM profiles WHERE id = $1)`,
    [ADA],
  );
  return db;
}

/** A pretend partner: records each create, answers reads from `paid`. */
function partner() {
  const calls = [];
  const reads = new Map();
  return {
    calls,
    reads,
    failNext: null,
    async initializePlatformCheckout(input) {
      calls.push(input);
      const failure = this.failNext;
      this.failNext = null;
      if (failure === 'refused')
        throw new PlatformCheckoutUnavailableError('ACCOUNT_NOT_ACTIVATED');
      // One checkout per idempotency key, as the partner does.
      const created = {
        providerReference: `platform:cs_${input.purchaseId}`,
        checkoutUrl: `https://checkout.bachs.io/session/cs_${input.purchaseId}`,
        expiresAt: new Date(NOW.getTime() + 30 * MIN),
      };
      if (failure === 'lost')
        throw new UncertainProviderOutcomeError(input.purchaseId, 'lost');
      return created;
    },
    async verifyTransaction(reference) {
      return (
        reads.get(reference) ?? {
          status: 'pending',
          amountMinor: 250000n,
          currency: 'NGN',
          feeMinor: 0n,
        }
      );
    },
  };
}

const paid = (over = {}) => ({
  status: 'succeeded',
  amountMinor: 250000n,
  currency: 'NGN',
  feeMinor: 5000n,
  feePaidBy: 'platform',
  method: 'NGN_CARD',
  ...over,
});

const q = (db, text, values = []) =>
  db.pool.query(text, values).then((result) => result.rows);
const planOf = async (db) =>
  (await q(db, `SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan;
const purchaseRow = async (db, id) =>
  (await q(db, `SELECT * FROM pro_purchases WHERE id = $1`, [id]))[0];
const outbox = (db, type) =>
  q(db, `SELECT * FROM outbox_events WHERE event_type = $1`, [type]);

const buy = (db, provider, over = {}) =>
  buyProByCheckout(db.db, {
    profileId: ADA,
    expectedAmountMinor: 250000n,
    idempotencyKey: randomUUID(),
    provider,
    providerName: 'bachs',
    successUrl: 'https://usetipme.xyz/dashboard/settings#plan',
    cancelUrl: 'https://usetipme.xyz/dashboard/settings#plan',
    now: NOW,
    ...over,
  });
const confirm = (db, purchaseId, verified, now = later(5 * MIN)) =>
  confirmProCheckout(db.db, { purchaseId, verified, now, sealing });

test('a card purchase is PENDING with a checkout URL, priced by the server; the plan stays free', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const bought = await buy(db, fake);
  assert.equal(bought.status, 'PENDING');
  assert.equal(bought.replayed, false);
  assert.match(bought.checkoutUrl, /^https:\/\/checkout\.bachs\.io\//);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].amountMinor, 250000n);
  assert.equal(fake.calls[0].currency, 'NGN');
  assert.equal(fake.calls[0].idempotencyKey, `tipme-pro-${bought.purchaseId}`);
  const row = await purchaseRow(db, bought.purchaseId);
  assert.equal(row.amount_minor, '250000');
  assert.equal(row.provider_reference, `platform:cs_${bought.purchaseId}`);
  assert.equal(await planOf(db), 'free');
});

test('the partner’s confirmation and read-back: PAID, one pro.<id> transaction, an ACTIVE month, plan pro, one receipt', async (t) => {
  const db = await setup(t);
  const bought = await buy(db, partner());
  const outcome = await confirm(db, bought.purchaseId, paid());
  assert.equal(outcome.outcome, 'paid');
  assert.equal(outcome.planChanged, true);
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'PAID');
  const lines = await q(
    db,
    `SELECT a.code, e.side, e.amount_minor, e.profile_id FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.operation_key = $1 ORDER BY a.code`,
    [`pro.${bought.purchaseId}`],
  );
  assert.deepEqual(
    lines.map((l) => [l.code, l.side, l.amount_minor, l.profile_id]),
    [
      ['platform_clearing', 'debit', '245000', null],
      ['provider_fee_expense', 'debit', '5000', null],
      ['subscription_revenue', 'credit', '250000', null],
    ],
  );
  const [tx] = await q(
    db,
    `SELECT operation_type, pro_purchase_id, tip_id FROM ledger_transactions WHERE operation_key = $1`,
    [`pro.${bought.purchaseId}`],
  );
  assert.equal(tx.operation_type, 'pro_sale');
  assert.equal(tx.pro_purchase_id, bought.purchaseId);
  assert.equal(tx.tip_id, null);
  const [period] = await q(
    db,
    `SELECT status, paid_by, purchase_id FROM pro_periods WHERE profile_id = $1`,
    [ADA],
  );
  assert.deepEqual(period, {
    status: 'ACTIVE',
    paid_by: 'card',
    purchase_id: bought.purchaseId,
  });
  assert.equal(await planOf(db), 'pro');
  assert.equal(
    (await q(db, `SELECT 1 FROM mail_messages WHERE type = 'pro_receipt'`))
      .length,
    1,
  );
  // Pro is not a tip: nothing owed to the recipient, no tip rewards.
  assert.equal(
    (
      await q(
        db,
        `SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = 'recipient_payable'`,
      )
    ).length,
    0,
  );
});

test('checkout.completed then collection.succeeded, or a duplicate, books once', async (t) => {
  const db = await setup(t);
  const bought = await buy(db, partner());
  assert.equal((await confirm(db, bought.purchaseId, paid())).outcome, 'paid');
  assert.equal(
    (await confirm(db, bought.purchaseId, paid(), later(6 * MIN))).outcome,
    'already',
  );
  assert.equal(
    (
      await q(
        db,
        `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_key = $1`,
        [`pro.${bought.purchaseId}`],
      )
    )[0].n,
    1,
  );
  assert.equal(
    (await q(db, `SELECT count(*)::int AS n FROM pro_periods`))[0].n,
    1,
  );
});

test('confirmations racing each other book once and start one month', async (t) => {
  const db = await setup(t);
  const bought = await buy(db, partner());
  const outcomes = await Promise.all([
    confirm(db, bought.purchaseId, paid()),
    confirm(db, bought.purchaseId, paid()),
    confirm(db, bought.purchaseId, paid()),
  ]);
  assert.deepEqual(outcomes.map((o) => o.outcome).sort(), [
    'already',
    'already',
    'paid',
  ]);
  assert.equal(
    (await q(db, `SELECT count(*)::int AS n FROM pro_periods`))[0].n,
    1,
  );
  assert.equal(
    (await q(db, `SELECT count(*)::int AS n FROM ledger_transactions`))[0].n,
    1,
  );
});

test('a bank transfer: the month is paid_by bank_transfer, and its fee is the read-back’s 3,750', async (t) => {
  const db = await setup(t);
  const bought = await buy(db, partner());
  await confirm(
    db,
    bought.purchaseId,
    paid({ method: 'NGN_BANK_TRANSFER', feeMinor: 3750n }),
  );
  const [period] = await q(db, `SELECT paid_by FROM pro_periods`);
  assert.equal(period.paid_by, 'bank_transfer');
  const [fee] = await q(
    db,
    `SELECT e.amount_minor FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = 'provider_fee_expense'`,
  );
  assert.equal(fee.amount_minor, '3750');
});

test('a late bank transfer after the purchase EXPIRED is credited from the confirmation, with an alert', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const bought = await buy(db, fake);
  fake.reads.set(`platform:cs_${bought.purchaseId}`, {
    status: 'failed',
    amountMinor: 250000n,
    currency: 'NGN',
    feeMinor: 0n,
  });
  await reconcileProPurchases(db.db, {
    provider: fake,
    providerName: 'bachs',
    now: later(40 * MIN),
    sealing,
  });
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'EXPIRED');
  const confirmedAt = later(50 * MIN);
  const outcome = await confirm(
    db,
    bought.purchaseId,
    paid({ method: 'NGN_BANK_TRANSFER', feeMinor: 3750n }),
    confirmedAt,
  );
  assert.equal(outcome.outcome, 'paid');
  const [period] = await q(db, `SELECT starts_at FROM pro_periods`);
  assert.equal(period.starts_at.toISOString(), confirmedAt.toISOString());
  assert.equal((await outbox(db, 'pro.late_payment')).length, 1);
  assert.equal(await planOf(db), 'pro');
});

test('a short or over amount, or another currency, goes to REVIEW: a money issue, nothing booked', async (t) => {
  for (const verified of [
    paid({ amountMinor: 200000n }),
    paid({ amountMinor: 300000n }),
    paid({ currency: 'USD' }),
    paid({ feeMinor: 260000n }),
  ]) {
    const db = await setup(t);
    const bought = await buy(db, partner());
    const outcome = await confirm(db, bought.purchaseId, verified);
    assert.equal(outcome.outcome, 'review');
    assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'REVIEW');
    assert.equal((await outbox(db, 'pro.amount_mismatch')).length, 1);
    assert.equal((await q(db, `SELECT 1 FROM ledger_transactions`)).length, 0);
    assert.equal((await q(db, `SELECT 1 FROM pro_periods`)).length, 0);
    assert.equal(await planOf(db), 'free');
    // Staff decide it now: a later confirmation changes nothing.
    assert.equal(
      (await confirm(db, bought.purchaseId, paid())).outcome,
      'review',
    );
  }
});

test('a price change after the checkout opened confirms at the purchase’s price', async (t) => {
  const db = await setup(t);
  const bought = await buy(db, partner());
  await q(
    db,
    `INSERT INTO pro_prices (id, amount_minor, currency, effective_from, reason, created_at)
     VALUES (gen_random_uuid(), 300000, 'NGN', now(), 'Changed while the checkout was open', now())`,
  );
  assert.equal((await confirm(db, bought.purchaseId, paid())).outcome, 'paid');
});

test('two purchases at once leave one open; the other is PRO_PURCHASE_OPEN', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const results = await Promise.allSettled([buy(db, fake), buy(db, fake)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const refused = results.find((r) => r.status === 'rejected');
  assert.equal(refused.reason.code, 'PRO_PURCHASE_OPEN');
  assert.equal(fake.calls.length, 1);
});

test('the same key again returns the same purchase and calls the partner once; a different amount is a conflict', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const key = randomUUID();
  const first = await buy(db, fake, { idempotencyKey: key });
  const again = await buy(db, fake, { idempotencyKey: key });
  assert.equal(again.purchaseId, first.purchaseId);
  assert.equal(again.replayed, true);
  assert.equal(again.checkoutUrl, first.checkoutUrl);
  assert.equal(fake.calls.length, 1);
  await assert.rejects(
    buy(db, fake, { idempotencyKey: key, expectedAmountMinor: 300000n }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('an expected amount other than the server’s price is PRO_PRICE_CHANGED, before anything is made', async (t) => {
  const db = await setup(t);
  const fake = partner();
  await assert.rejects(
    buy(db, fake, { expectedAmountMinor: 200000n }),
    (error) => error.code === 'PRO_PRICE_CHANGED',
  );
  assert.equal(fake.calls.length, 0);
  assert.equal((await q(db, `SELECT 1 FROM pro_purchases`)).length, 0);
});

test('a lost answer leaves the purchase UNKNOWN; reconciling finds the same checkout and confirms it', async (t) => {
  const db = await setup(t);
  const fake = partner();
  fake.failNext = 'lost';
  const bought = await buy(db, fake);
  assert.equal(bought.status, 'UNKNOWN');
  assert.equal(bought.checkoutUrl, null);
  fake.reads.set(`platform:cs_${bought.purchaseId}`, paid());
  const result = await reconcileProPurchases(db.db, {
    provider: fake,
    providerName: 'bachs',
    now: later(5 * MIN),
    sealing,
  });
  assert.equal(result.paid.length, 1);
  // Asked again with the same key: the partner dedupes it, so no second checkout exists.
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].idempotencyKey, fake.calls[0].idempotencyKey);
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'PAID');
  assert.equal(await planOf(db), 'pro');
});

test('a stale PENDING the partner reports failed is EXPIRED, and a new purchase can start', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const bought = await buy(db, fake);
  fake.reads.set(`platform:cs_${bought.purchaseId}`, {
    status: 'failed',
    amountMinor: 250000n,
    currency: 'NGN',
    feeMinor: 0n,
  });
  // Too young: left alone.
  await reconcileProPurchases(db.db, {
    provider: fake,
    providerName: 'bachs',
    now: later(MIN),
    sealing,
  });
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'PENDING');
  await reconcileProPurchases(db.db, {
    provider: fake,
    providerName: 'bachs',
    now: later(31 * MIN),
    sealing,
  });
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'EXPIRED');
  assert.equal(
    (await buy(db, fake, { now: later(32 * MIN) })).status,
    'PENDING',
  );
});

test('a purchase while a month is queued is refused PRO_ALREADY_RENEWED', async (t) => {
  const db = await setup(t);
  for (const purchaseId of [randomUUID(), randomUUID()])
    await db.db.transaction((tx) =>
      startPaidPeriod(tx, {
        profileId: ADA,
        purchaseId,
        paidBy: 'card',
        amountMinor: 250000n,
        currency: 'NGN',
        now: NOW,
      }),
    );
  await assert.rejects(
    buy(db, partner()),
    (error) =>
      error instanceof OperationError && error.code === 'PRO_ALREADY_RENEWED',
  );
});

test('TipMe’s account not activated: the purchase FAILS at once and says PRO_CHECKOUT_UNAVAILABLE', async (t) => {
  const db = await setup(t);
  const fake = partner();
  fake.failNext = 'refused';
  await assert.rejects(
    buy(db, fake),
    (error) => error.code === 'PRO_CHECKOUT_UNAVAILABLE',
  );
  const [row] = await q(db, `SELECT status FROM pro_purchases`);
  assert.equal(row.status, 'FAILED');
  // Nothing is left open: another try can start.
  fake.failNext = null;
  assert.equal((await buy(db, fake)).status, 'PENDING');
});

test('each Pro money alert becomes one inbox issue about the page', async (t) => {
  const db = await setup(t);
  for (const [eventType, kind, severity] of [
    ['pro.amount_mismatch', 'pro_amount_mismatch', 'money'],
    ['pro.late_payment', 'pro_late_payment', 'info'],
    ['pro.conflict', 'pro_conflict', 'money'],
    ['pro.reversed', 'pro_reversed', 'money'],
    // Plan Tasks 8 and 9.
    ['pro.collect_unknown', 'pro_collect_unknown', 'money'],
    ['pro.refund_failed', 'pro_refund_failed', 'money'],
  ]) {
    const input = {
      eventType,
      dedupeKey: `${eventType}.${randomUUID()}`,
      payload: { purchaseId: randomUUID(), profileId: ADA },
    };
    assert.equal(await openIssueFromEvent(db.db, input), 'opened');
    assert.equal(await openIssueFromEvent(db.db, input), 'duplicate');
    const [issue] = await q(
      db,
      `SELECT severity, subject FROM issues WHERE kind = $1`,
      [kind],
    );
    assert.equal(issue.severity, severity);
    assert.equal(issue.subject.profileId, ADA);
  }
});
