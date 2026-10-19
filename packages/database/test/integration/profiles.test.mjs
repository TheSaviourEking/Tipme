import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  checkHandle,
  claimHandle,
  createSession,
  createPaymentIntent,
  createQuote,
  deleteAccount,
  getMyProfile,
  listPretendOutbox,
  publicProfile,
  requestSignInCode,
  resolveSession,
  setPageState,
  updateMyProfile,
  verifySignInCode,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const secret = 'test-auth-code-secret-at-least-32-chars!';

test('profiles, handles and page states', async (t) => {
  const database = await useDatabase(t);
  const now = new Date('2026-10-19T10:00:00Z');
  const signUp = async (phone) => {
    await requestSignInCode(database.db, { phone, secret, now: new Date() });
    const code = /\b(\d{6})\b/.exec(
      (await listPretendOutbox(database.db, { limit: 1 }))[0].body,
    )[1];
    return (await verifySignInCode(database.db, { phone, code, secret }))
      .userId;
  };
  const errorCode = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code;
    }
  };

  await t.test(
    'a handle is claimed once, lower case, not live, named after itself',
    async () => {
      await database.fresh();
      const kemi = await signUp('+2348031230001');
      assert.equal(await checkHandle(database.db, 'Kemi', now), 'available');
      await claimHandle(database.db, { userId: kemi, handle: 'Kemi', now });
      const mine = await getMyProfile(database.db, kemi);
      assert.deepEqual(
        [mine.handle, mine.pageState, mine.displayName],
        ['kemi', 'not_live', 'kemi'],
      );
      assert.equal(mine.phone, '+2348031230001');
      assert.equal(await checkHandle(database.db, 'KEMI', now), 'taken');
      assert.equal(
        await checkHandle(database.db, 'dashboard', now),
        'reserved',
      );
      assert.equal(await checkHandle(database.db, 'a-b', now), 'invalid');
      const other = await signUp('+2348031230002');
      assert.equal(
        await errorCode(
          claimHandle(database.db, { userId: other, handle: 'KEMI', now }),
        ),
        'HANDLE_TAKEN',
      );
      assert.equal(
        await errorCode(
          claimHandle(database.db, { userId: other, handle: 'dashboard', now }),
        ),
        'HANDLE_TAKEN',
      );
      assert.equal(
        await errorCode(
          claimHandle(database.db, { userId: kemi, handle: 'kemi2', now }),
        ),
        'ALREADY_HAS_PAGE',
      );
    },
  );

  await t.test(
    'the public page shows only live pages and only public details',
    async () => {
      await database.fresh();
      const kemi = await signUp('+2348031230001');
      await claimHandle(database.db, { userId: kemi, handle: 'kemi', now });
      assert.equal(await publicProfile(database.db, 'kemi'), null);
      await setPageState(database.db, kemi, 'live');
      await updateMyProfile(database.db, kemi, {
        displayName: 'Kemi Bello',
        role: 'Hairdresser at Glow Studio',
        bio: 'Braids and kindness.',
        socials: { instagram: 'https://instagram.com/kemi' },
      });
      let page = await publicProfile(database.db, 'KEMI');
      assert.deepEqual(
        {
          handle: page.handle,
          displayName: page.displayName,
          role: page.role,
          bio: page.bio,
          socials: page.socials,
        },
        {
          handle: 'kemi',
          displayName: 'Kemi Bello',
          role: 'Hairdresser at Glow Studio',
          bio: 'Braids and kindness.',
          socials: { instagram: 'https://instagram.com/kemi' },
        },
      );
      assert.equal('phone' in page, false);
      assert.equal('email' in page, false);
      await updateMyProfile(database.db, kemi, {
        phonePublic: true,
        bioPublic: false,
      });
      page = await publicProfile(database.db, 'kemi');
      assert.equal(page.phone, '+2348031230001');
      assert.equal('bio' in page, false);
      await setPageState(database.db, kemi, 'not_live');
      assert.equal(await publicProfile(database.db, 'kemi'), null);
    },
  );

  await t.test('social links must point at the named sites', async () => {
    await database.fresh();
    const kemi = await signUp('+2348031230001');
    await claimHandle(database.db, { userId: kemi, handle: 'kemi', now });
    assert.equal(
      await errorCode(
        updateMyProfile(database.db, kemi, {
          socials: { instagram: 'https://evil.example/kemi' },
        }),
      ),
      'INVALID_INPUT',
    );
    assert.equal(
      await errorCode(
        updateMyProfile(database.db, kemi, {
          socials: { x: 'http://x.com/kemi' },
        }),
      ),
      'INVALID_INPUT',
    );
    await updateMyProfile(database.db, kemi, {
      socials: {
        x: 'https://twitter.com/kemi',
        facebook: 'https://www.facebook.com/kemi',
      },
    });
  });

  await t.test('tips need a live page', async () => {
    await database.fresh();
    const kemi = await signUp('+2348031230001');
    await claimHandle(database.db, { userId: kemi, handle: 'kemi', now });
    assert.equal(
      await errorCode(
        createQuote(database.db, {
          handle: 'kemi',
          tipMinor: 100000n,
          currency: 'NGN',
        }),
      ),
      'PROFILE_NOT_FOUND',
    );
    await setPageState(database.db, kemi, 'live');
    const quote = await createQuote(database.db, {
      handle: 'kemi',
      tipMinor: 100000n,
      currency: 'NGN',
    });
    await setPageState(database.db, kemi, 'not_live');
    assert.equal(
      await errorCode(
        createPaymentIntent(database.db, {
          quoteId: quote.quoteId,
          idempotencyKey: randomUUID(),
        }),
      ),
      'TIP_NOT_PAYABLE',
    );
  });

  await t.test(
    'deleting erases the person, ends sessions, holds the handle for 90 days',
    async () => {
      await database.fresh();
      const kemi = await signUp('+2348031230001');
      await claimHandle(database.db, { userId: kemi, handle: 'kemi', now });
      await setPageState(database.db, kemi, 'live');
      const { token } = await createSession(database.db, {
        userId: kemi,
        deviceLabel: 'Phone',
        now,
      });
      await deleteAccount(database.db, { userId: kemi, now });
      assert.equal(await resolveSession(database.db, token, now), null);
      assert.equal(await publicProfile(database.db, 'kemi'), null);
      const [user] = (
        await database.pool.query(
          'SELECT phone_e164, email, deleted_at FROM users WHERE id = $1',
          [kemi],
        )
      ).rows;
      assert.deepEqual([user.phone_e164, user.email], [null, null]);
      assert.ok(user.deleted_at);
      const [profile] = (
        await database.pool.query(
          'SELECT display_name, bio, socials, page_state FROM profiles WHERE user_id = $1',
          [kemi],
        )
      ).rows;
      assert.equal(profile.page_state, 'deleted');
      assert.equal(profile.bio, null);
      assert.deepEqual(profile.socials, {});
      assert.equal(
        await checkHandle(
          database.db,
          'kemi',
          new Date(now.getTime() + 89 * 86_400_000),
        ),
        'taken',
      );
      assert.equal(
        await checkHandle(
          database.db,
          'kemi',
          new Date(now.getTime() + 91 * 86_400_000),
        ),
        'available',
      );
      // The same number can start again as a new person.
      const again = await signUp('+2348031230001');
      assert.notEqual(again, kemi);
    },
  );

  await t.test(
    'deleting is blocked while a tip is still confirming',
    async () => {
      await database.fresh();
      const [{ user_id: adaUser }] = (
        await database.pool.query(
          "SELECT user_id FROM profiles WHERE handle_lower = 'ada'",
        )
      ).rows;
      assert.ok(adaUser, 'Ada is a seeded account');
      const quote = await createQuote(database.db, {
        handle: 'ada',
        tipMinor: 100000n,
        currency: 'NGN',
      });
      const intent = await createPaymentIntent(database.db, {
        quoteId: quote.quoteId,
        idempotencyKey: randomUUID(),
      });
      // The provider said "pending": the attempt is placed there directly (transition triggers bypassed).
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query(
          "UPDATE payment_attempts SET status = 'PENDING' WHERE id = $1",
          [intent.attemptId],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      assert.equal(
        await errorCode(deleteAccount(database.db, { userId: adaUser, now })),
        'HAS_BALANCE',
      );
    },
  );
});
