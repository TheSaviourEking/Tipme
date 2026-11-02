import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { sql } from '../../packages/database/node_modules/drizzle-orm/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import { handleDomainEvent } from '../../apps/worker/dist/handlers/domain-events.js';
import { staffAlertPoster } from '../../apps/worker/dist/handlers/domain-events.js';
import * as contracts from '../../packages/contracts/dist/index.js';
import {
  MAIL_SEAL_KEY,
  OPS_TOTP_KEY,
  WEB,
  browserHeaders,
  opsSignIn,
  startStack,
} from './helpers.mjs';

const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Checked with the person on a call today';
const SENSITIVE = 'fees.manage';
const HARMLESS = 'search.view';

const reads = { lockHeldDuringRead: [] };
let database;

/** Each provider read checks from elsewhere that nobody is holding the staff-admin lock. */
const lockHeld = async () =>
  (
    await database.pool.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
       AND objid = (hashtext('tipme.staff-admin')::bigint & 4294967295)::oid`,
    )
  ).rows.length > 0;
const reader = () => ({
  findPayoutByReference: async () => {
    reads.lockHeldDuringRead.push(await lockHeld());
    return null;
  },
  fetchPayoutStatus: async () => ({ status: 'not_found' }),
});

const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
  payoutReader: reader,
  mail: {
    production: false,
    configured: new Set(['mock']),
    fallback: 'mock',
    status: async () => {
      reads.lockHeldDuringRead.push(await lockHeld());
      return { sandbox: false };
    },
  },
});

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  ops.registerRealSeriousActions();
  ops.registerRealSeriousActions();
  ops.registerSeriousAction({
    name: 'test.overstays',
    permission: SENSITIVE,
    validate: async () => {},
    describe: async () => 'Writes, then overstays',
    run: async (tx) => {
      await tx.execute(
        sql`UPDATE profiles SET custom_fee_bps = 4321 WHERE handle_lower = 'tobi'`,
      );
      await tx.execute(sql`SELECT pg_sleep(30)`);
    },
  });
});
after(async () => {
  await database.close();
});

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

const people = new Map();
let seq = 0;

beforeEach(async () => {
  reads.lockHeldDuringRead.length = 0;
  for (const table of [
    'ops_sessions',
    'ops_lockouts',
    'staff_totp',
    'staff_enrolments',
    'staff_permission_overrides',
    'staff',
    'approval_requests',
    'outbox_events',
    'provider_tests',
    'provider_settings',
  ])
    await q(`DELETE FROM ${table}`);
  await q(
    `DELETE FROM issues WHERE kind LIKE 'staff_%' OR kind LIKE 'payout_%' OR kind = 'payment_reversed'`,
  );
  await q(`UPDATE profiles SET custom_fee_bps = NULL`);
});

async function person({ roleId = 'owner', recovery = null } = {}) {
  seq += 1;
  const email = `gate${seq}.${randomUUID().slice(0, 6)}@example.com`;
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at, recovery_email, recovery_email_verified_at)
     VALUES (gen_random_uuid(), $1, now(), $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [email, recovery],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [id, roleId],
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

async function roleWith(permissions) {
  const id = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [id]);
  for (const permission of permissions)
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [id, permission],
    );
  return id;
}

const ask = (actorId, name, payload, extra = {}) =>
  ops.requestSeriousAction(database.db, {
    name,
    payload,
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
    ...extra,
  });
const asking = (actorId) => ({
  actorId,
  grantId: people.get(actorId).grantId,
  reason: REASON,
  services: services(),
});
const codeOf = (id) =>
  totpAt(people.get(id).secret, BigInt(Math.floor(Date.now() / 30_000)));
const approve = (requestId, actorId) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: codeOf(actorId),
    key,
    services: services(),
  });
const rowOf = async (id) =>
  (await q(`SELECT * FROM approval_requests WHERE id = $1`, [id]))[0];
const profileId = async (handle = 'tobi') =>
  (await q(`SELECT id FROM profiles WHERE handle_lower = $1`, [handle]))[0].id;
const ownerOf = async (handle = 'tobi') =>
  (await q(`SELECT user_id FROM profiles WHERE handle_lower = $1`, [handle]))[0]
    .user_id;
const feeOf = async () =>
  (
    await q(`SELECT custom_fee_bps FROM profiles WHERE handle_lower = 'tobi'`)
  )[0].custom_fee_bps;

async function unresolvedPayoutIssue() {
  const owner = await ownerOf();
  void owner;
  const id = await profileId();
  const quote = await ops.createQuote(database.db, {
    handle: 'tobi',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `mock_pay_${randomUUID()}`;
  await ops.markAttemptInitiated(database.db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await ops.recordProviderEvent(database.db, {
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
  await q(`DELETE FROM withdrawal_holds WHERE profile_id = $1`, [id]);
  const { payoutId } = await ops.requestWithdrawal(database.db, {
    profileId: id,
    amountMinor: 100000n,
    idempotencyKey: randomUUID(),
    provider: {
      name: 'mock',
      capabilities: { connectedAccounts: false },
      payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
      payoutBalance: async () => ({ availableMinor: 100_000_000n }),
      quotePayoutFee: async () => ({ feeMinor: 5000n, exact: false }),
      coverPayoutFee: async () => ({ transferRef: 'transfer' }),
      findPayoutByReference: async () => null,
      fetchPayoutStatus: async () => ({ status: 'not_found' }),
    },
  });
  // Old enough that the provider's silence counts as absence.
  await q(
    `UPDATE payouts SET created_at = now() - interval '30 days', provider = 'mock', status = 'REQUESTED' WHERE id = $1`,
    [payoutId],
  );
  const issue = await ops.openIssue(database.db, {
    dedupeKey: `payout_unresolved.${payoutId}.${randomUUID()}`,
    kind: 'payout_unresolved',
    subject: { payoutId },
    now: new Date(),
  });
  return { issueId: issue.id, payoutId };
}

/** Every serious action: what to ask, and whether it has happened. */
const wired = {
  'email_recovery.start': async () => {
    const userId = await ownerOf();
    await q(
      `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
      [userId, `page.${randomUUID().slice(0, 6)}@example.com`],
    );
    await q(`DELETE FROM email_recoveries WHERE user_id = $1`, [userId]);
    return {
      payload: {
        userId,
        newEmail: `new.${randomUUID().slice(0, 6)}@example.com`,
        checks: 'Matched their last three tips',
      },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM email_recoveries WHERE user_id = $1 AND cancelled_at IS NULL AND completed_at IS NULL`,
            [userId],
          )
        ).length > 0,
    };
  },
  'payout.settle': async () => {
    const { issueId, payoutId } = await unresolvedPayoutIssue();
    return {
      payload: { issueId, how: 'mark_failed' },
      happened: async () =>
        (await q(`SELECT status FROM payouts WHERE id = $1`, [payoutId]))[0]
          .status === 'FAILED',
    };
  },
  'balance.write_off': async () => {
    const issue = await ops.openIssue(database.db, {
      dedupeKey: `payment_reversed.${randomUUID()}`,
      kind: 'payment_reversed',
      subject: { profileId: await profileId() },
      now: new Date(),
    });
    return {
      payload: { issueId: issue.id },
      happened: async () =>
        (
          await q(`SELECT resolution_outcome FROM issues WHERE id = $1`, [
            issue.id,
          ])
        )[0].resolution_outcome === 'written_off',
    };
  },
  'fee.change': async () => ({
    payload: { profileId: await profileId(), feeBps: 250 },
    happened: async () => (await feeOf()) === 250,
  }),
  'fee.free': async () => {
    const id = await profileId();
    await q(`DELETE FROM fee_free_credits WHERE profile_id = $1`, [id]);
    return {
      payload: { profileId: id, count: 3 },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM fee_free_credits WHERE profile_id = $1 AND remaining = 3`,
            [id],
          )
        ).length > 0,
    };
  },
  'staff.grant_owner': async () => {
    const userId = await person({ roleId: await roleWith([HARMLESS]) });
    return {
      payload: { kind: 'role', userId, roleId: 'owner' },
      happened: async () =>
        (await q(`SELECT role_id FROM staff WHERE user_id = $1`, [userId]))[0]
          .role_id === 'owner',
      third: userId,
    };
  },
  'staff.grant_sensitive': async () => {
    const userId = await person({ roleId: await roleWith([HARMLESS]) });
    const roleId = await roleWith([SENSITIVE]);
    return {
      payload: { kind: 'role', userId, roleId },
      happened: async () =>
        (await q(`SELECT role_id FROM staff WHERE user_id = $1`, [userId]))[0]
          .role_id === roleId,
    };
  },
  'role.add_sensitive': async () => {
    const roleId = await roleWith([HARMLESS]);
    return {
      payload: { roleId, permissions: [HARMLESS, SENSITIVE] },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission = $2`,
            [roleId, SENSITIVE],
          )
        ).length > 0,
    };
  },
  'staff.reset_authenticator': async () => {
    const userId = await person({ roleId: await roleWith([HARMLESS]) });
    return {
      payload: { userId },
      happened: async () =>
        (await q(`SELECT 1 FROM staff_totp WHERE user_id = $1`, [userId]))
          .length === 0,
    };
  },
  'mail_provider.switch': async () => {
    await q(
      `INSERT INTO provider_tests (id, kind, provider, started_by, started_at, status, confirmed_at)
       VALUES (gen_random_uuid(), 'mail', 'mock', $1, now(), 'confirmed', now())`,
      [await person()],
    );
    return {
      payload: { provider: 'mock' },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM provider_settings WHERE kind = 'mail' AND active_provider = 'mock'`,
          )
        ).length > 0,
    };
  },
};

test('every serious action in the catalogue is wired here', () => {
  assert.deepEqual(
    Object.keys(wired).sort(),
    [...contracts.SERIOUS_ACTIONS].sort(),
  );
});

for (const [action, fixture] of Object.entries(wired)) {
  test(`${action}: waits for a second person when one qualifies`, async () => {
    const requester = await person();
    const second = await person();
    const { payload, happened } = await fixture();
    const outcome = await ask(requester, action, payload);
    assert.equal(outcome.state, 'pending', action);
    assert.equal(await happened(), false, 'nothing happens yet');
    const row = await rowOf(outcome.requestId);
    assert.ok(row.summary.length > 0);
    const approved = await approve(outcome.requestId, second);
    if (approved.status !== 'approved')
      assert.fail(
        JSON.stringify(
          await q(
            `SELECT reason FROM audit_events WHERE subject_id = $1 ORDER BY seq`,
            [outcome.requestId],
          ),
        ),
      );
    assert.equal(await happened(), true, 'it ran on approval');
    assert.ok(!reads.lockHeldDuringRead.includes(true), 'read under the lock');
  });

  test(`${action}: runs alone with the alert when nobody qualifies`, async () => {
    const requester = await person();
    const { payload, happened } = await fixture();
    // The fixtures that add staff or tests may have made someone else qualified.
    await q(
      `UPDATE staff SET revoked_at = now() WHERE role_id = 'owner' AND user_id <> $1`,
      [requester],
    );
    const outcome = await ask(requester, action, payload);
    assert.equal(outcome.state, 'ran', JSON.stringify(outcome));
    assert.equal(outcome.aloneReason, 'no_second_person');
    assert.equal(await happened(), true);
    assert.equal(
      (
        await q(
          `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
        )
      ).length,
      1,
    );
    assert.ok(!reads.lockHeldDuringRead.includes(true), 'read under the lock');
  });
}

test('giving someone a role with no sensitive permission applies at once', async () => {
  const requester = await person();
  await person();
  const userId = await person({ roleId: await roleWith([HARMLESS]) });
  const roleId = await roleWith(['analytics.view'].filter(Boolean));
  const outcome = await ops.changeRoleOrAsk(database.db, {
    ...asking(requester),
    userId,
    roleId,
  });
  assert.equal(outcome.state, 'applied');
  assert.equal(
    (await q(`SELECT role_id FROM staff WHERE user_id = $1`, [userId]))[0]
      .role_id,
    roleId,
  );
});

test('giving someone a role containing a sensitive permission waits', async () => {
  const requester = await person();
  await person();
  const userId = await person({ roleId: await roleWith([HARMLESS]) });
  const roleId = await roleWith([SENSITIVE]);
  const outcome = await ops.changeRoleOrAsk(database.db, {
    ...asking(requester),
    userId,
    roleId,
  });
  assert.equal(outcome.state, 'pending');
  assert.notEqual(
    (await q(`SELECT role_id FROM staff WHERE user_id = $1`, [userId]))[0]
      .role_id,
    roleId,
  );
});

test('adding someone on a sensitive role, or a personal sensitive permission, waits; a harmless addition does not', async () => {
  const requester = await person();
  await person();
  const added = await ops.addStaffOrAsk(database.db, {
    ...asking(requester),
    email: `added.${randomUUID().slice(0, 6)}@example.com`,
    roleId: await roleWith([SENSITIVE]),
  });
  assert.equal(added.state, 'pending');
  const userId = await person({ roleId: await roleWith([HARMLESS]) });
  const personal = await ops.setPersonalAccessOrAsk(database.db, {
    ...asking(requester),
    userId,
    additions: [SENSITIVE],
    removals: [],
  });
  assert.equal(personal.state, 'pending');
  const harmless = await ops.setPersonalAccessOrAsk(database.db, {
    ...asking(requester),
    userId,
    additions: ['analytics.view'].filter(() => false),
    removals: [],
  });
  assert.equal(harmless.state, 'applied');
});

test('clearing a personal removal that hands a sensitive permission back waits', async () => {
  const requester = await person();
  await person();
  const userId = await person({ roleId: await roleWith([SENSITIVE]) });
  await q(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by) VALUES ($1, $2, 'remove', $3)`,
    [userId, SENSITIVE, requester],
  );
  const outcome = await ops.setPersonalAccessOrAsk(database.db, {
    ...asking(requester),
    userId,
    additions: [],
    removals: [],
  });
  assert.equal(outcome.state, 'pending');
});

test('a role edited or deleted while a request waits stops the request', async () => {
  const requester = await person();
  const second = await person();
  const userId = await person({ roleId: await roleWith([HARMLESS]) });
  const edited = await roleWith([SENSITIVE]);
  const first = await ask(requester, 'staff.grant_sensitive', {
    kind: 'role',
    userId,
    roleId: edited,
  });
  await ops.updateRole(database.db, {
    actorId: second,
    roleId: edited,
    description: 'Changed while it waited',
    reason: REASON,
  });
  assert.deepEqual(await approve(first.requestId, second), {
    status: 'stale',
    why: 'facts_changed',
  });
  const deleted = await roleWith([SENSITIVE]);
  const secondAsk = await ask(requester, 'staff.grant_sensitive', {
    kind: 'role',
    userId,
    roleId: deleted,
  });
  await ops.deleteRole(database.db, {
    actorId: second,
    roleId: deleted,
    reason: REASON,
  });
  const third = await person();
  assert.equal((await approve(secondAsk.requestId, third)).status, 'stale');
  assert.equal(
    (await q(`SELECT role_id FROM staff WHERE user_id = $1`, [userId]))[0]
      .role_id === deleted,
    false,
  );
});

test('removing a person never waits', async () => {
  const requester = await person();
  await person();
  const userId = await person({ roleId: await roleWith([SENSITIVE]) });
  await ops.removeStaff(database.db, {
    ...asking(requester),
    userId,
    sealing,
  });
  assert.ok(
    (await q(`SELECT revoked_at FROM staff WHERE user_id = $1`, [userId]))[0]
      .revoked_at,
  );
});

test('I2: who may decide comes from the real actions: only an owner decides owner-only ones', async () => {
  const requester = await person();
  const manager = await person({ roleId: await roleWith(['staff.manage']) });
  const target = await person({ roleId: await roleWith([HARMLESS]) });
  // A manager holds staff.manage, but isn't a second person for this: it runs alone.
  const alone = await ask(requester, 'staff.reset_authenticator', {
    userId: target,
  });
  assert.equal(alone.state, 'ran');
  const other = await person();
  const pending = await ask(requester, 'staff.reset_authenticator', {
    userId: await person({ roleId: await roleWith([HARMLESS]) }),
  });
  await assert.rejects(approve(pending.requestId, manager), {
    code: 'PERMISSION_NOT_HELD',
  });
  assert.equal((await approve(pending.requestId, other)).status, 'approved');
});

test('I2: someone who does not hold what is granted cannot decide it', async () => {
  const requester = await person();
  const manager = await person({ roleId: await roleWith(['staff.manage']) });
  const owner = await person();
  const target = await person({ roleId: await roleWith([HARMLESS]) });
  const pending = await ask(requester, 'staff.grant_sensitive', {
    kind: 'role',
    userId: target,
    roleId: await roleWith([SENSITIVE]),
  });
  await assert.rejects(approve(pending.requestId, manager), {
    code: 'PERMISSION_NOT_HELD',
  });
  assert.equal((await approve(pending.requestId, owner)).status, 'approved');
});

test('I4: a page owner on staff cannot approve their own fee, by id or by mailbox', async () => {
  const requester = await person();
  const pageOwner = await ownerOf();
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [pageOwner],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [pageOwner, ops.sealSecret(key, secret)],
  );
  people.set(pageOwner, { secret });
  const [{ email: ownerEmail }] = await q(
    `SELECT email FROM users WHERE id = $1`,
    [pageOwner],
  );
  const payload = { profileId: await profileId(), feeBps: 111 };
  // Nobody else: the page owner doesn't count, so it runs alone.
  assert.equal((await ask(requester, 'fee.change', payload)).state, 'ran');
  const other = await person({ recovery: ownerEmail ?? 'none@example.com' });
  const third = await person();
  const pending = await ask(requester, 'fee.change', {
    profileId: payload.profileId,
    feeBps: 222,
  });
  await assert.rejects(approve(pending.requestId, pageOwner), {
    code: 'APPROVAL_SUBJECT',
  });
  if (ownerEmail)
    await assert.rejects(approve(pending.requestId, other), {
      code: 'APPROVAL_SUBJECT',
    });
  assert.equal((await approve(pending.requestId, third)).status, 'approved');
  assert.equal(await feeOf(), 222);
});

test('I4: someone on a role cannot approve adding to it', async () => {
  const requester = await person();
  const roleId = await roleWith(['staff.manage', HARMLESS]);
  const member = await person({ roleId });
  const other = await person();
  // They hold what's being added, so only being on the role stops them.
  await q(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by) VALUES ($1, $2, 'add', $3)`,
    [member, SENSITIVE, other],
  );
  const pending = await ask(requester, 'role.add_sensitive', {
    roleId,
    permissions: ['staff.manage', HARMLESS, SENSITIVE],
  });
  await assert.rejects(approve(pending.requestId, member), {
    code: 'APPROVAL_SUBJECT',
  });
  assert.equal((await approve(pending.requestId, other)).status, 'approved');
});

test('I6: an older fee request cannot overwrite a fee that has moved', async () => {
  const requester = await person();
  const second = await person();
  const id = await profileId();
  const old = await ask(requester, 'fee.change', {
    profileId: id,
    feeBps: 300,
  });
  const newer = await ask(requester, 'fee.change', {
    profileId: id,
    feeBps: 400,
  });
  assert.equal((await approve(newer.requestId, second)).status, 'approved');
  const third = await person();
  assert.equal((await approve(old.requestId, third)).status, 'stale');
  assert.equal(await feeOf(), 400);
});

test('N2: an identical request from someone who cannot count does not run again after a lone action', async () => {
  const a = await person();
  const b = await person();
  const id = await profileId();
  const payload = { profileId: id, count: 2 };
  await q(`DELETE FROM fee_free_credits WHERE profile_id = $1`, [id]);
  const asked = await ask(a, 'fee.free', payload);
  // b leaves: a's request now has nobody, and c arrives with a's mailbox-free account.
  await q(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [a]);
  await q(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [a]);
  await q(`DELETE FROM staff_totp WHERE user_id = $1`, [a]);
  const alone = await ask(b, 'fee.free', payload);
  assert.equal(alone.state, 'ran');
  assert.deepEqual(alone.superseded, [asked.requestId]);
  const row = await rowOf(asked.requestId);
  assert.equal(row.status, 'stale');
  assert.equal(row.decided_reason, 'superseded');
  assert.equal(
    (
      await q(`SELECT remaining FROM fee_free_credits WHERE profile_id = $1`, [
        id,
      ])
    )[0].remaining,
    2,
  );
  // Theirs: they hear it was closed.
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.approval_closed' AND aggregate_id = $1`,
        [asked.requestId],
      )
    ).length,
    1,
  );
});

test('N3: losing the second owner is alerted even while another person holds staff.manage', async () => {
  const actor = await person();
  const other = await person();
  await person({ roleId: await roleWith(['staff.manage']) });
  await person({ roleId: await roleWith(['staff.manage']) });
  await ops.removeStaff(database.db, {
    actorId: actor,
    userId: other,
    reason: REASON,
    sealing,
  });
  const [alert] = await q(
    `SELECT payload FROM outbox_events WHERE event_type = 'ops.last_approver_removed'`,
  );
  assert.ok(alert, 'alerted');
  assert.match(alert.payload.permissions, /owner-only actions/);
});

test('N6: grant-owner by phone refuses a recovery address that reaches a colleague', async () => {
  const colleague = await person();
  const phone = `+23480999${String(++seq).padStart(5, '0')}`;
  await q(
    `INSERT INTO users (id, phone_e164, recovery_email, recovery_email_verified_at) VALUES (gen_random_uuid(), $1, $2, now())`,
    [phone, people.get(colleague).email],
  );
  await assert.rejects(ops.grantOwner(database.db, { phone }), {
    code: 'STAFF_EMAIL_TAKEN',
  });
});

test('N7: a repeat ask leaves an audit row naming who asked, with their reason', async () => {
  const a = await person();
  const b = await person();
  await person();
  const payload = { profileId: await profileId(), feeBps: 555 };
  const first = await ask(a, 'fee.change', payload);
  const again = await ask(b, 'fee.change', payload, {
    reason: 'A different reason from another person',
  });
  assert.equal(again.requestId, first.requestId);
  assert.equal(again.repeat, true);
  const [row] = await q(
    `SELECT * FROM audit_events WHERE action = 'serious_action.repeated' AND subject_id = $1`,
    [first.requestId],
  );
  assert.equal(row.staff_user_id, b);
  assert.match(row.reason, /A different reason from another person/);
});

test('N1: a run past its time leaves nothing written and the lock free', async () => {
  const owner = await person();
  await assert.rejects(ask(owner, 'test.overstays', {}), {
    code: 'STAFF_ADMIN_BUSY',
  });
  assert.equal(await feeOf(), null);
  assert.equal(await lockHeld(), false);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM audit_events WHERE action = 'serious_action.ran_alone' AND staff_user_id = $1`,
        [owner],
      )
    ).length,
    0,
  );
});

test('a credential-looking payload key stays refused', async () => {
  const owner = await person();
  await assert.rejects(
    ask(owner, 'fee.change', {
      profileId: await profileId(),
      feeBps: 1,
      currencyCode: 'NGN',
    }),
    { code: 'INVALID_INPUT' },
  );
});

test('the worker: pending mail obeys the real rules, and alone reaches the webhook without the address', async () => {
  const requester = await person();
  const pageOwner = await ownerOf();
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [pageOwner],
  );
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [pageOwner, ops.sealSecret(key, newTotpSecret())],
  );
  const able = await person();
  const asked = await ask(requester, 'fee.change', {
    profileId: await profileId(),
    feeBps: 123,
  });
  const logger = { info() {}, warn() {} };
  const posted = [];
  const URL = 'https://hooks.example.com/secret-path';
  const logs = [];
  const postStaffAlert = staffAlertPoster({
    url: URL,
    fetchImpl: async (url, init) => {
      posted.push({ url, body: init.body });
      return new Response('', { status: 200 });
    },
    log: (entry) => logs.push(entry),
  });
  await handleDomainEvent(
    'ops.approval_pending',
    {
      action: 'fee.change',
      requestedBy: requester,
      requestId: asked.requestId,
      permission: 'fees.manage',
    },
    {
      db: database.db,
      logger,
      dedupeKey: `ops.approval_pending.${asked.requestId}`,
      sealing,
      pretendPayment: true,
      postStaffAlert,
    },
  );
  const mailed = (
    await q(
      `SELECT user_id FROM mail_messages WHERE type = 'staff_approval_pending'`,
    )
  ).map((row) => row.user_id);
  assert.ok(mailed.includes(able));
  assert.ok(!mailed.includes(pageOwner), 'the page owner can’t decide this');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, URL);
  assert.ok(!posted[0].body.includes('hooks.example.com'));

  // A failed post is logged by a fixed word, never quoting the address.
  const failing = staffAlertPoster({
    url: URL,
    fetchImpl: async () => {
      throw new Error(`connect failed ${URL}`);
    },
    log: (entry) => logs.push(entry),
  });
  await failing({
    event: 'ops.acted_alone',
    action: 'fee.change',
    requestedBy: requester,
  });
  assert.ok(logs.some((entry) => entry.event === 'staff_alert.not_posted'));
  assert.ok(!JSON.stringify(logs).includes('hooks.example.com'));
});

test('routes answer 202 with the request, repeats say so, and asking is limited per person', async (t) => {
  // Only here: a running worker would start the withdrawals the other tests set up by hand.
  const stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '6',
    },
  });
  t.after(() => stack.stop());
  const phone = `+23480888${String(++seq).padStart(5, '0')}`;
  const session = await opsSignIn(stack.api, database.db, phone);
  await person();
  const id = await profileId();
  const post = (feeBps) =>
    fetch(`${stack.api}/v1/ops/pages/${id}/fee`, {
      method: 'POST',
      headers: browserHeaders(session.cookie),
      body: JSON.stringify({ feeBps, reason: REASON }),
    });
  const first = await post(700);
  assert.equal(first.status, 202);
  const { data } = await first.json();
  assert.ok(data.requestId);
  assert.equal(data.repeat, undefined);
  const second = await post(700);
  assert.equal(second.status, 202);
  assert.deepEqual((await second.json()).data, {
    requestId: data.requestId,
    repeat: true,
  });
  assert.equal(await feeOf(), null);
  let last;
  for (let i = 0; i < 6; i += 1) last = await post(700);
  assert.equal(last.status, 429);
});
