import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  enqueueMail,
  listMail,
  mailDailySeries,
  mailPeriodSummary,
  mailSealing,
  mailTimeline,
  openMailSnapshot,
  rebuildMailDailyStats,
  recordMailEvent,
  revealMailRecipient,
  sealSecret,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Staff audit every email from inside TipMe: by Lagos day, week and month, with the period before
// alongside, without going to the provider.

const sealing = mailSealing(Buffer.alloc(32, 7));
const STAFF = '00000000-0000-7000-8000-000000007b11';
const NOW = new Date('2026-10-15T12:00:00Z');
const tip = {
  firstName: 'Tobi',
  netMinor: '180000',
  supporterLabel: 'Ada',
  pretendPayment: false,
};
const verify = { token: 'sample-token-sample-token-sample-token-0001' };
let n = 0;

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

async function sent(
  db,
  at,
  { type = 'tip_received', data = tip, provider = 'ses' } = {},
) {
  const category = type === 'tip_received' ? 'transactional' : 'security';
  const { id } = await enqueueMail(db, sealing, {
    type,
    to: `p${++n}@example.com`,
    data,
    dedupeKey: `${type}.${n}`,
    now: at,
  });
  await recordMailEvent(db, {
    messageId: id,
    kind: 'sent',
    provider,
    occurredAt: at,
    type,
    category,
  });
  return id;
}

const event = (db, id, kind, at, extra = {}) =>
  recordMailEvent(db, {
    messageId: id,
    kind,
    provider: 'ses',
    providerEventId: `e${++n}`,
    occurredAt: at,
    type: 'tip_received',
    category: 'transactional',
    ...extra,
  });

test('months are split in Lagos time, and a month so far is compared like for like', async (t) => {
  const { db } = await fresh(t);
  // 23:30 in Lagos on 30 September is still last month, though close to the boundary.
  await sent(db, new Date('2026-09-30T22:30:00Z'));
  // 00:30 in Lagos on 1 October is this month, though still 30 September in UTC.
  await sent(db, new Date('2026-09-30T23:30:00Z'));
  await sent(db, new Date('2026-09-10T10:00:00Z'));
  await sent(db, new Date('2026-10-14T10:00:00Z'));
  const summary = await mailPeriodSummary(db, { kind: 'this_month' }, NOW);
  assert.deepEqual(summary.range, { from: '2026-10-01', to: '2026-10-15' });
  // The first 15 days of last month, not all 30.
  assert.deepEqual(summary.previous, { from: '2026-09-01', to: '2026-09-15' });
  assert.deepEqual(summary.totals.sent, {
    count: 2,
    previous: 1,
    changePct: 100,
  });
  const last = await mailPeriodSummary(db, { kind: 'last_month' }, NOW);
  assert.equal(last.totals.sent.count, 2, 'the 23:30 one counts in September');
});

test('a month so far never reaches past the end of a shorter month', async (t) => {
  const { db } = await fresh(t);
  const { previous } = await mailPeriodSummary(
    db,
    { kind: 'this_month' },
    new Date('2026-03-31T12:00:00Z'),
  );
  assert.deepEqual(previous, { from: '2026-02-01', to: '2026-02-28' });
});

test('rates never pass 100%, even when deliveries of earlier mail land in this period', async (t) => {
  const { db } = await fresh(t);
  const at = new Date('2026-10-14T10:00:00Z');
  const a = await sent(db, at);
  for (let i = 0; i < 5; i++) await event(db, a, 'delivered', at);
  const { rates } = await mailPeriodSummary(db, { kind: 'this_month' }, NOW);
  assert.equal(rates.delivery, 1);
});

test('the summary lists every type seen, by category, and how long the queue has waited', async (t) => {
  const { db } = await fresh(t);
  const at = new Date('2026-10-14T10:00:00Z');
  await sent(db, at);
  await recordMailEvent(db, {
    messageId: null,
    kind: 'send_failed',
    provider: 'ses',
    occurredAt: at,
    type: 'weekly_report',
    category: 'engagement',
  });
  await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'waiting@example.com',
    data: tip,
    dedupeKey: 'tip.waiting',
    now: new Date(NOW.getTime() - 90_000),
  });
  const summary = await mailPeriodSummary(db, { kind: 'this_month' }, NOW);
  assert.deepEqual([...summary.types].sort(), [
    'tip_received',
    'weekly_report',
  ]);
  assert.deepEqual(summary.byCategory, [
    { category: 'transactional', sent: 1, previous: 0 },
  ]);
  assert.ok(summary.queueAgeSeconds >= 90);
});

test('a range longer than a year, or a malformed cursor, is refused', async (t) => {
  const { db } = await fresh(t);
  await assert.rejects(
    mailPeriodSummary(
      db,
      { kind: 'range', from: '2020-01-01', to: '2026-01-01' },
      NOW,
    ),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    listMail(db, { period: { kind: 'today' }, limit: 5, cursor: 'x|y' }, NOW),
    { code: 'INVALID_INPUT' },
  );
});

test('the list shows the account’s handle and the provider’s message id', async (t) => {
  const { db, rows } = await fresh(t);
  const [tobi] = await rows(
    `SELECT user_id FROM profiles WHERE handle_lower = 'tobi'`,
  );
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    userId: tobi.user_id,
    data: tip,
    dedupeKey: 'tip.handle',
    now: new Date('2026-10-14T10:00:00Z'),
  });
  await db.execute(
    `UPDATE mail_messages SET provider_message_id = 'ses-9' WHERE id = '${id}'`,
  );
  const { rows: list } = await listMail(
    db,
    { period: { kind: 'this_month' }, limit: 5 },
    NOW,
  );
  assert.equal(list[0].handle, 'tobi');
  assert.equal(list[0].providerMessageId, 'ses-9');
});

test('a zero previous period gives no percentage', async (t) => {
  const { db } = await fresh(t);
  await sent(db, new Date('2026-10-14T10:00:00Z'));
  const { totals } = await mailPeriodSummary(db, { kind: 'this_month' }, NOW);
  assert.deepEqual(totals.sent, { count: 1, previous: 0, changePct: null });
});

test('rates count people, not repeat opens', async (t) => {
  const { db } = await fresh(t);
  const at = new Date('2026-10-14T10:00:00Z');
  const a = await sent(db, at);
  await sent(db, at);
  await event(db, a, 'delivered', at);
  await event(db, a, 'opened', at);
  await event(db, a, 'opened', at);
  const { totals, rates, byType, byProvider } = await mailPeriodSummary(
    db,
    { kind: 'this_month' },
    NOW,
  );
  assert.equal(totals.opened.count, 1);
  assert.deepEqual(rates, { delivery: 0.5, open: 0.5, click: 0 });
  assert.deepEqual(byType, [{ type: 'tip_received', sent: 2, previous: 0 }]);
  assert.deepEqual(byProvider, [{ provider: 'ses', sent: 2, previous: 0 }]);
});

test('every kind of period has the right range and the one before it', async (t) => {
  const { db } = await fresh(t);
  const range = async (period) => {
    const s = await mailPeriodSummary(db, period, NOW);
    return [s.range.from, s.range.to, s.previous.from, s.previous.to];
  };
  // 15 October 2026 is a Thursday.
  assert.deepEqual(await range({ kind: 'today' }), [
    '2026-10-15',
    '2026-10-15',
    '2026-10-14',
    '2026-10-14',
  ]);
  assert.deepEqual(await range({ kind: 'yesterday' }), [
    '2026-10-14',
    '2026-10-14',
    '2026-10-13',
    '2026-10-13',
  ]);
  assert.deepEqual(await range({ kind: 'this_week' }), [
    '2026-10-12',
    '2026-10-15',
    '2026-10-05',
    '2026-10-08',
  ]);
  assert.deepEqual(await range({ kind: 'last_week' }), [
    '2026-10-05',
    '2026-10-11',
    '2026-09-28',
    '2026-10-04',
  ]);
  assert.deepEqual(await range({ kind: 'last_month' }), [
    '2026-09-01',
    '2026-09-30',
    '2026-08-01',
    '2026-08-31',
  ]);
  assert.deepEqual(
    await range({ kind: 'range', from: '2026-10-01', to: '2026-10-03' }),
    ['2026-10-01', '2026-10-03', '2026-09-28', '2026-09-30'],
  );
});

test('the series has every day, with the previous period alongside', async (t) => {
  const { db } = await fresh(t);
  await sent(db, new Date('2026-10-13T10:00:00Z'));
  await sent(db, new Date('2026-10-06T10:00:00Z'));
  const series = await mailDailySeries(db, { kind: 'this_week' }, NOW);
  assert.deepEqual(
    series.map((d) => [d.date, d.sent, d.previousSent]),
    [
      ['2026-10-12', 0, 0],
      ['2026-10-13', 1, 1],
      ['2026-10-14', 0, 0],
      ['2026-10-15', 0, 0],
    ],
  );
  const today = await mailDailySeries(db, { kind: 'today' }, NOW);
  assert.equal(today.length, 24);
});

test('totals equal a recount from events', async (t) => {
  const { db, rows } = await fresh(t);
  const at = new Date('2026-10-14T10:00:00Z');
  const a = await sent(db, at);
  await event(db, a, 'delivered', at);
  await event(db, a, 'hard_bounce', at);
  const read = () =>
    rows(
      `SELECT lagos_date::text AS d, type, provider, kind, count FROM mail_daily_stats ORDER BY 1, 2, 3, 4`,
    );
  const before = await read();
  await db.execute(`UPDATE mail_daily_stats SET count = 999`);
  await rebuildMailDailyStats(db, '2026-10-14', '2026-10-14');
  assert.deepEqual(await read(), before);
});

test('the list pages through every message in the period', async (t) => {
  const { db } = await fresh(t);
  const at = new Date('2026-10-14T10:00:00Z');
  const ids = [];
  for (let i = 0; i < 120; i++) ids.push(await sent(db, at));
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await listMail(
      db,
      {
        period: { kind: 'this_month' },
        limit: 50,
        ...(cursor ? { cursor } : {}),
      },
      NOW,
    );
    seen.push(...page.rows.map((r) => r.id));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 120);
  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test('the list filters, and shows a masked recipient and the last event', async (t) => {
  const { db } = await fresh(t);
  const at = new Date('2026-10-14T10:00:00Z');
  const a = await sent(db, at);
  await sent(db, at, {
    type: 'email_verification_link',
    data: verify,
    provider: 'zeptomail',
  });
  await event(db, a, 'opened', new Date(at.getTime() + 1000));
  const { rows } = await listMail(
    db,
    { period: { kind: 'this_month' }, type: 'tip_received', limit: 10 },
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastEvent, 'opened');
  assert.match(rows[0].toHint, /^p•••@example\.com$/);
  assert.ok(!JSON.stringify(rows).includes('p' + (n - 1) + '@'));
});

test('a message’s timeline is in order and never carries a link', async (t) => {
  const { db } = await fresh(t);
  const at = new Date('2026-10-14T10:00:00Z');
  const a = await sent(db, at);
  await event(db, a, 'clicked', new Date(at.getTime() + 5000), {
    linkKey: 'see_tips',
  });
  const timeline = await mailTimeline(db, a);
  assert.deepEqual(
    timeline.map((e) => [e.kind, e.linkKey]),
    [
      ['queued', null],
      ['sent', null],
      ['clicked', 'see_tips'],
    ],
  );
});

test('a security email’s content is withheld', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sent(db, new Date(), {
    type: 'email_verification_link',
    data: verify,
  });
  assert.deepEqual(
    await openMailSnapshot(db, sealing, { messageId: id, staffUserId: STAFF }),
    { status: 'withheld' },
  );
  assert.equal(
    (await rows(`SELECT 1 FROM audit_events WHERE action = 'email.viewed'`))
      .length,
    1,
  );
});

test('opening a snapshot shows the sent email and is audited', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sent(db, new Date());
  await db.execute(
    `UPDATE mail_messages SET rendered_sealed = '${sealSecret(sealing.key, JSON.stringify({ subject: 'S', html: '<p>H</p>', text: 'T' }))}' WHERE id = '${id}'`,
  );
  assert.deepEqual(
    await openMailSnapshot(db, sealing, { messageId: id, staffUserId: STAFF }),
    { status: 'ok', subject: 'S', html: '<p>H</p>', text: 'T' },
  );
  const [audit] = await rows(
    `SELECT subject_id, staff_user_id FROM audit_events WHERE action = 'email.viewed'`,
  );
  assert.deepEqual(audit, { subject_id: id, staff_user_id: STAFF });
  assert.deepEqual(
    await openMailSnapshot(db, sealing, {
      messageId: '00000000-0000-7000-8000-000000000000',
      staffUserId: STAFF,
    }),
    { status: 'not_found' },
  );
});

test('revealing a recipient is audited with the reason, and fails once wiped', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sent(db, new Date());
  const reveal = () =>
    revealMailRecipient(db, sealing, {
      messageId: id,
      staffUserId: STAFF,
      reason: 'support asked about this email',
    });
  assert.match((await reveal()).address, /^p\d+@example\.com$/);
  const [audit] = await rows(
    `SELECT reason FROM audit_events WHERE action = 'email.recipient_revealed'`,
  );
  assert.equal(audit.reason, 'support asked about this email');
  await db.execute(
    `UPDATE mail_messages SET to_sealed = NULL WHERE id = '${id}'`,
  );
  assert.deepEqual(await reveal(), { address: null });
});
