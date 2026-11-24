import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  balanceOf,
  businessBalanceOf,
  checkProviderSplit,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  flagUnconnectedMoney,
  listSplitAccounts,
  markAttemptInitiated,
  purgeSplitChecks,
  recordProviderEvent,
  requestWithdrawal,
  RETIRE_AFTER_MS,
  retireCheck,
  SPLIT_CHECK_BATCH,
  SPLIT_SHORT_THRESHOLD_MINOR,
  splitOwnersDue,
} from '../../dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from './business-fixtures.mjs';
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
  /** Staff settle an issue: the next spell of the same cause must open a new one. */
  const resolve = (id) =>
    q(
      `UPDATE issues SET status = 'resolved', resolved_at = now(), resolved_by = 'system'
        WHERE id = $1`,
      [id],
    );
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
      old.reads.length = 0;
      active.reads.length = 0;
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
      // One key per spell, so a resolved issue never swallows the next shortfall.
      assert.ok(
        issue.dedupe_key.startsWith(`provider_split_short.${TOBI.id}.`),
      );
      // Short is read again before the issue is opened: each provider was asked twice.
      assert.equal(old.reads.filter((r) => r.startsWith('balance:')).length, 2);
      assert.equal(
        active.reads.filter((r) => r.startsWith('balance:')).length,
        2,
      );
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
      // Resolved, then short again: a new issue for the new spell.
      await resolve(issue.id);
      await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
        now: new Date(now.getTime() + 2 * DAY + 2),
      });
      const after = await issuesOf('provider_split_short');
      assert.equal(after.length, 2);
      const reopened = after.find((row) => row.id !== issue.id);
      assert.equal(reopened.status, 'open');
      assert.ok(
        reopened.dedupe_key.startsWith(`provider_split_short.${TOBI.id}.`),
      );
    },
  );

  await t.test(
    'a one-off dip at a provider that recovers on the re-read opens nothing',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const old = reader('mock_alt', { balance: 372000n });
      // The first read shows ₦3,720 missing; the second has it back.
      const answers = [0n, 372000n];
      const dipping = {
        ...reader('mock'),
        async payoutBalance() {
          return { availableMinor: answers.shift() ?? 372000n };
        },
      };
      const result = await checkProviderSplit(
        db,
        { profileId: TOBI.id },
        set(dipping, old),
        { now },
      );
      // The row keeps what the first read saw.
      assert.deepEqual(result, { outcome: 'short' });
      const [row] = await checks();
      assert.equal(row.outcome, 'short');
      assert.deepEqual(row.providers[1], {
        provider: 'mock',
        availableMinor: '0',
        queuedMinor: '0',
      });
      assert.equal(answers.length, 0);
      assert.equal((await issuesOf('provider_split_short')).length, 0);
    },
  );

  await t.test(
    'a business owner is checked on its own balance and shared tips',
    async () => {
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
      /** A ₦4,000 tip to Tobi at the business through `provider`; the business takes half. */
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
      const share = await sharedTip('mock_alt');
      await sharedTip('mock');
      const ledger = (await businessBalanceOf(db, businessId)).availableMinor;
      assert.equal(ledger, share * 2n);
      const old = reader('mock_alt', { balance: 0n });
      const active = reader('mock', { balance: share });
      const providers = set(active, old);
      // The business is due through its shared tip at mock_alt (and so is Tobi, through the tip).
      const due = await splitOwnersDue(db, providers, { now, limit: 20 });
      assert.ok(due.some((owner) => owner.businessId === businessId));
      const result = await checkProviderSplit(db, { businessId }, providers, {
        now,
      });
      assert.deepEqual(result, { outcome: 'short' });
      // Read at the business's own account (its id, while accountless).
      assert.ok(old.reads.includes(`balance:${businessId}`));
      const [row] = await checks(businessId);
      assert.equal(row.profile_id, null);
      assert.equal(row.business_id, businessId);
      assert.equal(row.ledger_minor, ledger.toString());
      const [issue] = await issuesOf('provider_split_short');
      assert.ok(
        issue.dedupe_key.startsWith(`provider_split_short.${businessId}.`),
      );
      assert.equal(issue.subject.businessId, businessId);
      assert.match(issue.summary, new RegExp(`business ${businessId}`));
      // Checked now, so no longer due; Tobi still is.
      const later = await splitOwnersDue(db, providers, { now, limit: 20 });
      assert.equal(
        later.some((owner) => owner.businessId === businessId),
        false,
      );
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
        opened.map((issue) =>
          issue.dedupe_key.split('.').slice(0, 2).join('.'),
        ),
        [
          'provider_unconnected_money.gone_pay',
          'provider_unconnected_money.mock_alt',
        ],
      );
      // One key per spell: `<prefix><id>`.
      for (const issue of opened)
        assert.equal(issue.dedupe_key.split('.').length, 3);
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
        opened.some((issue) =>
          issue.dedupe_key.startsWith('provider_unconnected_money.mock.'),
        ),
        false,
      );
      // The next run opens nothing new.
      assert.equal(await flagUnconnectedMoney(db, withoutAlt, now), 0);
      assert.equal((await issuesOf('provider_unconnected_money')).length, 2);
      // Resolved while the money is still there: the next run opens a new issue for that provider.
      await resolve(gone.id);
      assert.equal(await flagUnconnectedMoney(db, withoutAlt, now), 1);
      const now3 = await issuesOf('provider_unconnected_money');
      assert.equal(now3.length, 3);
      const fresh = now3.find(
        (issue) => issue.id !== gone.id && issue.id !== alt.id,
      );
      assert.equal(fresh.status, 'open');
      assert.ok(
        fresh.dedupe_key.startsWith('provider_unconnected_money.gone_pay.'),
      );
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
  await t.test(
    'split accounts lists only owners with two or more configured providers or a withdraw-only one',
    async () => {
      await database.fresh();
      // Ada: tipped through the active provider only, so not split.
      await tip('mock', 'ada');
      await tip('mock_alt');
      await tip('mock');
      const active = reader('mock');
      const old = reader('mock_alt', { balance: 372000n });
      const providers = set(active, old);
      await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 200000n,
        idempotencyKey: randomUUID(),
        providers,
      });
      active.reads.length = 0;
      old.reads.length = 0;
      const page = await listSplitAccounts(db, providers, { limit: 50 });
      assert.equal(page.nextCursor, null);
      assert.equal(page.items.length, 1);
      const [item] = page.items;
      assert.deepEqual(item.owner, { profileId: TOBI.id, handle: 'tobi' });
      assert.equal(
        item.ledgerMinor,
        (await balanceOf(db, TOBI.id)).availableMinor,
      );
      // Drain order, each with its role and what is queued there (the ₦2,000 at mock_alt).
      assert.deepEqual(item.providers, [
        { provider: 'mock_alt', role: 'withdraw_only', queuedMinor: 200000n },
        { provider: 'mock', role: 'active', queuedMinor: 0n },
      ]);
      assert.equal(item.lastCheck, null);
      assert.equal(item.openIssueId, null);
      // Listing reads TipMe's own records only.
      assert.deepEqual([...active.reads, ...old.reads], []);
      // With no withdraw-only provider, nobody is split.
      assert.deepEqual(
        await listSplitAccounts(db, set(active), { limit: 50 }),
        {
          items: [],
          nextCursor: null,
        },
      );
      // An account reference at a withdraw-only provider counts too.
      await q(
        `INSERT INTO payment_accounts
           (id, profile_id, provider, environment, provider_account_reference, status,
            charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
         VALUES ($1, $2, 'bachs', 'sandbox', 'acct_ada', 'ACTIVE', true, true, 'platform', now())`,
        [randomUUID(), ADA.id],
      );
      const sandbox = reader('bachs-sandbox', { connected: true });
      const withSandbox = await listSplitAccounts(db, set(active, sandbox), {
        limit: 50,
      });
      assert.deepEqual(
        withSandbox.items.map((row) => row.owner.profileId),
        [ADA.id],
      );
      assert.deepEqual(
        withSandbox.items[0].providers.map((row) => [row.provider, row.role]),
        [
          ['bachs', 'withdraw_only'],
          ['mock', 'active'],
        ],
      );
      // Pages: one at a time, then the rest.
      const both = set(active, old, sandbox);
      const first = await listSplitAccounts(db, both, { limit: 1 });
      assert.equal(first.items.length, 1);
      assert.ok(first.nextCursor);
      const second = await listSplitAccounts(db, both, {
        limit: 1,
        cursor: first.nextCursor,
      });
      assert.equal(second.items.length, 1);
      assert.equal(second.nextCursor, null);
      assert.deepEqual(
        [
          first.items[0].owner.profileId,
          second.items[0].owner.profileId,
        ].sort(),
        [ADA.id, TOBI.id].sort(),
      );
    },
  );

  await t.test(
    'split accounts show the latest check, and its open issue only when the re-read confirmed it',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const providers = set(reader('mock'), reader('mock_alt'));
      const insert = (checkedAt, outcome) =>
        q(
          `INSERT INTO provider_split_checks
             (id, profile_id, checked_at, ledger_minor, providers, outcome)
           VALUES ($1, $2, $3, 0, '[]'::jsonb, $4)`,
          [randomUUID(), TOBI.id, checkedAt, outcome],
        );
      await insert(new Date(now.getTime() - DAY), 'ok');
      // A one-off dip: a short row, but the re-read cleared it, so no issue.
      await insert(now, 'short');
      let [item] = (await listSplitAccounts(db, providers, { limit: 50 }))
        .items;
      assert.equal(item.lastCheck.outcome, 'short');
      assert.equal(item.lastCheck.checkedAt.toISOString(), now.toISOString());
      assert.equal(item.openIssueId, null);
      // A confirmed short opens the issue, and the row links it.
      await checkProviderSplit(
        db,
        { profileId: TOBI.id },
        set(
          reader('mock', { balance: 0n }),
          reader('mock_alt', { balance: 0n }),
        ),
        { now: new Date(now.getTime() + HOUR) },
      );
      const [issue] = await issuesOf('provider_split_short');
      [item] = (await listSplitAccounts(db, providers, { limit: 50 })).items;
      assert.equal(item.lastCheck.outcome, 'short');
      assert.equal(item.openIssueId, issue.id);
      // Resolved: no longer linked.
      await resolve(issue.id);
      [item] = (await listSplitAccounts(db, providers, { limit: 50 })).items;
      assert.equal(item.openIssueId, null);
    },
  );

  await t.test('can retire only at zero after 30 days', async () => {
    await database.fresh();
    assert.equal(RETIRE_AFTER_MS, 30 * DAY);
    const intent = await tip('mock_alt');
    await tip('mock');
    const old = reader('mock_alt', { balance: 372000n });
    const providers = set(reader('mock'), old);
    const t0 = new Date('2026-10-01T09:00:00Z');
    // Every record at mock_alt dates from t0.
    const settle = () =>
      Promise.all([
        q(
          `UPDATE payment_attempts SET created_at = $1 WHERE provider = 'mock_alt'`,
          [t0],
        ),
        q(`UPDATE payouts SET created_at = $1 WHERE provider = 'mock_alt'`, [
          t0,
        ]),
        q(
          `UPDATE tip_refunds SET created_at = $1, updated_at = $1 WHERE provider = 'mock_alt'`,
          [t0],
        ),
        q(
          `UPDATE disputes SET created_at = $1, updated_at = $1, last_event_at = $1 WHERE provider = 'mock_alt'`,
          [t0],
        ),
        q(
          `UPDATE provider_events SET received_at = $1 WHERE provider = 'mock_alt'`,
          [t0],
        ),
      ]);
    const at = (days, ms = 0) => new Date(t0.getTime() + days * DAY + ms);
    const only = async (days) => {
      const rows = await retireCheck(db, providers, at(days));
      // Withdraw-only providers only: the active one is never retired here.
      assert.deepEqual(
        rows.map((row) => row.provider),
        ['mock_alt'],
      );
      return rows[0];
    };
    await settle();

    // An owner with money there (their latest check) blocks it.
    await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
      now: at(31),
    });
    let row = await only(31);
    assert.equal(row.ownersWithMoney, 1);
    assert.equal(row.canRetire, false);
    assert.equal(row.lastActivityAt.toISOString(), t0.toISOString());

    // Drained (a later check says 0): nothing blocks it after 30 days.
    old.balance = 0n;
    await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
      now: at(31, 1),
    });
    row = await only(31);
    assert.deepEqual(
      {
        ownersWithMoney: row.ownersWithMoney,
        openPayouts: row.openPayouts,
        openRefunds: row.openRefunds,
        openDisputes: row.openDisputes,
        canRetire: row.canRetire,
      },
      {
        ownersWithMoney: 0,
        openPayouts: 0,
        openRefunds: 0,
        openDisputes: 0,
        canRetire: true,
      },
    );
    // A read that failed there is not "no money".
    old.fail = true;
    await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
      now: at(31, 2),
    });
    row = await only(31);
    assert.equal(row.ownersWithMoney, 1);
    assert.equal(row.canRetire, false);
    old.fail = false;
    await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
      now: at(31, 3),
    });

    // An open refund recorded there blocks it.
    const { tipId } = intent;
    const [{ id: refundId }] = await q(
      `INSERT INTO tip_refunds (id, tip_id, status, amount_minor, currency, provider,
                                provider_reference, requested_by, reason)
       VALUES (gen_random_uuid(), $1, 'REQUESTED', 400000, 'NGN', 'mock_alt', 'ref', $2, 'asked')
       RETURNING id`,
      [tipId, ADA.userId],
    );
    await settle();
    row = await only(31);
    assert.equal(row.openRefunds, 1);
    assert.equal(row.canRetire, false);
    await q(`UPDATE tip_refunds SET status = 'FAILED' WHERE id = $1`, [
      refundId,
    ]);
    await settle();

    // An open dispute recorded there blocks it, until it is settled.
    const [{ id: disputeId }] = await q(
      `INSERT INTO disputes (id, provider, partner_dispute_id, tip_id, amount_minor, currency,
                             status, last_event_at)
       VALUES (gen_random_uuid(), 'mock_alt', $1, $2, 400000, 'NGN', 'open', now())
       RETURNING id`,
      [`dsp_${randomUUID()}`, tipId],
    );
    await settle();
    row = await only(31);
    assert.equal(row.openDisputes, 1);
    assert.equal(row.canRetire, false);
    await q(
      `UPDATE disputes SET status = 'won', decided_at = $2, settled_at = $2 WHERE id = $1`,
      [disputeId, t0],
    );

    // An open payout recorded there blocks it.
    old.balance = 300000n;
    await requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor: 200000n,
      idempotencyKey: randomUUID(),
      providers,
    });
    const [payout] = await q(
      `SELECT id FROM payouts WHERE provider = 'mock_alt' AND status = 'REQUESTED'`,
    );
    assert.ok(payout);
    await settle();
    row = await only(31);
    assert.equal(row.openPayouts, 1);
    assert.equal(row.canRetire, false);
    await q(`UPDATE payouts SET status = 'FAILED' WHERE id = $1`, [payout.id]);
    old.balance = 0n;
    await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
      now: at(31, 4),
    });
    await settle();

    // All zero: day 29 still blocks it, day 30 allows it.
    row = await only(29);
    assert.equal(
      row.ownersWithMoney +
        row.openPayouts +
        row.openRefunds +
        row.openDisputes,
      0,
    );
    assert.equal(row.canRetire, false);
    row = await only(30);
    assert.equal(row.canRetire, true);
  });
  await t.test(
    'a stale or missing check, or a late provider event, blocks retire',
    async () => {
      await database.fresh();
      await tip('mock_alt');
      await tip('mock');
      const old = reader('mock_alt', { balance: 0n });
      const providers = set(reader('mock'), old);
      const t0 = new Date('2026-10-01T09:00:00Z');
      const at = (days, ms = 0) => new Date(t0.getTime() + days * DAY + ms);
      const settle = () =>
        Promise.all([
          q(
            `UPDATE payment_attempts SET created_at = $1, collected_at = NULL WHERE provider = 'mock_alt'`,
            [t0],
          ),
          q(`UPDATE payouts SET created_at = $1 WHERE provider = 'mock_alt'`, [
            t0,
          ]),
          q(
            `UPDATE provider_events SET received_at = $1 WHERE provider = 'mock_alt'`,
            [t0],
          ),
        ]);
      const only = async (days) =>
        (await retireCheck(db, providers, at(days)))[0];
      await settle();

      // Missing: a split owner never checked may still hold money there.
      let row = await only(31);
      assert.equal(row.ownersWithMoney, 1);
      assert.equal(row.canRetire, false);

      // Stale: a check that said 0 more than 48 h ago says nothing about now.
      await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
        now: at(1),
      });
      row = await only(31);
      assert.equal(row.ownersWithMoney, 1);
      assert.equal(row.canRetire, false);
      // A check within 48 h that says 0 lets it go.
      await checkProviderSplit(db, { profileId: TOBI.id }, providers, {
        now: at(29, HOUR),
      });
      row = await only(31);
      assert.equal(row.ownersWithMoney, 0);
      assert.equal(row.canRetire, true);

      // A payout there that failed after that check (its event came later): money moved back, so the
      // provider isn't quiet, though the payout itself has no later time of its own.
      old.balance = 300000n;
      await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 200000n,
        idempotencyKey: randomUUID(),
        providers,
      });
      const [payout] = await q(
        `SELECT id FROM payouts WHERE provider = 'mock_alt' AND status = 'REQUESTED'`,
      );
      await settle();
      await q(`UPDATE payouts SET status = 'FAILED' WHERE id = $1`, [
        payout.id,
      ]);
      await q(
        `INSERT INTO provider_events (id, provider, provider_event_id, event_type, signature_verified,
                                      payload_hash, payload, payout_id, received_at)
         VALUES (gen_random_uuid(), 'mock_alt', $1, 'payout.failed', true, 'h', '{}'::jsonb, $2, $3)`,
        [`evt_${randomUUID()}`, payout.id, at(30)],
      );
      row = await only(31);
      assert.equal(row.ownersWithMoney, 0);
      assert.equal(row.openPayouts, 0);
      assert.equal(row.lastActivityAt.toISOString(), at(30).toISOString());
      assert.equal(row.canRetire, false);
      // A payment there whose money was seen taken later than it started counts from then.
      await q(
        `UPDATE payment_attempts SET collected_at = $1 WHERE provider = 'mock_alt'`,
        [at(30, 2 * HOUR)],
      );
      row = await only(31);
      assert.equal(
        row.lastActivityAt.toISOString(),
        at(30, 2 * HOUR).toISOString(),
      );
    },
  );
});
