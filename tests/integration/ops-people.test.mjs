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
  OPS_TOTP_KEY,
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

const TOTP_KEY = Buffer.from(OPS_TOTP_KEY, 'base64');

/** The data of the newest email of this type to this person, as the mail worker would open it. */
async function sealedMail(userId, type) {
  const [row] = await rows(
    `SELECT data_sealed, to_hint FROM mail_messages WHERE user_id = $1 AND type = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId, type],
  );
  return {
    toHint: row.to_hint,
    ...JSON.parse(ops.openSecret(sealing.key, row.data_sealed)),
  };
}

/** Sets up an authenticator the way /ops does, from an enrolment code. */
async function confirmAuthenticator(userId, enrolmentCode) {
  const { secret } = await ops.startTotpEnrolment(database.db, {
    userId,
    enrolmentCode,
    key: TOTP_KEY,
  });
  const { status } = await ops.confirmTotpEnrolment(database.db, {
    userId,
    code: await totpClock(secret)(),
    key: TOTP_KEY,
  });
  assert.equal(status, 'ok');
}

/** A second owner who has enrolled; signed in by nobody. */
async function anotherOwner(email = newEmail()) {
  const { userId, enrolmentCode } = await ops.grantOwner(database.db, {
    email,
  });
  await confirmAuthenticator(userId, enrolmentCode);
  return userId;
}

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
  await confirmAuthenticator(
    userId,
    (await sealedMail(userId, 'staff_invitation')).code,
  );
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
  assert.deepEqual((await me.json()).data, {
    state: 'needs_enrolment',
    canDecline: true,
  });
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
  assert.deepEqual((await me.json()).data, {
    state: 'needs_enrolment',
    canDecline: true,
  });
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

  // A removed person's variant is refused too: only their exact address brings them back.
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
  await confirmAuthenticator(
    strong,
    (await sealedMail(strong, 'staff_invitation')).code,
  );
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
  assert.deepEqual((await me.json()).data, {
    state: 'needs_enrolment',
    canDecline: true,
  });
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
  assert.deepEqual((await me.json()).data, {
    state: 'needs_enrolment',
    canDecline: false,
  });
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

const attempt = (promise) =>
  promise.then(
    () => 'ok',
    (error) => error.code,
  );

test('a stolen recipient session cannot move a staff account: the whole chain', async () => {
  const victim = await enrolled('owner');
  const attacker = newEmail();
  const [before] = await rows(
    `SELECT u.email, s.role_id, s.revoked_at, t.confirmed_at FROM users u
       JOIN staff s ON s.user_id = u.id JOIN staff_totp t ON t.user_id = u.id WHERE u.id = $1`,
    [victim.userId],
  );
  // Only the recipient session: the attacker has no authenticator and no mailbox.
  const stolen = victim.cookie.split('; ')[0];
  const asked = await call('POST', '/v1/me/email/code', stolen, {
    email: attacker,
  });
  assert.equal(asked.status, 409);
  const body = await asked.json();
  assert.equal(body.error.code, 'STAFF_EMAIL_LOCKED');
  assert.match(body.error.message, /owner/i);
  const moved = await call('POST', '/v1/me/email/confirm', stolen, {
    email: attacker,
    code: '123456',
  });
  assert.equal(moved.status, 409);
  assert.equal(await errorCode(moved), 'STAFF_EMAIL_LOCKED');

  const [after] = await rows(
    `SELECT u.email, s.role_id, s.revoked_at, t.confirmed_at FROM users u
       JOIN staff s ON s.user_id = u.id JOIN staff_totp t ON t.user_id = u.id WHERE u.id = $1`,
    [victim.userId],
  );
  assert.deepEqual(after, before);
  assert.equal((await call('GET', '/v1/ops/audit', victim.cookie)).status, 200);
  // A reset still goes to the real person.
  await ops.resetAuthenticator(database.db, {
    actorId: ownerId,
    userId: victim.userId,
    reason: REASON,
    sealing,
  });
  const { toHint } = await sealedMail(victim.userId, 'staff_invitation');
  assert.equal(toHint, `a•••@${victim.email.split('@')[1]}`);
});

test('a change code from before someone became staff cannot move them afterwards', async () => {
  const email = newEmail();
  const attacker = newEmail();
  const session = await emailSignIn(email);
  assert.equal(
    (
      await call('POST', '/v1/me/email/code', session.cookie, {
        email: attacker,
      })
    ).status,
    202,
  );
  const mail = await inboxMail(attacker, '');
  await person(auditRole.id, email);
  const moved = await call('POST', '/v1/me/email/confirm', session.cookie, {
    email: attacker,
    code: /\b(\d{6})\b/.exec(mail.body)[1],
  });
  assert.equal(moved.status, 409);
  assert.equal(await errorCode(moved), 'STAFF_EMAIL_LOCKED');
  const [{ email: kept }] = await rows(
    `SELECT email FROM users WHERE id = $1`,
    [session.userId],
  );
  assert.equal(kept, email);
});

test('a confirmation link from before someone became staff cannot move them either', async () => {
  for (const confirm of [
    async (token) => ops.confirmEmail(database.db, { token }),
    async (token) =>
      (await ops.confirmEmailForUser(database.db, { token })).status,
  ]) {
    const email = newEmail();
    const { userId } = await emailSignIn(email);
    await ops.startEmailVerification(database.db, {
      sealing,
      userId,
      email: newEmail(),
      webOrigin: WEB,
    });
    const { token } = await sealedMail(userId, 'email_verification_link');
    await person(auditRole.id, email);
    assert.equal(await confirm(token), 'staff_account');
    const [row] = await rows(`SELECT email FROM users WHERE id = $1`, [userId]);
    assert.equal(row.email, email);
  }
});

test('ops:set-email stays the server route for staff, and logs what moved', async () => {
  const [{ handle, user_id: userId }] = await rows(
    `SELECT handle_lower AS handle, user_id FROM profiles
       WHERE user_id NOT IN (SELECT user_id FROM staff) ORDER BY handle_lower LIMIT 1`,
  );
  const first = newEmail();
  assert.equal(
    await ops.setAccountEmail(database.db, {
      handle,
      email: first,
      reason: REASON,
    }),
    'set',
  );
  await person(auditRole.id, first);
  const next = newEmail();
  assert.equal(
    await ops.setAccountEmail(database.db, {
      handle,
      email: next,
      reason: REASON,
      sealing,
    }),
    'set',
  );
  const audit = await lastAudit('account.email_set_by_script', userId);
  assert.equal(audit.staff_user_id, null);
  assert.ok(audit.reason.startsWith(REASON));
  const change = changeIn(audit.reason);
  assert.equal(change.staff, true);
  assert.equal(change.from, `a•••@${first.split('@')[1]}`);
  assert.equal(change.to, `a•••@${next.split('@')[1]}`);
  // A link emailed to the old address dies with the move.
  const [{ open }] = await rows(
    `SELECT count(*)::int AS open FROM staff_enrolments WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  assert.equal(open, 0);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
});

/** Takes a person through the real email recovery up to its 24-hour hold. */
async function recoveryInHold(email, newAddress) {
  const session = await emailSignIn(email);
  const recovery = newEmail();
  await call('POST', '/v1/me/recovery-email/code', session.cookie, {
    email: recovery,
  });
  const set = await call('POST', '/v1/me/recovery-email', session.cookie, {
    email: recovery,
    code: /\b(\d{6})\b/.exec(
      (await inboxMail(recovery, 'recovery email')).body,
    )[1],
  });
  assert.equal(set.status, 200);
  await call('POST', '/v1/auth/email-recovery/start', undefined, { email });
  const code = /\b(\d{6})\b/.exec(
    (await inboxMail(recovery, 'recovery code')).body,
  )[1];
  assert.equal(
    (
      await call('POST', '/v1/auth/email-recovery/propose', undefined, {
        email,
        code,
        newEmail: newAddress,
      })
    ).status,
    202,
  );
  const confirmed = await call(
    'POST',
    '/v1/auth/email-recovery/confirm',
    undefined,
    {
      email,
      newEmail: newAddress,
      code: /\b(\d{6})\b/.exec((await inboxMail(newAddress, '')).body)[1],
    },
  );
  assert.equal(confirmed.status, 200);
  return session;
}
const pendingRecoveries = async (userId) =>
  (
    await rows(
      `SELECT 1 FROM email_recoveries WHERE user_id = $1 AND cancelled_at IS NULL AND completed_at IS NULL`,
      [userId],
    )
  ).length;
const later = () => new Date(Date.now() + 25 * 3600_000);

test('inviting someone cancels recoveries waiting on them, so their address stays', async () => {
  const email = newEmail();
  const session = await recoveryInHold(email, newEmail());
  assert.equal(await pendingRecoveries(session.userId), 1);
  await person(auditRole.id, email);
  assert.equal(await pendingRecoveries(session.userId), 0);
  assert.equal(
    changeIn((await lastAudit('staff.added', session.userId)).reason)
      .recoveriesCancelled,
    1,
  );
  await ops.completeDueRecoveries(database.db, sealing, later());
  const [row] = await rows(`SELECT email FROM users WHERE id = $1`, [
    session.userId,
  ]);
  assert.equal(row.email, email);
});

test('completing a recovery is refused for active staff, however the staff row appeared', async () => {
  const email = newEmail();
  const session = await recoveryInHold(email, newEmail());
  // grant-owner is the path that doesn't go through addStaff's cancelling.
  await ops.grantOwner(database.db, { email });
  await ops.completeDueRecoveries(database.db, sealing, later());
  const [row] = await rows(`SELECT email FROM users WHERE id = $1`, [
    session.userId,
  ]);
  assert.equal(row.email, email);
  assert.equal(await pendingRecoveries(session.userId), 0);
  assert.ok(await lastAudit('account.recovery_refused_staff', session.userId));
  const [{ open }] = await rows(
    `SELECT count(*)::int AS open FROM staff_enrolments WHERE user_id = $1 AND used_at IS NULL`,
    [session.userId],
  );
  assert.equal(open, 1, 'the enrolment link survives: nothing moved');
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: session.userId,
    reason: REASON,
  });
});

test('a phone recovery due for active staff is cancelled, not completed', async () => {
  const email = newEmail();
  const { userId } = await emailSignIn(email);
  const newPhone = `+234803667${phone++}`;
  // Phone sign-in is legacy and has no route to reach a hold from here, so the row is set up directly.
  await rows(
    `INSERT INTO phone_recoveries (id, user_id, new_phone_e164, effective_at)
       VALUES (gen_random_uuid(), $1, $2, now() - interval '1 hour')`,
    [userId, newPhone],
  );
  await ops.grantOwner(database.db, { email });
  const result = await call('POST', '/v1/auth/code', undefined, {
    phone: newPhone,
  });
  assert.equal(result.status, 202);
  const code = /\b(\d{6})\b/.exec(
    (await (await fetch(`${stack.api}/v1/dev/inbox`)).json()).data[0].body,
  )[1];
  const verified = await call('POST', '/v1/auth/verify', undefined, {
    phone: newPhone,
    code,
  });
  assert.equal(verified.status, 200);
  const [row] = await rows(`SELECT phone_e164 FROM users WHERE id = $1`, [
    userId,
  ]);
  assert.notEqual(row.phone_e164, newPhone);
  const [recovery] = await rows(
    `SELECT cancelled_at, completed_at FROM phone_recoveries WHERE user_id = $1`,
    [userId],
  );
  assert.ok(recovery.cancelled_at);
  assert.equal(recovery.completed_at, null);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
});

test('a request waiting when its owner lost their authenticator does not run', async () => {
  const [a, c] = [await anotherOwner(), await anotherOwner()];
  await ops.resetAuthenticator(database.db, {
    actorId: a,
    userId: c,
    reason: REASON,
    sealing,
  });
  assert.equal(
    await attempt(
      ops.removeStaff(database.db, { actorId: c, userId: a, reason: REASON }),
    ),
    'PERMISSION_NOT_HELD',
  );
  assert.equal(await ops.staffRole(database.db, a), 'owner');
});

test('two owners resetting each other at once leave one able to act', async () => {
  const [a, c] = [await anotherOwner(), await anotherOwner()];
  const results = await Promise.allSettled([
    ops.resetAuthenticator(database.db, {
      actorId: a,
      userId: c,
      reason: REASON,
      sealing,
    }),
    ops.resetAuthenticator(database.db, {
      actorId: c,
      userId: a,
      reason: REASON,
      sealing,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((r) => r.status === 'rejected').reason.code,
    'PERMISSION_NOT_HELD',
  );
  const [{ left }] = await rows(
    `SELECT count(*)::int AS left FROM staff_totp WHERE user_id = ANY($1) AND confirmed_at IS NOT NULL`,
    [[a, c]],
  );
  assert.equal(left, 1);
});

test('an owner who never enrolled does not count: grant-owner --role release_check is refused', async () => {
  const email = newEmail();
  const sole = await anotherOwner(email);
  // Started enrolling and never confirmed: a row exists, and still doesn't count.
  const { userId: never, enrolmentCode: neverCode } = await ops.grantOwner(
    database.db,
    { email: newEmail() },
  );
  await ops.startTotpEnrolment(database.db, {
    userId: never,
    enrolmentCode: neverCode,
    key: TOTP_KEY,
  });
  const boss = await manager();
  await asSoleOwner(sole, async () => {
    await rows(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [
      never,
    ]);
    assert.equal(
      await attempt(
        ops.grantOwner(database.db, { email, role: 'release_check' }),
      ),
      'LAST_OWNER',
    );
    assert.equal(await ops.staffRole(database.db, sole), 'owner');
    // A manager can't take them away by removal either.
    assert.equal(
      await attempt(
        ops.removeStaff(database.db, {
          actorId: boss,
          userId: sole,
          reason: REASON,
        }),
      ),
      'LAST_OWNER',
    );
    // The enrolled owner can still clear away one who never enrolled.
    await ops.removeStaff(database.db, {
      actorId: sole,
      userId: never,
      reason: REASON,
    });
  });
});

test('a staff account cannot be deleted, and a deleted account never counts as an owner', async () => {
  const someone = await enrolled();
  const refused = await call(
    'DELETE',
    '/v1/me/account',
    someone.cookie.split('; ')[0],
    {
      confirm: 'DELETE',
    },
  );
  const attemptBody = await refused.text();
  assert.equal(refused.status, 409, attemptBody);
  assert.equal(JSON.parse(attemptBody).error.code, 'STAFF_CANNOT_DELETE');
  const [{ deleted_at: stillThere }] = await rows(
    `SELECT deleted_at FROM users WHERE id = $1`,
    [someone.userId],
  );
  assert.equal(stillThere, null);

  // Removed first, deletion works; and an account deleted before this rule (no route reaches that
  // now, so set directly) neither counts as the other owner nor can act.
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
  assert.equal(
    await attempt(
      ops.deleteAccount(database.db, { userId: someone.userId, sealing }),
    ),
    'ok',
  );
  const email = newEmail();
  const sole = await anotherOwner(email);
  const gone = await anotherOwner();
  await rows(
    `UPDATE users SET deleted_at = now(), email = NULL, email_verified_at = NULL WHERE id = $1`,
    [gone],
  );
  await asSoleOwner(sole, async () => {
    await rows(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [gone]);
    assert.equal(
      await attempt(
        ops.grantOwner(database.db, { email, role: 'release_check' }),
      ),
      'LAST_OWNER',
    );
    assert.equal(
      await attempt(
        ops.removeStaff(database.db, {
          actorId: gone,
          userId: sole,
          reason: REASON,
        }),
      ),
      'PERMISSION_NOT_HELD',
    );
  });
  await rows(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [gone]);
});

test('grant-owner still makes the first owner, and brings back a sole owner who lost their phone', async () => {
  const email = newEmail();
  const sole = await anotherOwner(email);
  await asSoleOwner(sole, async () => {
    await rows(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [
      sole,
    ]);
    // Nobody is an owner at all: a fresh install, as far as this is concerned.
    const first = await ops.grantOwner(database.db, { email: newEmail() });
    assert.equal(await ops.staffRole(database.db, first.userId), 'owner');
    await rows(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [
      first.userId,
    ]);
    await rows(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [sole]);
    // Lost phone: same account, new link, and it works.
    const again = await ops.grantOwner(database.db, { email });
    assert.equal(again.userId, sole);
    await confirmAuthenticator(sole, again.enrolmentCode);
  });
});

test('a removed person comes back on their exact address, with a fresh link and a restore in the log', async () => {
  const email = newEmail();
  const { userId } = await person(auditRole.id, email);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  const other = await ops.createRole(database.db, {
    actorId: ownerId,
    name: `Rehired ${uniquePrefix()}`,
    description: '',
    permissions: ['analytics.view'],
    reason: REASON,
  });
  const back = await ops.addStaff(database.db, {
    actorId: ownerId,
    email,
    roleId: other.id,
    reason: REASON,
    sealing,
  });
  assert.equal(back.userId, userId);
  assert.equal(await ops.staffRole(database.db, userId), other.id);
  const change = changeIn((await lastAudit('staff.added', userId)).reason);
  assert.equal(change.restored, true);
  const session = await emailSignIn(email);
  const me = await call('GET', '/v1/ops/me', session.cookie);
  assert.deepEqual((await me.json()).data, {
    state: 'needs_enrolment',
    canDecline: true,
  });
  await confirmAuthenticator(
    userId,
    (await sealedMail(userId, 'staff_invitation')).code,
  );
  assert.deepEqual(
    [...(await ops.staffPermissions(database.db, userId))],
    ['analytics.view'],
  );

  // Usual rules: a manager can't restore someone into a role beyond them, or as an owner.
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  const weak = await manager();
  for (const roleId of [other.id, 'owner'])
    assert.equal(
      await attempt(
        ops.addStaff(database.db, {
          actorId: weak,
          email,
          roleId,
          reason: REASON,
          sealing,
        }),
      ),
      'PERMISSION_NOT_HELD',
    );
  assert.equal(await ops.staffRole(database.db, userId), null);
});

test('a removed release_check account can come back on a normal role', async () => {
  const email = newEmail();
  const { userId } = await ops.grantOwner(database.db, {
    email,
    role: 'release_check',
  });
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  await ops.addStaff(database.db, {
    actorId: ownerId,
    email,
    roleId: auditRole.id,
    reason: REASON,
    sealing,
  });
  assert.equal(await ops.staffRole(database.db, userId), auditRole.id);
});

test('a lapsed invitation can be sent again, and only the new link works', async () => {
  const email = newEmail();
  const { userId } = await person(auditRole.id, email);
  const old = (await sealedMail(userId, 'staff_invitation')).code;
  await assert.rejects(
    ops.resendInvitation(database.db, {
      actorId: await manager(),
      userId,
      reason: REASON,
      sealing,
    }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  const able = await manager(['audit.view']);
  const resent = await ops.resendInvitation(database.db, {
    actorId: able,
    userId,
    reason: REASON,
    sealing,
  });
  assert.equal(resent.delivery, 'queued');
  const code = (await sealedMail(userId, 'staff_invitation')).code;
  assert.notEqual(code, old);
  assert.equal(
    await lastAudit('staff.invitation_resent', userId).then(
      (r) => r.staff_user_id,
    ),
    able,
  );
  await assert.rejects(
    ops.startTotpEnrolment(database.db, {
      userId,
      enrolmentCode: old,
      key: TOTP_KEY,
    }),
    refusedWith('ENROLMENT_INVALID'),
  );
  await confirmAuthenticator(userId, code);
  // Enrolled now: this is no longer an invitation, and a reset is an owner's call.
  assert.equal(
    await attempt(
      ops.resendInvitation(database.db, {
        actorId: ownerId,
        userId,
        reason: REASON,
        sealing,
      }),
    ),
    'STAFF_ALREADY_ENROLLED',
  );
  const route = await call(
    'POST',
    `/v1/ops/staff/${(await person()).userId}/resend-invitation`,
    owner.cookie,
    { reason: REASON },
  );
  assert.equal(route.status, 200);
  assert.equal((await route.json()).data.delivery, 'queued');
});

test('grant-owner refuses a mailbox that is staff on another account, and names it masked', async () => {
  const name = `n${uniquePrefix().replace(/\W/g, '')}`;
  const { userId } = await person(auditRole.id, `${name}@gmail.com`);
  const before = await rows(`SELECT count(*)::int AS n FROM users`);
  const variant = `${name[0]}.${name.slice(1)}+x@googlemail.com`;
  await assert.rejects(
    ops.grantOwner(database.db, { email: variant }),
    (error) => {
      assert.equal(error.code, 'STAFF_EMAIL_TAKEN');
      assert.equal(error.detail, `${name[0]}•••@gmail.com`);
      return true;
    },
  );
  // A removed match counts too; the exact address still restores.
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  assert.equal(
    await attempt(ops.grantOwner(database.db, { email: variant })),
    'STAFF_EMAIL_TAKEN',
  );
  assert.deepEqual(await rows(`SELECT count(*)::int AS n FROM users`), before);
  const back = await ops.grantOwner(database.db, {
    email: `${name}@gmail.com`,
  });
  assert.equal(back.userId, userId);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
});

test('moving an account voids its open enrolment link', async () => {
  const email = newEmail();
  const { userId, enrolmentCode } = await ops.grantOwner(database.db, {
    email,
  });
  const [row] = await rows(
    `SELECT 1 FROM staff_enrolments WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  assert.ok(row);
  await ops.dropOpsAccess(database.db, userId);
  assert.equal(
    await attempt(
      ops.startTotpEnrolment(database.db, {
        userId,
        enrolmentCode,
        key: TOTP_KEY,
      }),
    ),
    'ENROLMENT_INVALID',
  );
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
});

test('a reset clears a lockout, so the new link can be used at once', async () => {
  const someone = await enrolled();
  await rows(
    `INSERT INTO ops_lockouts (user_id, failures, locked_until) VALUES ($1, 0, now() + interval '15 minutes')
       ON CONFLICT (user_id) DO UPDATE SET locked_until = EXCLUDED.locked_until`,
    [someone.userId],
  );
  await ops.resetAuthenticator(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
    sealing,
  });
  await confirmAuthenticator(
    someone.userId,
    (await sealedMail(someone.userId, 'staff_invitation')).code,
  );
});

test("an invitation that can't or didn't go out is reported as such", async () => {
  const blocked = newEmail();
  await rows(
    `INSERT INTO mail_suppressions (address_hmac, reason) VALUES ($1, 'hard_bounce')`,
    [ops.addressHmac(sealing, blocked)],
  );
  const added = await ops.addStaff(database.db, {
    actorId: ownerId,
    email: blocked,
    roleId: auditRole.id,
    reason: REASON,
    sealing,
  });
  assert.equal(added.delivery, 'suppressed');
  const fine = await ops.addStaff(database.db, {
    actorId: ownerId,
    email: newEmail(),
    roleId: auditRole.id,
    reason: REASON,
    sealing,
  });
  assert.equal(fine.delivery, 'queued');
  const list = await ops.activeStaffList(database.db);
  const find = (id) => list.find((row) => row.userId === id);
  assert.ok(find(fine.userId).invitation.linkOpen);
  assert.ok(find(fine.userId).invitation.status);
  await rows(
    `UPDATE mail_messages SET status = 'failed' WHERE user_id = $1 AND type = 'staff_invitation'`,
    [fine.userId],
  );
  assert.equal(
    (await ops.activeStaffList(database.db)).find(
      (r) => r.userId === fine.userId,
    ).invitation.status,
    'failed',
  );
  // Past its 30 minutes the link is reported closed.
  await rows(
    `UPDATE staff_enrolments SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
    [fine.userId],
  );
  assert.equal(
    (await ops.activeStaffList(database.db)).find(
      (r) => r.userId === fine.userId,
    ).invitation.linkOpen,
    false,
  );
  // Nothing to report for someone enrolled.
  assert.equal(find(ownerId).invitation, null);
});

test('a recovery proposed before someone became staff cannot be confirmed afterwards', async () => {
  const email = newEmail();
  const newAddress = newEmail();
  const session = await emailSignIn(email);
  const recovery = newEmail();
  await call('POST', '/v1/me/recovery-email/code', session.cookie, {
    email: recovery,
  });
  await call('POST', '/v1/me/recovery-email', session.cookie, {
    email: recovery,
    code: /\b(\d{6})\b/.exec(
      (await inboxMail(recovery, 'recovery email')).body,
    )[1],
  });
  await call('POST', '/v1/auth/email-recovery/start', undefined, { email });
  const code = /\b(\d{6})\b/.exec(
    (await inboxMail(recovery, 'recovery code')).body,
  )[1];
  await call('POST', '/v1/auth/email-recovery/propose', undefined, {
    email,
    code,
    newEmail: newAddress,
  });
  const mail = await inboxMail(newAddress, '');
  // grant-owner: the path that doesn't cancel what is waiting.
  const { userId } = await ops.grantOwner(database.db, { email });
  const confirmed = await call(
    'POST',
    '/v1/auth/email-recovery/confirm',
    undefined,
    {
      email,
      newEmail: newAddress,
      code: /\b(\d{6})\b/.exec(mail.body)[1],
    },
  );
  assert.equal(confirmed.status, 400);
  const [{ effective_at: effectiveAt }] = await rows(
    `SELECT effective_at FROM email_recoveries WHERE user_id = $1`,
    [userId],
  );
  assert.equal(effectiveAt, null);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
});

test('inviting someone cancels a phone recovery waiting on them too', async () => {
  const email = newEmail();
  const { userId } = await emailSignIn(email);
  // Phone sign-in is legacy and has no route to reach a hold from here, so the row is set up directly.
  await rows(
    `INSERT INTO phone_recoveries (id, user_id, new_phone_e164, effective_at)
       VALUES (gen_random_uuid(), $1, $2, now() + interval '1 hour')`,
    [userId, `+234803668${phone++}`],
  );
  await person(auditRole.id, email);
  const [row] = await rows(
    `SELECT cancelled_at FROM phone_recoveries WHERE user_id = $1`,
    [userId],
  );
  assert.ok(row.cancelled_at);
  assert.equal(
    changeIn((await lastAudit('staff.added', userId)).reason)
      .recoveriesCancelled,
    1,
  );
});

test('only an owner sends an invitation again to an owner', async () => {
  const every = await ops.createRole(database.db, {
    actorId: ownerId,
    name: `All ${uniquePrefix()}`,
    description: '',
    permissions: ops.OPS_PERMISSIONS,
    reason: REASON,
  });
  const strong = (await person(every.id)).userId;
  await confirmAuthenticator(
    strong,
    (await sealedMail(strong, 'staff_invitation')).code,
  );
  const invited = await person('owner');
  assert.equal(
    await attempt(
      ops.resendInvitation(database.db, {
        actorId: strong,
        userId: invited.userId,
        reason: REASON,
        sealing,
      }),
    ),
    'PERMISSION_NOT_HELD',
  );
  assert.equal(
    (
      await ops.resendInvitation(database.db, {
        actorId: ownerId,
        userId: invited.userId,
        reason: REASON,
        sealing,
      })
    ).delivery,
    'queued',
  );
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: invited.userId,
    reason: REASON,
  });
});

const recipientSession = (person_) => person_.cookie.split('; ')[0];
const openLinks = async (userId) =>
  (
    await rows(
      `SELECT count(*)::int AS open FROM staff_enrolments WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    )
  )[0].open;

test('an invited person can decline: access ends, it is logged, and their self-service returns', async () => {
  const email = newEmail();
  const session = await emailSignIn(email);
  const { userId } = await person(auditRole.id, email);
  assert.equal(
    (
      await call('POST', '/v1/me/email/code', session.cookie, {
        email: newEmail(),
      })
    ).status,
    409,
    'the email lock holds while invited',
  );
  const declined = await call('POST', '/v1/ops/decline', session.cookie, {});
  assert.equal(declined.status, 200);
  assert.equal((await call('GET', '/v1/ops/me', session.cookie)).status, 404);
  assert.ok(
    (await rows(`SELECT revoked_at FROM staff WHERE user_id = $1`, [userId]))[0]
      .revoked_at,
  );
  assert.equal(await openLinks(userId), 0);
  const audit = await lastAudit('staff.invitation_declined', userId);
  assert.equal(audit.staff_user_id, userId);
  assert.equal(changeIn(audit.reason).role.id, auditRole.id);
  assert.equal(
    (
      await call('POST', '/v1/me/email/code', session.cookie, {
        email: newEmail(),
      })
    ).status,
    202,
  );
  // Declining isn't a ban: they can be invited again.
  assert.equal((await person(auditRole.id, email)).userId, userId);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
});

test('someone enrolled cannot decline, and a non-staff session sees nothing', async () => {
  const someone = await enrolled();
  const refused = await call(
    'POST',
    '/v1/ops/decline',
    recipientSession(someone),
    {},
  );
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), 'STAFF_ALREADY_ENROLLED');
  assert.equal(await ops.staffRole(database.db, someone.userId), auditRole.id);
  const stranger = await emailSignIn(newEmail());
  assert.equal(
    (await call('POST', '/v1/ops/decline', stranger.cookie, {})).status,
    404,
  );
  assert.equal(
    (await call('POST', '/v1/ops/decline', undefined, {})).status,
    404,
  );
});

test('the invitation says how to decline; a reset does not offer it', async () => {
  const { MAIL_TYPES } = await import('../../packages/mail/dist/index.js');
  const ctx = { webOrigin: WEB, unsubscribeUrl: null };
  const render = (kind) =>
    MAIL_TYPES.staff_invitation.render({ code: 'ABCDEFGH23', kind }, ctx).text;
  assert.match(render('invited'), /decline/i);
  assert.doesNotMatch(render('reset'), /decline/i);
});

test('an invited person can delete their account, which ends their staff access', async () => {
  const email = newEmail();
  const session = await emailSignIn(email);
  const { userId } = await person(auditRole.id, email);
  const removed = await call('DELETE', '/v1/me/account', session.cookie, {
    confirm: 'DELETE',
  });
  assert.equal(removed.status, 204);
  const [row] = await rows(
    `SELECT s.revoked_at, u.deleted_at, u.email FROM staff s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
    [userId],
  );
  assert.ok(row.revoked_at);
  assert.ok(row.deleted_at);
  assert.equal(row.email, null);
  assert.equal(await openLinks(userId), 0);
  const audit = await lastAudit('staff.invitation_declined', userId);
  assert.equal(changeIn(audit.reason).via, 'account_deleted');
});

test('inviting someone tells them a recovery was cancelled, at both addresses', async () => {
  const email = newEmail();
  const newAddress = newEmail();
  const session = await recoveryInHold(email, newAddress);
  await person(auditRole.id, email);
  const notices = await rows(
    `SELECT to_hint FROM mail_messages WHERE user_id = $1 AND type = 'recovery_cancelled_notice' ORDER BY to_hint`,
    [session.userId],
  );
  assert.deepEqual(
    notices.map((n) => n.to_hint).sort(),
    [`a•••@${email.split('@')[1]}`, `a•••@${newAddress.split('@')[1]}`].sort(),
  );
  const mail = await inboxMail(email, 'cancelled');
  assert.match(mail.body, /support@/);
  assert.doesNotMatch(mail.body, /admin|staff/i);
  // Nothing was waiting: no notice.
  const quiet = newEmail();
  const { userId } = await emailSignIn(quiet);
  await person(auditRole.id, quiet);
  assert.equal(
    (
      await rows(
        `SELECT 1 FROM mail_messages WHERE user_id = $1 AND type = 'recovery_cancelled_notice'`,
        [userId],
      )
    ).length,
    0,
  );
});

test('a recovery refused at completion also tells the person', async () => {
  const email = newEmail();
  const session = await recoveryInHold(email, newEmail());
  await ops.grantOwner(database.db, { email });
  await ops.completeDueRecoveries(database.db, sealing, later());
  assert.equal(
    (
      await rows(
        `SELECT 1 FROM mail_messages WHERE user_id = $1 AND type = 'recovery_cancelled_notice'`,
        [session.userId],
      )
    ).length,
    2,
  );
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: session.userId,
    reason: REASON,
  });
});

test('ops:set-email reaches staff with no page, logs it and tells the old address', async () => {
  const { execFile } = await import('node:child_process');
  const script = new URL(
    '../../packages/database/dist/scripts/set-email.js',
    import.meta.url,
  ).pathname;
  const run = (...args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [script, ...args],
        { env: { ...process.env, DATABASE_URL: database.url, MAIL_SEAL_KEY } },
        (error, stdout, stderr) =>
          resolve({ code: error?.code ?? 0, stdout, stderr }),
      ),
    );
  const email = newEmail();
  const { userId } = await person(auditRole.id, email);
  assert.deepEqual(
    await rows(`SELECT 1 FROM profiles WHERE user_id = $1`, [userId]),
    [],
  );
  const next = newEmail();
  const moved = await run(
    '--email-current',
    email,
    '--email',
    next,
    '--reason',
    REASON,
  );
  assert.equal(moved.code, 0, moved.stderr + moved.stdout);
  assert.equal(
    (await rows(`SELECT email FROM users WHERE id = $1`, [userId]))[0].email,
    next,
  );
  const change = changeIn(
    (await lastAudit('account.email_set_by_script', userId)).reason,
  );
  assert.equal(change.staff, true);
  assert.equal(change.oldAddressNotified, true);
  const notice = await sealedMail(userId, 'email_changed_notice');
  assert.equal(notice.toHint, `a•••@${email.split('@')[1]}`);
  assert.equal(notice.newEmailHint, `a•••@${next.split('@')[1]}`);

  // One way to name the account, exactly.
  const both = await run(
    '--email-current',
    next,
    '--handle',
    'x',
    '--email',
    newEmail(),
    '--reason',
    REASON,
  );
  assert.equal(both.code, 1);
  assert.match(both.stderr, /Usage/);
  const unknown = await run(
    '--email-current',
    newEmail(),
    '--email',
    newEmail(),
    '--reason',
    REASON,
  );
  assert.equal(unknown.code, 1);
  assert.match(unknown.stdout, /no account/i);
  // The right message for a reason the log can't take.
  const marked = await run(
    '--email-current',
    next,
    '--email',
    newEmail(),
    '--reason',
    `${REASON} [change: x]`,
  );
  assert.equal(marked.code, 1);
  assert.match(marked.stdout, /reason/i);
  assert.doesNotMatch(marked.stdout, /valid email/i);
  assert.equal(
    (await rows(`SELECT email FROM users WHERE id = $1`, [userId]))[0].email,
    next,
  );
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
});

test('with no mail key the script refuses for active staff, and warns for anyone else', async () => {
  const { execFile } = await import('node:child_process');
  const script = new URL(
    '../../packages/database/dist/scripts/set-email.js',
    import.meta.url,
  ).pathname;
  const env = { ...process.env };
  delete env.MAIL_SEAL_KEY;
  const run = (...args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [script, ...args],
        { env: { ...env, DATABASE_URL: database.url } },
        (error, stdout, stderr) =>
          resolve({ code: error?.code ?? 0, stdout, stderr }),
      ),
    );
  const email = newEmail();
  const { userId } = await person(auditRole.id, email);
  const refused = await run(
    '--email-current',
    email,
    '--email',
    newEmail(),
    '--reason',
    REASON,
  );
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /MAIL_SEAL_KEY/);
  const [row] = await rows(`SELECT email FROM users WHERE id = $1`, [userId]);
  assert.equal(row.email, email);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });

  // Removed now, so an ordinary account: the warning is enough, and the log says nobody was told.
  const allowed = await run(
    '--email-current',
    email,
    '--email',
    newEmail(),
    '--reason',
    REASON,
  );
  assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
  assert.match(allowed.stdout, /MAIL_SEAL_KEY/);
  assert.equal(
    changeIn((await lastAudit('account.email_set_by_script', userId)).reason)
      .oldAddressNotified,
    false,
  );
});

test('set-email refuses a mailbox that is another active staff member', async () => {
  const name = `n${uniquePrefix().replace(/\W/g, '')}`;
  await person(auditRole.id, `${name}@gmail.com`);
  const email = newEmail();
  const { userId } = await person(auditRole.id, email);
  assert.equal(
    await ops.setAccountEmail(database.db, {
      currentEmail: email,
      email: `${name}+x@gmail.com`,
      reason: REASON,
      sealing,
    }),
    'staff_mailbox_taken',
  );
  const [row] = await rows(`SELECT email FROM users WHERE id = $1`, [userId]);
  assert.equal(row.email, email);
});

test('STAFF_EMAIL_LOCKED says to contact the owner, who can have it changed', async () => {
  const someone = await enrolled();
  const { error } = await (
    await call('POST', '/v1/me/email/code', recipientSession(someone), {
      email: newEmail(),
    })
  ).json();
  assert.match(error.message, /contact the owner/i);
  assert.match(error.message, /have it changed/i);
});

test('grant-owner on an active account is not blocked by a removed look-alike', async () => {
  const name = `n${uniquePrefix().replace(/\W/g, '')}`;
  const gone = await person(auditRole.id, `${name}@gmail.com`);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: gone.userId,
    reason: REASON,
  });
  // An operator moved an active person onto the same mailbox: the real route to this state.
  const active = newEmail();
  const { userId } = await person(auditRole.id, active);
  const variant = `${name}+work@gmail.com`;
  assert.equal(
    await ops.setAccountEmail(database.db, {
      currentEmail: active,
      email: variant,
      reason: REASON,
      sealing,
    }),
    'set',
  );
  const granted = await ops.grantOwner(database.db, { email: variant });
  assert.equal(granted.userId, userId);
  // An account that isn't active staff gets no such pass.
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId,
    reason: REASON,
  });
  assert.equal(
    await attempt(
      ops.grantOwner(database.db, { email: `${name}+other@gmail.com` }),
    ),
    'STAFF_EMAIL_TAKEN',
  );
});

test('grant-owner compares the mailbox on the phone form too', async () => {
  const name = `n${uniquePrefix().replace(/\W/g, '')}`;
  await person(auditRole.id, `${name}@gmail.com`);
  const number = `+234803669${phone++}`;
  assert.equal(
    (await call('POST', '/v1/auth/code', undefined, { phone: number })).status,
    202,
  );
  const code = /\b(\d{6})\b/.exec(
    (await (await fetch(`${stack.api}/v1/dev/inbox`)).json()).data[0].body,
  )[1];
  const verified = await call('POST', '/v1/auth/verify', undefined, {
    phone: number,
    code,
  });
  assert.equal(verified.status, 200);
  const [{ id: userId }] = await rows(
    `SELECT id FROM users WHERE phone_e164 = $1`,
    [number],
  );
  await ops.startEmailVerification(database.db, {
    sealing,
    userId,
    email: `${name}+phone@gmail.com`,
    webOrigin: WEB,
  });
  const { token } = await sealedMail(userId, 'email_verification_link');
  assert.equal(await ops.confirmEmail(database.db, { token }), 'confirmed');
  assert.equal(
    await attempt(ops.grantOwner(database.db, { phone: number })),
    'STAFF_EMAIL_TAKEN',
  );
  assert.equal(await ops.staffRole(database.db, userId), null);
});

test('inviting and deleting the same person at once never breaks', async () => {
  for (let i = 0; i < 6; i++) {
    const email = newEmail();
    const { userId } = await emailSignIn(email);
    // Set up directly: the race needs a recovery row, and six real recoveries add nothing.
    await rows(
      `INSERT INTO phone_recoveries (id, user_id, new_phone_e164, effective_at)
         VALUES (gen_random_uuid(), $1, $2, now() + interval '1 hour')`,
      [userId, `+234803670${phone++}`],
    );
    const results = await Promise.allSettled([
      ops.addStaff(database.db, {
        actorId: ownerId,
        email,
        roleId: auditRole.id,
        reason: REASON,
        sealing,
      }),
      ops.deleteAccount(database.db, { userId, sealing }),
    ]);
    for (const result of results)
      if (result.status === 'rejected')
        assert.equal(
          result.reason.name,
          'OperationError',
          String(result.reason),
        );
    const [row] = await rows(
      `SELECT u.deleted_at, s.revoked_at, s.user_id FROM users u LEFT JOIN staff s ON s.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    assert.ok(row.deleted_at, 'the deletion ran');
    if (row.user_id)
      assert.ok(row.revoked_at, 'a deleted account keeps no live staff row');
  }
});

const enrolledAt = async (userId) =>
  (await rows(`SELECT enrolled_at FROM staff WHERE user_id = $1`, [userId]))[0]
    .enrolled_at;

test('enrolled_at is set once at first confirmation, and survives a reset and grant-owner', async () => {
  const someone = await enrolled();
  const first = await enrolledAt(someone.userId);
  assert.ok(first, 'set when the HTTP enrolment confirms');
  await ops.resetAuthenticator(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
    sealing,
  });
  assert.deepEqual(await enrolledAt(someone.userId), first);
  await ops.grantOwner(database.db, { email: someone.email });
  assert.deepEqual(await enrolledAt(someone.userId), first);
  await ops.dropOpsAccess(database.db, someone.userId);
  assert.deepEqual(await enrolledAt(someone.userId), first);
  // A second confirmation doesn't move it.
  const { enrolmentCode } = await ops.grantOwner(database.db, {
    email: someone.email,
  });
  await confirmAuthenticator(someone.userId, enrolmentCode);
  assert.deepEqual(await enrolledAt(someone.userId), first);
  // Only being granted access again after removal clears it.
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
  assert.deepEqual(await enrolledAt(someone.userId), first);
  // grant-owner bringing back someone removed starts over too.
  const regranted = await ops.grantOwner(database.db, { email: someone.email });
  assert.equal(await enrolledAt(someone.userId), null);
  await confirmAuthenticator(someone.userId, regranted.enrolmentCode);
  assert.ok(await enrolledAt(someone.userId));
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
  await ops.addStaff(database.db, {
    actorId: ownerId,
    email: someone.email,
    roleId: auditRole.id,
    reason: REASON,
    sealing,
  });
  assert.equal(await enrolledAt(someone.userId), null);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
  await ops.grantOwner(database.db, { email: someone.email });
  assert.equal(await enrolledAt(someone.userId), null);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
});

test('a reset person cannot decline: a stolen session gets nowhere', async () => {
  const someone = await enrolled('owner');
  const session = someone.cookie.split('; ')[0];
  assert.equal(
    (await call('POST', '/v1/ops/decline', session, {})).status,
    409,
  );
  await ops.resetAuthenticator(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
    sealing,
  });
  assert.equal((await call('GET', '/v1/me/sessions', session)).status, 200);
  const refused = await call('POST', '/v1/ops/decline', session, {});
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), 'STAFF_ALREADY_ENROLLED');
  assert.equal(await ops.staffRole(database.db, someone.userId), 'owner');
  const me = await call('GET', '/v1/ops/me', session);
  assert.deepEqual((await me.json()).data, {
    state: 'needs_enrolment',
    canDecline: false,
  });
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
});

test('a reset person cannot delete their account', async () => {
  const someone = await enrolled('owner');
  const session = someone.cookie.split('; ')[0];
  await ops.resetAuthenticator(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
    sealing,
  });
  const refused = await call('DELETE', '/v1/me/account', session, {
    confirm: 'DELETE',
  });
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), 'STAFF_CANNOT_DELETE');
  const [row] = await rows(
    `SELECT deleted_at, email FROM users WHERE id = $1`,
    [someone.userId],
  );
  assert.equal(row.deleted_at, null);
  assert.equal(row.email, someone.email);
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
});

test('a sole owner re-enrolling through grant-owner cannot decline or delete', async () => {
  const someone = await enrolled('owner');
  const session = someone.cookie.split('; ')[0];
  await asSoleOwner(someone.userId, async () => {
    const { enrolmentCode } = await ops.grantOwner(database.db, {
      email: someone.email,
    });
    const me = await call('GET', '/v1/ops/me', session);
    assert.deepEqual((await me.json()).data, {
      state: 'needs_enrolment',
      canDecline: false,
    });
    assert.equal(
      (await call('POST', '/v1/ops/decline', session, {})).status,
      409,
    );
    assert.equal(
      (await call('DELETE', '/v1/me/account', session, { confirm: 'DELETE' }))
        .status,
      409,
    );
    assert.equal(await ops.staffRole(database.db, someone.userId), 'owner');
    await confirmAuthenticator(someone.userId, enrolmentCode);
  });
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
});

async function phoneCode(cookie, number) {
  assert.equal(
    (await call('POST', '/v1/me/phone/code', cookie, { phone: number })).status,
    202,
  );
  return /\b(\d{6})\b/.exec(
    (await (await fetch(`${stack.api}/v1/dev/inbox`)).json()).data[0].body,
  )[1];
}

test('a phone change is refused for active staff, and a reset person still cannot delete afterwards', async () => {
  const someone = await enrolled('owner');
  const session = someone.cookie.split('; ')[0];
  // Enrolled: the recipient session can't remove the authenticator through this route.
  const number = `+234803671${phone++}`;
  const refused = await call('PUT', '/v1/me/phone', session, {
    phone: number,
    code: await phoneCode(session, number),
  });
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), 'STAFF_PHONE_LOCKED');
  const [totp] = await rows(
    `SELECT confirmed_at FROM staff_totp WHERE user_id = $1`,
    [someone.userId],
  );
  assert.ok(totp.confirmed_at);
  assert.equal(
    (await call('GET', '/v1/ops/audit', someone.cookie)).status,
    200,
  );

  await ops.resetAuthenticator(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
    sealing,
  });
  const again = `+234803671${phone++}`;
  assert.equal(
    (
      await call('PUT', '/v1/me/phone', session, {
        phone: again,
        code: await phoneCode(session, again),
      })
    ).status,
    409,
  );
  assert.equal(
    (await call('DELETE', '/v1/me/account', session, { confirm: 'DELETE' }))
      .status,
    409,
  );
  assert.equal(await ops.staffRole(database.db, someone.userId), 'owner');
  await ops.removeStaff(database.db, {
    actorId: ownerId,
    userId: someone.userId,
    reason: REASON,
  });
});

test('a phone change for someone with no page changes nothing and answers 404', async () => {
  const session = await emailSignIn(newEmail());
  const number = `+234803672${phone++}`;
  const code = await phoneCode(session.cookie, number);
  const answer = await call('PUT', '/v1/me/phone', session.cookie, {
    phone: number,
    code,
  });
  assert.equal(answer.status, 404);
  const [row] = await rows(`SELECT phone_e164 FROM users WHERE id = $1`, [
    session.userId,
  ]);
  assert.equal(row.phone_e164, null);
});

test('declining tells the inviter and owners, masked, and not the person', async () => {
  const boss = await manager(['audit.view']);
  const [{ owner_id: ownerWithEmail }] = await rows(
    `SELECT s.user_id AS owner_id FROM staff s JOIN users u ON u.id = s.user_id
       WHERE s.role_id = 'owner' AND s.revoked_at IS NULL AND u.email IS NOT NULL
         AND s.enrolled_at IS NOT NULL LIMIT 1`,
  ).then(async (found) =>
    found.length > 0 ? found : [{ owner_id: await anotherOwner() }],
  );
  // The manager needs an address too; they have one from being invited.
  const email = newEmail();
  const invited = await ops.addStaff(database.db, {
    actorId: boss,
    email,
    roleId: auditRole.id,
    reason: REASON,
    sealing,
  });
  await ops.declineInvitation(database.db, { userId: invited.userId, sealing });
  const told = await rows(
    `SELECT DISTINCT user_id FROM mail_messages WHERE type = 'staff_invitation_declined'
       AND created_at > now() - interval '1 minute'`,
  );
  const ids = told.map((row) => row.user_id);
  assert.ok(ids.includes(boss), 'the inviter');
  assert.ok(ids.includes(ownerWithEmail), 'an owner');
  assert.ok(!ids.includes(invited.userId), 'not the person');
  const notice = await sealedMail(boss, 'staff_invitation_declined');
  assert.equal(notice.personHint, `a•••@${email.split('@')[1]}`);
  assert.equal(notice.roleName, 'Auditors');
  const { MAIL_TYPES } = await import('../../packages/mail/dist/index.js');
  assert.equal(MAIL_TYPES.staff_invitation_declined.category, 'security');
  // Deleting the account instead tells them too, and an email is gone by then so the hint is taken first.
  const second = newEmail();
  const session = await emailSignIn(second);
  await ops.addStaff(database.db, {
    actorId: boss,
    email: second,
    roleId: auditRole.id,
    reason: REASON,
    sealing,
  });
  assert.equal(
    (
      await call('DELETE', '/v1/me/account', session.cookie, {
        confirm: 'DELETE',
      })
    ).status,
    204,
  );
  assert.equal(
    (await sealedMail(boss, 'staff_invitation_declined')).personHint,
    `a•••@${second.split('@')[1]}`,
  );
});

// These three force the order instead of hoping for a race: one connection holds a lock, and the
// operation under test must be parked behind it having taken nothing the other side needs next.
async function waitBlocked(pattern) {
  for (let i = 0; i < 100; i++) {
    const found = await rows(
      `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
      [pattern],
    );
    if (found.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('deleteAccount takes recovery rows before anything on the account, as completion does', async () => {
  const email = newEmail();
  const { userId } = await emailSignIn(email);
  const [{ id }] = await rows(
    `INSERT INTO email_recoveries (id, user_id, new_email, started_by, confirmed_at, effective_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'self', now(), now(), now()) RETURNING id`,
    [userId, newEmail()],
  );
  const held = await database.pool.connect();
  let deletion;
  try {
    await held.query('BEGIN');
    await held.query(
      `SELECT id FROM email_recoveries WHERE id = $1 FOR UPDATE`,
      [id],
    );
    deletion = ops.deleteAccount(database.db, { userId, sealing });
    assert.ok(await waitBlocked('%delete from "email_recoveries"%'));
    // Completion's next step: this would deadlock if deletion already held the account in any way.
    await held.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT`, [
      userId,
    ]);
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  await deletion;
});

test('deleteAccount holds the account before touching enrolment links', async () => {
  const email = newEmail();
  const { userId } = await emailSignIn(email);
  await person(auditRole.id, email);
  const held = await database.pool.connect();
  let deletion;
  try {
    await held.query('BEGIN');
    await held.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    deletion = ops.deleteAccount(database.db, { userId, sealing });
    assert.ok(await waitBlocked('%from "users"%for update%'));
    await held.query(
      `SELECT user_id FROM staff_enrolments WHERE user_id = $1 FOR UPDATE NOWAIT`,
      [userId],
    );
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  await deletion;
});

test('set-email takes the staff-admin lock before the account row', async () => {
  const email = newEmail();
  const { userId } = await emailSignIn(email);
  const held = await database.pool.connect();
  let move;
  try {
    await held.query('BEGIN');
    await held.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
    );
    move = ops.setAccountEmail(database.db, {
      currentEmail: email,
      email: newEmail(),
      reason: REASON,
      sealing,
    });
    assert.ok(await waitBlocked('%pg_advisory_xact_lock%'));
    await held.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT`, [
      userId,
    ]);
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  assert.equal(await move, 'set');
});
