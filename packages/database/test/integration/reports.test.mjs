import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  buildWeeklyReport,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  isoWeekOf,
  listNotifications,
  listWeeklyReports,
  markAttemptInitiated,
  previousIsoWeek,
  recordProviderEvent,
  runWeeklyReports,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;
const lagos = (iso) => new Date(`${iso}+01:00`);

test('weekly reports', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const paid = async (handle, tipMinor, at, { label, message } = {}) => {
    const quote = await createQuote(db, { handle, tipMinor, currency: 'NGN' });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      payerDisplayLabel: label,
      message,
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
      eventType: 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: tipMinor,
      currency: 'NGN',
      providerFeeMinor: quote.breakdown.providerFeeMinor,
      signatureVerified: true,
      payload: {},
      now: at,
    });
    return quote.breakdown.recipientNetMinor;
  };

  // Week 2026-W41 runs Monday 5 to Sunday 11 October (Lagos); W40 is the week before.
  const prior = await paid('tobi', 100000n, lagos('2026-09-30T10:00:00'), {
    label: 'Zed Q.',
  });
  const a = await paid('tobi', 200000n, lagos('2026-10-05T09:00:00'), {
    label: 'Ada M.',
    message: 'Great coffee',
  });
  const b = await paid('tobi', 100000n, lagos('2026-10-07T18:00:00'), {
    label: 'Bola',
  });
  const c = await paid('tobi', 300000n, lagos('2026-10-07T19:00:00'), {
    label: 'Ada M.',
  });
  const d = await paid('tobi', 100000n, lagos('2026-10-11T23:30:00'), {
    label: 'Bola',
  });
  await paid('tobi', 500000n, lagos('2026-10-12T00:30:00'));

  await t.test('ISO weeks follow Lagos time', () => {
    assert.equal(isoWeekOf(lagos('2026-10-11T23:30:00')), '2026-W41');
    assert.equal(isoWeekOf(lagos('2026-10-12T00:30:00')), '2026-W42');
    assert.equal(previousIsoWeek(lagos('2026-10-12T07:00:00')), '2026-W41');
    assert.equal(previousIsoWeek(lagos('2027-01-04T07:00:00')), '2026-W53');
  });

  await t.test(
    'a report sums the week and finds the best day and the most frequent supporter',
    async () => {
      const report = await buildWeeklyReport(db, TOBI.id, '2026-W41');
      const total = a + b + c + d;
      assert.equal(report.week, '2026-W41');
      assert.equal(report.totalNetMinor, total.toString());
      assert.equal(report.tipCount, 4);
      assert.equal(report.notesCount, 1);
      assert.deepEqual(report.bestDay, {
        date: '2026-10-07',
        netMinor: (b + c).toString(),
      });
      assert.equal(
        report.changePct,
        Math.round(Number(((total - prior) * 100n) / prior)),
      );
      // Ada M. and Bola both tipped twice; the more recent wins (Bola, 11 October).
      assert.equal(report.topSupporterLabel, 'Bola');
    },
  );

  await t.test(
    'running the week twice creates each report once, only for people who were tipped',
    async () => {
      const first = await runWeeklyReports(db, { isoWeek: '2026-W41' });
      assert.equal(first.created, 1);
      assert.equal(
        (await runWeeklyReports(db, { isoWeek: '2026-W41' })).created,
        0,
      );
      assert.equal((await listWeeklyReports(db, ADA.id)).length, 0);
      const reports = await listWeeklyReports(db, TOBI.id);
      assert.deepEqual(
        reports.map((r) => r.week),
        ['2026-W41'],
      );
      const notes = await listNotifications(db, TOBI.userId, {});
      assert.equal(notes.filter((n) => n.kind === 'weekly_report').length, 1);
    },
  );
});
