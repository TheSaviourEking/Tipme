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
  drainOrder,
  markAttemptInitiated,
  recordProviderEvent,
  sameBank,
  withdrawalQuote,
  withdrawalsAvailable,
} from '../../dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from './business-fixtures.mjs';
import { AT_12_NOV_PLAN_FEES, useDatabase } from './helpers.mjs';

// Per-provider balances, Task 5 (spec §5, §6, §8): one quote across every configured provider that
// holds the owner's money. Each provider's balance is its own truth, the ledger total is the cap,
// withdraw-only providers are drawn first and the active one last.

const [ADA, TOBI] = DEMO_PROFILES;
const HUGE = 100_000_000_000n;

/** A plain-object payout reader with a settable balance; `fail` makes every balance read throw. */
const reader = (name, { connected = false, balance = HUGE } = {}) => ({
  name,
  capabilities: { connectedAccounts: connected },
  balance,
  fail: false,
  reads: [],
  async payoutCapability(accountRef) {
    this.reads.push(`capability:${accountRef}`);
    return { status: 'active', requirementsDue: [] };
  },
  async payoutBalance(accountRef) {
    this.reads.push(`balance:${accountRef}`);
    if (this.fail) throw new Error('provider down');
    return { availableMinor: this.balance };
  },
  async quotePayoutFee(accountRef, amountMinor) {
    this.reads.push(`fee:${accountRef}:${amountMinor}`);
    return { feeMinor: 5000n, exact: false };
  },
});

const set = (active, ...withdrawOnly) => ({ active, withdrawOnly });

test('per-provider withdrawal quote', async (t) => {
  const database = await useDatabase(t, AT_12_NOV_PLAN_FEES);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);

  /** One ₦4,000 tip collected through `provider`: ₦3,720 net (372,000 minor). */
  const tip = async (provider, handle = 'tobi', extra = {}) => {
    const quote = await createQuote(db, {
      handle,
      tipMinor: 400000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      ...extra,
    });
    const reference = `${provider}_pay_${randomUUID()}`;
    await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider,
      providerReference: reference,
    });
    await recordProviderEvent(db, {
      provider,
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
    return intent;
  };
  const quoteOf = (providers, profileId = TOBI.id) =>
    withdrawalQuote(db, { profileId, providers });
  const seedAccount = (profileId = TOBI.id) =>
    q(
      `INSERT INTO payment_accounts
         (id, profile_id, provider, environment, provider_account_reference, status,
          charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
       VALUES ($1, $2, 'bachs', 'sandbox', 'acct_tobi', 'ACTIVE', true, true, 'platform', now())`,
      [randomUUID(), profileId],
    );
  const seedDestination = (provider, last4, status = 'usable') => {
    const id = randomUUID();
    return q(
      `INSERT INTO payout_destinations
         (id, profile_id, provider, destination_reference, bank_code, bank_name,
          account_last4, status)
       VALUES ($1, $2, $3, $4, '058', 'Guaranty Trust Bank', $5, $6)`,
      [id, TOBI.id, provider, `ba_${id.slice(0, 8)}`, last4, status],
    );
  };

  await t.test(
    'drainOrder lists the withdraw-only providers in order, then the active one',
    () => {
      const active = reader('mock');
      const a = reader('mock_alt');
      const b = reader('bachs-sandbox', { connected: true });
      assert.deepEqual(
        drainOrder(set(active, a, b)).map((p) => p.name),
        ['mock_alt', 'bachs-sandbox', 'mock'],
      );
      assert.deepEqual(
        drainOrder(set(active)).map((p) => p.name),
        ['mock'],
      );
    },
  );

  await t.test(
    'sameBank compares bank code and last 4, and the hashes only when both have one',
    () => {
      const row = (bankCode, last4, accountHash = null) => ({
        bankCode,
        last4,
        accountHash,
      });
      assert.equal(sameBank(row('058', '4321'), row('058', '4321')), true);
      assert.equal(sameBank(row('058', '4321'), row('058', '9999')), false);
      assert.equal(sameBank(row('058', '4321'), row('044', '4321')), false);
      assert.equal(
        sameBank(row('058', '4321', 'h1'), row('058', '4321')),
        true,
      );
      assert.equal(
        sameBank(row('058', '4321', 'h1'), row('058', '4321', 'h1')),
        true,
      );
      assert.equal(
        sameBank(row('058', '4321', 'h1'), row('058', '4321', 'h2')),
        false,
      );
    },
  );

  await t.test(
    'money at both providers is one balance: capped by the ledger, drawn withdraw-only first',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 744000n);
      const active = reader('mock');
      const old = reader('mock_alt', { balance: 372000n });
      const quote = await quoteOf(set(active, old));
      assert.equal(quote.state, 'ready');
      assert.equal(quote.withdrawableMinor, 744000n);
      assert.deepEqual(quote.capsMinor, [372000n, 372000n]);
      assert.equal(quote.ledgerMinor, 744000n);
      assert.equal(quote.providerMinor, 372000n + HUGE);
      assert.equal(quote.partial, false);
      assert.equal(quote.bankDetailsNeeded, false);
      assert.equal(quote.heldElsewhere, false);
      // The screen's one bank is the active provider's: the pretend bank for an accountless one.
      assert.deepEqual(quote.destination, {
        bankName: 'Pretend bank',
        last4: '0000',
      });
      // Each provider was read for the owner's own account (the profile, while accountless).
      assert.ok(old.reads.includes(`balance:${TOBI.id}`));
      assert.ok(active.reads.includes(`balance:${TOBI.id}`));
    },
  );

  await t.test(
    'the ledger caps the total even when providers hold more',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const active = reader('mock');
      const old = reader('mock_alt', { balance: 5_000_000n });
      const quote = await quoteOf(set(active, old));
      assert.equal(quote.withdrawableMinor, 744000n);
      // The withdraw-only provider covers it all, so the active one carries nothing.
      assert.deepEqual(quote.capsMinor, [744000n]);
      assert.equal(quote.providerMinor, 5_000_000n + HUGE);
    },
  );

  await t.test(
    'a provider that never held the owner’s money is not read',
    async () => {
      await database.fresh();
      await tip('mock');
      const active = reader('mock');
      // An accountless provider answers for any reference; it must not take this owner's money.
      const old = reader('mock_alt', { balance: 5_000_000n });
      const quote = await quoteOf(set(active, old));
      assert.equal(quote.withdrawableMinor, 372000n);
      assert.deepEqual(quote.capsMinor, [372000n]);
      assert.deepEqual(old.reads, []);
    },
  );

  await t.test(
    'a failed read at one provider leaves the rest withdrawable and marks partial',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const active = reader('mock', { balance: 372000n });
      const old = reader('mock_alt', { balance: 372000n });
      old.fail = true;
      const failures = [];
      const quote = await withdrawalQuote(db, {
        profileId: TOBI.id,
        providers: set(active, old),
        onReadFailure: (failure, provider) =>
          failures.push({ provider, ...failure }),
      });
      assert.equal(quote.state, 'ready');
      assert.equal(quote.partial, true);
      assert.equal(quote.withdrawableMinor, 372000n);
      assert.deepEqual(quote.capsMinor, [372000n]);
      assert.equal(quote.bankDetailsNeeded, false);
      // Staff logs learn which provider failed; the person's quote never names it.
      assert.deepEqual(
        failures.map((f) => f.provider),
        ['mock_alt'],
      );
      assert.doesNotMatch(
        JSON.stringify(quote, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
        /mock/,
      );
      // Every provider failing is still today's outage.
      active.fail = true;
      assert.deepEqual(await quoteOf(set(active, old)), {
        state: 'provider_unavailable',
      });
    },
  );

  await t.test(
    'a part whose provider holds a different bank is never quoted or sent',
    async () => {
      await database.fresh();
      await tip('bachs');
      await tip('mock');
      await seedAccount();
      // The person changed bank at the active provider; the old provider still has the old bank.
      await seedDestination('mock', '4321');
      await seedDestination('bachs', '9999');
      // Each provider holds exactly its own tip's money.
      const active = reader('mock', { balance: 372000n });
      const old = reader('bachs-sandbox', {
        connected: true,
        balance: 372000n,
      });
      const quote = await quoteOf(set(active, old));
      assert.equal(quote.state, 'ready');
      assert.equal(quote.bankDetailsNeeded, true);
      assert.equal(quote.partial, false);
      // Only the active provider's money: the old provider's part is not in the total.
      assert.equal(quote.withdrawableMinor, 372000n);
      assert.deepEqual(quote.capsMinor, [372000n]);
      assert.deepEqual(old.reads, []);
      assert.deepEqual(quote.destination, {
        bankName: 'Guaranty Trust Bank',
        last4: '4321',
      });

      // The same bank at both: the old provider's money is withdrawable again, drawn first.
      await q(
        `UPDATE payout_destinations SET account_last4 = '4321' WHERE provider = 'bachs'`,
      );
      const same = await quoteOf(
        set(
          active,
          reader('bachs-sandbox', {
            connected: true,
            balance: 372000n,
          }),
        ),
      );
      assert.equal(same.bankDetailsNeeded, false);
      assert.equal(same.withdrawableMinor, 744000n);
      assert.deepEqual(same.capsMinor, [372000n, 372000n]);

      // A missing or pending bank there is the same "add your bank details again".
      await q(
        `UPDATE payout_destinations SET status = 'pending_review' WHERE provider = 'bachs'`,
      );
      const pending = await quoteOf(
        set(
          active,
          reader('bachs-sandbox', {
            connected: true,
            balance: 372000n,
          }),
        ),
      );
      assert.equal(pending.bankDetailsNeeded, true);
      assert.equal(pending.withdrawableMinor, 372000n);
    },
  );

  await t.test(
    'what the person cannot fix at a withdraw-only provider is partial, not bank details',
    async () => {
      await database.fresh();
      await tip('bachs');
      await tip('mock');
      // A tip went through it, but there is no account reference there.
      const active = reader('mock', { balance: 372000n });
      const old = reader('bachs-sandbox', {
        connected: true,
        balance: 372000n,
      });
      const quote = await quoteOf(set(active, old));
      assert.equal(quote.partial, true);
      assert.equal(quote.bankDetailsNeeded, false);
      assert.equal(quote.withdrawableMinor, 372000n);
      assert.deepEqual(old.reads, []);
    },
  );

  await t.test('the active route still decides setup states', async () => {
    await database.fresh();
    await tip('mock_alt');
    await tip('bachs');
    await seedAccount();
    const active = reader('bachs-sandbox', { connected: true });
    const old = reader('mock_alt', { balance: 372000n });
    assert.deepEqual(await quoteOf(set(active, old)), {
      state: 'no_destination',
    });
    assert.deepEqual(old.reads, []);
  });

  await t.test(
    'money at an unconnected provider no longer blocks the rest',
    async () => {
      await database.fresh();
      await tip('bachs');
      await tip('mock');
      const active = reader('mock', { balance: 372000n });
      const old = reader('mock_alt');
      const providers = set(active, old);
      const quote = await quoteOf(providers);
      assert.equal(quote.state, 'ready');
      assert.equal(quote.heldElsewhere, true);
      assert.equal(quote.withdrawableMinor, 372000n);
      assert.deepEqual(quote.capsMinor, [372000n]);
      assert.equal(
        await withdrawalsAvailable(db, { profileId: TOBI.id, providers }),
        true,
      );
      // Ada's only tip went through the unconnected provider: nothing configured can pay.
      await tip('bachs', 'ada');
      assert.equal(
        await withdrawalsAvailable(db, { profileId: ADA.id, providers }),
        false,
      );
      // Once that provider is configured (here as withdraw-only), it can.
      assert.equal(
        await withdrawalsAvailable(db, {
          profileId: ADA.id,
          providers: set(active, reader('bachs-sandbox', { connected: true })),
        }),
        true,
      );
    },
  );

  await t.test(
    'queued payouts count against their own provider only',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      // A withdrawal part queued at the old provider and not yet started there.
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, provider,
                              idempotency_key, request_fingerprint, fee_minor)
         VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', 'mock_alt', $3, 'test', 5000)`,
        [randomUUID(), TOBI.id, randomUUID()],
      );
      const ledger = (await balanceOf(db, TOBI.id)).availableMinor;
      assert.equal(ledger, 644000n);
      const active = reader('mock', { balance: 372000n });
      const old = reader('mock_alt', { balance: 372000n });
      const quote = await quoteOf(set(active, old));
      // The old provider still holds the queued 100,000; the active one owes none of it.
      assert.deepEqual(quote.capsMinor, [272000n, 372000n]);
      assert.equal(quote.withdrawableMinor, 644000n);
      assert.equal(quote.providerMinor, 272000n + 372000n);
    },
  );

  await t.test('a business owner gets the same allocation', async () => {
    await database.fresh();
    const { businessId, locations } = await seedBusiness(database);
    const { memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId: TOBI.id,
    });
    const { agreementId } = await seedAgreement(database, {
      memberId,
      businessBps: 5000,
    });
    /** A tip to Tobi at the business; the business takes half of the net. */
    const sharedTip = async (provider) => {
      const quote = await createQuote(db, {
        handle: 'tobi',
        tipMinor: 400000n,
        currency: 'NGN',
      });
      const intent = await createPaymentIntent(db, {
        quoteId: quote.quoteId,
        idempotencyKey: randomUUID(),
        businessMemberId: memberId,
      });
      const [{ net }] = await q(
        `SELECT q.recipient_net_minor::text AS net FROM payment_intents i
           JOIN tip_quotes q ON q.id = i.quote_id
          WHERE i.id = (SELECT intent_id FROM tips WHERE id = $1)`,
        [intent.tipId],
      );
      const share = BigInt(net) / 2n;
      await q(
        `INSERT INTO tip_business_shares (tip_id, agreement_id, business_id, business_bps, share_minor)
         VALUES ($1, $2, $3, 5000, $4)`,
        [intent.tipId, agreementId, businessId, share.toString()],
      );
      const reference = `${provider}_pay_${randomUUID()}`;
      await markAttemptInitiated(db, {
        attemptId: intent.attemptId,
        provider,
        providerReference: reference,
      });
      await recordProviderEvent(db, {
        provider,
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
      return share;
    };
    const first = await sharedTip('mock_alt');
    const second = await sharedTip('mock');
    assert.equal(
      (await businessBalanceOf(db, businessId)).availableMinor,
      first + second,
    );
    const active = reader('mock');
    const old = reader('mock_alt', { balance: first });
    const quote = await businessWithdrawalQuote(db, {
      businessId,
      providers: set(active, old),
    });
    assert.equal(quote.state, 'ready');
    assert.equal(quote.withdrawableMinor, first + second);
    assert.deepEqual(quote.capsMinor, [first, second]);
    // The business's own account at each provider (its id, while accountless).
    assert.ok(old.reads.includes(`balance:${businessId}`));
    // Tobi's own quote never counts the business's share at the old provider.
    const own = await quoteOf(set(reader('mock'), reader('mock_alt')));
    assert.equal(
      own.ledgerMinor,
      (await balanceOf(db, TOBI.id)).availableMinor,
    );
  });
});
