import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  balanceOf,
  checkProviderSplit,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  flagUnconnectedMoney,
  markAttemptInitiated,
  purgeSplitChecks,
  recordProviderEvent,
  requestWithdrawal,
  SPLIT_CHECK_BATCH,
  SPLIT_SHORT_THRESHOLD_MINOR,
  splitOwnersDue,
} from '../../dist/index.js';
import { AT_12_NOV_PLAN_FEES, useDatabase } from './helpers.mjs';

// Per-provider balances, Task 10 (spec §5a, §7, P12): the daily check of split accounts. Each split
// owner's ledger available is compared with what their providers hold, less what is queued there.
// Short by more than ₦100 opens a staff issue; over is informational; a failed read is partial.

const [ADA, TOBI] = DEMO_PROFILES;
const HUGE = 100_000_000_000n;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

test('daily split check', async (t) => {
  const database = await useDatabase(t, AT_12_NOV_PLAN_FEES);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);

  /** One ₦4,000 tip collected through `provider` (a recorded name): ₦3,720 net (372,000 minor). */
  const tip = async (provider, handle = 'tobi') => {
    const quote = await createQuote(db, {
      handle,
      tipMinor: 400000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
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
  const checks = (ownerId = TOBI.id) =>
    q(
      `SELECT * FROM provider_split_checks
        WHERE profile_id = $1 OR business_id = $1 ORDER BY checked_at`,
      [ownerId],
    );
  const issuesOf = (kind) =>
    q(`SELECT * FROM issues WHERE kind = $1 ORDER BY dedupe_key`, [kind]);
  const now = new Date('2026-11-24T09:00:00Z');

  await t.test('the threshold and batch are the plan figures', () => {
    assert.equal(SPLIT_SHORT_THRESHOLD_MINOR, 10_000n);
    assert.equal(SPLIT_CHECK_BATCH, 20);
  });

  await t.test(
    'a split owner whose providers hold less than the ledger by more than ₦100 opens provider_split_short',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const old = reader('mock_alt', { balance: 372000n });
      const active = reader('mock', { balance: 352000n });
      const providers = set(active, old);
      // ₦2,000 queued at mock_alt: off the ledger's available already, still in mock_alt's balance.
      await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 200000n,
        idempotencyKey: randomUUID(),
        providers,
      });
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 544000n);
      // 544,000 − ((372,000 − 200,000) + 352,000) = 20,000: ₦200 short.
      const result = await checkProviderSplit(
        db,
        { profileId: TOBI.id },
        providers,
        { now },
      );
      assert.deepEqual(result, { outcome: 'short' });
      const [row] = await checks();
      assert.equal(row.outcome, 'short');
      assert.equal(row.ledger_minor, '544000');
      assert.equal(row.business_id, null);
      assert.equal(row.checked_at.toISOString(), now.toISOString());
      assert.deepEqual(row.providers, [
        {
          provider: 'mock_alt',
          availableMinor: '372000',
          queuedMinor: '200000',
        },
        { provider: 'mock', availableMinor: '352000', queuedMinor: '0' },
      ]);
      const [issue] = await issuesOf('provider_split_short');
      assert.equal(issue.dedupe_key, `provider_split_short.${TOBI.id}`);
      assert.equal(issue.severity, 'money');
      assert.equal(issue.subject.profileId, TOBI.id);
      // Staff see each provider's figures under its recorded name.
      assert.match(issue.summary, /mock_alt/);
      assert.match(issue.summary, /₦3,720/);
      assert.match(issue.summary, /₦2,000 queued/);
      assert.match(issue.summary, /₦200/);
      // A second short check of the same owner adds a row but no second issue.
      await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
        now: new Date(now.getTime() + DAY + 1),
      });
      assert.equal((await checks()).length, 2);
      assert.equal((await issuesOf('provider_split_short')).length, 1);
    },
  );

  await t.test('a gap of ₦100 or less opens nothing', async () => {
    await database.fresh();
    await tip('mock_alt');
    await tip('mock');
    // 744,000 − (372,000 + 362,000) = 10,000: exactly ₦100.
    const providers = set(
      reader('mock', { balance: 362000n }),
      reader('mock_alt', { balance: 372000n }),
    );
    const result = await checkProviderSplit(
      db,
      { profileId: TOBI.id },
      providers,
      { now },
    );
    assert.deepEqual(result, { outcome: 'ok' });
    assert.equal((await checks())[0].outcome, 'ok');
    assert.equal((await issuesOf('provider_split_short')).length, 0);
  });

  await t.test(
    'providers holding more is recorded as over with no issue',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const providers = set(
        reader('mock'),
        reader('mock_alt', { balance: 372000n }),
      );
      const result = await checkProviderSplit(
        db,
        { profileId: TOBI.id },
        providers,
        { now },
      );
      assert.deepEqual(result, { outcome: 'over' });
      assert.equal((await checks())[0].outcome, 'over');
      assert.equal((await issuesOf('provider_split_short')).length, 0);
    },
  );

  await t.test('a failed read records partial with no issue', async () => {
    await database.fresh();
    await tip('mock_alt');
    await tip('mock');
    const old = reader('mock_alt', { balance: 0n });
    old.fail = true;
    const failures = [];
    // The other provider alone is short by far: still partial, never an issue on half the figures.
    const result = await checkProviderSplit(
      db,
      { profileId: TOBI.id },
      set(reader('mock', { balance: 0n }), old),
      {
        now,
        onReadFailure: (failure, provider) =>
          failures.push({ failure, provider }),
      },
    );
    assert.deepEqual(result, { outcome: 'partial' });
    const [row] = await checks();
    assert.equal(row.outcome, 'partial');
    assert.deepEqual(row.providers, [
      { provider: 'mock_alt', availableMinor: null, queuedMinor: '0' },
      { provider: 'mock', availableMinor: '0', queuedMinor: '0' },
    ]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].provider, 'mock_alt');
    assert.equal((await issuesOf('provider_split_short')).length, 0);
  });

  await t.test('a single-provider owner is never checked', async () => {
    await database.fresh();
    await tip('mock', 'ada');
    await tip('mock_alt');
    await tip('mock');
    const active = reader('mock');
    const old = reader('mock_alt');
    assert.deepEqual(
      await splitOwnersDue(db, set(active, old), { now, limit: 20 }),
      [{ profileId: TOBI.id }],
    );
    // With no withdraw-only provider, nobody is split.
    assert.deepEqual(
      await splitOwnersDue(db, set(active), { now, limit: 20 }),
      [],
    );
    // An account reference at a withdraw-only provider counts, as in the owner's provider set.
    await q(
      `INSERT INTO payment_accounts
         (id, profile_id, provider, environment, provider_account_reference, status,
          charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
       VALUES ($1, $2, 'bachs', 'sandbox', 'acct_ada', 'ACTIVE', true, true, 'platform', now())`,
      [randomUUID(), ADA.id],
    );
    const sandbox = reader('bachs-sandbox', { connected: true });
    assert.deepEqual(
      await splitOwnersDue(db, set(active, sandbox), { now, limit: 20 }),
      [{ profileId: ADA.id }],
    );
    // Nothing was read to find them.
    assert.deepEqual([...active.reads, ...old.reads, ...sandbox.reads], []);
  });

  await t.test('an owner checked within 24 h is not due', async () => {
    await database.fresh();
    await tip('mock_alt', 'ada');
    await tip('mock_alt');
    const providers = set(reader('mock'), reader('mock_alt'));
    // Never checked comes first, then the oldest check.
    await checkProviderSplit(db, { profileId: TOBI.id }, providers, { now });
    assert.deepEqual(
      await splitOwnersDue(db, providers, {
        now: new Date(now.getTime() + DAY + 1),
        limit: 20,
      }),
      [{ profileId: ADA.id }, { profileId: TOBI.id }],
    );
    await checkProviderSplit(db, { profileId: ADA.id }, providers, {
      now: new Date(now.getTime() + HOUR),
    });
    assert.deepEqual(
      await splitOwnersDue(db, providers, {
        now: new Date(now.getTime() + 23 * HOUR),
        limit: 20,
      }),
      [],
    );
    assert.deepEqual(
      await splitOwnersDue(db, providers, {
        now: new Date(now.getTime() + DAY + 2 * HOUR),
        limit: 20,
      }),
      [{ profileId: TOBI.id }, { profileId: ADA.id }],
    );
    // The limit bounds a run.
    assert.deepEqual(
      await splitOwnersDue(db, providers, {
        now: new Date(now.getTime() + DAY + 2 * HOUR),
        limit: 1,
      }),
      [{ profileId: TOBI.id }],
    );
  });

  await t.test(
    'money at an unconnected provider opens one issue per provider',
    async () => {
      await database.fresh();
      await tip('gone_pay', 'ada');
      await tip('mock', 'ada');
      await tip('mock_alt');
      // Review Focus 5: mock_alt is dropped from the roles while TOBI's part there is REQUESTED.
      // All of TOBI's money is reserved by it (a ledger of 0), so the payout is what says money is
      // still there.
      const withAlt = set(
        reader('mock'),
        reader('mock_alt', { balance: 372000n }),
      );
      await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 372000n,
        idempotencyKey: randomUUID(),
        providers: withAlt,
      });
      const [payout] = await q(
        `SELECT id FROM payouts WHERE provider = 'mock_alt' AND status = 'REQUESTED'`,
      );
      assert.ok(payout);
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 0n);
      const withoutAlt = set(reader('mock'));
      assert.equal(await flagUnconnectedMoney(db, withoutAlt, now), 2);
      const opened = await issuesOf('provider_unconnected_money');
      assert.deepEqual(
        opened.map((issue) => issue.dedupe_key),
        [
          'provider_unconnected_money.gone_pay',
          'provider_unconnected_money.mock_alt',
        ],
      );
      for (const issue of opened) assert.equal(issue.severity, 'money');
      const [gone, alt] = opened;
      assert.match(gone.summary, /gone_pay/);
      assert.match(gone.summary, new RegExp(ADA.id));
      assert.doesNotMatch(gone.summary, new RegExp(TOBI.id));
      assert.doesNotMatch(alt.summary, new RegExp(ADA.id));
      assert.match(alt.summary, new RegExp(TOBI.id));
      assert.match(alt.summary, new RegExp(payout.id));
      // The connected provider holds money too, but it is reachable: no issue for it.
      assert.equal(
        opened.some((issue) => issue.dedupe_key.endsWith('.mock')),
        false,
      );
      // The next run opens nothing new.
      assert.equal(await flagUnconnectedMoney(db, withoutAlt, now), 0);
      assert.equal((await issuesOf('provider_unconnected_money')).length, 2);
      // While mock_alt is connected, only gone_pay would be flagged (already open).
      await database.fresh();
      await tip('mock_alt');
      assert.equal(await flagUnconnectedMoney(db, withAlt, now), 0);
    },
  );

  await t.test('old checks are purged after 90 days', async () => {
    await database.fresh();
    const insert = (checkedAt) =>
      q(
        `INSERT INTO provider_split_checks
           (id, profile_id, checked_at, ledger_minor, providers, outcome)
         VALUES ($1, $2, $3, 0, '[]'::jsonb, 'ok')`,
        [randomUUID(), TOBI.id, checkedAt],
      );
    await insert(new Date(now.getTime() - 91 * DAY));
    await insert(new Date(now.getTime() - 89 * DAY));
    assert.equal(await purgeSplitChecks(db, now), 1);
    const left = await checks();
    assert.equal(left.length, 1);
    assert.equal(
      left[0].checked_at.toISOString(),
      new Date(now.getTime() - 89 * DAY).toISOString(),
    );
  });

  await t.test('a check row belongs to exactly one owner', async () => {
    await database.fresh();
    await assert.rejects(
      q(
        `INSERT INTO provider_split_checks
           (id, checked_at, ledger_minor, providers, outcome)
         VALUES ($1, now(), 0, '[]'::jsonb, 'ok')`,
        [randomUUID()],
      ),
      /provider_split_checks_owner/,
    );
    await assert.rejects(
      q(
        `INSERT INTO provider_split_checks
           (id, profile_id, checked_at, ledger_minor, providers, outcome)
         VALUES ($1, $2, now(), 0, '[]'::jsonb, 'fine')`,
        [randomUUID(), TOBI.id],
      ),
      /provider_split_checks_outcome/,
    );
  });
});
