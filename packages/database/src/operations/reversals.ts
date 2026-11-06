import {
  buildReversalPosting,
  type AccountCode,
  type LedgerLine,
} from '@tipme/domain';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  issues,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  profiles,
  tips,
} from '../schema.js';
import { balanceIn, businessBalanceIn } from './balance.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId } from './ids.js';
import { openIssue } from './issues.js';
import { postLedgerTransaction } from './ledger.js';

/** Whose balance a reversal left below zero (Q8). */
export type BelowZero = { profileId: string } | { businessId: string };

export interface ReversalResult {
  transactionId: string;
  /** False for a repeat of the same provider event: nothing new was posted. */
  created: boolean;
  belowZero: BelowZero[];
}

/** The ledger key of the reversal for one provider refund or chargeback event. */
export const reversalKey = (providerEventId: string) =>
  `reversal.${providerEventId}`;

const ownerKey = (line: LedgerLine) =>
  `${line.account}|${line.profileId ?? ''}|${line.businessId ?? ''}`;

/**
 * Business release 2 (Q7, Q8): takes back a refunded or charged-back tip, every line of its payment
 * (the person's part, the business's part and TipMe's own lines), in one balanced `reversal`
 * transaction keyed by the provider event. TipMe only records it: the partner already moved the
 * money, so nothing here calls the partner and a repeat of the event is a no-op.
 *
 * A partial refund (`refundedMinor` below what is left of the tip) takes back each line in
 * proportion. A tip can be refunded and later charged back: each reversal works on what earlier
 * ones left, so no account is ever taken back more than the payment gave it, and a refund larger
 * than what is left is refused (`TIP_NOT_REVERSIBLE`).
 *
 * The reversal posts even when the money was already withdrawn, and the balance may go below zero:
 * withdrawals then refuse `BALANCE_BELOW_ZERO`, and one `balance_below_zero` money issue opens per
 * balance it left below zero. Nothing is collected automatically. It locks the tip, then each
 * person's profile row and each business row, as withdrawals do, so a withdrawal racing it sees
 * either the money or the reversal, never both.
 */
export async function reverseTip(
  tx: Tx,
  input: {
    tipId: string;
    providerEventId: string;
    refundedMinor: bigint;
    traceId?: string | null;
    now?: Date;
  },
): Promise<ReversalResult> {
  if (input.refundedMinor <= 0n || input.providerEventId.length === 0)
    throw new OperationError('INVALID_INPUT');
  const operationKey = reversalKey(input.providerEventId);
  const [tip] = await tx
    .select({ id: tips.id, currency: tips.currency })
    .from(tips)
    .where(eq(tips.id, input.tipId))
    .for('update');
  if (!tip) throw new OperationError('TIP_NOT_REVERSIBLE', 'no_tip');

  // Under the tip's lock, so a repeat that raced this one finds it.
  const [done] = await tx
    .select({ id: ledgerTransactions.id, tipId: ledgerTransactions.tipId })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.operationKey, operationKey));
  if (done) {
    if (done.tipId !== tip.id) throw new OperationError('INVALID_INPUT');
    return { transactionId: done.id, created: false, belowZero: [] };
  }

  const [payment] = await tx
    .select({ id: ledgerTransactions.id })
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.tipId, tip.id),
        eq(ledgerTransactions.operationType, 'payment'),
      ),
    );
  if (!payment) throw new OperationError('TIP_NOT_REVERSIBLE', 'not_paid');

  const rows = await tx
    .select({
      transactionId: ledgerEntries.transactionId,
      account: ledgerAccounts.code,
      profileId: ledgerEntries.profileId,
      businessId: ledgerEntries.businessId,
      side: ledgerEntries.side,
      amountMinor: ledgerEntries.amountMinor,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .innerJoin(
      ledgerTransactions,
      eq(ledgerTransactions.id, ledgerEntries.transactionId),
    )
    .where(
      or(
        eq(ledgerTransactions.id, payment.id),
        eq(ledgerTransactions.reversesTransactionId, payment.id),
      ),
    )
    .orderBy(ledgerEntries.createdAt, ledgerEntries.id);
  const asLine = (row: (typeof rows)[number]): LedgerLine => ({
    // The account codes are the domain's chart (ledger.ts KIND).
    account: row.account as AccountCode,
    side: row.side,
    amountMinor: row.amountMinor,
    ...(row.profileId ? { profileId: row.profileId } : {}),
    ...(row.businessId ? { businessId: row.businessId } : {}),
  });
  // What is left of each line of the payment after the reversals already posted against it.
  const original = rows
    .filter((row) => row.transactionId === payment.id)
    .map(asLine);
  const taken = new Map<string, bigint>();
  for (const row of rows) {
    if (row.transactionId === payment.id) continue;
    const line = asLine(row);
    const from = original.find((o) => ownerKey(o) === ownerKey(line));
    // A reversal only ever mirrors a payment line (and the database checks it): stop otherwise.
    if (!from || from.side === line.side)
      throw new Error('a reversal does not mirror its payment');
    taken.set(
      ownerKey(line),
      (taken.get(ownerKey(line)) ?? 0n) + line.amountMinor,
    );
  }
  const remaining = original
    .map((line) => ({
      ...line,
      amountMinor: line.amountMinor - (taken.get(ownerKey(line)) ?? 0n),
    }))
    .filter((line) => line.amountMinor > 0n);
  const left = remaining
    .filter((line) => line.side === 'debit')
    .reduce((sum, line) => sum + line.amountMinor, 0n);
  if (left === 0n)
    throw new OperationError('TIP_NOT_REVERSIBLE', 'already_reversed');
  if (input.refundedMinor > left)
    throw new OperationError('TIP_NOT_REVERSIBLE', 'more_than_left');

  // Lock each balance the reversal touches, in a fixed order, before posting against it.
  const people = [
    ...new Set(remaining.flatMap((l) => (l.profileId ? [l.profileId] : []))),
  ].sort();
  const firms = [
    ...new Set(remaining.flatMap((l) => (l.businessId ? [l.businessId] : []))),
  ].sort();
  if (people.length > 0)
    await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(inArray(profiles.id, people))
      .orderBy(profiles.id)
      .for('update');
  if (firms.length > 0)
    await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(inArray(businesses.id, firms))
      .orderBy(businesses.id)
      .for('update');

  const lines = buildReversalPosting(
    remaining,
    input.refundedMinor === left
      ? undefined
      : { num: input.refundedMinor, den: left },
  );
  const posted = await postLedgerTransaction(tx, {
    operationType: 'reversal',
    operationKey,
    currency: tip.currency,
    tipId: tip.id,
    reversesTransactionId: payment.id,
    lines,
    traceId: input.traceId ?? activeTraceId(),
  });

  const now = input.now ?? new Date();
  const belowZero: BelowZero[] = [];
  const touched = new Set(lines.map(ownerKey));
  for (const profileId of people) {
    if (!touched.has(`recipient_payable|${profileId}|`)) continue;
    if ((await balanceIn(tx, profileId)).availableMinor >= 0n) continue;
    belowZero.push({ profileId });
    await openIssue(tx, {
      dedupeKey: `balance_below_zero.${operationKey}.${profileId}`,
      kind: 'balance_below_zero',
      subject: { tipId: tip.id, profileId },
      now,
    });
  }
  for (const businessId of firms) {
    if (!touched.has(`business_payable||${businessId}`)) continue;
    if ((await businessBalanceIn(tx, businessId)).availableMinor >= 0n)
      continue;
    belowZero.push({ businessId });
    await openIssue(tx, {
      dedupeKey: `balance_below_zero.${operationKey}.${businessId}`,
      kind: 'balance_below_zero',
      subject: { tipId: tip.id, businessId },
      now,
    });
  }
  return { ...posted, belowZero };
}

/** How much of a tip's payment reversals have taken back so far (its gross, in minor units). */
export async function reversedMinorOf(tx: Tx, tipId: string): Promise<bigint> {
  const result = await tx.execute<{ reversed: string | null }>(sql`
    SELECT COALESCE(SUM(e.amount_minor), 0) AS reversed
      FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.transaction_id
     WHERE x.tip_id = ${tipId} AND x.operation_type = 'reversal' AND e.side = 'debit'
  `);
  return BigInt(result.rows[0]?.reversed ?? '0');
}

/**
 * What a staff reversal from this issue would take back: the open `payment_reversed` issue's tip,
 * and the partner's event id it was opened for (the last part of its key, as flagPaymentReversal
 * wrote it). Null for any other issue.
 */
export function tipReversalTarget(
  db: Database,
  issueId: string,
): Promise<{ tipId: string; providerEventId: string } | null> {
  return guarded(async () => {
    const [issue] = await db
      .select({
        kind: issues.kind,
        status: issues.status,
        dedupeKey: issues.dedupeKey,
        subject: issues.subject,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (issue?.kind !== 'payment_reversed' || issue.status !== 'open')
      return null;
    const { attemptId, tipId } = issue.subject;
    const prefix = `event.payment.reversed.${attemptId ?? ''}.`;
    if (!attemptId || !tipId || !issue.dedupeKey.startsWith(prefix))
      return null;
    const providerEventId = issue.dedupeKey.slice(prefix.length);
    return providerEventId ? { tipId, providerEventId } : null;
  });
}
