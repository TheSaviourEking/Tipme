import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  balanceOf,
  businessBalanceIn,
  flagPaymentReversal,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  recordProviderEvent,
  requestWithdrawal,
  reverseTip,
  withdrawalQuote,
} from '../../dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

// Business release 2, PR R2-A: the business's share is its own ledger line, and a refund or
// chargeback that staff confirm takes back every line of the tip (Q7), even below zero (Q8).

const { createMockProvider } = await import('../../../payments/dist/index.js');
const { Redis } = createRequire(
  new URL('../../../payments/package.json', import.meta.url),
)('ioredis');
const [, TOBI] = DEMO_PROFILES;

// A ₦4,000 tip: Tobi receives ₦3,600 after TipMe's 10% fee (ADR-0014).
const GROSS = 400000n;
const NET = 360000n;

test('reversals and the business share', async (t) => {
  const database = await useDatabase(t);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const mock = () =>
    createMockProvider({ redis, prefix: `rv-${randomUUID().slice(0, 8)}` });
  const codeOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code ?? String(error);
    }
  };

  /** Tobi works at The Yellow Chilli, which takes `bps` of what they receive. */
  const atBusiness = async (bps = 1000) => {
    const { businessId, locations } = await seedBusiness(database);
    const { memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId: TOBI.id,
    });
    const { agreementId } = await seedAgreement(database, {
      memberId,
      businessBps: bps,
    });
    return { businessId, memberId, agreementId, bps };
  };

  /** A paid ₦4,000 tip to Tobi; at a business with a share, the share is fixed at intent time. */
  const paidTip = async (shared) => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: GROSS,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      ...(shared ? { businessMemberId: shared.memberId } : {}),
    });
    // R2-C2 writes this row when the intent is made; the database checks it is the agreed share.
    if (shared)
      await q(
        `INSERT INTO tip_business_shares (tip_id, agreement_id, business_id, business_bps, share_minor)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          intent.tipId,
          shared.agreementId,
          shared.businessId,
          shared.bps,
          ((NET * BigInt(shared.bps)) / 10000n).toString(),
        ],
      );
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
      amountMinor: GROSS,
      currency: 'NGN',
      providerFeeMinor: 6000n,
      signatureVerified: true,
      payload: {},
    });
    return intent.tipId;
  };
  const reverse = (tipId, refundedMinor = GROSS, providerEventId) =>
    db.transaction((tx) =>
      reverseTip(tx, {
        tipId,
        providerEventId: providerEventId ?? `evt_refund_${randomUUID()}`,
        refundedMinor,
      }),
    );
  const person = async () => (await balanceOf(db, TOBI.id)).availableMinor;
  const business = async (businessId) =>
    (await businessBalanceIn(db, businessId)).availableMinor;
  /** Every transaction balances in its currency (the database also refuses one that doesn't). */
  const assertBalanced = async () => {
    const rows = await q(
      `SELECT transaction_id, currency,
              sum(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END) AS d
         FROM ledger_entries GROUP BY transaction_id, currency
        HAVING sum(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`,
    );
    assert.deepEqual(rows, []);
  };
  /**
   * A paid tip has a business_payable line exactly when it has a share, for exactly the share: the
   * share row and its ledger line are never one without the other.
   */
  const assertShareLines = async () => {
    const rows = await q(
      `SELECT t.id, s.share_minor::text AS share,
              (SELECT string_agg(e.amount_minor::text, ',')
                 FROM ledger_transactions x
                 JOIN ledger_entries e ON e.transaction_id = x.id
                 JOIN ledger_accounts a ON a.id = e.account_id
                WHERE x.tip_id = t.id AND x.operation_type = 'payment'
                  AND a.code = 'business_payable' AND e.side = 'credit') AS line
         FROM tips t LEFT JOIN tip_business_shares s ON s.tip_id = t.id
        WHERE t.status = 'SUCCEEDED'`,
    );
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.line, row.share, `tip ${row.id}`);
  };
  const belowZeroIssues = () =>
    q(
      `SELECT subject, severity FROM issues WHERE kind = 'balance_below_zero' ORDER BY opened_at`,
    );

  await t.test(
    "a paid shared tip posts the business's share as its own business_payable line",
    async () => {
      await database.fresh();
      const shared = await atBusiness(1000);
      const tipId = await paidTip(shared);
      const lines = await q(
        `SELECT a.code, e.side, e.amount_minor::text AS amount, e.profile_id, e.business_id
           FROM ledger_entries e
           JOIN ledger_accounts a ON a.id = e.account_id
           JOIN ledger_transactions x ON x.id = e.transaction_id
          WHERE x.tip_id = $1 AND a.code IN ('recipient_payable', 'business_payable')
          ORDER BY a.code`,
        [tipId],
      );
      assert.deepEqual(lines, [
        {
          code: 'business_payable',
          side: 'credit',
          amount: '36000',
          profile_id: null,
          business_id: shared.businessId,
        },
        {
          code: 'recipient_payable',
          side: 'credit',
          amount: '324000',
          profile_id: TOBI.id,
          business_id: null,
        },
      ]);
      assert.equal(await person(), 324000n);
      assert.equal(await business(shared.businessId), 36000n);
      // A tip through Tobi's own page, at the same time, has no business line at all.
      await paidTip();
      assert.equal(await person(), 324000n + NET);
      assert.equal(await business(shared.businessId), 36000n);
      await assertBalanced();
      await assertShareLines();
    },
  );

  await t.test(
    "reversing a shared tip lowers both the person's and the business's balance by their parts",
    async () => {
      await database.fresh();
      const shared = await atBusiness(2000);
      const tipId = await paidTip(shared);
      assert.equal(await person(), 288000n);
      assert.equal(await business(shared.businessId), 72000n);
      // A refund of half: each line in proportion.
      const half = await reverse(tipId, GROSS / 2n);
      assert.equal(half.created, true);
      assert.equal(await person(), 144000n);
      assert.equal(await business(shared.businessId), 36000n);
      // The rest: everything is back to nothing, and every posting balanced.
      await reverse(tipId, GROSS / 2n);
      assert.equal(await person(), 0n);
      assert.equal(await business(shared.businessId), 0n);
      const [{ n }] = await q(
        `SELECT count(*)::int AS n FROM ledger_transactions
          WHERE tip_id = $1 AND operation_type = 'reversal'
            AND reverses_transaction_id = (SELECT id FROM ledger_transactions
                                            WHERE tip_id = $1 AND operation_type = 'payment')`,
        [tipId],
      );
      assert.equal(n, 2);
      // Every account the payment touched is back to zero, TipMe's own included.
      const left = await q(
        `SELECT a.code, sum(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END)::text AS net
           FROM ledger_entries e
           JOIN ledger_accounts a ON a.id = e.account_id
           JOIN ledger_transactions x ON x.id = e.transaction_id
          WHERE x.tip_id = $1 GROUP BY a.code
         HAVING sum(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) <> 0`,
        [tipId],
      );
      assert.deepEqual(left, []);
      // Nothing is left to take back.
      assert.equal(await codeOf(reverse(tipId, 1n)), 'TIP_NOT_REVERSIBLE');
      await assertBalanced();
    },
  );

  await t.test(
    'a refund and a later chargeback never take back more than the payment gave',
    async () => {
      await database.fresh();
      const shared = await atBusiness(5000);
      const tipId = await paidTip(shared);
      await reverse(tipId, GROSS / 2n, 'evt_refund');
      // The chargeback names the whole tip, but only half is left: refused, nothing posted.
      assert.equal(
        await codeOf(reverse(tipId, GROSS, 'evt_chargeback')),
        'TIP_NOT_REVERSIBLE',
      );
      assert.equal(await person(), 90000n);
      assert.equal(await business(shared.businessId), 90000n);
      // What is left can be taken back, once.
      await reverse(tipId, GROSS / 2n, 'evt_chargeback');
      assert.equal(await person(), 0n);
      assert.equal(await business(shared.businessId), 0n);
      assert.equal(
        await codeOf(reverse(tipId, 1n, 'evt_chargeback_2')),
        'TIP_NOT_REVERSIBLE',
      );
      await assertBalanced();
      await assertShareLines();
    },
  );

  await t.test(
    "the partner's refund event on a shared tip names the business and holds the person's withdrawals",
    async () => {
      await database.fresh();
      const shared = await atBusiness(1000);
      const tipId = await paidTip(shared);
      const [{ attempt_id: attemptId }] = await q(
        `SELECT a.id AS attempt_id FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
          WHERE t.id = $1`,
        [tipId],
      );
      await flagPaymentReversal(db, {
        attemptId,
        eventId: 'evt/refund 1',
        eventType: 'refund.processed',
      });
      const [issue] = await q(
        `SELECT subject, status FROM issues WHERE kind = 'payment_reversed'`,
      );
      assert.equal(issue.status, 'open');
      assert.equal(issue.subject.businessId, shared.businessId);
      assert.equal(issue.subject.profileId, TOBI.id);
      const holds = await q(
        `SELECT profile_id FROM withdrawal_holds WHERE released_at IS NULL`,
      );
      assert.deepEqual(holds, [{ profile_id: TOBI.id }]);
      // Nothing in the ledger changes until staff confirm the reversal (Q7).
      assert.equal(await person(), 324000n);
      assert.equal(await business(shared.businessId), 36000n);
    },
  );

  await t.test('a second reversal with the same event is a no-op', async () => {
    await database.fresh();
    const shared = await atBusiness(1000);
    const tipId = await paidTip(shared);
    const first = await reverse(tipId, GROSS, 'evt_refund_same');
    const again = await reverse(tipId, GROSS, 'evt_refund_same');
    assert.equal(again.created, false);
    assert.equal(again.transactionId, first.transactionId);
    // Even when a repeat names another amount, the event was already taken back once.
    const third = await reverse(tipId, 1000n, 'evt_refund_same');
    assert.equal(third.created, false);
    assert.equal(await person(), 0n);
    assert.equal(await business(shared.businessId), 0n);
    const [{ n }] = await q(
      `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_type = 'reversal'`,
    );
    assert.equal(n, 1);
  });

  await t.test('a plain tip reverses its single recipient line', async () => {
    await database.fresh();
    const tipId = await paidTip();
    assert.equal(await person(), NET);
    const result = await reverse(tipId);
    assert.equal(result.created, true);
    assert.deepEqual(result.belowZero, []);
    assert.equal(await person(), 0n);
    const lines = await q(
      `SELECT a.code, e.side, e.amount_minor::text AS amount
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE e.transaction_id = $1 AND a.code LIKE '%payable' ORDER BY a.code`,
      [result.transactionId],
    );
    assert.deepEqual(lines, [
      { code: 'recipient_payable', side: 'debit', amount: '360000' },
    ]);
    await assertBalanced();
  });

  await t.test(
    'a refund larger than the payment, or of an unpaid tip, is refused',
    async () => {
      await database.fresh();
      const tipId = await paidTip();
      assert.equal(
        await codeOf(reverse(tipId, GROSS + 1n)),
        'TIP_NOT_REVERSIBLE',
      );
      assert.equal(await codeOf(reverse(tipId, 0n)), 'INVALID_INPUT');
      const quote = await createQuote(db, {
        handle: 'tobi',
        tipMinor: GROSS,
        currency: 'NGN',
      });
      const unpaid = await createPaymentIntent(db, {
        quoteId: quote.quoteId,
        idempotencyKey: randomUUID(),
      });
      assert.equal(await codeOf(reverse(unpaid.tipId)), 'TIP_NOT_REVERSIBLE');
      assert.equal(await person(), NET);
    },
  );

  await t.test(
    'a reversal after withdrawal leaves the balance below zero, refuses the next withdrawal and opens one money issue',
    async () => {
      await database.fresh();
      const provider = mock();
      const tipId = await paidTip();
      const withdrawn = await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: NET,
        idempotencyKey: randomUUID(),
        provider,
      });
      assert.equal(withdrawn.status, 'REQUESTED');
      // The money has gone (reserved for the withdrawal); the refund is booked anyway (Q8).
      const result = await reverse(tipId);
      assert.equal(result.created, true);
      assert.deepEqual(result.belowZero, [{ profileId: TOBI.id }]);
      assert.equal(await person(), -NET);
      // A later tip brings money in, but not enough: the balance is still below zero.
      await paidTip();
      assert.equal(await person(), 0n);
      assert.equal(
        await codeOf(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 1n,
            idempotencyKey: randomUUID(),
            provider,
          }),
        ),
        'INSUFFICIENT_BALANCE',
      );
      const issues = await belowZeroIssues();
      assert.equal(issues.length, 1);
      assert.equal(issues[0].severity, 'money');
      assert.equal(issues[0].subject.profileId, TOBI.id);
      assert.equal(issues[0].subject.tipId, tipId);
    },
  );

  await t.test(
    'below zero, the next withdrawal is refused and the quote says withdrawals are paused',
    async () => {
      await database.fresh();
      const provider = mock();
      const first = await paidTip();
      await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: NET,
        idempotencyKey: randomUUID(),
        provider,
      });
      await reverse(first);
      // A smaller tip later: the payable is positive, but the balance is still below zero.
      const quote = await createQuote(db, {
        handle: 'tobi',
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
      assert.equal(await person(), -180000n);
      assert.equal(
        await codeOf(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 100000n,
            idempotencyKey: randomUUID(),
            provider,
          }),
        ),
        'BALANCE_BELOW_ZERO',
      );
      const quoted = await withdrawalQuote(db, {
        profileId: TOBI.id,
        provider,
      });
      assert.deepEqual(quoted, { state: 'paused', reason: 'reversal' });
      assert.equal((await belowZeroIssues()).length, 1);
    },
  );

  await t.test(
    'a reversal racing a withdrawal ends with exactly one of them seeing the money',
    async () => {
      for (let round = 0; round < 6; round++) {
        await database.fresh();
        const provider = mock();
        const shared = await atBusiness(1000);
        const tipId = await paidTip(shared);
        const mine = 324000n;
        assert.equal(await person(), mine);
        const [withdrawal, reversal] = await Promise.allSettled([
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: mine,
            idempotencyKey: randomUUID(),
            provider,
          }),
          reverse(tipId),
        ]);
        assert.equal(reversal.status, 'fulfilled', String(reversal.reason));
        const issues = await belowZeroIssues();
        if (withdrawal.status === 'fulfilled') {
          // The withdrawal took the money first: the reversal leaves Tobi owing it, and says so.
          assert.equal(await person(), -mine);
          assert.deepEqual(reversal.value.belowZero, [{ profileId: TOBI.id }]);
          assert.equal(issues.length, 1);
        } else {
          // The reversal took it first: nothing was left to withdraw.
          assert.ok(
            ['INSUFFICIENT_BALANCE', 'BALANCE_BELOW_ZERO'].includes(
              withdrawal.reason.code,
            ),
            String(withdrawal.reason),
          );
          assert.equal(await person(), 0n);
          assert.equal(issues.length, 0);
        }
        assert.equal(await business(shared.businessId), 0n);
        await assertBalanced();
      }
    },
  );
});
