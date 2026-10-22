import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuote, QUOTE_TTL_MS } from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

test('quotes', async (t) => {
  const database = await useDatabase(t);

  await t.test(
    'prices a tip with the mock policy and a 15-minute expiry',
    async () => {
      await database.fresh();
      const now = new Date('2026-10-18T12:00:00Z');
      const quote = await createQuote(database.db, {
        handle: 'Ada',
        tipMinor: 100000n,
        currency: 'NGN',
        now,
      });
      assert.equal(quote.breakdown.recipientNetMinor, 90000n);
      assert.equal(quote.feePolicyVersion, 'proposed-v1.1');
      assert.equal(quote.expiresAt.getTime(), now.getTime() + QUOTE_TTL_MS);
      assert.equal(QUOTE_TTL_MS, 15 * 60 * 1000);
    },
  );

  await t.test(
    'hidden, suspended and unknown profiles are all simply not found',
    async () => {
      await database.fresh();
      await database.pool.query(
        `UPDATE profiles SET visibility = 'hidden' WHERE handle = 'ada'`,
      );
      await database.pool.query(
        `UPDATE profiles SET status = 'suspended' WHERE handle = 'tobi'`,
      );
      for (const handle of ['ada', 'tobi', 'nobody']) {
        await assert.rejects(
          createQuote(database.db, {
            handle,
            tipMinor: 100000n,
            currency: 'NGN',
          }),
          {
            code: 'PROFILE_NOT_FOUND',
          },
        );
      }
    },
  );

  await t.test('amounts outside the range are refused', async () => {
    await database.fresh();
    await assert.rejects(
      createQuote(database.db, {
        handle: 'ada',
        tipMinor: 99n,
        currency: 'NGN',
      }),
      {
        code: 'AMOUNT_OUT_OF_RANGE',
      },
    );
  });
});
