import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cancelEmailRecoveries,
  completeDueRecoveries,
  confirmRecoveredEmail,
  confirmRecoveryEmail,
  createSession,
  grantOwner,
  mailSealing,
  needsRecoveryEmail,
  pendingEmailRecoveries,
  proposeRecoveredEmail,
  removeRecoveryEmail,
  requestEmailSignInCode,
  requestRecoveryChangeCode,
  requestRecoveryEmailCode,
  resolveSession,
  startEmailRecovery,
  startStaffRecovery,
  verifyEmailSignInCode,
} from '../../dist/index.js';
import { queuedMail } from '../../dist/test-support.js';
import { useDatabase } from './helpers.mjs';

const sealing = mailSealing(Buffer.alloc(32, 7));
const secret = 'test-auth-code-secret-at-least-32-chars!';
const STAFF = '00000000-0000-7000-8000-000000007b11';

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const mails = () => queuedMail(db, sealing, { limit: 100 });
  const codeTo = async (to, type) =>
    (await mails()).find((m) => m.to === to && m.type === type).data.code;
  const account = async (email) => {
    await requestEmailSignInCode(db, sealing, { email, secret });
    const code = await codeTo(email, 'sign_in_code');
    const { userId } = await verifyEmailSignInCode(db, sealing, {
      email,
      code,
      secret,
      deviceHash: null,
      webOrigin: 'https://usetipme.xyz',
    });
    return userId;
  };
  const addRecovery = async (userId, recoveryEmail) => {
    await requestRecoveryEmailCode(db, sealing, {
      userId,
      recoveryEmail,
      secret,
    });
    return confirmRecoveryEmail(db, {
      userId,
      recoveryEmail,
      code: await codeTo(recoveryEmail, 'recovery_email_code'),
      secret,
    });
  };
  /** Runs self-service recovery up to the 24-hour hold. */
  const recover = async (signInEmail, recoveryEmail, newEmail, now) => {
    await startEmailRecovery(db, sealing, { signInEmail, secret });
    const proposed = await proposeRecoveredEmail(db, sealing, {
      signInEmail,
      recoveryCode: await codeTo(recoveryEmail, 'recovery_code'),
      newEmail,
      secret,
    });
    assert.equal(proposed, 'code_sent');
    return confirmRecoveredEmail(db, sealing, {
      signInEmail,
      newEmail,
      code: await codeTo(newEmail, 'recovery_new_email_code'),
      secret,
      ...(now ? { now } : {}),
    });
  };
  return { ...database, rows, mails, codeTo, account, addRecovery, recover };
}

test('a recovery email must differ from the sign-in email', async (t) => {
  const { db, account } = await fresh(t);
  const userId = await account('me@example.com');
  assert.equal(
    await requestRecoveryEmailCode(db, sealing, {
      userId,
      recoveryEmail: 'ME@example.com',
      secret,
    }),
    'same_as_sign_in',
  );
});

test('a recovery email that is another account’s sign-in email is refused', async (t) => {
  const { account, addRecovery } = await fresh(t);
  await account('other@example.com');
  const userId = await account('me@example.com');
  assert.equal(await addRecovery(userId, 'other@example.com'), 'taken');
});

test('someone else’s recovery email can’t be claimed, and adding one is proven by a code', async (t) => {
  const { db, account, addRecovery, rows } = await fresh(t);
  const first = await account('one@example.com');
  assert.equal(await addRecovery(first, 'safe@example.com'), 'confirmed');
  const [row] = await rows(
    'SELECT recovery_email, recovery_email_verified_at IS NOT NULL AS ok FROM users WHERE id = $1',
    [first],
  );
  assert.deepEqual(row, { recovery_email: 'safe@example.com', ok: true });
  const second = await account('two@example.com');
  assert.equal(await addRecovery(second, 'safe@example.com'), 'taken');
  assert.equal(
    await confirmRecoveryEmail(db, {
      userId: second,
      recoveryEmail: 'new@example.com',
      code: '000000',
      secret,
    }),
    'invalid',
  );
});

test('changing or removing a confirmed recovery email needs a code to the sign-in email', async (t) => {
  const { db, account, addRecovery, codeTo, rows } = await fresh(t);
  const userId = await account('me@example.com');
  await addRecovery(userId, 'safe@example.com');
  assert.equal(
    await addRecovery(userId, 'new@example.com'),
    'needs_sign_in_code',
  );
  assert.equal(
    await removeRecoveryEmail(db, { userId, signInCode: '000000', secret }),
    'invalid',
  );
  await requestRecoveryChangeCode(db, sealing, { userId, secret });
  const signInCode = await codeTo('me@example.com', 'recovery_change_code');
  assert.equal(
    await confirmRecoveryEmail(db, {
      userId,
      recoveryEmail: 'new@example.com',
      code: await codeTo('new@example.com', 'recovery_email_code'),
      secret,
      signInCode,
    }),
    'confirmed',
  );
  await requestRecoveryChangeCode(db, sealing, { userId, secret });
  const [mail] = (await queuedMail(db, sealing, { limit: 100 })).filter(
    (m) => m.to === 'me@example.com' && m.type === 'recovery_change_code',
  );
  assert.equal(
    await removeRecoveryEmail(db, {
      userId,
      signInCode: mail.data.code,
      secret,
    }),
    'removed',
  );
  const [row] = await rows('SELECT recovery_email FROM users WHERE id = $1', [
    userId,
  ]);
  assert.equal(row.recovery_email, null);
});

test('recovery answers identically for unknown addresses and accounts with no recovery email', async (t) => {
  const { db, account, mails } = await fresh(t);
  await account('no-recovery@example.com');
  const before = (await mails()).length;
  assert.equal(
    await startEmailRecovery(db, sealing, {
      signInEmail: 'nobody@example.com',
      secret,
    }),
    'sent',
  );
  assert.equal(
    await startEmailRecovery(db, sealing, {
      signInEmail: 'no-recovery@example.com',
      secret,
    }),
    'sent',
  );
  assert.equal((await mails()).length, before, 'no email at all');
});

test('a recovery waits 24 hours, tells the old address, and any session can cancel it', async (t) => {
  const { db, account, addRecovery, recover, mails } = await fresh(t);
  const userId = await account('me@example.com');
  await addRecovery(userId, 'safe@example.com');
  const result = await recover(
    'me@example.com',
    'safe@example.com',
    'new@example.com',
  );
  assert.equal(result.status, 'pending');
  assert.ok(result.effectiveAt.getTime() > Date.now() + 23 * 3_600_000);
  const notice = (await mails()).find(
    (m) => m.type === 'recovery_started_notice',
  );
  assert.equal(notice.to, 'me@example.com');
  assert.deepEqual(
    (await pendingEmailRecoveries(db, userId)).map((r) => r.newEmailHint),
    ['n•••@example.com'],
  );
  assert.equal(
    await completeDueRecoveries(db, sealing, new Date()),
    0,
    'not yet',
  );
  assert.equal(await cancelEmailRecoveries(db, userId), 1);
  assert.equal(
    await completeDueRecoveries(
      db,
      sealing,
      new Date(Date.now() + 25 * 3_600_000),
    ),
    0,
    'cancelled',
  );
  assert.deepEqual(await pendingEmailRecoveries(db, userId), []);
});

test('completion moves the sign-in email, notifies both addresses and ends sessions', async (t) => {
  const { db, account, addRecovery, recover, mails, rows } = await fresh(t);
  const userId = await account('me@example.com');
  await addRecovery(userId, 'safe@example.com');
  const live = await createSession(db, { userId, deviceLabel: 'Old phone' });
  await recover('me@example.com', 'safe@example.com', 'new@example.com');
  const later = new Date(Date.now() + 25 * 3_600_000);
  assert.equal(await completeDueRecoveries(db, sealing, later), 1);
  const [row] = await rows('SELECT email FROM users WHERE id = $1', [userId]);
  assert.equal(row.email, 'new@example.com');
  assert.equal(await resolveSession(db, live.token, new Date()), null);
  const notices = (await mails())
    .filter((m) => m.type === 'recovery_completed_notice')
    .map((m) => m.to)
    .sort();
  assert.deepEqual(notices, ['me@example.com', 'new@example.com']);
  assert.equal(await completeDueRecoveries(db, sealing, later), 0, 'only once');
});

test('a recovery code alone proves nothing about the new address', async (t) => {
  const { db, account, addRecovery, codeTo } = await fresh(t);
  const userId = await account('me@example.com');
  await addRecovery(userId, 'safe@example.com');
  await startEmailRecovery(db, sealing, {
    signInEmail: 'me@example.com',
    secret,
  });
  assert.equal(
    await proposeRecoveredEmail(db, sealing, {
      signInEmail: 'me@example.com',
      recoveryCode: '000000',
      newEmail: 'evil@example.com',
      secret,
    }),
    'invalid',
  );
  await proposeRecoveredEmail(db, sealing, {
    signInEmail: 'me@example.com',
    recoveryCode: await codeTo('safe@example.com', 'recovery_code'),
    newEmail: 'new@example.com',
    secret,
  });
  // A code for a different address than the one proposed doesn't confirm it.
  assert.equal(
    (
      await confirmRecoveredEmail(db, sealing, {
        signInEmail: 'me@example.com',
        newEmail: 'evil@example.com',
        code: await codeTo('new@example.com', 'recovery_new_email_code'),
        secret,
      })
    ).status,
    'invalid',
  );
});

test('recovery to an address already on another account is refused', async (t) => {
  const { db, account, addRecovery, codeTo } = await fresh(t);
  await account('taken@example.com');
  const userId = await account('me@example.com');
  await addRecovery(userId, 'safe@example.com');
  await startEmailRecovery(db, sealing, {
    signInEmail: 'me@example.com',
    secret,
  });
  await proposeRecoveredEmail(db, sealing, {
    signInEmail: 'me@example.com',
    recoveryCode: await codeTo('safe@example.com', 'recovery_code'),
    newEmail: 'taken@example.com',
    secret,
  });
  const code = (await queuedMail(db, sealing, { limit: 100 })).find(
    (m) => m.to === 'taken@example.com' && m.type === 'recovery_new_email_code',
  ).data.code;
  assert.equal(
    (
      await confirmRecoveredEmail(db, sealing, {
        signInEmail: 'me@example.com',
        newEmail: 'taken@example.com',
        code,
        secret,
      })
    ).status,
    'invalid',
  );
});

test('staff recovery records the checks, the same hold applies, and staff accounts are refused', async (t) => {
  const { db, account, codeTo, rows } = await fresh(t);
  const userId = await account('lost@example.com');
  const input = {
    staffUserId: STAFF,
    secret,
    newEmail: 'found@example.com',
    checks: 'Matched their last three tips and government ID',
    reason: 'Lost access to their email after a job change',
  };
  assert.equal(
    await startStaffRecovery(db, sealing, { ...input, userId }),
    'code_sent',
  );
  const [audit] = await rows(
    `SELECT reason FROM audit_events WHERE action = 'account.staff_recovery_started'`,
  );
  assert.match(audit.reason, /Matched their last three tips/);
  const result = await confirmRecoveredEmail(db, sealing, {
    signInEmail: 'lost@example.com',
    newEmail: 'found@example.com',
    code: await codeTo('found@example.com', 'recovery_new_email_code'),
    secret,
  });
  assert.equal(result.status, 'pending');
  assert.equal(
    await completeDueRecoveries(
      db,
      sealing,
      new Date(Date.now() + 25 * 3_600_000),
    ),
    1,
  );
  const owner = await grantOwner(db, { email: 'staffer@example.com' });
  assert.equal(
    await startStaffRecovery(db, sealing, { ...input, userId: owner.userId }),
    'staff_account',
  );
});

test('staff accounts are never recovered by email', async (t) => {
  const { db, mails, account, addRecovery, pool } = await fresh(t);
  const userId = await account('owner@example.com');
  await addRecovery(userId, 'safe@example.com');
  await grantOwner(db, { email: 'owner@example.com' });
  const before = (await mails()).length;
  await startEmailRecovery(db, sealing, {
    signInEmail: 'owner@example.com',
    secret,
  });
  assert.equal((await mails()).length, before);
  void pool;
});

test('the reminder shows until a recovery email is confirmed', async (t) => {
  const { db, account, addRecovery } = await fresh(t);
  const userId = await account('me@example.com');
  assert.equal(await needsRecoveryEmail(db, userId), true);
  await addRecovery(userId, 'safe@example.com');
  assert.equal(await needsRecoveryEmail(db, userId), false);
});
