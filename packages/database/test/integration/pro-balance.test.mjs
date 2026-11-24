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
  withdrawalQuote,
} from '../../dist/index.js';
import {
  PayoutRejectedError,
  UncertainProviderOutcomeError,
} from '../../../payments/dist/index.js';
import { ADA, atLaunchProPrice, useDatabase } from './helpers.mjs';

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
  await atLaunchProPrice(db);
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

/**
 * A pretend partner for the balance: the account holds `available`; each collect is recorded. Like
 * the pretend provider, it has no connected accounts (`name` is what its rows record).
 */
function partner({ available = 100_000_000n, name = 'mock' } = {}) {
  const collects = [];
  const transfers = new Map();
  return {
    name,
    capabilities: { connectedAccounts: false },
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
    providers: [{ reader: provider }],
    sealing,
    now: NOW,
    ...over,
  });
/** Buys through several providers, given in drain order. */
const buyThrough = (db, readers, over = {}) =>
  buy(db, null, {
    providers: readers.map((reader) => ({ reader })),
    ...over,
  });
const reconcile = (db, provider, now, providerName = 'mock') =>
  reconcileProCollections(db.db, {
    provider,
    providerName,
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
    providers: { active: mock, withdrawOnly: [] },
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
      providers: { active: mock, withdrawOnly: [] },
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

// Per-provider balances, Task 7 (spec §8, P10): one provider pays, the first in drain order whose
// own money covers the price; never a split.

test('Pro is paid from the first provider in drain order that covers the price alone', async (t) => {
  const db = await setup(t);
  // Both cover it: the first in drain order (withdraw-only mock_alt) pays, once, and the row
  // records that provider's own name and account.
  const alt = partner({ name: 'mock_alt', available: 300000n });
  const active = partner();
  const bought = await buyThrough(db, [alt, active]);
  assert.equal(bought.status, 'PAID');
  assert.equal(alt.collects.length, 1);
  assert.equal(alt.collects[0].accountRef, ADA);
  assert.equal(
    alt.collects[0].idempotencyKey,
    `tipme-pro-${bought.purchaseId}`,
  );
  assert.equal(active.collects.length, 0);
  const row = await purchaseRow(db, bought.purchaseId);
  assert.equal(row.provider, 'mock_alt');
  assert.equal(row.account_reference, ADA);
  assert.equal(await available(db), 650000n);
  assert.equal(await planOf(db), 'pro');
});

test('a provider that cannot cover the price alone is passed over for the next in drain order', async (t) => {
  const db = await setup(t);
  // mock_alt is drawn first but holds only ₦1,000; the active mock covers it.
  const alt = partner({ name: 'mock_alt', available: 100000n });
  const active = partner();
  const bought = await buyThrough(db, [alt, active]);
  assert.equal(bought.status, 'PAID');
  assert.equal(alt.collects.length, 0);
  assert.equal(active.collects.length, 1);
  assert.equal((await purchaseRow(db, bought.purchaseId)).provider, 'mock');
});

test('Pro is refused INSUFFICIENT_BALANCE when only a split would cover it', async (t) => {
  const db = await setup(t);
  // ₦9,000 owed; ₦1,500 at each provider: ₦3,000 together, but neither covers ₦2,500 alone.
  const alt = partner({ name: 'mock_alt', available: 150000n });
  const active = partner({ available: 150000n });
  assert.equal(
    await codeOf(buyThrough(db, [alt, active])),
    'INSUFFICIENT_BALANCE',
  );
  assert.equal(alt.collects.length, 0);
  assert.equal(active.collects.length, 0);
  assert.equal((await q(db, `SELECT 1 FROM pro_purchases`)).length, 0);
  assert.equal(await available(db), 900000n);
  assert.equal(await planOf(db), 'free');
});

test('a replay returns the same purchase whichever provider paid', async (t) => {
  const db = await setup(t);
  const key = randomUUID();
  const alt = partner({ name: 'mock_alt', available: 300000n });
  const active = partner();
  const first = await buyThrough(db, [alt, active], { idempotencyKey: key });
  assert.equal(first.status, 'PAID');
  assert.equal(alt.collects.length, 1);
  // The retry finds mock_alt emptied and only the active provider holding money: same purchase.
  const emptied = partner({ name: 'mock_alt', available: 0n });
  const again = await buyThrough(db, [emptied, active], {
    idempotencyKey: key,
  });
  assert.equal(again.purchaseId, first.purchaseId);
  assert.equal(again.replayed, true);
  assert.equal(emptied.collects.length, 0);
  assert.equal(active.collects.length, 0);
  assert.equal(alt.collects.length, 1);
  assert.equal((await proLedger(db)).length, 4);
  assert.equal((await purchaseRow(db, first.purchaseId)).provider, 'mock_alt');
});

test('the read-back finds a balance purchase at a withdraw-only provider', async (t) => {
  const db = await setup(t);
  const alt = partner({ name: 'mock_alt', available: 300000n });
  const active = partner();
  alt.next = 'lost';
  const bought = await buyThrough(db, [alt, active]);
  assert.equal(bought.status, 'UNKNOWN');
  assert.equal(await available(db), 650000n);
  // The active provider's read-back never looks at it: it is mock_alt's.
  const elsewhere = await reconcile(db, active, later(5 * MIN), 'mock');
  assert.equal(elsewhere.checked, 0);
  const found = await reconcile(db, alt, later(5 * MIN), 'mock_alt');
  assert.equal(found.checked, 1);
  assert.equal(found.paid.length, 1);
  assert.equal((await purchaseRow(db, bought.purchaseId)).status, 'PAID');
  assert.equal(alt.collects.length, 1);
  assert.equal(active.collects.length, 0);
  assert.equal((await proLedger(db)).length, 4);
  assert.equal(await planOf(db), 'pro');
});

test('a withdrawal queued at a provider counts only against that provider', async (t) => {
  const db = await setup(t, 900000n);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const mock = createMockProvider({
    redis,
    prefix: `pb-${randomUUID().slice(0, 8)}`,
  });
  // ₦5,000 queued at mock (not yet sent): mock's ₦6,000 covers only ₦1,000 more, so mock_alt pays.
  await requestWithdrawal(db.db, {
    profileId: ADA,
    amountMinor: 500000n,
    idempotencyKey: randomUUID(),
    providers: { active: mock, withdrawOnly: [] },
  });
  const active = partner({ available: 600000n });
  const alt = partner({ name: 'mock_alt', available: 300000n });
  // Drain order here puts the active provider first only to prove its queue is its own.
  const bought = await buyThrough(db, [active, alt]);
  assert.equal(bought.status, 'PAID');
  assert.equal(active.collects.length, 0);
  assert.equal(alt.collects.length, 1);
  assert.equal((await purchaseRow(db, bought.purchaseId)).provider, 'mock_alt');
});

// Fix round 1: Pro and withdrawals reserve each other's money at each provider.

/** A plain payout reader with a fixed balance, accountless like the pretend provider. */
const payoutReader = (name, balance) => ({
  name,
  capabilities: { connectedAccounts: false },
  async payoutCapability() {
    return { status: 'active', requirementsDue: [] };
  },
  async payoutBalance() {
    return { availableMinor: balance };
  },
  async quotePayoutFee() {
    return { feeMinor: 0n, exact: false };
  },
});

test('a queued withdrawal counts its user fee against its provider: Pro goes to the next one', async (t) => {
  const db = await setup(t, 1_500_000n);
  // P (mock_alt, drawn first) holds ₦7,500 with ₦5,000 queued there plus a ₦50 fee the user pays
  // from it: ₦2,450 of room, short of ₦2,500 by the fee alone. Q (mock) holds ₦20,000.
  await requestWithdrawal(db.db, {
    profileId: ADA,
    amountMinor: 500000n,
    idempotencyKey: randomUUID(),
    providers: { active: payoutReader('mock_alt', 750000n), withdrawOnly: [] },
  });
  await q(
    db,
    `UPDATE payouts SET fee_payer = 'user', user_fee_minor = 5000 WHERE provider = 'mock_alt'`,
  );
  const p = partner({ name: 'mock_alt', available: 750000n });
  const qq = partner({ available: 2_000_000n });
  const bought = await buyThrough(db, [p, qq]);
  assert.equal(bought.status, 'PAID');
  assert.equal(p.collects.length, 0);
  assert.equal(qq.collects.length, 1);
  assert.equal((await purchaseRow(db, bought.purchaseId)).provider, 'mock');
});

test("while a Pro payment at a provider is UNKNOWN, a withdrawal cannot take that provider's room", async (t) => {
  const db = await setup(t);
  const alt = partner({ name: 'mock_alt', available: 300000n });
  alt.next = 'lost';
  const bought = await buyThrough(db, [alt]);
  assert.equal(bought.status, 'UNKNOWN');
  // mock_alt still shows ₦3,000, but ₦2,500 of it is the open Pro payment: ₦500 of room.
  const providers = {
    active: payoutReader('mock_alt', 300000n),
    withdrawOnly: [],
  };
  const quote = await withdrawalQuote(db.db, { profileId: ADA, providers });
  assert.equal(quote.state, 'ready');
  assert.equal(quote.withdrawableMinor, 50000n);
  assert.equal(
    await codeOf(
      requestWithdrawal(db.db, {
        profileId: ADA,
        amountMinor: 100000n,
        idempotencyKey: randomUUID(),
        providers,
      }),
    ),
    'INSUFFICIENT_BALANCE',
  );
  assert.equal((await q(db, `SELECT 1 FROM payouts`)).length, 0);
});

test('a changed price with no provider covering it still refuses PRO_PRICE_CHANGED', async (t) => {
  const db = await setup(t);
  const fake = partner({ available: 100000n });
  assert.equal(
    await codeOf(buy(db, fake, { expectedAmountMinor: 200000n })),
    'PRO_PRICE_CHANGED',
  );
  assert.equal(fake.collects.length, 0);
  assert.equal((await q(db, `SELECT 1 FROM pro_purchases`)).length, 0);
});

test('an open Pro payment with no provider covering another still refuses PRO_PURCHASE_OPEN', async (t) => {
  const db = await setup(t);
  const fake = partner({ available: 300000n });
  fake.next = 'lost';
  assert.equal((await buy(db, fake)).status, 'UNKNOWN');
  // The open payment holds ₦2,500 of the ₦3,000 there: no provider covers a second one.
  assert.equal(await codeOf(buy(db, fake)), 'PRO_PURCHASE_OPEN');
  assert.equal(fake.collects.length, 1);
});

test('a paused account with no provider covering it still refuses WITHDRAWALS_PAUSED', async (t) => {
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
  const fake = partner({ available: 100000n });
  assert.equal(await codeOf(buy(db, fake)), 'WITHDRAWALS_PAUSED');
  assert.equal(fake.collects.length, 0);
});
