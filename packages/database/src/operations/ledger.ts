import type { AccountCode, LedgerLine } from '@tipme/domain';
import { isBalanced } from '@tipme/domain';
import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../client.js';
import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
} from '../schema.js';
import { newId } from './ids.js';

const KIND: Record<AccountCode, 'asset' | 'liability' | 'revenue' | 'expense'> =
  {
    provider_clearing: 'asset',
    recipient_payable: 'liability',
    platform_fee_revenue: 'revenue',
    provider_fee_expense: 'expense',
    // Contra-expense: the provider fee recovered from the tip.
    provider_fee_recovered: 'revenue',
    promotions_expense: 'expense',
  };

async function accountId(
  tx: Tx,
  code: AccountCode,
  currency: string,
  profileId: string | null,
): Promise<string> {
  await tx
    .insert(ledgerAccounts)
    .values({ id: newId(), code, kind: KIND[code], currency, profileId })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.code, code),
        eq(ledgerAccounts.currency, currency),
        profileId === null
          ? isNull(ledgerAccounts.profileId)
          : eq(ledgerAccounts.profileId, profileId),
      ),
    );
  if (!row) throw new Error('ledger account could not be created');
  return row.id;
}

/**
 * Posts one balanced transaction for one business operation. The unique operation key makes a
 * repeat a no-op that returns the original transaction (and inserts no entries).
 */
export async function postLedgerTransaction(
  tx: Tx,
  input: {
    operationType: 'payment' | 'payout' | 'reward';
    operationKey: string;
    currency: string;
    tipId?: string;
    payoutId?: string;
    lines: LedgerLine[];
    traceId: string | null;
  },
): Promise<{ transactionId: string; created: boolean }> {
  if (!isBalanced(input.lines))
    throw new Error('refusing to post an unbalanced transaction');
  const transactionId = newId();
  const inserted = await tx
    .insert(ledgerTransactions)
    .values({
      id: transactionId,
      operationType: input.operationType,
      operationKey: input.operationKey,
      currency: input.currency,
      tipId: input.tipId ?? null,
      payoutId: input.payoutId ?? null,
      traceId: input.traceId,
    })
    .onConflictDoNothing({ target: ledgerTransactions.operationKey })
    .returning({ id: ledgerTransactions.id });
  if (inserted.length === 0) {
    const [existing] = await tx
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.operationKey, input.operationKey));
    if (!existing) throw new Error('ledger transaction vanished');
    return { transactionId: existing.id, created: false };
  }
  for (const line of input.lines) {
    const profileId = line.profileId ?? null;
    await tx.insert(ledgerEntries).values({
      id: newId(),
      transactionId,
      accountId: await accountId(tx, line.account, input.currency, profileId),
      profileId,
      side: line.side,
      amountMinor: line.amountMinor,
      currency: input.currency,
    });
  }
  return { transactionId, created: true };
}
