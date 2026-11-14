import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY } from './helpers.mjs';

// Staff announcements by email (owner-approved, 14 Nov 2026): a second person approves sending;
// the worker queues the mail in batches, once per person, resumably, and a cancel stops it.
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Telling everyone about the new fees';
const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});

let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  ops.registerRealSeriousActions();
});
after(async () => {
  await database.close();
});

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

beforeEach(async () => {
  await database.reset();
  await ops.ensureOwnerRole(database.db);
});

const people = new Map();
async function staffMember() {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`staff.${randomUUID().slice(0, 8)}@example.com`],
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
  people.set(id, { secret, grantId });
  return id;
}

/**
 * A user who may get announcements unless told otherwise. `marketing` is their marketing switch
 * (opt-in: no row means off), `engagement` the guides and news switch.
 */
async function user({
  verified = true,
  marketing = true,
  engagement = true,
  deleted = false,
  plan = 'free',
  businessOwner = false,
} = {}) {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at, deleted_at)
     VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
    [
      `u.${randomUUID().slice(0, 8)}@example.com`,
      verified ? new Date() : null,
      deleted ? new Date() : null,
    ],
  );
  if (marketing !== null)
    await q(
      `INSERT INTO mail_preferences (user_id, marketing, engagement) VALUES ($1, $2, $3)`,
      [id, marketing, engagement],
    );
  const handle = `a${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await q(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, plan)
     VALUES (gen_random_uuid(), $1, $2, $2, 'Someone', $3)`,
    [id, handle, plan],
  );
  if (businessOwner) {
    const [{ id: businessId }] = await q(
      `INSERT INTO businesses (id, slug, name, contact_name, contact_email, created_by)
       VALUES (gen_random_uuid(), $1, 'Shop', 'Funke', 'funke@example.com', $2) RETURNING id`,
      [`shop${randomUUID().slice(0, 8)}`, id],
    );
    await q(
      `INSERT INTO business_managers (id, business_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'owner')`,
      [businessId, id],
    );
  }
  return id;
}

const draft = (extra = {}) => ({
  subject: 'Lower fees on TipMe',
  preheader: 'TipMe’s fee is going down.',
  text: 'From 1 December, TipMe’s fee on each tip is going down.\n\n- **Free: 7%**\n- **Pro: 5%**',
  buttonLabel: null,
  buttonUrl: null,
  audience: 'everyone',
  ...extra,
});

const create = (staffUserId, extra) =>
  ops.createAnnouncement(database.db, {
    staffUserId,
    draft: draft(extra),
  });

const ask = (actorId, announcement) =>
  ops.askToSendAnnouncement(database.db, {
    actorId,
    grantId: people.get(actorId).grantId,
    id: announcement.id,
    revision: announcement.revision,
    reason: REASON,
    services: services(),
  });

const approve = async (requestId, actorId) => {
  // A code the server will take now, however recently this person used one.
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

const queued = (id) =>
  q(
    `SELECT user_id, type, category, priority FROM mail_messages WHERE dedupe_key LIKE $1 ORDER BY user_id`,
    [`announcement:${id}:%`],
  );

const audits = async (id) =>
  (
    await q(
      `SELECT action FROM audit_events WHERE subject_type = 'announcement' AND subject_id = $1 ORDER BY seq`,
      [id],
    )
  ).map((row) => row.action);

const batch = (limit) =>
  ops.queueAnnouncementBatch(database.db, sealing, {
    now: new Date(),
    limit,
  });

/** Sends one announcement to whoever is set up, approved by a second person. */
async function sending(extra) {
  const asker = await staffMember();
  const approver = await staffMember();
  const announcement = await create(asker, extra);
  const outcome = await ask(asker, announcement);
  assert.equal(outcome.state, 'pending');
  assert.equal((await approve(outcome.requestId, approver)).status, 'approved');
  return { asker, approver, announcement };
}

test('the audience counts confirmed emails whose preferences allow it, and nobody else', async () => {
  const yes = [await user(), await user({ plan: 'pro' })];
  await user({ verified: false });
  await user({ marketing: false });
  // No row: marketing is opt-in, so they never said yes.
  await user({ marketing: null });
  await user({ engagement: false });
  await user({ deleted: true });
  const asker = await staffMember();
  const announcement = await create(asker);
  // Staff hold no preference row either, so they're not in it.
  assert.equal(announcement.audienceCount, yes.length);
  assert.equal(announcement.state, 'draft');
  assert.equal(
    await ops.countAnnouncementAudience(database.db, 'everyone'),
    yes.length,
  );
});

test('Free, Pro and business owners narrow the audience', async () => {
  await user();
  await user({ plan: 'pro' });
  await user({ businessOwner: true });
  await user({ plan: 'pro', marketing: false });
  const count = (audience) =>
    ops.countAnnouncementAudience(database.db, audience);
  assert.equal(await count('everyone'), 3);
  assert.equal(await count('free'), 2);
  assert.equal(await count('pro'), 1);
  assert.equal(await count('business_owners'), 1);
});

test('sending needs a second person: asking queues nothing, approving starts it with a recount', async () => {
  await user();
  await user();
  const asker = await staffMember();
  const approver = await staffMember();
  const announcement = await create(asker);
  assert.equal(announcement.audienceCount, 2);
  const outcome = await ask(asker, announcement);
  assert.equal(outcome.state, 'pending');
  const waiting = await ops.readAnnouncement(database.db, announcement.id);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.waitingRequestId, outcome.requestId);
  assert.equal((await batch(100)).queued, 0);
  assert.equal((await queued(announcement.id)).length, 0);
  // The summary the approver reads names the subject and the count.
  const [{ summary }] = await q(
    `SELECT summary FROM approval_requests WHERE id = $1`,
    [outcome.requestId],
  );
  assert.match(summary, /Lower fees on TipMe/);
  assert.match(summary, /2 people/);

  // One more joins while it waits: the count at send time includes them.
  await user();
  assert.deepEqual(await approve(outcome.requestId, approver), {
    status: 'approved',
    result: { id: announcement.id, recipientCount: 3 },
  });
  const started = await ops.readAnnouncement(database.db, announcement.id);
  assert.equal(started.state, 'sending');
  assert.equal(started.recipientCount, 3);
  assert.equal(started.queuedCount, 0);
});

test('the asker can’t approve their own request', async () => {
  await user();
  const asker = await staffMember();
  await staffMember();
  const announcement = await create(asker);
  const outcome = await ask(asker, announcement);
  await assert.rejects(approve(outcome.requestId, asker));
  assert.equal(
    (await ops.readAnnouncement(database.db, announcement.id)).state,
    'waiting',
  );
});

test('nobody to send to is refused', async () => {
  const asker = await staffMember();
  await staffMember();
  const announcement = await create(asker);
  await assert.rejects(ask(asker, announcement), {
    code: 'ANNOUNCEMENT_NO_RECIPIENTS',
  });
});

test('an edit after asking makes the request stale; a sending announcement can’t be edited', async () => {
  await user();
  const asker = await staffMember();
  const approver = await staffMember();
  const announcement = await create(asker);
  const outcome = await ask(asker, announcement);
  const edited = await ops.editAnnouncement(database.db, {
    staffUserId: asker,
    id: announcement.id,
    edit: { ...draft({ subject: 'Changed' }), revision: announcement.revision },
  });
  assert.equal(edited.revision, announcement.revision + 1);
  assert.equal((await approve(outcome.requestId, approver)).status, 'stale');
  assert.equal(
    (await ops.readAnnouncement(database.db, announcement.id)).state,
    'draft',
  );
  const again = await ask(asker, edited);
  assert.equal((await approve(again.requestId, approver)).status, 'approved');
  await assert.rejects(
    ops.editAnnouncement(database.db, {
      staffUserId: asker,
      id: announcement.id,
      edit: { ...draft(), revision: edited.revision },
    }),
    { code: 'ANNOUNCEMENT_NOT_DRAFT' },
  );
});

test('batches queue each person exactly once, at the lowest priority, and finish', async () => {
  const everyone = [];
  for (let i = 0; i < 5; i += 1) everyone.push(await user());
  const { announcement } = await sending();
  assert.equal((await batch(2)).queued, 2);
  let state = await ops.readAnnouncement(database.db, announcement.id);
  assert.equal(state.queuedCount, 2);
  assert.equal(state.state, 'sending');
  await batch(2);
  await batch(2);
  // Nothing left: the next batch finishes it.
  await batch(2);
  state = await ops.readAnnouncement(database.db, announcement.id);
  assert.equal(state.state, 'sent');
  assert.equal(state.queuedCount, 5);
  assert.ok(state.finishedAt);
  const rows = await queued(announcement.id);
  assert.deepEqual(rows.map((row) => row.user_id).sort(), everyone.sort());
  for (const row of rows) {
    assert.equal(row.type, 'announcement');
    assert.equal(row.category, 'marketing');
  }
  // Below everything else in the queue.
  const [{ highest }] = await q(
    `SELECT max(priority) AS highest FROM mail_messages WHERE dedupe_key NOT LIKE 'announcement:%'`,
  );
  for (const row of rows) assert.ok(row.priority > (highest ?? 3));
  assert.equal((await batch(2)).queued, 0);
});

test('a restart that lost its place, or two workers at once, still mails each person once', async () => {
  const everyone = [];
  for (let i = 0; i < 6; i += 1) everyone.push(await user());
  const { announcement } = await sending();
  await batch(3);
  // As if the worker died and its progress was lost: start again from the beginning.
  await q(
    `UPDATE announcements SET cursor_user_id = NULL, queued_count = 0 WHERE id = $1`,
    [announcement.id],
  );
  await Promise.all([batch(2), batch(2), batch(2)]);
  for (let i = 0; i < 6; i += 1) await batch(2);
  const rows = await queued(announcement.id);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.user_id).sort(), everyone.sort());
  const state = await ops.readAnnouncement(database.db, announcement.id);
  assert.equal(state.state, 'sent');
  assert.equal(state.queuedCount, 6);
});

test('someone who opts out after the send started is skipped', async () => {
  const stays = await user();
  const leaves = await user();
  const { announcement } = await sending();
  await q(`UPDATE mail_preferences SET marketing = false WHERE user_id = $1`, [
    leaves,
  ]);
  for (let i = 0; i < 3; i += 1) await batch(10);
  assert.deepEqual(
    (await queued(announcement.id)).map((row) => row.user_id),
    [stays],
  );
});

test('cancel stops further batches, and every step is audited', async () => {
  for (let i = 0; i < 4; i += 1) await user();
  const { asker, announcement } = await sending();
  await ops.sendAnnouncementTest(database.db, sealing, {
    staffUserId: asker,
    id: announcement.id,
  });
  await batch(1);
  const cancelled = await ops.cancelAnnouncement(database.db, {
    staffUserId: asker,
    id: announcement.id,
    reason: 'Wrong date in the subject line',
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await batch(10)).queued, 0);
  assert.equal((await queued(announcement.id)).length, 1);
  // Cancelling twice changes nothing.
  await ops.cancelAnnouncement(database.db, {
    staffUserId: asker,
    id: announcement.id,
    reason: 'Wrong date in the subject line',
  });
  const steps = await audits(announcement.id);
  for (const step of [
    'announcement.created',
    'announcement.test_sent',
    'announcement.send_started',
    'announcement.cancelled',
  ])
    assert.ok(steps.includes(step), `${step} in ${steps}`);
  assert.equal(steps.filter((s) => s === 'announcement.cancelled').length, 1);
  // The request and the approval are in the log against the approval request.
  const [{ count }] = await q(
    `SELECT count(*)::int AS count FROM audit_events
      WHERE action IN ('serious_action.requested', 'serious_action.ran')
        AND reason LIKE '%announcement.send%'`,
  );
  assert.equal(count, 2);
});

test('a finished send is audited as sent', async () => {
  await user();
  const { announcement } = await sending();
  await batch(10);
  await batch(10);
  assert.ok((await audits(announcement.id)).includes('announcement.sent'));
});

test('a test goes to the staff member alone, now, without touching the audience', async () => {
  await user();
  const asker = await staffMember();
  const announcement = await create(asker, {
    buttonLabel: 'See the fees',
    buttonUrl: '/pro',
  });
  const sent = await ops.sendAnnouncementTest(database.db, sealing, {
    staffUserId: asker,
    id: announcement.id,
  });
  assert.match(sent.toHint, /^s•••@example\.com$/);
  const rows = await q(
    `SELECT user_id, type FROM mail_messages WHERE dedupe_key LIKE $1`,
    [`announcement_test:${announcement.id}:%`],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'announcement');
  // Not tied to an account: their own marketing switch doesn't hold back their own test.
  assert.equal(rows[0].user_id, null);
  assert.equal((await queued(announcement.id)).length, 0);
});

test('marketing mail is skipped at send time for anyone who turned off marketing or news', async () => {
  const off = await user({ engagement: false });
  const on = await user();
  const gate = (userId) =>
    ops.mailGate(
      database.db,
      sealing,
      {
        id: randomUUID(),
        type: 'announcement',
        category: 'marketing',
        userId,
        to: 'x@example.com',
        data: {},
        pinnedProvider: null,
        expiresAt: null,
        attempts: 0,
        claimedAt: new Date(),
      },
      new Date(),
    );
  assert.equal(await gate(off), 'skipped_preference');
  assert.equal(await gate(on), 'send');
});
