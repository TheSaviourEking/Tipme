import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addressHmac,
  applyMailProviderEvent,
  claimDueMail,
  enqueueMail,
  mailSealing,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Provider events (bounces, complaints, deliveries, opens, clicks) land on the email they belong
// to and keep TipMe from emailing addresses that bounce or complain.

const sealing = mailSealing(Buffer.alloc(32, 7));
const tip = {
  firstName: 'Tobi',
  netMinor: '180000',
  supporterLabel: 'Ada',
  pretendPayment: false,
};

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

async function sentMail(db, dedupe, to = 'tobi@example.com') {
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to,
    data: tip,
    dedupeKey: dedupe,
  });
  await db.execute(
    `UPDATE mail_messages SET status = 'sent', provider = 'ses', provider_message_id = 'ses-${id}' WHERE id = '${id}'`,
  );
  return id;
}

let n = 0;
const event = (kind, extra = {}) => ({
  kind,
  providerEventId: `ev-${++n}`,
  occurredAt: new Date(),
  address: 'tobi@example.com',
  providerMessageId: null,
  reference: null,
  linkKey: null,
  ...extra,
});

const suppression = async (rows, address = 'tobi@example.com') =>
  (
    await rows('SELECT reason FROM mail_suppressions WHERE address_hmac = $1', [
      addressHmac(sealing, address),
    ])
  )[0]?.reason ?? null;

test('a hard bounce suppresses the address and marks the message', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sentMail(db, 'tip.hard');
  assert.equal(
    await applyMailProviderEvent(
      db,
      sealing,
      'ses',
      event('hard_bounce', { reference: id }),
      new Date(),
    ),
    'recorded',
  );
  assert.equal(await suppression(rows), 'hard_bounce');
  const [row] = await rows('SELECT status FROM mail_messages WHERE id = $1', [
    id,
  ]);
  assert.equal(row.status, 'bounced');
});

test('three soft bounces in seven days suppress', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sentMail(db, 'tip.soft');
  for (let i = 0; i < 2; i++)
    await applyMailProviderEvent(
      db,
      sealing,
      'ses',
      event('soft_bounce', { reference: id }),
      new Date(),
    );
  assert.equal(await suppression(rows), null, 'two are not enough');
  await applyMailProviderEvent(
    db,
    sealing,
    'ses',
    event('soft_bounce', { reference: id }),
    new Date(),
  );
  assert.equal(await suppression(rows), 'repeated_soft_bounce');
});

test('soft bounces older than seven days do not count', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sentMail(db, 'tip.soft-old');
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (let i = 0; i < 2; i++)
    await applyMailProviderEvent(
      db,
      sealing,
      'ses',
      event('soft_bounce', { reference: id, occurredAt: old }),
      old,
    );
  await applyMailProviderEvent(
    db,
    sealing,
    'ses',
    event('soft_bounce', { reference: id }),
    new Date(),
  );
  assert.equal(await suppression(rows), null);
});

test('a complaint suppresses', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sentMail(db, 'tip.complaint');
  await applyMailProviderEvent(
    db,
    sealing,
    'zeptomail',
    event('complaint', { reference: id }),
    new Date(),
  );
  assert.equal(await suppression(rows), 'complaint');
  const [row] = await rows('SELECT status FROM mail_messages WHERE id = $1', [
    id,
  ]);
  assert.equal(row.status, 'complained');
});

test('a duplicate event changes nothing', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sentMail(db, 'tip.dup');
  const once = event('opened', { reference: id, providerEventId: 'same' });
  assert.equal(
    await applyMailProviderEvent(db, sealing, 'ses', once, new Date()),
    'recorded',
  );
  assert.equal(
    await applyMailProviderEvent(db, sealing, 'ses', once, new Date()),
    'duplicate',
  );
  const [count] = await rows(
    `SELECT count(*)::int AS n FROM mail_message_events WHERE kind = 'opened'`,
  );
  assert.equal(count.n, 1);
});

test('an event that arrives before the send is recorded still lands on its message', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip.early',
  });
  await claimDueMail(db, sealing, { now: new Date(), limit: 1 });
  await applyMailProviderEvent(
    db,
    sealing,
    'zeptomail',
    event('delivered', { reference: id }),
    new Date(),
  );
  const kinds = await rows(
    'SELECT kind FROM mail_message_events WHERE message_id = $1 ORDER BY kind',
    [id],
  );
  assert.deepEqual(
    kinds.map((k) => k.kind),
    ['delivered', 'queued'],
  );
});

test('events are matched by the provider message id when there is no reference', async (t) => {
  const { db, rows } = await fresh(t);
  const id = await sentMail(db, 'tip.by-provider-id');
  await applyMailProviderEvent(
    db,
    sealing,
    'ses',
    event('clicked', {
      providerMessageId: `ses-${id}`,
      linkKey: 'see_tips',
    }),
    new Date(),
  );
  const [click] = await rows(
    `SELECT link_key FROM mail_message_events WHERE message_id = $1 AND kind = 'clicked'`,
    [id],
  );
  assert.equal(click.link_key, 'see_tips');
  const [stat] = await rows(
    `SELECT count FROM mail_daily_stats WHERE kind = 'clicked' AND type = 'tip_received' AND provider = 'ses'`,
  );
  assert.equal(stat.count, 1);
});

test('an unmatched bounce still suppresses its address', async (t) => {
  const { db, rows } = await fresh(t);
  assert.equal(
    await applyMailProviderEvent(
      db,
      sealing,
      'ses',
      event('hard_bounce', { address: 'ghost@example.com' }),
      new Date(),
    ),
    'unmatched',
  );
  assert.equal(await suppression(rows, 'ghost@example.com'), 'hard_bounce');
});
