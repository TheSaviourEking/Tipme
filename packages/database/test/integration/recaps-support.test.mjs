import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  getMonthlyRecap,
  listIssues,
  listMonthlyRecaps,
  listMySupportRequests,
  mailSealing,
  markAttemptInitiated,
  recordProviderEvent,
  revealPrivate,
  runMonthlyRecaps,
  sendSupportRequest,
} from '../../dist/index.js';
import { queuedMail } from '../../dist/test-support.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;
const sealing = mailSealing(Buffer.alloc(32, 7));
const lagos = (iso) => new Date(`${iso}+01:00`);

async function paid(db, handle, tipMinor, at, { label, message } = {}) {
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
  return BigInt(quote.breakdown.recipientNetMinor);
}

test('monthly recap: Pro pages tipped in the month, once, with an email that names nothing private', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  await database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [
    ADA.id,
  ]);
  await database.pool.query(
    "UPDATE users SET email = 'ada@example.test', email_verified_at = now() WHERE id = (SELECT user_id FROM profiles WHERE id = $1)",
    [ADA.id],
  );
  let net = 0n;
  // Week of Mon 12 Oct: 3 tips (best); week of 5 Oct: 1; Sat 31 Oct belongs to the week of 26 Oct.
  net += await paid(db, 'ada', 300000n, lagos('2026-10-06T10:00:00'), {
    label: 'Chidi',
    message: 'Thank you!',
  });
  for (const day of ['12', '14', '16'])
    net += await paid(db, 'ada', 200000n, lagos(`2026-10-${day}T10:00:00`));
  net += await paid(db, 'ada', 200000n, lagos('2026-10-31T23:30:00'));
  // Tobi is Free: no recap.
  await paid(db, 'tobi', 200000n, lagos('2026-10-14T10:00:00'));

  const first = await runMonthlyRecaps(db, { sealing, month: '2026-10' });
  const again = await runMonthlyRecaps(db, { sealing, month: '2026-10' });
  assert.equal(first.created, 1);
  assert.equal(again.created, 0);

  const recap = await getMonthlyRecap(db, ADA.id, '2026-10');
  assert.deepEqual(recap, {
    month: '2026-10',
    tipCount: 5,
    totalNetMinor: net.toString(),
    averageMinor: ((net * 2n + 5n) / 10n).toString(),
    previousNetMinor: '0',
    bestWeek: { from: '2026-10-12', to: '2026-10-18', tips: 3 },
    bestDay: null,
    notes: 1,
  });
  // No name, label or message anywhere in what is kept.
  assert.doesNotMatch(JSON.stringify(recap), /Chidi|Thank you/);
  assert.equal(await getMonthlyRecap(db, TOBI.id, '2026-10'), null);
  assert.deepEqual(
    (await listMonthlyRecaps(db, ADA.id)).map((r) => [r.month, r.tipCount]),
    [['2026-10', 5]],
  );

  const mail = (await queuedMail(db, sealing, { limit: 10 })).filter(
    (m) => m.type === 'monthly_recap',
  );
  assert.equal(mail.length, 1);
  assert.deepEqual(mail[0].data, { month: '2026-10', tipCount: 5 });

  // Opted out of reports: the recap is still made, but no email.
  await database.pool.query(
    'UPDATE profiles SET notify_weekly_reports = false WHERE id = $1',
    [ADA.id],
  );
  await paid(db, 'ada', 200000n, lagos('2026-09-14T10:00:00'));
  assert.equal(
    (await runMonthlyRecaps(db, { sealing, month: '2026-09' })).created,
    1,
  );
  const after = (await queuedMail(db, sealing, { limit: 10 })).filter(
    (m) => m.type === 'monthly_recap',
  );
  assert.equal(after.length, 1);
});

test('priority support: a Pro request is flagged and sorted first in the open queue', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const userOf = async (id) =>
    (
      await database.pool.query('SELECT user_id FROM profiles WHERE id = $1', [
        id,
      ])
    ).rows[0].user_id;
  const tobiUser = await userOf(TOBI.id);
  const adaUser = await userOf(ADA.id);
  await database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [
    ADA.id,
  ]);

  // Tobi (Free) writes first, then Ada (Pro).
  const free = await sendSupportRequest(db, {
    userId: tobiUser,
    topic: 'tip',
    body: 'A tip did not show up',
    now: new Date('2026-11-08T10:00:00Z'),
  });
  const pro = await sendSupportRequest(db, {
    userId: adaUser,
    topic: 'withdrawal',
    body: 'My withdrawal is late.\nCan you look?',
    now: new Date('2026-11-08T11:00:00Z'),
  });
  assert.equal(free.priority, false);
  assert.equal(pro.priority, true);

  const open = await listIssues(db, { status: 'open', limit: 50 });
  const support = open.filter((i) => i.kind === 'support_request');
  assert.deepEqual(
    support.map((i) => [i.subject.profileId, i.priority]),
    [
      [ADA.id, true],
      [TOBI.id, false],
    ],
  );
  // Pro first in the whole open queue, ahead of newer non-priority issues too.
  assert.equal(open[0].id, support[0].id);
  // Keyset paging keeps the order: page 1 = the Pro request, page 2 the rest.
  const page1 = await listIssues(db, { status: 'open', limit: 1 });
  const page2 = await listIssues(db, {
    status: 'open',
    limit: 50,
    cursor: page1[0].id,
  });
  assert.equal(page1[0].id, support[0].id);
  assert.ok(page2.some((i) => i.id === support[1].id));
  assert.ok(!page2.some((i) => i.id === support[0].id));

  // The summary carries no words of the request; reveal shows them.
  assert.doesNotMatch(support[0].summary, /withdrawal is late/);
  const revealed = await revealPrivate(db, support[0].id);
  assert.equal(revealed.message, 'My withdrawal is late.\nCan you look?');

  // At most 3 waiting.
  for (let i = 0; i < 2; i++)
    await sendSupportRequest(db, {
      userId: adaUser,
      topic: 'other',
      body: `More ${i}`,
    });
  await assert.rejects(
    sendSupportRequest(db, { userId: adaUser, topic: 'other', body: 'Fourth' }),
    { code: 'SUPPORT_TOO_MANY_OPEN' },
  );
  const mine = await listMySupportRequests(db, adaUser);
  assert.equal(mine.length, 3);
  assert.deepEqual(Object.keys(mine[0]).sort(), [
    'createdAt',
    'id',
    'priority',
    'status',
    'topic',
  ]);
});
