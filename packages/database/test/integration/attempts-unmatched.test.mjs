import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  findAttemptByReference,
  claimAttemptStart,
  markAttemptStartFailed,
  markAttemptInitiated,
  recordUnmatchedEvent,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

test('attempt initiation and unmatched events', async (t) => {
  const database = await useDatabase(t);
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);

  await t.test(
    'initiating an attempt records the reference once, with history',
    async () => {
      await database.fresh();
      const { quoteId } = await createQuote(database.db, {
        handle: 'ada',
        tipMinor: 100000n,
        currency: 'NGN',
      });
      const { attemptId } = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
      });
      const first = await markAttemptInitiated(database.db, {
        attemptId,
        provider: 'mock',
        providerReference: 'mock_pay_1',
      });
      const second = await markAttemptInitiated(database.db, {
        attemptId,
        provider: 'mock',
        providerReference: 'mock_pay_2',
      });
      assert.deepEqual([first, second], ['initiated', 'conflict']);
      assert.equal(
        await findAttemptByReference(database.db, 'mock', 'mock_pay_1'),
        attemptId,
      );
      assert.equal(
        await findAttemptByReference(database.db, 'mock', 'mock_pay_2'),
        null,
      );
      const history = await q(
        `SELECT to_status FROM status_transitions WHERE entity_id = $1 ORDER BY created_at, id`,
        [attemptId],
      );
      assert.deepEqual(
        history.map((row) => row.to_status),
        ['CREATED', 'INITIATED'],
      );
    },
  );

  await t.test(
    'a definite provider rejection closes the claimed attempt',
    async () => {
      await database.fresh();
      const { quoteId } = await createQuote(database.db, {
        handle: 'ada',
        tipMinor: 100000n,
        currency: 'NGN',
      });
      const { attemptId, tipId } = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
      });
      assert.equal(
        (await claimAttemptStart(database.db, { attemptId, provider: 'bachs' }))
          .outcome,
        'claimed',
      );

      assert.equal(
        await markAttemptStartFailed(database.db, {
          attemptId,
          provider: 'bachs',
        }),
        'failed',
      );
      const rows = await q(
        `SELECT a.status AS attempt_status, t.status AS tip_status
         FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
        WHERE a.id = $1 AND t.id = $2`,
        [attemptId, tipId],
      );
      assert.deepEqual(rows[0], {
        attempt_status: 'VERIFIED_FAILED',
        tip_status: 'FAILED',
      });
    },
  );

  await t.test('unknown-attempt events are stored durably, once', async () => {
    await database.fresh();
    const event = {
      provider: 'mock',
      providerEventId: 'evt_x',
      eventType: 'payment.succeeded',
      payload: { a: 1 },
      reason: 'unknown_attempt',
    };
    assert.equal(await recordUnmatchedEvent(database.db, event), 'stored');
    assert.equal(await recordUnmatchedEvent(database.db, event), 'duplicate');
    assert.equal(
      (await q('SELECT count(*)::int AS n FROM unmatched_provider_events'))[0]
        .n,
      1,
    );
    await assert.rejects(
      q(`UPDATE unmatched_provider_events SET reason = 'x'`),
      /append-only/,
    );
    await assert.rejects(
      q('DELETE FROM unmatched_provider_events'),
      /append-only/,
    );
    await assert.rejects(q('TRUNCATE unmatched_provider_events'), /TRUNCATE/);
  });
});
