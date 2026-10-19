import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  listPretendOutbox,
  normalisePhone,
  requestSignInCode,
  verifySignInCode,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const secret = 'test-auth-code-secret-at-least-32-chars!';
const codeFrom = (row) => /\b(\d{6})\b/.exec(row.body)?.[1];

test('phone numbers normalise to one identity', () => {
  assert.equal(normalisePhone('0803 123 4567'), '+2348031234567');
  assert.equal(normalisePhone('+234 803 123 4567'), '+2348031234567');
  assert.equal(normalisePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalisePhone('12'), null);
  assert.equal(normalisePhone('not a phone'), null);
});

test('sign-in codes', async (t) => {
  const database = await useDatabase(t);
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const t0 = new Date('2026-10-19T10:00:00Z');
  const at = (minutes) => new Date(t0.getTime() + minutes * 60_000);
  const latestCode = async () =>
    codeFrom((await listPretendOutbox(database.db, { limit: 1 }))[0]);

  await t.test(
    'a code goes by WhatsApp, or SMS when WhatsApp fails, and is stored hashed',
    async () => {
      await database.fresh();
      assert.deepEqual(
        await requestSignInCode(database.db, {
          phone: '0803 123 4567',
          secret,
          now: t0,
        }),
        { status: 'sent' },
      );
      const [message] = await listPretendOutbox(database.db, { limit: 5 });
      assert.equal(message.channel, 'whatsapp');
      assert.equal(message.recipientHint, '•••4567');
      const code = codeFrom(message);
      assert.match(code, /^\d{6}$/);
      const stored = await q('SELECT code_hmac, phone_e164 FROM sign_in_codes');
      assert.equal(stored.length, 1);
      assert.notEqual(stored[0].code_hmac, code);
      assert.doesNotMatch(stored[0].code_hmac, new RegExp(code));
      await requestSignInCode(database.db, {
        phone: '08031234567',
        secret,
        now: at(1),
        simulateWhatsappFailure: true,
      });
      const channels = (await listPretendOutbox(database.db, { limit: 5 })).map(
        (row) => row.channel,
      );
      assert.deepEqual(channels.slice(0, 2), ['sms', 'whatsapp']);
    },
  );

  await t.test(
    'the right code signs in, creating the account once',
    async () => {
      await database.fresh();
      await requestSignInCode(database.db, {
        phone: '+2348031234567',
        secret,
        now: t0,
      });
      const first = await verifySignInCode(database.db, {
        phone: '0803 123 4567',
        code: await latestCode(),
        secret,
        now: at(1),
      });
      assert.equal(first.status, 'ok');
      assert.equal(first.created, true);
      await requestSignInCode(database.db, {
        phone: '+2348031234567',
        secret,
        now: at(2),
      });
      const second = await verifySignInCode(database.db, {
        phone: '+2348031234567',
        code: await latestCode(),
        secret,
        now: at(3),
      });
      assert.deepEqual(
        [second.status, second.created, second.userId],
        ['ok', false, first.userId],
      );
      assert.equal(
        (
          await q(
            'SELECT count(*)::int AS n FROM users WHERE phone_e164 = $1',
            ['+2348031234567'],
          )
        )[0].n,
        1,
      );
      // A used code cannot be used again.
      assert.equal(
        (
          await verifySignInCode(database.db, {
            phone: '+2348031234567',
            code: await latestCode(),
            secret,
            now: at(4),
          })
        ).status,
        'invalid',
      );
    },
  );

  await t.test(
    'codes expire after 10 minutes and only the latest counts',
    async () => {
      await database.fresh();
      await requestSignInCode(database.db, {
        phone: '+2348031234567',
        secret,
        now: t0,
      });
      const old = await latestCode();
      assert.equal(
        (
          await verifySignInCode(database.db, {
            phone: '+2348031234567',
            code: old,
            secret,
            now: at(11),
          })
        ).status,
        'expired',
      );
      await requestSignInCode(database.db, {
        phone: '+2348031234567',
        secret,
        now: at(12),
      });
      const fresh = await latestCode();
      if (old !== fresh)
        assert.equal(
          (
            await verifySignInCode(database.db, {
              phone: '+2348031234567',
              code: old,
              secret,
              now: at(13),
            })
          ).status,
          'invalid',
        );
      assert.equal(
        (
          await verifySignInCode(database.db, {
            phone: '+2348031234567',
            code: fresh,
            secret,
            now: at(13),
          })
        ).status,
        'ok',
      );
    },
  );

  await t.test('three codes an hour per number', async () => {
    await database.fresh();
    for (let i = 0; i < 3; i += 1)
      assert.equal(
        (
          await requestSignInCode(database.db, {
            phone: '+2348031234567',
            secret,
            now: at(i),
          })
        ).status,
        'sent',
      );
    assert.equal(
      (
        await requestSignInCode(database.db, {
          phone: '+2348031234567',
          secret,
          now: at(5),
        })
      ).status,
      'rate_limited',
    );
    assert.equal(
      (
        await requestSignInCode(database.db, {
          phone: '+2348031234567',
          secret,
          now: at(61),
        })
      ).status,
      'sent',
    );
  });

  await t.test('five wrong codes lock the number for 15 minutes', async () => {
    await database.fresh();
    await requestSignInCode(database.db, {
      phone: '+2348031234567',
      secret,
      now: t0,
    });
    const code = await latestCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1)
      assert.equal(
        (
          await verifySignInCode(database.db, {
            phone: '+2348031234567',
            code: wrong,
            secret,
            now: at(1),
          })
        ).status,
        'invalid',
      );
    assert.equal(
      (
        await verifySignInCode(database.db, {
          phone: '+2348031234567',
          code: wrong,
          secret,
          now: at(1),
        })
      ).status,
      'locked',
    );
    assert.equal(
      (
        await verifySignInCode(database.db, {
          phone: '+2348031234567',
          code,
          secret,
          now: at(2),
        })
      ).status,
      'locked',
    );
    assert.equal(
      (
        await requestSignInCode(database.db, {
          phone: '+2348031234567',
          secret,
          now: at(3),
        })
      ).status,
      'locked',
    );
    await requestSignInCode(database.db, {
      phone: '+2348031234567',
      secret,
      now: at(17),
    });
    assert.equal(
      (
        await verifySignInCode(database.db, {
          phone: '+2348031234567',
          code: await latestCode(),
          secret,
          now: at(18),
        })
      ).status,
      'ok',
    );
  });

  await t.test(
    'an unknown number gets the same answer and no account until verified',
    async () => {
      await database.fresh();
      assert.deepEqual(
        await requestSignInCode(database.db, {
          phone: '+2348039999999',
          secret,
          now: t0,
        }),
        { status: 'sent' },
      );
      assert.equal(
        (
          await q(
            'SELECT count(*)::int AS n FROM users WHERE phone_e164 = $1',
            ['+2348039999999'],
          )
        )[0].n,
        0,
      );
    },
  );
});
