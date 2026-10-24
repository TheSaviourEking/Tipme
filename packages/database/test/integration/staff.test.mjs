import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { totpAt } from '@tipme/domain';
import {
  changePhone,
  confirmTotpEnrolment,
  createSession,
  grantOwner,
  listAudit,
  listPretendOutbox,
  openOpsGrant,
  openSecret,
  recordAudit,
  requestSignInCode,
  resolveOpsGrant,
  revokeSession,
  sealSecret,
  staffPermissions,
  startRecovery,
  startTotpEnrolment,
  verifySignInCode,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const key = randomBytes(32);
const secret = 'test-auth-code-secret-at-least-32-chars!';
const OWNER_PHONE = '+2348035550101';
const t0 = new Date('2026-10-19T10:00:00Z');
const at = (ms) => new Date(t0.getTime() + ms);
const MIN = 60_000;
const stepOf = (now) => BigInt(Math.floor(now.getTime() / 30_000));
const codeAt = (totpSecret, now) => totpAt(totpSecret, stepOf(now));

async function signInUser(db, phone, now = t0) {
  await requestSignInCode(db, { phone, secret, now });
  const code = /\b(\d{6})\b/.exec(
    (await listPretendOutbox(db, { limit: 1 }))[0].body,
  )[1];
  const { userId } = await verifySignInCode(db, { phone, code, secret, now });
  const { sessionId } = await createSession(db, {
    userId,
    deviceLabel: 'test',
    now,
  });
  return { userId, sessionId };
}

/** Owner granted, enrolled and confirmed; returns the authenticator secret. */
async function enrolledOwner(db, now = t0) {
  const { userId, enrolmentCode } = await grantOwner(db, {
    phone: OWNER_PHONE,
    now,
  });
  const { sessionId } = await signInUser(db, OWNER_PHONE, now);
  const { secret: totp } = await startTotpEnrolment(db, {
    userId,
    enrolmentCode,
    key,
    now,
  });
  assert.equal(
    (
      await confirmTotpEnrolment(db, {
        userId,
        code: codeAt(totp, now),
        key,
        now,
      })
    ).status,
    'ok',
  );
  return { userId, sessionId, totp };
}

test('staff access', async (t) => {
  const database = await useDatabase(t);
  const q = (text, params) =>
    database.pool.query(text, params).then((r) => r.rows);

  await t.test(
    'sealed secrets round-trip and never contain the plain text',
    () => {
      const sealed = sealSecret(key, 'GEZDGNBVGY3TQOJQ');
      assert.match(
        sealed,
        /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
      assert.equal(sealed.includes('GEZDGNBVGY3TQOJQ'), false);
      assert.equal(openSecret(key, sealed), 'GEZDGNBVGY3TQOJQ');
      assert.throws(() => openSecret(randomBytes(32), sealed));
    },
  );

  await t.test(
    'the grant prints a one-time enrolment code valid 30 minutes',
    async () => {
      await database.fresh();
      const { userId, enrolmentCode } = await grantOwner(database.db, {
        phone: '0803 555 0101',
      });
      assert.match(enrolmentCode, /^[A-Z2-7]{10}$/);
      const [stored] = await q('SELECT code_sha256 FROM staff_enrolments');
      assert.equal(
        stored.code_sha256,
        createHash('sha256').update(enrolmentCode).digest('hex'),
      );
      assert.equal(
        (await staffPermissions(database.db, userId)).size,
        11,
        'Owner holds every permission',
      );
      await assert.rejects(
        startTotpEnrolment(database.db, {
          userId,
          enrolmentCode: 'AAAAAAAAAA',
          key,
          now: t0,
        }),
        { code: 'ENROLMENT_INVALID' },
      );
      await assert.rejects(
        startTotpEnrolment(database.db, {
          userId,
          enrolmentCode,
          key,
          now: new Date(Date.now() + 31 * MIN),
        }),
        { code: 'ENROLMENT_INVALID' },
      );
      const started = await startTotpEnrolment(database.db, {
        userId,
        enrolmentCode,
        key,
      });
      assert.match(started.secret, /^[A-Z2-7]{32}$/);
      assert.match(started.otpauthUrl, /^otpauth:\/\/totp\//);
      const [row] = await q('SELECT secret_enc, confirmed_at FROM staff_totp');
      assert.equal(row.secret_enc.includes(started.secret), false);
      assert.equal(row.confirmed_at, null);
      await assert.rejects(
        startTotpEnrolment(database.db, { userId, enrolmentCode, key }),
        { code: 'ENROLMENT_INVALID' },
        'the code works once',
      );
      const now = new Date();
      assert.equal(
        (
          await confirmTotpEnrolment(database.db, {
            userId,
            code:
              '000000' === codeAt(started.secret, now) ? '111111' : '000000',
            key,
            now,
          })
        ).status,
        'invalid',
      );
      assert.equal(
        (
          await confirmTotpEnrolment(database.db, {
            userId,
            code: codeAt(started.secret, now),
            key,
            now,
          })
        ).status,
        'ok',
      );
    },
  );

  await t.test(
    'a grant needs a fresh code; the same code twice is refused',
    async () => {
      await database.fresh();
      const { userId, sessionId, totp } = await enrolledOwner(database.db);
      const later = at(2 * MIN);
      const code = codeAt(totp, later);
      const opened = await openOpsGrant(database.db, {
        userId,
        sessionId,
        code,
        key,
        now: later,
      });
      assert.equal(opened.status, 'ok');
      assert.match(opened.token, /^[A-Za-z0-9_-]{43}$/);
      const [row] = await q('SELECT token_sha256 FROM ops_sessions');
      assert.equal(
        row.token_sha256,
        createHash('sha256').update(opened.token).digest('hex'),
      );
      assert.equal(
        (
          await openOpsGrant(database.db, {
            userId,
            sessionId,
            code,
            key,
            now: later,
          })
        ).status,
        'invalid',
      );
      const audit = await listAudit(database.db, { limit: 10 });
      assert.ok(audit.some((e) => e.action === 'ops.grant_opened'));
    },
  );

  await t.test('five wrong codes lock ops access for 15 minutes', async () => {
    await database.fresh();
    const { userId, sessionId, totp } = await enrolledOwner(database.db);
    const now = at(2 * MIN);
    const wrong = codeAt(totp, now) === '000000' ? '111111' : '000000';
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(
        (
          await openOpsGrant(database.db, {
            userId,
            sessionId,
            code: wrong,
            key,
            now,
          })
        ).status,
      );
    assert.deepEqual(results, [
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'locked',
    ]);
    const during = at(10 * MIN);
    assert.equal(
      (
        await openOpsGrant(database.db, {
          userId,
          sessionId,
          code: codeAt(totp, during),
          key,
          now: during,
        })
      ).status,
      'locked',
    );
    const afterLock = at(18 * MIN);
    assert.equal(
      (
        await openOpsGrant(database.db, {
          userId,
          sessionId,
          code: codeAt(totp, afterLock),
          key,
          now: afterLock,
        })
      ).status,
      'ok',
    );
  });

  await t.test(
    'fix: wrong codes sent in parallel still lock after five (final review)',
    async () => {
      await database.fresh();
      const { userId, sessionId, totp } = await enrolledOwner(database.db);
      const now = at(2 * MIN);
      const wrong = codeAt(totp, now) === '000000' ? '111111' : '000000';
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          openOpsGrant(database.db, {
            userId,
            sessionId,
            code: wrong,
            key,
            now,
          }).then((r) => r.status),
        ),
      );
      assert.equal(results.filter((r) => r === 'invalid').length, 4);
      assert.equal(results.filter((r) => r === 'locked').length, 6);
    },
  );

  await t.test('a non-staff user gets not_staff', async () => {
    await database.fresh();
    const { userId, sessionId } = await signInUser(
      database.db,
      '+2348035550199',
    );
    assert.equal(await staffPermissions(database.db, userId), null);
    assert.equal(
      (
        await openOpsGrant(database.db, {
          userId,
          sessionId,
          code: '123456',
          key,
          now: t0,
        })
      ).status,
      'not_staff',
    );
  });

  await t.test(
    'a grant ends after 1 hour idle, 12 hours in all, with its recipient session, or on another session',
    async () => {
      await database.fresh();
      const { userId, sessionId, totp } = await enrolledOwner(database.db);
      const open = async (now) => {
        const result = await openOpsGrant(database.db, {
          userId,
          sessionId,
          code: codeAt(totp, now),
          key,
          now,
        });
        assert.equal(result.status, 'ok');
        return result.token;
      };
      const resolve = (token, now, session = sessionId) =>
        resolveOpsGrant(database.db, { token, sessionId: session, now });

      // Idle: used at +50 min keeps it alive; then 61 minutes of silence ends it.
      let token = await open(at(MIN));
      const ok = await resolve(token, at(50 * MIN));
      assert.equal(ok.userId, userId);
      assert.ok(ok.permissions.has('issues.view'));
      assert.equal(await resolve(token, at(111 * MIN + 1)), null);

      // Absolute: kept busy every 50 minutes, it still ends 12 hours after opening.
      const start = at(3 * 60 * MIN);
      token = await open(start);
      for (let m = 50; m < 12 * 60; m += 50)
        assert.ok(
          await resolve(token, new Date(start.getTime() + m * MIN)),
          `alive at ${m} min`,
        );
      assert.equal(
        await resolve(token, new Date(start.getTime() + 12 * 60 * MIN + 1)),
        null,
      );

      // Another recipient session cannot carry it.
      const later = at(20 * 60 * MIN);
      token = await open(later);
      const other = await signInUser(database.db, '+2348035550198', later);
      assert.equal(await resolve(token, later, other.sessionId), null);

      // Signing out ends it (Review Focus 1).
      assert.ok(await resolve(token, later));
      await revokeSession(database.db, { userId, sessionId, now: later });
      assert.equal(await resolve(token, later), null);
    },
  );

  await t.test('staff accounts get no recovery email', async () => {
    await database.fresh();
    const { userId } = await enrolledOwner(database.db);
    await q(
      `UPDATE users SET email = 'owner@example.com', email_verified_at = now() WHERE id = $1`,
      [userId],
    );
    const before = (await listPretendOutbox(database.db, { limit: 50 })).length;
    assert.equal(
      await startRecovery(database.db, {
        email: 'owner@example.com',
        webOrigin: 'http://127.0.0.1:3100',
      }),
      'sent',
    );
    assert.equal(
      (await listPretendOutbox(database.db, { limit: 50 })).length,
      before,
    );
  });

  await t.test(
    'a phone change removes the authenticator and every grant',
    async () => {
      await database.fresh();
      const { userId, sessionId, totp } = await enrolledOwner(database.db);
      const now = at(2 * MIN);
      const opened = await openOpsGrant(database.db, {
        userId,
        sessionId,
        code: codeAt(totp, now),
        key,
        now,
      });
      await requestSignInCode(database.db, {
        phone: '+2348035550111',
        secret,
        purpose: 'change_phone',
      });
      const code = /\b(\d{6})\b/.exec(
        (await listPretendOutbox(database.db, { limit: 1 }))[0].body,
      )[1];
      await changePhone(database.db, {
        userId,
        newPhone: '+2348035550111',
        code,
        secret,
        keepSessionId: sessionId,
      });
      assert.equal(await database.count('staff_totp'), 0);
      assert.equal(
        await resolveOpsGrant(database.db, {
          token: opened.token,
          sessionId,
          now,
        }),
        null,
      );
      assert.equal(
        (
          await openOpsGrant(database.db, {
            userId,
            sessionId,
            code: codeAt(totp, at(5 * MIN)),
            key,
            now: at(5 * MIN),
          })
        ).status,
        'not_staff',
        'not enrolled any more: the grant command must be run again',
      );
    },
  );

  await t.test(
    'audit events are append-only and carry the reason',
    async () => {
      await database.fresh();
      const { userId } = await enrolledOwner(database.db);
      await recordAudit(database.db, {
        staffUserId: userId,
        action: 'issue.resolved',
        permission: 'issues.resolve',
        subjectType: 'issue',
        subjectId: 'x',
        reason: 'Provider confirmed by phone',
      });
      const [latest] = await listAudit(database.db, { limit: 1 });
      assert.equal(latest.reason, 'Provider confirmed by phone');
      assert.equal(latest.staffUserId, userId);
      await assert.rejects(q(`UPDATE audit_events SET reason = 'edited'`));
      await assert.rejects(q('DELETE FROM audit_events'));
    },
  );

  await t.test(
    'a completed phone recovery removes ops access too',
    async () => {
      await database.fresh();
      const { userId } = await enrolledOwner(database.db);
      await q(
        `INSERT INTO phone_recoveries (id, user_id, new_phone_e164, effective_at)
       VALUES (gen_random_uuid(), $1, '+2348035550122', $2)`,
        [userId, at(MIN)],
      );
      await signInUser(database.db, '+2348035550122', at(2 * MIN));
      const [user] = await q('SELECT phone_e164 FROM users WHERE id = $1', [
        userId,
      ]);
      assert.equal(user.phone_e164, '+2348035550122');
      assert.equal(await database.count('staff_totp'), 0);
    },
  );
});
