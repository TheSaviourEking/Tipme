import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  reconcileAttempts,
  reconcilePayouts,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

const { createMockProvider } = await import('../../../payments/dist/index.js');
const { Redis } = createRequire(
  new URL('../../../payments/package.json', import.meta.url),
)('ioredis');

test('reconciliation', async (t) => {
  const database = await useDatabase(t);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  let mock;
  const freshMock = () => {
    mock = createMockProvider({
      redis,
      secret: 'x'.repeat(32),
      prefix: `r-${randomUUID().slice(0, 8)}`,
    });
    let initialised = 0;
    const original = mock.initializePayment.bind(mock);
    mock.initializePayment = async (input) => {
      initialised += 1;
      return original(input);
    };
    mock.initialisedCount = () => initialised;
    return mock;
  };
  const initiated = async ({ scenario = 'succeed', status } = {}) => {
    const { quoteId } = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
    });
    const { tipId, attemptId } = await createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
    });
    const { providerReference } = await mock.initializePayment({
      attemptId,
      amountMinor: 100000n,
      currency: 'NGN',
      scenario,
    });
    if (status) await mock.markStatus(providerReference, status);
    await markAttemptInitiated(database.db, {
      attemptId,
      provider: 'mock',
      providerReference,
    });
    return { tipId, attemptId, providerReference };
  };
  const tipStatus = async (tipId) =>
    (await q('SELECT status FROM tips WHERE id = $1', [tipId]))[0].status;
  const later = (minutes) => new Date(Date.now() + minutes * 60_000);

  await t.test(
    'a captured payment the provider never reported is recorded once',
    async () => {
      await database.fresh();
      freshMock();
      const { tipId } = await initiated({ scenario: 'no-reply' });
      const before = mock.initialisedCount();
      assert.deepEqual(
        await reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(3),
          minAgeMs: 120_000,
        }),
        { checked: 1, applied: 1, unresolved: 0, errors: 0, errorKinds: {} },
      );
      assert.equal(await tipStatus(tipId), 'SUCCEEDED');
      assert.deepEqual(
        await reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(4),
          minAgeMs: 120_000,
        }),
        { checked: 0, applied: 0, unresolved: 0, errors: 0, errorKinds: {} },
      );
      assert.equal(
        mock.initialisedCount(),
        before,
        'reconciliation never starts a payment',
      );
    },
  );

  await t.test(
    'two reconcilers at once book the payment exactly once',
    async () => {
      await database.fresh();
      freshMock();
      const { attemptId } = await initiated({ scenario: 'no-reply' });
      await Promise.all([
        reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(3),
          minAgeMs: 120_000,
        }),
        reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(3),
          minAgeMs: 120_000,
        }),
      ]);
      assert.equal(
        (
          await q(
            `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_key = $1`,
            [`payment.${attemptId}`],
          )
        )[0].n,
        1,
      );
    },
  );

  await t.test(
    'attempts that can never resolve do not starve newer ones',
    async () => {
      await database.fresh();
      freshMock();
      for (let i = 0; i < 3; i++)
        await initiated({ scenario: 'wrong-amount', status: 'succeeded' });
      // Wrong-amount attempts first hear a mismatch, then stay UNKNOWN forever.
      await reconcileAttempts({
        db: database.db,
        provider: mock,
        now: later(3),
        minAgeMs: 120_000,
        limit: 2,
      });
      const { tipId } = await initiated({ scenario: 'no-reply' });
      for (let run = 0; run < 3; run++) {
        await reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(5 + run),
          minAgeMs: 0,
          limit: 2,
        });
      }
      assert.equal(await tipStatus(tipId), 'SUCCEEDED');
    },
  );

  await t.test(
    'one attempt that always fails to check does not stop the others',
    async () => {
      await database.fresh();
      freshMock();
      const broken = await initiated();
      const { tipId } = await initiated({ scenario: 'no-reply' });
      const flaky = {
        verifyTransaction: async (reference) => {
          if (reference === broken.providerReference)
            throw Object.assign(new Error('no response'), {
              name: 'BachsTransportError',
            });
          return mock.verifyTransaction(reference);
        },
      };
      const result = await reconcileAttempts({
        db: database.db,
        provider: flaky,
        now: later(3),
        minAgeMs: 120_000,
      });
      assert.equal(result.errors, 1);
      // Counted by kind, so the worker's log says why (never which attempt or how much).
      assert.deepEqual(result.errorKinds, { BachsTransportError: 1 });
      assert.equal(result.applied, 1);
      assert.equal(await tipStatus(tipId), 'SUCCEEDED');
    },
  );

  await t.test(
    'pending payments are left alone; young attempts are skipped',
    async () => {
      await database.fresh();
      freshMock();
      const { tipId } = await initiated();
      assert.equal(
        (
          await reconcileAttempts({
            db: database.db,
            provider: mock,
            now: new Date(),
            minAgeMs: 120_000,
          })
        ).checked,
        0,
      );
      assert.equal(
        (
          await reconcileAttempts({
            db: database.db,
            provider: mock,
            now: later(3),
            minAgeMs: 120_000,
          })
        ).applied,
        0,
      );
      assert.equal(await tipStatus(tipId), 'AWAITING_PAYMENT');
    },
  );

  await t.test(
    'a payout start with no answer and no lookup goes to staff once, and stays reserved',
    async () => {
      await database.fresh();
      const payoutId = randomUUID();
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                              request_fingerprint, provider, start_uncertain_at, created_at)
         VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'f', 'bachs',
                 now() - interval '2 hours', now() - interval '2 hours')`,
        [payoutId, ADA, randomUUID()],
      );
      const verifier = {
        fetchPayoutStatus: async () => ({ status: 'pending' }),
      };
      for (let run = 0; run < 2; run += 1)
        await reconcilePayouts({
          db: database.db,
          provider: verifier,
          now: new Date(),
          minAgeMs: 0,
        });
      assert.equal(
        (await q(`SELECT 1 FROM issues WHERE kind = 'payout_unresolved'`))
          .length,
        1,
      );
      assert.equal(
        (await q('SELECT status FROM payouts WHERE id = $1', [payoutId]))[0]
          .status,
        'REQUESTED',
      );
    },
  );

  await t.test(
    'a queued payout that never started goes to staff, unless a hold explains it',
    async () => {
      await database.fresh();
      const payoutId = randomUUID();
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                              request_fingerprint, provider, created_at)
         VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'f', 'bachs', now() - interval '2 hours')`,
        [payoutId, ADA, randomUUID()],
      );
      const issueId = randomUUID();
      await q(
        `INSERT INTO issues (id, kind, dedupe_key, severity, subject, summary, opened_at)
         VALUES ($1, 'payment_reversed', $2, 'money', '{}', 'test', now())`,
        [issueId, `test.${issueId}`],
      );
      await q(
        `INSERT INTO withdrawal_holds (id, profile_id, reason, issue_id) VALUES ($1, $2, 'reversal', $3)`,
        [randomUUID(), ADA, issueId],
      );
      const verifier = {
        fetchPayoutStatus: async () => ({ status: 'pending' }),
      };
      const run = () =>
        reconcilePayouts({
          db: database.db,
          provider: verifier,
          now: new Date(),
          minAgeMs: 0,
        });
      const unresolved = async () =>
        (await q(`SELECT 1 FROM issues WHERE kind = 'payout_unresolved'`))
          .length;
      await run();
      assert.equal(await unresolved(), 0);
      await q(`UPDATE withdrawal_holds SET released_at = now()`);
      await run();
      assert.equal(await unresolved(), 1);
    },
  );

  await t.test(
    'a payment the provider cannot find for 30 minutes raises one alert',
    async () => {
      await database.fresh();
      freshMock();
      const { attemptId } = await initiated();
      await q(
        `UPDATE payment_attempts SET provider_reference = 'mock_pay_missing' WHERE id = $1`,
        [attemptId],
      );
      const first = await reconcileAttempts({
        db: database.db,
        provider: mock,
        now: later(31),
        minAgeMs: 120_000,
      });
      await reconcileAttempts({
        db: database.db,
        provider: mock,
        now: later(32),
        minAgeMs: 120_000,
      });
      assert.equal(first.unresolved, 1);
      const alerts = await q(
        `SELECT dedupe_key FROM outbox_events WHERE event_type = 'payment.unresolved'`,
      );
      assert.equal(alerts.length, 1);
    },
  );
});
