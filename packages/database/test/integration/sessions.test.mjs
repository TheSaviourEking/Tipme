import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createSession,
  listPretendOutbox,
  listSessions,
  requestSignInCode,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  verifySignInCode,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const secret = 'test-auth-code-secret-at-least-32-chars!';

test('sessions', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const t0 = new Date('2026-10-19T10:00:00Z');
  const days = (n) => new Date(t0.getTime() + n * 86_400_000);
  await requestSignInCode(database.db, {
    phone: '+2348031234567',
    secret,
    now: t0,
  });
  const code = /\b(\d{6})\b/.exec(
    (await listPretendOutbox(database.db, { limit: 1 }))[0].body,
  )[1];
  const { userId } = await verifySignInCode(database.db, {
    phone: '+2348031234567',
    code,
    secret,
    now: t0,
  });

  await t.test(
    'only the token hash is stored, and a session ends 30 days after sign-in however often it is used',
    async () => {
      const { token, expiresAt } = await createSession(database.db, {
        userId,
        deviceLabel: 'Chrome on Android',
        now: t0,
      });
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(expiresAt.getTime(), days(30).getTime());
      const rows = await q('SELECT token_sha256 FROM sessions');
      assert.equal(
        rows[0].token_sha256,
        createHash('sha256').update(token).digest('hex'),
      );
      assert.equal(JSON.stringify(rows).includes(token), false);
      // Used every day (as a stolen token replayed by hand would be): it still ends on day 30,
      // when the browser's cookie does.
      for (const day of [1, 10, 20, 29])
        assert.equal(
          (await resolveSession(database.db, token, days(day)))?.userId,
          userId,
        );
      const [after] = await q('SELECT expires_at, last_seen_at FROM sessions');
      assert.equal(after.expires_at.getTime(), days(30).getTime());
      assert.equal(after.last_seen_at.getTime(), days(29).getTime());
      assert.equal(await resolveSession(database.db, token, days(31)), null);
      assert.equal(await resolveSession(database.db, 'not-a-token', t0), null);
    },
  );

  await t.test(
    'sessions can be listed and revoked, one or all but this one',
    async () => {
      const a = await createSession(database.db, {
        userId,
        deviceLabel: 'Phone',
        now: t0,
      });
      const b = await createSession(database.db, {
        userId,
        deviceLabel: 'Laptop',
        now: t0,
      });
      const c = await createSession(database.db, {
        userId,
        deviceLabel: 'Tablet',
        now: t0,
      });
      const listed = await listSessions(database.db, userId, t0);
      assert.ok(listed.length >= 3);
      assert.ok(listed.every((s) => !('tokenSha256' in s) && !('token' in s)));
      const sessionB = (await resolveSession(database.db, b.token, t0))
        .sessionId;
      await revokeSession(database.db, { userId, sessionId: sessionB });
      assert.equal(await resolveSession(database.db, b.token, t0), null);
      const sessionA = (await resolveSession(database.db, a.token, t0))
        .sessionId;
      await revokeAllSessions(database.db, {
        userId,
        exceptSessionId: sessionA,
      });
      assert.notEqual(await resolveSession(database.db, a.token, t0), null);
      assert.equal(await resolveSession(database.db, c.token, t0), null);
    },
  );

  await t.test('another user cannot revoke your session', async () => {
    const mine = await createSession(database.db, {
      userId,
      deviceLabel: 'Phone',
      now: t0,
    });
    const sessionId = (await resolveSession(database.db, mine.token, t0))
      .sessionId;
    await revokeSession(database.db, {
      userId: '00000000-0000-7000-8000-000000000000',
      sessionId,
    });
    assert.notEqual(await resolveSession(database.db, mine.token, t0), null);
  });
});
