import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  balanceOf,
  businessBalanceOf,
  businessWithdrawalQuote,
  collectStatus,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  drainOrder,
  failPayoutByStaff,
  listMyWithdrawals,
  markAttemptInitiated,
  recentActivity,
  recordProviderEvent,
  requestBusinessWithdrawal,
  requestWithdrawal,
  sameBank,
  setFeatureSwitch,
  withdrawalQuote,
  withdrawalsAvailable,
  withdrawalSignalDue,
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
const reader = (
  name,
  { connected = false, balance = HUGE, fee = 5000n } = {},
) => ({
  name,
  capabilities: { connectedAccounts: connected },
  balance,
  fee,
  fail: false,
  /** When set, every balance read waits for it: two requests can be held at the same point. */
  gate: null,
  reads: [],
  async payoutCapability(accountRef) {
    this.reads.push(`capability:${accountRef}`);
    return { status: 'active', requirementsDue: [] };
  },
  async payoutBalance(accountRef) {
    this.reads.push(`balance:${accountRef}`);
    if (this.gate) await this.gate();
    if (this.fail) throw new Error('provider down');
    return { availableMinor: this.balance };
  },
  async quotePayoutFee(accountRef, amountMinor) {
    this.reads.push(`fee:${accountRef}:${amountMinor}`);
    return { feeMinor: this.fee, exact: false };
  },
});

const set = (active, ...withdrawOnly) => ({ active, withdrawOnly });

test('per-provider withdrawal quote', async (t) => {
  const database = await useDatabase(t, AT_12_NOV_PLAN_FEES);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);

  /** One ₦4,000 tip collected through `provider`: ₦3,720 net (372,000 minor). */
  const tip = async (
    provider,
    handle = 'tobi',
    extra = {},
    tipMinor = 400000n,
  ) => {
    const quote = await createQuote(db, {
      handle,
      tipMinor,
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
      amountMinor: tipMinor,
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
    ).then(() => id);
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

  await t.test(
    'an accountless withdraw-only provider with no bank row is the same bank (P5)',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      // The active provider has a bank row; the accountless old one has none.
      await seedDestination('mock', '4321');
      const active = reader('mock', { balance: 372000n });
      const old = reader('mock_alt', { balance: 372000n });
      const quote = await quoteOf(set(active, old));
      assert.equal(quote.bankDetailsNeeded, false);
      assert.equal(quote.withdrawableMinor, 744000n);
      assert.deepEqual(quote.capsMinor, [372000n, 372000n]);
    },
  );

  await t.test(
    'the fee is the one the provider carrying the largest part quotes (P8)',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const pair = (oldBalance, activeBalance = HUGE) =>
        set(
          reader('mock', { balance: activeBalance, fee: 5000n }),
          reader('mock_alt', { balance: oldBalance, fee: 1000n }),
        );
      // The old provider carries 500,000 of 744,000: its fee.
      const oldCarries = await quoteOf(pair(500000n));
      assert.deepEqual(oldCarries.capsMinor, [500000n, 244000n]);
      assert.equal(oldCarries.feeMinor, 1000n);
      // The active provider carries 644,000: its fee.
      const activeCarries = await quoteOf(pair(100000n));
      assert.deepEqual(activeCarries.capsMinor, [100000n, 644000n]);
      assert.equal(activeCarries.feeMinor, 5000n);
      // Nothing carried anywhere: the active provider's fee, though the old one is read first.
      const none = await quoteOf(pair(0n, 0n));
      assert.deepEqual(none.capsMinor, []);
      assert.equal(none.withdrawableMinor, 0n);
      assert.equal(none.feeMinor, 5000n);
    },
  );

  await t.test(
    'nothing held back means no partial or bank-details flag',
    async () => {
      await database.fresh();
      await tip('bachs');
      await tip('mock');
      await seedAccount();
      await seedDestination('mock', '4321');
      await seedDestination('bachs', '9999');
      // The active provider alone covers the whole ledger, so the old one's bank doesn't matter.
      const active = reader('mock');
      const old = reader('bachs-sandbox', { connected: true, balance: 0n });
      const bank = await quoteOf(set(active, old));
      assert.equal(bank.withdrawableMinor, bank.ledgerMinor);
      assert.equal(bank.bankDetailsNeeded, false);
      // Nor a failed read at the old provider, when nothing is held back.
      await q(
        `UPDATE payout_destinations SET account_last4 = '4321' WHERE provider = 'bachs'`,
      );
      const failing = reader('bachs-sandbox', { connected: true });
      failing.fail = true;
      const read = await quoteOf(set(active, failing));
      assert.equal(read.withdrawableMinor, read.ledgerMinor);
      assert.equal(read.partial, false);
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

  // Task 6 (spec §5, P6, P7, P9): one request paid as parts across providers.

  const ask = (providers, amountMinor, extra = {}) =>
    requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor,
      idempotencyKey: randomUUID(),
      providers,
      ...extra,
    });
  const rows = () =>
    q(
      `SELECT id, provider, account_reference, destination_id, withdrawal_group_id, group_part,
              idempotency_key, amount_minor::text AS amount, fee_payer,
              user_fee_minor::text AS user_fee, fee_minor::text AS fee, status
         FROM payouts ORDER BY created_at, group_part NULLS FIRST, id`,
    );
  const starts = () =>
    q(
      `SELECT aggregate_id FROM outbox_events WHERE event_type = 'payouts.start'
        ORDER BY created_at, id`,
    );
  const count = async (table) =>
    (await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
  /** Two withdrawals already asked for today, so the next one is the 3rd (P7). */
  const twoToday = async () => {
    for (let i = 0; i < 2; i += 1)
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, provider,
                              provider_reference, idempotency_key, request_fingerprint,
                              fee_minor, paid_at)
         VALUES ($1, $2, 'NGN', 1000, 'PAID', 'mock', $3, $4, 'test', 5000, now())`,
        [randomUUID(), TOBI.id, `mock_po_${randomUUID()}`, randomUUID()],
      );
  };
  /** The old provider connected-account, on the same bank as the active (pretend) one. */
  const sameBankAtBoth = async () => {
    await tip('bachs');
    await tip('mock');
    await seedAccount();
    const active = await seedDestination('mock', '4321');
    const old = await seedDestination('bachs', '4321');
    return { active, old };
  };

  await t.test(
    'a request larger than any one provider is paid as two parts in drain order',
    async () => {
      await database.fresh();
      const destinations = await sameBankAtBoth();
      const active = reader('mock', { balance: 372000n, fee: 5000n });
      const old = reader('bachs-sandbox', {
        connected: true,
        balance: 372000n,
        fee: 4000n,
      });
      const key = randomUUID();
      const result = await ask(set(active, old), 600000n, {
        idempotencyKey: key,
      });
      const [first, second, ...more] = await rows();
      assert.equal(more.length, 0);
      // Drain order: the withdraw-only provider first, emptied; the active one the rest.
      assert.equal(first.provider, 'bachs');
      assert.equal(first.account_reference, 'acct_tobi');
      assert.equal(first.destination_id, destinations.old);
      assert.equal(first.amount, '372000');
      assert.equal(first.fee, '4000');
      assert.equal(second.provider, 'mock');
      assert.equal(second.account_reference, null);
      assert.equal(second.destination_id, destinations.active);
      assert.equal(second.amount, '228000');
      assert.equal(second.fee, '5000');
      // One group (P6): part 1 carries the client's key, part 2 `<key>:2`.
      assert.ok(first.withdrawal_group_id);
      assert.equal(second.withdrawal_group_id, first.withdrawal_group_id);
      assert.deepEqual([first.group_part, second.group_part], [1, 2]);
      assert.equal(first.idempotency_key, key);
      assert.equal(second.idempotency_key, `${key}:2`);
      // The first withdrawal of the day: TipMe pays every part's fee.
      assert.deepEqual(
        [first.fee_payer, second.fee_payer, first.user_fee, second.user_fee],
        ['tipme', 'tipme', '0', '0'],
      );
      assert.deepEqual(
        (await starts()).map((row) => row.aggregate_id).sort(),
        [first.id, second.id].sort(),
      );
      assert.deepEqual(result, {
        payoutId: first.id,
        status: 'REQUESTED',
        replayed: false,
        groupId: first.withdrawal_group_id,
        parts: [
          { payoutId: first.id, amountMinor: 372000n, status: 'REQUESTED' },
          { payoutId: second.id, amountMinor: 228000n, status: 'REQUESTED' },
        ],
      });
    },
  );

  await t.test(
    'a request one provider covers is a single payout with no group',
    async () => {
      await database.fresh();
      await sameBankAtBoth();
      const active = reader('mock', { balance: 372000n });
      const old = reader('bachs-sandbox', {
        connected: true,
        balance: 372000n,
      });
      const key = randomUUID();
      const result = await ask(set(active, old), 300000n, {
        idempotencyKey: key,
      });
      const [only, ...more] = await rows();
      assert.equal(more.length, 0);
      // The first in drain order that covers it alone.
      assert.equal(only.provider, 'bachs');
      assert.equal(only.amount, '300000');
      assert.equal(only.withdrawal_group_id, null);
      assert.equal(only.group_part, null);
      assert.equal(only.idempotency_key, key);
      assert.deepEqual(result, {
        payoutId: only.id,
        status: 'REQUESTED',
        replayed: false,
        groupId: null,
        parts: [
          { payoutId: only.id, amountMinor: 300000n, status: 'REQUESTED' },
        ],
      });
    },
  );

  await t.test('the replay of a split returns the same group', async () => {
    await database.fresh();
    await tip('mock_alt');
    await tip('mock');
    const active = reader('mock', { balance: 372000n });
    const old = reader('mock_alt', { balance: 372000n });
    const key = randomUUID();
    const first = await ask(set(active, old), 500000n, { idempotencyKey: key });
    const again = await ask(set(active, old), 500000n, { idempotencyKey: key });
    assert.equal(again.replayed, true);
    assert.equal(again.groupId, first.groupId);
    assert.equal(again.payoutId, first.payoutId);
    assert.deepEqual(again.parts, first.parts);
    assert.equal(await count('payouts'), 2);
    assert.equal((await starts()).length, 2);
    // The same key for another amount is still a conflict.
    await assert.rejects(
      ask(set(active, old), 400000n, { idempotencyKey: key }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  });

  await t.test(
    'a replay after one part failed returns the same group and writes nothing',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const active = reader('mock', { balance: 372000n });
      const old = reader('mock_alt', { balance: 372000n });
      const key = randomUUID();
      const first = await ask(set(active, old), 500000n, {
        idempotencyKey: key,
      });
      const part2 = first.parts[1].payoutId;
      await db.transaction((tx) =>
        failPayoutByStaff(tx, {
          id: part2,
          profileId: TOBI.id,
          businessId: null,
          status: 'REQUESTED',
        }),
      );
      const before = {
        payouts: await count('payouts'),
        outbox: await count('outbox_events'),
        transitions: await count('status_transitions'),
        reads: active.reads.length + old.reads.length,
      };
      const again = await ask(set(active, old), 500000n, {
        idempotencyKey: key,
      });
      assert.equal(again.replayed, true);
      assert.equal(again.groupId, first.groupId);
      assert.deepEqual(
        again.parts.map((part) => [part.payoutId, part.status]),
        [
          [first.parts[0].payoutId, 'REQUESTED'],
          [part2, 'FAILED'],
        ],
      );
      // Nothing new: no part, no start job, no transition, and no provider asked.
      assert.deepEqual(
        {
          payouts: await count('payouts'),
          outbox: await count('outbox_events'),
          transitions: await count('status_transitions'),
          reads: active.reads.length + old.reads.length,
        },
        before,
      );
    },
  );

  await t.test(
    'two requests at once never spend the same provider’s money',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const ledger = (await balanceOf(db, TOBI.id)).availableMinor;
      assert.equal(ledger, 744000n);
      const BALANCE = { mock: 372000n, mock_alt: 372000n };
      const active = reader('mock', { balance: BALANCE.mock });
      const old = reader('mock_alt', { balance: BALANCE.mock_alt });
      // Both requests read the old provider's full balance before either takes the lock.
      let arrived = 0;
      let open;
      const bothRead = new Promise((resolve) => {
        open = resolve;
      });
      old.gate = () => {
        arrived += 1;
        if (arrived === 2) open();
        return bothRead;
      };
      const results = await Promise.allSettled([
        ask(set(active, old), 400000n),
        ask(set(active, old), 344000n),
      ]);
      assert.equal(arrived, 2);
      for (const result of results)
        if (result.status === 'rejected')
          assert.equal(result.reason.code, 'INSUFFICIENT_BALANCE');
      assert.ok(results.some((result) => result.status === 'fulfilled'));
      const spent = await q(
        `SELECT provider, SUM(amount_minor + user_fee_minor)::text AS total
           FROM payouts WHERE status <> 'FAILED' GROUP BY provider`,
      );
      let total = 0n;
      for (const row of spent) {
        assert.ok(
          BigInt(row.total) <= BALANCE[row.provider],
          `${row.provider} spent ${row.total}`,
        );
        total += BigInt(row.total);
      }
      assert.ok(total <= ledger);
      // The two allocations are distinct payouts, never the same money twice.
      const ids = results
        .filter((result) => result.status === 'fulfilled')
        .flatMap((result) => result.value.parts.map((part) => part.payoutId));
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.length, await count('payouts'));
    },
  );

  await t.test(
    'a request with one provider unreadable uses only the others, or refuses unavailable',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const active = reader('mock', { balance: 372000n });
      const old = reader('mock_alt', { balance: 372000n });
      old.fail = true;
      const failures = [];
      const onReadFailure = (_failure, provider) => failures.push(provider);
      // More than the readable provider holds: never sent to the unread one (P9).
      await assert.rejects(ask(set(active, old), 500000n, { onReadFailure }), {
        code: 'PAYOUT_PROVIDER_UNAVAILABLE',
      });
      assert.equal(await count('payouts'), 0);
      // What the readable provider covers goes through it alone.
      const result = await ask(set(active, old), 300000n, { onReadFailure });
      assert.equal(result.groupId, null);
      assert.deepEqual(
        (await rows()).map((row) => [row.provider, row.amount]),
        [['mock', '300000']],
      );
      assert.deepEqual(failures, ['mock_alt', 'mock_alt']);
      // More than the ledger holds is too little money, whatever could be read (T6-R2).
      await assert.rejects(ask(set(active, old), 500000n), {
        code: 'INSUFFICIENT_BALANCE',
      });
    },
  );

  await t.test(
    'an outage at the only provider is unavailable up to the ledger, and too little above it',
    async () => {
      await database.fresh();
      await tip('mock');
      const active = reader('mock');
      active.fail = true;
      await assert.rejects(ask(set(active), 372000n), {
        code: 'PAYOUT_PROVIDER_UNAVAILABLE',
      });
      await assert.rejects(ask(set(active), 372001n), {
        code: 'INSUFFICIENT_BALANCE',
      });
      assert.equal(await count('payouts'), 0);
    },
  );

  await t.test(
    'a part whose provider holds a different bank is never quoted or sent',
    async () => {
      await database.fresh();
      await tip('bachs');
      await tip('mock');
      await seedAccount();
      await seedDestination('mock', '4321');
      await seedDestination('bachs', '9999');
      const active = reader('mock', { balance: 372000n });
      const old = reader('bachs-sandbox', {
        connected: true,
        balance: 372000n,
      });
      // The amount needs the old provider's money, which can't go to the bank the screen shows.
      await assert.rejects(ask(set(active, old), 500000n), {
        code: 'INSUFFICIENT_BALANCE',
      });
      assert.deepEqual(old.reads, []);
      assert.equal(await count('payouts'), 0);
      await ask(set(active, old), 300000n);
      assert.deepEqual(
        (await rows()).map((row) => row.provider),
        ['mock'],
      );
      assert.deepEqual(old.reads, []);
    },
  );

  await t.test(
    'a request whose only user-paid part failed is free again (P7)',
    async () => {
      await database.fresh();
      for (let i = 0; i < 3; i += 1) {
        await tip('mock_alt');
        await tip('mock');
      }
      const providers = () =>
        set(
          reader('mock', { balance: 1_000_000n }),
          reader('mock_alt', { balance: 1_000_000n }),
        );
      const feePaidBy = async () => (await quoteOf(providers())).feePaidBy;
      const failOne = (id) =>
        db.transaction((tx) =>
          failPayoutByStaff(tx, {
            id,
            profileId: TOBI.id,
            businessId: null,
            status: 'REQUESTED',
          }),
        );
      // Two free requests, then a split whose largest part pays the fee.
      assert.equal((await ask(providers(), 1_100_000n)).parts.length, 2);
      const single = await ask(providers(), 200000n);
      assert.equal(single.groupId, null);
      const paid = await ask(providers(), 650000n);
      assert.deepEqual(
        (await rows())
          .filter((row) => row.withdrawal_group_id === paid.groupId)
          .map((row) => [row.amount, row.fee_payer]),
        [
          ['100000', 'tipme'],
          ['545000', 'user'],
        ],
      );
      // One free request failed: a free slot is open again.
      await failOne(single.payoutId);
      assert.equal(await feePaidBy(), 'tipme');
      // The user-paid part failed too: that request paid nothing, so it is a free one.
      await failOne(paid.parts[1].payoutId);
      assert.equal(await feePaidBy(), 'user');
    },
  );

  await t.test('a user-paid fee comes off the largest part once', async () => {
    await database.fresh();
    await tip('mock_alt');
    await tip('mock');
    await twoToday();
    const active = reader('mock', { balance: 372000n, fee: 5000n });
    const old = reader('mock_alt', { balance: 372000n, fee: 1000n });
    const result = await ask(set(active, old), 600000n);
    const parts = (await rows()).filter((row) => row.withdrawal_group_id);
    // The largest part (the old provider's 372,000) carries its provider's fee, once.
    assert.deepEqual(
      parts.map((row) => [
        row.provider,
        row.amount,
        row.fee_payer,
        row.user_fee,
      ]),
      [
        ['mock_alt', '371000', 'user', '1000'],
        ['mock', '228000', 'tipme', '0'],
      ],
    );
    assert.equal(result.parts[0].amountMinor, 371000n);
    // Exactly the amount chosen leaves the balance.
    assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 144000n);

    // Nothing can be sent when the largest part is not more than its fee.
    await database.fresh();
    await tip('mock_alt');
    await tip('mock');
    await twoToday();
    const costly = reader('mock_alt', { balance: 372000n, fee: 372000n });
    await assert.rejects(
      ask(set(reader('mock', { balance: 372000n }), costly), 600000n),
      { code: 'WITHDRAWAL_BELOW_FEE' },
    );
    assert.equal(await count('payouts'), 2);
  });

  await t.test('a business split pays at most one fee', async () => {
    const switchTo = (on) =>
      db.transaction((tx) =>
        setFeatureSwitch(tx, {
          key: 'business_payout_fee_absorbed',
          on,
          staffUserId: ADA.userId,
          approvedBy: null,
          reason: 'Switched for the split fee test',
          now: new Date(),
        }),
      );
    /** A ₦10,000 tip to Tobi at the business through `provider`; the business takes half. */
    const sharedTip = async (
      provider,
      { memberId, agreementId, businessId },
    ) => {
      const quote = await createQuote(db, {
        handle: 'tobi',
        tipMinor: 1_000_000n,
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
        amountMinor: 1_000_000n,
        currency: 'NGN',
        providerFeeMinor: 3000n,
        signatureVerified: true,
        payload: {},
      });
      return share;
    };
    const atBusiness = async () => {
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
      const at = { memberId, agreementId, businessId };
      const share = await sharedTip('mock_alt', at);
      assert.equal(await sharedTip('mock', at), share);
      return { businessId, share };
    };
    /** More than either provider holds: the old one's share, and the minimum from the active. */
    const split = ({ businessId, share }) =>
      requestBusinessWithdrawal(db, {
        businessId,
        userId: ADA.userId,
        amountMinor: share + 200000n,
        idempotencyKey: randomUUID(),
        providers: set(
          reader('mock', { balance: share }),
          reader('mock_alt', { balance: share }),
        ),
      });
    const payers = () =>
      q(
        `SELECT amount_minor::text AS amount, fee_payer, user_fee_minor::text AS user_fee
           FROM payouts ORDER BY group_part`,
      );

    const business = await atBusiness();
    assert.equal(
      (await businessBalanceOf(db, business.businessId)).availableMinor,
      business.share * 2n,
    );
    const { share } = business;
    const result = await split(business);
    assert.equal(result.parts.length, 2);
    // The business pays one fee, off the largest part; TipMe pays the other part's.
    assert.deepEqual(await payers(), [
      {
        amount: (share - 5000n).toString(),
        fee_payer: 'user',
        user_fee: '5000',
      },
      { amount: '200000', fee_payer: 'tipme', user_fee: '0' },
    ]);
    // With TipMe paying businesses' fees, none does.
    const absorbed = await atBusiness();
    await switchTo(true);
    try {
      await split(absorbed);
      assert.deepEqual(await payers(), [
        { amount: share.toString(), fee_payer: 'tipme', user_fee: '0' },
        { amount: '200000', fee_payer: 'tipme', user_fee: '0' },
      ]);
    } finally {
      await switchTo(false);
    }
  });

  await t.test('You collect limits apply to the request total', async () => {
    await database.fresh();
    await tip('mock_alt', 'tobi', {}, 10_000_000n);
    await tip('mock', 'tobi', {}, 10_000_000n);
    await q(
      `UPDATE profiles SET collection_mode = 'collect', collect_verified_at = now() WHERE id = $1`,
      [TOBI.id],
    );
    const status = await collectStatus(db, TOBI.id, new Date());
    assert.equal(status.firstWithdrawalCapMinor, 5_000_000n);
    const providers = () =>
      set(
        reader('mock', { balance: 3_000_000n }),
        reader('mock_alt', { balance: 3_000_000n }),
      );
    // Both providers together could pay more, but the first withdrawal's cap is on the total.
    await assert.rejects(ask(providers(), 5_000_001n), {
      code: 'WITHDRAWAL_FIRST_CAP',
    });
    assert.equal(await count('payouts'), 0);
    const result = await ask(providers(), 5_000_000n);
    assert.deepEqual(
      result.parts.map((part) => part.amountMinor),
      [3_000_000n, 2_000_000n],
    );
    // One request is one first withdrawal: the cap is behind them now.
    assert.equal(
      (await collectStatus(db, TOBI.id, new Date())).firstWithdrawalCapMinor,
      null,
    );
  });

  await t.test(
    'taking everything is allowed when the ledger runs out before the providers',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      // Money already on its way elsewhere leaves 250,000 in the ledger.
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, provider,
                              idempotency_key, request_fingerprint, fee_minor)
         VALUES ($1, $2, 'NGN', 494000, 'REQUESTED', 'other', $3, 'test', 5000)`,
        [randomUUID(), TOBI.id, randomUUID()],
      );
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 250000n);
      const providers = () =>
        set(
          reader('mock', { balance: 200000n }),
          reader('mock_alt', { balance: 100000n }),
        );
      const quote = await quoteOf(providers());
      assert.deepEqual(quote.capsMinor, [100000n, 150000n]);
      // No split of 250,000 keeps every part at the minimum or emptying its provider, but it is
      // everything: each provider carries what the quote said.
      const result = await ask(providers(), 250000n);
      assert.deepEqual(
        result.parts.map((part) => part.amountMinor),
        [100000n, 150000n],
      );
    },
  );

  await t.test('a failed part releases only its own reservation', async () => {
    await database.fresh();
    await tip('mock_alt');
    await tip('mock');
    const providers = () =>
      set(
        reader('mock', { balance: 372000n }),
        reader('mock_alt', { balance: 372000n }),
      );
    const result = await ask(providers(), 600000n);
    const before = await quoteOf(providers());
    assert.equal(before.withdrawableMinor, 144000n);
    await db.transaction((tx) =>
      failPayoutByStaff(tx, {
        id: result.parts[1].payoutId,
        profileId: TOBI.id,
        businessId: null,
        status: 'REQUESTED',
      }),
    );
    const after = await quoteOf(providers());
    assert.equal(after.withdrawableMinor, 144000n + 228000n);
    // Part 1 still holds its money at the old provider.
    assert.deepEqual(after.capsMinor, [372000n]);
  });

  await t.test(
    'the withdrawals list shows one row per request with its parts',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      await tip('mock');
      const providers = () =>
        set(
          reader('mock', { balance: 500000n }),
          reader('mock_alt', { balance: 372000n }),
        );
      const split = await ask(providers(), 600000n);
      await q(`UPDATE payouts SET created_at = now() - interval '1 minute'`);
      const single = await ask(providers(), 250000n);
      assert.equal(single.groupId, null);
      const page = await listMyWithdrawals(db, TOBI.id, {});
      assert.equal(page.items.length, 2);
      const [newest, older] = page.items;
      assert.equal(newest.payoutId, single.payoutId);
      assert.equal(newest.amountMinor, '250000');
      assert.equal(newest.parts, null);
      assert.equal(older.payoutId, split.payoutId);
      assert.equal(older.amountMinor, '600000');
      assert.equal(older.state, 'requested');
      assert.deepEqual(older.parts, [
        { amountMinor: '372000', state: 'requested' },
        { amountMinor: '228000', state: 'requested' },
      ]);
      assert.doesNotMatch(JSON.stringify(page), /mock/);
      // One row per request across pages too: the cursor is part 1's.
      const first = await listMyWithdrawals(db, TOBI.id, { limit: 1 });
      assert.deepEqual(
        first.items.map((row) => row.payoutId),
        [single.payoutId],
      );
      const next = await listMyWithdrawals(db, TOBI.id, {
        limit: 1,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        next.items.map((row) => row.payoutId),
        [split.payoutId],
      );
      assert.equal(next.nextCursor, null);
      // The row's state from its parts: one failed, one still asked for.
      const [part1, part2] = split.parts.map((part) => part.payoutId);
      await db.transaction((tx) =>
        failPayoutByStaff(tx, {
          id: part2,
          profileId: TOBI.id,
          businessId: null,
          status: 'REQUESTED',
        }),
      );
      const stateOf = async () =>
        (await listMyWithdrawals(db, TOBI.id, {})).items[1];
      // The failed part's money is back in the balance: the row is what is still coming.
      const partly = await stateOf();
      assert.equal(partly.state, 'requested');
      assert.equal(partly.amountMinor, '372000');
      assert.deepEqual(partly.parts, [
        { amountMinor: '372000', state: 'requested' },
        { amountMinor: '228000', state: 'failed' },
      ]);
      await q(
        `UPDATE payouts SET status = 'PAID', paid_at = now() WHERE id = $1`,
        [part1],
      );
      // Sent and failed: sent, for what was sent, paid when that part was.
      const sentAndFailed = await stateOf();
      assert.equal(sentAndFailed.state, 'sent');
      assert.equal(sentAndFailed.amountMinor, '372000');
      assert.ok(sentAndFailed.paidAt);
      assert.deepEqual(
        sentAndFailed.parts.map((part) => part.state),
        ['sent', 'failed'],
      );
      // Failed only when every part failed.
      const again = await ask(providers(), 600000n);
      assert.equal(again.parts.length, 2);
      for (const part of again.parts)
        await db.transaction((tx) =>
          failPayoutByStaff(tx, {
            id: part.payoutId,
            profileId: TOBI.id,
            businessId: null,
            status: 'REQUESTED',
          }),
        );
      const failed = (await listMyWithdrawals(db, TOBI.id, {})).items.find(
        (row) => row.payoutId === again.payoutId,
      );
      assert.equal(failed.state, 'failed');
      // Every part failed: the row says what was to be sent, as a single failed payout does (this
      // 3rd request of the day paid its ₦50 fee off the largest part).
      assert.equal(failed.amountMinor, '595000');
      assert.equal(failed.paidAt, null);
      assert.deepEqual(
        failed.parts.map((part) => part.state),
        ['failed', 'failed'],
      );
    },
  );

  // Task 9: Home's recent activity lists a request once, like the withdrawals list (P6).
  await t.test(
    'recent activity shows a split request as one row with its total',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const providers = set(
        reader('mock', { balance: 500000n }),
        reader('mock_alt', { balance: 372000n }),
      );
      const split = await ask(providers, 600000n);
      assert.equal(split.parts.length, 2);
      const withdrawalsOf = async () =>
        (await recentActivity(db, TOBI.id, 10)).filter(
          (row) => row.kind === 'withdrawal',
        );
      const [only, ...more] = await withdrawalsOf();
      assert.equal(more.length, 0);
      assert.equal(only.id, split.payoutId);
      assert.equal(only.amountMinor, '600000');
      assert.equal(only.state, 'requested');
      // One part failed: what is still coming, as the withdrawals list says.
      await db.transaction((tx) =>
        failPayoutByStaff(tx, {
          id: split.parts[1].payoutId,
          profileId: TOBI.id,
          businessId: null,
          status: 'REQUESTED',
        }),
      );
      const [partly] = await withdrawalsOf();
      assert.equal(partly.amountMinor, '372000');
      assert.equal(partly.state, 'requested');
      await q(
        `UPDATE payouts SET status = 'PAID', paid_at = now() WHERE id = $1`,
        [split.parts[0].payoutId],
      );
      const [sent] = await withdrawalsOf();
      assert.equal(sent.state, 'sent');
      assert.equal(sent.amountMinor, '372000');
    },
  );

  // Task 9: a split request's live signal goes out when the request moves, not for every part.
  await t.test(
    'a part signals only when its request has moved as a whole',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const providers = set(
        reader('mock', { balance: 500000n }),
        reader('mock_alt', { balance: 372000n }),
      );
      const split = await ask(providers, 600000n);
      const [part1, part2] = split.parts.map((part) => part.payoutId);
      const due = (payoutId, after) =>
        withdrawalSignalDue(db, { payoutId, after });
      const status = (id, value) =>
        q(`UPDATE payouts SET status = $2 WHERE id = $1`, [id, value]);
      // Part 1 started, part 2 still waiting: the request is still "requested".
      await status(part1, 'PROCESSING');
      assert.equal(await due(part1, 'started'), false);
      await status(part2, 'PROCESSING');
      assert.equal(await due(part2, 'started'), true);
      // Part 1 paid, part 2 on its way: nothing to say yet.
      await status(part1, 'PAID');
      assert.equal(await due(part1, 'settled'), false);
      await status(part2, 'PAID');
      assert.equal(await due(part2, 'settled'), true);
      // A request one payout carries signals as before; so does an unknown id.
      const single = await ask(providers, 250000n);
      assert.equal(single.groupId, null);
      assert.equal(await due(single.payoutId, 'started'), true);
      assert.equal(await due(single.payoutId, 'settled'), true);
      assert.equal(await due(randomUUID(), 'settled'), true);
    },
  );

  // Final fix I1 (ruling F-R1): at a withdraw-only provider, money still owed to someone else there
  // (an unswept business share, a business's recover, an open refund) is never the owner's to take.
  // The active provider stays as it always was.
  const shareSetup = async () => {
    const { businessId, locations } = await seedBusiness(database);
    const { memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId: TOBI.id,
    });
    const { agreementId } = await seedAgreement(database, {
      memberId,
      businessBps: 5000,
    });
    /** A tip to Tobi at the business through `provider`; half the net is the business's share. */
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
      return { tipId: intent.tipId, share, net: BigInt(net) };
    };
    return { businessId, sharedTip };
  };

  await t.test(
    'a pending sweep at a withdraw-only provider is never drawn by a split withdrawal',
    async () => {
      await database.fresh();
      const { sharedTip } = await shareSetup();
      const { tipId, share, net } = await sharedTip('mock_alt');
      await tip('mock');
      const [sweep] = await q(
        `SELECT status, provider FROM share_transfers WHERE tip_id = $1 AND kind = 'sweep'`,
        [tipId],
      );
      assert.deepEqual(sweep, { status: 'waiting', provider: 'mock_alt' });
      const ledger = (await balanceOf(db, TOBI.id)).availableMinor;
      assert.equal(ledger, net - share + 372000n);
      // The old provider still holds the whole net: Tobi's half and the business's.
      const providers = () =>
        set(
          reader('mock', { balance: 372000n }),
          reader('mock_alt', { balance: net }),
        );
      for (const status of ['waiting', 'out_sent', 'review']) {
        await q(
          `UPDATE share_transfers SET status = $2 WHERE tip_id = $1 AND kind = 'sweep'`,
          [tipId, status],
        );
        const quote = await quoteOf(providers());
        assert.deepEqual(quote.capsMinor, [net - share, 372000n], status);
        assert.equal(quote.withdrawableMinor, ledger, status);
      }
      // The request draws the same: never the business's share at the old provider.
      await q(
        `UPDATE share_transfers SET status = 'waiting' WHERE tip_id = $1 AND kind = 'sweep'`,
        [tipId],
      );
      await ask(providers(), ledger);
      const parts = await rows();
      assert.deepEqual(
        parts.map((row) => [row.provider, row.amount]),
        [
          ['mock_alt', (net - share).toString()],
          ['mock', '372000'],
        ],
      );
      // Once the sweep has taken it (its leg in still to go), nothing is held back for it.
      await q(
        `UPDATE share_transfers SET status = 'out_paid', deliver_minor = amount_minor
          WHERE tip_id = $1 AND kind = 'sweep'`,
        [tipId],
      );
      await q(`UPDATE payouts SET status = 'FAILED'`);
      const after = await quoteOf(
        set(
          reader('mock', { balance: 372000n }),
          reader('mock_alt', { balance: net - share }),
        ),
      );
      assert.equal(after.capsMinor[0], net - share);
    },
  );

  await t.test(
    'a single-provider owner with a waiting, unsettled sweep keeps today’s withdrawable',
    async () => {
      await database.fresh();
      const { sharedTip } = await shareSetup();
      await tip('mock');
      const { tipId } = await sharedTip('mock');
      const [sweep] = await q(
        `SELECT status FROM share_transfers WHERE tip_id = $1 AND kind = 'sweep'`,
        [tipId],
      );
      assert.equal(sweep.status, 'waiting');
      // The shared tip hasn't settled: the partner's available balance is the older tip alone.
      const providers = set(reader('mock', { balance: 372000n }));
      const quote = await quoteOf(providers);
      assert.equal(quote.state, 'ready');
      assert.equal(quote.withdrawableMinor, 372000n);
      assert.deepEqual(quote.capsMinor, [372000n]);
      const result = await ask(providers, 372000n);
      assert.equal(result.status, 'REQUESTED');
    },
  );

  await t.test(
    'an in-flight refund at a withdraw-only provider lowers the owner’s room there',
    async () => {
      await database.fresh();
      const intent = await tip('mock_alt');
      await tip('mock');
      const providers = () =>
        set(
          reader('mock', { balance: 372000n }),
          reader('mock_alt', { balance: 372000n }),
        );
      assert.deepEqual((await quoteOf(providers())).capsMinor, [
        372000n,
        372000n,
      ]);
      const [{ id: refundId }] = await q(
        `INSERT INTO tip_refunds (id, tip_id, status, amount_minor, currency, provider,
                                  provider_reference, requested_by, reason)
         VALUES (gen_random_uuid(), $1, 'REQUESTED', 300000, 'NGN', 'mock_alt', 'ref', $2, 'asked')
         RETURNING id`,
        [intent.tipId, ADA.userId],
      );
      for (const status of ['REQUESTED', 'PROCESSING', 'UNKNOWN']) {
        await q(`UPDATE tip_refunds SET status = $2 WHERE id = $1`, [
          refundId,
          status,
        ]);
        const quote = await quoteOf(providers());
        assert.deepEqual(quote.capsMinor, [72000n, 372000n], status);
        await assert.rejects(ask(providers(), 444001n), {
          code: 'INSUFFICIENT_BALANCE',
        });
      }
      // Settled one way or the other: it no longer holds anything there.
      await q(`UPDATE tip_refunds SET status = 'FAILED' WHERE id = $1`, [
        refundId,
      ]);
      assert.deepEqual((await quoteOf(providers())).capsMinor, [
        372000n,
        372000n,
      ]);
    },
  );

  await t.test(
    'a business recover at a withdraw-only provider lowers its room there once its sweep is done',
    async () => {
      await database.fresh();
      const { businessId, sharedTip } = await shareSetup();
      const { tipId, share } = await sharedTip('mock_alt');
      await sharedTip('mock');
      const [{ id: ledgerTx }] = await q(
        `SELECT id FROM ledger_transactions WHERE tip_id = $1 LIMIT 1`,
        [tipId],
      );
      const back = share / 2n;
      await q(
        `INSERT INTO share_transfers (id, tip_id, kind, business_id, profile_id, currency,
                                      amount_minor, status, provider, reversal_transaction_id)
         VALUES (gen_random_uuid(), $1, 'recover', $2, $3, 'NGN', $4, 'waiting', 'mock_alt', $5)`,
        [tipId, businessId, TOBI.id, back.toString(), ledgerTx],
      );
      const capAtOld = async () =>
        (
          await businessWithdrawalQuote(db, {
            businessId,
            providers: set(
              reader('mock'),
              reader('mock_alt', { balance: share }),
            ),
          })
        ).capsMinor[0];
      // The sweep hasn't delivered: the business doesn't hold the share there yet, so the recover
      // can't take it from what it does hold.
      await q(
        `UPDATE share_transfers SET status = 'in_sent', deliver_minor = amount_minor
          WHERE tip_id = $1 AND kind = 'sweep'`,
        [tipId],
      );
      assert.equal(await capAtOld(), share);
      await q(
        `UPDATE share_transfers SET status = 'done' WHERE tip_id = $1 AND kind = 'sweep'`,
        [tipId],
      );
      assert.equal(await capAtOld(), share - back);
      for (const status of ['out_sent', 'review']) {
        await q(
          `UPDATE share_transfers SET status = $2 WHERE tip_id = $1 AND kind = 'recover'`,
          [tipId, status],
        );
        assert.equal(await capAtOld(), share - back, status);
      }
      // Gone (or a gap, where nothing moves): nothing held back for it.
      await q(
        `UPDATE share_transfers SET status = 'gap' WHERE tip_id = $1 AND kind = 'recover'`,
        [tipId],
      );
      assert.equal(await capAtOld(), share);
    },
  );
});
