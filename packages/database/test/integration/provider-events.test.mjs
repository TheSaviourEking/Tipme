import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  recordProviderEvent,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

const paidEvent = (attemptId, overrides = {}) => ({
  provider: 'mock',
  providerEventId: randomUUID(),
  eventType: 'payment.succeeded',
  attemptId,
  providerReference: `ref-${attemptId}`,
  amountMinor: 100000n,
  currency: 'NGN',
  providerFeeMinor: 1500n,
  signatureVerified: true,
  payload: { kind: 'test' },
  ...overrides,
});

test('provider events', async (t) => {
  const database = await useDatabase(t);
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  const newTip = async (extra = {}) => {
    const { quoteId } = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
    });
    return createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
      ...extra,
    });
  };
  const tipStatus = async (tipId) =>
    (await q('SELECT status FROM tips WHERE id = $1', [tipId]))[0].status;
  const balanceOf = async (code, profileId = null) =>
    (
      await q(
        `SELECT coalesce(sum(CASE e.side WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS b
           FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.code = $1 AND a.profile_id IS NOT DISTINCT FROM $2`,
        [code, profileId],
      )
    )[0].b;

  await t.test(
    'a verified success marks the tip paid, posts balanced books and queues one receipt event',
    async () => {
      await database.fresh();
      const { tipId, attemptId } = await newTip();
      const result = await recordProviderEvent(
        database.db,
        paidEvent(attemptId),
      );
      assert.deepEqual(result, {
        outcome: 'applied',
        tipStatus: 'SUCCEEDED',
        attemptStatus: 'VERIFIED_SUCCEEDED',
      });
      assert.equal(await tipStatus(tipId), 'SUCCEEDED');
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM ledger_transactions'))[0].n,
        1,
      );
      assert.equal(await balanceOf('recipient_payable', ADA), '90000');
      assert.equal(await balanceOf('platform_fee_revenue'), '10000');
      const outbox = await q('SELECT dedupe_key, payload FROM outbox_events');
      assert.deepEqual(
        outbox.map((row) => row.dedupe_key),
        [`tip.succeeded.${tipId}`],
      );
      assert.doesNotThrow(() => JSON.stringify(outbox));
      assert.equal(outbox[0].payload.recipientNetMinor, '90000');
    },
  );

  await t.test(
    'the same event delivered 10 times at once is applied exactly once',
    async () => {
      await database.fresh();
      const { attemptId } = await newTip();
      const event = paidEvent(attemptId);
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () =>
          recordProviderEvent(database.db, { ...event }),
        ),
      );
      assert.equal(
        outcomes.filter((result) => result.outcome === 'applied').length,
        1,
      );
      assert.equal(
        outcomes.filter((result) => result.outcome === 'duplicate').length,
        9,
      );
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM ledger_transactions'))[0].n,
        1,
      );
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM outbox_events'))[0].n,
        1,
      );
    },
  );

  await t.test(
    'a second, different success event changes nothing',
    async () => {
      await database.fresh();
      const { attemptId } = await newTip();
      await recordProviderEvent(database.db, paidEvent(attemptId));
      assert.equal(
        (await recordProviderEvent(database.db, paidEvent(attemptId))).outcome,
        'ignored',
      );
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM ledger_transactions'))[0].n,
        1,
      );
    },
  );

  await t.test('a late failure never downgrades a success', async () => {
    await database.fresh();
    const { tipId, attemptId } = await newTip();
    await recordProviderEvent(database.db, paidEvent(attemptId));
    const late = await recordProviderEvent(
      database.db,
      paidEvent(attemptId, { eventType: 'payment.failed' }),
    );
    assert.equal(late.outcome, 'ignored');
    assert.equal(await tipStatus(tipId), 'SUCCEEDED');
  });

  await t.test(
    'a success after a verified failure is flagged as a conflict, never silently dropped',
    async () => {
      await database.fresh();
      const { tipId, attemptId } = await newTip();
      await recordProviderEvent(
        database.db,
        paidEvent(attemptId, { eventType: 'payment.failed' }),
      );
      const result = await recordProviderEvent(
        database.db,
        paidEvent(attemptId),
      );
      assert.equal(result.outcome, 'conflict');
      assert.equal(await tipStatus(tipId), 'FAILED');
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM ledger_entries'))[0].n,
        0,
      );
      const keys = (await q('SELECT dedupe_key FROM outbox_events')).map(
        (row) => row.dedupe_key,
      );
      assert.ok(
        keys.some((key) => key.startsWith(`payment.conflict.${attemptId}.`)),
        keys.join(','),
      );
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM provider_events'))[0].n,
        2,
      );
    },
  );

  await t.test(
    'a wrong amount is never booked; the attempt waits for verified evidence',
    async () => {
      await database.fresh();
      const { tipId, attemptId } = await newTip();
      const wrong = await recordProviderEvent(
        database.db,
        paidEvent(attemptId, { amountMinor: 99999n }),
      );
      assert.deepEqual(wrong, {
        outcome: 'mismatch',
        tipStatus: 'AWAITING_PAYMENT',
        attemptStatus: 'UNKNOWN',
      });
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM ledger_entries'))[0].n,
        0,
      );
      assert.ok(
        (await q('SELECT dedupe_key FROM outbox_events')).some((row) =>
          row.dedupe_key.startsWith(`payment.mismatch.${attemptId}.`),
        ),
      );
      const right = await recordProviderEvent(
        database.db,
        paidEvent(attemptId),
      );
      assert.equal(right.outcome, 'applied');
      assert.equal(await tipStatus(tipId), 'SUCCEEDED');
    },
  );

  await t.test('a wrong currency is a mismatch too', async () => {
    await database.fresh();
    const { attemptId } = await newTip();
    assert.equal(
      (
        await recordProviderEvent(
          database.db,
          paidEvent(attemptId, { currency: 'USD' }),
        )
      ).outcome,
      'mismatch',
    );
  });

  await t.test(
    'a higher actual provider fee is absorbed: books balance and the recipient gets the quoted net',
    async () => {
      await database.fresh();
      const { attemptId } = await newTip();
      await recordProviderEvent(
        database.db,
        paidEvent(attemptId, { providerFeeMinor: 2000n }),
      );
      assert.equal(await balanceOf('recipient_payable', ADA), '90000');
      const [{ net }] = await q(
        `SELECT sum(CASE side WHEN 'debit' THEN amount_minor ELSE -amount_minor END)::text AS net FROM ledger_entries`,
      );
      assert.equal(net, '0');
    },
  );

  await t.test(
    'pending then success records the full history in order',
    async () => {
      await database.fresh();
      const { tipId, attemptId } = await newTip();
      await recordProviderEvent(
        database.db,
        paidEvent(attemptId, { eventType: 'payment.pending' }),
      );
      await recordProviderEvent(database.db, paidEvent(attemptId));
      const history = await q(
        `SELECT to_status FROM status_transitions WHERE entity_type = 'tip' AND entity_id = $1 ORDER BY created_at, id`,
        [tipId],
      );
      assert.deepEqual(
        history.map((row) => row.to_status),
        ['AWAITING_PAYMENT', 'PENDING_VERIFICATION', 'SUCCEEDED'],
      );
    },
  );

  await t.test('payer messages never reach the outbox', async () => {
    await database.fresh();
    const { attemptId } = await newTip({ message: 'Thank you Ada' });
    await recordProviderEvent(database.db, paidEvent(attemptId));
    assert.ok(
      !JSON.stringify(await q('SELECT * FROM outbox_events')).includes(
        'Thank you Ada',
      ),
    );
  });

  await t.test(
    'different events for one attempt at the same moment never deadlock',
    async () => {
      await database.fresh();
      for (let i = 0; i < 10; i++) {
        const { attemptId } = await newTip();
        const results = await Promise.allSettled([
          recordProviderEvent(database.db, paidEvent(attemptId)),
          recordProviderEvent(
            database.db,
            paidEvent(attemptId, { eventType: 'payment.failed' }),
          ),
          recordProviderEvent(
            database.db,
            paidEvent(attemptId, { eventType: 'payment.pending' }),
          ),
        ]);
        const rejected = results.filter(
          (result) => result.status === 'rejected',
        );
        assert.deepEqual(
          rejected.map((result) => result.reason?.message),
          [],
          'no event may fail',
        );
        const stored = await q(
          'SELECT count(*)::int AS n FROM provider_events WHERE attempt_id = $1',
          [attemptId],
        );
        assert.equal(stored[0].n, 3, 'every verified event is stored');
      }
    },
  );

  await t.test(
    'a fee larger than the payment is stored and flagged, never thrown away',
    async () => {
      await database.fresh();
      const { attemptId } = await newTip();
      const result = await recordProviderEvent(
        database.db,
        paidEvent(attemptId, { providerFeeMinor: 100001n }),
      );
      assert.equal(result.outcome, 'mismatch');
      assert.equal(result.attemptStatus, 'UNKNOWN');
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM provider_events'))[0].n,
        1,
      );
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM ledger_entries'))[0].n,
        0,
      );
    },
  );

  await t.test(
    'payloads with big numbers or nothing at all are stored safely',
    async () => {
      await database.fresh();
      const one = await newTip();
      assert.equal(
        (
          await recordProviderEvent(
            database.db,
            paidEvent(one.attemptId, {
              payload: { amount: 100000n, note: undefined },
            }),
          )
        ).outcome,
        'applied',
      );
      const [stored] = await q('SELECT payload FROM provider_events');
      assert.deepEqual(stored.payload, { amount: '100000' });
      const two = await newTip();
      assert.equal(
        (
          await recordProviderEvent(
            database.db,
            paidEvent(two.attemptId, { payload: undefined }),
          )
        ).outcome,
        'applied',
      );
    },
  );

  await t.test(
    'a reused provider event ID with different content is flagged',
    async () => {
      await database.fresh();
      const { attemptId } = await newTip();
      const event = paidEvent(attemptId, { eventType: 'payment.pending' });
      await recordProviderEvent(database.db, event);
      assert.equal(
        (await recordProviderEvent(database.db, { ...event })).outcome,
        'duplicate',
      );
      const altered = await recordProviderEvent(database.db, {
        ...event,
        eventType: 'payment.succeeded',
      });
      assert.equal(altered.outcome, 'conflict');
      const keys = (await q('SELECT dedupe_key FROM outbox_events')).map(
        (row) => row.dedupe_key,
      );
      assert.ok(
        keys.some((key) => key.startsWith('provider_event.conflict.')),
        keys.join(','),
      );
    },
  );

  await t.test(
    'a success for a cancelled tip is a conflict, never a payment',
    async () => {
      await database.fresh();
      const { tipId, attemptId } = await newTip();
      await q(`UPDATE tips SET status = 'CANCELLED' WHERE id = $1`, [tipId]);
      const result = await recordProviderEvent(
        database.db,
        paidEvent(attemptId),
      );
      assert.equal(result.outcome, 'conflict');
      assert.equal(await tipStatus(tipId), 'CANCELLED');
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM ledger_entries'))[0].n,
        0,
      );
    },
  );

  await t.test(
    'the provider reference comes only from the verified, applied event',
    async () => {
      await database.fresh();
      const { attemptId } = await newTip();
      await recordProviderEvent(
        database.db,
        paidEvent(attemptId, {
          amountMinor: 1n,
          providerReference: 'wrong-ref',
        }),
      );
      const [afterMismatch] = await q(
        'SELECT provider_reference FROM payment_attempts WHERE id = $1',
        [attemptId],
      );
      assert.equal(
        afterMismatch.provider_reference,
        null,
        'a mismatched event must not set the reference',
      );
      await recordProviderEvent(
        database.db,
        paidEvent(attemptId, { providerReference: 'right-ref' }),
      );
      await recordProviderEvent(
        database.db,
        paidEvent(attemptId, {
          providerReference: 'late-ref',
          eventType: 'payment.failed',
        }),
      );
      const [attempt] = await q(
        'SELECT provider_reference FROM payment_attempts WHERE id = $1',
        [attemptId],
      );
      assert.equal(attempt.provider_reference, 'right-ref');
    },
  );

  await t.test('every mismatch alert is kept, not just the first', async () => {
    await database.fresh();
    const { attemptId } = await newTip();
    await recordProviderEvent(
      database.db,
      paidEvent(attemptId, { amountMinor: 1n }),
    );
    await recordProviderEvent(
      database.db,
      paidEvent(attemptId, { amountMinor: 2n }),
    );
    const keys = (
      await q(
        `SELECT dedupe_key FROM outbox_events WHERE event_type = 'payment.mismatch'`,
      )
    ).map((row) => row.dedupe_key);
    assert.equal(keys.length, 2);
  });

  await t.test(
    'an unknown attempt is refused before anything is stored',
    async () => {
      await database.fresh();
      await assert.rejects(
        recordProviderEvent(database.db, paidEvent(randomUUID())),
        { code: 'ATTEMPT_NOT_FOUND' },
      );
      assert.equal(
        (await q('SELECT count(*)::int AS n FROM provider_events'))[0].n,
        0,
      );
    },
  );
});
