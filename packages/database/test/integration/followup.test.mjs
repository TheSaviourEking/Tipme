import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  createPaymentIntent,
  createPayout,
  createQuote,
  markAttemptInitiated,
  markPayoutInitiated,
  reconcileAttempts,
  reconcilePayouts,
  recordProviderEvent,
  recordUnmatchedEvent,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const { createMockProvider } = await import('../../../payments/dist/index.js');
const { Redis } = createRequire(
  new URL('../../../payments/package.json', import.meta.url),
)('ioredis');

test('follow-up hardening', async (t) => {
  const database = await useDatabase(t);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  const mock = createMockProvider({
    redis,
    prefix: `f-${randomUUID().slice(0, 8)}`,
  });
  const later = (minutes) => new Date(Date.now() + minutes * 60_000);
  const newAttempt = async () => {
    const { quoteId } = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
    });
    return createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
    });
  };
  const paidTip = async () => {
    const { tipId, attemptId } = await newAttempt();
    await recordProviderEvent(database.db, {
      provider: 'mock',
      providerEventId: randomUUID(),
      eventType: 'payment.succeeded',
      attemptId,
      providerReference: `r-${attemptId}`,
      amountMinor: 100000n,
      currency: 'NGN',
      providerFeeMinor: 1500n,
      signatureVerified: true,
      payload: {},
    });
    return tipId;
  };

  await t.test(
    'initiation reports unknown attempts and conflicting references',
    async () => {
      await database.fresh();
      const { attemptId } = await newAttempt();
      assert.equal(
        await markAttemptInitiated(database.db, {
          attemptId: randomUUID(),
          provider: 'mock',
          providerReference: 'x',
        }),
        'not_found',
      );
      assert.equal(
        await markAttemptInitiated(database.db, {
          attemptId,
          provider: 'mock',
          providerReference: 'ref-a',
        }),
        'initiated',
      );
      assert.equal(
        await markAttemptInitiated(database.db, {
          attemptId,
          provider: 'mock',
          providerReference: 'ref-a',
        }),
        'already',
      );
      assert.equal(
        await markAttemptInitiated(database.db, {
          attemptId,
          provider: 'mock',
          providerReference: 'ref-b',
        }),
        'conflict',
      );
    },
  );

  await t.test(
    'payout initiation never overwrites a reference and only starts from REQUESTED',
    async () => {
      await database.fresh();
      const { payoutId } = await createPayout(database.db, {
        profileId: DEMO_PROFILES[0].id,
        tipIds: [await paidTip()],
        idempotencyKey: randomUUID(),
      });
      assert.equal(
        await markPayoutInitiated(database.db, {
          payoutId: randomUUID(),
          provider: 'mock',
          providerReference: 'x',
        }),
        'not_found',
      );
      assert.equal(
        await markPayoutInitiated(database.db, {
          payoutId,
          provider: 'mock',
          providerReference: 'out-a',
        }),
        'initiated',
      );
      assert.equal(
        await markPayoutInitiated(database.db, {
          payoutId,
          provider: 'mock',
          providerReference: 'out-a',
        }),
        'already',
      );
      assert.equal(
        await markPayoutInitiated(database.db, {
          payoutId,
          provider: 'mock',
          providerReference: 'out-b',
        }),
        'conflict',
      );
      assert.equal(
        (
          await q('SELECT provider_reference FROM payouts WHERE id = $1', [
            payoutId,
          ])
        )[0].provider_reference,
        'out-a',
      );
    },
  );

  await t.test(
    'an unmatched message reusing an ID with different content is flagged',
    async () => {
      await database.fresh();
      const base = {
        provider: 'mock',
        providerEventId: 'evt_u',
        eventType: 'payment.succeeded',
        reason: 'unknown_attempt',
      };
      assert.equal(
        await recordUnmatchedEvent(database.db, { ...base, payload: { a: 1 } }),
        'stored',
      );
      assert.equal(
        await recordUnmatchedEvent(database.db, { ...base, payload: { a: 1 } }),
        'duplicate',
      );
      assert.equal(
        await recordUnmatchedEvent(database.db, { ...base, payload: { a: 2 } }),
        'conflict',
      );
    },
  );

  await t.test('the unresolved count only counts new alerts', async () => {
    await database.fresh();
    const { attemptId } = await newAttempt();
    await markAttemptInitiated(database.db, {
      attemptId,
      provider: 'mock',
      providerReference: 'mock_pay_missing',
    });
    const first = await reconcileAttempts({
      db: database.db,
      provider: mock,
      now: later(31),
      minAgeMs: 0,
    });
    const second = await reconcileAttempts({
      db: database.db,
      provider: mock,
      now: later(32),
      minAgeMs: 0,
    });
    assert.deepEqual([first.unresolved, second.unresolved], [1, 0]);
  });

  await t.test(
    'a payout the provider settled without telling us is recovered by reconciliation',
    async () => {
      await database.fresh();
      const tipId = await paidTip();
      const { payoutId, amountMinor, currency } = await createPayout(
        database.db,
        {
          profileId: DEMO_PROFILES[0].id,
          tipIds: [tipId],
          idempotencyKey: randomUUID(),
        },
      );
      const { providerReference } = await mock.initiatePayout({
        payoutId,
        amountMinor,
        currency,
        scenario: 'payout-paid',
      });
      await markPayoutInitiated(database.db, {
        payoutId,
        provider: 'mock',
        providerReference,
      });
      await mock.settlePayout(providerReference);
      const result = await reconcilePayouts({
        db: database.db,
        provider: mock,
        now: later(3),
        minAgeMs: 120_000,
      });
      assert.deepEqual(result, { checked: 1, applied: 1, errors: 0 });
      assert.equal(
        (await q('SELECT status FROM payouts WHERE id = $1', [payoutId]))[0]
          .status,
        'PAID',
      );
      assert.equal(
        (
          await reconcilePayouts({
            db: database.db,
            provider: mock,
            now: later(4),
            minAgeMs: 120_000,
          })
        ).checked,
        0,
      );
    },
  );
});
