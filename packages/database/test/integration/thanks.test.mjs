import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimHandle,
  deleteAccount,
  getMyProfile,
  listPretendOutbox,
  requestSignInCode,
  setThanks,
  updateMyProfile,
  verifySignInCode,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const secret = 'test-auth-code-secret-at-least-32-chars!';

test('the thank-you line', async (t) => {
  const database = await useDatabase(t);
  const { pool } = database;
  const q = async (sql, values = []) => (await pool.query(sql, values)).rows;
  let phones = 0;
  /** A new recipient with a page, on the given plan. */
  const recipient = async (plan = 'free') => {
    phones += 1;
    const phone = `+23480312${String(phones).padStart(5, '0')}`;
    await requestSignInCode(database.db, { phone, secret, now: new Date() });
    const code = /\b(\d{6})\b/.exec(
      (await listPretendOutbox(database.db, { limit: 1 }))[0].body,
    )[1];
    const { userId } = await verifySignInCode(database.db, {
      phone,
      code,
      secret,
    });
    await claimHandle(database.db, {
      userId,
      handle: `thanks${phones}`,
      now: new Date(),
    });
    await updateMyProfile(database.db, userId, { displayName: 'Ada Okafor' });
    await q('UPDATE profiles SET plan = $1 WHERE user_id = $2', [plan, userId]);
    return userId;
  };
  const row = async (userId) =>
    (
      await q(
        `SELECT thanks_line, thanks_style, thanks_signed, xmin::text AS xmin
           FROM profiles WHERE user_id = $1`,
        [userId],
      )
    )[0];
  const codeOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code;
    }
  };

  await t.test(
    'a Free page saves and clears its line; style and signed stay as stored',
    async () => {
      await database.fresh();
      const ada = await recipient('free');
      assert.deepEqual((await getMyProfile(database.db, ada)).thanks, {
        line: null,
        style: 'paper',
        signed: false,
      });
      await q(
        `UPDATE profiles SET thanks_style = 'night', thanks_signed = true WHERE user_id = $1`,
        [ada],
      );
      const saved = await setThanks(database.db, ada, { line: 'Thank you' });
      assert.deepEqual(saved.thanks, {
        line: 'Thank you',
        style: 'night',
        signed: true,
      });
      const cleared = await setThanks(database.db, ada, { line: null });
      assert.equal(cleared.thanks.line, null);
      assert.equal((await row(ada)).thanks_line, null);
      // An empty line, after cleaning, clears it too.
      await setThanks(database.db, ada, { line: 'Again' });
      await setThanks(database.db, ada, { line: '  \n ' });
      assert.equal((await row(ada)).thanks_line, null);
    },
  );

  await t.test(
    'a Free page sending a style or a signature is refused and nothing changes',
    async () => {
      await database.fresh();
      const ada = await recipient('free');
      await setThanks(database.db, ada, { line: 'Before' });
      const before = await row(ada);
      for (const patch of [
        { line: 'x', style: 'violet' },
        { line: 'x', signed: true },
      ]) {
        assert.equal(
          await codeOf(setThanks(database.db, ada, patch)),
          'THANKS_PRO_REQUIRED',
        );
        assert.deepEqual(await row(ada), before);
      }
      // Paper and unsigned are Free, so a Free page may send them.
      const plain = await setThanks(database.db, ada, {
        line: 'Plain',
        style: 'paper',
        signed: false,
      });
      assert.deepEqual(plain.thanks, {
        line: 'Plain',
        style: 'paper',
        signed: false,
      });
    },
  );

  await t.test(
    'a line with a link or over 140 characters is refused',
    async () => {
      await database.fresh();
      const ada = await recipient('free');
      for (const line of ['see www.me.ng', 'a'.repeat(141)])
        assert.equal(
          await codeOf(setThanks(database.db, ada, { line })),
          'INVALID_THANKS_LINE',
        );
      assert.equal((await row(ada)).thanks_line, null);
    },
  );

  await t.test(
    'a Pro page saves night and signed; dropping to Free between read and write refuses it',
    async () => {
      await database.fresh();
      const ada = await recipient('pro');
      const saved = await setThanks(database.db, ada, {
        line: 'Thank you',
        style: 'night',
        signed: true,
      });
      assert.deepEqual(saved.thanks, {
        line: 'Thank you',
        style: 'night',
        signed: true,
      });

      const before = await row(ada);
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query(
        'SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE',
        [ada],
      );
      const pending = codeOf(
        setThanks(database.db, ada, {
          line: 'Changed',
          style: 'violet',
          signed: false,
        }),
      );
      let waited = false;
      for (let tries = 0; tries < 500 && !waited; tries += 1) {
        const [{ n }] = await q(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        waited = n > 0;
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await client.query(
        `UPDATE profiles SET plan = 'free' WHERE user_id = $1`,
        [ada],
      );
      await client.query('COMMIT');
      client.release();
      assert.equal(waited, true, 'the save never waited for the lock');
      assert.equal(await pending, 'THANKS_PRO_REQUIRED');
      const after = await row(ada);
      assert.deepEqual(
        [after.thanks_line, after.thanks_style, after.thanks_signed],
        [before.thanks_line, before.thanks_style, before.thanks_signed],
      );
    },
  );

  await t.test(
    'the database refuses a 141-character line and an unknown style',
    async () => {
      await database.fresh();
      const ada = await recipient('free');
      await assert.rejects(
        q('UPDATE profiles SET thanks_line = $1 WHERE user_id = $2', [
          '😀'.repeat(141),
          ada,
        ]),
        { constraint: 'profiles_thanks_line_length' },
      );
      // 140 emoji are 140 characters to Postgres, as to the contract.
      await q('UPDATE profiles SET thanks_line = $1 WHERE user_id = $2', [
        '😀'.repeat(140),
        ada,
      ]);
      await assert.rejects(
        q(`UPDATE profiles SET thanks_line = '' WHERE user_id = $1`, [ada]),
        { constraint: 'profiles_thanks_line_length' },
      );
      await assert.rejects(
        q(`UPDATE profiles SET thanks_style = 'gold' WHERE user_id = $1`, [
          ada,
        ]),
        { constraint: 'profiles_thanks_style' },
      );
    },
  );

  await t.test(
    'deleting the account clears the line, style and signature',
    async () => {
      await database.fresh();
      const ada = await recipient('pro');
      await setThanks(database.db, ada, {
        line: 'Thank you',
        style: 'violet',
        signed: true,
      });
      await deleteAccount(database.db, { userId: ada, now: new Date() });
      const after = await row(ada);
      assert.deepEqual(
        [after.thanks_line, after.thanks_style, after.thanks_signed],
        [null, null, false],
      );
    },
  );
});
