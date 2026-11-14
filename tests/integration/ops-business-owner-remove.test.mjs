import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import { queuedMail } from '../../packages/database/dist/test-support.js';
import {
  seedBusiness,
  seedManager,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY } from './helpers.mjs';

// Owner-change lock (owner, 14 Nov 2026): only TipMe removes a business owner, as a two-person
// serious action, never leaving a business with no owner, and every owner is emailed.

const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Both owners confirmed by email on ticket 4411';
const [ADA, TOBI] = ops.DEMO_PROFILES;

let database;
const people = new Map();
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
beforeEach(async () => {
  for (const table of [
    'ops_sessions',
    'staff_totp',
    'staff',
    'approval_requests',
    'outbox_events',
    'mail_message_events',
    'mail_messages',
  ])
    await q(`DELETE FROM ${table}`);
});

async function person() {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`verify.${randomUUID().slice(0, 8)}@example.com`],
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

const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});
const ask = (actorId, businessId, managerId) =>
  ops.requestSeriousAction(database.db, {
    name: 'business.owner_remove',
    payload: { businessId, managerId },
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
  });
const approve = (requestId, actorId) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: totpAt(
      people.get(actorId).secret,
      BigInt(Math.floor(Date.now() / 30_000)),
    ),
    key,
    services: services(),
  });

async function twoOwners() {
  await q(
    `UPDATE users SET email = 'ada@example.com', email_verified_at = now() WHERE id = $1`,
    [ADA.userId],
  );
  await q(
    `UPDATE users SET email = 'tobi@example.com', email_verified_at = now() WHERE id = $1`,
    [TOBI.userId],
  );
  const business = await seedBusiness(database, { name: 'The Yellow Chilli' });
  const [founder] = await q(
    `SELECT id FROM business_managers WHERE business_id = $1 AND user_id = $2`,
    [business.businessId, ADA.userId],
  );
  const second = await seedManager(database, {
    businessId: business.businessId,
    userId: TOBI.userId,
  });
  return { ...business, founderSeat: founder.id, secondSeat: second.managerId };
}
const openOwners = async (businessId) =>
  (
    await q(
      `SELECT user_id FROM business_managers
        WHERE business_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY user_id`,
      [businessId],
    )
  ).map((row) => row.user_id);
const ownerMail = async () =>
  (await queuedMail(database.db, sealing, { limit: 50 }))
    .filter((mail) => mail.type === 'business_owner_change')
    .map(({ userId, data }) => ({ userId, ...data }))
    .sort((a, b) => a.userId.localeCompare(b.userId));

test('removing an owner waits for a second person; once approved the seat ends, it is audited and every owner is emailed', async () => {
  const requester = await person();
  const approver = await person();
  const { businessId, secondSeat } = await twoOwners();
  const outcome = await ask(requester, businessId, secondSeat);
  assert.equal(outcome.state, 'pending');
  // Nothing happens while it waits.
  assert.deepEqual(
    await openOwners(businessId),
    [ADA.userId, TOBI.userId].sort(),
  );
  assert.deepEqual(await ownerMail(), []);
  const [request] = await q(
    `SELECT summary FROM approval_requests WHERE id = $1`,
    [outcome.requestId],
  );
  assert.equal(
    request.summary,
    'Remove Tobi Adeyemi as an owner of The Yellow Chilli. 1 owner stays.',
  );

  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  assert.deepEqual(await openOwners(businessId), [ADA.userId]);
  const audits = await q(
    `SELECT staff_user_id, permission, subject_type, subject_id, reason FROM audit_events
      WHERE action = 'business.owner_removed'`,
  );
  assert.deepEqual(audits, [
    {
      staff_user_id: requester,
      permission: 'businesses.manage',
      subject_type: 'business',
      subject_id: businessId,
      reason: REASON,
    },
  ]);
  // Every owner, the removed one included.
  const removed = {
    change: 'removed_by_tipme',
    businessName: 'The Yellow Chilli',
    ownerName: 'Tobi Adeyemi',
  };
  assert.deepEqual(
    await ownerMail(),
    [
      { userId: ADA.userId, ...removed, you: 'other' },
      { userId: TOBI.userId, ...removed, you: 'owner' },
    ].sort((a, b) => a.userId.localeCompare(b.userId)),
  );
});

test('the founding owner can be removed through TipMe, but never the last owner', async () => {
  const requester = await person();
  await person();
  const { businessId, founderSeat, secondSeat } = await twoOwners();
  // Tobi steps down first, so Ada (the founder) is the only owner left.
  await ops.removeManager(
    database.db,
    sealing,
    TOBI.userId,
    businessId,
    secondSeat,
  );
  await assert.rejects(ask(requester, businessId, founderSeat), {
    code: 'BUSINESS_LAST_OWNER',
  });
  assert.deepEqual(await openOwners(businessId), [ADA.userId]);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM approval_requests WHERE payload->>'businessId' = $1`,
        [businessId],
      )
    ).length,
    0,
  );

  // With a second owner again, the founder's seat can be removed by TipMe.
  await seedManager(database, { businessId, userId: TOBI.userId });
  const outcome = await ask(requester, businessId, founderSeat);
  assert.equal(outcome.state, 'pending');
});

test('a location manager is not an owner: asking is refused (dry run)', async () => {
  const requester = await person();
  await person();
  const { businessId, locations } = await twoOwners();
  const [{ id: userId }] = await q(
    `INSERT INTO users (id) VALUES (gen_random_uuid()) RETURNING id`,
  );
  const manager = await seedManager(database, {
    businessId,
    userId,
    locationId: locations[0].id,
  });
  await assert.rejects(ask(requester, businessId, manager.managerId), {
    code: 'INVALID_INPUT',
  });
});

test('an owner stepping down after asking makes the approval stale', async () => {
  const requester = await person();
  const approver = await person();
  const { businessId, secondSeat } = await twoOwners();
  const outcome = await ask(requester, businessId, secondSeat);
  assert.equal(outcome.state, 'pending');
  await q(`UPDATE business_managers SET removed_at = now() WHERE id = $1`, [
    secondSeat,
  ]);
  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'stale', JSON.stringify(approved));
});

test('someone who runs the business cannot ask to remove one of its owners', async () => {
  const requester = await person();
  await person();
  const { businessId, secondSeat } = await twoOwners();
  await q(
    `INSERT INTO business_managers (id, business_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [businessId, requester],
  );
  await assert.rejects(ask(requester, businessId, secondSeat), {
    code: 'APPROVAL_SUBJECT',
  });
});
