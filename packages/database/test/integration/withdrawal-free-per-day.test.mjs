import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  recordProviderEvent,
  requestWithdrawal,
  withdrawalQuote,
} from '../../dist/index.js';
import { FREE_WITHDRAWALS_PER_DAY } from '@tipme/domain';
import { AT_12_NOV_PLAN_FEES, useDatabase, waiveFee } from './helpers.mjs';

const [, TOBI] = DEMO_PROFILES;

// The owner, 18 Nov 2026: a person's first 2 withdrawals each Lagos calendar day are free (TipMe pays
// the partner's fee). From the 3rd that day the user pays it from the amount (the partner's ₦50).
// Requested ones count (failed ones do not), by the payout's stored fee_payer, decided under the
// profile row lock the request already takes, so two at once cannot both take the last free slot.

test('withdrawals per day: 2 free, then the partner fee comes off', async (t) => {
  const database = await useDatabase(t, AT_12_NOV_PLAN_FEES);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const ACCOUNT = 'acct_tobi';
  const bachsLike = () => ({
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: true },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
    async payoutBalance() {
      return { availableMinor: 100_000_000n };
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
  });
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
  const ready = async () => {
    await database.fresh();
    for (let i = 0; i < 4; i += 1) await bachsTip();
    await q(
      `INSERT INTO payment_accounts
         (id, profile_id, provider, environment, provider_account_reference, status,
          charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
       VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, 'platform', now())`,
      [randomUUID(), TOBI.id, ACCOUNT],
    );
    const id = randomUUID();
    await q(
      `INSERT INTO payout_destinations
         (id, profile_id, provider, destination_reference, bank_code, bank_name,
          account_last4, status)
       VALUES ($1, $2, 'bachs', $3, '058', 'Guaranty Trust Bank', '4321', 'usable')`,
      [id, TOBI.id, `ba_${id.slice(0, 8)}`],
    );
  };
  const withdraw = (extra = {}) =>
    requestWithdrawal(db, {
      profileId: TOBI.id,
      amountMinor: 200000n,
      idempotencyKey: randomUUID(),
      providers: { active: bachsLike(), withdrawOnly: [] },
      ...extra,
    });
  const quote = (now) =>
    withdrawalQuote(db, {
      profileId: TOBI.id,
      providers: { active: bachsLike(), withdrawOnly: [] },
      ...(now ? { now } : {}),
    });
  const payers = async () =>
    (
      await q(
        `SELECT fee_payer, amount_minor::text AS sent, user_fee_minor::text AS fee
           FROM payouts ORDER BY created_at, id`,
      )
    ).map((row) => [row.fee_payer, row.sent, row.fee]);
  const DAY = 24 * 3_600_000;

  await t.test('the number of free withdrawals a day is 2', () => {
    assert.equal(FREE_WITHDRAWALS_PER_DAY, 2);
  });

  await t.test(
    'the first two are free, the 3rd and 4th pay the ₦50 from the amount',
    async () => {
      await ready();
      const before = await quote();
      assert.equal(before.feePaidBy, 'tipme');
      assert.equal(before.ordinalToday, 1);
      assert.equal(before.freePerDay, 2);
      await withdraw();
      assert.equal((await quote()).ordinalToday, 2);
      assert.equal((await quote()).feePaidBy, 'tipme');
      await withdraw();
      const third = await quote();
      assert.equal(third.feePaidBy, 'user');
      assert.equal(third.ordinalToday, 3);
      assert.equal(third.feeMinor, 5000n);
      await withdraw();
      await withdraw();
      assert.deepEqual(await payers(), [
        ['tipme', '200000', '0'],
        ['tipme', '200000', '0'],
        ['user', '195000', '5000'],
        ['user', '195000', '5000'],
      ]);
      assert.equal((await quote()).ordinalToday, 5);
    },
  );

  await t.test(
    'a replay of the same request never takes another slot',
    async () => {
      await ready();
      const key = randomUUID();
      const first = await withdraw({ idempotencyKey: key });
      const again = await withdraw({ idempotencyKey: key });
      assert.equal(again.replayed, true);
      assert.equal(again.payoutId, first.payoutId);
      assert.equal((await quote()).ordinalToday, 2);
    },
  );

  await t.test('the next Lagos day starts again at 2 free', async () => {
    await ready();
    await withdraw();
    await withdraw();
    await withdraw();
    const tomorrow = new Date(Date.now() + DAY + 3_600_000);
    const next = await quote(tomorrow);
    assert.equal(next.feePaidBy, 'tipme');
    assert.equal(next.ordinalToday, 1);
    await withdraw({ now: tomorrow });
    assert.equal((await payers()).at(-1)[0], 'tipme');
  });

  await t.test('failed withdrawals do not count', async () => {
    await ready();
    const first = await withdraw();
    await withdraw();
    assert.equal((await quote()).feePaidBy, 'user');
    await q(`UPDATE payouts SET status = 'FAILED' WHERE id = $1`, [
      first.payoutId,
    ]);
    const after = await quote();
    assert.equal(after.feePaidBy, 'tipme');
    assert.equal(after.ordinalToday, 2);
    await withdraw();
    assert.deepEqual(
      (await payers()).map(([payer]) => payer),
      ['tipme', 'tipme', 'tipme'],
    );
  });

  await t.test('five at once: exactly 2 take the free slots', async () => {
    await ready();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => withdraw()),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      Array(5).fill('fulfilled'),
      JSON.stringify(results.filter((r) => r.status === 'rejected')),
    );
    const rows = await payers();
    assert.equal(rows.filter(([payer]) => payer === 'tipme').length, 2);
    assert.equal(rows.filter(([payer]) => payer === 'user').length, 3);
    for (const [payer, sent, fee] of rows)
      if (payer === 'user') assert.deepEqual([sent, fee], ['195000', '5000']);
  });
  // Fee waivers (spec 2026-11-23 §4, W8): a withdrawal waiver makes TipMe pay the fee on every
  // request. Only a fee the person would have paid counts as waived, and a waived request still
  // takes one of the day's two free slots (P7 counts it free).
  const waived = () =>
    q(
      `SELECT fee_payer, user_fee_minor::text AS fee, fee_waiver_id, waived_fee_minor::text AS waived
         FROM payouts ORDER BY created_at, id`,
    );
  const tobiWaiver = (payer = 'tipme') =>
    waiveFee(database, {
      scope: 'account',
      kind: 'individual',
      profileId: TOBI.id,
      payer,
    });

  await t.test(
    'a person under a withdrawal waiver pays no fee on the third withdrawal of the day',
    async () => {
      await ready();
      await withdraw();
      await withdraw();
      const rule = await tobiWaiver();
      await withdraw();
      const third = (await waived()).at(-1);
      assert.deepEqual(third, {
        fee_payer: 'tipme',
        fee: '0',
        fee_waiver_id: rule,
        waived: '5000',
      });
      assert.equal((await payers()).at(-1)[1], '200000');
    },
  );

  await t.test(
    'a waived withdrawal that would have been free anyway costs the waiver nothing',
    async () => {
      await ready();
      const rule = await tobiWaiver();
      await withdraw();
      await withdraw();
      assert.deepEqual(await waived(), [
        { fee_payer: 'tipme', fee: '0', fee_waiver_id: rule, waived: '0' },
        { fee_payer: 'tipme', fee: '0', fee_waiver_id: rule, waived: '0' },
      ]);
    },
  );

  await t.test(
    'a waived withdrawal still counts toward the daily two',
    async () => {
      await ready();
      await tobiWaiver();
      await withdraw();
      await withdraw();
      // The waiver ends: Tobi follows the kind (none), so today's rule is back.
      await tobiWaiver('inherit');
      const next = await quote();
      assert.equal(next.feePaidBy, 'user');
      assert.equal(next.ordinalToday, 3);
      await withdraw();
      assert.deepEqual((await waived()).at(-1), {
        fee_payer: 'user',
        fee: '5000',
        fee_waiver_id: null,
        waived: '0',
      });
    },
  );

  await t.test(
    'the withdrawal quote says tipme while the waiver is in force',
    async () => {
      await ready();
      await withdraw();
      await withdraw();
      assert.equal((await quote()).feePaidBy, 'user');
      // A kind-wide waiver for every person reaches Tobi too.
      await waiveFee(database, { scope: 'kind', kind: 'individual' });
      const during = await quote();
      assert.equal(during.feePaidBy, 'tipme');
      assert.equal(during.ordinalToday, 3);
      // Tobi opted out of it ("normal rules"): the person pays again.
      await tobiWaiver('account');
      assert.equal((await quote()).feePaidBy, 'user');
    },
  );

  await t.test('a split counts as one withdrawal of the day', async () => {
    await database.fresh();
    /** A ₦4,000 tip through the accountless `provider`: 372,000 to withdraw. */
    const tipVia = async (provider) => {
      const tipQuote = await createQuote(db, {
        handle: 'tobi',
        tipMinor: 400000n,
        currency: 'NGN',
      });
      const intent = await createPaymentIntent(db, {
        quoteId: tipQuote.quoteId,
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
    };
    for (let i = 0; i < 3; i += 1) {
      await tipVia('mock_alt');
      await tipVia('mock');
    }
    /** Each provider holds 300,000 now: every 500,000 request splits in two. */
    const pretend = (name) => ({
      name,
      capabilities: { connectedAccounts: false },
      async payoutCapability() {
        return { status: 'active', requirementsDue: [] };
      },
      async payoutBalance() {
        return { availableMinor: 300000n };
      },
      async quotePayoutFee() {
        return { feeMinor: 5000n, exact: false };
      },
    });
    const providers = () => ({
      active: pretend('mock'),
      withdrawOnly: [pretend('mock_alt')],
    });
    const split = async () => {
      const result = await requestWithdrawal(db, {
        profileId: TOBI.id,
        amountMinor: 500000n,
        idempotencyKey: randomUUID(),
        providers: providers(),
      });
      assert.equal(result.parts.length, 2);
      // The worker started both parts: the providers' figures already exclude them.
      await q(
        `UPDATE payouts SET status = 'PROCESSING', provider_reference = 'po_' || id
          WHERE withdrawal_group_id = $1`,
        [result.groupId],
      );
      return result;
    };
    const ordinal = async () =>
      (
        await withdrawalQuote(db, {
          profileId: TOBI.id,
          providers: providers(),
        })
      ).ordinalToday;
    await split();
    assert.equal(await ordinal(), 2);
    await split();
    assert.equal(await ordinal(), 3);
    // Both splits were free: every part's fee is TipMe's.
    assert.deepEqual(
      (await payers()).map(([payer]) => payer),
      ['tipme', 'tipme', 'tipme', 'tipme'],
    );
    // The 3rd request pays one fee, off its largest part only.
    const third = await split();
    const rows = await q(
      `SELECT fee_payer, user_fee_minor::text AS fee, amount_minor::text AS sent
         FROM payouts WHERE withdrawal_group_id = $1 ORDER BY group_part`,
      [third.groupId],
    );
    assert.deepEqual(rows, [
      { fee_payer: 'user', fee: '5000', sent: '295000' },
      { fee_payer: 'tipme', fee: '0', sent: '200000' },
    ]);
    assert.equal(
      (await q(`SELECT 1 FROM payouts WHERE user_fee_minor > 0`)).length,
      1,
    );
    assert.equal(await ordinal(), 4);
  });
});
