import { sql, type SQL } from 'drizzle-orm';

/**
 * Task 11 (re-review 1, N1): the one definition of "a dispute on this tip isn't settled", so the
 * share transfers, refunds and returns can't drift apart. Open or responded, or lost and its loss not
 * yet booked (`settled_at` null). A lost dispute that settled is over: what its loss didn't use is
 * the tip's to return. A closed dispute with no ruling keeps its hold for a refund until it settles
 * (P28): it counts only where `closed` says so, since a refund or a return is how that hold ends,
 * but nothing may move to the recipient or a business meanwhile.
 */
export function unsettledDisputeSql(
  tipId: SQL,
  { closed }: { closed: 'unsettled' | 'ignored' },
): SQL {
  const settling =
    closed === 'unsettled' ? sql`('lost', 'closed')` : sql`('lost')`;
  return sql`EXISTS (
    SELECT 1 FROM disputes x
     WHERE x.tip_id = ${tipId}
       AND (x.status IN ('open', 'responded')
            OR (x.status IN ${settling} AND x.settled_at IS NULL)))`;
}

/**
 * Task 15 follow-up (re-review 2, n3): the same rule as `unsettledDisputeSql` with `closed: 'ignored'`,
 * for disputes already read into memory (a refund's plan), so the two can't drift apart.
 */
export function isUnsettledDispute(dispute: {
  status: string;
  settledAt: Date | null;
}): boolean {
  return (
    dispute.status === 'open' ||
    dispute.status === 'responded' ||
    (dispute.status === 'lost' && dispute.settledAt === null)
  );
}

/**
 * Task 15 follow-up (re-review 2, n3): a refund is never sent once a dispute on its tip is open,
 * answered or lost (settled or not), or the tip's money went back (a reversal posting). Stricter than
 * `unsettledDisputeSql` on purpose: after any loss, what is left is returned, never refunded again.
 */
export function refundSendBlockedSql(tipId: SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM disputes x WHERE x.tip_id = ${tipId}
              AND x.status IN ('open', 'responded', 'lost'))
           OR EXISTS (SELECT 1 FROM ledger_transactions l WHERE l.tip_id = ${tipId}
              AND l.operation_type = 'reversal'))`;
}
