import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  expireStaleTips,
  markAttemptInitiated,
  recordProviderEvent,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

/** A provider whose answers the test sets per reference; counts every question. */
const fakeProvider = () => {
  const answers = new Map();
  const asked = [];
  return {
    asked,
    answer: (reference, status) => answers.set(reference, status),
    async verifyTransaction(reference) {
      asked.push(reference);
      return {
        status: answers.get(reference) ?? 'pending',
        amountMinor: 100000n,
        currency: 'NGN',
        feeMinor: 1500n,
      };
    },
  };
};

test('stale tip expiry', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const quoteTime = new Date('2026-10-18T10:00:00Z');
  // Quotes live 15 minutes; expiry waits a further 15 minutes of grace.
  const staleNow = new Date(quoteTime.getTime() + 31 * 60_000);
  const freshNow = new Date(quoteTime.getTime() + 29 * 60_000);
  const initiatedTip = async () => {
    const { quoteId } = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
      now: quoteTime,
    });
    const intent = await createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
      now: quoteTime,
    });
    const reference = `mock_pay_${randomUUID()}`;
    await markAttemptInitiated(database.db, {
      attemptId: intent.attemptId,
      provider: 'mock',
      providerReference: reference,
    });
    return { ...intent, reference };
  };
  const statuses = async ({ tipId, attemptId }) => ({
    tip: (await q('SELECT status FROM tips WHERE id = $1', [tipId]))[0].status,
    attempt: (
      await q('SELECT status FROM payment_attempts WHERE id = $1', [attemptId])
    )[0].status,
  });

  await t.test(
    'an unpaid stale tip is cancelled after asking the provider',
    async () => {
      const tip = await initiatedTip();
      const provider = fakeProvider();
      const result = await expireStaleTips({
        db: database.db,
        provider,
        now: staleNow,
      });
      assert.deepEqual(result, { expired: 1, paid: 0, errors: 0 });
      assert.deepEqual(provider.asked, [tip.reference]);
      assert.deepEqual(await statuses(tip), {
        tip: 'CANCELLED',
        attempt: 'EXPIRED',
      });
      const transitions = await q(
        `SELECT entity_type, from_status, to_status FROM status_transitions
         WHERE entity_id = ANY($1) AND cause = 'expiry' ORDER BY entity_type::text`,
        [[tip.tipId, tip.attemptId]],
      );
      assert.deepEqual(
        transitions.map((row) => [
          row.entity_type,
          row.from_status,
          row.to_status,
        ]),
        [
          ['attempt', 'INITIATED', 'EXPIRED'],
          ['tip', 'AWAITING_PAYMENT', 'CANCELLED'],
        ],
      );
      const again = await expireStaleTips({
        db: database.db,
        provider,
        now: staleNow,
      });
      assert.deepEqual(again, { expired: 0, paid: 0, errors: 0 });
    },
  );

  await t.test(
    'a stale tip the provider says was paid is never cancelled',
    async () => {
      await database.fresh();
      const tip = await initiatedTip();
      const provider = fakeProvider();
      provider.answer(tip.reference, 'succeeded');
      const result = await expireStaleTips({
        db: database.db,
        provider,
        now: staleNow,
      });
      assert.deepEqual(result, { expired: 0, paid: 1, errors: 0 });
      assert.deepEqual(await statuses(tip), {
        tip: 'SUCCEEDED',
        attempt: 'VERIFIED_SUCCEEDED',
      });
    },
  );

  await t.test('a tip within the grace period is untouched', async () => {
    await database.fresh();
    const tip = await initiatedTip();
    const provider = fakeProvider();
    const result = await expireStaleTips({
      db: database.db,
      provider,
      now: freshNow,
    });
    assert.deepEqual(result, { expired: 0, paid: 0, errors: 0 });
    assert.deepEqual(provider.asked, []);
    assert.deepEqual(await statuses(tip), {
      tip: 'AWAITING_PAYMENT',
      attempt: 'INITIATED',
    });
  });

  await t.test(
    'a provider failure leaves the tip alone and is counted',
    async () => {
      await database.fresh();
      const tip = await initiatedTip();
      const provider = {
        async verifyTransaction() {
          throw new Error('timeout');
        },
      };
      const result = await expireStaleTips({
        db: database.db,
        provider,
        now: staleNow,
      });
      assert.deepEqual(result, { expired: 0, paid: 0, errors: 1 });
      assert.deepEqual(await statuses(tip), {
        tip: 'AWAITING_PAYMENT',
        attempt: 'INITIATED',
      });
    },
  );

  await t.test(
    'minor: checks that keep failing cannot starve newer expiries',
    async () => {
      await database.fresh();
      const stuck = await initiatedTip();
      const later = await initiatedTip();
      const provider = {
        async verifyTransaction(reference) {
          if (reference === stuck.reference) throw new Error('timeout');
          return {
            status: 'pending',
            amountMinor: 0n,
            currency: 'NGN',
            feeMinor: 0n,
          };
        },
      };
      const first = await expireStaleTips({
        db: database.db,
        provider,
        now: staleNow,
        limit: 1,
      });
      assert.deepEqual(first, { expired: 0, paid: 0, errors: 1 });
      // The failed check moves to the back of the queue, so the next run reaches the other tip.
      const second = await expireStaleTips({
        db: database.db,
        provider,
        now: new Date(staleNow.getTime() + 1000),
        limit: 1,
      });
      assert.deepEqual(second, { expired: 1, paid: 0, errors: 0 });
      assert.deepEqual(await statuses(later), {
        tip: 'CANCELLED',
        attempt: 'EXPIRED',
      });
    },
  );

  await t.test(
    'a late verified success after expiry is flagged as a conflict',
    async () => {
      await database.fresh();
      const tip = await initiatedTip();
      await expireStaleTips({
        db: database.db,
        provider: fakeProvider(),
        now: staleNow,
      });
      const late = await recordProviderEvent(database.db, {
        provider: 'mock',
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'payment.succeeded',
        attemptId: tip.attemptId,
        providerReference: tip.reference,
        amountMinor: 100000n,
        currency: 'NGN',
        providerFeeMinor: 1500n,
        signatureVerified: true,
        payload: {},
      });
      assert.equal(late.outcome, 'conflict');
      assert.deepEqual(await statuses(tip), {
        tip: 'CANCELLED',
        attempt: 'EXPIRED',
      });
      const flagged = await q(
        `SELECT dedupe_key FROM outbox_events WHERE event_type = 'payment.conflict'`,
      );
      assert.equal(flagged.length, 1);
      assert.match(
        flagged[0].dedupe_key,
        new RegExp(`^payment\\.conflict\\.${tip.attemptId}`),
      );
    },
  );
});
