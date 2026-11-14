import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  balanceOf,
  buyProFromBalance,
  grantCashReward,
  holdWithdrawals,
  mailSealing,
  openIssueFromEvent,
  reconcileProCollections,
  requestWithdrawal,
} from '../../dist/index.js';
import {
  PayoutRejectedError,
  UncertainProviderOutcomeError,
} from '../../../payments/dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

const { createMockProvider } = await import('../../../payments/dist/index.js');
const { Redis } = createRequire(
  new URL('../../../payments/package.json', import.meta.url),
)('ioredis');

// Paid Pro, plan Task 8 (ruling 8, behind PRO_PAY_FROM_BALANCE): a month paid from what TipMe owes
// the person. The partner moves the money from their account to TipMe's own (`destination: self`)
// before anything is booked. A pretend partner stands in: nothing here reaches the network.
const sealing = mailSealing(Buffer.alloc(32, 9));
const NOW = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000);
const MIN = 60_000;
const later = (ms) => new Date(NOW.getTime() + ms);

async function setup(t, credit = 900000n) {
  const db = await useDatabase(t);
  await db.fresh();
  await db.pool.query(
    `UPDATE users SET email = 'ada@example.com', email_verified_at = now()
       WHERE id = (SELECT user_id FROM profiles WHERE id = $1)`,
    [ADA],
  );
  if (credit > 0n)
    await grantCashReward(db.db, {
      profileId: ADA,
      amountMinor: credit,
      currency: 'NGN',
      operationKey: `reward.test.${randomUUID()}`,
    });
  return db;
}

/** A pretend partner for the balance: the account holds `available`; each collect is recorded. */
function partner({ available = 100_000_000n } = {}) {
  const collects = [];
  const transfers = new Map();
  return {
    collects,
    transfers,
    next: null,
    hold: null,
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
    async payoutBalance() {
      return { availableMinor: available };
    },
    async collectToPlatform(input) {
      collects.push(input);
      if (this.hold) await this.hold;
      const next = this.next;
      this.next = null;
      if (next === 'refused')
        throw new PayoutRejectedError('in_debt', 'ORGANIZATION_IN_DEBT');
      const made = {
        transferRef: `tr_${collects.length}`,
        status: 'paid',
        amountMinor: input.amountMinor,
        currency: 'NGN',
      };
      // The partner moved it, but the answer was lost on the way back.
      if (next === 'lost') {
        transfers.set(input.idempotencyKey, made);
        throw new UncertainProviderOutcomeError(input.idempotencyKey, 'lost');
      }
      if (next === 'lost_nothing')
        throw new UncertainProviderOutcomeError(input.idempotencyKey, 'lost');
      transfers.set(input.idempotencyKey, made);
      return { transferRef: made.transferRef, status: 'paid' };
    },
    async findPlatformCollection(_account, key) {
      return transfers.get(key) ?? null;
    },
  };
}

const q = (db, text, values = []) =>
  db.pool.query(text, values).then((result) => result.rows);
const planOf = async (db) =>
  (await q(db, `SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan;
const available = async (db) => (await balanceOf(db.db, ADA)).availableMinor;
const purchaseRow = async (db, id) =>
  (await q(db, `SELECT * FROM pro_purchases WHERE id = $1`, [id]))[0];
const proLedger = (db) =>
  q(
    db,
    `SELECT a.code, e.side, e.amount_minor, e.profile_id, t.operation_key
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.operation_type = 'pro_sale' ORDER BY a.code`,
  );
const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code ?? error.name;
  }
};

const buy = (db, provider, over = {}) =>
  buyProFromBalance(db.db, {
    profileId: ADA,
    expectedAmountMinor: 250000n,
    idempotencyKey: randomUUID(),
    provider,
    providerName: 'mock',
    sealing,
    now: NOW,
    ...over,
  });
const reconcile = (db, provider, now) =>
  reconcileProCollections(db.db, {
    provider,
    providerName: 'mock',
    now,
    sealing,
  });

test('enough balance: moved once with tipme-pro-<id>, then PAID, one pro.<id> posting, a month, plan pro, a receipt', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const bought = await buy(db, fake);
  assert.equal(bought.status, 'PAID');
  assert.equal(fake.collects.length, 1);
  assert.equal(fake.collects[0].accountRef, ADA);
  assert.equal(fake.collects[0].amountMinor, 250000n);
  assert.equal(
    fake.collects[0].idempotencyKey,
    `tipme-pro-${bought.purchaseId}`,
  );
  assert.deepEqual(
    (await proLedger(db)).map((l) => [
      l.code,
      l.side,
      l.amount_minor,
      l.profile_id,
    ]),
    [
      ['platform_clearing', 'debit', '250000', null],
      ['provider_clearing', 'credit', '250000', null],
      ['recipient_payable', 'debit', '250000', ADA],
      ['subscription_revenue', 'credit', '250000', null],
    ],
  );
  assert.equal(
    (await proLedger(db))[0].operation_key,
    `pro.${bought.purchaseId}`,
  );
  assert.equal(await available(db), 650000n);
  assert.equal(await planOf(db), 'pro');
  const [period] = await q(
    db,
    `SELECT status, paid_by FROM pro_periods WHERE profile_id = $1`,
    [ADA],
  );
  assert.deepEqual(period, { status: 'ACTIVE', paid_by: 'balance' });
  const row = await purchaseRow(db, bought.purchaseId);
  assert.equal(row.method, 'balance');
  assert.equal(row.provider_reference, 'tr_1');
  assert.equal(
    (await q(db, `SELECT 1 FROM mail_messages WHERE type = 'pro_receipt'`))
      .length,
    1,
  );
});

test('the amount is reserved while the partner moves it: available drops to 650000 before collection', async (t) => {
  const db = await setup(t);
  const fake = partner();
  let release;
  fake.hold = new Promise((resolve) => {
    release = resolve;
  });
  const pending = buy(db, fake);
  while (fake.collects.length === 0)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(await available(db), 650000n);
  assert.equal((await proLedger(db)).length, 0);
  release();
  assert.equal((await pending).status, 'PAID');
  assert.equal(await available(db), 650000n);
});

test('short: ₦2,000 owed refuses INSUFFICIENT_BALANCE, and the partner is never asked', async (t) => {
  const db = await setup(t, 200000n);
  const fake = partner();
  assert.equal(await codeOf(buy(db, fake)), 'INSUFFICIENT_BALANCE');
  assert.equal(fake.collects.length, 0);
  assert.equal((await q(db, `SELECT 1 FROM pro_purchases`)).length, 0);
  assert.equal(await planOf(db), 'free');
});

test('short at the partner: ₦9,000 owed but ₦2,000 available on the account refuses', async (t) => {
  const db = await setup(t);
  const fake = partner({ available: 200000n });
  assert.equal(await codeOf(buy(db, fake)), 'INSUFFICIENT_BALANCE');
  assert.equal(fake.collects.length, 0);
});

test('a withdrawal in flight is not spendable: ₦6,000 owed, ₦5,000 being withdrawn, Pro refused', async (t) => {
  const db = await setup(t, 600000n);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const mock = createMockProvider({
    redis,
    prefix: `pb-${randomUUID().slice(0, 8)}`,
  });
  await requestWithdrawal(db.db, {
    profileId: ADA,
    amountMinor: 500000n,
    idempotencyKey: randomUUID(),
    provider: mock,
  });
  const fake = partner();
  assert.equal(await codeOf(buy(db, fake)), 'INSUFFICIENT_BALANCE');
  assert.equal(fake.collects.length, 0);
});

test('a withdrawal and a Pro payment at once, with ₦6,000: exactly one goes through', async (t) => {
  const db = await setup(t, 600000n);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const mock = createMockProvider({
    redis,
    prefix: `pb-${randomUUID().slice(0, 8)}`,
  });
  const results = await Promise.allSettled([
    requestWithdrawal(db.db, {
      profileId: ADA,
      amountMinor: 500000n,
      idempotencyKey: randomUUID(),
      provider: mock,
    }),
    buy(db, partner()),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((r) => r.status === 'rejected').reason.code,
    'INSUFFICIENT_BALANCE',
  );
  assert.ok((await available(db)) >= 0n);
});

test('refused by the partner (in debt): FAILED, the reservation released, nothing booked', async (t) => {
  const db = await setup(t);
  const fake = partner();
  fake.next = 'refused';
  assert.equal(await codeOf(buy(db, fake)), 'PRO_BALANCE_REFUSED');
  const [row] = await q(db, `SELECT status FROM pro_purchases`);
  assert.equal(row.status, 'FAILED');
  assert.equal(await available(db), 900000n);
  assert.equal((await proLedger(db)).length, 0);
  assert.equal(await planOf(db), 'free');
});

test('partner timeout: UNKNOWN and still reserved; the read-back finds the transfer and books it once', async (t) => {
  const db = await setup(t);
  const fake = partner();
  fake.next = 'lost';
  const bought = await buy(db, fake);
  assert.equal(bought.status, 'UNKNOWN');
  assert.equal(await available(db), 650000n);
  assert.equal((await proLedger(db)).length, 0);
  assert.equal(await planOf(db), 'free');
  const first = await reconcile(db, fake, later(5 * MIN));
  assert.equal(first.paid.length, 1);
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'PAID');
  await reconcile(db, fake, later(10 * MIN));
  // Never sent again: only the read-back was asked.
  assert.equal(fake.collects.length, 1);
  assert.equal((await proLedger(db)).length, 4);
  assert.equal(await available(db), 650000n);
  assert.equal(await planOf(db), 'pro');
});

test('partner timeout and no transfer found after 30 minutes: FAILED, released, one pro.collect_unknown alert, never re-sent', async (t) => {
  const db = await setup(t);
  const fake = partner();
  fake.next = 'lost_nothing';
  const bought = await buy(db, fake);
  assert.equal(bought.status, 'UNKNOWN');
  await reconcile(db, fake, later(5 * MIN));
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'UNKNOWN');
  await reconcile(db, fake, later(40 * MIN));
  await reconcile(db, fake, later(50 * MIN));
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'FAILED');
  assert.equal(await available(db), 900000n);
  assert.equal(fake.collects.length, 1);
  assert.equal(
    (
      await q(
        db,
        `SELECT 1 FROM outbox_events WHERE event_type = 'pro.collect_unknown'`,
      )
    ).length,
    1,
  );
});

test('a retry with the same key returns the same purchase and moves the money once', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const key = randomUUID();
  const first = await buy(db, fake, { idempotencyKey: key });
  const again = await buy(db, fake, { idempotencyKey: key });
  assert.equal(again.purchaseId, first.purchaseId);
  assert.equal(again.replayed, true);
  assert.equal(fake.collects.length, 1);
  assert.equal((await proLedger(db)).length, 4);
  assert.equal(
    await codeOf(
      buy(db, fake, { idempotencyKey: key, expectedAmountMinor: 300000n }),
    ),
    'IDEMPOTENCY_CONFLICT',
  );
});

test('a changed price refuses PRO_PRICE_CHANGED before anything is reserved', async (t) => {
  const db = await setup(t);
  const fake = partner();
  assert.equal(
    await codeOf(buy(db, fake, { expectedAmountMinor: 200000n })),
    'PRO_PRICE_CHANGED',
  );
  assert.equal(fake.collects.length, 0);
});

test('a paused account (a withdrawal hold) refuses a balance payment', async (t) => {
  const db = await setup(t);
  await openIssueFromEvent(db.db, {
    eventType: 'pro.reversed',
    dedupeKey: `hold.${randomUUID()}`,
    payload: { purchaseId: randomUUID(), profileId: ADA },
  });
  const [issue] = await q(
    db,
    `SELECT id FROM issues WHERE kind = 'pro_reversed'`,
  );
  await db.db.transaction((tx) =>
    holdWithdrawals(tx, {
      profileId: ADA,
      reason: 'reversal',
      issueId: issue.id,
    }),
  );
  const fake = partner();
  assert.equal(await codeOf(buy(db, fake)), 'WITHDRAWALS_PAUSED');
  assert.equal(fake.collects.length, 0);
});
