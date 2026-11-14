import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
import { seedBusiness } from '../../packages/database/test/integration/business-fixtures.mjs';
import { GROSS, reportedReversal } from './reversal-fixtures.mjs';
import {
  MAIL_SEAL_KEY,
  OPS_TOTP_KEY,
  REDIS_URL,
  WEB,
  WEBHOOK_SECRET,
  browserHeaders,
  opsSignIn,
  startStack,
} from './helpers.mjs';

const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Checked with the person on a call today';
const OPERATION = (error) => error instanceof ops.OperationError;
const SENSITIVE = 'fees.manage';
const HARMLESS = 'search.view';

const reads = { lockHeldDuringRead: [] };
let database;

/**
 * Each provider read checks from elsewhere that nobody is holding the staff-admin lock in this
 * database. pg_locks covers the whole server, and test files running alongside hold the same lock
 * in their own databases.
 */
const lockHeld = async () =>
  (
    await database.pool.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
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
  // tip.reverse runs only while business shares are on (R2-A review finding 3).
  businessSharesEnabled: true,
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
  // Take-backs name the request that approved them; the requests go below.
  await q(`UPDATE handle_take_backs SET approval_request_id = NULL`);
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
    tipMinor: 400000n,
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
    amountMinor: 400000n,
    currency: 'NGN',
    providerFeeMinor: 3000n,
    signatureVerified: true,
    payload: {},
  });
  await q(`DELETE FROM withdrawal_holds WHERE profile_id = $1`, [id]);
  const { payoutId } = await ops.requestWithdrawal(database.db, {
    profileId: id,
    amountMinor: 200000n,
    idempotencyKey: randomUUID(),
    provider: {
      name: 'mock',
      capabilities: { connectedAccounts: false },
      payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
      payoutBalance: async () => ({ availableMinor: 200000000n }),
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
/** A price change for one plan: the next price up, and whether it is now that plan's latest. */
async function priceFixture(plan) {
  const latest = async () =>
    (
      await q(
        `SELECT amount_minor::text AS amount FROM pro_prices WHERE plan = $1
          ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
        [plan],
      )
    )[0].amount;
  const next = String(BigInt(await latest()) + 10000n);
  return {
    payload: { amountMinor: next },
    happened: async () => (await latest()) === next,
  };
}

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
  'money_issue.close': async () => {
    const issue = await ops.openIssue(database.db, {
      dedupeKey: `payment_reversed.${randomUUID()}`,
      kind: 'payment_reversed',
      subject: { profileId: await profileId() },
      now: new Date(),
    });
    return {
      payload: { issueId: issue.id, outcome: 'written_off' },
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
  // Paid Pro (ADR-0015): a price one naira-step away from whatever is current, each time.
  'pro_price.change': async () => priceFixture('personal'),
  // Business Pro (plan Task A5): its own price, changed the same way.
  'business_pro_price.change': async () => priceFixture('business'),
  // Paid Pro, plan Task 9: a card month paid just now, on a page of its own.
  'pro.refund': async () => {
    const [{ id: userId }] = await q(
      `INSERT INTO users (id) VALUES (gen_random_uuid()) RETURNING id`,
    );
    const handle = `refund_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const [{ id: profileId }] = await q(
      `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state)
       VALUES (gen_random_uuid(), $1, $2, $2, 'Page', 'live') RETURNING id`,
      [userId, handle],
    );
    const [{ id: purchaseId }] = await q(
      `INSERT INTO pro_purchases (id, profile_id, method, price_id, amount_minor, currency, status,
                                  provider, provider_reference, idempotency_key, fingerprint,
                                  paid_at, fee_minor, charge_reference)
       SELECT gen_random_uuid(), $1, 'card', id, amount_minor, 'NGN', 'PAID', 'bachs',
              'platform:cs_' || substr(md5(random()::text), 1, 12), gen_random_uuid()::text, 'x',
              now(), 5000, 'ch_' || substr(md5(random()::text), 1, 12)
         FROM pro_prices ORDER BY effective_from DESC, created_at DESC LIMIT 1
       RETURNING id`,
      [profileId],
    );
    await q(
      `INSERT INTO pro_periods (id, profile_id, purchase_id, starts_at, ends_at, grace_ends_at, status, paid_by, amount_minor, currency)
       VALUES (gen_random_uuid(), $1, $2, now(), now() + interval '30 days', now() + interval '33 days', 'ACTIVE', 'card', 250000, 'NGN')`,
      [profileId, purchaseId],
    );
    return {
      payload: { purchaseId },
      happened: async () =>
        (
          await q(`SELECT 1 FROM pro_refunds WHERE purchase_id = $1`, [
            purchaseId,
          ])
        ).length === 1,
    };
  },
  'username.take_back': async () => {
    const handle = `gate_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const [{ id: userId }] = await q(
      `INSERT INTO users (id) VALUES (gen_random_uuid()) RETURNING id`,
    );
    const [{ id }] = await q(
      `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state)
       VALUES (gen_random_uuid(), $1, $2, $2, 'Page', 'live') RETURNING id`,
      [userId, handle],
    );
    return {
      payload: {
        profileId: id,
        name: handle,
        kind: 'current',
        category: 'ordinary',
        noticeDays: 7,
      },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM handle_take_backs WHERE handle_lower = $1 AND state = 'approved'`,
            [handle],
          )
        ).length > 0,
    };
  },
  'changelog.publish': async () => {
    const number = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    await q(
      `INSERT INTO changelog_entries (pr_number, merge_sha, merged_at, pr_title, staff_text, user_text, audience)
       VALUES ($1, $2, now(), 'feat: pins', 'feat: pins — Adds pins.', 'You can pin a supporter note.', 'everyone')`,
      [number, 'd'.repeat(40)],
    );
    return {
      payload: { number, revision: 1 },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM changelog_entries WHERE pr_number = $1 AND published_revision = 1`,
            [number],
          )
        ).length > 0,
    };
  },
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
  'business.verify': async () => {
    const { businessId } = await seedBusiness(database, { status: 'pending' });
    return {
      payload: { businessId },
      happened: async () =>
        (
          await q(`SELECT status FROM businesses WHERE id = $1`, [businessId])
        )[0].status === 'verified',
    };
  },
  'tip.reverse': async () => {
    // No hold: beforeEach deletes payment_reversed issues, which a hold would still name.
    const { tipId, issueId, partnerReversalId, reversals } =
      await reportedReversal(database, { bps: 1000, keepHold: false });
    return {
      payload: {
        issueId,
        tipId,
        partnerReversalId,
        refundedMinor: GROSS.toString(),
      },
      happened: async () => (await reversals()) === 1,
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
  const roleId = await roleWith(['analytics.view']);
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
    additions: ['analytics.view'],
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

test("the page's owner can't approve a take-back of their own page", async () => {
  const requester = await person();
  const handle = `own_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const pageOwner = await person();
  const [{ id }] = await q(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state)
     VALUES (gen_random_uuid(), $1, $2, $2, 'Page', 'live') RETURNING id`,
    [pageOwner, handle],
  );
  const third = await person();
  const pending = await ask(requester, 'username.take_back', {
    profileId: id,
    name: handle,
    kind: 'current',
    category: 'trademark',
    noticeDays: 3,
  });
  assert.equal(pending.state, 'pending');
  await assert.rejects(approve(pending.requestId, pageOwner), {
    code: 'APPROVAL_SUBJECT',
  });
  assert.equal((await approve(pending.requestId, third)).status, 'approved');
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
  // a can no longer enter a code, so a doesn't count as second person for b, whose ask runs alone.
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

/* A reader whose answers each test scripts. */
const scripted = (answer) => ({
  ...services(),
  payoutReader: () => ({
    findPayoutByReference: async () => answer(),
    fetchPayoutStatus: async () => ({ status: 'not_found' }),
  }),
});
const FOUND = (status) => ({
  providerReference: `ref_${randomUUID()}`,
  status,
});
const statusOf = async (payoutId) =>
  (await q(`SELECT status FROM payouts WHERE id = $1`, [payoutId]))[0].status;
const approveWith = (requestId, actorId, servicesNow) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: codeOf(actorId),
    key,
    services: servicesNow,
  });
const noFalseSuccess = async (requestId) => {
  assert.equal(
    (
      await q(
        `SELECT 1 FROM audit_events WHERE subject_id = $1 AND action IN ('serious_action.ran', 'serious_action.approved')`,
        [requestId],
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.approval_ran' AND aggregate_id = $1`,
        [requestId],
      )
    ).length,
    0,
  );
};

for (const [reported, expected] of [
  ['paid', 'PAID'],
  ['failed', 'FAILED'],
]) {
  test(`payout.settle apply ${reported}: waits, then records what the provider says`, async () => {
    const requester = await person();
    const second = await person();
    const { issueId, payoutId } = await unresolvedPayoutIssue();
    const answering = scripted(() => FOUND(reported));
    const asked = await ask(
      requester,
      'payout.settle',
      { issueId, how: 'apply', reported },
      { services: answering },
    );
    assert.equal(asked.state, 'pending');
    assert.equal(await statusOf(payoutId), 'REQUESTED');
    assert.equal(
      (await approveWith(asked.requestId, second, answering)).status,
      'approved',
    );
    assert.equal(await statusOf(payoutId), expected);
  });
}

test('payout.settle apply: the provider’s answer changing during the wait goes stale', async () => {
  const requester = await person();
  const second = await person();
  const { issueId, payoutId } = await unresolvedPayoutIssue();
  const asked = await ask(
    requester,
    'payout.settle',
    { issueId, how: 'apply', reported: 'paid' },
    { services: scripted(() => FOUND('paid')) },
  );
  const outcome = await approveWith(
    asked.requestId,
    second,
    scripted(() => null),
  );
  assert.equal(outcome.status, 'stale');
  assert.equal(await statusOf(payoutId), 'REQUESTED');
  await noFalseSuccess(asked.requestId);
});

test('I3: a settlement refused inside the run is not approved-and-ran, and the mutation of the first refusal is caught', async () => {
  const requester = await person();
  const second = await person();
  const { issueId, payoutId } = await unresolvedPayoutIssue();
  const asked = await ask(
    requester,
    'payout.settle',
    { issueId, how: 'apply', reported: 'paid' },
    { services: scripted(() => FOUND('paid')) },
  );
  // Another reference lands after the read and before the lock.
  const racing = scripted(async () => {
    await q(`UPDATE payouts SET provider_reference = $2 WHERE id = $1`, [
      payoutId,
      `someone_else_${randomUUID()}`,
    ]);
    return FOUND('paid');
  });
  const outcome = await approveWith(asked.requestId, second, racing);
  assert.equal(outcome.status, 'stale', JSON.stringify(outcome));
  assert.equal((await rowOf(asked.requestId)).status, 'stale');
  assert.notEqual(await statusOf(payoutId), 'PAID');
  await noFalseSuccess(asked.requestId);
});

test('I3: alone on an issue already closed records no ran_alone and no alert; with a second person no request opens', async () => {
  const requester = await person();
  const { issueId } = await unresolvedPayoutIssue();
  await q(
    `UPDATE issues SET status = 'resolved', resolved_at = now() WHERE id = $1`,
    [issueId],
  );
  const payload = { issueId, how: 'mark_failed' };
  await assert.rejects(ask(requester, 'payout.settle', payload), OPERATION);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM audit_events WHERE action = 'serious_action.ran_alone' AND staff_user_id = $1`,
        [requester],
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length,
    0,
  );
  await person();
  await assert.rejects(ask(requester, 'payout.settle', payload), OPERATION);
  assert.equal((await q(`SELECT 1 FROM approval_requests`)).length, 0);
});

test('M1: a mismatch found at approval keeps its conflict issue, and the request stops', async () => {
  const requester = await person();
  const second = await person();
  const { issueId, payoutId } = await unresolvedPayoutIssue();
  const asked = await ask(
    requester,
    'payout.settle',
    { issueId, how: 'apply', reported: 'paid' },
    { services: scripted(() => FOUND('paid')) },
  );
  const wrong = scripted(() => ({ ...FOUND('paid'), amountMinor: 1n }));
  assert.equal(
    (await approveWith(asked.requestId, second, wrong)).status,
    'stale',
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM issues WHERE kind = 'payout_conflict' AND subject->>'payoutId' = $1`,
        [payoutId],
      )
    ).length,
    1,
  );
});

test('M2: a provider outage at approval leaves the request waiting and the code unused', async () => {
  const requester = await person();
  const second = await person();
  const { issueId } = await unresolvedPayoutIssue();
  const asked = await ask(requester, 'payout.settle', {
    issueId,
    how: 'mark_failed',
  });
  const down = {
    ...services(),
    payoutReader: () => ({
      findPayoutByReference: async () => {
        throw new Error('connection refused');
      },
      fetchPayoutStatus: async () => {
        throw new Error('connection refused');
      },
    }),
  };
  await assert.rejects(approveWith(asked.requestId, second, down), {
    code: 'PROVIDER_STATUS_UNKNOWN',
  });
  assert.equal((await rowOf(asked.requestId)).status, 'pending');
  assert.equal(
    (
      await q(`SELECT last_step FROM staff_totp WHERE user_id = $1`, [second])
    )[0].last_step,
    null,
  );
  assert.equal(
    (await approveWith(asked.requestId, second, services())).status,
    'approved',
  );
});

test('M3: clearing a personal removal needs an approver holding that permission', async () => {
  const requester = await person();
  const manager = await person({ roleId: await roleWith(['staff.manage']) });
  const owner = await person();
  const userId = await person({ roleId: await roleWith([SENSITIVE]) });
  await q(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by) VALUES ($1, $2, 'remove', $3)`,
    [userId, SENSITIVE, requester],
  );
  const asked = await ops.setPersonalAccessOrAsk(database.db, {
    ...asking(requester),
    userId,
    additions: [],
    removals: [],
  });
  assert.equal(asked.state, 'pending');
  await assert.rejects(approve(asked.requestId, manager), {
    code: 'PERMISSION_NOT_HELD',
  });
  assert.equal((await approve(asked.requestId, owner)).status, 'approved');
});

test('M7: a requester who has lost issues.resolve can’t have a money close run', async () => {
  const roleId = await roleWith(['payouts.resolve', 'issues.resolve']);
  const requester = await person({ roleId });
  const owner = await person();
  const issue = await ops.openIssue(database.db, {
    dedupeKey: `payment_reversed.${randomUUID()}`,
    kind: 'payment_reversed',
    subject: { profileId: await profileId() },
    now: new Date(),
  });
  const asked = await ask(requester, 'money_issue.close', {
    issueId: issue.id,
    outcome: 'recipient_owes',
  });
  await q(
    `DELETE FROM role_permissions WHERE role_id = $1 AND permission = 'issues.resolve'`,
    [roleId],
  );
  assert.equal((await approve(asked.requestId, owner)).status, 'stale');
  assert.equal(
    (await q(`SELECT status FROM issues WHERE id = $1`, [issue.id]))[0].status,
    'open',
  );
});

test('I4: recovery can’t move an account to the requester’s or the approver’s own mailbox, tags and dots included', async () => {
  const requester = await person();
  const approver = await person();
  const other = await person();
  const userId = await ownerOf();
  await q(
    `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
    [userId, `page.${randomUUID().slice(0, 6)}@example.com`],
  );
  await q(`DELETE FROM email_recoveries WHERE user_id = $1`, [userId]);
  const tagged = (id) => people.get(id).email.replace('@', '+x@');
  const checks = 'Matched their last three tips';
  await assert.rejects(
    ask(requester, 'email_recovery.start', {
      userId,
      newEmail: tagged(requester),
      checks,
    }),
    { code: 'APPROVAL_SUBJECT' },
  );
  await assert.rejects(
    ask(requester, 'email_recovery.start', {
      userId,
      newEmail: tagged(approver),
      checks,
    }),
    { code: 'APPROVAL_SUBJECT' },
  );
  // Gmail's dots are the same mailbox.
  await q(`UPDATE users SET email = 'first.last@gmail.com' WHERE id = $1`, [
    other,
  ]);
  await assert.rejects(
    ask(requester, 'email_recovery.start', {
      userId,
      newEmail: 'firstlast+y@gmail.com',
      checks,
    }),
    { code: 'APPROVAL_SUBJECT' },
  );
  // Asked for an outsider, who then turns out to reach the approver's mailbox: they can't decide.
  const outsider = `out.${randomUUID().slice(0, 6)}@example.com`;
  const asked = await ask(requester, 'email_recovery.start', {
    userId,
    newEmail: outsider,
    checks,
  });
  assert.equal(asked.state, 'pending');
  const row = await rowOf(asked.requestId);
  assert.match(row.summary, /Matched their last three tips/);
  assert.match(row.summary, /matches no staff mailbox/);
  assert.ok(!row.summary.includes(outsider), 'the address stays masked');
  await q(
    `UPDATE users SET recovery_email = $2, recovery_email_verified_at = now() WHERE id = $1`,
    [approver, outsider],
  );
  await assert.rejects(approve(asked.requestId, approver), {
    code: 'APPROVAL_SUBJECT',
  });
});

test('N1: with exactly two staff, recovery can’t go to the other one’s mailbox, even alone', async () => {
  const requester = await person();
  const only = await person();
  const userId = await ownerOf();
  await q(
    `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
    [userId, `page.${randomUUID().slice(0, 6)}@example.com`],
  );
  await q(`DELETE FROM email_recoveries WHERE user_id = $1`, [userId]);
  await assert.rejects(
    ask(requester, 'email_recovery.start', {
      userId,
      newEmail: people.get(only).email.replace('@', '+x@'),
      checks: 'Matched their last three tips',
    }),
    { code: 'APPROVAL_SUBJECT' },
  );
  assert.equal(
    (await q(`SELECT 1 FROM email_recoveries WHERE user_id = $1`, [userId]))
      .length,
    0,
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length,
    0,
  );
});

test('I7: the provider now answering differently from what was asked stops it, and books nothing', async () => {
  const requester = await person();
  const second = await person();
  const { issueId, payoutId } = await unresolvedPayoutIssue();
  const asked = await ask(
    requester,
    'payout.settle',
    { issueId, how: 'apply', reported: 'paid' },
    { services: scripted(() => FOUND('paid')) },
  );
  const outcome = await approveWith(
    asked.requestId,
    second,
    scripted(() => FOUND('failed')),
  );
  assert.equal(outcome.status, 'stale');
  assert.equal(await statusOf(payoutId), 'REQUESTED');
  await noFalseSuccess(asked.requestId);
});

test('N2, N6: a reference racing in keeps a conflict for a person, on both paths, in neutral words', async () => {
  const requester = await person();
  const second = await person();
  const conflicts = (payoutId) =>
    q(
      `SELECT 1 FROM issues WHERE kind = 'payout_conflict' AND subject->>'payoutId' = $1`,
      [payoutId],
    );
  const racing = (payoutId) =>
    scripted(async () => {
      await q(`UPDATE payouts SET provider_reference = $2 WHERE id = $1`, [
        payoutId,
        `someone_else_${randomUUID()}`,
      ]);
      return FOUND('paid');
    });
  const waited = await unresolvedPayoutIssue();
  const asked = await ask(
    requester,
    'payout.settle',
    { issueId: waited.issueId, how: 'apply', reported: 'paid' },
    { services: scripted(() => FOUND('paid')) },
  );
  assert.equal(
    (await approveWith(asked.requestId, second, racing(waited.payoutId)))
      .status,
    'stale',
  );
  assert.equal((await conflicts(waited.payoutId)).length, 1);

  await q(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [second]);
  const alone = await unresolvedPayoutIssue();
  await assert.rejects(
    ask(
      requester,
      'payout.settle',
      { issueId: alone.issueId, how: 'apply', reported: 'paid' },
      { services: racing(alone.payoutId) },
    ),
    { code: 'PAYOUT_CHANGED' },
  );
  assert.equal((await conflicts(alone.payoutId)).length, 1);
});

test('I5: new staff, removals and role changes each queue an alert, by id and name only', async () => {
  const actor = await person();
  const alerts = async () =>
    (
      await q(
        `SELECT payload FROM outbox_events WHERE event_type = 'ops.staff_changed' ORDER BY created_at, id`,
      )
    ).map((row) => row.payload.action);
  const email = `alert.${randomUUID().slice(0, 6)}@example.com`;
  const roleId = await roleWith([HARMLESS]);
  const added = await ops.addStaff(database.db, {
    actorId: actor,
    email,
    roleId,
    reason: REASON,
    sealing,
  });
  const target = await person({ roleId });
  await ops.changeRole(database.db, {
    actorId: actor,
    userId: target,
    roleId: await roleWith(['analytics.view']),
    reason: REASON,
  });
  await ops.setPersonalAccess(database.db, {
    actorId: actor,
    userId: target,
    additions: [HARMLESS],
    removals: [],
    reason: REASON,
  });
  await ops.updateRole(database.db, {
    actorId: actor,
    roleId,
    description: 'New words',
    reason: REASON,
  });
  await ops.removeStaff(database.db, {
    actorId: actor,
    userId: added.userId,
    reason: REASON,
    sealing,
  });
  assert.deepEqual((await alerts()).sort(), [
    'access_changed',
    'added',
    'removed',
    'role_changed',
    'role_updated',
  ]);
  const raw = JSON.stringify(
    await q(
      `SELECT payload FROM outbox_events WHERE event_type = 'ops.staff_changed'`,
    ),
  );
  assert.ok(!raw.includes(email), 'no address in an alert');
  const [{ payload: moved }] = await q(
    `SELECT payload FROM outbox_events WHERE event_type = 'ops.staff_changed' AND payload->>'action' = 'role_changed'`,
  );
  assert.equal(moved.targetId, target);
  assert.ok(moved.roleName, 'names the role');
});

test('I5, M4: each alert event reaches the webhook, and an unset route logs under its own name', async () => {
  const requester = await person();
  const context = (name) => {
    const posted = [];
    return {
      posted,
      deps: {
        db: database.db,
        logger: { info() {}, warn() {} },
        dedupeKey: `${name}.${randomUUID()}`,
        sealing,
        pretendPayment: true,
        postStaffAlert: async (alert) => posted.push(alert),
      },
    };
  };
  for (const [name, data, action] of [
    [
      'ops.acted_alone',
      { action: 'fee.change', requestedBy: requester },
      'fee.change',
    ],
    [
      'ops.approval_ran',
      { action: 'fee.free', requestedBy: requester, requestId: randomUUID() },
      'fee.free',
    ],
    [
      'ops.freeze_released',
      { action: 'freeze_released', requestedBy: requester },
      'freeze_released',
    ],
    [
      'ops.approval_closed',
      {
        action: 'fee.free',
        requestedBy: requester,
        requestId: randomUUID(),
        outcome: 'rejected',
      },
      'fee.free: rejected',
    ],
    [
      'ops.approval_closed',
      {
        action: 'fee.free',
        requestedBy: requester,
        requestId: randomUUID(),
        outcome: 'stale',
      },
      'fee.free: stale',
    ],
    [
      'ops.approval_closed',
      {
        action: 'fee.free',
        requestedBy: requester,
        requestId: randomUUID(),
        outcome: 'expired',
      },
      'fee.free: expired',
    ],
    ['ops.staff_changed', { action: 'added', requestedBy: requester }, 'added'],
  ]) {
    const { posted, deps } = context(name);
    await handleDomainEvent(name, data, deps);
    assert.equal(posted.length, 1, name);
    assert.equal(posted[0].action, action);
    assert.equal(posted[0].event, name);
  }
  const logs = [];
  await staffAlertPoster({
    url: undefined,
    log: (entry) => logs.push(entry.event),
  })({
    event: 'ops.acted_alone',
    action: 'fee.change',
    requestedBy: requester,
  });
  assert.ok(logs.includes('staff_alert.unrouted'), logs.join());
  const posted = [];
  await handleDomainEvent(
    'ops.staff_changed',
    {
      action: 'role_changed',
      requestedBy: requester,
      targetId: 'the-target',
      roleName: 'Finance',
    },
    { ...context('x').deps, postStaffAlert: async (a) => posted.push(a) },
  );
  assert.match(posted[0].action, /role_changed/);
  assert.match(posted[0].action, /the-target/);
  assert.match(posted[0].action, /Finance/);
  assert.ok(!logs.includes('reserve.alert_unrouted'));
});

test('I5: a quiet close still posts, without mailing the person who already knows', async () => {
  const a = await person();
  const b = await person();
  const asked = await ask(a, 'fee.change', {
    profileId: await profileId(),
    feeBps: 909,
  });
  await ops.cancelRequest(database.db, {
    requestId: asked.requestId,
    actorId: a,
  });
  const asked2 = await ask(a, 'fee.change', {
    profileId: await profileId(),
    feeBps: 910,
  });
  await ops.removeStaff(database.db, {
    actorId: b,
    userId: a,
    reason: REASON,
    sealing,
  });
  const [closed] = await q(
    `SELECT payload FROM outbox_events WHERE event_type = 'ops.approval_closed' AND aggregate_id = $1`,
    [asked2.requestId],
  );
  assert.equal(closed.payload.outcome, 'stale');
  assert.equal(closed.payload.quiet, 'yes');
  const posted = [];
  await handleDomainEvent('ops.approval_closed', closed.payload, {
    db: database.db,
    logger: { info() {}, warn() {} },
    dedupeKey: `ops.approval_closed.${randomUUID()}`,
    sealing,
    pretendPayment: true,
    postStaffAlert: async (alert) => posted.push(alert),
  });
  assert.equal(posted.length, 1);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM mail_messages WHERE type = 'staff_approval_outcome' AND user_id = $1`,
        [a],
      )
    ).length,
    0,
  );
});

test('M4: a process that loaded only the worker has the real actions registered', async () => {
  const script = `
    const { startJobWorker } = await import(${JSON.stringify(new URL('../../apps/worker/dist/job-worker.js', import.meta.url).href)});
    const { loadWorkerConfig } = await import(${JSON.stringify(new URL('../../apps/worker/dist/config.js', import.meta.url).href)});
    const db = await import(${JSON.stringify(new URL('../../packages/database/dist/index.js', import.meta.url).href)});
    const worker = await startJobWorker(loadWorkerConfig({
      NODE_ENV: 'test',
      REDIS_URL: ${JSON.stringify(REDIS_URL)},
      QUEUE_PREFIX: 'worker-only-' + process.pid,
      LOG_LEVEL: 'error',
      MAIL_SEAL_KEY: ${JSON.stringify(MAIL_SEAL_KEY)},
      DATABASE_URL: ${JSON.stringify(database.url)},
      MOCK_PROVIDER_WEBHOOK_SECRET: ${JSON.stringify(WEBHOOK_SECRET)},
    }));
    let already = false;
    try {
      db.registerSeriousAction({ name: 'fee.change', permission: 'fees.manage', validate: async () => {}, describe: async () => 'x', run: async () => {} });
    } catch (error) { already = /already registered/.test(error.message); }
    await worker.close();
    console.log(already ? 'REGISTERED' : 'NOT_REGISTERED');
    process.exit(0);
  `;
  const output = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      { timeout: 60_000 },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : resolve(stdout),
    ),
  );
  assert.match(output, /\bREGISTERED\b/);
  assert.doesNotMatch(output, /NOT_REGISTERED/);
});

test('N4: the server command and a declined invitation say what they are', async () => {
  const phone = `+23480999${String(++seq).padStart(5, '0')}`;
  await ops.grantOwner(database.db, { phone });
  const [granted] = await q(
    `SELECT payload FROM outbox_events WHERE event_type = 'ops.staff_changed' ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  assert.equal(granted.payload.action, 'granted_from_server');
  assert.equal(granted.payload.requestedBy, 'server command');
  assert.equal(granted.payload.roleName, 'Owner');

  const actor = await person();
  const invited = await ops.addStaff(database.db, {
    actorId: actor,
    email: `decline.${randomUUID().slice(0, 6)}@example.com`,
    roleId: await roleWith([HARMLESS]),
    reason: REASON,
    sealing,
  });
  await ops.declineInvitation(database.db, { userId: invited.userId, sealing });
  const rows = await q(
    `SELECT payload FROM outbox_events WHERE event_type = 'ops.staff_changed' AND payload->>'action' = 'invitation_declined'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.targetId, invited.userId);
});

/* What the approver reads: what would really change, not what was typed. */

const summaryOf = async (outcome) => (await rowOf(outcome.requestId)).summary;
const removePersonally = (userId, permission, by) =>
  q(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by) VALUES ($1, $2, 'remove', $3)`,
    [userId, permission, by],
  );

test('re-ticking a removed permission names it as gained, never "none"', async () => {
  const requester = await person();
  await person();
  const userId = await person({
    roleId: await roleWith([SENSITIVE, HARMLESS]),
  });
  await removePersonally(userId, SENSITIVE, requester);
  const words = await summaryOf(
    await ops.setPersonalAccessOrAsk(database.db, {
      ...asking(requester),
      userId,
      additions: [],
      removals: [],
    }),
  );
  assert.match(words, new RegExp(`gains ${SENSITIVE}`));
  assert.doesNotMatch(words, /none|loses/);
});

test('one change named beside a cleared removal names both; a stored addition is not new', async () => {
  const requester = await person();
  await person();
  const userId = await person({ roleId: await roleWith([SENSITIVE]) });
  await removePersonally(userId, SENSITIVE, requester);
  await q(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by) VALUES ($1, $2, 'add', $3)`,
    [userId, HARMLESS, requester],
  );
  const words = await summaryOf(
    await ops.setPersonalAccessOrAsk(database.db, {
      ...asking(requester),
      userId,
      additions: [HARMLESS, 'analytics.view'],
      removals: [],
    }),
  );
  assert.match(words, /gains analytics\.view, fees\.manage/);
  assert.doesNotMatch(words, new RegExp(HARMLESS.replace('.', '\\.')));
});

test('a gain and a loss in one change are both named', async () => {
  const requester = await person();
  await person();
  const userId = await person({ roleId: await roleWith([HARMLESS]) });
  const words = await summaryOf(
    await ops.setPersonalAccessOrAsk(database.db, {
      ...asking(requester),
      userId,
      additions: [SENSITIVE],
      removals: [HARMLESS],
    }),
  );
  assert.match(words, /gains fees\.manage; loses search\.view/);
});

test('moving someone to a role names what they gain and lose, through their own adjustments', async () => {
  const requester = await person();
  await person();
  const userId = await person({ roleId: await roleWith([HARMLESS]) });
  const next = await roleWith([SENSITIVE, 'audit.view']);
  await removePersonally(userId, 'audit.view', requester);
  const words = await summaryOf(
    await ops.changeRoleOrAsk(database.db, {
      ...asking(requester),
      userId,
      roleId: next,
    }),
  );
  assert.match(words, /gains fees\.manage; loses search\.view/);
  assert.doesNotMatch(words, /audit\.view/);
});

test('adding someone names everything the role gives them', async () => {
  const requester = await person();
  await person();
  const role = await roleWith([SENSITIVE, HARMLESS]);
  const words = await summaryOf(
    await ops.addStaffOrAsk(database.db, {
      ...asking(requester),
      email: `added.${randomUUID().slice(0, 6)}@example.com`,
      roleId: role,
    }),
  );
  assert.match(words, /which holds fees\.manage, search\.view/);
});

test('M1: a role edit with a new name still asks, and the approver reads the name', async () => {
  const requester = await person();
  const second = await person();
  const roleId = await roleWith([HARMLESS]);
  const name = `Renamed ${randomUUID().slice(0, 6)}`;
  const outcome = await ops.updateRoleOrAsk(database.db, {
    ...asking(requester),
    roleId,
    name,
    description: 'Now reads the fees',
    permissions: [HARMLESS, SENSITIVE],
  });
  assert.equal(outcome.state, 'pending');
  const row = await rowOf(outcome.requestId);
  assert.equal(row.action, 'role.add_sensitive');
  assert.match(row.summary, /add fees\.manage/);
  assert.match(row.summary, new RegExp(`rename it to "${name}"`));
  assert.match(row.summary, /Now reads the fees/);
  assert.equal((await approve(outcome.requestId, second)).status, 'approved');
  const [role] = await q(`SELECT name FROM roles WHERE id = $1`, [roleId]);
  assert.equal(role.name, name);
});

test('M7: a closed request keeps no address in the clear, however it closed', async () => {
  const plain = /[a-z0-9.]{4,}@example\.com/;
  const addressed = async (requester) =>
    ask(requester, 'staff.grant_sensitive', {
      kind: 'add',
      email: `invited.${randomUUID().slice(0, 6)}@example.com`,
      roleId: await roleWith([SENSITIVE]),
    });
  const requester = await person();
  const second = await person();

  const waiting = await addressed(requester);
  assert.match(JSON.stringify((await rowOf(waiting.requestId)).payload), plain);

  const closings = [
    [waiting, (id) => approve(id, second), 'approved'],
    [
      await addressed(requester),
      (id) =>
        ops.rejectRequest(database.db, {
          requestId: id,
          actorId: second,
          grantId: people.get(second).grantId,
          reason: REASON,
        }),
      'rejected',
    ],
    [
      await addressed(requester),
      (id) =>
        ops.cancelRequest(database.db, {
          requestId: id,
          actorId: requester,
          reason: REASON,
        }),
      'cancelled',
    ],
    [
      await addressed(requester),
      async (id) => {
        await q(
          `UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`,
          [id],
        );
        await ops.expireRequests(database.db, { now: new Date() });
      },
      'expired',
    ],
  ];
  for (const [asked, close, status] of closings) {
    await close(asked.requestId);
    const row = await rowOf(asked.requestId);
    assert.equal(row.status, status);
    assert.doesNotMatch(JSON.stringify(row.payload), plain, status);
    assert.match(row.payload.email, /•/, status);
  }

  const recovery = await ask(requester, 'email_recovery.start', {
    userId: await ownerOf(),
    newEmail: `moved.${randomUUID().slice(0, 6)}@example.com`,
    checks: 'Selfie and a call',
  });
  // The same approver within one 30-second code: this isn't about reusing codes.
  await q(`UPDATE staff_totp SET last_step = NULL WHERE user_id = $1`, [
    second,
  ]);
  assert.equal((await approve(recovery.requestId, second)).status, 'approved');
  assert.doesNotMatch(
    JSON.stringify((await rowOf(recovery.requestId)).payload),
    plain,
  );
});
