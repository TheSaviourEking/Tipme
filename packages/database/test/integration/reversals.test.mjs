import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  balanceOf,
  businessBalanceIn,
  createPayout,
  flagPaymentReversal,
  tipReversalTarget,
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

// A ₦4,000 tip: Tobi receives ₦3,720 after TipMe's 7% Free fee (owner, 12 Nov 2026).
const GROSS = 400000n;
const NET = 372000n;

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
  const reverse = (
    tipId,
    refundedMinor = GROSS,
    partnerReversalId,
    refundFeeMinor,
  ) =>
    db.transaction((tx) =>
      reverseTip(tx, {
        tipId,
        partnerReversalId: partnerReversalId ?? `refund.re_${randomUUID()}`,
        refundedMinor,
        ...(refundFeeMinor === undefined ? {} : { refundFeeMinor }),
      }),
    );
  /** What every transaction of a tip did to each of TipMe's accounts (debits positive). */
  const accountsOf = async (tipId) =>
    Object.fromEntries(
      (
        await q(
          `SELECT a.code, sum(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END)::text AS net
             FROM ledger_entries e
             JOIN ledger_accounts a ON a.id = e.account_id
             JOIN ledger_transactions x ON x.id = e.transaction_id
            WHERE x.tip_id = $1 GROUP BY a.code`,
          [tipId],
        )
      ).map((row) => [row.code, row.net]),
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
          amount: '37200',
          profile_id: null,
          business_id: shared.businessId,
        },
        {
          code: 'recipient_payable',
          side: 'credit',
          amount: '334800',
          profile_id: TOBI.id,
          business_id: null,
        },
      ]);
      assert.equal(await person(), 334800n);
      assert.equal(await business(shared.businessId), 37200n);
      // A tip through Tobi's own page, at the same time, has no business line at all.
      await paidTip();
      assert.equal(await person(), 334800n + NET);
      assert.equal(await business(shared.businessId), 37200n);
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
      assert.equal(await person(), 297600n);
      assert.equal(await business(shared.businessId), 74400n);
      // A refund of half: each line in proportion.
      const half = await reverse(tipId, GROSS / 2n);
      assert.equal(half.created, true);
      assert.equal(await person(), 148800n);
      assert.equal(await business(shared.businessId), 37200n);
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
      // Everything the payment owed is back to zero. The partner kept its ₦60 fee ("Fees already
      // charged are not returned"): TipMe's expense, paid out of its partner balance.
      assert.deepEqual(await accountsOf(tipId), {
        business_payable: '0',
        platform_fee_revenue: '0',
        provider_clearing: '-6000',
        provider_fee_expense: '6000',
        provider_fee_recovered: '0',
        recipient_payable: '0',
      });
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
      assert.equal(await person(), 93000n);
      assert.equal(await business(shared.businessId), 93000n);
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
      assert.equal(await person(), 334800n);
      assert.equal(await business(shared.businessId), 37200n);
    },
  );

  /** The partner's webhook about a refund or dispute of this tip, as the webhook service passes it. */
  const partnerSays = async (tipId, input) => {
    const [{ attempt_id: attemptId }] = await q(
      `SELECT a.id AS attempt_id FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
        WHERE t.id = $1`,
      [tipId],
    );
    return flagPaymentReversal(db, { attemptId, ...input });
  };
  const reversedIssues = () =>
    q(
      `SELECT id, subject, status FROM issues WHERE kind = 'payment_reversed' ORDER BY opened_at`,
    );

  await t.test(
    'two webhook events for one ₦500 refund open one issue and reverse exactly ₦500',
    async () => {
      await database.fresh();
      const shared = await atBusiness(1000);
      const tipId = await paidTip(shared);
      await partnerSays(tipId, {
        eventId: `evt_${randomUUID()}`,
        eventType: 'refund.created',
        partnerReversalId: 'refund.rfnd_500',
        disputeWon: false,
        refundState: 'pending',
        refundedMinor: null,
        refundFeeMinor: null,
      });
      // Accepted, still processing: noted and held, but nothing to reverse yet.
      let issues = await reversedIssues();
      assert.equal(issues.length, 1);
      assert.equal(issues[0].subject.refundState, 'pending');
      assert.equal(await tipReversalTarget(db, issues[0].id), null);
      await partnerSays(tipId, {
        eventId: `evt_${randomUUID()}`,
        eventType: 'refund.paid',
        partnerReversalId: 'refund.rfnd_500',
        disputeWon: false,
        refundState: 'paid',
        refundedMinor: 50000n,
        refundFeeMinor: 0n,
      });
      // The same issue, now paid with its amount: reversible once.
      issues = await reversedIssues();
      assert.equal(issues.length, 1);
      const target = await tipReversalTarget(db, issues[0].id);
      assert.deepEqual(target, {
        tipId,
        partnerReversalId: 'refund.rfnd_500',
        refundedMinor: 50000n,
        refundFeeMinor: 0n,
      });
      // A late or repeated `refund.created` never takes it back to pending.
      await partnerSays(tipId, {
        eventId: `evt_${randomUUID()}`,
        eventType: 'refund.created',
        partnerReversalId: 'refund.rfnd_500',
        disputeWon: false,
        refundState: 'pending',
        refundedMinor: null,
        refundFeeMinor: null,
      });
      assert.equal((await reversedIssues())[0].subject.refundState, 'paid');
      // Staff confirm it twice (two people, or the same person twice): one reversal of ₦500.
      const once = await reverse(tipId, 50000n, target.partnerReversalId);
      const twice = await reverse(tipId, 50000n, target.partnerReversalId);
      assert.equal(once.created, true);
      assert.equal(twice.created, false);
      const [{ reversed }] = await q(
        `SELECT sum(e.amount_minor)::text AS reversed FROM ledger_entries e
           JOIN ledger_transactions x ON x.id = e.transaction_id
          WHERE x.tip_id = $1 AND x.operation_type = 'reversal' AND e.side = 'debit'`,
        [tipId],
      );
      assert.equal(reversed, '50000');
      // A dispute on the same tip is another partner object: its own issue.
      await partnerSays(tipId, {
        eventId: `evt_${randomUUID()}`,
        eventType: 'dispute.created',
        partnerReversalId: 'dispute.dp_1',
        disputeWon: false,
      });
      assert.equal((await reversedIssues()).length, 2);
    },
  );

  await t.test(
    'a failed refund reverses nothing, and its issue says nothing moved',
    async () => {
      await database.fresh();
      const tipId = await paidTip();
      for (const [eventType, refundState] of [
        ['refund.created', 'pending'],
        ['refund.failed', 'failed'],
        // A paid event can't follow a final failure.
        ['refund.paid', 'paid'],
      ])
        await partnerSays(tipId, {
          eventId: `evt_${randomUUID()}`,
          eventType,
          partnerReversalId: 'refund.rfnd_fail',
          disputeWon: false,
          refundState,
          refundedMinor: refundState === 'paid' ? 50000n : null,
          refundFeeMinor: null,
        });
      const [issue, ...more] = await reversedIssues();
      assert.equal(more.length, 0);
      assert.equal(issue.subject.refundState, 'failed');
      assert.equal(await tipReversalTarget(db, issue.id), null);
      const [{ summary }] = await q(
        `SELECT summary FROM issues WHERE id = $1`,
        [issue.id],
      );
      assert.match(summary, /refund failed: nothing moved/);
      assert.equal(await person(), NET);
    },
  );

  await t.test(
    "a refund's own fee is TipMe's expense; the partner keeps the payment's fee",
    async () => {
      await database.fresh();
      const shared = await atBusiness(1000);
      const tipId = await paidTip(shared);
      const result = await reverse(tipId, GROSS, 'refund.rfnd_fee', 1500n);
      assert.equal(result.created, true);
      assert.equal(await person(), 0n);
      assert.equal(await business(shared.businessId), 0n);
      assert.deepEqual(await accountsOf(tipId), {
        business_payable: '0',
        platform_fee_revenue: '0',
        // ₦4,000 − ₦60 came in; ₦4,000 + ₦15 went back out.
        provider_clearing: '-7500',
        provider_fee_expense: '7500',
        provider_fee_recovered: '0',
        recipient_payable: '0',
      });
      await assertBalanced();
    },
  );

  await t.test(
    'the database lets a reversal only take money out of the partner balance and never take back a fee',
    async () => {
      await database.fresh();
      const tipId = await paidTip();
      const [payment] = await q(
        `SELECT id FROM ledger_transactions WHERE tip_id = $1 AND operation_type = 'payment'`,
        [tipId],
      );
      const accounts = Object.fromEntries(
        (
          await q(
            `SELECT DISTINCT a.code, a.id FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
              WHERE e.transaction_id = $1`,
            [payment.id],
          )
        ).map((row) => [row.code, row.id]),
      );
      const post = async (lines) => {
        const client = await database.pool.connect();
        try {
          await client.query('BEGIN');
          const id = randomUUID();
          await client.query(
            `INSERT INTO ledger_transactions (id, operation_type, operation_key, currency, tip_id, reverses_transaction_id)
             VALUES ($1, 'reversal', $2, 'NGN', $3, $4)`,
            [id, `reversal.test.${id}`, tipId, payment.id],
          );
          for (const [code, side, amount, profile] of lines)
            await client.query(
              `INSERT INTO ledger_entries (id, transaction_id, account_id, profile_id, side, amount_minor, currency)
               VALUES ($1, $2, $3, $4, $5, $6, 'NGN')`,
              [randomUUID(), id, accounts[code], profile ?? null, side, amount],
            );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      const refused = (promise) =>
        assert.rejects(promise, (error) => {
          assert.match(
            String(error.constraint),
            /ledger_reversal_within_payment/,
          );
          return true;
        });
      // Taking back a fee (crediting the provider fee expense) is refused.
      await refused(
        post([
          ['provider_fee_expense', 'credit', '6000'],
          ['recipient_payable', 'debit', '6000', TOBI.id],
        ]),
      );
      // Paying money into the partner balance is refused.
      await refused(
        post([
          ['provider_clearing', 'debit', '1000'],
          ['recipient_payable', 'credit', '1000', TOBI.id],
        ]),
      );
      // Taking back more than the person was credited is still refused.
      await refused(
        post([
          ['recipient_payable', 'debit', String(NET + 1n), TOBI.id],
          ['provider_clearing', 'credit', String(NET + 1n)],
        ]),
      );
      // The partner's way: the whole refund out of the partner balance, the fee left alone.
      await post([
        ['recipient_payable', 'debit', String(NET), TOBI.id],
        ['platform_fee_revenue', 'debit', '22000'],
        ['provider_fee_recovered', 'debit', '6000'],
        ['provider_clearing', 'credit', String(GROSS)],
      ]);
      assert.equal(await person(), 0n);
    },
  );

  await t.test(
    'a won dispute opens no reversible issue and holds nothing',
    async () => {
      await database.fresh();
      const tipId = await paidTip();
      assert.equal(
        await partnerSays(tipId, {
          eventId: `evt_${randomUUID()}`,
          eventType: 'dispute.won',
          partnerReversalId: 'dispute.dp_9',
          disputeWon: true,
        }),
        'dispute_won',
      );
      assert.deepEqual(await reversedIssues(), []);
      assert.deepEqual(
        await q(`SELECT 1 FROM withdrawal_holds WHERE released_at IS NULL`),
        [],
      );
    },
  );

  await t.test(
    "an event naming no refund or dispute still alerts and holds, but can't be reversed here",
    async () => {
      await database.fresh();
      const tipId = await paidTip();
      assert.equal(
        await partnerSays(tipId, {
          eventId: 'evt_no_object',
          eventType: 'refund.paid',
          partnerReversalId: null,
          disputeWon: false,
          refundState: 'paid',
          refundedMinor: 50000n,
          refundFeeMinor: null,
        }),
        'flagged',
      );
      const [issue] = await reversedIssues();
      assert.equal(issue.status, 'open');
      assert.equal(await tipReversalTarget(db, issue.id), null);
      assert.equal(
        (await q(`SELECT 1 FROM withdrawal_holds WHERE released_at IS NULL`))
          .length,
        1,
      );
    },
  );

  await t.test(
    'the old tip-list payout refuses a tip a reversal took back while it waited',
    async () => {
      await database.fresh();
      const tipId = await paidTip();
      let release;
      const gate = new Promise((done) => (release = done));
      let locked;
      const holding = new Promise((done) => (locked = done));
      // The reversal holds the tip's lock, uncommitted, while the payout asks for it.
      const reversal = db.transaction(async (tx) => {
        const result = await reverseTip(tx, {
          tipId,
          partnerReversalId: 'refund.re_race',
          refundedMinor: GROSS,
        });
        locked();
        await gate;
        return result;
      });
      await holding;
      const payout = createPayout(db, {
        profileId: TOBI.id,
        tipIds: [tipId],
        idempotencyKey: randomUUID(),
      });
      await new Promise((done) => setTimeout(done, 300));
      release();
      await reversal;
      assert.equal(await codeOf(payout), 'TIP_NOT_PAYABLE');
      assert.equal(await person(), 0n);
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
      { code: 'recipient_payable', side: 'debit', amount: '372000' },
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
      assert.equal(await person(), -186000n);
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
        const mine = 334800n;
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
