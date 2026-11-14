import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  balanceOf,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  grantCashReward,
  markAttemptInitiated,
  markPayoutInitiated,
  reconcilePayouts,
  recordProviderEvent,
  requestWithdrawal,
  withdrawalQuote,
  withdrawalsAvailable,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const { createMockProvider } = await import('../../../payments/dist/index.js');
const { Redis } = createRequire(
  new URL('../../../payments/package.json', import.meta.url),
)('ioredis');
const [ADA, TOBI] = DEMO_PROFILES;

test('withdrawals', async (t) => {
  const database = await useDatabase(t);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const mock = () =>
    createMockProvider({ redis, prefix: `w-${randomUUID().slice(0, 8)}` });
  const errorCode = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code;
    }
  };
  /** Tobi gets one confirmed ₦2,000 tip: NGN 1,860.00 net. */
  const paidTip = async () => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: 400000n,
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
      amountMinor: 400000n,
      currency: 'NGN',
      providerFeeMinor: 3000n,
      signatureVerified: true,
      payload: {},
    });
  };
  const available = async () => (await balanceOf(db, TOBI.id)).availableMinor;
  const queuedJobs = async (payoutId) =>
    (
      await q(
        `SELECT count(*)::int AS n FROM outbox_events
          WHERE event_type = 'payouts.start' AND aggregate_id = $1`,
        [payoutId],
      )
    )[0].n;
  /** What the worker does with the queued job: the request itself reaches no provider. */
  const startOnMock = async (provider, payoutId, scenario) => {
    const [row] = await q(
      'SELECT amount_minor, currency FROM payouts WHERE id = $1',
      [payoutId],
    );
    const { providerReference } = await provider.initiatePayout({
      payoutId,
      idempotencyKey: `payout.${payoutId}`,
      amountMinor: BigInt(row.amount_minor),
      currency: row.currency,
      scenario,
    });
    await markPayoutInitiated(db, {
      payoutId,
      provider: provider.name,
      providerReference,
    });
    return providerReference;
  };

  await t.test(
    'a withdrawal reserves part of the balance, then settles it once paid',
    async () => {
      await database.fresh();
      await paidTip();
      assert.equal(await available(), 372000n);
      const provider = mock();
      const key = randomUUID();
      const first = await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 200000n,
        idempotencyKey: key,
        provider,
      });
      assert.equal(first.status, 'REQUESTED');
      assert.equal(await available(), 172000n);
      const reference = await startOnMock(
        provider,
        first.payoutId,
        'payout-paid',
      );
      assert.match(reference, /^mock_out_/);
      // The same key and amount replays; another amount is a conflict.
      assert.equal(
        (
          await requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 200000n,
            idempotencyKey: key,
            provider,
          })
        ).payoutId,
        first.payoutId,
      );
      assert.equal(
        await errorCode(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 300000n,
            idempotencyKey: key,
            provider,
          }),
        ),
        'IDEMPOTENCY_CONFLICT',
      );
      await provider.settlePayout(reference);
      await reconcilePayouts({ db, provider, now: new Date(), minAgeMs: 0 });
      assert.equal(
        (
          await q('SELECT status FROM payouts WHERE id = $1', [first.payoutId])
        )[0].status,
        'PAID',
      );
      assert.equal(await available(), 172000n);
      const unbalanced =
        await q(`SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
      HAVING SUM(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`);
      assert.deepEqual(unbalanced, []);
    },
  );

  await t.test(
    'a failed withdrawal returns the money to the balance',
    async () => {
      await database.fresh();
      await paidTip();
      const provider = mock();
      const withdrawal = await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 372000n,
        idempotencyKey: randomUUID(),
        provider,
      });
      assert.equal(await available(), 0n);
      await provider.settlePayout(
        await startOnMock(provider, withdrawal.payoutId, 'payout-failed'),
      );
      await reconcilePayouts({ db, provider, now: new Date(), minAgeMs: 0 });
      assert.equal(await available(), 372000n);
    },
  );

  await t.test(
    'concurrent retries of one request make one payout and one queued job',
    async () => {
      await database.fresh();
      await paidTip();
      const idempotencyKey = randomUUID();
      const input = {
        profileId: TOBI.id,
        amountMinor: 200000n,
        idempotencyKey,
        provider: mock(),
      };
      const [first, replay] = await Promise.all([
        requestWithdrawal(db, input),
        requestWithdrawal(db, input),
      ]);
      assert.equal(first.payoutId, replay.payoutId);
      assert.equal(
        (
          await q(
            'SELECT count(*)::int AS n FROM payouts WHERE idempotency_key = $1',
            [idempotencyKey],
          )
        )[0].n,
        1,
      );
      assert.equal(await queuedJobs(first.payoutId), 1);
      await requestWithdrawal(db, input);
      assert.equal(await queuedJobs(first.payoutId), 1);
    },
  );

  await t.test(
    'more than the balance, zero, or two at once that add up to too much are refused',
    async () => {
      await database.fresh();
      await paidTip();
      const provider = mock();
      assert.equal(
        await errorCode(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 374002n,
            idempotencyKey: randomUUID(),
            provider,
          }),
        ),
        'INSUFFICIENT_BALANCE',
      );
      assert.equal(
        await errorCode(
          requestWithdrawal(db, {
            profileId: TOBI.id,
            amountMinor: 0n,
            idempotencyKey: randomUUID(),
            provider,
          }),
        ),
        'INVALID_INPUT',
      );
      const results = await Promise.allSettled([
        requestWithdrawal(db, {
          profileId: TOBI.id,
          amountMinor: 200000n,
          idempotencyKey: randomUUID(),
          provider,
        }),
        requestWithdrawal(db, {
          profileId: TOBI.id,
          amountMinor: 200000n,
          idempotencyKey: randomUUID(),
          provider,
        }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        results.find((r) => r.status === 'rejected').reason.code,
        'INSUFFICIENT_BALANCE',
      );
      assert.equal(await available(), 172000n);
    },
  );

  await t.test('a cash bonus from TipMe is withdrawable', async () => {
    await database.fresh();
    await grantCashReward(db, {
      profileId: TOBI.id,
      amountMinor: 200000n,
      currency: 'NGN',
      operationKey: `reward.test.${randomUUID()}`,
    });
    assert.equal(await available(), 200000n);
    const rows =
      await q(`SELECT a.code, e.side, e.amount_minor FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.operation_type = 'reward' ORDER BY a.code`);
    assert.deepEqual(
      rows.map((r) => [r.code, r.side, r.amount_minor]),
      [
        ['promotions_expense', 'debit', '200000'],
        ['recipient_payable', 'credit', '200000'],
      ],
    );
    const withdrawal = await requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor: 200000n,
      idempotencyKey: randomUUID(),
      provider: mock(),
    });
    assert.equal(withdrawal.status, 'REQUESTED');
  });
});

test('money collected by a provider without payouts can never be withdrawn through another', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  await database.fresh();
  // The dashboard asks the same question before the owner types an amount.
  assert.equal(
    await withdrawalsAvailable(db, { profileId: TOBI.id, provider: 'mock' }),
    true,
  );
  const quote = await createQuote(db, {
    handle: 'tobi',
    tipMinor: 400000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = 'acct_tobi:chk_paid';
  await markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: reference,
  });
  await recordProviderEvent(db, {
    provider: 'bachs',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 400000n,
    currency: 'NGN',
    providerFeeMinor: 3000n,
    signatureVerified: true,
    payload: {},
  });
  assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 372000n);
  let started = false;
  await assert.rejects(
    requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor: 372000n,
      idempotencyKey: randomUUID(),
      provider: {
        name: 'mock',
        async initiatePayout() {
          started = true;
          return { providerReference: 'never' };
        },
      },
    }),
    { code: 'WITHDRAWAL_UNAVAILABLE' },
  );
  assert.equal(started, false);
  assert.equal(
    (await database.pool.query('SELECT count(*)::int AS n FROM payouts'))
      .rows[0].n,
    0,
  );
  assert.equal(
    await withdrawalsAvailable(db, { profileId: TOBI.id, provider: 'mock' }),
    false,
  );
  // Only the profile that holds such money is affected.
  assert.equal(
    await withdrawalsAvailable(db, { profileId: ADA.id, provider: 'mock' }),
    true,
  );
});

test('withdrawals through the provider', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const errorCode = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const ACCOUNT = 'acct_tobi';
  /** A provider with connected accounts, as Bachs is; every money write fails the test. */
  const bachsLike = (overrides = {}) => ({
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: true },
    reads: [],
    async payoutCapability(accountRef) {
      this.reads.push(`capability:${accountRef}`);
      return { status: 'active', requirementsDue: [] };
    },
    async payoutBalance(accountRef, currency) {
      this.reads.push(`balance:${accountRef}:${currency}`);
      return { availableMinor: 1000000n };
    },
    async quotePayoutFee() {
      return { feeMinor: 5000n, exact: false };
    },
    async initiatePayout() {
      throw new Error('the request must not start a payout');
    },
    async coverPayoutFee() {
      throw new Error('the request must not move the fee');
    },
    ...overrides,
  });
  /** One ₦2,000 tip collected through Bachs: NGN 1,860.00 net for Tobi. */
  const bachsTip = async () => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: 400000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const reference = `${ACCOUNT}:chk_${randomUUID().slice(0, 8)}`;
    await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'bachs',
      providerReference: reference,
    });
    await recordProviderEvent(db, {
      provider: 'bachs',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: 400000n,
      currency: 'NGN',
      providerFeeMinor: 3000n,
      signatureVerified: true,
      payload: {},
    });
  };
  const seedAccount = () =>
    q(
      `INSERT INTO payment_accounts
         (id, profile_id, provider, environment, provider_account_reference, status,
          charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
       VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, 'platform', now())`,
      [randomUUID(), TOBI.id, ACCOUNT],
    );
  const seedDestination = async (status = 'usable') => {
    const id = randomUUID();
    await q(
      `INSERT INTO payout_destinations
         (id, profile_id, provider, destination_reference, bank_code, bank_name,
          account_last4, status)
       VALUES ($1, $2, 'bachs', $3, '058', 'Guaranty Trust Bank', '4321', $4)`,
      [id, TOBI.id, `ba_${id.slice(0, 8)}`, status],
    );
    return id;
  };
  const seedHold = async (reason = 'reversal') => {
    const issueId = randomUUID();
    await q(
      `INSERT INTO issues (id, kind, dedupe_key, severity, subject, summary, opened_at)
       VALUES ($1, 'payment_reversed', $2, 'money', $3, 'test', now())`,
      [issueId, `test.${issueId}`, JSON.stringify({ profileId: TOBI.id })],
    );
    await q(
      `INSERT INTO withdrawal_holds (id, profile_id, reason, issue_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), TOBI.id, reason, issueId],
    );
  };
  const ready = async () => {
    await database.fresh();
    await bachsTip();
    await seedAccount();
    return seedDestination();
  };
  const withdraw = (provider, amountMinor, idempotencyKey = randomUUID()) =>
    requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor,
      idempotencyKey,
      provider,
    });
  const payoutCount = async () =>
    (await q('SELECT count(*)::int AS n FROM payouts'))[0].n;
  const startJobs = async () =>
    (
      await q(
        `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'payouts.start'`,
      )
    )[0].n;
  const quoteOf = (provider) =>
    withdrawalQuote(db, { profileId: TOBI.id, provider });
  const withBalance = (availableMinor) =>
    bachsLike({
      async payoutBalance() {
        return { availableMinor };
      },
    });

  await t.test(
    'the withdrawable amount is the lower of the ledger and Bachs balances',
    async () => {
      await ready();
      assert.deepEqual(await quoteOf(withBalance(240000n)), {
        state: 'ready',
        withdrawableMinor: 240000n,
        ledgerMinor: 372000n,
        providerMinor: 240000n,
        feeMinor: 5000n,
        destination: { bankName: 'Guaranty Trust Bank', last4: '4321' },
      });
      const more = await quoteOf(withBalance(1800000n));
      assert.equal(more.withdrawableMinor, 372000n);
      assert.equal(
        await errorCode(withdraw(withBalance(240000n), 240002n)),
        'INSUFFICIENT_BALANCE',
      );
      assert.equal(
        await errorCode(withdraw(withBalance(1800000n), 372002n)),
        'INSUFFICIENT_BALANCE',
      );
      assert.equal(await payoutCount(), 0);
      assert.ok((await withdraw(withBalance(240000n), 240000n)).payoutId);
    },
  );

  await t.test(
    'money queued but not started still counts against the Bachs balance',
    async () => {
      await ready();
      const provider = withBalance(240000n);
      await withdraw(provider, 200000n);
      // Bachs still reports 120000 because nothing has left it yet: only 20000 can follow.
      assert.equal(
        await errorCode(withdraw(provider, 160000n)),
        'INSUFFICIENT_BALANCE',
      );
      const quote = await quoteOf(provider);
      assert.equal(quote.ledgerMinor, 172000n);
      assert.equal(quote.withdrawableMinor, 40000n);
    },
  );

  await t.test(
    'a Bachs balance read that fails disables withdrawing, it never falls back to the ledger',
    async () => {
      await ready();
      const broken = {
        payoutBalance: async () => {
          throw new Error('timeout');
        },
      };
      const failing = [
        bachsLike(broken),
        bachsLike({
          payoutCapability: async () => {
            throw new Error('timeout');
          },
        }),
        bachsLike({
          quotePayoutFee: async () => {
            throw new Error('timeout');
          },
        }),
      ];
      for (const provider of failing) {
        assert.deepEqual(await quoteOf(provider), {
          state: 'provider_unavailable',
        });
        assert.equal(
          await errorCode(withdraw(provider, 200000n)),
          'PAYOUT_PROVIDER_UNAVAILABLE',
        );
      }
      assert.equal(await payoutCount(), 0);
      assert.equal(await startJobs(), 0);
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 372000n);
    },
  );

  await t.test(
    'an active hold pauses withdrawals with its reason',
    async () => {
      await ready();
      await seedHold('in_debt');
      assert.deepEqual(await quoteOf(bachsLike()), {
        state: 'paused',
        reason: 'in_debt',
      });
      assert.equal(
        await errorCode(withdraw(bachsLike(), 200000n)),
        'WITHDRAWALS_PAUSED',
      );
      assert.equal(await payoutCount(), 0);
      await q(
        'UPDATE withdrawal_holds SET released_at = now() WHERE profile_id = $1',
        [TOBI.id],
      );
      assert.equal((await quoteOf(bachsLike())).state, 'ready');
      assert.ok((await withdraw(bachsLike(), 200000n)).payoutId);
    },
  );

  await t.test(
    'a hold created after the provider was read is still seen',
    async () => {
      await ready();
      const provider = bachsLike({
        async payoutBalance() {
          await seedHold('reversal');
          return { availableMinor: 1000000n };
        },
      });
      assert.equal(
        await errorCode(withdraw(provider, 200000n)),
        'WITHDRAWALS_PAUSED',
      );
      assert.equal(await payoutCount(), 0);
    },
  );

  await t.test(
    'a withdrawal records destination and fee and queues payouts.start, calling no provider',
    async () => {
      const destinationId = await ready();
      const provider = bachsLike();
      const result = await withdraw(provider, 200000n);
      assert.equal(result.status, 'REQUESTED');
      assert.equal(result.replayed, false);
      const [row] = await q('SELECT * FROM payouts WHERE id = $1', [
        result.payoutId,
      ]);
      assert.equal(row.provider, 'bachs');
      assert.equal(row.destination_id, destinationId);
      assert.equal(row.fee_minor, '5000');
      assert.equal(row.account_reference, ACCOUNT);
      assert.equal(row.provider_reference, null);
      const jobs = await q(
        `SELECT aggregate_id, payload FROM outbox_events WHERE event_type = 'payouts.start'`,
      );
      assert.deepEqual(jobs, [
        {
          aggregate_id: result.payoutId,
          payload: { payoutId: result.payoutId, profileId: TOBI.id },
        },
      ]);
      // Reads were made of Tobi's own account; bachsLike throws on any money write.
      assert.deepEqual(provider.reads, [
        `capability:${ACCOUNT}`,
        `balance:${ACCOUNT}:NGN`,
      ]);
    },
  );

  await t.test(
    'a replay returns the payout unchanged whatever changed since, and queues nothing',
    async () => {
      await ready();
      const key = randomUUID();
      const first = await withdraw(bachsLike(), 200000n, key);
      await seedHold();
      const unreachable = bachsLike({
        async payoutCapability() {
          throw new Error('a replay must not read the provider');
        },
        async payoutBalance() {
          throw new Error('a replay must not read the provider');
        },
      });
      const replay = await withdraw(unreachable, 200000n, key);
      assert.equal(replay.payoutId, first.payoutId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.status, 'REQUESTED');
      assert.equal(await startJobs(), 1);
      assert.equal(await payoutCount(), 1);
    },
  );

  await t.test(
    'the same key after the bank account changed replays the payout, which keeps its destination',
    async () => {
      const destinationId = await ready();
      const key = randomUUID();
      const first = await withdraw(bachsLike(), 200000n, key);
      await q(
        'UPDATE payout_destinations SET replaced_at = now() WHERE profile_id = $1',
        [TOBI.id],
      );
      await seedDestination();
      const replay = await withdraw(bachsLike(), 200000n, key);
      assert.equal(replay.replayed, true);
      assert.equal(replay.payoutId, first.payoutId);
      assert.equal(await payoutCount(), 1);
      const [row] = await q(
        'SELECT destination_id FROM payouts WHERE id = $1',
        [first.payoutId],
      );
      assert.equal(row.destination_id, destinationId);
    },
  );

  await t.test(
    'a bank account replaced while the provider was being read refuses the withdrawal',
    async () => {
      await ready();
      const provider = bachsLike({
        async payoutBalance() {
          await q(
            'UPDATE payout_destinations SET replaced_at = now() WHERE profile_id = $1',
            [TOBI.id],
          );
          await seedDestination();
          return { availableMinor: 1000000n };
        },
      });
      assert.equal(
        await errorCode(withdraw(provider, 200000n)),
        'PAYOUT_DESTINATION_NEEDED',
      );
      assert.equal(await payoutCount(), 0);
    },
  );

  await t.test(
    'without a usable destination the quote asks for one',
    async () => {
      await database.fresh();
      await bachsTip();
      await seedAccount();
      assert.deepEqual(await quoteOf(bachsLike()), { state: 'no_destination' });
      assert.equal(
        await errorCode(withdraw(bachsLike(), 200000n)),
        'PAYOUT_DESTINATION_NEEDED',
      );
      const pending = await seedDestination('pending_review');
      assert.deepEqual(await quoteOf(bachsLike()), {
        state: 'destination_pending',
      });
      assert.equal(
        await errorCode(withdraw(bachsLike(), 200000n)),
        'PAYOUT_DESTINATION_NEEDED',
      );
      await q(
        `UPDATE payout_destinations SET status = 'rejected' WHERE id = $1`,
        [pending],
      );
      assert.deepEqual(await quoteOf(bachsLike()), { state: 'no_destination' });
      assert.equal(await payoutCount(), 0);
    },
  );

  await t.test(
    'a restricted payout capability shows what Bachs still needs',
    async () => {
      await ready();
      const restricted = bachsLike({
        async payoutCapability() {
          return { status: 'restricted', requirementsDue: ['id_document'] };
        },
      });
      assert.deepEqual(await quoteOf(restricted), {
        state: 'setup_needed',
        requirementsDue: ['id_document'],
      });
      assert.equal(
        await errorCode(withdraw(restricted, 200000n)),
        'PAYOUT_SETUP_NEEDED',
      );
      const missing = bachsLike({
        async payoutCapability() {
          return { status: 'missing', requirementsDue: [] };
        },
      });
      assert.equal((await quoteOf(missing)).state, 'setup_needed');
      assert.equal(await payoutCount(), 0);
    },
  );

  await t.test(
    'no connected account for this provider asks for setup',
    async () => {
      await database.fresh();
      await bachsTip();
      const provider = bachsLike();
      assert.deepEqual(await quoteOf(provider), {
        state: 'setup_needed',
        requirementsDue: [],
      });
      assert.equal(
        await errorCode(withdraw(provider, 200000n)),
        'PAYOUT_SETUP_NEEDED',
      );
      // An account in the other environment is not this provider's account.
      await seedAccount();
      const live = bachsLike({ name: 'bachs-live' });
      assert.equal((await quoteOf(live)).state, 'setup_needed');
      assert.deepEqual(provider.reads, []);
    },
  );

  await t.test(
    'the ₦2,000 minimum and the withdraw-everything exception still hold',
    async () => {
      await ready();
      assert.equal(
        await errorCode(withdraw(bachsLike(), 199998n)),
        'WITHDRAWAL_TOO_SMALL',
      );
      await withdraw(bachsLike(), 200000n);
      assert.equal(
        await errorCode(withdraw(bachsLike(), 100000n)),
        'WITHDRAWAL_TOO_SMALL',
      );
      assert.ok((await withdraw(bachsLike(), 172000n)).payoutId);
    },
  );

  await t.test(
    'Bachs-collected tips can be withdrawn through either Bachs name, recorded as bachs',
    async () => {
      await ready();
      assert.equal(
        await withdrawalsAvailable(db, {
          profileId: TOBI.id,
          provider: 'bachs-sandbox',
        }),
        true,
      );
      const { payoutId } = await withdraw(bachsLike(), 200000n);
      assert.equal(
        (await q('SELECT provider FROM payouts WHERE id = $1', [payoutId]))[0]
          .provider,
        'bachs',
      );
      assert.equal(
        await withdrawalsAvailable(db, {
          profileId: TOBI.id,
          provider: 'bachs-live',
        }),
        true,
      );
    },
  );

  await t.test(
    'the pretend provider needs no account or bank and still queues the job',
    async () => {
      await database.fresh();
      const redis = new Redis(
        process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      );
      t.after(() => redis.quit());
      const provider = createMockProvider({
        redis,
        prefix: `w-${randomUUID().slice(0, 8)}`,
      });
      await grantCashReward(db, {
        profileId: TOBI.id,
        amountMinor: 200000n,
        currency: 'NGN',
        operationKey: `reward.test.${randomUUID()}`,
      });
      const quote = await quoteOf(provider);
      assert.equal(quote.state, 'ready');
      assert.equal(quote.withdrawableMinor, 200000n);
      assert.deepEqual(quote.destination, {
        bankName: 'Pretend bank',
        last4: '0000',
      });
      const { payoutId } = await withdraw(provider, 200000n);
      const [row] = await q('SELECT * FROM payouts WHERE id = $1', [payoutId]);
      assert.equal(row.provider, 'mock');
      assert.equal(row.account_reference, null);
      assert.equal(row.destination_id, null);
      assert.equal(row.fee_minor, '5000');
      assert.equal(await startJobs(), 1);
    },
  );
});
