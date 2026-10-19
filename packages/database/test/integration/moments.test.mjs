import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  balanceOf,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  evaluatePeriodMoments,
  evaluateTipMoments,
  listMoments,
  markAttemptInitiated,
  publicProfile,
  recordProviderEvent,
  shareMoment,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const [, TOBI] = DEMO_PROFILES;
const BUDGET = 25_000_000n;
const lagos = (iso) => new Date(`${iso}+01:00`);

test('moments and rewards', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);

  /** A confirmed ₦2,000 tip for Tobi (platform fee NGN 100.00 unless fee-free). */
  const paid = async ({ at, message } = {}) => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: 200000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      message,
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
      ...(at ? { now: at } : {}),
    });
    return { tipId: intent.tipId, quote };
  };
  const tipAndEvaluate = async (options) => {
    const tip = await paid(options);
    await evaluateTipMoments(db, {
      profileId: TOBI.id,
      tipId: tip.tipId,
      now: new Date(),
      budgetPerMonthMinor: BUDGET,
    });
    return tip;
  };
  const credits = async () =>
    (
      await q('SELECT remaining FROM fee_free_credits WHERE profile_id = $1', [
        TOBI.id,
      ])
    )[0]?.remaining ?? 0;

  await t.test(
    'the 10th tip brings 5 fee-free tips, used up only by tips that succeed',
    async () => {
      await database.fresh();
      for (let i = 0; i < 9; i += 1) await tipAndEvaluate();
      assert.deepEqual(
        (await listMoments(db, TOBI.id)).map((m) => m.key),
        [`milestone.1.${TOBI.id}`],
      );
      await tipAndEvaluate();
      const moments = await listMoments(db, TOBI.id);
      assert.equal(moments[0].title, '10 tips! Your next 5 tips are fee-free.');
      assert.equal(await credits(), 5);
      const next = await createQuote(db, {
        handle: 'tobi',
        tipMinor: 200000n,
        currency: 'NGN',
      });
      assert.equal(next.breakdown.platformFeeMinor, 0n);
      assert.equal(next.feePolicyVersion, 'mock-v0-fee-free');
      assert.equal(await credits(), 5);
      const freeTip = await tipAndEvaluate();
      assert.equal(freeTip.quote.breakdown.platformFeeMinor, 0n);
      assert.equal(await credits(), 4);
    },
  );

  await t.test(
    'the 50th tip pays a cash bonus of half the fees, booked as TipMe’s own cost',
    async () => {
      await database.fresh();
      for (let i = 0; i < 50; i += 1) await tipAndEvaluate();
      const moment = (await listMoments(db, TOBI.id)).find(
        (m) => m.key === `milestone.50.${TOBI.id}`,
      );
      assert.match(
        moment.title,
        /^50 tips! A thank-you from TipMe: NGN [\d,]+\.\d\d added to your balance\.$/,
      );
      const [grant] = await q(
        "SELECT cash_minor FROM reward_grants WHERE kind = 'cash'",
      );
      const fees =
        await q(`SELECT COALESCE(SUM(q.platform_fee_minor), 0)::bigint AS fees FROM tips t
      JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id WHERE t.status = 'SUCCEEDED'`);
      assert.ok(BigInt(grant.cash_minor) > 0n);
      assert.ok(BigInt(grant.cash_minor) * 2n <= BigInt(fees[0].fees));
      const entries =
        await q(`SELECT a.code, e.side FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.operation_type = 'reward' ORDER BY a.code`);
      assert.deepEqual(
        entries.map((e) => [e.code, e.side]),
        [
          ['promotions_expense', 'debit'],
          ['recipient_payable', 'credit'],
        ],
      );
      const { availableMinor } = await balanceOf(db, TOBI.id);
      assert.equal(
        availableMinor,
        50n * 187000n - 0n + BigInt(grant.cash_minor) + 5n * 10000n,
      );
    },
  );

  await t.test(
    'two tips crossing a milestone together make one moment, one reward',
    async () => {
      await database.fresh();
      for (let i = 0; i < 8; i += 1) await paid();
      const [ninth, tenth] = await Promise.all([paid(), paid()]);
      await Promise.all([
        evaluateTipMoments(db, {
          profileId: TOBI.id,
          tipId: ninth.tipId,
          now: new Date(),
          budgetPerMonthMinor: BUDGET,
        }),
        evaluateTipMoments(db, {
          profileId: TOBI.id,
          tipId: tenth.tipId,
          now: new Date(),
          budgetPerMonthMinor: BUDGET,
        }),
      ]);
      assert.equal(
        (
          await q(`SELECT count(*)::int AS n FROM moments WHERE key = $1`, [
            `milestone.10.${TOBI.id}`,
          ])
        )[0].n,
        1,
      );
      assert.equal(
        (await q(`SELECT count(*)::int AS n FROM reward_grants`))[0].n,
        1,
      );
      assert.equal(await credits(), 5);
    },
  );

  await t.test(
    'the last fee-free credit is used once, never below zero',
    async () => {
      await database.fresh();
      // Fee history first: a fee-free tip must stay within half the fees earned.
      for (let i = 0; i < 4; i += 1) await paid();
      await q(
        'INSERT INTO fee_free_credits (profile_id, remaining) VALUES ($1, 1)',
        [TOBI.id],
      );
      // Both quotes are fee-free (one credit left); both succeed at once.
      await Promise.all([paid(), paid()]);
      assert.equal(await credits(), 0);
    },
  );

  await t.test(
    'with no budget left, the cash bonus becomes fee-free tips',
    async () => {
      await database.fresh();
      for (let i = 0; i < 49; i += 1) await tipAndEvaluate();
      const tip = await paid();
      await evaluateTipMoments(db, {
        profileId: TOBI.id,
        tipId: tip.tipId,
        now: new Date(),
        budgetPerMonthMinor: 0n,
      });
      assert.equal(
        (
          await q(
            "SELECT count(*)::int AS n FROM reward_grants WHERE kind = 'cash'",
          )
        )[0].n,
        0,
      );
      const moment = (await listMoments(db, TOBI.id)).find(
        (m) => m.key === `milestone.50.${TOBI.id}`,
      );
      assert.equal(moment.title, '50 tips! Your next 5 tips are fee-free.');
    },
  );

  await t.test(
    'a best month needs history, and is celebrated once',
    async () => {
      await database.fresh();
      for (const at of ['2026-07-10', '2026-08-10'])
        await paid({ at: lagos(`${at}T10:00:00`) });
      for (let i = 0; i < 4; i += 1)
        await paid({ at: lagos(`2026-06-1${i}T10:00:00`) });
      const tooEarly = await evaluatePeriodMoments(db, {
        period: 'month',
        periodKey: '2026-06',
        now: new Date(),
        budgetPerMonthMinor: BUDGET,
      });
      assert.equal(tooEarly.created, 0);
      for (let i = 0; i < 5; i += 1)
        await paid({ at: lagos(`2026-09-1${i}T10:00:00`) });
      const best = await evaluatePeriodMoments(db, {
        period: 'month',
        periodKey: '2026-09',
        now: new Date(),
        budgetPerMonthMinor: BUDGET,
      });
      assert.equal(best.created, 1);
      const again = await evaluatePeriodMoments(db, {
        period: 'month',
        periodKey: '2026-09',
        now: new Date(),
        budgetPerMonthMinor: BUDGET,
      });
      assert.equal(again.created, 0);
    },
  );

  await t.test(
    'a moment is public only once shared, and only for 14 days',
    async () => {
      await database.fresh();
      await tipAndEvaluate();
      const [first] = await listMoments(db, TOBI.id);
      assert.equal((await publicProfile(db, 'tobi')).celebration, undefined);
      await shareMoment(db, TOBI.userId, first.id);
      // Public words come from the kind of moment, never its reward.
      assert.deepEqual((await publicProfile(db, 'tobi')).celebration, {
        momentId: first.id,
        label: 'first tip',
      });
      await q(
        "UPDATE moments SET shared_at = now() - interval '15 days' WHERE id = $1",
        [first.id],
      );
      assert.equal((await publicProfile(db, 'tobi')).celebration, undefined);
    },
  );
});

test('public moment words never reveal a reward', async () => {
  const { publicMomentLabel } = await import('../../dist/index.js');
  assert.equal(publicMomentLabel('milestone.1.x'), 'first tip');
  assert.equal(publicMomentLabel('milestone.10.x'), '10th tip');
  assert.equal(publicMomentLabel('milestone.50.x'), '50th tip');
  assert.equal(publicMomentLabel('milestone.100.x'), '100th tip');
  assert.equal(publicMomentLabel('best_month.2026-09.x'), 'best month so far');
});

test('review fixes: rewards', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const paid = async () => {
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
    await evaluateTipMoments(db, {
      profileId: TOBI.id,
      tipId: intent.tipId,
      now: new Date(),
      budgetPerMonthMinor: BUDGET,
    });
    return quote;
  };

  await t.test(
    'fix: an open fee-free quote reserves its credit and its cost',
    async () => {
      await database.fresh();
      // Two normal tips: room for exactly one waived NGN 100.00 fee (half of NGN 200.00 earned).
      await paid();
      await paid();
      await q(
        'INSERT INTO fee_free_credits (profile_id, remaining) VALUES ($1, 5) ON CONFLICT (profile_id) DO UPDATE SET remaining = 5',
        [TOBI.id],
      );
      const first = await createQuote(db, {
        handle: 'tobi',
        tipMinor: 200000n,
        currency: 'NGN',
      });
      const second = await createQuote(db, {
        handle: 'tobi',
        tipMinor: 200000n,
        currency: 'NGN',
      });
      assert.equal(first.feeFree, true);
      assert.equal(second.feeFree, false);
    },
  );

  await t.test(
    'fix: fee-free tips promised with a cash bonus can actually be used',
    async () => {
      await database.fresh();
      for (let i = 0; i < 100; i += 1) await paid();
      const hundred = (await listMoments(db, TOBI.id)).find(
        (m) => m.key === `milestone.100.${TOBI.id}`,
      );
      const next = await createQuote(db, {
        handle: 'tobi',
        tipMinor: 200000n,
        currency: 'NGN',
      });
      if (/fee-free/.test(hundred.title))
        assert.equal(next.feeFree, true, hundred.title);
      else assert.doesNotMatch(hundred.title, /fee-free/);
    },
  );
});
