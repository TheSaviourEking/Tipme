import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  markPayoutInitiated,
  recordPayoutOutcome,
  recordProviderEvent,
  localWithdrawalQuote,
  requestWithdrawal,
  withdrawalQuote,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [ADA, TOBI] = DEMO_PROFILES;

/**
 * The pretend provider's shape, counting every call, with a balance the test can move. `perAccount`
 * answers each account its own balance; `bachs` is a provider with connected accounts.
 */
function countingProvider({ bachs = false, perAccount = null } = {}) {
  const state = {
    calls: 0,
    availableMinor: 100_000_000n,
    fail: false,
    exact: false,
  };
  const touch = () => {
    state.calls += 1;
    if (state.fail) throw new Error('partner unreachable');
  };
  return {
    state,
    name: bachs ? 'bachs-sandbox' : 'mock',
    capabilities: { connectedAccounts: bachs },
    async payoutCapability() {
      touch();
      return { status: 'active', requirementsDue: [] };
    },
    async payoutBalance(accountRef) {
      touch();
      return {
        availableMinor: perAccount
          ? perAccount[accountRef]
          : state.availableMinor,
      };
    },
    async quotePayoutFee() {
      touch();
      return { feeMinor: 5000n, exact: state.exact };
    },
  };
}

/** What the API's Redis cache does, in memory: one shared version per account. */
function memoryCache() {
  const entries = new Map();
  const versions = new Map();
  const scopeKey = ({ provider, profileId }) => `${provider}:${profileId}`;
  return {
    entries,
    async open(scope) {
      const prefix = `${scopeKey(scope)}:${versions.get(scopeKey(scope)) ?? 0}`;
      return {
        async get(part) {
          return entries.get(`${prefix}:${part}`) ?? null;
        },
        async set(part, value) {
          entries.set(`${prefix}:${part}`, value);
        },
      };
    },
    invalidate(scope) {
      versions.set(scopeKey(scope), (versions.get(scopeKey(scope)) ?? 0) + 1);
    },
  };
}

test('partner quote cache', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  /** Tobi gets one confirmed ₦2,000 tip: NGN 1,800.00 net. */
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
  const setup = async () => {
    await database.fresh();
    await paidTip();
    return { provider: countingProvider(), cache: memoryCache() };
  };
  const quote = (provider, cache) =>
    withdrawalQuote(db, { profileId: TOBI.id, provider, cache });
  const withdraw = (provider, amountMinor, extra = {}) =>
    requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor,
      idempotencyKey: randomUUID(),
      provider,
      ...extra,
    });
  const started = async (payoutId) => {
    const reference = `mock_out_${randomUUID()}`;
    await markPayoutInitiated(db, {
      payoutId,
      provider: 'mock',
      providerReference: reference,
    });
    return reference;
  };
  const outcome = (payoutId, providerReference, result) =>
    recordPayoutOutcome(db, {
      payoutId,
      provider: 'mock',
      providerEventId: `evt_${randomUUID()}`,
      providerReference,
      outcome: result,
      signatureVerified: true,
      payload: {},
    });

  await t.test(
    'a second quote is served from the cache and asks the partner nothing',
    async () => {
      const { provider, cache } = await setup();
      const first = await quote(provider, cache);
      assert.equal(first.state, 'ready');
      assert.equal(provider.state.calls, 3);
      provider.state.availableMinor = 1n;
      assert.deepEqual(await quote(provider, cache), first);
      assert.equal(provider.state.calls, 3);
    },
  );

  await t.test(
    'the ledger is read fresh: a new tip shows at once and asks the partner again',
    async () => {
      const { provider, cache } = await setup();
      assert.equal((await quote(provider, cache)).ledgerMinor, 360000n);
      await paidTip();
      const after = await quote(provider, cache);
      assert.equal(after.ledgerMinor, 720000n);
      assert.equal(after.withdrawableMinor, 720000n);
      assert.equal(provider.state.calls, 6);
    },
  );

  await t.test(
    'a withdrawal always asks the partner, even with a cached quote',
    async () => {
      const { provider, cache } = await setup();
      assert.equal((await quote(provider, cache)).withdrawableMinor, 360000n);
      // The partner now holds less than the cached quote says. The request must see that.
      provider.state.availableMinor = 100000n;
      const calls = provider.state.calls;
      await assert.rejects(withdraw(provider, 300000n, { cache }), {
        code: 'INSUFFICIENT_BALANCE',
      });
      assert.equal(provider.state.calls, calls + 3);
    },
  );

  await t.test(
    'after a withdrawal is requested the next quote asks the partner',
    async () => {
      const { provider, cache } = await setup();
      await quote(provider, cache);
      await withdraw(provider, 200000n);
      const calls = provider.state.calls;
      const after = await quote(provider, cache);
      assert.equal(after.ledgerMinor, 160000n);
      assert.equal(provider.state.calls, calls + 3);
    },
  );

  for (const result of ['paid', 'failed']) {
    await t.test(
      `a payout ${result} makes the next quote ask the partner`,
      async () => {
        const { provider, cache } = await setup();
        const { payoutId } = await withdraw(provider, 200000n);
        const reference = await started(payoutId);
        await quote(provider, cache);
        const calls = provider.state.calls;
        await quote(provider, cache);
        assert.equal(provider.state.calls, calls, 'cached until the outcome');
        await outcome(payoutId, reference, result);
        await quote(provider, cache);
        assert.equal(provider.state.calls, calls + 3);
      },
    );
  }

  await t.test(
    'a reversed payout makes the next quote ask the partner',
    async () => {
      const { provider, cache } = await setup();
      const { payoutId } = await withdraw(provider, 200000n);
      await outcome(payoutId, await started(payoutId), 'paid');
      await quote(provider, cache);
      const calls = provider.state.calls;
      // TODO: use the real operation once one moves a payout to REVERSED (none does yet). Until
      // then the status alone must be enough to miss.
      await q(`UPDATE payouts SET status = 'REVERSED' WHERE id = $1`, [
        payoutId,
      ]);
      await quote(provider, cache);
      assert.equal(provider.state.calls, calls + 3);
    },
  );

  await t.test(
    'a bank change makes the next quote ask the partner, with no invalidation at all',
    async () => {
      const { provider, cache } = await setup();
      await quote(provider, cache);
      const calls = provider.state.calls;
      await q(
        `INSERT INTO payout_destinations
           (id, profile_id, provider, destination_reference, bank_code, bank_name,
            account_last4, status)
         VALUES ($1, $2, 'mock', 'mock_dest', '058', 'Pretend Guaranty Bank', '4321', 'usable')`,
        [randomUUID(), TOBI.id],
      );
      const after = await quote(provider, cache);
      assert.deepEqual(after.destination, {
        bankName: 'Pretend Guaranty Bank',
        last4: '4321',
      });
      assert.equal(provider.state.calls, calls + 3);
    },
  );

  await t.test('an invalidated account asks the partner again', async () => {
    const { provider, cache } = await setup();
    await quote(provider, cache);
    cache.invalidate({ provider: 'mock', profileId: TOBI.id });
    await quote(provider, cache);
    assert.equal(provider.state.calls, 6);
  });

  await t.test('a failed partner read is never cached', async () => {
    const { provider, cache } = await setup();
    provider.state.fail = true;
    assert.equal((await quote(provider, cache)).state, 'provider_unavailable');
    provider.state.fail = false;
    assert.equal((await quote(provider, cache)).state, 'ready');
    assert.equal(cache.entries.size > 0, true);
  });

  await t.test(
    'a broken cache means a direct partner call, never an error',
    async () => {
      const { provider } = await setup();
      const broken = {
        open: async () => ({
          get: async () => {
            throw new Error('store down');
          },
          set: async () => {
            throw new Error('store down');
          },
        }),
      };
      assert.equal((await quote(provider, broken)).state, 'ready');
      const refused = {
        open: async () => {
          throw new Error('store down');
        },
      };
      assert.equal((await quote(provider, refused)).state, 'ready');
      const absent = { open: async () => null };
      assert.equal((await quote(provider, absent)).state, 'ready');
      // A stored answer that can't be read is a miss too.
      const garbled = {
        open: async () => ({
          get: async () => '{not json',
          set: async () => {},
        }),
      };
      assert.equal((await quote(provider, garbled)).state, 'ready');
      assert.equal(provider.state.calls, 12);
    },
  );
  await t.test(
    "the payment account's reference and change time are in the key",
    async () => {
      await database.fresh();
      const provider = countingProvider({ bachs: true });
      const cache = memoryCache();
      const accountId = randomUUID();
      await q(
        `INSERT INTO payment_accounts
           (id, profile_id, provider, environment, provider_account_reference, status,
            charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
         VALUES ($1, $2, 'bachs', 'sandbox', 'acct_one', 'ACTIVE', true, true, 'platform', now())`,
        [accountId, TOBI.id],
      );
      await q(
        `INSERT INTO payout_destinations
           (id, profile_id, provider, destination_reference, bank_code, bank_name,
            account_last4, status)
         VALUES ($1, $2, 'bachs', 'ba_one', '058', 'Guaranty Trust Bank', '4321', 'usable')`,
        [randomUUID(), TOBI.id],
      );
      assert.equal((await quote(provider, cache)).state, 'ready');
      await quote(provider, cache);
      assert.equal(provider.state.calls, 3, 'the second quote was a hit');
      await q(
        `UPDATE payment_accounts SET provider_account_reference = 'acct_two' WHERE id = $1`,
        [accountId],
      );
      await quote(provider, cache);
      assert.equal(provider.state.calls, 6, 'a new account reference misses');
      await q(
        `UPDATE payment_accounts SET updated_at = updated_at + interval '1 second' WHERE id = $1`,
        [accountId],
      );
      await quote(provider, cache);
      assert.equal(provider.state.calls, 9, 'a recorded account change misses');
    },
  );

  await t.test('two recipients never share an answer', async () => {
    await database.fresh();
    await paidTip();
    const provider = countingProvider({
      perAccount: { [TOBI.id]: 100_000_000n, [ADA.id]: 7000n },
    });
    const cache = memoryCache();
    const tobi = await quote(provider, cache);
    const ada = await withdrawalQuote(db, {
      profileId: ADA.id,
      provider,
      cache,
    });
    assert.equal(provider.state.calls, 6, 'Ada made her own partner calls');
    assert.equal(tobi.providerMinor, 100_000_000n);
    assert.equal(ada.providerMinor, 7000n);
    assert.deepEqual(await quote(provider, cache), tobi);
    assert.equal(provider.state.calls, 6);
  });

  await t.test('a hold or the switch wins over a warm cache', async () => {
    const { provider, cache } = await setup();
    assert.equal((await quote(provider, cache)).state, 'ready');
    const issueId = randomUUID();
    await q(
      `INSERT INTO issues (id, kind, dedupe_key, severity, subject, summary, opened_at)
       VALUES ($1, 'payment_reversed', $2, 'money', $3, 'test', now())`,
      [issueId, `test.${issueId}`, JSON.stringify({ profileId: TOBI.id })],
    );
    const holdId = randomUUID();
    await q(
      `INSERT INTO withdrawal_holds (id, profile_id, reason, issue_id)
       VALUES ($1, $2, 'reversal', $3)`,
      [holdId, TOBI.id, issueId],
    );
    assert.deepEqual(await quote(provider, cache), {
      state: 'paused',
      reason: 'reversal',
    });
    await q(`UPDATE withdrawal_holds SET released_at = now() WHERE id = $1`, [
      holdId,
    ]);
    assert.equal((await quote(provider, cache)).state, 'ready');
    await q(`UPDATE withdrawals_switch SET paused = true`);
    assert.deepEqual(await quote(provider, cache), {
      state: 'paused',
      reason: 'switched_off',
    });
    await q(`UPDATE withdrawals_switch SET paused = false`);
  });

  await t.test(
    'entries are per currency, and a hit keeps the fee exactness',
    async () => {
      const { provider, cache } = await setup();
      provider.state.exact = true;
      await quote(provider, cache);
      const keys = [...cache.entries.keys()];
      assert.ok(
        keys.length === 2 && keys.every((key) => key.includes(':NGN:')),
      );
      const fee = keys.find((key) => key.includes('fee:'));
      assert.deepEqual(JSON.parse(cache.entries.get(fee)), {
        feeMinor: '5000',
        exact: true,
      });
    },
  );
});

// Live updates: a signal re-reads only what TipMe's records decide. The partner is never asked,
// even when a full quote would ask it, and even when it would fail.
test('a local quote never calls the partner', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const mock = countingProvider();
  mock.state.fail = true;
  assert.deepEqual(
    await localWithdrawalQuote(db, { profileId: TOBI.id, provider: mock }),
    { state: 'unchecked' },
  );
  // A provider with connected accounts and no account yet: the route blocks, from TipMe's rows.
  const bachs = countingProvider({ bachs: true });
  bachs.state.fail = true;
  const local = await localWithdrawalQuote(db, {
    profileId: TOBI.id,
    provider: bachs,
  });
  assert.equal(local.state, 'setup_needed');
  assert.deepEqual(
    local,
    await withdrawalQuote(db, { profileId: TOBI.id, provider: bachs }),
    "the same answer a full quote gives when TipMe's side blocks",
  );
  assert.equal(mock.state.calls, 0);
  assert.equal(bachs.state.calls, 0);
});
