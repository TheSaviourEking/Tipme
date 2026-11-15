import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  earningsPeriod,
  earningsSummary,
  earningsTrend,
  markAttemptInitiated,
  recordProviderEvent,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Earnings analytics (Pro, ProEarnings board): fixtures with known tips, Lagos days, net after
// TipMe's 10%, confirmed tips only, repeat supporters counted only when opted in.
const [ADA] = DEMO_PROFILES;
const lagos = (iso) => new Date(`${iso}+01:00`);

function makeTip(db) {
  return async (
    tipMinor,
    at,
    { pendingOnly = false, supporterKey, label } = {},
  ) => {
    const quote = await createQuote(db, {
      handle: 'ada',
      tipMinor,
      currency: 'NGN',
      now: new Date(at.getTime() - 60_000),
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      now: new Date(at.getTime() - 60_000),
      ...(supporterKey
        ? { supporterKey, payerDisplayLabel: label, recognitionOn: true }
        : {}),
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
    return BigInt(quote.breakdown.recipientNetMinor);
  };
}

test('earnings: totals, average, best day, change and notes from known tips', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  await database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [
    ADA.id,
  ]);
  const tip = makeTip(db);

  // October 2026: 12 tips. Saturdays (3, 10, 17, 24, 31 Oct) get 6 of them. 23:30 on Sat 31 Oct
  // in Lagos is still October although it is 22:30 UTC.
  let octoberNet = 0n;
  const repeatKey = randomBytes(32).toString('base64url');
  const once = randomBytes(32).toString('base64url');
  for (const day of ['03', '10', '17', '24', '31'])
    octoberNet += await tip(300000n, lagos(`2026-10-${day}T12:00:00`));
  octoberNet += await tip(300000n, lagos('2026-10-31T23:30:00'));
  octoberNet += await tip(200000n, lagos('2026-10-05T09:00:00'), {
    supporterKey: repeatKey,
    label: 'Chidi',
  });
  octoberNet += await tip(200000n, lagos('2026-10-06T09:00:00'), {
    supporterKey: repeatKey,
    label: 'Chidi',
  });
  octoberNet += await tip(200000n, lagos('2026-10-07T09:00:00'), {
    supporterKey: once,
    label: 'Bola',
  });
  // Two tips by a supporter who did not opt in: never a repeat supporter.
  octoberNet += await tip(250000n, lagos('2026-10-08T09:00:00'), {
    label: 'Ngozi',
  });
  octoberNet += await tip(250000n, lagos('2026-10-09T09:00:00'), {
    label: 'Ngozi',
  });
  octoberNet += await tip(500000n, lagos('2026-10-11T18:00:00'));
  // Being confirmed: never counted.
  await tip(900000n, lagos('2026-10-20T10:00:00'), { pendingOnly: true });
  // September: 2 tips. 1 Nov 00:10 Lagos is November.
  const septemberNet =
    (await tip(400000n, lagos('2026-09-12T10:00:00'))) +
    (await tip(200000n, lagos('2026-09-30T23:59:00')));
  const novemberNet = await tip(200000n, lagos('2026-11-01T00:10:00'));

  const now = lagos('2026-11-08T15:00:00');
  const october = await earningsPeriod(db, ADA.id, {
    period: 'month',
    at: '2026-10-15',
    now,
  });
  assert.equal(october.from, '2026-10-01');
  assert.equal(october.to, '2026-10-31');
  assert.equal(october.complete, true);
  assert.equal(october.tips, 12);
  assert.equal(october.netMinor, octoberNet.toString());
  assert.equal(
    october.averageMinor,
    ((octoberNet * 2n + 12n) / 24n).toString(),
  );
  assert.equal(october.previous.tips, 2);
  assert.equal(october.previous.netMinor, septemberNet.toString());
  assert.equal(
    october.changePct,
    Math.round(
      (Number(octoberNet - septemberNet) / Number(septemberNet)) * 100,
    ),
  );
  assert.deepEqual(october.byWeekday, [1, 1, 1, 1, 1, 6, 1]);
  assert.deepEqual(october.bestDay, { weekday: 5, tips: 6 });
  // Chidi tipped twice and opted in; Ngozi tipped twice without opting in.
  assert.equal(october.repeatSupporters, 1);
  assert.equal(
    october.notes[0],
    'Most of your tips came on Saturdays: 6 of 12.',
  );
  assert.equal(october.notes[1], '1 person tipped you more than once.');
  assert.match(
    october.notes[2],
    /^Your average tip went from ₦[\d,.]+ in September to ₦[\d,.]+\.$/,
  );

  // This month so far (1–8 Nov) against 1–8 Oct.
  const thisMonth = await earningsPeriod(db, ADA.id, { period: 'month', now });
  assert.equal(thisMonth.complete, false);
  assert.equal(thisMonth.to, '2026-11-08');
  assert.deepEqual(
    [thisMonth.previous.from, thisMonth.previous.to],
    ['2026-10-01', '2026-10-08'],
  );
  assert.equal(thisMonth.tips, 1);
  assert.equal(thisMonth.netMinor, novemberNet.toString());
  assert.equal(thisMonth.previous.tips, 5);
  assert.deepEqual(
    { netMinor: thisMonth.previous.netMinor, tips: thisMonth.previous.tips },
    await sumBetween('2026-10-01', '2026-10-08'),
  );
  // Under 10 tips: no notes, and no best day under 5.
  assert.deepEqual(thisMonth.notes, []);
  assert.equal(thisMonth.bestDay, null);

  // A day after today is refused.
  assert.equal(
    await earningsPeriod(db, ADA.id, { period: 'week', at: '2026-11-09', now }),
    null,
  );

  const summary = await earningsSummary(db, ADA.id, now);
  assert.equal(summary.today, '2026-11-08');
  assert.deepEqual(
    summary.thisMonth.previous,
    await sumBetween('2026-10-01', '2026-10-08'),
  );
  assert.equal(summary.allTime.tips, 15);
  assert.equal(
    summary.allTime.netMinor,
    (octoberNet + septemberNet + novemberNet).toString(),
  );
  assert.equal(summary.thisYear.tips, 15);
  // Mon 2 – Sun 8 Nov: nothing; same days last week (26 Oct – 1 Nov): Sat 31 Oct ×2 and 1 Nov.
  assert.equal(summary.thisWeek.tips, 0);
  assert.equal(summary.thisWeek.previous.tips, 3);

  async function sumBetween(from, to) {
    const { rows } = await database.pool.query(
      `SELECT COALESCE(SUM(q.recipient_net_minor),0)::text AS net, COUNT(*)::int AS tips FROM tips t
         JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
        WHERE t.profile_id = $1 AND t.status = 'SUCCEEDED'
          AND (t.completed_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $2 AND $3`,
      [ADA.id, from, to],
    );
    return { netMinor: rows[0].net, tips: rows[0].tips };
  }

  const months = await earningsTrend(db, ADA.id, { unit: 'month', now });
  assert.equal(months.points.length, 12);
  assert.deepEqual(months.points.at(-1), {
    from: '2026-11-01',
    netMinor: novemberNet.toString(),
    tips: 1,
    complete: false,
  });
  assert.equal(months.points.at(-2).tips, 12);
  assert.equal(months.points.at(-3).tips, 2);
  const weeks = await earningsTrend(db, ADA.id, { unit: 'week', now });
  assert.equal(weeks.points.length, 12);
  assert.equal(weeks.points.at(-1).from, '2026-11-02');
  assert.equal(weeks.points.at(-2).from, '2026-10-26');
  assert.equal(weeks.points.at(-2).tips, 3);
});
