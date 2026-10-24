import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createPayout,
  createQuote,
  recordPayoutOutcome,
  recordProviderEvent,
  tipProof,
} from '../../dist/index.js';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

test('payouts and proof', async (t) => {
  const database = await useDatabase(t);
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  const tipFor = async (handle, { pay = 'succeeded' } = {}) => {
    const { quoteId } = await createQuote(database.db, {
      handle,
      tipMinor: 100000n,
      currency: 'NGN',
    });
    const { tipId, attemptId } = await createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
    });
    if (pay) {
      await recordProviderEvent(database.db, {
        provider: 'mock',
        providerEventId: randomUUID(),
        eventType: `payment.${pay}`,
        attemptId,
        providerReference: `pay-${attemptId}`,
        amountMinor: 100000n,
        currency: 'NGN',
        providerFeeMinor: 1500n,
        signatureVerified: true,
        payload: {},
      });
    }
    return tipId;
  };
  const outcome = (payoutId, result, extra = {}) =>
    recordPayoutOutcome(database.db, {
      payoutId,
      provider: 'mock',
      providerEventId: randomUUID(),
      providerReference: `out-${payoutId}`,
      outcome: result,
      signatureVerified: true,
      payload: {},
      ...extra,
    });
  const payable = async () =>
    (
      await q(
        `SELECT coalesce(sum(CASE e.side WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS b
           FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.code = 'recipient_payable' AND a.profile_id = $1`,
        [ADA],
      )
    )[0].b;

  await t.test(
    'a payout covers the net of succeeded tips and is idempotent',
    async () => {
      await database.fresh();
      const tips = [await tipFor('ada'), await tipFor('ada')];
      const key = randomUUID();
      const first = await createPayout(database.db, {
        profileId: ADA,
        tipIds: tips,
        idempotencyKey: key,
      });
      assert.equal(first.amountMinor, 180000n);
      assert.equal(first.replayed, false);
      const again = await createPayout(database.db, {
        profileId: ADA,
        tipIds: tips,
        idempotencyKey: key,
      });
      assert.deepEqual({ ...again, replayed: false }, first);
      assert.equal(again.replayed, true);
    },
  );

  await t.test(
    "other people's, unpaid and already-claimed tips are refused",
    async () => {
      await database.fresh();
      const tobis = await tipFor('tobi');
      const failed = await tipFor('ada', { pay: 'failed' });
      const claimed = await tipFor('ada');
      await createPayout(database.db, {
        profileId: ADA,
        tipIds: [claimed],
        idempotencyKey: randomUUID(),
      });
      for (const tipIds of [[tobis], [failed], [claimed]]) {
        await assert.rejects(
          createPayout(database.db, {
            profileId: ADA,
            tipIds,
            idempotencyKey: randomUUID(),
          }),
          {
            code: 'TIP_NOT_PAYABLE',
          },
        );
      }
      assert.ok(TOBI);
    },
  );

  await t.test(
    'a paid payout settles the payable with its own ledger transaction; repeats are duplicates',
    async () => {
      await database.fresh();
      const tip = await tipFor('ada');
      assert.equal(await payable(), '90000');
      const { payoutId } = await createPayout(database.db, {
        profileId: ADA,
        tipIds: [tip],
        idempotencyKey: randomUUID(),
      });
      const providerEventId = randomUUID();
      assert.equal(
        (await outcome(payoutId, 'paid', { providerEventId })).outcome,
        'applied',
      );
      assert.equal(await payable(), '0');
      assert.equal(
        (
          await q(
            `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_key = $1`,
            [`payout.${payoutId}`],
          )
        )[0].n,
        1,
      );
      assert.ok(
        (await q('SELECT dedupe_key FROM outbox_events')).some(
          (row) => row.dedupe_key === `payout.paid.${payoutId}`,
        ),
      );
      assert.equal(
        (await outcome(payoutId, 'paid', { providerEventId })).outcome,
        'duplicate',
      );
      assert.equal((await outcome(payoutId, 'failed')).outcome, 'ignored');
    },
  );

  await t.test(
    'a failed payout releases its tips for a new payout',
    async () => {
      await database.fresh();
      const tip = await tipFor('ada');
      const { payoutId } = await createPayout(database.db, {
        profileId: ADA,
        tipIds: [tip],
        idempotencyKey: randomUUID(),
      });
      await outcome(payoutId, 'failed');
      const retry = await createPayout(database.db, {
        profileId: ADA,
        tipIds: [tip],
        idempotencyKey: randomUUID(),
      });
      assert.notEqual(retry.payoutId, payoutId);
      assert.equal(await payable(), '90000');
    },
  );

  await t.test(
    'a payout reported paid after it failed is flagged as a conflict',
    async () => {
      await database.fresh();
      const tip = await tipFor('ada');
      const { payoutId } = await createPayout(database.db, {
        profileId: ADA,
        tipIds: [tip],
        idempotencyKey: randomUUID(),
      });
      await outcome(payoutId, 'failed');
      assert.equal((await outcome(payoutId, 'paid')).outcome, 'conflict');
      assert.ok(
        (await q('SELECT dedupe_key FROM outbox_events')).some((row) =>
          row.dedupe_key.startsWith(`payout.conflict.${payoutId}.`),
        ),
      );
    },
  );

  await t.test(
    'reusing a payout key for different tips is a conflict',
    async () => {
      await database.fresh();
      const [a, b] = [await tipFor('ada'), await tipFor('ada')];
      const key = randomUUID();
      await createPayout(database.db, {
        profileId: ADA,
        tipIds: [a],
        idempotencyKey: key,
      });
      await assert.rejects(
        createPayout(database.db, {
          profileId: ADA,
          tipIds: [b],
          idempotencyKey: key,
        }),
        {
          code: 'IDEMPOTENCY_CONFLICT',
        },
      );
      assert.equal(
        (
          await createPayout(database.db, {
            profileId: ADA,
            tipIds: [a],
            idempotencyKey: key,
          })
        ).replayed,
        true,
      );
    },
  );

  await t.test('the proof history keeps an earlier failed payout', async () => {
    await database.fresh();
    const tip = await tipFor('ada');
    const first = await createPayout(database.db, {
      profileId: ADA,
      tipIds: [tip],
      idempotencyKey: randomUUID(),
    });
    await outcome(first.payoutId, 'failed');
    const second = await createPayout(database.db, {
      profileId: ADA,
      tipIds: [tip],
      idempotencyKey: randomUUID(),
    });
    await outcome(second.payoutId, 'paid');
    const proof = await tipProof(database.db, tip);
    assert.equal(proof.payout.payoutId, second.payoutId);
    const payoutHistory = proof.history
      .filter((entry) => entry.entityType === 'payout')
      .map((entry) => entry.toStatus);
    assert.ok(payoutHistory.includes('FAILED'), payoutHistory.join(','));
    assert.ok(payoutHistory.includes('PAID'));
  });

  await t.test(
    'two payouts racing for the same tips: exactly one wins',
    async () => {
      await database.fresh();
      for (let i = 0; i < 10; i++) {
        const tips = [await tipFor('ada'), await tipFor('ada')];
        const results = await Promise.allSettled([
          createPayout(database.db, {
            profileId: ADA,
            tipIds: tips,
            idempotencyKey: randomUUID(),
          }),
          createPayout(database.db, {
            profileId: ADA,
            tipIds: [...tips].reverse(),
            idempotencyKey: randomUUID(),
          }),
        ]);
        const outcomes = results
          .map((result) =>
            result.status === 'fulfilled' ? 'ok' : result.reason.code,
          )
          .sort();
        assert.deepEqual(outcomes, ['TIP_NOT_PAYABLE', 'ok']);
      }
    },
  );

  await t.test(
    'the proof shows both the confirmed payment and the payout, as JSON-safe strings',
    async () => {
      await database.fresh();
      const tip = await tipFor('ada');
      const { payoutId } = await createPayout(database.db, {
        profileId: ADA,
        tipIds: [tip],
        idempotencyKey: randomUUID(),
      });
      await outcome(payoutId, 'paid');
      const proof = await tipProof(database.db, tip);
      assert.doesNotThrow(() => JSON.stringify(proof));
      assert.equal(proof.tip.status, 'SUCCEEDED');
      assert.equal(proof.tip.grossMinor, '100000');
      assert.match(proof.payment.providerReference, /^pay-/);
      assert.ok(proof.payment.providerEventId);
      assert.deepEqual(proof.breakdown, {
        grossMinor: '100000',
        platformFeeMinor: '8500',
        quotedProviderFeeMinor: '1500',
        actualProviderFeeMinor: '1500',
        recipientNetMinor: '90000',
      });
      assert.ok(proof.paymentLedgerTransactionId);
      assert.equal(proof.payout.status, 'PAID');
      assert.equal(proof.payout.providerReference, `out-${payoutId}`);
      assert.ok(proof.payout.paidAt);
      assert.ok(proof.payout.ledgerTransactionId);
      const times = proof.history.map((entry) => entry.at);
      assert.deepEqual([...times].sort(), times);
      assert.ok(
        proof.history.some(
          (entry) => entry.entityType === 'payout' && entry.toStatus === 'PAID',
        ),
      );
      assert.equal(await tipProof(database.db, randomUUID()), null);
    },
  );
});
