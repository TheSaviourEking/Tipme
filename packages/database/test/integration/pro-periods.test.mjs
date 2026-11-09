import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  expireDuePeriods,
  mailSealing,
  publicProfile,
  recomputePlan,
  sendProReminders,
  setPagePlan,
  startPaidPeriod,
  OperationError,
} from '../../dist/index.js';
import { proGraceEnd, proPeriodEnd } from '../../../domain/dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

// Paid Pro, plan Task 4 (ADR-0015): monthly periods, 3 days' grace, expiry and reminders.
const sealing = mailSealing(Buffer.alloc(32, 9));
const DAY = 86_400_000;
const START = new Date('2026-11-09T09:00:00.000Z');
const at = (ms) => new Date(START.getTime() + ms);

async function setup(t) {
  const db = await useDatabase(t);
  await db.fresh();
  // Ada can receive email, so her notices are queued.
  await db.pool.query(
    `UPDATE users SET email = 'ada@example.com', email_verified_at = now()
       WHERE id = (SELECT user_id FROM profiles WHERE id = $1)`,
    [ADA],
  );
  return db;
}

const q = (db, text, values = []) =>
  db.pool.query(text, values).then((result) => result.rows);
const planOf = async (db) =>
  (await q(db, `SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan;
const periods = (db) =>
  q(
    db,
    `SELECT id, purchase_id, starts_at, ends_at, grace_ends_at, status, paid_by
       FROM pro_periods WHERE profile_id = $1 ORDER BY starts_at`,
    [ADA],
  );
const mails = (db, type) =>
  q(db, `SELECT dedupe_key FROM mail_messages WHERE type = $1`, [type]);

const pay = (db, now, purchaseId = randomUUID(), paidBy = 'card') =>
  db.db.transaction((tx) =>
    startPaidPeriod(tx, {
      profileId: ADA,
      purchaseId,
      paidBy,
      amountMinor: 250000n,
      currency: 'NGN',
      now,
    }),
  );
const expire = (db, now) => expireDuePeriods(db.db, { now, sealing });

test('a paid period makes the plan pro and ends one Lagos month later', async (t) => {
  const db = await setup(t);
  const period = await pay(db, START);
  assert.equal(period.status, 'ACTIVE');
  assert.equal(period.startsAt.toISOString(), START.toISOString());
  assert.equal(period.endsAt.toISOString(), proPeriodEnd(START).toISOString());
  assert.equal(await planOf(db), 'pro');
  const [row] = await periods(db);
  assert.equal(
    row.grace_ends_at.toISOString(),
    proGraceEnd(row.ends_at).toISOString(),
  );
  assert.equal(row.paid_by, 'card');
});

test('the same payment never starts a second month', async (t) => {
  const db = await setup(t);
  const purchaseId = randomUUID();
  const first = await pay(db, START, purchaseId);
  const again = await pay(db, at(DAY), purchaseId);
  assert.equal(again.periodId, first.periodId);
  assert.equal((await periods(db)).length, 1);
});

test('a second purchase while active is SCHEDULED from the current end; a third is refused', async (t) => {
  const db = await setup(t);
  const first = await pay(db, START);
  const second = await pay(db, at(5 * DAY));
  assert.equal(second.status, 'SCHEDULED');
  assert.equal(second.startsAt.toISOString(), first.endsAt.toISOString());
  await assert.rejects(
    pay(db, at(6 * DAY)),
    (error) =>
      error instanceof OperationError && error.code === 'PRO_ALREADY_RENEWED',
  );
});

test('at ends_at the period is GRACE and the plan stays pro; grace-started is sent once', async (t) => {
  const db = await setup(t);
  const { endsAt } = await pay(db, START);
  for (let i = 0; i < 3; i += 1) await expire(db, endsAt);
  const [row] = await periods(db);
  assert.equal(row.status, 'GRACE');
  assert.equal(await planOf(db), 'pro');
  assert.equal((await mails(db, 'pro_grace_started')).length, 1);
});

test('a payment during grace starts at the old end, with no gap and no overlap', async (t) => {
  const db = await setup(t);
  const { endsAt } = await pay(db, START);
  await expire(db, endsAt);
  const renewed = await pay(db, new Date(endsAt.getTime() + DAY));
  assert.equal(renewed.status, 'ACTIVE');
  assert.equal(renewed.startsAt.toISOString(), endsAt.toISOString());
  const rows = await periods(db);
  assert.deepEqual(
    rows.map((row) => row.status),
    ['ENDED', 'ACTIVE'],
  );
  assert.equal(await planOf(db), 'pro');
});

test('at grace_ends_at the page is Free, every Pro gate falls back, and nothing is deleted', async (t) => {
  const db = await setup(t);
  const links = [
    'https://instagram.com/ada',
    'https://x.com/ada',
    'https://tiktok.com/@ada',
    'https://youtube.com/@ada',
    'https://ada.example.com',
  ];
  await q(
    db,
    `UPDATE profiles SET links = $2::jsonb, tip_presets_minor = '{300000,700000}',
       min_tip_minor = 300000, socials_public = true WHERE id = $1`,
    [
      ADA,
      JSON.stringify([
        { platform: 'instagram', url: links[0] },
        { platform: 'x', url: links[1] },
        { platform: 'tiktok', url: links[2] },
        { platform: 'youtube', url: links[3] },
        { platform: 'website', url: links[4] },
      ]),
    ],
  );
  const { endsAt } = await pay(db, START);
  const onPro = await publicProfile(db.db, 'ada', { recognition: true });
  assert.equal(onPro.plan, 'pro');
  assert.equal(onPro.links.length, 5);
  assert.deepEqual(onPro.tipAmounts.presetsMinor, ['300000', '700000']);
  assert.equal(onPro.recognition, true);

  await expire(db, endsAt);
  const { changed } = await expire(db, proGraceEnd(endsAt));
  assert.deepEqual(
    changed.map((page) => page.profileId),
    [ADA],
  );
  assert.equal(await planOf(db), 'free');
  const onFree = await publicProfile(db.db, 'ada', { recognition: true });
  assert.equal(onFree.plan, 'free');
  assert.equal(onFree.links.length, 3);
  assert.notDeepEqual(onFree.tipAmounts.presetsMinor, ['300000', '700000']);
  assert.equal(onFree.recognition, undefined);
  // The legacy column follows what shows; every stored choice is still there.
  const [stored] = await q(
    db,
    `SELECT links, socials, tip_presets_minor, min_tip_minor FROM profiles WHERE id = $1`,
    [ADA],
  );
  assert.equal(stored.links.length, 5);
  assert.deepEqual(stored.tip_presets_minor, ['300000', '700000']);
  assert.equal(stored.min_tip_minor, '300000');
  assert.equal(Object.keys(stored.socials ?? {}).length <= 3, true);
  assert.equal((await mails(db, 'pro_ended')).length, 1);
  await expire(db, new Date(proGraceEnd(endsAt).getTime() + DAY));
  assert.equal((await mails(db, 'pro_ended')).length, 1);
  assert.equal((await periods(db))[0].status, 'ENDED');
});

test('expiry activates a due SCHEDULED month with no gap and no grace notice', async (t) => {
  const db = await setup(t);
  const first = await pay(db, START);
  await pay(db, at(10 * DAY));
  const { changed } = await expire(db, first.endsAt);
  assert.deepEqual(changed, []);
  assert.deepEqual(
    (await periods(db)).map((row) => row.status),
    ['ENDED', 'ACTIVE'],
  );
  assert.equal(await planOf(db), 'pro');
  assert.equal((await mails(db, 'pro_grace_started')).length, 0);
});

test('a staff grant keeps Pro after a paid month ends; removing it during a paid month keeps Pro until grace ends', async (t) => {
  const db = await setup(t);
  const staffUserId = (
    await q(db, `SELECT user_id FROM profiles WHERE handle = 'tobi'`)
  )[0].user_id;
  await setPagePlan(db.db, {
    staffUserId,
    profileId: ADA,
    plan: 'pro',
    reason: 'A partner page for the pilot',
  });
  const { endsAt } = await pay(db, START);
  await expire(db, proGraceEnd(endsAt));
  assert.equal(await planOf(db), 'pro');
  assert.equal((await mails(db, 'pro_ended')).length, 0);

  const second = await pay(db, at(40 * DAY));
  const removed = await setPagePlan(db.db, {
    staffUserId,
    profileId: ADA,
    plan: 'free',
    reason: 'The pilot ended this week',
  });
  assert.equal(removed.plan, 'pro');
  assert.equal(removed.changed, false);
  assert.equal(await planOf(db), 'pro');
  await expire(db, second.endsAt);
  await expire(db, proGraceEnd(second.endsAt));
  assert.equal(await planOf(db), 'free');
});

test('a staff grant without a paid month still moves the plan, and asking again changes nothing', async (t) => {
  const db = await setup(t);
  const staffUserId = (
    await q(db, `SELECT user_id FROM profiles WHERE handle = 'tobi'`)
  )[0].user_id;
  const input = {
    staffUserId,
    profileId: ADA,
    plan: 'pro',
    reason: 'A partner page for the pilot',
  };
  assert.equal((await setPagePlan(db.db, input)).changed, true);
  assert.equal((await setPagePlan(db.db, input)).changed, false);
  assert.equal(
    (
      await q(
        db,
        `SELECT count(*)::int AS n FROM audit_events WHERE action = 'page.plan_pro'`,
      )
    )[0].n,
    1,
  );
  const off = await setPagePlan(db.db, { ...input, plan: 'free' });
  assert.equal(off.changed, true);
  assert.equal(await planOf(db), 'free');
});

test('confirmation and expiry in parallel leave one ACTIVE month and the plan pro', async (t) => {
  const db = await setup(t);
  const { endsAt } = await pay(db, START);
  await expire(db, endsAt);
  const graceEnd = proGraceEnd(endsAt);
  await Promise.all([pay(db, graceEnd), expire(db, graceEnd)]);
  const rows = await periods(db);
  assert.equal(rows.filter((row) => row.status === 'ACTIVE').length, 1);
  assert.equal(await planOf(db), 'pro');
  // Whichever came first, the next sweep finds the same answer.
  await expire(db, graceEnd);
  assert.equal(await planOf(db), 'pro');
});

test('recomputePlan agrees with the periods at any moment', async (t) => {
  const db = await setup(t);
  const { endsAt } = await pay(db, START);
  const planAt = (now) =>
    db.db.transaction((tx) => recomputePlan(tx, ADA, now));
  assert.equal((await planAt(endsAt)).plan, 'pro');
  assert.equal((await planAt(proGraceEnd(endsAt))).plan, 'free');
  assert.equal((await planAt(START)).plan, 'pro');
});

test('reminders: one 7-day and one 1-day per month, however often the job runs; none when a month is queued', async (t) => {
  const db = await setup(t);
  const { endsAt } = await pay(db, START);
  const before = (days) => new Date(endsAt.getTime() - days * DAY);
  for (let i = 0; i < 3; i += 1)
    await sendProReminders(db.db, { now: before(6.5), sealing });
  for (let i = 0; i < 3; i += 1)
    await sendProReminders(db.db, { now: before(0.5), sealing });
  assert.deepEqual(
    (await mails(db, 'pro_renewal_reminder')).map((m) => m.dedupe_key).sort(),
    [
      `pro_reminder.${(await periods(db))[0].id}.1d`,
      `pro_reminder.${(await periods(db))[0].id}.7d`,
    ],
  );

  const db2 = await setup(t);
  const queued = await pay(db2, START);
  await pay(db2, at(2 * DAY));
  await sendProReminders(db2.db, {
    now: new Date(queued.endsAt.getTime() - 0.5 * DAY),
    sealing,
  });
  assert.equal((await mails(db2, 'pro_renewal_reminder')).length, 0);
});
