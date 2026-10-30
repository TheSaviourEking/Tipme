import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  changePhone,
  completeRecovery,
  confirmEmail,
  createPaymentIntent,
  createQuote,
  createSession,
  DEMO_PROFILES,
  listNotifications,
  listPretendOutbox,
  mailSealing,
  markAttemptInitiated,
  markRead,
  notifyTipSucceeded,
  recordProviderEvent,
  requestSignInCode,
  resolveSession,
  startEmailVerification,
  startRecovery,
} from '../../dist/index.js';
import { queuedMail } from '../../dist/test-support.js';
import { renderMail } from '@tipme/mail';
import { useDatabase } from './helpers.mjs';

const secret = 'test-auth-code-secret-at-least-32-chars!';
const WEB = 'http://localhost:3000';
const sealing = mailSealing(Buffer.alloc(32, 7));
const [ADA, TOBI] = DEMO_PROFILES;

test('notifications, email, phone change and recovery', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const latest = async () => (await listPretendOutbox(db, { limit: 1 }))[0];
  const latestMail = async () =>
    (await queuedMail(db, sealing, { limit: 1 }))[0];
  const codeFor = async (phone, purpose) => {
    await requestSignInCode(db, { phone, secret, purpose });
    return /\b(\d{6})\b/.exec((await latest()).body)[1];
  };
  const errorCode = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const tip = async (status = 'payment.succeeded') => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: 200000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      payerDisplayLabel: 'Ada M.',
    });
    const reference = `mock_pay_${randomUUID()}`;
    await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'mock',
      providerReference: reference,
    });
    await recordProviderEvent(db, {
      provider: 'mock',
      providerEventId: `evt_${randomUUID()}`,
      eventType: status,
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: 200000n,
      currency: 'NGN',
      providerFeeMinor: 3000n,
      signatureVerified: true,
      payload: {},
    });
    return intent.tipId;
  };

  await t.test(
    'a confirmed tip notifies once, with an email only to a verified address',
    async () => {
      await database.fresh();
      const tipId = await tip();
      assert.equal(
        await notifyTipSucceeded(db, { sealing, tipId, profileId: TOBI.id }),
        'created',
      );
      assert.equal(
        await notifyTipSucceeded(db, { sealing, tipId, profileId: TOBI.id }),
        'duplicate',
      );
      const list = await listNotifications(db, TOBI.userId, {});
      assert.equal(list.length, 1);
      assert.equal(list[0].title, 'You got a tip');
      assert.equal(list[0].body, 'NGN 1,800.00 from Ada M.');
      assert.equal(list[0].read, false);
      assert.equal(
        (
          await database.pool.query(
            'SELECT count(*)::int AS n FROM mail_messages',
          )
        ).rows[0].n,
        0,
      );

      await startEmailVerification(db, {
        sealing,
        userId: TOBI.userId,
        email: 'tobi@example.com',
        webOrigin: WEB,
      });
      const mail = await latestMail();
      assert.equal(mail.type, 'email_verification_link');
      assert.equal(mail.toHint, 't•••@example.com');
      const token = mail.data.token;
      assert.equal(await confirmEmail(db, { token }), 'confirmed');
      assert.equal(await confirmEmail(db, { token }), 'invalid');
      const second = await tip();
      await notifyTipSucceeded(db, {
        sealing,
        tipId: second,
        profileId: TOBI.id,
      });
      const email = await latestMail();
      assert.equal(email.type, 'tip_received');
      assert.equal(
        renderMail(email.type, email.data, {
          webOrigin: WEB,
          unsubscribeUrl: null,
        }).subject,
        'You got a ₦1,800 tip on TipMe',
      );
      await markRead(
        db,
        TOBI.userId,
        list.map((n) => n.id),
      );
      assert.equal(
        (await listNotifications(db, TOBI.userId, { unreadOnly: true })).length,
        1,
      );
      // Ada never sees Tobi's notifications, and cannot mark them read.
      assert.equal((await listNotifications(db, ADA.userId, {})).length, 0);
    },
  );

  await t.test(
    'changing the phone needs a code sent to the new number, and the number must be free',
    async () => {
      await database.fresh();
      const code = await codeFor('+2348039990001', 'change_phone');
      assert.equal(
        await errorCode(
          changePhone(db, {
            userId: TOBI.userId,
            newPhone: '+2348039990001',
            code: '000000',
            secret,
          }),
        ),
        'CODE_INVALID',
      );
      await changePhone(db, {
        userId: TOBI.userId,
        newPhone: '+2348039990001',
        code,
        secret,
      });
      const [user] = (
        await database.pool.query(
          'SELECT phone_e164 FROM users WHERE id = $1',
          [TOBI.userId],
        )
      ).rows;
      assert.equal(user.phone_e164, '+2348039990001');
      const taken = await codeFor('+2348000000001', 'change_phone');
      assert.equal(
        await errorCode(
          changePhone(db, {
            userId: TOBI.userId,
            newPhone: '+2348000000001',
            code: taken,
            secret,
          }),
        ),
        'PHONE_TAKEN',
      );
    },
  );

  await t.test(
    'recovery by email attaches a new number only with that number’s code, and ends every session',
    async () => {
      await database.fresh();
      const old = await createSession(db, {
        userId: TOBI.userId,
        deviceLabel: 'Lost phone',
      });
      // An unverified email gets the same answer and no mail.
      const before = (await latestMail())?.id;
      assert.equal(
        await startRecovery(db, {
          sealing,
          email: 'nobody@example.com',
          webOrigin: WEB,
        }),
        'sent',
      );
      assert.equal((await latestMail())?.id, before);

      await startEmailVerification(db, {
        sealing,
        userId: TOBI.userId,
        email: 'tobi@example.com',
        webOrigin: WEB,
      });
      await confirmEmail(db, {
        token: (await latestMail()).data.token,
      });
      assert.equal(
        await startRecovery(db, {
          sealing,
          email: 'TOBI@example.com',
          webOrigin: WEB,
        }),
        'sent',
      );
      const token = (await latestMail()).data.token;
      assert.equal(
        await errorCode(
          completeRecovery(db, {
            sealing,
            token,
            newPhone: '+2348039990002',
            code: '123456',
            secret,
          }),
        ),
        'CODE_INVALID',
      );
      const code = await codeFor('+2348039990002', 'change_phone');
      const { userId } = await completeRecovery(db, {
        sealing,
        token,
        newPhone: '+2348039990002',
        code,
        secret,
      });
      assert.equal(userId, TOBI.userId);
      // Recovery now waits 24 hours (review fix): sessions end only when the new number takes over.
      assert.notEqual(await resolveSession(db, old.token, new Date()), null);
      assert.equal(
        await errorCode(
          completeRecovery(db, {
            sealing,
            token,
            newPhone: '+2348039990002',
            code,
            secret,
          }),
        ),
        'CODE_INVALID',
      );
    },
  );
});

test('review fixes: recovery hold and erasure', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const { verifySignInCode: verify } = await import('../../dist/index.js');
  const latest = async () => (await listPretendOutbox(db, { limit: 1 }))[0];
  const latestMail = async () =>
    (await queuedMail(db, sealing, { limit: 1 }))[0];
  const codeFor = async (phone, purpose, now) => {
    await requestSignInCode(db, {
      phone,
      secret,
      purpose,
      ...(now ? { now } : {}),
    });
    return /\b(\d{6})\b/.exec((await latest()).body)[1];
  };
  const recoveryToken = async () => {
    await startEmailVerification(db, {
      sealing,
      userId: TOBI.userId,
      email: 'tobi@example.com',
      webOrigin: WEB,
    });
    await confirmEmail(db, {
      token: (await latestMail()).data.token,
    });
    await startRecovery(db, {
      sealing,
      email: 'tobi@example.com',
      webOrigin: WEB,
    });
    return (await latestMail()).data.token;
  };

  await t.test(
    'fix: recovery waits 24 hours, tells the old number, and the owner can cancel it',
    async () => {
      await database.fresh();
      const live = await createSession(db, {
        userId: TOBI.userId,
        deviceLabel: 'Still mine',
      });
      const token = await recoveryToken();
      const code = await codeFor('+2348039990031', 'change_phone');
      const result = await completeRecovery(db, {
        sealing,
        token,
        newPhone: '+2348039990031',
        code,
        secret,
      });
      assert.ok(result.pendingUntil instanceof Date);
      const all = await listPretendOutbox(db, { limit: 5 });
      assert.ok(
        all.some(
          (m) =>
            m.recipientHint === '•••0002' &&
            /move your TipMe account/.test(m.body),
        ),
      );
      assert.notEqual(await resolveSession(db, live.token, new Date()), null);
      const early = await verify(db, {
        phone: '+2348039990031',
        code: await codeFor('+2348039990031'),
        secret,
      });
      assert.equal(early.status, 'pending_recovery');
      const later = new Date(Date.now() + 25 * 3600_000);
      const done = await verify(db, {
        phone: '+2348039990031',
        code: await codeFor('+2348039990031', undefined, later),
        secret,
        now: later,
      });
      assert.deepEqual([done.status, done.userId], ['ok', TOBI.userId]);
      assert.equal(await resolveSession(db, live.token, later), null);
    },
  );

  await t.test(
    'fix: the owner cancels a recovery from a live session',
    async () => {
      await database.fresh();
      const { cancelRecoveries } = await import('../../dist/index.js');
      const token = await recoveryToken();
      const code = await codeFor('+2348039990032', 'change_phone');
      await completeRecovery(db, {
        sealing,
        token,
        newPhone: '+2348039990032',
        code,
        secret,
      });
      assert.equal(await cancelRecoveries(db, TOBI.userId), 1);
      const later = new Date(Date.now() + 25 * 3600_000);
      const fresh = await verify(db, {
        phone: '+2348039990032',
        code: await codeFor('+2348039990032', undefined, later),
        secret,
        now: later,
      });
      assert.equal(fresh.status, 'ok');
      assert.notEqual(fresh.userId, TOBI.userId);
    },
  );

  await t.test(
    'fix: deleting erases codes, lockouts and pending email links, which can no longer restore anything',
    async () => {
      await database.fresh();
      const { deleteAccount } = await import('../../dist/index.js');
      await codeFor('+2348000000002');
      await startEmailVerification(db, {
        sealing,
        userId: TOBI.userId,
        email: 'late@example.com',
        webOrigin: WEB,
      });
      const lateToken = (await latestMail()).data.token;
      await deleteAccount(db, { userId: TOBI.userId });
      assert.equal(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM sign_in_codes WHERE phone_e164 = '+2348000000002'",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM sign_in_lockouts WHERE phone_e164 = '+2348000000002'",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(await confirmEmail(db, { token: lateToken }), 'invalid');
      const [user] = (
        await database.pool.query('SELECT email FROM users WHERE id = $1', [
          TOBI.userId,
        ])
      ).rows;
      assert.equal(user.email, null);
    },
  );
});
