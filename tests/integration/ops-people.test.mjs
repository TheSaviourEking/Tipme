import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
// A namespace, so one missing export fails its own test and not the whole file.
import * as ops from '../../packages/database/dist/index.js';
import {
  MAIL_SEAL_KEY,
  WEB,
  browserHeaders,
  opsSignIn,
  startStack,
  totpClock,
  uniquePrefix,
} from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const REASON = 'Agreed with the owner in the weekly review';
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const LINK = /\/ops\?ml=[a-z_-]+#enrol=([A-Z2-7]{10})/;

let database;
let stack;
let owner;
let ownerId;
let auditRole;
let phone = 8100;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348036668000');
  ownerId = (
    await rows(`SELECT id FROM users WHERE phone_e164 = $1`, ['+2348036668000'])
  )[0].id;
  auditRole = await ops.createRole(database.db, {
    actorId: ownerId,
    name: 'Auditors',
    description: '',
    permissions: ['audit.view'],
    reason: REASON,
  });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

async function rows(text, values = []) {
  return (await database.pool.query(text, values)).rows;
}
const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const errorCode = async (response) => (await response.json()).error?.code;
const refusedWith = (code) => (error) => {
  assert.equal(error.code, code);
  return true;
};
const newEmail = () => `a@${uniquePrefix()}.example`;
const lastAudit = async (action, subjectId) =>
  (
    await rows(
      `SELECT * FROM audit_events WHERE action = $1 AND subject_id = $2 ORDER BY seq DESC LIMIT 1`,
      [action, subjectId],
    )
  )[0];
const changeIn = (reason) =>
  JSON.parse(reason.slice(reason.indexOf('[change: ') + 9, -1));

/** A second owner, for tests that need one; signed in by nobody. */
const anotherOwner = async () =>
  (await ops.grantOwner(database.db, { email: newEmail() })).userId;

/** Someone on a fresh role holding staff.manage plus `permissions`. */
async function manager(permissions = []) {
  const role = await ops.createRole(database.db, {
    actorId: ownerId,
    name: `Managers ${uniquePrefix()}`,
    description: '',
    permissions: ['staff.manage', ...permissions],
    reason: REASON,
  });
  const { userId } = await ops.addStaff(database.db, {
    actorId: ownerId,
    email: newEmail(),
    roleId: role.id,
    reason: REASON,
    sealing,
  });
  return userId;
}

const person = async (roleId = auditRole.id, email = newEmail()) => ({
  email,
  ...(await ops.addStaff(database.db, {
    actorId: ownerId,
    email,
    roleId,
    reason: REASON,
    sealing,
  })),
});

/** Runs `fn` with `userId` the only active owner, then puts the others back. */
async function asSoleOwner(userId, fn) {
  const others = await rows(
    `UPDATE staff SET revoked_at = now()
       WHERE role_id = 'owner' AND revoked_at IS NULL AND user_id <> $1
       RETURNING user_id`,
    [userId],
  );
  try {
    await fn();
  } finally {
    for (const { user_id } of others)
      await rows(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [
        user_id,
      ]);
  }
}

async function inboxMail(email, subject) {
  const [local, domain] = email.split('@');
  const hint = `${local[0]}•••@${domain}`;
  for (let i = 0; i < 150; i++) {
    const { data } = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
    const mail = data.find(
      (m) => m.to === hint && m.subject?.includes(subject),
    );
    if (mail) return mail;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no "${subject}" email arrived`);
}

async function emailSignIn(email) {
  assert.equal(
    (await call('POST', '/v1/auth/code', undefined, { email })).status,
    202,
  );
  const mail = await inboxMail(email, 'sign-in code');
  const verify = await call('POST', '/v1/auth/verify', undefined, {
    email,
    code: /\b(\d{6})\b/.exec(mail.body)[1],
  });
  assert.equal(verify.status, 200);
  return {
    cookie: verify.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
    userId: (await verify.json()).data.userId,
  };
}

async function enrol(cookie, enrolmentCode) {
  const started = await call('POST', '/v1/ops/enrol', cookie, {
    enrolmentCode,
  });
  assert.equal(started.status, 200);
  const nextCode = totpClock((await started.json()).data.secret);
  const confirm = await call('POST', '/v1/ops/enrol/confirm', cookie, {
    code: await nextCode(),
  });
  assert.equal(confirm.status, 200);
  const ops_ = confirm.headers
    .getSetCookie()
    .find((c) => c.startsWith('tipme_ops='))
    .split(';')[0];
  return { cookie: `${cookie}; ${ops_}`, nextCode };
}

/** A person added over HTTP who has signed in and enrolled from their email. */
async function enrolled(roleId = auditRole.id) {
  const email = newEmail();
  const added = await call('POST', '/v1/ops/staff', owner.cookie, {
    email,
    roleId,
    reason: REASON,
  });
  assert.equal(added.status, 201);
  const mail = await inboxMail(email, 'admin');
  const session = await emailSignIn(email);
  const grant = await enrol(session.cookie, LINK.exec(mail.body)[1]);
  return { email, userId: session.userId, ...grant };
}

test('normaliseStaffEmail: one mailbox, one answer', () => {
  for (const [given, wanted] of [
    ['Name@Example.COM', 'name@example.com'],
    ['name+tag@example.com', 'name@example.com'],
    ['n.a.m.e@example.com', 'n.a.m.e@example.com'],
    ['name+tag@gmail.com', 'name@gmail.com'],
    ['n.a.m.e@gmail.com', 'name@gmail.com'],
    ['N.A.M.E+x+y@GMAIL.com', 'name@gmail.com'],
    // The same mailbox under Google's other domain.
    ['n.a.m.e@googlemail.com', 'name@gmail.com'],
    ['  name@gmail.com. ', 'name@gmail.com'],
  ])
    assert.equal(ops.normaliseStaffEmail(given), wanted, given);
});

test('adding a person emails an enrolment link, and they reach /ops only after enrolling', async () => {
  const email = newEmail();
  const added = await call('POST', '/v1/ops/staff', owner.cookie, {
    email,
    roleId: auditRole.id,
    reason: REASON,
  });
  assert.equal(added.status, 201);
  const body = JSON.stringify(await added.json());

  const mail = await inboxMail(email, 'admin');
  const code = LINK.exec(mail.body)?.[1];
  assert.ok(code, 'the email holds the link');
  assert.ok(!body.includes(code), 'the code is only in the email');
  assert.doesNotMatch(mail.body + mail.subject, /bachs|zeptomail|\bses\b/i);
  // The link is the only secret: nothing else in it looks like a code.
  assert.equal(mail.body.split(code).length - 1, 1);

  const [row] = await rows(
    `SELECT e.code_sha256, e.expires_at, e.user_id FROM staff_enrolments e
       JOIN users u ON u.id = e.user_id WHERE u.email = $1`,
    [email],
  );
  assert.equal(
    row.code_sha256,
    createHash('sha256').update(code).digest('hex'),
  );
  const minutes = (row.expires_at.getTime() - Date.now()) / 60_000;
  assert.ok(minutes > 29 && minutes <= 30, `${minutes} minutes`);
  const audit = await lastAudit('staff.added', row.user_id);
  assert.equal(audit.staff_user_id, ownerId);
  assert.ok(!audit.reason.includes(code));
  const change = changeIn(audit.reason);
  assert.equal(change.role.id, auditRole.id);
  assert.deepEqual(change.permissions, ['audit.view']);
  assert.ok(!audit.reason.includes(email), 'the log holds a masked address');

  // Signed in, but no authenticator yet: asked to enrol, and nothing else opens.
  const session = await emailSignIn(email);
  assert.equal(session.userId, row.user_id);
  const me = await call('GET', '/v1/ops/me', session.cookie);
  assert.deepEqual((await me.json()).data, { state: 'needs_enrolment' });
  assert.equal(
    (await call('GET', '/v1/ops/audit', session.cookie)).status,
    404,
  );

  const grant = await enrol(session.cookie, code);
  assert.equal((await call('GET', '/v1/ops/audit', grant.cookie)).status, 200);
  // Only what the role holds.
  assert.equal((await call('GET', '/v1/ops/staff', grant.cookie)).status, 403);
  // One-time.
  const again = await call('POST', '/v1/ops/enrol', session.cookie, {
    enrolmentCode: code,
  });
  assert.equal(await errorCode(again), 'ENROLMENT_INVALID');
});

test('the invitation is redacted in the stored snapshot and does not outlive its code', async () => {
  const { MAIL_TYPES } = await import('../../packages/mail/dist/index.js');
  const type = MAIL_TYPES.staff_invitation;
  assert.equal(type.category, 'security');
  assert.equal(type.tracking, false);
  const ctx = { webOrigin: WEB, unsubscribeUrl: null };
  const data = { code: 'ABCDEFGH23', kind: 'invited' };
  assert.match(type.render(data, ctx).text, /ABCDEFGH23/);
  const snapshot = type.render(data, { ...ctx, redact: true });
  assert.doesNotMatch(snapshot.text + snapshot.html, /ABCDEFGH23/);

  const { userId } = await person();
  const [message] = await rows(
    `SELECT expires_at, dedupe_key, data_sealed FROM mail_messages
       WHERE user_id = $1 AND type = 'staff_invitation'`,
    [userId],
  );
  const [enrolment] = await rows(
    `SELECT expires_at FROM staff_enrolments WHERE user_id = $1`,
    [userId],
  );
  assert.equal(message.expires_at.getTime(), enrolment.expires_at.getTime());
  assert.doesNotMatch(message.dedupe_key, /[A-Z2-7]{10}/);
});

test('an email already on a recipient account uses that account', async () => {
  const email = newEmail();
  const session = await emailSignIn(email);
  const { userId } = await person(auditRole.id, email);
  assert.equal(userId, session.userId);
  const accounts = await rows(`SELECT id FROM users WHERE email = $1`, [email]);
  assert.equal(accounts.length, 1);
  // Staff access stays a separate step behind the authenticator.
  const me = await call('GET', '/v1/ops/me', session.cookie);
  assert.deepEqual((await me.json()).data, { state: 'needs_enrolment' });
  assert.equal(
    changeIn((await lastAudit('staff.added', userId)).reason).account,
    'existing',
  );
});

test('an address only claimed on an account, never proven, does not hand that account staff access', async () => {
  const email = newEmail();
  const [claimant] = await rows(
    `INSERT INTO users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [email],
  );
  const { userId } = await person(auditRole.id, email);
  assert.notEqual(userId, claimant.id);
  assert.equal(await ops.staffRole(database.db, claimant.id), null);
});

test('name+tag@gmail.com and n.a.m.e@gmail.com are refused when name@gmail.com is staff', async () => {
  const name = `n${uniquePrefix().replace(/\W/g, '')}`;
  const { userId } = await person(auditRole.id, `${name}@gmail.com`);
  const dotted = `${name[0]}.${name.slice(1)}`;
  const before = await rows(`SELECT count(*)::int AS n FROM users`);
  for (const email of [
    `${name}+tag@gmail.com`,
    `${dotted}@gmail.com`,
    `${dotted}+x@googlemail.com`,
    `${name.toUpperCase()}@GMAIL.COM`,
  ])
    await assert.rejects(
      ops.addStaff(database.db, {
        actorId: ownerId,
        email,
        roleId: auditRole.id,
        reason: REASON,
        sealing,
      }),
      refusedWith('STAFF_EMAIL_TAKEN'),
      email,
    );
  assert.deepEqual(await rows(`SELECT count(*)::int AS n FROM users`), before);

  // Removed staff count too: coming back is a decision for grant-owner, not a fresh invitation.
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  await assert.rejects(
    ops.addStaff(database.db, {
      actorId: ownerId,
      email: `${dotted}@gmail.com`,
      roleId: auditRole.id,
      reason: REASON,
      sealing,
    }),
    refusedWith('STAFF_EMAIL_TAKEN'),
  );
  const over = await call('POST', '/v1/ops/staff', owner.cookie, {
    email: `${name}+again@gmail.com`,
    roleId: auditRole.id,
    reason: REASON,
  });
  assert.equal(over.status, 409);
  assert.equal(await errorCode(over), 'STAFF_EMAIL_TAKEN');
});

test('two adds of the same person at once make one staff member', async () => {
  const name = `n${uniquePrefix().replace(/\W/g, '')}`;
  const results = await Promise.allSettled(
    [`${name}@gmail.com`, `${name}+b@gmail.com`].map((email) =>
      ops.addStaff(database.db, {
        actorId: ownerId,
        email,
        roleId: auditRole.id,
        reason: REASON,
        sealing,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((r) => r.status === 'rejected').reason.code,
    'STAFF_EMAIL_TAKEN',
  );
});

test('removal takes effect on the next request and drops admin sessions', async () => {
  const someone = await enrolled();
  assert.equal(
    (await call('GET', '/v1/ops/audit', someone.cookie)).status,
    200,
  );
  const removed = await call(
    'POST',
    `/v1/ops/staff/${someone.userId}/remove`,
    owner.cookie,
    { reason: REASON },
  );
  assert.equal(removed.status, 200);
  assert.equal(
    (await call('GET', '/v1/ops/audit', someone.cookie)).status,
    404,
  );
  assert.equal((await call('GET', '/v1/ops/me', someone.cookie)).status, 404);

  const [{ open }] = await rows(
    `SELECT count(*)::int AS open FROM ops_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [someone.userId],
  );
  assert.equal(open, 0);
  assert.deepEqual(
    await rows(`SELECT 1 FROM staff_totp WHERE user_id = $1`, [someone.userId]),
    [],
  );
  // The history stays.
  const [row] = await rows(`SELECT revoked_at FROM staff WHERE user_id = $1`, [
    someone.userId,
  ]);
  assert.ok(row.revoked_at);
  const audit = await lastAudit('staff.removed', someone.userId);
  assert.equal(audit.staff_user_id, ownerId);
  const change = changeIn(audit.reason);
  assert.equal(change.role.id, auditRole.id);
  assert.deepEqual(change.losses, ['audit.view']);
  const notices = await rows(
    `SELECT 1 FROM mail_messages WHERE user_id = $1 AND type = 'staff_access_notice'`,
    [someone.userId],
  );
  assert.equal(notices.length, 1);
});

test('a removed person cannot use a code they were sent before removal', async () => {
  const email = newEmail();
  const { userId } = await person(auditRole.id, email);
  const mail = await inboxMail(email, 'admin');
  const session = await emailSignIn(email);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  assert.equal(
    (
      await call('POST', '/v1/ops/enrol', session.cookie, {
        enrolmentCode: LINK.exec(mail.body)[1],
      })
    ).status,
    404,
  );
  const [{ open }] = await rows(
    `SELECT count(*)::int AS open FROM staff_enrolments WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  assert.equal(open, 0);
});

test('removal clears personal adjustments, so a person brought back gets none of them', async () => {
  const roleWithout = await ops.createRole(database.db, {
    actorId: ownerId,
    name: `Plain ${uniquePrefix()}`,
    description: '',
    permissions: ['analytics.view', 'issues.view'],
    reason: REASON,
  });
  const { userId } = await person(roleWithout.id);
  await ops.setPersonalAccess(database.db, {
    actorId: ownerId,
    userId,
    additions: ['audit.view'],
    removals: ['issues.view'],
    reason: REASON,
  });
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  assert.deepEqual(
    await rows(`SELECT 1 FROM staff_permission_overrides WHERE user_id = $1`, [
      userId,
    ]),
    [],
  );
  const change = changeIn((await lastAudit('staff.removed', userId)).reason);
  assert.deepEqual(change.clearedAdditions, ['audit.view']);
  assert.deepEqual(change.clearedRemovals, ['issues.view']);
  // However they return, the role alone decides.
  await rows(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [userId]);
  assert.deepEqual(
    [...(await ops.staffPermissions(database.db, userId))].sort(),
    ['analytics.view', 'issues.view'],
  );
  await rows(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [
    userId,
  ]);
});

test('the last active owner cannot be removed or demoted', async () => {
  const boss = await manager();
  const sole = await anotherOwner();
  await asSoleOwner(sole, async () => {
    // Not their own access, so the self rule does not answer this: the last-owner rule does.
    await assert.rejects(
      ops.removeStaff(database.db, {
        actorId: boss,
        userId: sole,
        reason: REASON,
      }),
      refusedWith('LAST_OWNER'),
    );
    await assert.rejects(
      ops.changeRole(database.db, {
        actorId: boss,
        userId: sole,
        roleId: auditRole.id,
        reason: REASON,
      }),
      refusedWith('LAST_OWNER'),
    );
    await assert.rejects(
      ops.removeStaff(database.db, {
        actorId: sole,
        userId: sole,
        reason: REASON,
      }),
      refusedWith('SELF_ACCESS_CHANGE'),
    );
    assert.equal(await ops.staffRole(database.db, sole), 'owner');
  });
  // With another owner about, the same manager still can't touch an owner.
  await assert.rejects(
    ops.removeStaff(database.db, {
      actorId: boss,
      userId: sole,
      reason: REASON,
    }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
});

test('two owners removing each other at once leave one owner', async () => {
  const [a, b] = [await anotherOwner(), await anotherOwner()];
  await asSoleOwner(a, async () => {
    await rows(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [b]);
    const results = await Promise.allSettled([
      ops.removeStaff(database.db, { actorId: a, userId: b, reason: REASON }),
      ops.removeStaff(database.db, { actorId: b, userId: a, reason: REASON }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      results.find((r) => r.status === 'rejected').reason.code,
      'PERMISSION_NOT_HELD',
    );
    const [{ owners }] = await rows(
      `SELECT count(*)::int AS owners FROM staff WHERE role_id = 'owner' AND revoked_at IS NULL`,
    );
    assert.equal(owners, 1);
  });
});

test('only an owner can create an owner, and nobody hands out what they do not hold', async () => {
  const every = await ops.createRole(database.db, {
    actorId: ownerId,
    name: `Everything ${uniquePrefix()}`,
    description: '',
    permissions: ops.OPS_PERMISSIONS,
    reason: REASON,
  });
  const strong = (await person(every.id)).userId;
  await assert.rejects(
    ops.addStaff(database.db, {
      actorId: strong,
      email: newEmail(),
      roleId: 'owner',
      reason: REASON,
      sealing,
    }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  // Holding every permission is still not being an owner.
  await assert.rejects(
    ops.removeStaff(database.db, {
      actorId: strong,
      userId: await anotherOwner(),
      reason: REASON,
    }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  const made = await person('owner');
  assert.equal(await ops.staffRole(database.db, made.userId), 'owner');
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: made.userId,
    reason: REASON,
  });

  const weak = await manager();
  await assert.rejects(
    ops.addStaff(database.db, {
      actorId: weak,
      email: newEmail(),
      roleId: auditRole.id,
      reason: REASON,
      sealing,
    }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  await assert.rejects(
    ops.removeStaff(database.db, {
      actorId: weak,
      userId: (await person()).userId,
      reason: REASON,
    }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  await assert.rejects(
    ops.addStaff(database.db, {
      actorId: ownerId,
      email: newEmail(),
      roleId: 'release_check',
      reason: REASON,
      sealing,
    }),
    refusedWith('ROLE_PROTECTED'),
  );
  // A manager who holds it all can add and remove within that.
  const able = await manager(['audit.view']);
  const added = await ops.addStaff(database.db, {
    actorId: able,
    email: newEmail(),
    roleId: auditRole.id,
    reason: REASON,
    sealing,
  });
  await ops.removeStaff(database.db, {
    actorId: able,
    userId: added.userId,
    reason: REASON,
  });
  // Someone holding no staff.manage at all.
  await assert.rejects(
    ops.addStaff(database.db, {
      actorId: (await person()).userId,
      email: newEmail(),
      roleId: auditRole.id,
      reason: REASON,
      sealing,
    }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
});

test('the routes take ids from the session and the path', async () => {
  const { userId } = await person();
  const forged = await call('POST', '/v1/ops/staff', owner.cookie, {
    email: newEmail(),
    roleId: auditRole.id,
    reason: REASON,
    actorId: userId,
  });
  assert.equal(forged.status, 400);
  assert.equal(
    (
      await call('POST', `/v1/ops/staff/not-a-uuid/remove`, owner.cookie, {
        reason: REASON,
      })
    ).status,
    404,
  );
  await assert.rejects(
    ops.removeStaff(database.db, {
      actorId: ownerId,
      userId: ownerId.toUpperCase(),
      reason: REASON,
    }),
    refusedWith('SELF_ACCESS_CHANGE'),
  );
  await assert.rejects(
    ops.removeStaff(database.db, {
      actorId: ownerId,
      userId,
      reason: 'Fine [change: {"losses":[]}]',
    }),
    refusedWith('INVALID_INPUT'),
  );
  const someone = await enrolled();
  for (const [method, path, body] of [
    ['GET', '/v1/ops/staff'],
    [
      'POST',
      '/v1/ops/staff',
      { email: newEmail(), roleId: auditRole.id, reason: REASON },
    ],
    ['POST', `/v1/ops/staff/${userId}/remove`, { reason: REASON }],
    ['POST', `/v1/ops/staff/${userId}/reset-authenticator`, { reason: REASON }],
  ])
    assert.equal(
      (await call(method, path, someone.cookie, body)).status,
      403,
      path,
    );
});

test('activeStaffList shows active people with their role and whether they enrolled', async () => {
  const pending = await person();
  const someone = await enrolled();
  const gone = await person();
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: gone.userId,
    reason: REASON,
  });
  const list = await ops.activeStaffList(database.db);
  const find = (id) => list.find((row) => row.userId === id);
  assert.equal(find(gone.userId), undefined);
  assert.equal(find(pending.userId).enrolled, false);
  assert.equal(find(pending.userId).email, pending.email);
  assert.equal(find(pending.userId).roleName, 'Auditors');
  assert.equal(find(someone.userId).enrolled, true);
  assert.equal(find(ownerId).roleId, 'owner');
  const over = await call('GET', '/v1/ops/staff', owner.cookie);
  assert.equal(over.status, 200);
  assert.ok(
    (await over.json()).data.some((row) => row.userId === pending.userId),
  );
});

test('grant-owner restores a removed account and is logged', async () => {
  const email = newEmail();
  const { userId } = await person(auditRole.id, email);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  const session = await emailSignIn(email);
  assert.equal((await call('GET', '/v1/ops/me', session.cookie)).status, 404);

  const { userId: same, enrolmentCode } = await ops.grantOwner(database.db, {
    email,
  });
  assert.equal(same, userId);
  const me = await call('GET', '/v1/ops/me', session.cookie);
  assert.deepEqual((await me.json()).data, { state: 'needs_enrolment' });
  const audit = await lastAudit('staff.owner_granted', userId);
  assert.equal(audit.staff_user_id, null);
  const change = changeIn(audit.reason);
  assert.equal(change.restored, true);
  assert.equal(change.from, auditRole.id);
  assert.equal(change.to, 'owner');
  assert.ok(!audit.reason.includes(enrolmentCode));
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
});

test('grant-owner --role release_check refuses the last owner and clears adjustments', async () => {
  const email = newEmail();
  const sole = (await ops.grantOwner(database.db, { email })).userId;
  await asSoleOwner(sole, async () => {
    await assert.rejects(
      ops.grantOwner(database.db, { email, role: 'release_check' }),
      refusedWith('LAST_OWNER'),
    );
    assert.equal(await ops.staffRole(database.db, sole), 'owner');
  });
  // With another owner present the same command works.
  await ops.grantOwner(database.db, { email, role: 'release_check' });
  assert.equal(await ops.staffRole(database.db, sole), 'release_check');

  const adjusted = await person();
  await ops.setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: adjusted.userId,
    additions: ['analytics.view'],
    removals: [],
    reason: REASON,
  });
  await ops.grantOwner(database.db, {
    email: adjusted.email,
    role: 'release_check',
  });
  assert.deepEqual(
    await rows(`SELECT 1 FROM staff_permission_overrides WHERE user_id = $1`, [
      adjusted.userId,
    ]),
    [],
  );
  const change = changeIn(
    (await lastAudit('staff.release_check_granted', adjusted.userId)).reason,
  );
  assert.deepEqual(change.clearedAdditions, ['analytics.view']);
});

test('a role only removed people held explains why it cannot be deleted', async () => {
  const role = await ops.createRole(database.db, {
    actorId: ownerId,
    name: `Former ${uniquePrefix()}`,
    description: '',
    permissions: ['audit.view'],
    reason: REASON,
  });
  const { userId } = await person(role.id);
  await assert.rejects(
    ops.deleteRole(database.db, {
      actorId: ownerId,
      roleId: role.id,
      reason: REASON,
    }),
    refusedWith('ROLE_IN_USE'),
  );
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  const refused = await call(
    'POST',
    `/v1/ops/staff/roles/${role.id}/delete`,
    owner.cookie,
    {
      reason: REASON,
    },
  );
  assert.equal(refused.status, 409);
  const { error } = await refused.json();
  assert.equal(error.code, 'ROLE_HAS_FORMER_HOLDERS');
  assert.match(error.message, /removed/);
  // Its name and permissions are still free to change.
  await ops.updateRole(database.db, {
    actorId: ownerId,
    roleId: role.id,
    permissions: [],
    reason: REASON,
  });
});

test('resetting an authenticator ends access until the person enrols from a new link', async () => {
  const someone = await enrolled();
  const firstCode = LINK.exec(
    (await inboxMail(someone.email, 'admin')).body,
  )[1];
  const reset = await call(
    'POST',
    `/v1/ops/staff/${someone.userId}/reset-authenticator`,
    owner.cookie,
    { reason: REASON },
  );
  assert.equal(reset.status, 200);
  assert.ok(!JSON.stringify(await reset.json()).match(/[A-Z2-7]{10}/));
  assert.equal(
    (await call('GET', '/v1/ops/audit', someone.cookie)).status,
    404,
  );
  const me = await call('GET', '/v1/ops/me', someone.cookie);
  assert.deepEqual((await me.json()).data, { state: 'needs_enrolment' });
  const audit = await lastAudit('staff.authenticator_reset', someone.userId);
  assert.equal(audit.staff_user_id, ownerId);
  assert.equal(changeIn(audit.reason).authenticatorRemoved, true);

  const mail = await inboxMail(someone.email, 'authenticator');
  const code = LINK.exec(mail.body)[1];
  assert.notEqual(code, firstCode);
  const session = someone.cookie.split('; ')[0];
  const grant = await enrol(session, code);
  assert.equal((await call('GET', '/v1/ops/audit', grant.cookie)).status, 200);
});

test('only an owner resets an authenticator, never their own, and never without somewhere to send the link', async () => {
  const target = await person();
  await assert.rejects(
    ops.resetAuthenticator(database.db, {
      actorId: await manager(['audit.view']),
      userId: target.userId,
      reason: REASON,
      sealing,
    }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  await assert.rejects(
    ops.resetAuthenticator(database.db, {
      actorId: ownerId,
      userId: ownerId,
      reason: REASON,
      sealing,
    }),
    refusedWith('SELF_ACCESS_CHANGE'),
  );
  // A phone-only account would be locked out with no link to enrol from.
  const phoneOnly = (
    await ops.grantOwner(database.db, { phone: `+234803666${phone++}` })
  ).userId;
  await assert.rejects(
    ops.resetAuthenticator(database.db, {
      actorId: ownerId,
      userId: phoneOnly,
      reason: REASON,
      sealing,
    }),
    refusedWith('STAFF_NO_EMAIL'),
  );
  const [{ open }] = await rows(
    `SELECT count(*)::int AS open FROM staff_enrolments WHERE user_id = $1 AND used_at IS NULL`,
    [phoneOnly],
  );
  assert.equal(open, 1, 'the refused reset changed nothing');
});
