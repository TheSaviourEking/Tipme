import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { guarded } from './errors.js';

export function balanceQuery(profileId: string) {
  return sql`
    SELECT
      (SELECT COALESCE(SUM(CASE WHEN e.side = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.code = 'recipient_payable' AND a.profile_id = ${profileId}) AS payable,
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payouts p
        WHERE p.profile_id = ${profileId} AND p.status IN ('REQUESTED', 'PROCESSING')) AS reserved,
      (SELECT COALESCE(SUM(q.recipient_net_minor - COALESCE(s.share_minor, 0)), 0)
         FROM tips t
         JOIN payment_intents i ON i.id = t.intent_id
         JOIN tip_quotes q ON q.id = i.quote_id
         -- Business release 2: a business's share of the net is never the person's.
         LEFT JOIN tip_business_shares s ON s.tip_id = t.id
        WHERE t.profile_id = ${profileId}
          AND (t.status = 'PENDING_VERIFICATION'
               OR (t.status = 'AWAITING_PAYMENT' AND EXISTS (
                     SELECT 1 FROM payment_attempts pa
                      WHERE pa.intent_id = t.intent_id AND pa.status = 'PENDING')))) AS confirming
  `;
}

/**
 * What TipMe owes a recipient, from the ledger. It can read below zero after a reversal (Q8): a
 * refund or chargeback is booked even when the money was already withdrawn.
 *
 * What TipMe owes a recipient, from the ledger: `recipient_payable` credits minus debits, less
 * payouts still in flight (REQUESTED / PROCESSING), which are reserved. Money still being
 * confirmed by the provider is reported separately and is never part of the balance.
 */
export async function balanceIn(
  tx: Database | Tx,
  profileId: string,
): Promise<{ availableMinor: bigint; confirmingMinor: bigint }> {
  const result = await tx.execute<{
    payable: string | null;
    reserved: string | null;
    confirming: string | null;
  }>(balanceQuery(profileId));
  const row = result.rows[0];
  return {
    availableMinor: BigInt(row?.payable ?? '0') - BigInt(row?.reserved ?? '0'),
    confirmingMinor: BigInt(row?.confirming ?? '0'),
  };
}

export function balanceOf(
  db: Database,
  profileId: string,
): Promise<{ availableMinor: bigint; confirmingMinor: bigint }> {
  return guarded(() => balanceIn(db, profileId));
}

/**
 * Business release 2: what TipMe owes a business, from its `business_payable` ledger lines, less
 * its withdrawals in flight. Like a person's, it can read below zero after a reversal (Q8). R2-B's
 * business withdrawals lock the business row and refuse `BALANCE_BELOW_ZERO` below zero, as
 * `reverseTip` locks it before posting.
 */
export async function businessBalanceIn(
  tx: Database | Tx,
  businessId: string,
): Promise<{ availableMinor: bigint }> {
  const result = await tx.execute<{
    payable: string | null;
    reserved: string | null;
  }>(sql`
    SELECT
      (SELECT COALESCE(SUM(CASE WHEN e.side = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.code = 'business_payable' AND a.business_id = ${businessId}) AS payable,
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payouts p
        WHERE p.business_id = ${businessId} AND p.status IN ('REQUESTED', 'PROCESSING')) AS reserved
  `);
  const row = result.rows[0];
  return {
    availableMinor: BigInt(row?.payable ?? '0') - BigInt(row?.reserved ?? '0'),
  };
}

/** A business's own balance (R2-B), for its owners. The caller checks the reader is one. */
export function businessBalanceOf(
  db: Database,
  businessId: string,
): Promise<{ availableMinor: bigint }> {
  return guarded(() => businessBalanceIn(db, businessId));
}
