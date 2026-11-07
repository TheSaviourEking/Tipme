import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import { seedBusiness } from '../../packages/database/test/integration/business-fixtures.mjs';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY } from './helpers.mjs';

// TipMe for businesses, PR B2 Task 9: verifying a business is a two-person serious action.

const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Checked the name, address and contact today';
const [ADA] = ops.DEMO_PROFILES;

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
const ask = (actorId, businessId) =>
  ops.requestSeriousAction(database.db, {
    name: 'business.verify',
    payload: { businessId },
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

async function waitingBusiness() {
  const business = await seedBusiness(database, {
    status: 'pending',
    name: 'The Yellow Chilli',
  });
  await ops.openIssue(database.db, {
    dedupeKey: `business_waiting.${business.businessId}`,
    kind: 'business_waiting',
    subject: { businessId: business.businessId },
    now: new Date(),
  });
  return business;
}
const statusOf = async (businessId) =>
  (
    await q(
      `SELECT status, verified_at, verified_by FROM businesses WHERE id = $1`,
      [businessId],
    )
  )[0];

test('verify with a second qualified person waits; the approver runs it; codes go live', async () => {
  const requester = await person();
  const approver = await person();
  const { businessId, slug } = await waitingBusiness();
  const outcome = await ask(requester, businessId);
  assert.equal(outcome.state, 'pending');
  assert.equal((await statusOf(businessId)).status, 'pending');
  const [request] = await q(
    `SELECT summary FROM approval_requests WHERE id = $1`,
    [outcome.requestId],
  );
  assert.equal(
    request.summary,
    `Verify The Yellow Chilli (usetipme.xyz/b/${slug}) so its codes go live.`,
  );

  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  assert.deepEqual(approved.result, { revalidateBusiness: slug });
  const verified = await statusOf(businessId);
  assert.equal(verified.status, 'verified');
  assert.ok(verified.verified_at);
  assert.equal(verified.verified_by, requester);
  const issues = await q(
    `SELECT status FROM issues WHERE kind = 'business_waiting' AND subject->>'businessId' = $1`,
    [businessId],
  );
  assert.deepEqual(issues, [{ status: 'resolved' }]);
  const notices = await q(
    `SELECT user_id, title, body FROM notifications WHERE kind = 'business_verified' AND business_id = $1`,
    [businessId],
  );
  assert.deepEqual(notices, [
    {
      user_id: ADA.userId,
      title: 'The Yellow Chilli is verified',
      body: 'Your codes are ready to print.',
    },
  ]);
});

test('with nobody else qualified it runs at once and says so', async () => {
  const requester = await person();
  const { businessId } = await waitingBusiness();
  const outcome = await ask(requester, businessId);
  assert.equal(outcome.state, 'ran');
  assert.equal(outcome.aloneReason, 'no_second_person');
  assert.equal((await statusOf(businessId)).status, 'verified');
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length,
    1,
  );
});

test('a slug changed after asking makes the approval stale', async () => {
  const requester = await person();
  const approver = await person();
  const { businessId } = await waitingBusiness();
  const outcome = await ask(requester, businessId);
  assert.equal(outcome.state, 'pending');
  await q(`UPDATE businesses SET slug = $2 WHERE id = $1`, [
    businessId,
    `fixed-${randomUUID().slice(0, 6)}`,
  ]);
  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'stale', JSON.stringify(approved));
  assert.equal((await statusOf(businessId)).status, 'pending');
});

test('verifying a suspended or verified business is refused at asking (dry run)', async () => {
  const requester = await person();
  await person();
  for (const status of ['verified', 'suspended']) {
    const { businessId } = await seedBusiness(database, { status });
    await assert.rejects(ask(requester, businessId), {
      code: 'INVALID_INPUT',
    });
    assert.equal(
      (
        await q(
          `SELECT 1 FROM approval_requests WHERE payload->>'businessId' = $1`,
          [businessId],
        )
      ).length,
      0,
    );
  }
});

test('a manager of the business cannot approve its verification', async () => {
  const requester = await person();
  const approver = await person();
  const { businessId } = await seedBusiness(database, {
    status: 'pending',
    owner: approver,
  });
  // The only other staff member is the business's owner, so nobody qualifies: it runs alone.
  const outcome = await ask(requester, businessId);
  assert.equal(outcome.state, 'ran');
});

// Owner's ruling, 6 Nov 2026: someone who runs the business never verifies it, even alone.
const recordedFor = async (businessId) =>
  q(`SELECT 1 FROM approval_requests WHERE payload->>'businessId' = $1`, [
    businessId,
  ]);

test('a lone admin who owns the business is refused and it stays pending', async () => {
  const requester = await person();
  const { businessId } = await seedBusiness(database, {
    status: 'pending',
    owner: requester,
  });
  await assert.rejects(ask(requester, businessId), {
    code: 'APPROVAL_SUBJECT',
  });
  assert.equal((await statusOf(businessId)).status, 'pending');
  assert.equal((await recordedFor(businessId)).length, 0);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type IN ('ops.acted_alone', 'ops.approval_pending')`,
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM audit_events WHERE staff_user_id = $1 AND action LIKE 'serious_action.%'`,
        [requester],
      )
    ).length,
    0,
  );
});

test('a lone admin who does not manage the business still acts alone', async () => {
  const requester = await person();
  const { businessId } = await waitingBusiness();
  const outcome = await ask(requester, businessId);
  assert.equal(outcome.state, 'ran');
  assert.equal(outcome.aloneReason, 'no_second_person');
  assert.equal((await statusOf(businessId)).status, 'verified');
});

test('with a second admin, the owner-admin is refused rather than queued', async () => {
  const requester = await person();
  await person();
  const { businessId } = await seedBusiness(database, {
    status: 'pending',
    owner: requester,
  });
  await assert.rejects(ask(requester, businessId), {
    code: 'APPROVAL_SUBJECT',
  });
  assert.equal((await statusOf(businessId)).status, 'pending');
  assert.equal((await recordedFor(businessId)).length, 0);
});

test('a manager who shares a mailbox with the requester also blocks the request', async () => {
  const requester = await person();
  const [{ email }] = await q(`SELECT email FROM users WHERE id = $1`, [
    requester,
  ]);
  const [{ id: twin }] = await q(
    `INSERT INTO users (id, email, email_verified_at, recovery_email, recovery_email_verified_at)
     VALUES (gen_random_uuid(), $1, now(), $2, now()) RETURNING id`,
    [`twin.${randomUUID().slice(0, 8)}@example.com`, email],
  );
  const { businessId } = await seedBusiness(database, {
    status: 'pending',
    owner: twin,
  });
  await assert.rejects(ask(requester, businessId), {
    code: 'APPROVAL_SUBJECT',
  });
  assert.equal((await statusOf(businessId)).status, 'pending');
});
