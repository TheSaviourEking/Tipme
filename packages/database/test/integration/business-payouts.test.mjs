import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  balanceOf,
  businessBalanceOf,
  businessWithdrawalQuote,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  freezeWithdrawals,
  mailForDomainEvent,
  mailSealing,
  markAttemptInitiated,
  recordPayoutOutcome,
  recordProviderEvent,
  requestBusinessWithdrawal,
  requestWithdrawal,
  reverseTip,
  setPayoutDestination,
  setWithdrawalsPaused,
  startPayout,
  withdrawalQuote,
} from '../../dist/index.js';
import { queuedMail } from '../../dist/test-support.js';
import {
  seedAgreement,
  seedBusiness,
  seedManager,
  seedMember,
} from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

// Business release 2, PR R2-B: a business's own balance (its business_payable, from shares) and
// its owners' withdrawals of it, through exactly a person's balance-based withdrawal path.

const [ADA, TOBI] = DEMO_PROFILES;
const OWNER = ADA.userId;
const STAFF = '00000000-0000-7000-8000-00000000f00d';
const sealing = mailSealing(Buffer.alloc(32, 7));

// A ₦40,000 tip. Tobi receives the net after TipMe's fee; the business takes half of that (the
// owner's largest option), so its balance is big enough to withdraw in parts.
const GROSS = 4000000n;
const BPS = 5000;

/** The pretend provider's payout side, counting every start: nothing here reaches a partner. */
function provider({ balance = 200000000n } = {}) {
  const calls = { creates: 0 };
  return {
    calls,
    name: 'mock',
    capabilities: { connectedAccounts: false },
    payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
    payoutBalance: async () => ({ availableMinor: balance }),
    quotePayoutFee: async () => ({ feeMinor: 5000n, exact: false }),
    coverPayoutFee: async () => ({ transferRef: 'transfer' }),
    initiatePayout: async () => {
      calls.creates += 1;
      return {
        providerReference: `mock_out_${randomUUID()}`,
        status: 'pending',
      };
    },
    findPayoutByReference: async () => null,
    fetchPayoutStatus: async () => ({ status: 'not_found' }),
  };
}

test('a business balance and its withdrawals', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const codeOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code ?? String(error);
    }
  };

  /** The Yellow Chilli (owned by Ada's account) takes half of what Tobi receives there. */
  const atBusiness = async () => {
    const { businessId, locations } = await seedBusiness(database);
    const { memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId: TOBI.id,
    });
    const { agreementId } = await seedAgreement(database, {
      memberId,
      businessBps: BPS,
    });
    return { businessId, memberId, agreementId, locationId: locations[0].id };
  };

  /** A paid tip to Tobi; at the business, its share is fixed at intent time (as R2-C2 will). */
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
    const [{ net }] = await q(
      `SELECT q.recipient_net_minor::text AS net FROM payment_intents i
         JOIN tip_quotes q ON q.id = i.quote_id WHERE i.id = (SELECT intent_id FROM tips WHERE id = $1)`,
      [intent.tipId],
    );
    const share = (BigInt(net) * BigInt(BPS)) / 10000n;
    if (shared)
      await q(
        `INSERT INTO tip_business_shares (tip_id, agreement_id, business_id, business_bps, share_minor)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          intent.tipId,
          shared.agreementId,
          shared.businessId,
          BPS,
          share.toString(),
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
    return { tipId: intent.tipId, net: BigInt(net), share };
  };

  const businessBalance = async (businessId) =>
    (await businessBalanceOf(db, businessId)).availableMinor;
  const personBalance = async () =>
    (await balanceOf(db, TOBI.id)).availableMinor;
  const withdraw = (businessId, amountMinor, extra = {}) =>
    requestBusinessWithdrawal(db, {
      businessId,
      userId: OWNER,
      amountMinor,
      idempotencyKey: randomUUID(),
      provider: provider(),
      ...extra,
    });
  /** What the worker and the provider's answer do with a queued payout. */
  const settle = async (payoutId, outcome = 'paid') => {
    assert.equal(
      await startPayout(db, { payoutId, provider: provider() }),
      'started',
    );
    const [{ provider_reference: reference }] = await q(
      'SELECT provider_reference FROM payouts WHERE id = $1',
      [payoutId],
    );
    return recordPayoutOutcome(db, {
      payoutId,
      provider: 'mock',
      providerEventId: `evt_out_${randomUUID()}`,
      providerReference: reference,
      outcome,
      signatureVerified: true,
      payload: {},
    });
  };
  const states = (payoutId) =>
    q(
      `SELECT from_status, to_status, cause FROM status_transitions
        WHERE entity_type = 'payout' AND entity_id = $1 ORDER BY created_at, id`,
      [payoutId],
    );
  const assertBalanced = async () =>
    assert.deepEqual(
      await q(
        `SELECT transaction_id FROM ledger_entries GROUP BY transaction_id, currency
          HAVING sum(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`,
      ),
      [],
    );

  await t.test(
    'an owner reads the balance from its business_payable lines, and a person never does',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const first = await paidTip(shared);
      await paidTip(shared);
      const own = await paidTip();
      assert.equal(await businessBalance(shared.businessId), first.share * 2n);
      // Tobi's balance is their part of the two shared tips plus all of the tip through their page.
      assert.equal(
        await personBalance(),
        (first.net - first.share) * 2n + own.net,
      );
      // Tobi can't withdraw the business's share: a person's withdrawal reads only their own line.
      assert.equal(
        await codeOf(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: (await personBalance()) + 1n,
            idempotencyKey: randomUUID(),
            provider: provider(),
          }),
        ),
        'INSUFFICIENT_BALANCE',
      );
      const quote = await withdrawalQuote(db, {
        profileId: TOBI.id,
        provider: provider(),
      });
      assert.equal(quote.ledgerMinor, await personBalance());
      const business = await businessWithdrawalQuote(db, {
        businessId: shared.businessId,
        provider: provider(),
      });
      assert.equal(business.state, 'ready');
      assert.equal(business.ledgerMinor, first.share * 2n);
      assert.equal(business.withdrawableMinor, first.share * 2n);
    },
  );

  await t.test(
    'only an owner withdraws: a location manager, a stranger or a removed owner is refused',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      await paidTip(shared);
      await seedManager(database, {
        businessId: shared.businessId,
        userId: TOBI.userId,
        locationId: shared.locationId,
      });
      const as = (userId) =>
        codeOf(withdraw(shared.businessId, 500000n, { userId }));
      assert.equal(await as(TOBI.userId), 'OWNER_REQUIRED');
      assert.equal(await as(randomUUID()), 'NOT_A_MANAGER');
      // Another business's owner can't reach this one.
      const other = await seedBusiness(database, { owner: TOBI.userId });
      assert.equal(
        await codeOf(
          requestBusinessWithdrawal(db, {
            businessId: shared.businessId,
            userId: TOBI.userId,
            amountMinor: 500000n,
            idempotencyKey: randomUUID(),
            provider: provider(),
          }),
        ),
        'OWNER_REQUIRED',
      );
      assert.ok(other.businessId);
      await q(
        `UPDATE business_managers SET removed_at = now() WHERE business_id = $1 AND user_id = $2`,
        [shared.businessId, OWNER],
      );
      assert.equal(await as(OWNER), 'NOT_A_MANAGER');
      assert.equal(await q('SELECT id FROM payouts').then((r) => r.length), 0);
    },
  );

  await t.test(
    "a business's withdrawal follows a person's step for step, and takes its own business_payable",
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const { share } = await paidTip(shared);
      const personBefore = await personBalance();
      const person = await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 200000n,
        idempotencyKey: randomUUID(),
        provider: provider(),
      });
      const business = await withdraw(shared.businessId, 500000n);
      assert.equal(business.status, 'REQUESTED');
      const [row] = await q(
        'SELECT profile_id, business_id, status FROM payouts WHERE id = $1',
        [business.payoutId],
      );
      assert.deepEqual(row, {
        profile_id: null,
        business_id: shared.businessId,
        status: 'REQUESTED',
      });
      // Reserved at once, posted nowhere yet; the person's balance is untouched by it.
      assert.equal(await businessBalance(shared.businessId), share - 500000n);
      assert.equal(await personBalance(), personBefore - 200000n);
      // One start job, as for a person.
      assert.deepEqual(
        await q(
          `SELECT payload->>'businessId' AS business, payload->>'profileId' AS profile
             FROM outbox_events WHERE event_type = 'payouts.start' AND aggregate_id = $1`,
          [business.payoutId],
        ),
        [{ business: shared.businessId, profile: null }],
      );
      await settle(person.payoutId);
      await settle(business.payoutId);
      assert.deepEqual(
        await states(business.payoutId),
        await states(person.payoutId),
      );
      assert.deepEqual(
        (await states(business.payoutId)).map((s) => s.to_status),
        ['REQUESTED', 'PROCESSING', 'PAID'],
      );
      // Paid: the business's own line is debited, never Tobi's. The business pays the ₦50
      // transfer fee from the amount (owner, 12 Nov 2026): ₦4,950 sent, ₦50 fee, both its own.
      const lines = (key) =>
        q(
          `SELECT a.code, e.side, e.amount_minor::text AS amount, e.business_id, e.profile_id
             FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
             JOIN ledger_transactions x ON x.id = e.transaction_id
            WHERE x.payout_id = $1 AND x.operation_key = $2 || $1::text
            ORDER BY a.code`,
          [business.payoutId, key],
        );
      for (const [key, amount] of [
        ['payout.', '495000'],
        ['payout-user-fee.', '5000'],
      ])
        assert.deepEqual(await lines(key), [
          {
            code: 'business_payable',
            side: 'debit',
            amount,
            business_id: shared.businessId,
            profile_id: null,
          },
          {
            code: 'provider_clearing',
            side: 'credit',
            amount,
            business_id: null,
            profile_id: null,
          },
        ]);
      assert.equal(await businessBalance(shared.businessId), share - 500000n);
      assert.equal(await personBalance(), personBefore - 200000n);
      await assertBalanced();
    },
  );

  await t.test(
    'a failed business withdrawal returns the money to the business, and its owners are told',
    async () => {
      await database.fresh();
      await q(
        `UPDATE users SET email = 'owner@example.com', email_verified_at = now() WHERE id = $1`,
        [OWNER],
      );
      const shared = await atBusiness();
      const { share } = await paidTip(shared);
      const paid = await withdraw(shared.businessId, 500000n);
      await settle(paid.payoutId);
      const failed = await withdraw(shared.businessId, 600000n);
      assert.equal(await businessBalance(shared.businessId), share - 1100000n);
      await settle(failed.payoutId, 'failed');
      assert.equal(await businessBalance(shared.businessId), share - 500000n);
      // The worker's mail step: before R2-B it threw NOT_A_PERSON for every business payout.
      await mailForDomainEvent(db, sealing, 'payout.paid', {
        payoutId: paid.payoutId,
      });
      await mailForDomainEvent(db, sealing, 'payout.failed', {
        payoutId: failed.payoutId,
      });
      const mail = (await queuedMail(db, sealing, { limit: 100 })).filter(
        (m) => m.type === 'withdrawal_paid' || m.type === 'withdrawal_failed',
      );
      assert.deepEqual(
        mail.map((m) => [m.type, m.to, m.data.businessName]).sort(),
        [
          ['withdrawal_failed', 'owner@example.com', 'The Yellow Chilli'],
          ['withdrawal_paid', 'owner@example.com', 'The Yellow Chilli'],
        ],
      );
      await assertBalanced();
    },
  );

  await t.test(
    'a retry with the same key replays; another amount on it, or a person’s key, conflicts',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      await paidTip(shared);
      const idempotencyKey = randomUUID();
      const input = {
        businessId: shared.businessId,
        userId: OWNER,
        amountMinor: 500000n,
        idempotencyKey,
        provider: provider(),
      };
      const [first, again] = await Promise.all([
        requestBusinessWithdrawal(db, input),
        requestBusinessWithdrawal(db, input),
      ]);
      assert.equal(first.payoutId, again.payoutId);
      const replay = await requestBusinessWithdrawal(db, input);
      assert.equal(replay.payoutId, first.payoutId);
      assert.equal(replay.replayed, true);
      assert.equal(
        await codeOf(
          requestBusinessWithdrawal(db, { ...input, amountMinor: 600000n }),
        ),
        'IDEMPOTENCY_CONFLICT',
      );
      // The same key and amount from Tobi's own withdrawal is another request, never this one.
      assert.equal(
        await codeOf(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 200000n,
            idempotencyKey,
            provider: provider(),
          }),
        ),
        'IDEMPOTENCY_CONFLICT',
      );
      assert.equal(
        (
          await q(
            `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'payouts.start' AND aggregate_id = $1`,
            [first.payoutId],
          )
        )[0].n,
        1,
      );
    },
  );

  await t.test(
    'two withdrawals at once can never overdraw the business',
    async () => {
      for (let round = 0; round < 5; round++) {
        await database.fresh();
        const shared = await atBusiness();
        const { share } = await paidTip(shared);
        // Each alone fits; both together are more than the business has.
        const amount = share / 2n + 1n;
        const results = await Promise.allSettled([
          withdraw(shared.businessId, amount),
          withdraw(shared.businessId, amount),
        ]);
        const done = results.filter((r) => r.status === 'fulfilled');
        assert.equal(done.length, 1, `round ${round}`);
        assert.equal(
          results.find((r) => r.status === 'rejected').reason.code,
          'INSUFFICIENT_BALANCE',
        );
        assert.equal(
          await businessBalance(shared.businessId),
          share - amount,
          `round ${round}`,
        );
      }
    },
  );

  await t.test(
    'the withdrawals switch stops a business withdrawal',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      await paidTip(shared);
      await setWithdrawalsPaused(db, {
        paused: true,
        staffUserId: STAFF,
        reason: 'A wrong payout amount: stopping while we look.',
      });
      assert.equal(
        await codeOf(withdraw(shared.businessId, 500000n)),
        'WITHDRAWALS_SWITCHED_OFF',
      );
      assert.deepEqual(
        await businessWithdrawalQuote(db, {
          businessId: shared.businessId,
          provider: provider(),
        }),
        { state: 'paused', reason: 'switched_off' },
      );
      assert.equal(await q('SELECT id FROM payouts').then((r) => r.length), 0);
    },
  );

  await t.test(
    "a takeover freeze on an owner's own account stops the business's withdrawals and its queued start",
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      await paidTip(shared);
      const queued = await withdraw(shared.businessId, 500000n);
      await freezeWithdrawals(db, {
        profileId: ADA.id,
        staffUserId: STAFF,
        reason: 'The owner reported their account was taken over.',
      });
      assert.equal(
        await codeOf(withdraw(shared.businessId, 500000n)),
        'WITHDRAWALS_PAUSED',
      );
      assert.deepEqual(
        await businessWithdrawalQuote(db, {
          businessId: shared.businessId,
          provider: provider(),
        }),
        { state: 'paused', reason: 'review' },
      );
      // The payout queued before the freeze is a person's to decide: never sent.
      const fake = provider();
      assert.equal(
        await startPayout(db, { payoutId: queued.payoutId, provider: fake }),
        'held',
      );
      assert.equal(fake.calls.creates, 0);
      assert.equal(
        (
          await q(
            `SELECT id FROM issues WHERE status = 'open' AND kind = 'payout_held' AND subject->>'payoutId' = $1`,
            [queued.payoutId],
          )
        ).length,
        1,
      );
      // The business's own bank can't be changed either.
      assert.equal(
        await codeOf(
          setPayoutDestination(db, {
            businessId: shared.businessId,
            userId: OWNER,
            provider: 'mock',
            destinationRef: 'mock_dest_1',
            bankCode: '058',
            bankName: 'Pretend Guaranty Bank',
            last4: '1234',
            status: 'usable',
            sealing,
          }),
        ),
        'WITHDRAWALS_PAUSED',
      );
    },
  );

  await t.test(
    'below zero after a reversal, the business can’t withdraw until it is back (Q8)',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const { tipId, share } = await paidTip(shared);
      const all = await withdraw(shared.businessId, share);
      await settle(all.payoutId);
      assert.equal(await businessBalance(shared.businessId), 0n);
      // The tip is refunded after the business took its share out: it goes below zero.
      const reversed = await db.transaction((tx) =>
        reverseTip(tx, {
          tipId,
          partnerReversalId: `refund.rfnd_${randomUUID()}`,
          refundedMinor: GROSS,
        }),
      );
      assert.deepEqual(
        reversed.belowZero.filter((b) => 'businessId' in b),
        [{ businessId: shared.businessId }],
      );
      assert.equal(await businessBalance(shared.businessId), -share);
      // Below zero: refused, whatever the amount.
      assert.equal(
        await codeOf(withdraw(shared.businessId, 1n)),
        'BALANCE_BELOW_ZERO',
      );
      assert.deepEqual(
        await businessWithdrawalQuote(db, {
          businessId: shared.businessId,
          provider: provider(),
        }),
        { state: 'paused', reason: 'reversal' },
      );
      assert.equal(
        (
          await q(
            `SELECT id FROM issues WHERE kind = 'balance_below_zero' AND subject->>'businessId' = $1`,
            [shared.businessId],
          )
        ).length,
        1,
      );
      // A new shared tip brings it back to zero: no longer paused, with nothing yet to take.
      await paidTip(shared);
      assert.equal(await businessBalance(shared.businessId), 0n);
      const atZero = await businessWithdrawalQuote(db, {
        businessId: shared.businessId,
        provider: provider(),
      });
      assert.equal(atZero.state, 'ready');
      assert.equal(atZero.withdrawableMinor, 0n);
      // Above zero, it can withdraw again.
      await paidTip(shared);
      const back = await businessBalance(shared.businessId);
      assert.ok(back > 0n);
      assert.equal(
        (await withdraw(shared.businessId, back)).status,
        'REQUESTED',
      );
      await assertBalanced();
    },
  );

  await t.test(
    'a reversal racing a business withdrawal: exactly one of them sees the money',
    async () => {
      for (let round = 0; round < 5; round++) {
        await database.fresh();
        const shared = await atBusiness();
        const { tipId, share } = await paidTip(shared);
        const [withdrawal, reversal] = await Promise.allSettled([
          withdraw(shared.businessId, share),
          db.transaction((tx) =>
            reverseTip(tx, {
              tipId,
              partnerReversalId: `refund.rfnd_${randomUUID()}`,
              refundedMinor: GROSS,
            }),
          ),
        ]);
        assert.equal(reversal.status, 'fulfilled', `round ${round}`);
        if (withdrawal.status === 'fulfilled') {
          // The withdrawal took the lock first: the reversal then took the business below zero.
          assert.equal(await businessBalance(shared.businessId), -share);
          assert.deepEqual(
            reversal.value.belowZero.filter((b) => 'businessId' in b),
            [{ businessId: shared.businessId }],
          );
        } else {
          // The reversal took it first: nothing was left to withdraw.
          assert.equal(withdrawal.reason.code, 'INSUFFICIENT_BALANCE');
          assert.equal(await businessBalance(shared.businessId), 0n);
          assert.equal(
            await q('SELECT id FROM payouts').then((r) => r.length),
            0,
          );
        }
        await assertBalanced();
      }
    },
  );

  await t.test(
    "an owner sets the business's own bank; the next withdrawal goes there, and owners are told of a change",
    async () => {
      await database.fresh();
      await q(
        `UPDATE users SET email = 'owner@example.com', email_verified_at = now() WHERE id = $1`,
        [OWNER],
      );
      const shared = await atBusiness();
      await paidTip(shared);
      const set = (last4, userId = OWNER) =>
        setPayoutDestination(db, {
          businessId: shared.businessId,
          userId,
          provider: 'mock',
          destinationRef: `mock_dest_${last4}`,
          bankCode: '058',
          bankName: 'Pretend Guaranty Bank',
          last4,
          status: 'usable',
          sealing,
        });
      assert.equal(await codeOf(set('1111', TOBI.userId)), 'NOT_A_MANAGER');
      assert.deepEqual(await set('1111'), { replaced: false });
      assert.deepEqual(await set('2222'), { replaced: true });
      const quote = await businessWithdrawalQuote(db, {
        businessId: shared.businessId,
        provider: provider(),
      });
      assert.deepEqual(quote.destination, {
        bankName: 'Pretend Guaranty Bank',
        last4: '2222',
      });
      const { payoutId } = await withdraw(shared.businessId, 500000n);
      assert.deepEqual(
        await q(
          `SELECT d.account_last4 AS last4, d.business_id, d.profile_id
             FROM payouts p JOIN payout_destinations d ON d.id = p.destination_id WHERE p.id = $1`,
          [payoutId],
        ),
        [{ last4: '2222', business_id: shared.businessId, profile_id: null }],
      );
      // Tobi's own bank is untouched by it.
      assert.equal(
        (
          await q('SELECT id FROM payout_destinations WHERE profile_id = $1', [
            TOBI.id,
          ])
        ).length,
        0,
      );
      const changed = (await queuedMail(db, sealing, { limit: 100 })).filter(
        (m) => m.type === 'payout_destination_changed',
      );
      assert.deepEqual(
        changed.map((m) => [m.to, m.data.businessName, m.data.last4]),
        [['owner@example.com', 'The Yellow Chilli', '2222']],
      );
    },
  );
});
