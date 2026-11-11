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
import { planRefundTransfers } from './share-transfers.js';

/** Whose balance a reversal left below zero (Q8). */
export type BelowZero = { profileId: string } | { businessId: string };

export interface ReversalResult {
  transactionId: string;
  /** False for a repeat of the same provider event: nothing new was posted. */
  created: boolean;
  belowZero: BelowZero[];
}

/** The ledger key of the reversal for one provider refund or chargeback event. */
/**
 * The ledger key of the reversal of one partner refund or dispute (`refund.<id>` / `dispute.<id>`),
 * never of a webhook event: several events about one refund make one reversal.
 */
export const reversalKey = (partnerReversalId: string) =>
  `reversal.${partnerReversalId}`;

/** TipMe's own side of the partner balance: a reversal never mirrors it (the partner keeps fees). */
const TIPME_SIDE: ReadonlySet<string> = new Set([
  'provider_clearing',
  'provider_fee_expense',
]);

const ownerKey = (line: LedgerLine) =>
  `${line.account}|${line.profileId ?? ''}|${line.businessId ?? ''}`;

/**
 * Business release 2 (Q7, Q8): takes back a refunded or charged-back tip: everything its payment owed
 * (the person's part, the business's part, TipMe's fee and the provider fee it recovered), while the
 * partner balance drops by the whole refund plus any refund fee. The partner's refund guide says
 * "Fees already charged are not returned", so the provider fee stays TipMe's expense, as does the
 * refund's own fee: nobody's balance loses more than they received. One balanced `reversal`
 * transaction keyed by the partner's refund or dispute (never by a webhook event). TipMe only
 * records it: the partner already moved the money, so nothing here calls the partner, and a repeat
 * for the same refund or dispute is a no-op.
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
    /** The partner's refund or dispute, as the issue names it. */
    partnerReversalId: string;
    /** What the partner gave back of the supporter's payment. */
    refundedMinor: bigint;
    /** A fee the refund itself carried: TipMe's expense, out of the partner balance. */
    refundFeeMinor?: bigint;
    traceId?: string | null;
    now?: Date;
  },
): Promise<ReversalResult> {
  if (input.refundedMinor <= 0n || input.partnerReversalId.length === 0)
    throw new OperationError('INVALID_INPUT');
  const operationKey = reversalKey(input.partnerReversalId);
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
  // What is left of what the payment owed (its credit lines) after earlier reversals. TipMe's own
  // side (the partner balance and the provider fee) is never mirrored: the partner keeps its fee.
  const original = rows
    .filter((row) => row.transactionId === payment.id && row.side === 'credit')
    .map(asLine);
  const taken = new Map<string, bigint>();
  for (const row of rows) {
    if (row.transactionId === payment.id || TIPME_SIDE.has(row.account))
      continue;
    const line = asLine(row);
    const from = original.find((o) => ownerKey(o) === ownerKey(line));
    // A reversal only ever takes back what a payment credited (and the database checks it).
    if (!from || line.side !== 'debit')
      throw new Error('a reversal does not mirror its payment');
    taken.set(
      ownerKey(line),
      (taken.get(ownerKey(line)) ?? 0n) + line.amountMinor,
    );
  }
  const owed = original
    .map((line) => ({
      ...line,
      amountMinor: line.amountMinor - (taken.get(ownerKey(line)) ?? 0n),
    }))
    .filter((line) => line.amountMinor > 0n);
  const left = owed.reduce((sum, line) => sum + line.amountMinor, 0n);
  if (left === 0n)
    throw new OperationError('TIP_NOT_REVERSIBLE', 'already_reversed');
  if (input.refundedMinor > left)
    throw new OperationError('TIP_NOT_REVERSIBLE', 'more_than_left');
  const refundFeeMinor = input.refundFeeMinor ?? 0n;
  if (refundFeeMinor < 0n) throw new OperationError('INVALID_INPUT');
  // As a balanced posting, so the domain can check it: what is left, against the partner balance.
  const remaining: LedgerLine[] = [
    { account: 'provider_clearing', side: 'debit', amountMinor: left },
    ...owed,
  ];

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

  const lines = buildReversalPosting(remaining, {
    refundedMinor: input.refundedMinor,
    refundFeeMinor,
  });
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
  // Option B: a shared tip's money is put right between the partner accounts too (TipMe's fee back
  // to the staff member; the business's share back from it, or held back from its next shares).
  // Only a tip with a share has anything to move, so every other reversal is exactly as before.
  if (posted.created)
    await planRefundTransfers(tx, {
      tipId: tip.id,
      reversalTransactionId: posted.transactionId,
      lines,
      now,
    });
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

/**
 * What a staff reversal from this issue would take back: the open `payment_reversed` issue's tip and
 * the partner's refund or dispute it is about. Null for any other issue, and for one whose events
 * named no refund or dispute: without that id, two events about one refund could each be reversed
 * (R2-A review finding 1), so such an issue is settled at the partner and closed by hand. A refund
 * is reversible only once the partner reports it paid (`refund.paid`), for the amount it gave back;
 * a dispute (no events documented by the partner) for the amount staff enter.
 */
export function tipReversalTarget(
  db: Database,
  issueId: string,
): Promise<{
  tipId: string;
  partnerReversalId: string;
  /** What the partner reports the refund gave back; null for a dispute (staff enter it). */
  refundedMinor: bigint | null;
  refundFeeMinor: bigint;
} | null> {
  return guarded(async () => {
    const [issue] = await db
      .select({
        kind: issues.kind,
        status: issues.status,
        subject: issues.subject,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (issue?.kind !== 'payment_reversed' || issue.status !== 'open')
      return null;
    const { tipId, partnerReversalId, refundState, refundedMinor } =
      issue.subject;
    if (!tipId || !partnerReversalId) return null;
    if (partnerReversalId.startsWith('dispute.'))
      return {
        tipId,
        partnerReversalId,
        refundedMinor: null,
        refundFeeMinor: 0n,
      };
    // A refund only once the partner says it was paid, for what it gave back (its refund guide).
    if (refundState !== 'paid' || !refundedMinor) return null;
    return {
      tipId,
      partnerReversalId,
      refundedMinor: BigInt(refundedMinor),
      refundFeeMinor: BigInt(issue.subject.refundFeeMinor ?? '0'),
    };
  });
}

/** The reversals already posted against a tip's payment: how many, and how much of its gross. */
export async function reversalsOf(
  tx: Tx,
  tipId: string,
): Promise<{ count: number; reversedMinor: bigint }> {
  const result = await tx.execute<{ n: string; reversed: string | null }>(sql`
    SELECT count(DISTINCT x.id) AS n, COALESCE(SUM(e.amount_minor), 0) AS reversed
      FROM ledger_transactions x
      JOIN ledger_entries e ON e.transaction_id = x.id AND e.side = 'debit'
      -- What was taken back of the payment, not a refund's own fee (TipMe's expense).
      JOIN ledger_accounts a ON a.id = e.account_id AND a.code <> 'provider_fee_expense'
     WHERE x.tip_id = ${tipId} AND x.operation_type = 'reversal'
  `);
  const row = result.rows[0];
  return {
    count: Number(row?.n ?? '0'),
    reversedMinor: BigInt(row?.reversed ?? '0'),
  };
}

/** Whether this partner refund or dispute was already reversed. */
export async function alreadyReversed(
  tx: Tx,
  partnerReversalId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: ledgerTransactions.id })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.operationKey, reversalKey(partnerReversalId)));
  return row !== undefined;
}
