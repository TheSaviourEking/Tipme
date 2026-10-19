import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createPayout,
  createQuote,
  dashboardSummary,
  DEMO_PROFILES,
  listMyTips,
  markAttemptInitiated,
  myTipDetail,
  recentActivity,
  recordProviderEvent,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;
const lagos = (iso) => new Date(`${iso}+01:00`);

test('dashboard data', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;

  /** A tip the provider confirmed at `at` (Lagos time). */
  const paidTip = async (
    handle,
    tipMinor,
    at,
    { label, message, pendingOnly = false } = {},
  ) => {
    const quote = await createQuote(db, {
      handle,
      tipMinor,
      currency: 'NGN',
      now: new Date(at.getTime() - 60_000),
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      payerDisplayLabel: label,
      message,
      now: new Date(at.getTime() - 60_000),
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
      eventType: pendingOnly ? 'payment.pending' : 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: tipMinor,
      currency: 'NGN',
      providerFeeMinor: quote.breakdown.providerFeeMinor,
      signatureVerified: true,
      payload: {},
      now: at,
    });
    return { ...intent, reference, net: quote.breakdown.recipientNetMinor };
  };

  // Wednesday 14 October 2026, noon in Lagos. Dates are in the past because a confirming tip has
  // no completion time and is ordered by when it was really created (now).
  const now = lagos('2026-10-14T12:00:00');
  const lateYesterday = await paidTip(
    'tobi',
    200000n,
    lagos('2026-10-13T23:30:00'),
    { label: 'Ada M.' },
  );
  const earlyToday = await paidTip(
    'tobi',
    100000n,
    lagos('2026-10-14T00:30:00'),
    { message: 'Lovely coffee' },
  );
  const lastWeek = await paidTip('tobi', 300000n, lagos('2026-10-08T09:00:00'));
  const confirming = await paidTip(
    'tobi',
    100000n,
    lagos('2026-10-14T11:00:00'),
    { pendingOnly: true },
  );
  await paidTip('ada', 500000n, lagos('2026-10-14T08:00:00'));

  await t.test('periods follow Lagos days and weeks', async () => {
    const summary = await dashboardSummary(db, TOBI.id, now);
    assert.equal(summary.currency, 'NGN');
    assert.equal(summary.today, earlyToday.net.toString());
    assert.equal(summary.yesterday, lateYesterday.net.toString());
    assert.equal(
      summary.thisWeek,
      (earlyToday.net + lateYesterday.net).toString(),
    );
    assert.equal(summary.lastWeek, lastWeek.net.toString());
    assert.deepEqual(
      summary.last7Days.map((day) => day.date),
      [
        '2026-10-08',
        '2026-10-09',
        '2026-10-10',
        '2026-10-11',
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
      ],
    );
    assert.equal(summary.last7Days[0].netMinor, lastWeek.net.toString());
    assert.equal(summary.last7Days[1].netMinor, '0');
  });

  await t.test(
    'the balance holds only confirmed money; confirming money is separate',
    async () => {
      const summary = await dashboardSummary(db, TOBI.id, now);
      assert.equal(
        summary.availableMinor,
        (earlyToday.net + lateYesterday.net + lastWeek.net).toString(),
      );
      assert.equal(summary.confirmingMinor, confirming.net.toString());
      await createPayout(db, {
        profileId: TOBI.id,
        tipIds: [lastWeek.tipId],
        idempotencyKey: randomUUID(),
      });
      const after = await dashboardSummary(db, TOBI.id, now);
      assert.equal(
        after.availableMinor,
        (earlyToday.net + lateYesterday.net).toString(),
      );
    },
  );

  await t.test('tips are listed newest first, a page at a time', async () => {
    const first = await listMyTips(db, TOBI.id, { limit: 2, status: 'all' });
    assert.equal(first.items.length, 2);
    assert.equal(first.items[0].tipId, confirming.tipId);
    assert.equal(first.items[0].state, 'confirming');
    assert.equal(first.items[1].tipId, earlyToday.tipId);
    assert.equal(first.items[1].hasMessage, true);
    const second = await listMyTips(db, TOBI.id, {
      limit: 2,
      status: 'all',
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((item) => item.tipId),
      [lateYesterday.tipId, lastWeek.tipId],
    );
    assert.equal(second.items[0].supporterLabel, 'Ada M.');
    assert.equal(second.nextCursor, null);
    const paid = await listMyTips(db, TOBI.id, { limit: 50, status: 'paid' });
    assert.equal(paid.items.length, 3);
    assert.ok(paid.items.every((item) => item.state === 'paid'));
  });

  await t.test(
    'a tip detail carries the message, the amounts and the proof',
    async () => {
      const detail = await myTipDetail(db, TOBI.id, earlyToday.tipId);
      assert.equal(detail.message, 'Lovely coffee');
      assert.equal(detail.grossMinor, '100000');
      assert.equal(detail.netMinor, earlyToday.net.toString());
      assert.equal(detail.platformFeeMinor, '5000');
      assert.equal(detail.providerFeeMinor, '1500');
      assert.equal(detail.proof.verified, true);
      assert.equal(detail.proof.provider, 'mock');
      assert.equal(detail.proof.referenceTail, earlyToday.reference.slice(-6));
      assert.equal(
        JSON.stringify(detail).includes(earlyToday.reference),
        false,
      );
      assert.equal(await myTipDetail(db, ADA.id, earlyToday.tipId), null);
    },
  );

  await t.test(
    'recent activity mixes tips and withdrawals by time',
    async () => {
      const activity = await recentActivity(db, TOBI.id, 10);
      assert.ok(
        activity.some(
          (row) => row.kind === 'withdrawal' && row.state === 'requested',
        ),
      );
      assert.ok(
        activity.some((row) => row.kind === 'tip' && row.state === 'paid'),
      );
      const times = activity.map((row) => Date.parse(row.at));
      assert.deepEqual(
        [...times].sort((a, b) => b - a),
        times,
      );
    },
  );
});

test('fix: an unpaid tip never reaches the dashboard, nor its message', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const quote = await createQuote(db, {
    handle: 'tobi',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    message: 'unpaid words',
    payerDisplayLabel: 'Troll',
  });
  const list = await listMyTips(db, TOBI.id, { status: 'all', limit: 50 });
  assert.equal(
    list.items.some((item) => item.tipId === intent.tipId),
    false,
  );
  const confirming = await listMyTips(db, TOBI.id, {
    status: 'confirming',
    limit: 50,
  });
  assert.equal(confirming.items.length, 0);
  assert.equal(await myTipDetail(db, TOBI.id, intent.tipId), null);
  assert.equal(
    (await recentActivity(db, TOBI.id, 10)).some(
      (row) => row.id === intent.tipId,
    ),
    false,
  );
});
