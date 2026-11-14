import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { providerFeeCredits } from '../schema.js';

/**
 * An unspent ₦50 top-up TipMe already sent to this account (old rule), not held by a payout still in
 * flight, big enough for `feeMinor`; null when there is none. Since users pay their own fee (owner,
 * 12 Nov 2026) no new top-ups are sent: one already there pays the next withdrawal's fee, so TipMe's
 * money is neither stranded in the account nor counted twice. The caller holds the owner's lock.
 */
export async function freeFeeCredit(
  db: Database | Tx,
  input: {
    accountRef: string;
    provider: string;
    currency: string;
    feeMinor: bigint;
  },
): Promise<string | null> {
  const [credit] = await db
    .select({ reference: providerFeeCredits.transferReference })
    .from(providerFeeCredits)
    .where(
      and(
        eq(providerFeeCredits.accountReference, input.accountRef),
        eq(providerFeeCredits.provider, input.provider),
        eq(providerFeeCredits.currency, input.currency),
        isNull(providerFeeCredits.usedByPayoutId),
        sql`${providerFeeCredits.amountMinor} >= ${input.feeMinor}`,
        // Held by a payout still in flight, or promised to one waiting to start (a TipMe-paid
        // payout with no top-up yet claims the oldest free one when it starts).
        sql`NOT EXISTS (
          SELECT 1 FROM payouts p
           WHERE p.fee_transfer_reference = ${providerFeeCredits.transferReference}
             AND p.status IN ('REQUESTED', 'PROCESSING'))`,
        sql`(SELECT count(*) FROM payouts p
              WHERE p.account_reference = ${input.accountRef}
                AND p.fee_payer = 'tipme' AND p.fee_transfer_reference IS NULL
                AND p.status = 'REQUESTED')
            < (SELECT count(*) FROM provider_fee_credits c
                WHERE c.account_reference = ${input.accountRef}
                  AND c.provider = ${input.provider} AND c.currency = ${input.currency}
                  AND c.used_by_payout_id IS NULL AND c.amount_minor >= ${input.feeMinor}
                  AND NOT EXISTS (
                    SELECT 1 FROM payouts p
                     WHERE p.fee_transfer_reference = c.transfer_reference
                       AND p.status IN ('REQUESTED', 'PROCESSING')))`,
      ),
    )
    .orderBy(asc(providerFeeCredits.createdAt))
    .limit(1);
  return credit?.reference ?? null;
}
