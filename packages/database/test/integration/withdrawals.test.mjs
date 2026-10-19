import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  balanceOf,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  grantCashReward,
  markAttemptInitiated,
  reconcilePayouts,
  recordProviderEvent,
  requestWithdrawal,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const { createMockProvider } = await import('../../../payments/dist/index.js');
const { Redis } = createRequire(
  new URL('../../../payments/package.json', import.meta.url),
)('ioredis');
const [, TOBI] = DEMO_PROFILES;

test('withdrawals', async (t) => {
  const database = await useDatabase(t);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const mock = () =>
    createMockProvider({ redis, prefix: `w-${randomUUID().slice(0, 8)}` });
  const errorCode = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code;
    }
  };
  /** Tobi gets one confirmed ₦2,000 tip: NGN 1,870.00 net. */
  const paidTip = async () => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: 200000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
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
      amountMinor: 200000n,
      currency: 'NGN',
      providerFeeMinor: 3000n,
      signatureVerified: true,
      payload: {},
    });
  };
  const available = async () => (await balanceOf(db, TOBI.id)).availableMinor;

  await t.test(
    'a withdrawal reserves part of the balance, then settles it once paid',
    async () => {
      await database.fresh();
      await paidTip();
      assert.equal(await available(), 187000n);
      const provider = mock();
      const key = randomUUID();
      const first = await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 100000n,
        idempotencyKey: key,
        provider,
        scenario: 'payout-paid',
      });
      assert.equal(first.status, 'REQUESTED');
      assert.equal(await available(), 87000n);
      const [payout] = await q(
        'SELECT provider_reference FROM payouts WHERE id = $1',
        [first.payoutId],
      );
      assert.match(payout.provider_reference, /^mock_out_/);
      // The same key and amount replays; another amount is a conflict.
      assert.equal(
        (
          await requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 100000n,
            idempotencyKey: key,
            provider,
          })
        ).payoutId,
        first.payoutId,
      );
      assert.equal(
        await errorCode(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 50000n,
            idempotencyKey: key,
            provider,
          }),
        ),
        'IDEMPOTENCY_CONFLICT',
      );
      await provider.settlePayout(payout.provider_reference);
      await reconcilePayouts({ db, provider, now: new Date(), minAgeMs: 0 });
      assert.equal(
        (
          await q('SELECT status FROM payouts WHERE id = $1', [first.payoutId])
        )[0].status,
        'PAID',
      );
      assert.equal(await available(), 87000n);
      const unbalanced =
        await q(`SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
      HAVING SUM(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`);
      assert.deepEqual(unbalanced, []);
    },
  );

  await t.test(
    'a failed withdrawal returns the money to the balance',
    async () => {
      await database.fresh();
      await paidTip();
      const provider = mock();
      const withdrawal = await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 187000n,
        idempotencyKey: randomUUID(),
        provider,
        scenario: 'payout-failed',
      });
      assert.equal(await available(), 0n);
      const [payout] = await q(
        'SELECT provider_reference FROM payouts WHERE id = $1',
        [withdrawal.payoutId],
      );
      await provider.settlePayout(payout.provider_reference);
      await reconcilePayouts({ db, provider, now: new Date(), minAgeMs: 0 });
      assert.equal(await available(), 187000n);
    },
  );

  await t.test(
    'more than the balance, zero, or two at once that add up to too much are refused',
    async () => {
      await database.fresh();
      await paidTip();
      const provider = mock();
      assert.equal(
        await errorCode(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 187001n,
            idempotencyKey: randomUUID(),
            provider,
          }),
        ),
        'INSUFFICIENT_BALANCE',
      );
      assert.equal(
        await errorCode(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 0n,
            idempotencyKey: randomUUID(),
            provider,
          }),
        ),
        'INVALID_INPUT',
      );
      const results = await Promise.allSettled([
        requestWithdrawal(db, {
          profileId: TOBI.id,
          amountMinor: 100000n,
          idempotencyKey: randomUUID(),
          provider,
        }),
        requestWithdrawal(db, {
          profileId: TOBI.id,
          amountMinor: 100000n,
          idempotencyKey: randomUUID(),
          provider,
        }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        results.find((r) => r.status === 'rejected').reason.code,
        'INSUFFICIENT_BALANCE',
      );
      assert.equal(await available(), 87000n);
    },
  );

  await t.test('a cash bonus from TipMe is withdrawable', async () => {
    await database.fresh();
    await grantCashReward(db, {
      profileId: TOBI.id,
      amountMinor: 50000n,
      currency: 'NGN',
      operationKey: `reward.test.${randomUUID()}`,
    });
    assert.equal(await available(), 50000n);
    const rows =
      await q(`SELECT a.code, e.side, e.amount_minor FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.operation_type = 'reward' ORDER BY a.code`);
    assert.deepEqual(
      rows.map((r) => [r.code, r.side, r.amount_minor]),
      [
        ['promotions_expense', 'debit', '50000'],
        ['recipient_payable', 'credit', '50000'],
      ],
    );
    const withdrawal = await requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor: 50000n,
      idempotencyKey: randomUUID(),
      provider: mock(),
    });
    assert.equal(withdrawal.status, 'REQUESTED');
  });
});
