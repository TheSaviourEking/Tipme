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
      tipMinor: 200000n,
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
      assert.equal(view.amountMinor, '200000');
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
  await t.test(
    'the paid receipt says the note may be shown, and never carries the note',
    async () => {
      const { quoteId } = await createQuote(database.db, {
        handle: 'ada',
        tipMinor: 200000n,
        currency: 'NGN',
      });
      const agreed = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
        message: 'private words',
        noteMayShow: true,
      });
      const waiting = await tipStatusView(
        database.db,
        agreed.tipId,
        new Date(),
      );
      assert.equal('noteMayShow' in waiting, false);
      await place('tips', agreed.tipId, 'SUCCEEDED', ', completed_at = now()');
      const view = await tipStatusView(database.db, agreed.tipId, new Date());
      assert.equal(view.noteMayShow, true);
      assert.doesNotMatch(JSON.stringify(view), /private words/);

      const kept = await newTip();
      await place('tips', kept.tipId, 'SUCCEEDED', ', completed_at = now()');
      const keptView = await tipStatusView(database.db, kept.tipId, new Date());
      assert.equal('noteMayShow' in keptView, false);
    },
  );
  const setPage = (sql) =>
    database.pool.query(
      `UPDATE profiles SET ${sql} WHERE handle_lower = 'ada'`,
    );
  const paidTip = async () => {
    const tip = await newTip();
    await place('tips', tip.tipId, 'SUCCEEDED', ', completed_at = now()');
    return tip;
  };

  await t.test(
    "a paid tip receipt carries the recipient's line; a Free page shows paper, unsigned",
    async () => {
      await setPage(
        `plan = 'free', thanks_line = 'Thank you for backing me.', thanks_style = 'night', thanks_signed = true`,
      );
      const { tipId } = await paidTip();
      const view = await tipStatusView(database.db, tipId, new Date());
      assert.deepEqual(view.thanks, {
        line: 'Thank you for backing me.',
        style: 'paper',
      });
      assert.doesNotMatch(JSON.stringify(view), /private words/);
    },
  );

  await t.test(
    'a receipt that is not paid has no thank-you, and a page without a line has none',
    async () => {
      await setPage(`thanks_line = 'Thank you for backing me.'`);
      const waiting = await newTip();
      assert.equal(
        'thanks' in
          (await tipStatusView(database.db, waiting.tipId, new Date())),
        false,
      );
      const failed = await newTip();
      await place('tips', failed.tipId, 'FAILED');
      assert.equal(
        'thanks' in
          (await tipStatusView(database.db, failed.tipId, new Date())),
        false,
      );
      await setPage(`thanks_line = NULL`);
      const { tipId } = await paidTip();
      assert.equal(
        'thanks' in (await tipStatusView(database.db, tipId, new Date())),
        false,
      );
    },
  );

  await t.test(
    'a page that leaves Pro shows paper and unsigned, and its choices come back on Pro',
    async () => {
      await setPage(
        `plan = 'pro', thanks_line = 'Thank you.', thanks_style = 'violet', thanks_signed = true`,
      );
      const { tipId } = await paidTip();
      const pro = await tipStatusView(database.db, tipId, new Date());
      const first = pro.recipient.displayName.split(/\s+/)[0];
      assert.deepEqual(pro.thanks, {
        line: 'Thank you.',
        style: 'violet',
        signature: first,
      });
      await setPage(`plan = 'free'`);
      assert.deepEqual(
        (await tipStatusView(database.db, tipId, new Date())).thanks,
        { line: 'Thank you.', style: 'paper' },
      );
      await setPage(`plan = 'pro'`);
      assert.deepEqual(
        (await tipStatusView(database.db, tipId, new Date())).thanks,
        pro.thanks,
      );
      // The line as it is now, not as it was when the tip was made.
      await setPage(`thanks_line = 'Edited.'`);
      assert.equal(
        (await tipStatusView(database.db, tipId, new Date())).thanks.line,
        'Edited.',
      );
      await setPage(
        `plan = 'free', thanks_line = NULL, thanks_style = NULL, thanks_signed = false`,
      );
    },
  );
  await t.test(
    'collected, checking and cancelled receipts carry no thank-you and no consent',
    async () => {
      await setPage(`thanks_line = 'Thank you for backing me.'`);
      const agreedTip = async () => {
        const { quoteId } = await createQuote(database.db, {
          handle: 'ada',
          tipMinor: 200000n,
          currency: 'NGN',
        });
        return createPaymentIntent(database.db, {
          quoteId,
          idempotencyKey: randomUUID(),
          message: 'private words',
          noteMayShow: true,
        });
      };
      const collected = await agreedTip();
      await database.pool.query(
        'UPDATE payment_attempts SET collected_at = now() WHERE id = $1',
        [collected.attemptId],
      );
      const checking = await agreedTip();
      await place('payment_attempts', checking.attemptId, 'UNKNOWN');
      const cancelled = await agreedTip();
      await place('tips', cancelled.tipId, 'CANCELLED');
      for (const [tip, state] of [
        [collected, 'collected'],
        [checking, 'checking'],
        [cancelled, 'cancelled'],
      ]) {
        const view = await tipStatusView(database.db, tip.tipId, new Date());
        assert.equal(view.state, state);
        assert.equal('thanks' in view, false, state);
        assert.equal('noteMayShow' in view, false, state);
      }
      await setPage(`thanks_line = NULL`);
    },
  );

  await t.test(
    'a suspended page’s line does not show on receipts, and shows again once it is active',
    async () => {
      await setPage(`thanks_line = 'Thank you.'`);
      const { tipId } = await paidTip();
      await setPage(`status = 'suspended'`);
      try {
        const view = await tipStatusView(database.db, tipId, new Date());
        assert.equal(view.state, 'paid');
        assert.equal('thanks' in view, false);
      } finally {
        await setPage(`status = 'active'`);
      }
      assert.deepEqual(
        (await tipStatusView(database.db, tipId, new Date())).thanks,
        { line: 'Thank you.', style: 'paper' },
      );
      await setPage(`thanks_line = NULL`);
    },
  );
});
