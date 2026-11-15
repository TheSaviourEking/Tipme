import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  applyTipRefundEvent,
  askTipRefund,
  balanceOf,
  businessBalanceOf,
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  recordProviderEvent,
  reverseTip,
  sendTipRefunds,
  tipRefundFacts,
  tipStatusView,
} from '../../dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

/*
 * Staff "Refund tip" (owner, 14 Nov 2026), behind the `tip_refunds` admin switch. Staff ask, a second person approves
 * (`tip.refund`), the worker asks our payment partner for exactly the tip minus TipMe's fee, as the
 * recipient's account, and the partner's refund.paid books it: each side gives back what it received,
 * and TipMe keeps its fee. Pretend partner only.
 */
const [ADA, TOBI] = DEMO_PROFILES;
const STAFF = ADA.userId;
const GROSS = 1_000_000n; // ₦10,000; Tobi is on Free: TipMe keeps ₦700, Tobi receives ₦9,300
const NET = 930_000n;

function partner({ refuse, lose } = {}) {
  const calls = [];
  return {
    calls,
    async refundAccountCharge(input) {
      calls.push(input);
      if (refuse) {
        const error = new Error('refused');
        error.name = 'TipRefundRefusedError';
        error.reason = refuse;
        throw error;
      }
      if (lose && calls.length === 1) {
        const error = new Error('lost');
        error.name = 'UncertainProviderOutcomeError';
        throw error;
      }
      return { refundReference: 'rfnd_ok', status: 'processing' };
    },
  };
}

test('staff tip refunds', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const codeOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.reason ?? error.detail ?? error.code ?? String(error);
    }
  };

  const atBusiness = async () => {
    const { businessId, locations } = await seedBusiness(database);
    const { memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId: TOBI.id,
    });
    await seedAgreement(database, { memberId, businessBps: 2000 });
    return { businessId, memberId };
  };
  const paidTip = async ({ shared, pay = true } = {}) => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: GROSS,
      currency: 'NGN',
      ...(shared ? { businessMemberId: shared.memberId } : {}),
      sharesOn: true,
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      ...(shared ? { businessMemberId: shared.memberId } : {}),
      sharesOn: true,
    });
    const reference = `mock_pay_${randomUUID()}`;
    await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'mock',
      providerReference: reference,
    });
    if (pay)
      await recordProviderEvent(db, {
        provider: 'mock',
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'payment.succeeded',
        attemptId: intent.attemptId,
        providerReference: reference,
        amountMinor: GROSS,
        currency: 'NGN',
        providerFeeMinor: 20000n,
        signatureVerified: true,
        payload: {},
      });
    return { tipId: intent.tipId, reference };
  };
  const ask = (tipId, now = new Date()) =>
    db.transaction((tx) =>
      askTipRefund(tx, {
        tipId,
        staffUserId: STAFF,
        approvedBy: null,
        reason: 'The supporter paid twice by mistake and asked us.',
        now,
      }),
    );
  const send = (provider, now = new Date()) =>
    sendTipRefunds(db, { provider, providerName: 'mock', now });
  const refundRow = async (id) =>
    (
      await q(
        `SELECT status, amount_minor::text AS amount, failure, provider_refund_reference AS ref
           FROM tip_refunds WHERE id = $1`,
        [id],
      )
    )[0];
  const kept = async (tipId) =>
    (
      await q(
        `SELECT COALESCE(SUM(CASE e.side WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS net
           FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
           JOIN ledger_transactions x ON x.id = e.transaction_id
          WHERE x.tip_id = $1 AND a.code IN ('platform_fee_revenue', 'provider_fee_recovered')`,
        [tipId],
      )
    )[0].net;

  await t.test(
    'what the supporter gets back is the tip minus TipMe’s fee, and who gives back what',
    async () => {
      await database.fresh();
      const plain = await paidTip();
      const facts = await tipRefundFacts(db, plain.tipId);
      assert.equal(facts.refundable, true);
      assert.equal(facts.refundMinor, NET);
      assert.equal(facts.personMinor, NET);
      assert.equal(facts.businessMinor, 0n);
      assert.equal(facts.grossMinor, GROSS);
      assert.equal(facts.feeMinor, GROSS - NET);
      const shared = await atBusiness();
      const atWork = await paidTip({ shared });
      const parts = await tipRefundFacts(db, atWork.tipId);
      assert.equal(parts.refundMinor, NET);
      assert.equal(parts.personMinor, 744000n);
      assert.equal(parts.businessMinor, 186000n);
      assert.equal(parts.businessName, 'The Yellow Chilli');
    },
  );

  await t.test(
    'refused in plain words: not paid yet, already refunded or reversed',
    async () => {
      await database.fresh();
      const unpaid = await paidTip({ pay: false });
      const notPaid = await tipRefundFacts(db, unpaid.tipId);
      assert.equal(notPaid.refusal, 'not_paid');
      assert.match(notPaid.words, /isn’t paid/);
      assert.equal(await codeOf(ask(unpaid.tipId)), 'not_paid');

      const once = await paidTip();
      await ask(once.tipId);
      assert.equal((await tipRefundFacts(db, once.tipId)).refusal, 'already');
      assert.equal(await codeOf(ask(once.tipId)), 'already');

      const chargedBack = await paidTip();
      await db.transaction((tx) =>
        reverseTip(tx, {
          tipId: chargedBack.tipId,
          partnerReversalId: `dispute.${randomUUID()}`,
          refundedMinor: GROSS,
        }),
      );
      assert.equal(
        (await tipRefundFacts(db, chargedBack.tipId)).refusal,
        'already',
      );
    },
  );

  await t.test(
    'asked, sent once as the recipient’s account with a key from the refund, and booked at refund.paid: TipMe keeps its fee',
    async () => {
      await database.fresh();
      const tip = await paidTip();
      const { refundId, amountMinor } = await ask(tip.tipId);
      assert.equal(amountMinor, NET.toString());
      assert.equal((await refundRow(refundId)).status, 'REQUESTED');
      const provider = partner();
      await send(provider);
      await send(provider); // claimed: never sent twice
      assert.deepEqual(provider.calls, [
        {
          providerReference: tip.reference,
          amountMinor: NET,
          reference: `tipme-tip-refund-${refundId}`,
          idempotencyKey: `tipme-tip-refund-${refundId}`,
        },
      ]);
      // The receipt says nothing until the partner confirms it.
      assert.equal(
        (await tipStatusView(db, tip.tipId, new Date())).refund,
        undefined,
      );
      assert.deepEqual(await refundRow(refundId), {
        status: 'PROCESSING',
        amount: NET.toString(),
        failure: null,
        ref: 'rfnd_ok',
      });
      for (let i = 0; i < 2; i += 1)
        await applyTipRefundEvent(db, {
          tipRefundId: refundId,
          refundState: 'paid',
          partnerReversalId: 'refund.rfnd_ok',
          refundedMinor: NET,
          refundFeeMinor: 0n,
          now: new Date(),
        });
      assert.equal((await refundRow(refundId)).status, 'PAID');
      // The supporter's receipt: what they got back (TipMe's fee is kept).
      assert.deepEqual(
        (await tipStatusView(db, tip.tipId, new Date())).refund,
        {
          refundedMinor: NET.toString(),
        },
      );
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 0n);
      assert.equal(await kept(tip.tipId), '70000');
      const reversals = await q(
        `SELECT count(*)::int AS n FROM ledger_transactions WHERE tip_id = $1 AND operation_type = 'reversal'`,
        [tip.tipId],
      );
      assert.equal(reversals[0].n, 1);
      assert.deepEqual(
        await q(`SELECT kind FROM share_transfers WHERE tip_id = $1`, [
          tip.tipId,
        ]),
        [],
      );
    },
  );

  await t.test(
    'a tip at a business: the person and the business each give back what they received',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const tip = await paidTip({ shared });
      const { refundId } = await ask(tip.tipId);
      await send(partner());
      await applyTipRefundEvent(db, {
        tipRefundId: refundId,
        refundState: 'paid',
        partnerReversalId: 'refund.rfnd_ok',
        refundedMinor: NET,
        refundFeeMinor: 0n,
        now: new Date(),
      });
      assert.deepEqual(
        await q(
          `SELECT a.code, e.amount_minor::text AS amount
             FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
             JOIN ledger_transactions x ON x.id = e.transaction_id
            WHERE x.tip_id = $1 AND x.operation_type = 'reversal' AND e.side = 'debit'
            ORDER BY a.code`,
          [tip.tipId],
        ),
        [
          { code: 'business_payable', amount: '186000' },
          { code: 'recipient_payable', amount: '744000' },
        ],
      );
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 0n);
      assert.equal(
        (await businessBalanceOf(db, shared.businessId)).availableMinor,
        0n,
      );
      assert.equal(await kept(tip.tipId), '70000');
    },
  );

  await t.test(
    'a bank-transfer tip is refused by the partner: failed, nothing moved, staff told, and said up front next time',
    async () => {
      await database.fresh();
      const tip = await paidTip();
      const { refundId } = await ask(tip.tipId);
      await send(partner({ refuse: 'bank_transfer' }));
      const row = await refundRow(refundId);
      assert.equal(row.status, 'FAILED');
      assert.equal(row.failure, 'bank_transfer');
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, NET);
      const facts = await tipRefundFacts(db, tip.tipId);
      assert.equal(facts.refusal, 'bank_transfer');
      assert.match(facts.words, /bank transfer, so it can’t be refunded/);
      const issues = await q(`SELECT kind FROM issues WHERE dedupe_key = $1`, [
        `tip_refund_failed.${refundId}`,
      ]);
      assert.equal(issues.length, 1);
    },
  );

  await t.test(
    'a lost answer is asked again with the same key; refund.failed books nothing and can be asked again',
    async () => {
      await database.fresh();
      const tip = await paidTip();
      const { refundId } = await ask(tip.tipId);
      const provider = partner({ lose: true });
      const start = new Date();
      await send(provider, start);
      assert.equal((await refundRow(refundId)).status, 'UNKNOWN');
      await send(provider, new Date(start.getTime() + 3 * 60_000));
      assert.equal(provider.calls.length, 2);
      assert.equal(
        provider.calls[0].idempotencyKey,
        provider.calls[1].idempotencyKey,
      );
      assert.equal((await refundRow(refundId)).status, 'PROCESSING');
      await applyTipRefundEvent(db, {
        tipRefundId: refundId,
        refundState: 'failed',
        partnerReversalId: 'refund.rfnd_ok',
        refundedMinor: null,
        refundFeeMinor: null,
        now: new Date(),
      });
      assert.equal((await refundRow(refundId)).status, 'FAILED');
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, NET);
      assert.equal((await tipRefundFacts(db, tip.tipId)).refundable, true);
    },
  );
});
