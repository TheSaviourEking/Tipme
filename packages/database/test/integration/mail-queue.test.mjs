import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueMail, mailSealing, recordMailEvent } from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// TipMe queues each email in the same transaction as the change that causes it. The address and
// the template data are sealed at rest; only a masked hint is readable.

export const sealing = mailSealing(Buffer.alloc(32, 7));
const tip = {
  firstName: 'Ada',
  netMinor: '450000',
  supporterLabel: 'Tobi',
  pretendPayment: false,
};

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

test('mail exists only when the change that caused it commits', async (t) => {
  const { db, count } = await fresh(t);
  await assert.rejects(
    db.transaction(async (tx) => {
      await enqueueMail(tx, sealing, {
        type: 'tip_received',
        to: 'ada@example.com',
        data: tip,
        dedupeKey: 'tip_received.rollback',
      });
      throw new Error('rolled back');
    }),
  );
  assert.equal(await count('mail_messages'), 0);
});

test('the same dedupe key queues once', async (t) => {
  const { db } = await fresh(t);
  const input = {
    type: 'tip_received',
    to: 'ada@example.com',
    data: tip,
    dedupeKey: 'tip_received.once',
  };
  assert.equal((await enqueueMail(db, sealing, input)).created, true);
  assert.equal((await enqueueMail(db, sealing, input)).created, false);
});

test('addresses and data are sealed at rest', async (t) => {
  const { db, rows } = await fresh(t);
  await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'ada@example.com',
    data: tip,
    dedupeKey: 'tip_received.sealed',
  });
  const [row] = await rows('SELECT to_sealed, data_sealed FROM mail_messages');
  assert.ok(!row.to_sealed.includes('@'));
  assert.ok(!row.data_sealed.includes('Tobi'));
  assert.ok(!row.data_sealed.includes('450000'));
});

test('the hint is masked', async (t) => {
  const { db, rows } = await fresh(t);
  await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: ' Ada@Example.com ',
    data: tip,
    dedupeKey: 'tip_received.hint',
  });
  const [row] = await rows('SELECT to_hint FROM mail_messages');
  assert.equal(row.to_hint, 'a•••@example.com');
});

test('bad data is refused before anything is stored', async (t) => {
  const { db, count } = await fresh(t);
  await assert.rejects(
    enqueueMail(db, sealing, {
      type: 'tip_received',
      to: 'ada@example.com',
      data: {},
      dedupeKey: 'tip_received.bad',
    }),
  );
  await assert.rejects(
    enqueueMail(db, sealing, {
      type: 'tip_received',
      to: 'not an address',
      data: tip,
      dedupeKey: 'tip_received.bad-address',
    }),
  );
  assert.equal(await count('mail_messages'), 0);
});

test('security mail gets the highest priority', async (t) => {
  const { db, rows } = await fresh(t);
  await enqueueMail(db, sealing, {
    type: 'email_verification_link',
    to: 'ada@example.com',
    data: { token: 'sample-token-sample-token-sample-token-0001' },
    dedupeKey: 'email_verification_link.x',
  });
  const [row] = await rows(
    'SELECT priority, category, status FROM mail_messages',
  );
  assert.deepEqual(row, {
    priority: 0,
    category: 'security',
    status: 'queued',
  });
});

test('an event is recorded once and counted in the day’s stats', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'ada@example.com',
    data: tip,
    dedupeKey: 'tip_received.event',
  });
  const event = {
    messageId: id,
    kind: 'delivered',
    provider: 'ses',
    providerEventId: 'sns-1',
    occurredAt: new Date('2026-10-30T10:00:00Z'),
    type: 'tip_received',
    category: 'transactional',
  };
  assert.equal(await recordMailEvent(db, event), true);
  assert.equal(await recordMailEvent(db, event), false);
  const delivered = await rows(
    `SELECT lagos_date::text AS day, count FROM mail_daily_stats WHERE kind = 'delivered'`,
  );
  assert.deepEqual(delivered, [{ day: '2026-10-30', count: 1 }]);
  // Queueing itself is an event too.
  const [queued] = await rows(
    `SELECT count(*)::int AS n FROM mail_message_events WHERE kind = 'queued'`,
  );
  assert.equal(queued.n, 1);
});
