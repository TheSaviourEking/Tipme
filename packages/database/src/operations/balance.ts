import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { profiles } from '../schema.js';
import { guarded } from './errors.js';

export function balanceQuery(profileId: string) {
  return sql`
    SELECT
      (SELECT COALESCE(SUM(CASE WHEN e.side = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.code = 'recipient_payable' AND a.profile_id = ${profileId}) AS payable,
      (SELECT COALESCE(SUM(p.amount_minor + p.user_fee_minor), 0) FROM payouts p
        WHERE p.profile_id = ${profileId} AND p.status IN ('REQUESTED', 'PROCESSING'))
      -- Paid Pro from the balance (plan Task 8): reserved from the moment it opens until it is
      -- booked (then the ledger has it) or fails.
      + (SELECT COALESCE(SUM(pp.amount_minor), 0) FROM pro_purchases pp
          WHERE pp.profile_id = ${profileId} AND pp.method = 'balance'
            AND pp.status IN ('COLLECTING', 'UNKNOWN'))
      -- You collect (R4, plan Task 9): what a dispute holds of the balance while it is open, or lost
      -- and still being recovered. Zero once it is released or booked.
      + (SELECT COALESCE(SUM(x.held_minor), 0) FROM disputes x JOIN tips dt ON dt.id = x.tip_id
          WHERE dt.profile_id = ${profileId}) AS reserved,
      -- You collect (Task 12): the person's money TipMe still holds on its own account, kept for them
      -- (not verified yet) or on its way to theirs (verified). Owed, never in their account yet.
      (SELECT COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0)
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.code = 'held_for_recipients' AND a.profile_id = ${profileId}) AS held,
      (SELECT profiles.collect_verified_at IS NOT NULL FROM profiles
        WHERE profiles.id = ${profileId}) AS verified,
      -- Read here so a direct recipient's withdrawal needs no query of its own about You collect.
      (SELECT ${profiles.collectionMode} = 'collect' FROM profiles
        WHERE profiles.id = ${profileId}) AS collecting,
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
 * What TipMe owes a recipient, from the ledger: `recipient_payable` credits minus debits, less
 * payouts still in flight (REQUESTED / PROCESSING; what is sent plus the fee a user pays from it,
 * owner 12 Nov 2026) and Pro paid from the balance still being moved (COLLECTING / UNKNOWN), and what a dispute holds (`disputes.held_minor`, R4), which
 * are reserved. It can read below zero after a reversal (Q8). Money still being confirmed by the
 * provider is reported separately and is never part of the balance.
 *
 * You collect (Task 12, spec §2.1, §10): money TipMe still holds for them on its own account
 * (`held_for_recipients`) is owed but not in their account, so it is never part of
 * `availableMinor`. Unverified it is `keptMinor` ("Kept for you until you add your bank details");
 * verified, `onItsWayMinor` ("On its way to you"). Both zero for a direct recipient.
 */
export interface Balance {
  availableMinor: bigint;
  confirmingMinor: bigint;
  keptMinor: bigint;
  onItsWayMinor: bigint;
}

/** The balance, and whether the person is on You collect (so callers need no second read). */
export async function balanceWithModeIn(
  tx: Database | Tx,
  profileId: string,
): Promise<Balance & { collecting: boolean }> {
  const result = await tx.execute<{
    payable: string | null;
    reserved: string | null;
    held: string | null;
    verified: boolean | null;
    collecting: boolean | null;
    confirming: string | null;
  }>(balanceQuery(profileId));
  const row = result.rows[0];
  const held = BigInt(row?.held ?? '0');
  const verified = row?.verified === true;
  return {
    availableMinor:
      BigInt(row?.payable ?? '0') - BigInt(row?.reserved ?? '0') - held,
    confirmingMinor: BigInt(row?.confirming ?? '0'),
    keptMinor: verified ? 0n : held,
    onItsWayMinor: verified ? held : 0n,
    collecting: row?.collecting === true,
  };
}

export async function balanceIn(
  tx: Database | Tx,
  profileId: string,
): Promise<Balance> {
  const { collecting, ...balance } = await balanceWithModeIn(tx, profileId);
  void collecting;
  return balance;
}

export function balanceOf(db: Database, profileId: string): Promise<Balance> {
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
      (SELECT COALESCE(SUM(p.amount_minor + p.user_fee_minor), 0) FROM payouts p
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
