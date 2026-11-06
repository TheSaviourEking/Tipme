// Business release 2, PR R2-A: a paid tip the payment partner then refunded or charged back, as the
// `tip.reverse` suites need it. Written through the database operations, never another lane's routes.
import { randomUUID } from 'node:crypto';
import * as ops from '../../packages/database/dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';

export const GROSS = 400000n;
export const NET = 360000n;

/**
 * A paid ₦4,000 tip to `handle` (Tobi by default), at a business taking `bps` of their net when
 * `bps` is set, and the `payment_reversed` issue the partner's refund event opened for it (with
 * the withdrawal hold it places, unless `keepHold` is false).
 */
export async function reportedReversal(
  database,
  {
    handle = 'tobi',
    bps,
    keepHold = true,
    // The partner's webhook events about this one refund (its refund guide): accepted, then paid.
    events = ['refund.created', 'refund.paid'],
    // What the paid refund gave back, and its own fee.
    refundedMinor = GROSS,
    refundFeeMinor = 0n,
  } = {},
) {
  const q = (text, values = []) =>
    database.pool.query(text, values).then((result) => result.rows);
  const [{ id: profileId }] = await q(
    `SELECT id FROM profiles WHERE handle_lower = $1`,
    [handle],
  );
  let shared = null;
  if (bps) {
    const { businessId, locations } = await seedBusiness(database);
    const { memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId,
    });
    const { agreementId } = await seedAgreement(database, {
      memberId,
      businessBps: bps,
    });
    shared = { businessId, memberId, agreementId };
  }
  const quote = await ops.createQuote(database.db, {
    handle,
    tipMinor: GROSS,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    ...(shared ? { businessMemberId: shared.memberId } : {}),
  });
  const [{ net }] = await q(
    `SELECT recipient_net_minor::text AS net FROM tip_quotes WHERE id = $1`,
    [quote.quoteId],
  );
  if (shared)
    await q(
      `INSERT INTO tip_business_shares (tip_id, agreement_id, business_id, business_bps, share_minor)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        intent.tipId,
        shared.agreementId,
        shared.businessId,
        bps,
        // From the quote: a suite may have given the page its own fee.
        ((BigInt(net) * BigInt(bps)) / 10000n).toString(),
      ],
    );
  const reference = `mock_pay_${randomUUID()}`;
  await ops.markAttemptInitiated(database.db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await ops.recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: GROSS,
    currency: 'NGN',
    providerFeeMinor: 6000n,
    signatureVerified: true,
    payload: {},
  });
  const partnerReversalId = `refund.re_${randomUUID().replaceAll('-', '')}`;
  const STATES = {
    'refund.created': 'pending',
    'refund.paid': 'paid',
    'refund.failed': 'failed',
  };
  for (const eventType of events)
    await ops.flagPaymentReversal(database.db, {
      attemptId: intent.attemptId,
      eventId: `evt_${randomUUID()}`,
      eventType,
      partnerReversalId,
      disputeWon: false,
      refundState: STATES[eventType] ?? null,
      refundedMinor: eventType === 'refund.paid' ? refundedMinor : null,
      refundFeeMinor: eventType === 'refund.paid' ? refundFeeMinor : null,
    });
  const [{ id: issueId }] = await q(
    `SELECT id FROM issues WHERE kind = 'payment_reversed' AND dedupe_key = $1`,
    [`event.payment.reversed.${intent.attemptId}.${partnerReversalId}`],
  );
  // A suite that checks a page's other holds can drop this one (the issue stays open).
  if (!keepHold)
    await q(`DELETE FROM withdrawal_holds WHERE issue_id = $1`, [issueId]);
  const reversals = async () =>
    (
      await q(
        `SELECT count(*)::int AS n FROM ledger_transactions
          WHERE tip_id = $1 AND operation_type = 'reversal'`,
        [intent.tipId],
      )
    )[0].n;
  return {
    tipId: intent.tipId,
    profileId,
    issueId,
    attemptId: intent.attemptId,
    partnerReversalId,
    businessId: shared?.businessId ?? null,
    reversals,
  };
}
