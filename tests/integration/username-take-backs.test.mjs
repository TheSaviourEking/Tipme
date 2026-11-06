import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import * as contracts from '../../packages/contracts/dist/index.js';
import {
  lagosDateWords,
  newTotpSecret,
  takeBackDueAt,
  totpAt,
} from '../../packages/domain/dist/index.js';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY } from './helpers.mjs';

/*
 * Taking a username back from a page (docs/superpowers/specs/2026-11-03-username-reservation-design.md,
 * sections 5.3 to 5.10 and the owner's answers in section 12). Through the operations, as the
 * serious-action suites do: the routes have their own test in ops-serious-routes. Every test makes
 * its own page, so they share one database.
 */

const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'The brand asked us in writing on 2 November';
const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});

let database;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  ops.registerRealSeriousActions();
});
after(async () => {
  await database.close();
});

const people = new Map();
let seq = 0;
beforeEach(async () => {
  // Each test decides who else is on staff.
  await q(`UPDATE staff SET revoked_at = now() WHERE revoked_at IS NULL`);
  await q(
    `UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`,
  );
});

async function person() {
  seq += 1;
  const email = `tb${seq}.${randomUUID().slice(0, 6)}@example.com`;
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [email],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [id],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [id, ops.sealSecret(key, secret)],
  );
  const [{ id: sessionId }] = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [id, randomBytes(32).toString('hex')],
  );
  const [{ id: grantId }] = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now()) RETURNING id`,
    [id, sessionId, randomBytes(32).toString('hex')],
  );
  people.set(id, { secret, grantId, email });
  return id;
}

/** A live page of its own, owned by a fresh account. */
async function page({ verified = true, plan = 'free' } = {}) {
  const handle = `tb_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const [{ id: userId }] = await q(
    `INSERT INTO users (id, email, email_verified_at)
     VALUES (gen_random_uuid(), $1, CASE WHEN $2 THEN now() END) RETURNING id`,
    [`${handle}@example.com`, verified],
  );
  const [{ id }] = await q(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, plan, page_state)
     VALUES (gen_random_uuid(), $1, $2, $2, 'Page', $3, 'live') RETURNING id`,
    [userId, handle, plan],
  );
  return { id, userId, handle };
}

/** A fresh page with one settled tip, so it has a balance. */
async function paidPage() {
  const target = await page();
  const { quoteId } = await ops.createQuote(database.db, {
    handle: target.handle,
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  await ops.recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: `ref-${intent.attemptId}`,
    amountMinor: 200000n,
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: { kind: 'test' },
  });
  return target;
}

const ask = (actorId, input) =>
  ops.requestTakeBack(database.db, {
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
    category: 'ordinary',
    noticeDays: 7,
    ...input,
  });
const approve = async (requestId, actorId) => {
  await q(`UPDATE staff_totp SET last_step = NULL WHERE user_id = $1`, [
    actorId,
  ]);
  return ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: totpAt(
      people.get(actorId).secret,
      BigInt(Math.floor(Date.now() / 30_000)),
    ),
    key,
    services: services(),
  });
};
const takeBackOf = async (name) =>
  (
    await q(
      `SELECT * FROM handle_take_backs WHERE handle_lower = $1 ORDER BY approved_at DESC LIMIT 1`,
      [name],
    )
  )[0];
const mailOf = (type, takeBackId) =>
  q(`SELECT * FROM mail_messages WHERE dedupe_key = $1`, [
    `${type}.${takeBackId}`,
  ]);
const auditOf = (action, name) =>
  q(
    `SELECT * FROM audit_events WHERE action = $1 AND subject_id = $2 ORDER BY seq`,
    [action, name],
  );
/** Starts a take-back alone (nobody else on staff), as the lone-admin path does. */
async function started(input = {}, pageInput = {}) {
  const requester = await person();
  await q(
    `UPDATE staff SET revoked_at = now() WHERE revoked_at IS NULL AND user_id <> $1`,
    [requester],
  );
  const target = await page(pageInput);
  const outcome = await ask(requester, {
    profileId: target.id,
    name: target.handle,
    ...input,
  });
  assert.equal(outcome.state, 'ran', JSON.stringify(outcome));
  return { requester, target, row: await takeBackOf(target.handle) };
}
const refused = (code) => (error) => {
  assert.equal(error.code, code, error.message);
  return true;
};

test('approval creates the row in approved, queues the notice once, and audits started', async () => {
  const requester = await person();
  const second = await person();
  const target = await page();
  const pending = await ask(requester, {
    profileId: target.id,
    name: target.handle.toUpperCase(),
  });
  assert.equal(pending.state, 'pending');
  assert.equal(await takeBackOf(target.handle), undefined, 'nothing yet');
  const before = Date.now();
  assert.equal((await approve(pending.requestId, second)).status, 'approved');
  const row = await takeBackOf(target.handle);
  assert.equal(row.state, 'approved');
  assert.equal(row.kind, 'current');
  assert.equal(row.category, 'ordinary');
  assert.equal(row.notice_days, 7);
  assert.equal(row.requested_by, requester);
  assert.equal(row.approved_by, second);
  assert.equal(row.approval_request_id, pending.requestId);
  assert.equal(row.reason, REASON);
  assert.equal(row.noticed_at, null);
  assert.equal(row.due_at, null);
  const notices = await mailOf('username_take_back_notice', row.id);
  assert.equal(notices.length, 1);
  assert.equal(row.notice_mail_id, notices[0].id);
  // The notice says the earliest the deadline can be, and only the category's fixed words.
  const queued = (await queuedMail(database.db, sealing, { limit: 500 })).find(
    (m) => m.id === row.notice_mail_id,
  );
  assert.deepEqual(queued.data, {
    kind: 'current',
    old: target.handle,
    current: target.handle,
    why: contracts.TAKE_BACK_WHY.ordinary,
    dueDate: lagosDateWords(takeBackDueAt(new Date(before), 7)),
  });
  assert.ok(!JSON.stringify(queued.data).includes(REASON));
  const [audit] = await auditOf('username.take_back_started', target.handle);
  assert.equal(audit.staff_user_id, requester);
  assert.equal(audit.permission, 'usernames.manage');
  assert.equal(audit.subject_type, 'username');
  assert.ok(audit.reason.startsWith(REASON));
  for (const fact of [second, requester, 'ordinary', target.id])
    assert.ok(audit.reason.includes(fact), fact);
});

test('a queued email that never sends leaves the row approved', async () => {
  const { row } = await started();
  const [mail] = await q(
    `SELECT status, sent_at FROM mail_messages WHERE id = $1`,
    [row.notice_mail_id],
  );
  assert.equal(mail.status, 'queued');
  const again = await takeBackOf(row.handle_lower);
  assert.equal(again.state, 'approved');
  assert.equal(again.noticed_at, null);
  assert.equal(again.due_at, null);
});

test('no verified address: no email, notice_mail_id null, row approved', async () => {
  const { row } = await started({}, { verified: false });
  assert.equal(row.state, 'approved');
  assert.equal(row.notice_mail_id, null);
  assert.equal((await mailOf('username_take_back_notice', row.id)).length, 0);
});

test('a rename while waiting makes approval stale; the requester asks again', async () => {
  const requester = await person();
  const second = await person();
  const target = await page({ plan: 'pro' });
  const pending = await ask(requester, {
    profileId: target.id,
    name: target.handle,
  });
  await ops.renameHandle(database.db, {
    userId: target.userId,
    handle: `${target.handle}_x`,
  });
  const outcome = await approve(pending.requestId, second);
  assert.equal(outcome.status, 'stale');
  assert.equal(await takeBackOf(target.handle), undefined);
  // The name is now an old one of the page: asking again asks for that.
  const again = await ask(requester, {
    profileId: target.id,
    name: target.handle,
  });
  assert.equal(again.state, 'pending');
  assert.equal((await approve(again.requestId, second)).status, 'approved');
  assert.equal((await takeBackOf(target.handle)).kind, 'old');
});

test('a second take-back of the same name is refused', async () => {
  const { requester, target } = await started();
  await assert.rejects(
    ask(requester, { profileId: target.id, name: target.handle }),
    refused('TAKE_BACK_OPEN'),
  );
});

test('ordinary notice must be 7 to 30 days; others 1 to 7; 0 is refused until the no-notice path', async () => {
  const requester = await person();
  const target = await page();
  const tryWith = (category, noticeDays) =>
    ask(requester, {
      profileId: target.id,
      name: target.handle,
      category,
      noticeDays,
    });
  for (const [category, days] of [
    ['ordinary', 6],
    ['ordinary', 31],
    ['ordinary', 0],
    ['trademark', 8],
    ['trademark', 0],
    ['legal', 0],
    ['impersonation', 0],
  ])
    await assert.rejects(
      tryWith(category, days),
      refused('INVALID_INPUT'),
      `${category} ${days}`,
    );
  assert.equal((await tryWith('trademark', 1)).state, 'ran');
});

test('a release-check page and a built-in name are refused', async () => {
  const requester = await person();
  const target = await page();
  await assert.rejects(
    ask(requester, { profileId: target.id, name: 'dashboard' }),
    refused('USERNAME_BUILT_IN'),
  );
  const [{ id: runId }] = await q(
    `INSERT INTO release_runs (id) VALUES (gen_random_uuid()) RETURNING id`,
  );
  await q(`UPDATE profiles SET rehearsal_run_id = $1 WHERE id = $2`, [
    runId,
    target.id,
  ]);
  await assert.rejects(
    ask(requester, { profileId: target.id, name: target.handle }),
    refused('INVALID_INPUT'),
  );
  // A name the page doesn't hold, or a page that doesn't exist.
  const other = await page();
  await assert.rejects(
    ask(requester, { profileId: other.id, name: target.handle }),
    refused('USERNAME_HELD_BY_PAGE'),
  );
  await assert.rejects(
    ask(requester, { profileId: randomUUID(), name: other.handle }),
    refused('NO_PAGE'),
  );
});

test('cancel before notice sends nothing; cancel after notice sends the cancelled email; done cannot be cancelled', async () => {
  const cancel = (staffId, takeBackId) =>
    ops.cancelTakeBack(database.db, {
      staffId,
      takeBackId,
      reason: 'The brand withdrew its request',
      sealing,
    });
  const first = await started();
  const view = await cancel(first.requester, first.row.id);
  assert.equal(view.state, 'cancelled');
  assert.equal(
    (await mailOf('username_take_back_cancelled', first.row.id)).length,
    0,
  );
  // The notice that was still queued never goes out.
  const [notice] = await q(
    `SELECT expires_at FROM mail_messages WHERE id = $1`,
    [first.row.notice_mail_id],
  );
  assert.ok(notice.expires_at);
  const [cancelled] = await auditOf(
    'username.take_back_cancelled',
    first.target.handle,
  );
  assert.equal(cancelled.staff_user_id, first.requester);
  await assert.rejects(
    cancel(first.requester, first.row.id),
    refused('TAKE_BACK_CLOSED'),
  );

  const second = await started();
  await q(
    `UPDATE mail_messages SET status = 'sent', sent_at = now() WHERE id = $1`,
    [second.row.notice_mail_id],
  );
  await cancel(second.requester, second.row.id);
  const sent = await mailOf('username_take_back_cancelled', second.row.id);
  assert.equal(sent.length, 1);

  const third = await started();
  await q(`UPDATE handle_take_backs SET state = 'done' WHERE id = $1`, [
    third.row.id,
  ]);
  await assert.rejects(
    cancel(third.requester, third.row.id),
    refused('TAKE_BACK_CLOSED'),
  );
  await assert.rejects(
    cancel(third.requester, randomUUID()),
    refused('TAKE_BACK_NOT_FOUND'),
  );
});

test('check shows facts as flags only: no amounts, no address', async () => {
  const target = await page();
  const check = await ops.checkUsername(database.db, target.handle);
  assert.equal(check.state, 'page');
  assert.deepEqual(check.facts, {
    plan: 'free',
    pageState: 'live',
    suspended: false,
    hasBalance: false,
    withdrawalInFlight: false,
    verifiedEmail: true,
    // The API fills this from its settings; the database can't know it.
    liveCheckoutListed: false,
  });
  assert.equal(check.openTakeBack, null);
  assert.equal(check.pendingRequestId, null);
  assert.ok(!JSON.stringify(check).includes('@example.com'));
  const paid = await paidPage();
  const withMoney = await ops.checkUsername(database.db, paid.handle);
  assert.equal(withMoney.facts.hasBalance, true);
  assert.equal(withMoney.facts.withdrawalInFlight, false);
  assert.ok(!/Minor|amount|2000/i.test(JSON.stringify(withMoney.facts)));

  const requester = await person();
  await person();
  const pending = await ask(requester, {
    profileId: target.id,
    name: target.handle,
  });
  const waiting = await ops.checkUsername(database.db, target.handle);
  assert.equal(waiting.pendingRequestId, pending.requestId);
  const list = await ops.listUsernames(database.db, {});
  assert.ok(
    list.pending.some(
      (p) => p.requestId === pending.requestId && p.name === target.handle,
    ),
  );
});

test('the take-back money stays put', async () => {
  const money = async (profileId) =>
    JSON.stringify(
      {
        balance: await ops.balanceIn(database.db, profileId),
        tips: await q(
          `SELECT id, status FROM tips WHERE profile_id = $1 ORDER BY id`,
          [profileId],
        ),
        payouts: await q(
          `SELECT id, status FROM payouts WHERE profile_id = $1 ORDER BY id`,
          [profileId],
        ),
        page: await q(
          `SELECT plan, handle_changes_used, custom_fee_bps FROM profiles WHERE id = $1`,
          [profileId],
        ),
      },
      (_key, value) => (typeof value === 'bigint' ? `${value}` : value),
    );
  const target = await paidPage();
  const before = await money(target.id);
  assert.ok(JSON.parse(before).tips.length > 0);
  const requester = await person();
  assert.equal(
    (await ask(requester, { profileId: target.id, name: target.handle })).state,
    'ran',
  );
  const row = await takeBackOf(target.handle);
  assert.equal(await money(target.id), before);
  await database.db.transaction(async (tx) => {
    await ops.completeTakeBack(tx, {
      takeBackId: row.id,
      outcome: 'user_chose',
      chosenHandle: `${target.handle}_n`,
      sealing,
      now: new Date(),
      actorUserId: target.userId,
    });
  });
  assert.equal((await takeBackOf(target.handle)).state, 'done');
  assert.equal(await money(target.id), before);
});

test('every fixed why in the contracts is one the emails accept', async () => {
  const { MAIL_TYPES } = await import('../../packages/mail/dist/index.js');
  const notice = MAIL_TYPES.username_take_back_notice;
  for (const why of Object.values(contracts.TAKE_BACK_WHY))
    assert.ok(notice.schema.safeParse({ ...notice.sample, why }).success, why);
});

/* Task 8: the dashboard banner and the seen-time */

const HOUR = 3_600_000;
const seen = (target, row, now) =>
  ops.markTakeBackSeen(database.db, {
    userId: target.userId,
    takeBackId: row.id,
    ...(now ? { now } : {}),
  });

test('MyProfile carries the take-back while it is open, with the fixed why only', async () => {
  const { target, row } = await started({
    category: 'trademark',
    noticeDays: 3,
  });
  const before = Date.now();
  const mine = await ops.getMyProfile(database.db, target.userId);
  assert.equal(mine.usernameTakeBack.id, row.id);
  assert.equal(mine.usernameTakeBack.handle, target.handle);
  assert.equal(mine.usernameTakeBack.kind, 'current');
  assert.equal(mine.usernameTakeBack.current, target.handle);
  assert.equal(mine.usernameTakeBack.why, contracts.TAKE_BACK_WHY.trademark);
  // Not noticed yet: the deadline that seeing it now would set.
  assert.equal(
    mine.usernameTakeBack.dueAt,
    takeBackDueAt(new Date(before), 3).toISOString(),
  );
  assert.deepEqual(Object.keys(mine.usernameTakeBack).sort(), [
    'current',
    'dueAt',
    'handle',
    'id',
    'kind',
    'why',
  ]);
  const text = JSON.stringify(mine);
  assert.ok(!text.includes(REASON), 'no internal reason');
  assert.ok(!text.includes(people.get(row.requested_by).email));
  await q(`UPDATE handle_take_backs SET state = 'cancelled' WHERE id = $1`, [
    row.id,
  ]);
  assert.equal(
    (await ops.getMyProfile(database.db, target.userId)).usernameTakeBack,
    null,
  );
});

test('seen is recorded once, and only the first time starts the clock', async () => {
  const { target, row } = await started();
  const t0 = new Date(Date.now() + 1000);
  const first = await seen(target, row, t0);
  assert.equal(first.dueAt, takeBackDueAt(t0, 7).toISOString());
  const after1 = await takeBackOf(target.handle);
  assert.equal(after1.state, 'noticed');
  assert.equal(after1.noticed_via, 'banner');
  assert.equal(after1.noticed_at.toISOString(), t0.toISOString());
  assert.equal(after1.banner_seen_at.toISOString(), t0.toISOString());
  assert.equal(after1.due_at.toISOString(), takeBackDueAt(t0, 7).toISOString());
  await seen(target, row, new Date(t0.getTime() + HOUR));
  const after2 = await takeBackOf(target.handle);
  assert.deepEqual(after2, after1);
  const noticed = await auditOf('username.take_back_noticed', target.handle);
  assert.equal(noticed.length, 1);
  assert.equal(noticed[0].staff_user_id, target.userId);
  assert.match(noticed[0].reason, /"via":"banner"/);
});

test('a sent email first, then the banner: the clock stays at the email', async () => {
  const { target, row } = await started();
  const sentAt = new Date(Date.now() - HOUR);
  // What the sweep records once the notice is sent (Task 10).
  await q(
    `UPDATE handle_take_backs SET state = 'noticed', noticed_at = $2, noticed_via = 'email', due_at = $3 WHERE id = $1`,
    [row.id, sentAt, takeBackDueAt(sentAt, 7)],
  );
  const view = await seen(target, row);
  assert.equal(view.dueAt, takeBackDueAt(sentAt, 7).toISOString());
  const after = await takeBackOf(target.handle);
  assert.equal(after.noticed_via, 'email');
  assert.equal(after.noticed_at.toISOString(), sentAt.toISOString());
  assert.ok(after.banner_seen_at);
});

test('adding an email after the banner was seen changes nothing', async () => {
  const { target, row } = await started({}, { verified: false });
  await seen(target, row);
  const before = await takeBackOf(target.handle);
  await q(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [
    target.userId,
  ]);
  await seen(target, row, new Date(Date.now() + HOUR));
  assert.deepEqual(await takeBackOf(target.handle), before);
  assert.equal((await mailOf('username_take_back_notice', row.id)).length, 0);
});

test("someone else's take-back id answers not found", async () => {
  const { row } = await started();
  const other = await page();
  await assert.rejects(seen(other, row), refused('TAKE_BACK_NOT_FOUND'));
  await assert.rejects(
    ops.markTakeBackSeen(database.db, {
      userId: other.userId,
      takeBackId: 'not-a-uuid',
    }),
    refused('TAKE_BACK_NOT_FOUND'),
  );
  assert.equal((await takeBackOf(row.handle_lower)).banner_seen_at, null);
});

/* Task 9: the user chooses a new name during the notice */

test('the taken name is now an active take_back reservation', async () => {
  const { target, row } = await started();
  await ops.renameHandle(database.db, {
    userId: target.userId,
    handle: `${target.handle}_n`,
    sealing,
  });
  const [reservation] = await q(
    `SELECT * FROM handle_reservations WHERE handle_lower = $1 AND released_at IS NULL`,
    [target.handle],
  );
  assert.equal(reservation.source, 'take_back');
  assert.equal(reservation.take_back_id, row.id);
  assert.equal(reservation.reserved_by, null);
  assert.equal(reservation.reason, 'Taken back');
  const check = await ops.checkUsername(database.db, target.handle);
  assert.equal(check.state, 'reserved');
  assert.equal(check.reservation.source, 'take_back');
});

test('choosing completes early: done email once, banner gone, audited', async () => {
  const { target, row } = await started();
  const chosen = `${target.handle}_c`;
  const result = await ops.renameHandle(database.db, {
    userId: target.userId,
    handle: chosen,
    sealing,
  });
  assert.equal(result.takeBack, true);
  assert.equal(result.previous, target.handle);
  assert.equal(result.handle, chosen);
  const done = await mailOf('username_take_back_done', row.id);
  assert.equal(done.length, 1);
  const queued = (await queuedMail(database.db, sealing, { limit: 500 })).find(
    (m) => m.id === done[0].id,
  );
  assert.equal(queued.data.variant, 'user_chose');
  assert.equal(queued.data.new, chosen);
  assert.equal(
    (await ops.getMyProfile(database.db, target.userId)).usernameTakeBack,
    null,
  );
  const [audit] = await auditOf('username.take_back_done', target.handle);
  assert.equal(audit.staff_user_id, target.userId);
  assert.match(audit.reason, /"outcome":"user_chose"/);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'username.take_back_done' AND aggregate_id = $1`,
        [row.id],
      )
    ).length,
    1,
  );
});

test('deleting the page during the notice reserves the name as page_deleted, with no done email', async () => {
  const { target, row } = await started();
  await ops.deleteAccount(database.db, { userId: target.userId, sealing });
  const after = await takeBackOf(target.handle);
  assert.equal(after.state, 'done');
  assert.equal(after.outcome, 'page_deleted');
  assert.equal((await mailOf('username_take_back_done', row.id)).length, 0);
  const [reservation] = await q(
    `SELECT source FROM handle_reservations WHERE handle_lower = $1 AND released_at IS NULL`,
    [target.handle],
  );
  assert.equal(reservation.source, 'take_back');
  // The deletion hold stays as well.
  assert.equal(
    (
      await q(`SELECT 1 FROM handle_holds WHERE handle_lower = $1`, [
        target.handle,
      ])
    ).length,
    1,
  );
});

/* Task 10: the worker sweep, the deadline and the 14-day never-reached path (injected clock) */

const DAY = 86_400_000;
const sweep = (now) => ops.sweepTakeBacks(database.db, { sealing, now });
const markSent = (mailId, sentAt) =>
  q(`UPDATE mail_messages SET status = 'sent', sent_at = $2 WHERE id = $1`, [
    mailId,
    sentAt,
  ]);
const doneMailData = async (takeBackId) => {
  const [row] = await mailOf('username_take_back_done', takeBackId);
  if (!row) return null;
  return (await queuedMail(database.db, sealing, { limit: 500 })).find(
    (m) => m.id === row.id,
  ).data;
};

test('the full path: approved, noticed only after sent_at, reminder at due minus 2 days, due, done', async () => {
  const { target, row } = await started();
  const t0 = new Date(row.approved_at);
  // Queued, not sent: nothing moves, however late it is.
  await sweep(new Date(t0.getTime() + DAY));
  assert.equal((await takeBackOf(target.handle)).state, 'approved');
  const sentAt = new Date(t0.getTime() + 60_000);
  await markSent(row.notice_mail_id, sentAt);
  const first = await sweep(new Date(t0.getTime() + 120_000));
  assert.ok(first.noticed >= 1);
  const noticed = await takeBackOf(target.handle);
  assert.equal(noticed.state, 'noticed');
  assert.equal(noticed.noticed_via, 'email');
  assert.equal(noticed.noticed_at.toISOString(), sentAt.toISOString());
  const due = takeBackDueAt(sentAt, 7);
  assert.equal(noticed.due_at.toISOString(), due.toISOString());
  const [audit] = await auditOf('username.take_back_noticed', target.handle);
  assert.equal(audit.staff_user_id, null);
  // Just before due minus 2 days: no reminder yet; at it: one, and only one.
  await sweep(new Date(due.getTime() - 2 * DAY - 1000));
  assert.equal((await mailOf('username_take_back_reminder', row.id)).length, 0);
  const reminded = await sweep(new Date(due.getTime() - 2 * DAY + 1000));
  assert.ok(reminded.reminded >= 1);
  await sweep(new Date(due.getTime() - DAY));
  assert.equal((await mailOf('username_take_back_reminder', row.id)).length, 1);
  // The deadline: a new username, the done email, the reservation.
  const atDue = new Date(due.getTime() + 1000);
  const done = await sweep(atDue);
  assert.ok(done.completed >= 1);
  const after = await takeBackOf(target.handle);
  assert.equal(after.state, 'done');
  assert.equal(after.outcome, 'assigned');
  assert.match(after.new_handle, /^page_[a-z0-9]{6}$/);
  assert.ok(done.revalidate.includes(target.handle));
  assert.ok(done.revalidate.includes(after.new_handle));
  const [page] = await q(`SELECT handle FROM profiles WHERE id = $1`, [
    target.id,
  ]);
  assert.equal(page.handle, after.new_handle);
  assert.equal(after.free_change_until.getTime(), atDue.getTime() + 30 * DAY);
  const data = await doneMailData(row.id);
  assert.equal(data.variant, 'assigned');
  assert.equal(data.new, after.new_handle);
  assert.equal(data.noticeDate, lagosDateWords(sentAt));
  // Running again changes nothing for this one.
  const settled = await takeBackOf(target.handle);
  const again = await sweep(new Date(atDue.getTime() + 60_000));
  assert.ok(!again.revalidate.includes(target.handle));
  assert.deepEqual(await takeBackOf(target.handle), settled);
  assert.equal((await mailOf('username_take_back_done', row.id)).length, 1);
});

test('no reminder when notice_days is below 4', async () => {
  const { target, row } = await started({
    category: 'impersonation',
    noticeDays: 3,
  });
  const sentAt = new Date(new Date(row.approved_at).getTime() + 1000);
  await markSent(row.notice_mail_id, sentAt);
  await sweep(new Date(sentAt.getTime() + 1000));
  const due = (await takeBackOf(target.handle)).due_at;
  await sweep(new Date(due.getTime() - DAY));
  assert.equal((await mailOf('username_take_back_reminder', row.id)).length, 0);
});

test('worker catch-up after a missed deadline completes at the next run, recording the actual time', async () => {
  const { target, row } = await started();
  const sentAt = new Date(new Date(row.approved_at).getTime() + 1000);
  await markSent(row.notice_mail_id, sentAt);
  await sweep(new Date(sentAt.getTime() + 1000));
  const due = (await takeBackOf(target.handle)).due_at;
  // The worker was down for three days past the deadline.
  const late = new Date(due.getTime() + 3 * DAY);
  await sweep(late);
  const after = await takeBackOf(target.handle);
  assert.equal(after.state, 'done');
  assert.equal(after.done_at.toISOString(), late.toISOString());
  // The reminder that was due during the outage is not sent after the deadline.
  assert.equal((await mailOf('username_take_back_reminder', row.id)).length, 0);
});

/** A take-back past its deadline, ready for the sweep. */
async function pastDue() {
  const setup = await started();
  await q(
    `UPDATE handle_take_backs SET state = 'noticed', noticed_at = now() - interval '8 days', noticed_via = 'banner', due_at = now() - interval '1 minute' WHERE id = $1`,
    [setup.row.id],
  );
  return setup;
}

test('cancel racing the deadline sweep: one outcome', async () => {
  for (let round = 0; round < 3; round++) {
    const { requester, target, row } = await pastDue();
    const [swept, cancelled] = await Promise.allSettled([
      sweep(new Date()),
      ops.cancelTakeBack(database.db, {
        staffId: requester,
        takeBackId: row.id,
        reason: 'The brand withdrew its request',
        sealing,
      }),
    ]);
    assert.equal(swept.status, 'fulfilled', String(swept.reason));
    const after = await takeBackOf(target.handle);
    assert.ok(['done', 'cancelled'].includes(after.state));
    if (after.state === 'done') {
      assert.equal(cancelled.status, 'rejected');
      assert.equal(cancelled.reason.code, 'TAKE_BACK_CLOSED');
      assert.equal((await mailOf('username_take_back_done', row.id)).length, 1);
      assert.equal(
        (await mailOf('username_take_back_cancelled', row.id)).length,
        0,
      );
    } else {
      assert.equal(cancelled.status, 'fulfilled');
      assert.equal((await mailOf('username_take_back_done', row.id)).length, 0);
      const [page] = await q(`SELECT handle FROM profiles WHERE id = $1`, [
        target.id,
      ]);
      assert.equal(page.handle, target.handle, 'the page kept its name');
    }
  }
});

test('user choice racing the sweep: one outcome', async () => {
  for (let round = 0; round < 3; round++) {
    const { target, row } = await pastDue();
    const chosen = `${target.handle}_u`;
    const [, chose] = await Promise.allSettled([
      sweep(new Date()),
      ops.renameHandle(database.db, {
        userId: target.userId,
        handle: chosen,
        sealing,
      }),
    ]);
    const after = await takeBackOf(target.handle);
    assert.equal(after.state, 'done');
    assert.equal((await mailOf('username_take_back_done', row.id)).length, 1);
    const [page] = await q(`SELECT handle FROM profiles WHERE id = $1`, [
      target.id,
    ]);
    if (after.outcome === 'user_chose') {
      assert.equal(chose.status, 'fulfilled');
      assert.equal(page.handle, chosen);
    } else {
      assert.equal(after.outcome, 'assigned');
      assert.equal(page.handle, after.new_handle);
      // Their change then ran as an ordinary one on a Free page, and was refused.
      assert.equal(chose.status, 'rejected');
    }
    // Never an alias for the taken name.
    assert.equal(
      (
        await q(`SELECT 1 FROM handle_aliases WHERE handle_lower = $1`, [
          target.handle,
        ])
      ).length,
      0,
    );
  }
});

test('never reached for 14 days: completed as unreached and recorded', async () => {
  // No address at all: nothing is sent, before or after.
  const quiet = await started({}, { verified: false });
  const at = new Date(
    new Date(quiet.row.approved_at).getTime() + 14 * DAY + 1000,
  );
  const result = await sweep(at);
  assert.ok(result.unreached >= 1);
  const after = await takeBackOf(quiet.target.handle);
  assert.equal(after.state, 'done');
  assert.equal(after.outcome, 'assigned');
  assert.equal(after.noticed_via, 'unreached');
  assert.equal(after.noticed_at, null);
  assert.equal(
    (await mailOf('username_take_back_done', quiet.row.id)).length,
    0,
  );
  // An address added since: the done email goes, in the unreached words.
  const later = await started({}, { verified: false });
  await q(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [
    later.target.userId,
  ]);
  await sweep(
    new Date(new Date(later.row.approved_at).getTime() + 14 * DAY + 1000),
  );
  const data = await doneMailData(later.row.id);
  assert.equal(data.variant, 'unreached');
  assert.equal(data.why, contracts.TAKE_BACK_WHY.ordinary);
});

test('approved for 13 days 23 hours without notice: nothing happens yet', async () => {
  const { target, row } = await started({}, { verified: false });
  await sweep(
    new Date(new Date(row.approved_at).getTime() + 14 * DAY - 3_600_000),
  );
  assert.equal((await takeBackOf(target.handle)).state, 'approved');
});

test('the generated username retries on collision and is never built-in or reserved', async () => {
  const taken = await page();
  await q(
    `INSERT INTO handle_reservations (id, handle_lower, source, reason, reserved_at)
     VALUES (gen_random_uuid(), 'page_rsrvd0', 'staff', 'test name', now())`,
  );
  const tries = [
    'bad',
    'RSRVD0',
    'rsrvd0',
    taken.handle.slice(5, 11),
    'free01',
  ];
  // The page's own handle is tb_xxxxxxxxxx, so page_ plus its 6 characters isn't it: make one.
  await q(
    `INSERT INTO profiles (id, handle, handle_lower, display_name) VALUES (gen_random_uuid(), 'page_takenx', 'page_takenx', 'Page')`,
  );
  tries[3] = 'takenx';
  const seen = [];
  const handle = await database.db.transaction((tx) =>
    ops.generatedHandle(tx, () => {
      const next = tries.shift();
      seen.push(next);
      return next;
    }),
  );
  assert.equal(handle, 'page_free01');
  assert.deepEqual(seen, ['bad', 'RSRVD0', 'rsrvd0', 'takenx', 'free01']);
  // Ten collisions in a row: it gives up, and the take-back stays due.
  await assert.rejects(
    database.db.transaction((tx) => ops.generatedHandle(tx, () => 'takenx')),
    refused('HANDLE_TAKEN'),
  );
  for (let i = 0; i < 200; i++)
    assert.match(
      await database.db.transaction((tx) => ops.generatedHandle(tx)),
      /^page_[a-z0-9]{6}$/,
    );
});

test('an old-username take-back removes the alias at the deadline, and the page keeps its username', async () => {
  const requester = await person();
  await q(
    `UPDATE staff SET revoked_at = now() WHERE revoked_at IS NULL AND user_id <> $1`,
    [requester],
  );
  const target = await page({ plan: 'pro' });
  const now = `${target.handle}_now`;
  await ops.renameHandle(database.db, {
    userId: target.userId,
    handle: now,
    sealing,
  });
  assert.equal(
    (await ask(requester, { profileId: target.id, name: target.handle })).state,
    'ran',
  );
  const row = await takeBackOf(target.handle);
  assert.equal(row.kind, 'old');
  await q(
    `UPDATE handle_take_backs SET state = 'noticed', noticed_at = now(), noticed_via = 'email', due_at = now() - interval '1 second' WHERE id = $1`,
    [row.id],
  );
  const result = await sweep(new Date());
  assert.ok(result.revalidate.includes(target.handle));
  const after = await takeBackOf(target.handle);
  assert.equal(after.state, 'done');
  assert.equal(after.outcome, 'old_removed');
  assert.equal(after.new_handle, null);
  assert.equal(after.free_change_until, null);
  const [pageRow] = await q(`SELECT handle FROM profiles WHERE id = $1`, [
    target.id,
  ]);
  assert.equal(pageRow.handle, now);
  assert.equal(
    (
      await q(`SELECT 1 FROM handle_aliases WHERE handle_lower = $1`, [
        target.handle,
      ])
    ).length,
    0,
  );
  const data = await doneMailData(row.id);
  assert.equal(data.variant, 'old');
  assert.equal(data.current, now);
});

test('the unnoticed issue opens at 24 hours and closes once noticed', async () => {
  const { target, row } = await started();
  const issue = () =>
    q(`SELECT status, kind, severity FROM issues WHERE dedupe_key = $1`, [
      `username_take_back_unnoticed.${row.id}`,
    ]);
  const approved = new Date(row.approved_at);
  await ops.runIssueDetectors(
    database.db,
    new Date(approved.getTime() + 23 * 3_600_000),
  );
  assert.equal((await issue()).length, 0);
  await ops.runIssueDetectors(
    database.db,
    new Date(approved.getTime() + 24 * 3_600_000 + 1000),
  );
  const [opened] = await issue();
  assert.equal(opened.status, 'open');
  assert.equal(opened.severity, 'account');
  await seen(target, row);
  await ops.autoResolveIssues(database.db, new Date());
  assert.equal((await issue())[0].status, 'resolved');
});

test('the overdue issue opens an hour after due and closes once done', async () => {
  const { row } = await pastDue();
  const issue = () =>
    q(`SELECT status FROM issues WHERE dedupe_key = $1`, [
      `username_take_back_overdue.${row.id}`,
    ]);
  await ops.runIssueDetectors(database.db, new Date());
  assert.equal((await issue()).length, 0, 'not within the hour');
  await ops.runIssueDetectors(
    database.db,
    new Date(Date.now() + 2 * 3_600_000),
  );
  assert.equal((await issue())[0].status, 'open');
  await sweep(new Date());
  await ops.autoResolveIssues(database.db, new Date());
  assert.equal((await issue())[0].status, 'resolved');
});

test('a suspended page still gets the banner, and stays suspended under its new name', async () => {
  const { target, row } = await started();
  await q(`UPDATE profiles SET status = 'suspended' WHERE id = $1`, [
    target.id,
  ]);
  const mine = await ops.getMyProfile(database.db, target.userId);
  assert.equal(mine.usernameTakeBack.id, row.id);
  await q(
    `UPDATE handle_take_backs SET state = 'noticed', noticed_at = now(), noticed_via = 'banner', due_at = now() - interval '1 second' WHERE id = $1`,
    [row.id],
  );
  await sweep(new Date());
  const [page] = await q(`SELECT handle, status FROM profiles WHERE id = $1`, [
    target.id,
  ]);
  assert.match(page.handle, /^page_/);
  assert.equal(page.status, 'suspended');
});

test('the staff alert names the action in words; no email comes of the event', async () => {
  const { handleDomainEvent } =
    await import('../../apps/worker/dist/handlers/domain-events.js');
  const posted = [];
  const before = (await q(`SELECT count(*)::int AS n FROM mail_messages`))[0].n;
  await handleDomainEvent(
    'username.take_back_done',
    {
      takeBackId: randomUUID(),
      action: 'username.take_back',
      requestedBy: 'staff-id',
    },
    {
      db: database.db,
      logger: { info() {}, warn() {}, error() {} },
      dedupeKey: `username.take_back_done.${randomUUID()}`,
      sealing,
      pretendPayment: true,
      postStaffAlert: async (alert) => posted.push(alert),
    },
  );
  assert.deepEqual(posted, [
    {
      event: 'username.take_back_done',
      action: 'Take a username back from a page',
      requestedBy: 'staff-id',
    },
  ]);
  assert.equal(
    (await q(`SELECT count(*)::int AS n FROM mail_messages`))[0].n,
    before,
  );
});

/* Task 13: the audit list */

test('every take-back step leaves its audit entry, and the Overview lists started, done and released', async () => {
  // One that is reserved, released, started, noticed and done, then whose name is released.
  const reserver = await person();
  const reservedName = `rsv_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  await ops.reserveUsername(database.db, {
    staffId: reserver,
    name: reservedName,
    reason: REASON,
  });
  await ops.releaseUsername(database.db, {
    staffId: reserver,
    name: reservedName,
    reason: 'No longer needed by the brand',
  });
  const { requester, target, row } = await started();
  await seen(target, row);
  await ops.renameHandle(database.db, {
    userId: target.userId,
    handle: `${target.handle}_a`,
    sealing,
  });
  await ops.releaseUsername(database.db, {
    staffId: requester,
    name: target.handle,
    reason: 'The brand released its claim',
  });
  // One that is cancelled.
  const other = await started();
  await ops.cancelTakeBack(database.db, {
    staffId: other.requester,
    takeBackId: other.row.id,
    reason: 'The brand withdrew its request',
    sealing,
  });
  // A free change after an assigned username.
  const assigned = await started();
  await q(
    `UPDATE handle_take_backs SET state = 'noticed', noticed_at = now(), noticed_via = 'banner', due_at = now() - interval '1 second' WHERE id = $1`,
    [assigned.row.id],
  );
  await ops.sweepTakeBacks(database.db, { sealing, now: new Date() });
  await ops.renameHandle(database.db, {
    userId: assigned.target.userId,
    handle: `${assigned.target.handle}_f`,
    sealing,
  });

  const actions = async (subjectId) =>
    (
      await q(
        `SELECT action, subject_type FROM audit_events WHERE subject_id = $1 ORDER BY seq`,
        [subjectId],
      )
    ).map((r) => `${r.subject_type}:${r.action}`);
  assert.deepEqual(await actions(reservedName), [
    'username:username.reserved',
    'username:username.released',
  ]);
  assert.deepEqual(await actions(target.handle), [
    'username:username.take_back_started',
    'username:username.take_back_noticed',
    'username:username.take_back_done',
    'username:username.released',
  ]);
  const [released] = await q(
    `SELECT reason FROM audit_events WHERE action = 'username.released' AND subject_id = $1`,
    [target.handle],
  );
  assert.ok(released.reason.includes(row.id), 'names the take-back');
  assert.deepEqual(await actions(other.target.handle), [
    'username:username.take_back_started',
    'username:username.take_back_cancelled',
  ]);
  assert.deepEqual(await actions(assigned.target.id), [
    'profile:username.free_change_used',
  ]);
  const feed = await ops.staffActivity(database.db, { limit: 200 });
  const listed = new Set(feed.map((a) => a.action));
  for (const action of [
    'username.take_back_started',
    'username.take_back_done',
    'username.released',
  ])
    assert.ok(listed.has(action), action);
  assert.ok(!JSON.stringify(feed).includes(REASON), 'no reasons in the feed');
});
