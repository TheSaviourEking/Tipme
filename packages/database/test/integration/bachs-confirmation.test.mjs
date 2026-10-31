import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  expireStaleTips,
  markAttemptInitiated,
  reconcileAttempts,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// A Bachs payment is confirmed only against TipMe's expected share, and a payment Bachs has
// collected but not yet settled is never expired (expiry would cancel a paid tip for good).

const REFERENCE = 'acct_ada123:chk_paid';

test('Bachs confirmation and expiry', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const status = async () =>
    (
      await database.pool.query(
        `SELECT a.status AS attempt, t.status AS tip
           FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id`,
      )
    ).rows[0];

  /** A ₦1,000 tip to Ada started at Bachs: TipMe's share is ₦100, processing included. */
  const started = async (quotedAt) => {
    await database.fresh();
    const quote = await createQuote(db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
      ...(quotedAt ? { now: quotedAt } : {}),
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'bachs',
      providerReference: REFERENCE,
    });
    return quote;
  };
  const verifier = (answer) => {
    const expectations = [];
    return {
      expectations,
      name: 'bachs',
      async findPayment() {
        return null;
      },
      async verifyTransaction(reference, expectation) {
        assert.equal(reference, REFERENCE);
        expectations.push(expectation);
        return answer(expectation);
      },
    };
  };

  await t.test(
    'reconciliation passes the quoted TipMe share and records the verified payment',
    async () => {
      await started();
      const bachs = verifier((expectation) =>
        expectation?.platformFeeMinor === 10000n
          ? {
              status: 'succeeded',
              amountMinor: 100000n,
              currency: 'NGN',
              feeMinor: 1500n,
            }
          : {
              status: 'pending',
              amountMinor: 100000n,
              currency: 'NGN',
              feeMinor: 0n,
            },
      );
      await reconcileAttempts({
        db,
        provider: bachs,
        now: new Date(),
        minAgeMs: 0,
      });
      assert.deepEqual(bachs.expectations, [{ platformFeeMinor: 10000n }]);
      assert.deepEqual(await status(), {
        attempt: 'VERIFIED_SUCCEEDED',
        tip: 'SUCCEEDED',
      });
    },
  );

  // Quoted now (so the intent can still be created), checked an hour later.
  const quotedAt = undefined;
  const afterExpiry = new Date(Date.now() + 60 * 60 * 1000);

  await t.test(
    'expiry never cancels a payment Bachs collected but has not settled',
    async () => {
      await started(quotedAt);
      const bachs = verifier(() => ({
        status: 'pending',
        amountMinor: 100000n,
        currency: 'NGN',
        feeMinor: 0n,
        collected: true,
      }));
      const result = await expireStaleTips({
        db,
        provider: bachs,
        now: afterExpiry,
      });
      assert.equal(result.expired, 0);
      assert.deepEqual(bachs.expectations, [{ platformFeeMinor: 10000n }]);
      // Out of expiry's reach, still unbooked: reconciliation and the issue inbox take over.
      assert.deepEqual(await status(), {
        attempt: 'PENDING',
        tip: 'PENDING_VERIFICATION',
      });
    },
  );

  await t.test('expiry still cancels a checkout nobody paid', async () => {
    await started(quotedAt);
    const bachs = verifier(() => ({
      status: 'pending',
      amountMinor: 100000n,
      currency: 'NGN',
      feeMinor: 0n,
    }));
    const result = await expireStaleTips({
      db,
      provider: bachs,
      now: afterExpiry,
    });
    assert.equal(result.expired, 1);
    assert.deepEqual(await status(), { attempt: 'EXPIRED', tip: 'CANCELLED' });
  });

  await t.test(
    'a payment Bachs took in crypto is held as a mismatch: a money alert, nothing booked',
    async () => {
      await started();
      const ledgerRows = async () =>
        (
          await database.pool.query(
            'SELECT count(*)::int AS n FROM ledger_entries',
          )
        ).rows[0].n;
      const before = await ledgerRows();
      const bachs = verifier(() => ({
        status: 'succeeded',
        amountMinor: 0n,
        currency: 'USDT_TRC20',
        feeMinor: 0n,
      }));
      await reconcileAttempts({
        db,
        provider: bachs,
        now: new Date(),
        minAgeMs: 0,
      });
      assert.deepEqual(await status(), {
        attempt: 'UNKNOWN',
        tip: 'AWAITING_PAYMENT',
      });
      assert.equal(await ledgerRows(), before);
      const alerts = (
        await database.pool.query(
          `SELECT event_type FROM outbox_events WHERE event_type = 'payment.mismatch'`,
        )
      ).rows;
      assert.equal(alerts.length, 1);
    },
  );
});
