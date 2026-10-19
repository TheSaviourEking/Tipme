import type { TipProofView } from '@tipme/contracts';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  paymentAttempts,
  paymentIntents,
  payoutItems,
  payouts,
  providerEvents,
  statusTransitions,
  tipQuotes,
  tips,
} from '../schema.js';

export type TipProof = TipProofView;

const iso = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

/**
 * Both proofs for one tip, as JSON-safe strings: the verified provider event behind the payment,
 * the fee breakdown and its ledger transaction, and (once paid out) the payout and its ledger
 * transaction, plus the full status history.
 */
export async function tipProof(
  db: Database,
  tipId: string,
): Promise<TipProof | null> {
  const [row] = await db
    .select({ tip: tips, quote: tipQuotes, intentId: paymentIntents.id })
    .from(tips)
    .innerJoin(paymentIntents, eq(paymentIntents.id, tips.intentId))
    .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
    .where(eq(tips.id, tipId));
  if (!row) return null;
  const { tip, quote } = row;

  const attempts = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.intentId, row.intentId));
  const succeeded = attempts.find(
    (attempt) => attempt.status === 'VERIFIED_SUCCEEDED',
  );
  let payment: TipProof['payment'] = null;
  if (succeeded) {
    const [evidence] = await db
      .select({
        providerEventId: providerEvents.providerEventId,
        receivedAt: providerEvents.receivedAt,
      })
      .from(statusTransitions)
      .innerJoin(
        providerEvents,
        eq(providerEvents.id, statusTransitions.providerEventId),
      )
      .where(
        and(
          eq(statusTransitions.entityType, 'attempt'),
          eq(statusTransitions.entityId, succeeded.id),
          eq(statusTransitions.toStatus, 'VERIFIED_SUCCEEDED'),
        ),
      );
    if (evidence) {
      payment = {
        attemptId: succeeded.id,
        providerReference: succeeded.providerReference,
        providerEventId: evidence.providerEventId,
        verifiedAt: evidence.receivedAt.toISOString(),
      };
    }
  }

  const [paymentTxn] = await db
    .select({ id: ledgerTransactions.id })
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.tipId, tip.id),
        eq(ledgerTransactions.operationType, 'payment'),
      ),
    );
  let actualFee: string | null = null;
  if (paymentTxn) {
    const [fee] = await db
      .select({ amount: ledgerEntries.amountMinor })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .where(
        and(
          eq(ledgerEntries.transactionId, paymentTxn.id),
          eq(ledgerAccounts.code, 'provider_fee_expense'),
        ),
      );
    actualFee = (fee?.amount ?? 0n).toString();
  }

  // The most recent payout for this tip (earlier ones appear in the history below).
  const [payoutRow] = await db
    .select({ payout: payouts })
    .from(payoutItems)
    .innerJoin(payouts, eq(payouts.id, payoutItems.payoutId))
    .where(eq(payoutItems.tipId, tip.id))
    .orderBy(desc(payouts.createdAt))
    .limit(1);
  let payout: TipProof['payout'] = null;
  if (payoutRow) {
    const [payoutTxn] = await db
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.payoutId, payoutRow.payout.id));
    payout = {
      payoutId: payoutRow.payout.id,
      status: payoutRow.payout.status,
      providerReference: payoutRow.payout.providerReference,
      paidAt: iso(payoutRow.payout.paidAt),
      ledgerTransactionId: payoutTxn?.id ?? null,
    };
  }

  // Every payout that ever covered this tip (an earlier failed one included) is in the history.
  const allPayouts = await db
    .select({ id: payoutItems.payoutId })
    .from(payoutItems)
    .where(eq(payoutItems.tipId, tip.id));
  const entityIds = [
    tip.id,
    ...attempts.map((attempt) => attempt.id),
    ...allPayouts.map((row) => row.id),
  ];
  const history = await db
    .select()
    .from(statusTransitions)
    .where(inArray(statusTransitions.entityId, entityIds))
    .orderBy(asc(statusTransitions.createdAt), asc(statusTransitions.id));

  return {
    tip: {
      id: tip.id,
      status: tip.status,
      currency: tip.currency,
      grossMinor: tip.grossMinor.toString(),
      completedAt: iso(tip.completedAt),
    },
    payment,
    breakdown: {
      grossMinor: quote.tipMinor.toString(),
      platformFeeMinor: quote.platformFeeMinor.toString(),
      quotedProviderFeeMinor: quote.providerFeeMinor.toString(),
      actualProviderFeeMinor: actualFee,
      recipientNetMinor: quote.recipientNetMinor.toString(),
    },
    paymentLedgerTransactionId: paymentTxn?.id ?? null,
    payout,
    history: history.map((entry) => ({
      entityType: entry.entityType,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      cause: entry.cause,
      providerEventId: entry.providerEventId,
      traceId: entry.traceId,
      at: entry.createdAt.toISOString(),
    })),
  };
}
