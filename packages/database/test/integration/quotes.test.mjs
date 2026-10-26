import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createQuote,
  grantFeeFreeTips,
  grantOwner,
  pagePricing,
  QUOTE_TTL_MS,
  setAccountFee,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

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
  await t.test(
    'staff set an account fee and grant fee-free tips, each audited with its reason',
    async () => {
      await database.fresh();
      const { userId: staff } = await grantOwner(database.db, {
        phone: '+2348000009999',
      });
      const quoteAda = () =>
        createQuote(database.db, {
          handle: 'ada',
          tipMinor: 100000n,
          currency: 'NGN',
        });

      await setAccountFee(database.db, {
        profileId: ADA,
        staffUserId: staff,
        feeBps: 500,
        reason: 'Launch partner',
      });
      const custom = await quoteAda();
      // 5% of ₦1,000 = ₦50 to TipMe, its ₦15 processing estimate inside it (ADR-0014).
      assert.equal(custom.breakdown.platformFeeMinor, 3500n);
      assert.equal(custom.breakdown.providerFeeMinor, 1500n);
      assert.equal(custom.breakdown.recipientNetMinor, 95000n);
      assert.equal(custom.feePolicyVersion, 'proposed-v1.1-custom-500');
      assert.deepEqual(await pagePricing(database.db, ADA), {
        customFeeBps: 500,
        feeFreeRemaining: 0,
      });

      const { remaining } = await grantFeeFreeTips(database.db, {
        profileId: ADA,
        staffUserId: staff,
        count: 1,
        reason: 'Apology for downtime',
      });
      assert.equal(remaining, 1);
      // Honoured although Ada has never paid TipMe a fee: staff grants have no lifetime cap.
      const free = await quoteAda();
      assert.equal(free.feeFree, true);
      assert.equal(free.breakdown.recipientNetMinor, 100000n);
      assert.equal(free.feePolicyVersion, 'proposed-v1.1-custom-500-fee-free');
      // The one credit is reserved by the open fee-free quote: the next quote pays the fee.
      assert.equal((await quoteAda()).feeFree, false);

      await setAccountFee(database.db, {
        profileId: ADA,
        staffUserId: staff,
        feeBps: null,
        reason: 'Partnership ended',
      });
      const back = await quoteAda();
      assert.equal(back.feePolicyVersion, 'proposed-v1.1');

      const audit = (
        await database.pool.query(
          `SELECT action, permission, reason FROM audit_events
            WHERE subject_id = $1 ORDER BY seq`,
          [ADA],
        )
      ).rows;
      assert.deepEqual(
        audit.map((row) => [row.action, row.permission, row.reason]),
        [
          ['fee.set.500', 'fees.manage', 'Launch partner'],
          ['fee_free.granted.1', 'fees.manage', 'Apology for downtime'],
          ['fee.cleared', 'fees.manage', 'Partnership ended'],
        ],
      );
      for (const bad of [-1, 10001, 2.5])
        await assert.rejects(
          setAccountFee(database.db, {
            profileId: ADA,
            staffUserId: staff,
            feeBps: bad,
            reason: 'x',
          }),
          { code: 'INVALID_INPUT' },
        );
    },
  );
});
