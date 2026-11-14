import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  balanceOf,
  businessBalanceOf,
  businessShareMoney,
  createPaymentIntent,
  createQuote,
  flagPaymentReversal,
  markAttemptInitiated,
  recordProviderEvent,
  requestBusinessWithdrawal,
  reverseTip,
  runShareTransfers,
  shareInKey,
  shareOutKey,
} from '../../dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

/*
 * Business release 2 on option B (owner, 11 Nov 2026). The tip is collected on the staff member's
 * own partner account, as today; once it is available there, the business's share moves staff ->
 * TipMe -> business in two idempotent transfers. On a refund, TipMe returns its fee to the staff
 * member and the business gives its share back, or has it held back from its next shares.
 *
 * The partner here is a pretend one in memory, shaped on the sandbox evidence of 11 Nov 2026: a
 * transfer draws only on the available balance (S3, INSUFFICIENT_BALANCE), the same key returns the
 * same transfer and moves nothing twice (S3), and a business that withdrew its balance can't give a
 * share back (S5). It has no call that moves money between two accounts, as the partner has none
 * (S4); every call is recorded so the tests can say which side each one was on.
 */

const [ADA, TOBI] = DEMO_PROFILES;
const OWNER = ADA.userId;
const GROSS = 1000000n; // ₦10,000, the sandbox tip: Tobi is on Free, so TipMe's share is 7% (₦700)
// Of that ₦700, ₦150 is the processing TipMe recovers from the tip and ₦550 is TipMe's own fee: a
// refund returns only the ₦550, and Tobi bears the ₦150 (owner, 14 Nov 2026).
const BPS = 2000; // 80/20
const MINUTE = 60_000;
const SETTLE = 24 * 60 * MINUTE;

class PayoutRejectedError extends Error {
  name = 'PayoutRejectedError';
  constructor(code) {
    super(code);
    this.providerCode = code;
  }
}
class UncertainProviderOutcomeError extends Error {
  name = 'UncertainProviderOutcomeError';
}

function pretendPartner() {
  const available = new Map([['platform', 100000000n]]);
  const transfers = new Map(); // key -> { ref, from, to, amountMinor, status }
  const calls = [];
  // Scripted answers for the next call to each method: 'lost' (moved, answer lost), 'down'
  // (never arrived), 'pending'.
  const next = { collect: [], send: [] };
  const balance = (ref) => available.get(ref) ?? 0n;
  const move = (key, from, to, amountMinor, status = 'paid') => {
    const earlier = transfers.get(key);
    if (earlier) {
      if (earlier.amountMinor !== amountMinor || earlier.from !== from)
        throw new Error('idempotency key reused with other details');
      return earlier;
    }
    if (balance(from) < amountMinor)
      throw new PayoutRejectedError('INSUFFICIENT_BALANCE');
    available.set(from, balance(from) - amountMinor);
    available.set(to, balance(to) + amountMinor);
    const made = {
      ref: `tr_${transfers.size + 1}`,
      from,
      to,
      amountMinor,
      status,
    };
    transfers.set(key, made);
    return made;
  };
  const answer = (queue, key, from, to, amountMinor) => {
    const scripted = queue.shift();
    if (scripted === 'down')
      throw new UncertainProviderOutcomeError('no answer');
    const made = move(
      key,
      from,
      to,
      amountMinor,
      scripted === 'pending' ? 'pending' : 'paid',
    );
    if (scripted === 'lost') throw new UncertainProviderOutcomeError('lost');
    return { transferRef: made.ref, status: made.status };
  };
  return {
    available,
    transfers,
    calls,
    next,
    provider: {
      name: 'mock',
      capabilities: { connectedAccounts: false },
      async payoutBalance(accountRef) {
        return { availableMinor: balance(accountRef) };
      },
      async collectToPlatform({ accountRef, amountMinor, idempotencyKey }) {
        calls.push({
          call: 'collect',
          from: accountRef,
          to: 'platform',
          amountMinor,
          idempotencyKey,
        });
        return answer(
          next.collect,
          idempotencyKey,
          accountRef,
          'platform',
          amountMinor,
        );
      },
      async transferToAccount({ accountRef, amountMinor, idempotencyKey }) {
        calls.push({
          call: 'send',
          from: 'platform',
          to: accountRef,
          amountMinor,
          idempotencyKey,
        });
        return answer(
          next.send,
          idempotencyKey,
          'platform',
          accountRef,
          amountMinor,
        );
      },
      async findPlatformCollection(accountRef, idempotencyKey) {
        calls.push({ call: 'find', account: accountRef, idempotencyKey });
        const made = transfers.get(idempotencyKey);
        if (!made || (made.from !== accountRef && made.to !== accountRef))
          return null;
        return {
          transferRef: made.ref,
          status: made.status,
          amountMinor: made.amountMinor,
          currency: 'NGN',
        };
      },
      // For the business's withdrawal (R2-B's path, unchanged).
      payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
      quotePayoutFee: async () => ({ feeMinor: 5000n, exact: false }),
    },
  };
}

test('option B: shares and their money', async (t) => {
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
    return { businessId, memberId, agreementId };
  };

  /** A tip to Tobi at the business (or on their own page), quoted, made and paid as the API does. */
  const paidTip = async ({ shared, sharesOn = true, gross = GROSS } = {}) => {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: gross,
      currency: 'NGN',
      ...(shared ? { businessMemberId: shared.memberId } : {}),
      sharesOn,
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      ...(shared ? { businessMemberId: shared.memberId } : {}),
      sharesOn,
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
      amountMinor: gross,
      currency: 'NGN',
      providerFeeMinor: 20000n,
      signatureVerified: true,
      payload: {},
    });
    return { tipId: intent.tipId, attemptId: intent.attemptId, quote };
  };
  /** Our partner's refund events for a tip, as the webhook passes them on. */
  const refundEvent = (attemptId, refundId, refundState, extra = {}) =>
    flagPaymentReversal(db, {
      attemptId,
      eventId: `evt_${randomUUID()}`,
      eventType: `refund.${refundState === 'pending' ? 'created' : refundState}`,
      partnerReversalId: `refund.${refundId}`,
      refundState,
      ...(refundState === 'paid'
        ? { refundedMinor: extra.refundedMinor ?? GROSS, refundFeeMinor: 0n }
        : {}),
      ...(extra.feeReturnOn ? { feeReturnOn: true } : {}),
    });
  /** What the partner does on a refund: the staff member's account pays it all (sandbox S5). */
  /**
   * A refund as it happens: our partner takes it from the staff member's account and says
   * refund.paid (the webhook), then staff confirm the reversal (tip.reverse).
   */
  const refund = async (
    partner,
    { tipId, attemptId },
    { refundedMinor = GROSS, feeReturnOn = false } = {},
  ) => {
    partner.available.set(
      TOBI.id,
      (partner.available.get(TOBI.id) ?? 0n) - refundedMinor,
    );
    const refundId = randomUUID();
    await refundEvent(attemptId, refundId, 'paid', {
      refundedMinor,
      feeReturnOn,
    });
    return db.transaction((tx) =>
      reverseTip(tx, {
        tipId,
        partnerReversalId: `refund.${refundId}`,
        refundedMinor,
      }),
    );
  };
  const transfersOf = (tipId) =>
    q(
      `SELECT kind, status, amount_minor::text AS amount, deliver_minor::text AS deliver
         FROM share_transfers WHERE tip_id = $1 ORDER BY created_at, kind`,
      [tipId],
    );
  const run = (partner, now) =>
    runShareTransfers(db, {
      provider: partner.provider,
      now,
      settleWaitMs: SETTLE,
    });
  const later = (ms) => new Date(Date.now() + ms);

  await t.test(
    'the share is fixed at intent time, exactly, in kobo, only when shown',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const { tipId, quote } = await paidTip({ shared });
      assert.equal(quote.breakdown.recipientNetMinor, 930000n);
      assert.deepEqual(quote.share, {
        businessBps: BPS,
        businessName: 'The Yellow Chilli',
      });
      const [row] = await q(
        'SELECT share_minor::text AS share, business_bps FROM tip_business_shares WHERE tip_id = $1',
        [tipId],
      );
      assert.deepEqual(row, { share: '186000', business_bps: BPS });
      // The ledger: Tobi ₦7,440, the business ₦1,860, of the ₦9,300 net.
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 744000n);
      assert.equal(
        (await businessBalanceOf(db, shared.businessId)).availableMinor,
        186000n,
      );

      // An odd net rounds the share down; the kobo stays with Tobi.
      const odd = await paidTip({ shared, gross: 1000010n });
      const [oddRow] = await q(
        `SELECT s.share_minor::text AS share, q.recipient_net_minor::text AS net
         FROM tip_business_shares s JOIN tips t ON t.id = s.tip_id
         JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
        WHERE s.tip_id = $1`,
        [odd.tipId],
      );
      assert.equal(BigInt(oddRow.share), (BigInt(oddRow.net) * 2000n) / 10000n);

      // On Tobi's own page, and with the flag off, nothing is shared.
      const own = await paidTip();
      const off = await paidTip({ shared, sharesOn: false });
      assert.deepEqual(
        await q(
          'SELECT tip_id FROM tip_business_shares WHERE tip_id = ANY($1)',
          [[own.tipId, off.tipId]],
        ),
        [],
      );
      assert.deepEqual(await transfersOf(own.tipId), []);
      assert.deepEqual(await transfersOf(off.tipId), []);

      // A quote made before the split was in force can't fund a shared tip: re-quote and see it.
      const fresh = await seedBusiness(database);
      const { memberId } = await seedMember(database, {
        locationId: fresh.locations[0].id,
        profileId: TOBI.id,
      });
      const stale = await createQuote(db, {
        handle: 'tobi',
        tipMinor: GROSS,
        currency: 'NGN',
        businessMemberId: memberId,
        sharesOn: true,
      });
      assert.equal(stale.share, undefined);
      await seedAgreement(database, { memberId, businessBps: BPS });
      assert.equal(
        await codeOf(
          createPaymentIntent(db, {
            quoteId: stale.quoteId,
            idempotencyKey: randomUUID(),
            businessMemberId: memberId,
            sharesOn: true,
          }),
        ),
        'QUOTE_EXPIRED',
      );
    },
  );

  await t.test(
    'the sweep waits for the money to be available, then moves staff -> TipMe -> business once',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      const { tipId } = await paidTip({ shared });
      assert.deepEqual(await transfersOf(tipId), [
        { kind: 'sweep', status: 'waiting', amount: '186000', deliver: null },
      ]);

      // Before the settlement wait, nothing is even tried.
      await run(partner, new Date());
      assert.deepEqual(partner.calls, []);
      // After it, but the money is still pending on Tobi's account (available ₦0): still nothing sent.
      await run(partner, later(SETTLE + MINUTE));
      assert.equal(partner.calls.filter((c) => c.call !== 'find').length, 0);
      assert.equal((await transfersOf(tipId))[0].status, 'waiting');

      // Settled: Tobi's account holds the ₦9,300 net.
      partner.available.set(TOBI.id, 930000n);
      await run(partner, later(SETTLE + 7 * 60 * MINUTE));
      const [sweep] = await q(
        `SELECT id FROM share_transfers WHERE tip_id = $1`,
        [tipId],
      );
      assert.deepEqual(partner.calls, [
        {
          call: 'collect',
          from: TOBI.id,
          to: 'platform',
          amountMinor: 186000n,
          idempotencyKey: shareOutKey(sweep.id),
        },
        {
          call: 'send',
          from: 'platform',
          to: shared.businessId,
          amountMinor: 186000n,
          idempotencyKey: shareInKey(sweep.id),
        },
      ]);
      assert.equal(partner.available.get(TOBI.id), 744000n);
      assert.equal(partner.available.get(shared.businessId), 186000n);
      assert.equal(partner.available.get('platform'), 100000000n);
      assert.deepEqual(await transfersOf(tipId), [
        { kind: 'sweep', status: 'done', amount: '186000', deliver: '186000' },
      ]);
      // Done is done: more runs send nothing.
      await run(partner, later(2 * SETTLE));
      assert.equal(partner.calls.length, 2);
      // The ledger never moved: it already said who is owed what.
      assert.equal(
        (await businessBalanceOf(db, shared.businessId)).availableMinor,
        186000n,
      );
    },
  );

  await t.test(
    'two workers at once move the share once; no call ever goes account to account',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      partner.available.set(TOBI.id, 930000n * 3n);
      for (let i = 0; i < 3; i += 1) await paidTip({ shared });
      const at = later(SETTLE + MINUTE);
      await Promise.all([run(partner, at), run(partner, at), run(partner, at)]);
      const moves = partner.calls.filter((c) => c.call !== 'find');
      assert.equal(moves.filter((c) => c.call === 'collect').length, 3);
      assert.equal(moves.filter((c) => c.call === 'send').length, 3);
      assert.equal(partner.available.get(shared.businessId), 558000n);
      // Every movement has TipMe's own balance on exactly one side.
      for (const call of moves)
        assert.equal(
          [call.from, call.to].filter((side) => side === 'platform').length,
          1,
        );
      // And each send came after its own collect.
      for (const send of moves.filter((c) => c.call === 'send')) {
        const id = send.idempotencyKey.replace('tipme-share-in-', '');
        assert.ok(
          moves.indexOf(
            moves.find((c) => c.idempotencyKey === shareOutKey(id)),
          ) < moves.indexOf(send),
        );
      }
    },
  );

  await t.test(
    'a lost answer on either leg is read back, never sent blindly, and moves once',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      partner.available.set(TOBI.id, 930000n);
      const { tipId } = await paidTip({ shared });
      const [{ id }] = await q(
        `SELECT id FROM share_transfers WHERE tip_id = $1`,
        [tipId],
      );
      const t0 = later(SETTLE + MINUTE);

      // Leg 1 moved, but its answer was lost.
      partner.next.collect.push('lost');
      await run(partner, t0);
      assert.equal((await transfersOf(tipId))[0].status, 'out_sent');
      // The second leg never starts on an unconfirmed first.
      assert.equal(partner.calls.filter((c) => c.call === 'send').length, 0);
      // A run straight after doesn't ask again.
      await run(partner, new Date(t0.getTime() + 30_000));
      assert.equal(partner.calls.length, 1);
      // Two minutes on it reads back, finds leg 1 paid, and sends leg 2 (whose answer is lost too).
      partner.next.send.push('lost');
      await run(partner, new Date(t0.getTime() + 3 * MINUTE));
      await run(partner, new Date(t0.getTime() + 3 * MINUTE));
      assert.equal((await transfersOf(tipId))[0].status, 'in_sent');
      await run(partner, new Date(t0.getTime() + 6 * MINUTE));
      assert.deepEqual(await transfersOf(tipId), [
        { kind: 'sweep', status: 'done', amount: '186000', deliver: '186000' },
      ]);
      assert.equal(partner.calls.filter((c) => c.call === 'collect').length, 1);
      assert.equal(partner.calls.filter((c) => c.call === 'send').length, 1);
      assert.equal(partner.transfers.size, 2);
      assert.equal(partner.available.get(shared.businessId), 186000n);
      assert.equal(id.length, 36);
    },
  );

  await t.test(
    'a leg that never arrived is asked again only after 30 minutes, with the same key',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      partner.available.set(TOBI.id, 930000n);
      const { tipId } = await paidTip({ shared });
      const t0 = later(SETTLE + MINUTE);
      partner.next.collect.push('down');
      await run(partner, t0);
      await run(partner, new Date(t0.getTime() + 10 * MINUTE));
      assert.equal((await transfersOf(tipId))[0].status, 'out_sent');
      await run(partner, new Date(t0.getTime() + 31 * MINUTE)); // not found: back to waiting
      await run(partner, new Date(t0.getTime() + 32 * MINUTE)); // asked again
      const collects = partner.calls.filter((c) => c.call === 'collect');
      assert.equal(collects.length, 2);
      assert.equal(collects[0].idempotencyKey, collects[1].idempotencyKey);
      assert.equal((await transfersOf(tipId))[0].status, 'done');
      assert.equal(partner.available.get(shared.businessId), 186000n);
    },
  );

  await t.test(
    'a business withdraws at least the minimum tip (₦2,000), or everything it has, less the ₦50 fee',
    async () => {
      // Owner, 14 Nov 2026: the business minimum is the fee policy's minimum tip. The business pays
      // the transfer fee from the amount, so taking all of a balance under it is allowed; part is not.
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      partner.available.set(TOBI.id, 930000n);
      await paidTip({ shared });
      await run(partner, later(SETTLE + MINUTE));
      // ₦1,860 in the business's balance and on its account: everything, but under the minimum.
      const withdraw = (amountMinor) =>
        requestBusinessWithdrawal(db, {
          businessId: shared.businessId,
          userId: OWNER,
          amountMinor,
          idempotencyKey: randomUUID(),
          provider: partner.provider,
        });
      assert.equal(await codeOf(withdraw(185999n)), 'WITHDRAWAL_TOO_SMALL');
      const all = await withdraw(186000n);
      assert.equal(all.status, 'REQUESTED');
      assert.deepEqual(
        await q(
          `SELECT amount_minor::text AS sent, user_fee_minor::text AS fee FROM payouts WHERE id = $1`,
          [all.payoutId],
        ),
        [{ sent: '181000', fee: '5000' }],
      );
      assert.equal(
        (await businessBalanceOf(db, shared.businessId)).availableMinor,
        0n,
      );
    },
  );

  await t.test(
    'refunded before the sweep: TipMe returns its fee, the business is never asked',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      partner.available.set(TOBI.id, 930000n);
      const tip = await paidTip({ shared });
      const { tipId } = tip;
      await refund(partner, tip); // Tobi's account: ₦9,300 - ₦10,000 = -₦700
      assert.deepEqual(await transfersOf(tipId), [
        { kind: 'sweep', status: 'cancelled', amount: '186000', deliver: null },
        {
          kind: 'fee_return',
          status: 'out_paid',
          amount: '55000',
          deliver: '55000',
        },
      ]);
      await run(partner, later(SETTLE + MINUTE));
      assert.deepEqual(
        partner.calls.map(({ call, from, to, amountMinor }) => ({
          call,
          from,
          to,
          amountMinor,
        })),
        [{ call: 'send', from: 'platform', to: TOBI.id, amountMinor: 55000n }],
      );
      // Tobi bears the ₦150 processing, the same on the partner and in the ledger.
      assert.equal(partner.available.get(TOBI.id), -15000n);
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, -15000n);
      assert.equal(
        (await businessBalanceOf(db, shared.businessId)).availableMinor,
        0n,
      );
      assert.equal(partner.available.get(shared.businessId) ?? 0n, 0n);
    },
  );

  await t.test(
    'refunded after the sweep: the share comes back business -> TipMe -> staff, and the fee',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      partner.available.set(TOBI.id, 930000n);
      const tip = await paidTip({ shared });
      const { tipId } = tip;
      await run(partner, later(SETTLE + MINUTE));
      await refund(partner, tip); // Tobi: ₦7,440 - ₦10,000 = -₦2,560
      await run(partner, later(SETTLE + 2 * MINUTE));
      const moves = partner.calls
        .filter((c) => c.call !== 'find')
        .slice(2)
        .map(({ call, from, to, amountMinor }) => ({
          call,
          from,
          to,
          amountMinor,
        }));
      // Both are asked for by the reversal, in one transaction: the share back, then the fee.
      assert.deepEqual(moves, [
        {
          call: 'collect',
          from: shared.businessId,
          to: 'platform',
          amountMinor: 186000n,
        },
        { call: 'send', from: 'platform', to: TOBI.id, amountMinor: 186000n },
        { call: 'send', from: 'platform', to: TOBI.id, amountMinor: 55000n },
      ]);
      // Tobi bears the ₦150 processing; TipMe gave back its own ₦550 fee only.
      assert.equal(partner.available.get(TOBI.id), -15000n);
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, -15000n);
      assert.equal(partner.available.get(shared.businessId), 0n);
      assert.equal(partner.available.get('platform'), 100000000n - 55000n);
      const kinds = Object.fromEntries(
        (await transfersOf(tipId)).map((r) => [r.kind, r.status]),
      );
      assert.deepEqual(kinds, {
        sweep: 'done',
        fee_return: 'done',
        recover: 'done',
      });
    },
  );

  await t.test(
    'refunded after the business withdrew: the gap is held back from its next shares, and it is told',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      partner.available.set(TOBI.id, 930000n);
      const first = await paidTip({ shared });
      await run(partner, later(SETTLE + MINUTE));
      // The business withdrew its ₦1,860 at the partner (its account is empty).
      partner.available.set(shared.businessId, 0n);
      await refund(partner, first);
      await run(partner, later(SETTLE + 2 * MINUTE));
      const kinds = Object.fromEntries(
        (await transfersOf(first.tipId)).map((r) => [r.kind, r.status]),
      );
      assert.deepEqual(kinds, {
        sweep: 'done',
        fee_return: 'done',
        recover: 'gap',
      });
      assert.deepEqual(
        await q(
          `SELECT amount_minor::text AS amount, remaining_minor::text AS remaining, profile_id
           FROM share_holdbacks WHERE business_id = $1`,
          [shared.businessId],
        ),
        [{ amount: '186000', remaining: '186000', profile_id: TOBI.id }],
      );
      assert.deepEqual(await businessShareMoney(db, shared.businessId), {
        onTheWayMinor: 0n,
        heldBackMinor: 186000n,
      });
      // The owners are told in the app, with no email.
      const told = await q(
        `SELECT user_id, title FROM notifications WHERE kind = 'business_share_held_back' AND business_id = $1`,
        [shared.businessId],
      );
      assert.deepEqual(told, [
        { user_id: OWNER, title: 'A refunded tip’s share is held back' },
      ]);

      // The next shared tip's ₦1,860 goes back to Tobi instead of on to the business.
      const second = await paidTip({ shared });
      partner.available.set(TOBI.id, partner.available.get(TOBI.id) + 930000n);
      await run(partner, later(2 * SETTLE));
      await run(partner, later(2 * SETTLE));
      const [secondSweep] = await transfersOf(second.tipId);
      assert.deepEqual(secondSweep, {
        kind: 'sweep',
        status: 'done',
        amount: '186000',
        deliver: '0',
      });
      assert.equal(partner.available.get(shared.businessId), 0n);
      assert.deepEqual(
        await q(
          `SELECT remaining_minor::text AS remaining, settled_at IS NOT NULL AS settled FROM share_holdbacks`,
        ),
        [{ remaining: '0', settled: true }],
      );
      const [repay] = await q(
        `SELECT status, amount_minor::text AS amount, profile_id FROM share_transfers WHERE kind = 'holdback_repay'`,
      );
      assert.deepEqual(repay, {
        status: 'done',
        amount: '186000',
        profile_id: TOBI.id,
      });
      // Tobi's account matches the ledger again: the first tip came to nothing (₦9,300 in, ₦10,000
      // refunded, ₦550 fee back, ₦150 processing borne; ₦1,860 out to the business, ₦1,860 back
      // from the second tip's share), and the second tip leaves them their ₦7,440 less that ₦150.
      assert.equal(partner.available.get(TOBI.id), 729000n);
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, 729000n);
      // The business's account got nothing from the second tip: its share paid the gap.
      assert.equal(partner.available.get(shared.businessId), 0n);
    },
  );

  await t.test(
    'flags off: a plain tip and its refund move nothing between accounts',
    async () => {
      await database.fresh();
      const partner = pretendPartner();
      const tip = await paidTip({ sharesOn: false });
      const { tipId } = tip;
      partner.available.set(TOBI.id, 930000n);
      await refund(partner, tip);
      await run(partner, later(SETTLE + MINUTE));
      assert.deepEqual(await transfersOf(tipId), []);
      assert.deepEqual(partner.calls, []);
    },
  );

  // Owner, 12 Nov 2026: TipMe returns its fee on EVERY refunded tip once the refund is final
  // (refund.paid), behind REFUND_FEE_RETURN, keyed on the refund so it happens exactly once.
  const feeReturns = (tipId) =>
    q(
      `SELECT status, amount_minor::text AS amount, partner_reversal_id AS refund
         FROM share_transfers WHERE tip_id = $1 AND kind = 'fee_return'`,
      [tipId],
    );

  await t.test(
    'shares off, fee return on: an individual tip’s refund.paid posts the reversal and returns the fee, each once',
    async () => {
      await database.fresh();
      const partner = pretendPartner();
      const tip = await paidTip({ sharesOn: false });
      // The ₦9,300 net reached Tobi's account; then the partner takes the whole ₦10,000 refund.
      partner.available.set(TOBI.id, 930000n - GROSS);
      const reversals = () =>
        q(
          `SELECT operation_key FROM ledger_transactions WHERE tip_id = $1 AND operation_type = 'reversal'`,
          [tip.tipId],
        );
      const refundId = randomUUID();
      await refundEvent(tip.attemptId, refundId, 'pending', {
        feeReturnOn: true,
      });
      assert.deepEqual(await feeReturns(tip.tipId), []);
      assert.deepEqual(await reversals(), []);
      // refund.paid, delivered three times (replayed webhooks).
      for (let i = 0; i < 3; i += 1)
        await refundEvent(tip.attemptId, refundId, 'paid', {
          feeReturnOn: true,
        });
      // The reversal is posted with the money, once; so is the fee's return.
      assert.deepEqual(await reversals(), [
        { operation_key: `reversal.refund.${refundId}` },
      ]);
      assert.deepEqual(await feeReturns(tip.tipId), [
        { status: 'out_paid', amount: '55000', refund: `refund.${refundId}` },
      ]);
      // Owner, 14 Nov 2026: what goes back is the quote's own TipMe fee, never its processing part.
      const [quoted] = await q(
        `SELECT q.platform_fee_minor::text AS own, q.provider_fee_minor::text AS processing
           FROM tips t JOIN payment_intents i ON i.id = t.intent_id
           JOIN tip_quotes q ON q.id = i.quote_id WHERE t.id = $1`,
        [tip.tipId],
      );
      assert.deepEqual(quoted, { own: '55000', processing: '15000' });
      await run(partner, later(MINUTE));
      await run(partner, later(2 * MINUTE));
      assert.deepEqual(
        partner.calls.map(({ call, from, to, amountMinor }) => ({
          call,
          from,
          to,
          amountMinor,
        })),
        [{ call: 'send', from: 'platform', to: TOBI.id, amountMinor: 55000n }],
      );
      // Staff confirming it afterwards posts nothing more, and nothing more moves.
      const again = await db.transaction((tx) =>
        reverseTip(tx, {
          tipId: tip.tipId,
          partnerReversalId: `refund.${refundId}`,
          refundedMinor: GROSS,
          feeReturnOn: true,
        }),
      );
      assert.equal(again.created, false);
      await run(partner, later(3 * MINUTE));
      assert.equal(partner.calls.length, 1);
      assert.equal((await feeReturns(tip.tipId))[0].status, 'done');
      assert.equal((await reversals()).length, 1);
      // The ledger matches the partner: Tobi's balance is what their account holds (-₦150, the
      // processing they bear), TipMe's own fee is gone from its books and it keeps the ₦150
      // processing it recovered, every transaction balanced.
      assert.equal(partner.available.get(TOBI.id), -15000n);
      assert.equal((await balanceOf(db, TOBI.id)).availableMinor, -15000n);
      const revenue = await q(
        `SELECT a.code, COALESCE(SUM(CASE e.side WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS net
           FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
           JOIN ledger_transactions x ON x.id = e.transaction_id
          WHERE x.tip_id = $1 AND a.code IN ('platform_fee_revenue', 'provider_fee_recovered')
          GROUP BY a.code ORDER BY a.code`,
        [tip.tipId],
      );
      assert.deepEqual(revenue, [
        { code: 'platform_fee_revenue', net: '0' },
        { code: 'provider_fee_recovered', net: '15000' },
      ]);
      assert.deepEqual(
        await q(
          `SELECT transaction_id FROM ledger_entries GROUP BY transaction_id, currency
            HAVING sum(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`,
        ),
        [],
      );
    },
  );

  await t.test('a refund that failed returns nothing', async () => {
    await database.fresh();
    const partner = pretendPartner();
    const tip = await paidTip({ sharesOn: false });
    const refundId = randomUUID();
    await refundEvent(tip.attemptId, refundId, 'pending', {
      feeReturnOn: true,
    });
    await refundEvent(tip.attemptId, refundId, 'failed', { feeReturnOn: true });
    // A late paid after the failure is ignored: a final state is never undone.
    await refundEvent(tip.attemptId, refundId, 'paid', { feeReturnOn: true });
    assert.deepEqual(await feeReturns(tip.tipId), []);
    await run(partner, later(MINUTE));
    assert.deepEqual(partner.calls, []);
  });

  await t.test(
    'a business tip with a share: the fee goes back once, not twice, beside the share coming back',
    async () => {
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      partner.available.set(TOBI.id, 930000n);
      const tip = await paidTip({ shared });
      await run(partner, later(SETTLE + MINUTE));
      await refund(partner, tip, { feeReturnOn: true });
      await run(partner, later(SETTLE + 2 * MINUTE));
      const kinds = (await transfersOf(tip.tipId)).map((r) => [
        r.kind,
        r.status,
      ]);
      assert.deepEqual(kinds.sort(), [
        ['fee_return', 'done'],
        ['recover', 'done'],
        ['sweep', 'done'],
      ]);
      const fees = partner.calls.filter(
        (c) => c.call === 'send' && c.amountMinor === 55000n,
      );
      assert.equal(fees.length, 1);
      assert.equal(partner.available.get(TOBI.id), -15000n);
    },
  );

  await t.test(
    'with REFUND_FEE_RETURN off, a plain tip’s refund returns nothing',
    async () => {
      await database.fresh();
      const tip = await paidTip({ sharesOn: false });
      await refundEvent(tip.attemptId, randomUUID(), 'paid');
      assert.deepEqual(await feeReturns(tip.tipId), []);
    },
  );

  await t.test(
    'a lost dispute reversed by staff returns the fee once, keyed on the dispute',
    async () => {
      await database.fresh();
      const partner = pretendPartner();
      const tip = await paidTip({ sharesOn: false });
      const dispute = `dispute.${randomUUID().replaceAll('-', '')}`;
      const reverse = () =>
        db.transaction((tx) =>
          reverseTip(tx, {
            tipId: tip.tipId,
            partnerReversalId: dispute,
            refundedMinor: GROSS,
            feeReturnOn: true,
          }),
        );
      await reverse();
      await reverse(); // a repeat of the same dispute is a no-op
      assert.deepEqual(await feeReturns(tip.tipId), [
        { status: 'out_paid', amount: '55000', refund: dispute },
      ]);
      partner.available.set(TOBI.id, 0n);
      await run(partner, later(MINUTE));
      assert.equal(partner.available.get(TOBI.id), 55000n);
    },
  );

  await t.test(
    'a business tip takes the staff member’s plan rate, and a refund returns TipMe’s own fee its quote took, never the processing',
    async () => {
      // Owner, 12 Nov 2026: Free 7%, Pro 5%. The fee's return reads each tip's quote, so a plan
      // change between the tip and its refund never changes what goes back. Owner, 14 Nov 2026:
      // only TipMe's own fee goes back (Free ₦550, Pro ₦350), never the ₦150 processing.
      await database.fresh();
      const shared = await atBusiness();
      const partner = pretendPartner();
      const plan = (value) =>
        q('UPDATE profiles SET plan = $2 WHERE id = $1', [TOBI.id, value]);
      const free = await paidTip({ shared });
      assert.equal(free.quote.breakdown.recipientNetMinor, 930000n);
      await plan('pro');
      const pro = await paidTip({ shared });
      assert.equal(pro.quote.breakdown.recipientNetMinor, 950000n);
      assert.deepEqual(
        await q(
          'SELECT share_minor::text AS share FROM tip_business_shares WHERE tip_id = $1',
          [pro.tipId],
        ),
        [{ share: '190000' }],
      );
      partner.available.set(TOBI.id, 930000n + 950000n);
      await run(partner, later(SETTLE + MINUTE));
      // Back on Free when the Pro tip is refunded; on Pro when the Free tip is.
      await plan('free');
      await refund(partner, pro, { feeReturnOn: true });
      await plan('pro');
      await refund(partner, free, { feeReturnOn: true });
      assert.deepEqual(
        (await feeReturns(pro.tipId)).map((r) => r.amount),
        ['35000'],
      );
      assert.deepEqual(
        (await feeReturns(free.tipId)).map((r) => r.amount),
        ['55000'],
      );
      await run(partner, later(SETTLE + 2 * MINUTE));
      const fees = partner.calls
        .filter((c) => c.call === 'send' && c.to === TOBI.id)
        .map((c) => c.amountMinor);
      assert.ok(fees.includes(35000n) && fees.includes(55000n));
      assert.deepEqual(
        await q(
          `SELECT transaction_id FROM ledger_entries GROUP BY transaction_id, currency
            HAVING sum(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`,
        ),
        [],
      );
    },
  );
});
