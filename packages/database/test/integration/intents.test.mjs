import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPaymentIntent, createQuote } from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

test('payment intents', async (t) => {
  const database = await useDatabase(t);
  const quote = () =>
    createQuote(database.db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
    });

  await t.test(
    '20 concurrent identical requests create exactly one intent, tip and attempt',
    async () => {
      await database.fresh();
      const { quoteId } = await quote();
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          createPaymentIntent(database.db, {
            quoteId,
            idempotencyKey: key,
            message: 'Thank you',
          }),
        ),
      );
      assert.equal(await database.count('payment_intents'), 1);
      assert.equal(await database.count('tips'), 1);
      assert.equal(await database.count('payment_attempts'), 1);
      assert.equal(await database.count('tip_messages'), 1);
      assert.equal(results.filter((result) => result.replayed).length, 19);
      assert.equal(
        new Set(
          results.map(
            (result) =>
              `${result.intentId}/${result.tipId}/${result.attemptId}`,
          ),
        ).size,
        1,
      );
    },
  );

  await t.test(
    'the same key with a different request is a conflict',
    async () => {
      await database.fresh();
      const { quoteId } = await quote();
      const key = randomUUID();
      await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: key,
        message: 'One',
      });
      await assert.rejects(
        createPaymentIntent(database.db, {
          quoteId,
          idempotencyKey: key,
          message: 'Two',
        }),
        {
          code: 'IDEMPOTENCY_CONFLICT',
        },
      );
    },
  );

  await t.test('expired quotes cannot be paid', async () => {
    await database.fresh();
    const { quoteId, expiresAt } = await quote();
    await assert.rejects(
      createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
        now: new Date(expiresAt.getTime() + 1),
      }),
      { code: 'QUOTE_EXPIRED' },
    );
  });

  await t.test(
    'creation records the first transitions with the trace ID',
    async () => {
      await database.fresh();
      const { quoteId } = await quote();
      const traceId = 'a'.repeat(32);
      const { tipId, attemptId } = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
        traceId,
      });
      const { rows } = await database.pool.query(
        `SELECT entity_type, entity_id, from_status, to_status, trace_id FROM status_transitions ORDER BY entity_type::text`,
      );
      assert.deepEqual(
        rows,
        [
          {
            entity_type: 'tip',
            entity_id: tipId,
            from_status: null,
            to_status: 'AWAITING_PAYMENT',
            trace_id: traceId,
          },
          {
            entity_type: 'attempt',
            entity_id: attemptId,
            from_status: null,
            to_status: 'CREATED',
            trace_id: traceId,
          },
        ].sort((a, b) => a.entity_type.localeCompare(b.entity_type)),
      );
    },
  );

  await t.test(
    'payer labels are trimmed and cleaned; long messages are refused',
    async () => {
      await database.fresh();
      const { quoteId } = await quote();
      const { tipId } = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
        payerDisplayLabel: '  A\u0007 friend  ',
      });
      const { rows } = await database.pool.query(
        'SELECT payer_display_label FROM tips WHERE id = $1',
        [tipId],
      );
      assert.equal(rows[0].payer_display_label, 'A friend');
      const secret = 'private words '.repeat(25);
      await assert.rejects(
        createPaymentIntent(database.db, {
          quoteId,
          idempotencyKey: randomUUID(),
          message: secret,
        }),
        (error) =>
          error.code === 'INVALID_INPUT' &&
          !error.message.includes('private words'),
      );
      await assert.rejects(
        createPaymentIntent(database.db, {
          quoteId,
          idempotencyKey: randomUUID(),
          message: '   ',
        }),
        { code: 'INVALID_INPUT' },
      );
    },
  );

  await t.test('tip purpose is persisted with the tip', async () => {
    await database.fresh();
    const { quoteId } = await quote();
    const { tipId } = await createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
      purpose: 'great_service',
    });
    const { rows } = await database.pool.query(
      'SELECT purpose FROM tips WHERE id = $1',
      [tipId],
    );
    assert.equal(rows[0].purpose, 'great_service');
  });

  await t.test(
    'database errors never carry request values upward',
    async () => {
      await database.fresh();
      await assert.rejects(
        createPaymentIntent(database.db, {
          quoteId: 'not-a-uuid-secret-value',
          idempotencyKey: randomUUID(),
          message: 'hello there',
        }),
        (error) =>
          !String(error.message).includes('secret-value') &&
          !String(error.message).includes('hello there') &&
          !('cause' in error && error.cause),
      );
    },
  );

  await t.test(
    'a retry with the same key returns the original tip even after the quote expired',
    async () => {
      await database.fresh();
      const { quoteId, expiresAt } = await quote();
      const key = randomUUID();
      const first = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: key,
      });
      const later = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: key,
        now: new Date(expiresAt.getTime() + 60_000),
      });
      assert.equal(later.replayed, true);
      assert.equal(later.tipId, first.tipId);
    },
  );

  await t.test('a quote funds exactly one tip', async () => {
    await database.fresh();
    const { quoteId } = await quote();
    await createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
    });
    await assert.rejects(
      createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
      }),
      { code: 'QUOTE_ALREADY_USED' },
    );
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, async () => {
        const fresh = await quote();
        return Promise.allSettled([
          createPaymentIntent(database.db, {
            quoteId: fresh.quoteId,
            idempotencyKey: randomUUID(),
          }),
          createPaymentIntent(database.db, {
            quoteId: fresh.quoteId,
            idempotencyKey: randomUUID(),
          }),
        ]);
      }),
    );
    for (const round of results) {
      const outcomes = round.value.map((result) =>
        result.status === 'fulfilled' ? 'ok' : result.reason.code,
      );
      assert.deepEqual(outcomes.sort(), ['QUOTE_ALREADY_USED', 'ok']);
    }
  });

  await t.test('a failure part-way through leaves nothing behind', async () => {
    await database.fresh();
    const { quoteId } = await quote();
    process.env.NODE_ENV = 'test';
    await assert.rejects(
      createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
        __testFailAfter: 'tip',
      }),
    );
    for (const table of [
      'payment_intents',
      'tips',
      'payment_attempts',
      'status_transitions',
    ]) {
      assert.equal(await database.count(table), 0, table);
    }
  });
});
