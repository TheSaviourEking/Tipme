import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  accountDetail,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  recordProviderEvent,
  renameHandle,
  searchAccounts,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;

test('staff account search and summary', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const handles = async (query) =>
    (await searchAccounts(db, { query })).map((row) => row.handle);

  await t.test(
    'finds by handle, old handle or name, never by phone, and skips rehearsal pages',
    async () => {
      await database.fresh();
      assert.deepEqual(await handles('@ada'), ['ada']);
      assert.deepEqual(await handles('okafor'), ['ada']);
      assert.deepEqual(await handles(''), []);
      // Phone numbers are private: no match even for the exact number.
      assert.deepEqual(await handles('+2348000000001'), []);
      assert.deepEqual(await handles('%'), []);

      await renameHandle(db, { userId: TOBI.userId, handle: 'tobi_new' });
      assert.deepEqual(await handles('tobi'), ['tobi_new']);

      await database.pool.query(
        'UPDATE profiles SET rehearsal_run_id = $1 WHERE id = $2',
        [randomUUID(), ADA.id],
      );
      assert.deepEqual(await handles('ada'), []);
      assert.equal(await accountDetail(db, ADA.id), null);
    },
  );

  await t.test(
    'the summary shows pricing and money totals that reconcile with the 10% rule',
    async () => {
      await database.fresh();
      const quote = await createQuote(db, {
        handle: 'ada',
        tipMinor: 200000n,
        currency: 'NGN',
      });
      const intent = await createPaymentIntent(db, {
        quoteId: quote.quoteId,
        idempotencyKey: randomUUID(),
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
        amountMinor: 200000n,
        currency: 'NGN',
        providerFeeMinor: 3000n,
        signatureVerified: true,
        payload: {},
      });
      const detail = await accountDetail(db, ADA.id);
      assert.equal(detail.handle, 'ada');
      assert.equal(detail.platformFeeBps, null);
      assert.equal(detail.feeFreeRemaining, 0);
      assert.equal(detail.paidTipCount, 1);
      assert.equal(detail.paidGrossMinor, '200000');
      assert.equal(detail.availableMinor, '180000');
      assert.equal(detail.confirmingMinor, '0');
      assert.equal('phone' in detail, false);
      assert.equal('email' in detail, false);
    },
  );
});

test('anyone reports a live page; staff get one issue a day per page and read every report', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const { reportProfile, listProfileReports } =
    await import('../../dist/index.js');
  await database.fresh();
  const morning = new Date('2026-10-26T08:00:00Z');
  await reportProfile(db, {
    handle: 'Ada',
    reason: 'impersonation',
    details: '  This is not the real Ada.  ',
    now: morning,
  });
  await reportProfile(db, {
    handle: 'ada',
    reason: 'scam',
    now: new Date(morning.getTime() + 60_000),
  });
  const reports = await listProfileReports(db, ADA.id);
  assert.deepEqual(
    reports.map((r) => [r.reason, r.details]),
    [
      ['scam', null],
      ['impersonation', 'This is not the real Ada.'],
    ],
  );
  const issues = (
    await database.pool.query(
      `SELECT kind, severity, subject->>'profileId' AS profile FROM issues WHERE kind = 'profile_reported'`,
    )
  ).rows;
  assert.deepEqual(issues, [
    { kind: 'profile_reported', severity: 'account', profile: ADA.id },
  ]);
  // The next Lagos day opens a new issue for new reports.
  await reportProfile(db, {
    handle: 'ada',
    reason: 'other',
    now: new Date('2026-10-27T08:00:00Z'),
  });
  assert.equal(
    (
      await database.pool.query(
        `SELECT count(*)::int AS n FROM issues WHERE kind = 'profile_reported'`,
      )
    ).rows[0].n,
    2,
  );
  // A page that isn't live answers like an unknown one.
  await database.pool.query(
    `UPDATE profiles SET page_state = 'not_live' WHERE id = $1`,
    [TOBI.id],
  );
  for (const handle of ['tobi', 'nobody_here'])
    await assert.rejects(reportProfile(db, { handle, reason: 'abusive' }), {
      code: 'PROFILE_NOT_FOUND',
    });
});

test('a recipient’s CSV has the 10% amounts and status, never message text', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const { exportMyTipsCsv } = await import('../../dist/index.js');
  await database.fresh();
  const quote = await createQuote(db, {
    handle: 'ada',
    tipMinor: 250050n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    payerDisplayLabel: '=cmd',
    message: 'my secret note',
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
    amountMinor: 250050n,
    currency: 'NGN',
    providerFeeMinor: 3751n,
    signatureVerified: true,
    payload: {},
  });
  const { csv, rows } = await exportMyTipsCsv(db, ADA.id);
  assert.equal(rows, 1);
  const [header, line, end] = csv.split('\r\n');
  assert.match(header, /^Date \(Lagos\),From,Tip \(NGN\),TipMe fee/);
  const cells = line.split(',');
  assert.equal(cells[1], "'=cmd");
  // ₦2,500.50: TipMe 10% = ₦250.05, nothing recovered from Ada, she receives ₦2,250.45.
  assert.deepEqual(cells.slice(2, 7), [
    '2500.50',
    '250.05',
    '0.00',
    '2250.45',
    'Paid',
  ]);
  assert.equal(cells[7], reference.slice(-6));
  assert.equal(end, '');
  assert.equal(csv.includes('secret'), false);
});
