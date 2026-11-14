import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createPayout,
  createQuote,
  dashboardSummary,
  hideMessage,
  DEMO_PROFILES,
  listMyTips,
  listMyWithdrawals,
  markAttemptInitiated,
  myTipDetail,
  myTipTotals,
  recentActivity,
  recordProviderEvent,
  setPayoutDestination,
} from '../../dist/index.js';
import { mailSealing } from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;
const lagos = (iso) => new Date(`${iso}+01:00`);

/** Makes a function that creates a tip the provider confirmed at `at`. */
function makePaidTip(db) {
  return async (
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
}

test('dashboard data', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;

  const paidTip = makePaidTip(db);

  // Wednesday 14 October 2026, noon in Lagos. Dates are in the past because a confirming tip has
  // no completion time and is ordered by when it was really created (now).
  const now = lagos('2026-10-14T12:00:00');
  const lateYesterday = await paidTip(
    'tobi',
    400000n,
    lagos('2026-10-13T23:30:00'),
    { label: 'Ada M.' },
  );
  const earlyToday = await paidTip(
    'tobi',
    200000n,
    lagos('2026-10-14T00:30:00'),
    { message: 'Lovely coffee' },
  );
  const lastWeek = await paidTip('tobi', 600000n, lagos('2026-10-08T09:00:00'));
  const older = await paidTip('tobi', 500000n, lagos('2026-10-01T09:00:00'));
  const confirming = await paidTip(
    'tobi',
    200000n,
    lagos('2026-10-14T11:00:00'),
    { pendingOnly: true },
  );
  await paidTip('ada', 1000000n, lagos('2026-10-14T08:00:00'));

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
        (
          earlyToday.net +
          lateYesterday.net +
          lastWeek.net +
          older.net
        ).toString(),
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
        (earlyToday.net + lateYesterday.net + older.net).toString(),
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
      limit: 3,
      status: 'all',
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((item) => item.tipId),
      [lateYesterday.tipId, lastWeek.tipId, older.tipId],
    );
    assert.equal(second.items[0].supporterLabel, 'Ada M.');
    assert.equal(second.nextCursor, null);
    const paid = await listMyTips(db, TOBI.id, { limit: 50, status: 'paid' });
    assert.equal(paid.items.length, 4);
    assert.ok(paid.items.every((item) => item.state === 'paid'));
  });

  await t.test(
    'a tip detail carries the message, the amounts and the proof',
    async () => {
      const detail = await myTipDetail(db, TOBI.id, earlyToday.tipId);
      assert.equal(detail.message, 'Lovely coffee');
      assert.equal(detail.grossMinor, '200000');
      assert.equal(detail.netMinor, earlyToday.net.toString());
      assert.equal(detail.platformFeeMinor, '11000');
      assert.equal(detail.providerFeeMinor, '3000');
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
    tipMinor: 400000n,
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

// Withdrawals: their own list, each with the bank it went to.
const sealing = mailSealing(Buffer.alloc(32, 7));

function withdrawalTools(database) {
  const { db, pool } = database;
  let next = 0;
  const setBank = (profileId, bankName, last4) =>
    setPayoutDestination(db, {
      profileId,
      provider: 'mock',
      destinationRef: `dest_${randomUUID()}`,
      bankCode: '058',
      bankName,
      last4,
      status: 'usable',
      sealing,
    });
  const currentDestination = async (profileId) =>
    (
      await pool.query(
        'SELECT id FROM payout_destinations WHERE profile_id = $1 AND replaced_at IS NULL',
        [profileId],
      )
    ).rows[0]?.id ?? null;
  /** A payout row with exact times; `destinationId` defaults to none. */
  const payout = async (
    profileId,
    {
      status = 'REQUESTED',
      createdAt,
      destinationId = null,
      amount = 100000,
      review = false,
    } = {},
  ) => {
    const id = randomUUID();
    next += 1;
    await pool.query(
      `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                            request_fingerprint, created_at, destination_id, provider_review_at, paid_at)
       VALUES ($1, $2, 'NGN', $3, $4::payout_status, $5, $6, $7::timestamptz, $8,
               CASE WHEN $9::boolean THEN now() END,
               CASE WHEN $4::text = 'PAID' THEN $7::timestamptz END)`,
      [
        id,
        profileId,
        amount,
        status,
        `key_${id}`,
        `fp_${id}`,
        createdAt ?? new Date(Date.UTC(2026, 9, 1, 10, next)).toISOString(),
        destinationId,
        review,
      ],
    );
    return id;
  };
  return { setBank, currentDestination, payout };
}

test('withdrawals are listed apart from tips, newest request first, each with its state', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const { payout } = withdrawalTools(database);
  const paidTip = makePaidTip(db);
  const states = [
    ['REQUESTED', false, 'requested'],
    ['PROCESSING', false, 'processing'],
    ['PROCESSING', true, 'in_review'],
    ['PAID', false, 'sent'],
    ['FAILED', false, 'failed'],
    ['REVERSED', false, 'reversed'],
  ];
  const ids = [];
  for (const [status, review] of states) {
    ids.push(await payout(TOBI.id, { status, review }));
  }
  for (let i = 0; i < 12; i += 1)
    await paidTip('tobi', 200000n, new Date(Date.now() - 3_600_000 + i * 1000));
  const page = await listMyWithdrawals(db, TOBI.id, {});
  assert.deepEqual(
    page.items.map((row) => row.payoutId),
    [...ids].reverse(),
  );
  assert.deepEqual(
    page.items.map((row) => row.state),
    states.map(([, , state]) => state).reverse(),
  );
  const sent = page.items.find((row) => row.state === 'sent');
  assert.notEqual(sent.paidAt, null);
  assert.equal(page.items[0].paidAt, null);
  assert.equal(page.items[0].amountMinor, '100000');
  assert.equal(page.items[0].currency, 'NGN');
  const activity = await recentActivity(db, TOBI.id, 10);
  assert.equal(
    activity.some((row) => row.kind === 'withdrawal'),
    false,
    'twelve tips push the withdrawals out of the mixed feed',
  );
});

test('withdrawals page by cursor without gaps or repeats, even within one millisecond', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const { payout } = withdrawalTools(database);
  const times = [
    '2026-10-14T10:00:00.000000Z',
    '2026-10-14T10:00:01.000100Z',
    '2026-10-14T10:00:01.000400Z',
    '2026-10-14T10:00:02.000000Z',
    '2026-10-14T10:00:03.000000Z',
  ];
  const ids = [];
  for (const createdAt of times) ids.push(await payout(TOBI.id, { createdAt }));
  // Limits 1 and 3 put a page boundary between the two rows that share a millisecond.
  for (const limit of [1, 2, 3]) {
    const seen = [];
    let cursor;
    do {
      const page = await listMyWithdrawals(db, TOBI.id, { limit, cursor });
      seen.push(...page.items.map((row) => row.payoutId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, [...ids].reverse(), `limit ${limit}`);
  }
  const first = await listMyWithdrawals(db, TOBI.id, { limit: 2 });
  const tampered = await listMyWithdrawals(db, TOBI.id, {
    limit: 2,
    cursor: '!!',
  });
  assert.deepEqual(tampered, first);
});

test('a withdrawal keeps the bank it went to after the bank changes', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const { setBank, currentDestination, payout } = withdrawalTools(database);
  await setBank(TOBI.id, 'GTBank', '1234');
  const before = await payout(TOBI.id, {
    destinationId: await currentDestination(TOBI.id),
    createdAt: '2026-10-14T10:00:00.000000Z',
  });
  await setBank(TOBI.id, 'Kuda', '9876');
  const after = await payout(TOBI.id, {
    destinationId: await currentDestination(TOBI.id),
    createdAt: '2026-10-14T11:00:00.000000Z',
  });
  const page = await listMyWithdrawals(db, TOBI.id, {});
  const activity = await recentActivity(db, TOBI.id, 10);
  for (const rows of [
    page.items.map((row) => [row.payoutId, row.bank]),
    activity.map((row) => [row.id, row.bank]),
  ]) {
    const byId = new Map(rows);
    assert.deepEqual(byId.get(before), { bankName: 'GTBank', last4: '1234' });
    assert.deepEqual(byId.get(after), { bankName: 'Kuda', last4: '9876' });
  }
});

test('a payout without a destination shows no bank, never the current one', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const { setBank, payout } = withdrawalTools(database);
  await setBank(TOBI.id, 'GTBank', '1234');
  const id = await payout(TOBI.id, { destinationId: null });
  const page = await listMyWithdrawals(db, TOBI.id, {});
  assert.equal(page.items.find((row) => row.payoutId === id).bank, null);
  const activity = await recentActivity(db, TOBI.id, 10);
  assert.equal(activity.find((row) => row.id === id).bank, null);
});

test("another recipient's withdrawals and banks never appear", async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const { setBank, currentDestination, payout } = withdrawalTools(database);
  await setBank(ADA.id, 'Zenith', '5555');
  const adaBank = await currentDestination(ADA.id);
  const adas = await payout(ADA.id, { destinationId: adaBank });
  const tobis = await payout(TOBI.id, { destinationId: adaBank });
  const tobiPage = await listMyWithdrawals(db, TOBI.id, {});
  assert.deepEqual(
    tobiPage.items.map((row) => row.payoutId),
    [tobis],
  );
  assert.equal(tobiPage.items[0].bank, null);
  const activity = await recentActivity(db, TOBI.id, 10);
  assert.equal(
    activity.some((row) => row.id === adas),
    false,
  );
  assert.equal(activity.find((row) => row.id === tobis).bank, null);
  assert.equal(JSON.stringify(tobiPage).includes('Zenith'), false);
});

test('tip rows in activity have no bank', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  await makePaidTip(db)('tobi', 200000n, new Date(Date.now() - 60_000));
  const activity = await recentActivity(db, TOBI.id, 10);
  const tips = activity.filter((row) => row.kind === 'tip');
  assert.ok(tips.length > 0);
  assert.ok(tips.every((row) => row.bank === null));
});

test('tip totals count only paid tips, at what the recipient received', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const paidTip = makePaidTip(db);
  const at = (minutes) => new Date(Date.now() - minutes * 60_000);
  const empty = await myTipTotals(db, TOBI.id);
  assert.deepEqual(empty, {
    currency: 'NGN',
    receivedNetMinor: '0',
    paidTipCount: 0,
  });
  const a = await paidTip('tobi', 400000n, at(30));
  const b = await paidTip('tobi', 200000n, at(20));
  await paidTip('tobi', 200000n, at(10), { pendingOnly: true });
  const failed = await paidTip('tobi', 300000n, at(5), {
    pendingOnly: true,
  });
  await database.pool.query("UPDATE tips SET status = 'FAILED' WHERE id = $1", [
    failed.tipId,
  ]);
  await paidTip('ada', 1000000n, at(5));
  const totals = await myTipTotals(db, TOBI.id);
  assert.deepEqual(totals, {
    currency: 'NGN',
    receivedNetMinor: (a.net + b.net).toString(),
    paidTipCount: 2,
  });
  assert.equal(totals.receivedNetMinor, '558000');
  assert.equal((await myTipTotals(db, ADA.id)).paidTipCount, 1);
});

test('two tips under one name are two tips', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const paidTip = makePaidTip(db);
  await paidTip('tobi', 200000n, new Date(Date.now() - 120_000), {
    label: 'Ada M.',
  });
  await paidTip('tobi', 200000n, new Date(Date.now() - 60_000), {
    label: 'Ada M.',
  });
  assert.equal((await myTipTotals(db, TOBI.id)).paidTipCount, 2);
});

test('the note filter lists only tips whose note the recipient can read', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const paidTip = makePaidTip(db);
  const at = (minutes) => new Date(Date.now() - minutes * 60_000);
  const withNote = await paidTip('tobi', 200000n, at(50), {
    message: 'Great work',
    label: 'Ada M.',
  });
  await paidTip('tobi', 200000n, at(40));
  const hidden = await paidTip('tobi', 200000n, at(30), {
    message: 'Secret words',
  });
  await hideMessage(db, { profileId: TOBI.id, tipId: hidden.tipId });
  await paidTip('tobi', 200000n, at(20), {
    message: 'Not yet',
    pendingOnly: true,
  });
  const noted = await listMyTips(db, TOBI.id, {
    status: 'paid',
    note: 'with',
    limit: 50,
  });
  assert.deepEqual(
    noted.items.map((item) => item.tipId),
    [withNote.tipId],
  );
  const searched = await listMyTips(db, TOBI.id, {
    status: 'paid',
    note: 'with',
    q: 'ada',
  });
  assert.equal(searched.items.length, 1);
  const none = await listMyTips(db, TOBI.id, {
    status: 'paid',
    note: 'with',
    q: 'nobody',
  });
  assert.equal(none.items.length, 0);
  // Paging with the cursor, one at a time.
  const second = await paidTip('tobi', 200000n, at(10), { message: 'Again' });
  const first = await listMyTips(db, TOBI.id, {
    status: 'paid',
    note: 'with',
    limit: 1,
  });
  assert.deepEqual(
    first.items.map((item) => item.tipId),
    [second.tipId],
  );
  const next = await listMyTips(db, TOBI.id, {
    status: 'paid',
    note: 'with',
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    next.items.map((item) => item.tipId),
    [withNote.tipId],
  );
  assert.equal(next.nextCursor, null);
});

test('fix: tips paged by cursor lose none when they were paid within one second', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const paidTip = makePaidTip(db);
  const base = Date.now() - 3_600_000;
  const tips = [];
  for (let i = 0; i < 4; i += 1)
    tips.push(await paidTip('tobi', 200000n, new Date(base + i * 1000)));
  // Two share a millisecond and two share a second: only microseconds tell them apart.
  const stamps = [
    '2026-10-14T10:00:05.000100Z',
    '2026-10-14T10:00:05.000400Z',
    '2026-10-14T10:00:05.700000Z',
    '2026-10-14T10:00:05.700900Z',
  ];
  for (const [i, tip] of tips.entries())
    await database.pool.query(
      'UPDATE tips SET completed_at = $2::timestamptz WHERE id = $1',
      [tip.tipId, stamps[i]],
    );
  const expected = [...tips].reverse().map((tip) => tip.tipId);
  for (const limit of [1, 2, 3]) {
    const seen = [];
    let cursor;
    do {
      const page = await listMyTips(db, TOBI.id, {
        status: 'paid',
        limit,
        cursor,
      });
      seen.push(...page.items.map((item) => item.tipId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, expected, `limit ${limit}`);
  }
});
