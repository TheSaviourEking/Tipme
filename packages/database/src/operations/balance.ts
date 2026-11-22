import { sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { profiles } from '../schema.js';
import { guarded } from './errors.js';

/**
 * RM7 (Task 10): the part of a person's `held_for_recipients` waiting on a refund of a tip, never
 * "on its way" to them: a share still held for its refund (in review, reason `refund`), and what a
 * tip's refunds took back (paid transfers back, net of returns) until the refund is booked or a
 * lost dispute used it (either is the tip's `reversal`). `profile` is the profile id as SQL (a
 * parameter, or a column of the outer query).
 */
export function refundHeldSql(profile: SQL): SQL {
  return sql`(
      (SELECT COALESCE(SUM(s.amount_minor), 0) FROM collect_transfers s
        WHERE s.profile_id = ${profile} AND s.kind = 'share' AND s.status = 'review'
          AND s.review_reason = 'refund')
      + (SELECT COALESCE(SUM(GREATEST(k.taken, 0)), 0) FROM (
          SELECT SUM(CASE c.kind WHEN 'back' THEN c.amount_minor ELSE -c.amount_minor END) AS taken
            FROM collect_transfers c
           WHERE c.profile_id = ${profile} AND c.refund_id IS NOT NULL
             AND c.kind IN ('back', 'return') AND c.status = 'paid'
             AND NOT EXISTS (SELECT 1 FROM ledger_transactions lt
                              WHERE lt.tip_id = c.tip_id AND lt.operation_type = 'reversal')
           GROUP BY c.tip_id) k))`;
}

/**
 * Splits what TipMe holds for a person (`held_for_recipients`) into the words they see (spec §10):
 * held for a refund (RM7), and the rest kept for them (not verified) or on its way (verified).
 */
export function heldParts(
  held: bigint,
  refundHeld: bigint,
  verified: boolean,
): { keptMinor: bigint; onItsWayMinor: bigint; refundHeldMinor: bigint } {
  const refundHeldMinor =
    refundHeld <= 0n
      ? 0n
      : refundHeld > held
        ? held > 0n
          ? held
          : 0n
        : refundHeld;
  const rest = held - refundHeldMinor;
  return {
    keptMinor: verified ? 0n : rest,
    onItsWayMinor: verified ? rest : 0n,
    refundHeldMinor,
  };
}

/**
 * RI4 (Task 10): a tip's dispute holds and its refunds can name the same money. The refund term and
 * held_for_recipients already count what the tip's refunds reserve or took back (paid transfers
 * back, net of returns), so a dispute counts only the rest: per tip, GREATEST(held - covered, 0).
 * A lost dispute's own transfer back set its hold net of the refunds already (settleLost's
 * fromRefund), so that one counts net only of its own back once paid (RM9, Task 11): from then the
 * money is in held_for_recipients, and until settleLost books the loss it would count twice.
 *
 * RM10: every `collect_transfers` read here is scoped by `profile_id` (the tip's recipient, whose
 * account every share, transfer back and return of the tip uses), so it runs on the
 * `(profile_id, status)` index, never a scan of every recipient's transfers.
 */
function disputeTermOnce(profileId: string): SQL {
  return sql`+ (SELECT COALESCE(SUM(GREATEST(h.held - h.covered, 0)), 0) FROM (
          SELECT x.tip_id, SUM(x.held_minor) AS held,
                 GREATEST((SELECT COALESCE(SUM(CASE c.kind WHEN 'back' THEN c.amount_minor
                                                           ELSE -c.amount_minor END), 0)
                             FROM collect_transfers c
                            WHERE c.profile_id = ${profileId} AND c.tip_id = x.tip_id
                              AND c.refund_id IS NOT NULL
                              AND c.kind IN ('back', 'return') AND c.status = 'paid'), 0)
                 + (SELECT COALESCE(SUM(r.held_minor), 0) FROM tip_refunds r
                     WHERE r.tip_id = x.tip_id) AS covered
            FROM disputes x JOIN tips dt ON dt.id = x.tip_id
           WHERE dt.profile_id = ${profileId} AND x.held_minor > 0
             AND NOT EXISTS (SELECT 1 FROM collect_transfers b
                              WHERE b.profile_id = ${profileId} AND b.dispute_id = x.id
                                AND b.kind = 'back')
           GROUP BY x.tip_id) h)
      + (SELECT COALESCE(SUM(GREATEST(x.held_minor
                 - (SELECT COALESCE(SUM(b.amount_minor), 0) FROM collect_transfers b
                     WHERE b.profile_id = ${profileId} AND b.dispute_id = x.id
                       AND b.kind = 'back' AND b.status = 'paid'), 0)), 0)
           FROM disputes x JOIN tips dt ON dt.id = x.tip_id
          WHERE dt.profile_id = ${profileId}
            AND EXISTS (SELECT 1 FROM collect_transfers b
                         WHERE b.profile_id = ${profileId} AND b.dispute_id = x.id
                           AND b.kind = 'back'))`;
}

/** The same for someone with no dispute or collect refund at all (`collect_money` false): zero. */
function disputeTermPlain(profileId: string): SQL {
  return sql`+ (SELECT COALESCE(SUM(x.held_minor), 0) FROM disputes x JOIN tips dt ON dt.id = x.tip_id
          WHERE dt.profile_id = ${profileId})`;
}

/**
 * The balance's parts in one statement. `collect: false` (M4) reads nothing of You collect's
 * transfers: right only while `collect_money` is false (no dispute and no collect refund on any of
 * their tips, and not collecting), which it reports so the caller can read again with `collect`.
 */
export function balanceQuery(
  profileId: string,
  { collect = true }: { collect?: boolean } = {},
) {
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
      -- You collect (R4, plan Task 9): what a dispute holds of the balance while it is open, closed
      -- and kept for a refund (P28), or lost and still being recovered. Zero once released or booked.
      ${collect ? disputeTermOnce(profileId) : disputeTermPlain(profileId)}
      -- You collect (plan Task 10): what a refund of a collect tip is about to take back from their
      -- account (its transfer back not paid yet). Once paid, the money is in held_for_recipients
      -- (below) and this is zero. Always zero for a direct tip's refund.
      + (SELECT COALESCE(SUM(r.held_minor), 0) FROM tip_refunds r JOIN tips rt ON rt.id = r.tip_id
          WHERE rt.profile_id = ${profileId}) AS reserved,
      -- You collect (Task 12): the person's money TipMe still holds on its own account, kept for them
      -- (not verified yet) or on its way to theirs (verified). Owed, never in their account yet.
      (SELECT COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0)
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.code = 'held_for_recipients' AND a.profile_id = ${profileId}) AS held,
      ${collect ? refundHeldSql(sql`${profileId}`) : sql`0`} AS refund_held,
      (SELECT ${profiles.collectionMode} = 'collect' FROM profiles WHERE profiles.id = ${profileId})
        OR EXISTS (SELECT 1 FROM disputes x JOIN tips dt ON dt.id = x.tip_id
                    WHERE dt.profile_id = ${profileId})
        OR EXISTS (SELECT 1 FROM tip_refunds r JOIN tips rt ON rt.id = r.tip_id
                    WHERE rt.profile_id = ${profileId} AND r.collect_plan IS NOT NULL)
        AS collect_money,
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
 * owner 12 Nov 2026) and Pro paid from the balance still being moved (COLLECTING / UNKNOWN), what a dispute holds (`disputes.held_minor`, R4) and
 * what a collect refund is about to take back (`tip_refunds.held_minor`, Task 10), which are reserved. It can read below zero after a reversal (Q8). Money still being confirmed by the
 * provider is reported separately and is never part of the balance.
 *
 * You collect (Task 12, spec §2.1, §10): money TipMe still holds for them on its own account
 * (`held_for_recipients`) is owed but not in their account, so it is never part of
 * `availableMinor`. Unverified it is `keptMinor` ("Kept for you until you add your bank details");
 * verified, `onItsWayMinor` ("On its way to you"). Both zero for a direct recipient. The part held
 * while a refund of one of their tips is settled is neither: it is `refundHeldMinor` (RM7).
 *
 * RI4: a dispute's hold and a refund of the same tip count the same money once (see the query).
 */
export interface Balance {
  availableMinor: bigint;
  confirmingMinor: bigint;
  keptMinor: bigint;
  onItsWayMinor: bigint;
  /** RM7: held while a refund of one of their tips is settled ("Held while a refund is settled"). */
  refundHeldMinor: bigint;
}

/** The balance, and whether the person is on You collect (so callers need no second read). */
export async function balanceWithModeIn(
  tx: Database | Tx,
  profileId: string,
): Promise<Balance & { collecting: boolean }> {
  type BalanceRow = {
    payable: string | null;
    reserved: string | null;
    held: string | null;
    refund_held: string | null;
    collect_money: boolean | null;
    verified: boolean | null;
    collecting: boolean | null;
    confirming: string | null;
  };
  // M4: a direct recipient's read never touches You collect's transfers; anyone with collect money
  // (a dispute, a collect refund, or collecting now) is read again in full (RI4, RM7).
  let result = await tx.execute<BalanceRow>(
    balanceQuery(profileId, { collect: false }),
  );
  if (result.rows[0]?.collect_money === true)
    result = await tx.execute<BalanceRow>(balanceQuery(profileId));
  const row = result.rows[0];
  const held = BigInt(row?.held ?? '0');
  return {
    availableMinor:
      BigInt(row?.payable ?? '0') - BigInt(row?.reserved ?? '0') - held,
    confirmingMinor: BigInt(row?.confirming ?? '0'),
    ...heldParts(held, BigInt(row?.refund_held ?? '0'), row?.verified === true),
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
