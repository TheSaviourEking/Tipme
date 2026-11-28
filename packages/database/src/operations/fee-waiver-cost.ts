import type { FeeWaiverKind } from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import type { MoneyOwner } from './owner.js';

/**
 * What fee waivers cost TipMe (spec §6): two figures that are never added together, because one is
 * income TipMe did not earn and the other is cash it paid out.
 */
export type WaiverCost = {
  /** Fee TipMe would have earned: the waived platform fee (processing included) of SUCCEEDED tips. */
  incomeGivenUpMinor: bigint;
  /**
   * Cash TipMe paid because of waivers: the processing booked on waived tips' payment, plus the fee
   * quoted for each waived withdrawal. The withdrawal part is the quoted carrier fee
   * (`waived_fee_minor`), the one fee the account would otherwise have paid (ruling R9), not the
   * partner's real fee learned at payment.
   */
  cashPaidMinor: bigint;
};

export type FeeWaiverCostInput = {
  /** Inclusive start and exclusive end of the period. */
  from: Date;
  to: Date;
  ruleId?: string;
  kind?: FeeWaiverKind;
  /**
   * A person: their page's tips and withdrawals. A business: its withdrawals and the team tips
   * made at its locations.
   */
  owner?: MoneyOwner;
};

/**
 * Waived tips count by `completed_at`; paid waived withdrawals by `paid_at`. Ruling R10 would also
 * count refunded or reversed tips, but a tip never leaves SUCCEEDED (a reversal is a ledger entry,
 * and the payment transaction read here stays), so SUCCEEDED covers them. A fee-free credit tip has
 * no waiver and never counts.
 */
export async function feeWaiverCost(
  db: Database | Tx,
  input: FeeWaiverCostInput,
): Promise<WaiverCost> {
  const { from, to, ruleId, kind, owner } = input;
  const rule = ruleId === undefined ? sql`` : sql`AND w.id = ${ruleId}`;
  const ofKind = kind === undefined ? sql`` : sql`AND w.kind = ${kind}`;
  const tipOwner =
    owner === undefined
      ? sql``
      : 'businessId' in owner
        ? sql`AND q.team_location_id IN (
                SELECT id FROM business_locations WHERE business_id = ${owner.businessId})`
        : sql`AND q.profile_id = ${owner.profileId}`;
  const payoutOwner =
    owner === undefined
      ? sql``
      : 'businessId' in owner
        ? sql`AND p.business_id = ${owner.businessId}`
        : sql`AND p.profile_id = ${owner.profileId}`;

  const result = await db.execute<{ income: string; cash: string }>(sql`
    WITH waived_tips AS (
      SELECT t.id, q.waived_platform_fee_minor AS waived,
             COALESCE((SELECT sum(e.amount_minor)
                         FROM ledger_transactions x
                         JOIN ledger_entries e ON e.transaction_id = x.id AND e.side = 'debit'
                         JOIN ledger_accounts a ON a.id = e.account_id AND a.code = 'provider_fee_expense'
                        WHERE x.tip_id = t.id AND x.operation_type = 'payment'), 0) AS processing
        FROM tips t
        JOIN payment_intents i ON i.id = t.intent_id
        JOIN tip_quotes q ON q.id = i.quote_id
        JOIN fee_waivers w ON w.id = q.fee_waiver_id
       WHERE t.status = 'SUCCEEDED'
         AND t.completed_at >= ${from} AND t.completed_at < ${to}
         ${rule} ${ofKind} ${tipOwner}),
    waived_payouts AS (
      SELECT p.waived_fee_minor AS fee
        FROM payouts p
        JOIN fee_waivers w ON w.id = p.fee_waiver_id
       WHERE p.status = 'PAID' AND p.paid_at >= ${from} AND p.paid_at < ${to}
         ${rule} ${ofKind} ${payoutOwner})
    SELECT COALESCE((SELECT sum(waived) FROM waived_tips), 0)::text AS income,
           (COALESCE((SELECT sum(processing) FROM waived_tips), 0)
            + COALESCE((SELECT sum(fee) FROM waived_payouts), 0))::text AS cash`);
  const row = result.rows[0];
  return {
    incomeGivenUpMinor: BigInt(row?.income ?? '0'),
    cashPaidMinor: BigInt(row?.cash ?? '0'),
  };
}
