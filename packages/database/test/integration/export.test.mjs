import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  exportMyTipsCsv,
  exportMyWorkCsv,
  markAttemptInitiated,
  recordProviderEvent,
  writeBusinessNote,
} from '../../dist/index.js';
import { leaveMember, seedBusiness, seedMember } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

test('a recipient’s CSV has the 10% amounts and status, never message text', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
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
  const { csv, rows } = await exportMyTipsCsv(db, ADA);
  assert.equal(rows, 1);
  const [header, line, end] = csv.split('\r\n');
  assert.equal(
    header,
    'Date (Lagos),From,Tip (NGN),"TipMe fee, processing included (NGN)",You received (NGN),Status,Reference ends,At a business,Note tags,Note',
  );
  const cells = line.split(',');
  // A supporter's name can never run as a spreadsheet formula.
  assert.equal(cells[1], "'=cmd");
  // ₦2,500.50: TipMe's 7% on Free = ₦175.04 (processing included), Ada receives ₦2,325.46.
  assert.deepEqual(cells.slice(2, 6), ['2500.50', '175.04', '2325.46', 'Paid']);
  assert.equal(cells[6], reference.slice(-6));
  // Not made at a business: the three business cells are empty.
  assert.deepEqual(cells.slice(7), ['', '', '']);
  assert.equal(end, '');
  assert.equal(csv.includes('secret'), false);
});

/** A tip to Ada booked as paid through the provider event, at a business when `memberId` is set. */
async function paidTipToAda(db, { memberId } = {}) {
  const quote = await createQuote(db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    message: 'private words',
    ...(memberId ? { businessMemberId: memberId } : {}),
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
  return intent.tipId;
}

test('the tips CSV names the business a tip was made at and the note written about the person', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  await database.fresh();
  const { locations } = await seedBusiness(database, {
    owner: (
      await database.pool.query('SELECT user_id FROM profiles WHERE id = $1', [
        TOBI,
      ])
    ).rows[0].user_id,
    name: 'The Yellow Chilli',
    locations: [{ slug: 'vi', name: 'Victoria Island' }],
  });
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: ADA,
    shownName: 'Ada',
  });
  const noted = await paidTipToAda(db, { memberId });
  await writeBusinessNote(db, noted, {
    tags: ['friendly', 'extra_mile'],
    body: 'Fixed our order, fast.',
  });
  const removed = await paidTipToAda(db, { memberId });
  await writeBusinessNote(db, removed, { tags: ['fast'], body: 'held back' });
  await database.pool.query(
    `INSERT INTO business_note_flags (tip_id, reported_at, reported_by, reason, reviewed_at, outcome)
     VALUES ($1, now(), 'member', 'abusive', now(), 'removed')`,
    [removed],
  );
  const { csv, rows } = await exportMyTipsCsv(db, ADA);
  assert.equal(rows, 2);
  const byTip = new Map();
  for (const [tipId, line] of [
    [noted, csv.split('\r\n').find((l) => l.includes('Fixed'))],
    [removed, csv.split('\r\n').find((l) => l.includes('Removed by TipMe'))],
  ])
    byTip.set(tipId, line);
  assert.ok(
    byTip
      .get(noted)
      .endsWith(
        ',The Yellow Chilli · Victoria Island,Friendly; Went the extra mile,"Fixed our order, fast."',
      ),
    byTip.get(noted),
  );
  // A note TipMe removed keeps its place, with its words and tags held back (as on the Work page).
  assert.ok(
    byTip
      .get(removed)
      .endsWith(',The Yellow Chilli · Victoria Island,,Removed by TipMe'),
    byTip.get(removed),
  );
  assert.equal(csv.includes('held back'), false);
  assert.equal(csv.includes('private words'), false);
});

test('the work CSV lists every membership of the person’s page, left ones included', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  await database.fresh();
  const { locations } = await seedBusiness(database, {
    name: 'The Yellow Chilli',
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'ikoyi', name: 'Ikoyi' },
    ],
  });
  const joined = new Date('2026-11-02T09:00:00Z');
  await seedMember(database, {
    locationId: locations[0].id,
    profileId: ADA,
    shownName: 'Ada O.',
    now: joined,
  });
  const { memberId: left } = await seedMember(database, {
    locationId: locations[1].id,
    profileId: ADA,
    shownName: '=Ada',
    now: joined,
  });
  await leaveMember(database, left);
  // Somebody else's membership never appears in Ada's file.
  await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI,
    shownName: 'Tobi',
  });
  const { csv, rows } = await exportMyWorkCsv(db, ADA);
  assert.equal(rows, 2);
  const [header, ...lines] = csv.trimEnd().split('\r\n');
  assert.equal(
    header,
    'Business,Location,Name shown,Photo shown,Amounts shared,Joined (Lagos),Left (Lagos),Left by',
  );
  const vi = lines.find((l) => l.includes('Victoria Island'));
  assert.equal(
    vi,
    'The Yellow Chilli,Victoria Island,Ada O.,Yes,No,2026-11-02,,',
  );
  const ikoyi = lines.find((l) => l.includes('Ikoyi'));
  // A shown name can never run as a spreadsheet formula; a left membership says when and by whom.
  assert.match(
    ikoyi,
    /^The Yellow Chilli,Ikoyi,'=Ada,Yes,No,2026-11-02,\d{4}-\d{2}-\d{2},You$/,
  );
  assert.equal(csv.includes('Tobi'), false);
});
