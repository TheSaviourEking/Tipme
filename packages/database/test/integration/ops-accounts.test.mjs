import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  accountDetail,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  recordProviderEvent,
  renameHandle,
  searchAccounts,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;

test('staff account search and summary', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const handles = async (query) =>
    (await searchAccounts(db, { query })).map((row) => row.handle);

  await t.test(
    'finds by handle, old handle or name, never by phone, and skips rehearsal pages',
    async () => {
      await database.fresh();
      assert.deepEqual(await handles('@ada'), ['ada']);
      assert.deepEqual(await handles('okafor'), ['ada']);
      assert.deepEqual(await handles(''), []);
      // Phone numbers are private: no match even for the exact number.
      assert.deepEqual(await handles('+2348000000001'), []);
      assert.deepEqual(await handles('%'), []);

      await renameHandle(db, { userId: TOBI.userId, handle: 'tobi_new' });
      assert.deepEqual(await handles('tobi'), ['tobi_new']);

      await database.pool.query(
        'UPDATE profiles SET rehearsal_run_id = $1 WHERE id = $2',
        [randomUUID(), ADA.id],
      );
      assert.deepEqual(await handles('ada'), []);
      assert.equal(await accountDetail(db, ADA.id), null);
    },
  );

  await t.test(
    'the summary shows pricing and money totals that reconcile with the 10% rule',
    async () => {
      await database.fresh();
      const quote = await createQuote(db, {
        handle: 'ada',
        tipMinor: 200000n,
        currency: 'NGN',
      });
      const intent = await createPaymentIntent(db, {
        quoteId: quote.quoteId,
        idempotencyKey: randomUUID(),
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
        eventType: 'payment.succeeded',
        attemptId: intent.attemptId,
        providerReference: reference,
        amountMinor: 200000n,
        currency: 'NGN',
        providerFeeMinor: 3000n,
        signatureVerified: true,
        payload: {},
      });
      const detail = await accountDetail(db, ADA.id);
      assert.equal(detail.handle, 'ada');
      assert.equal(detail.platformFeeBps, null);
      assert.equal(detail.feeFreeRemaining, 0);
      assert.equal(detail.paidTipCount, 1);
      assert.equal(detail.paidGrossMinor, '200000');
      assert.equal(detail.availableMinor, '180000');
      assert.equal(detail.confirmingMinor, '0');
      assert.equal('phone' in detail, false);
      assert.equal('email' in detail, false);
    },
  );
});
