import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  tipStatusView,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

test('tip status view', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const newTip = async () => {
    const { quoteId } = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
    });
    return createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
      message: 'private words',
    });
  };
  // Places rows in a state with the transition triggers bypassed: this tests the read model only.
  const place = async (table, id, status, extra = '') => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `UPDATE ${table} SET status = $1${extra} WHERE id = $2`,
        [status, id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };

  await t.test(
    'a new tip is waiting, then checking after two minutes',
    async () => {
      const { tipId } = await newTip();
      const now = new Date();
      const view = await tipStatusView(database.db, tipId, now);
      assert.equal(view.state, 'waiting');
      assert.deepEqual(view.recipient, {
        handle: 'ada',
        displayName: view.recipient.displayName,
      });
      assert.ok(view.recipient.displayName.length > 0);
      assert.equal(view.amountMinor, '100000');
      assert.equal(view.currency, 'NGN');
      assert.equal(view.completedAt, null);
      assert.doesNotMatch(JSON.stringify(view), /private words/);
      const later = await tipStatusView(
        database.db,
        tipId,
        new Date(now.getTime() + 121_000),
      );
      assert.equal(later.state, 'checking');
    },
  );

  await t.test('an UNKNOWN attempt is checking', async () => {
    const { tipId, attemptId } = await newTip();
    await place('payment_attempts', attemptId, 'UNKNOWN');
    assert.equal(
      (await tipStatusView(database.db, tipId, new Date())).state,
      'checking',
    );
  });

  await t.test(
    'final tip states map to paid, declined and cancelled',
    async () => {
      const paid = await newTip();
      await place('tips', paid.tipId, 'SUCCEEDED', ', completed_at = now()');
      const paidView = await tipStatusView(database.db, paid.tipId, new Date());
      assert.equal(paidView.state, 'paid');
      assert.match(paidView.completedAt, /^\d{4}-\d\d-\d\dT/);
      const failed = await newTip();
      await place('tips', failed.tipId, 'FAILED');
      assert.equal(
        (await tipStatusView(database.db, failed.tipId, new Date())).state,
        'declined',
      );
      const cancelled = await newTip();
      await place('tips', cancelled.tipId, 'CANCELLED');
      assert.equal(
        (await tipStatusView(database.db, cancelled.tipId, new Date())).state,
        'cancelled',
      );
    },
  );

  await t.test('an unknown tip is null', async () => {
    assert.equal(
      await tipStatusView(database.db, randomUUID(), new Date()),
      null,
    );
  });
});
