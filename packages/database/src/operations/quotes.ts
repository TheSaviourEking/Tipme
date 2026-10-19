import {
  AmountOutOfRangeError,
  FEE_FREE_VERSION_SUFFIX,
  feeFreeAllowed,
  assertCurrency,
  MOCK_FEE_POLICY_V0,
  priceTip,
  type FeeBreakdown,
} from '@tipme/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { feeFreeCredits, profiles, tipQuotes } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { rewardStats } from './moments.js';

export const QUOTE_TTL_MS = 15 * 60 * 1000;

export interface QuoteResult {
  quoteId: string;
  profileId: string;
  handle: string;
  displayName: string;
  currency: string;
  breakdown: FeeBreakdown;
  feePolicyVersion: string;
  /** TipMe's fee is waived on this quote (a fee-free reward). */
  feeFree: boolean;
  expiresAt: Date;
}

/** Server-side price for a tip. Hidden, suspended and unknown profiles are indistinguishable. */
export function createQuote(
  db: Database,
  input: { handle: string; tipMinor: bigint; currency: string; now?: Date },
): Promise<QuoteResult> {
  return guarded(() => quote(db, input));
}

async function quote(
  db: Database,
  input: { handle: string; tipMinor: bigint; currency: string; now?: Date },
): Promise<QuoteResult> {
  try {
    assertCurrency(input.currency);
  } catch {
    throw new OperationError('AMOUNT_OUT_OF_RANGE');
  }
  const [profile] = await db
    .select({
      id: profiles.id,
      handle: profiles.handle,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(
      and(
        eq(profiles.handleLower, input.handle.toLowerCase()),
        eq(profiles.status, 'active'),
        eq(profiles.pageState, 'live'),
        eq(profiles.visibility, 'public'),
      ),
    );
  if (!profile) throw new OperationError('PROFILE_NOT_FOUND');
  let breakdown: FeeBreakdown;
  try {
    breakdown = priceTip(input.tipMinor, MOCK_FEE_POLICY_V0);
  } catch (error) {
    if (error instanceof AmountOutOfRangeError)
      throw new OperationError('AMOUNT_OUT_OF_RANGE');
    throw error;
  }
  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + QUOTE_TTL_MS,
  );
  const quoteId = newId();
  const priced = breakdown;
  // A fee-free reward waives TipMe's fee while credits last and the lifetime cap allows it.
  // Open fee-free quotes reserve their credit and their cost, under a lock on the credits row,
  // so quotes made before any of them is paid can never overspend either.
  const { waivedPlatformFeeMinor, finalBreakdown, feePolicyVersion } =
    await db.transaction(async (tx) => {
      const [credits] = await tx
        .select({ remaining: feeFreeCredits.remaining })
        .from(feeFreeCredits)
        .where(eq(feeFreeCredits.profileId, profile.id))
        .for('update');
      let waived = 0n;
      let chosen = priced;
      let version: string = MOCK_FEE_POLICY_V0.version;
      if ((credits?.remaining ?? 0) > 0 && priced.platformFeeMinor > 0n) {
        const open = await openFeeFreeQuotes(
          tx,
          profile.id,
          expiresAt.getTime() - QUOTE_TTL_MS,
        );
        const stats = await rewardStats(tx, profile.id);
        if (
          feeFreeAllowed({
            credits: (credits?.remaining ?? 0) - open.count,
            waivedFeeMinor: priced.platformFeeMinor,
            lifetimeFeesMinor: stats.lifetimeFeesMinor,
            lifetimeRewardCostMinor:
              stats.lifetimeRewardCostMinor + open.waivedMinor,
          })
        ) {
          waived = priced.platformFeeMinor;
          chosen = priceTip(input.tipMinor, MOCK_FEE_POLICY_V0, {
            feeFree: true,
          });
          version = `${MOCK_FEE_POLICY_V0.version}${FEE_FREE_VERSION_SUFFIX}`;
        }
      }
      await tx.insert(tipQuotes).values({
        id: quoteId,
        profileId: profile.id,
        currency: input.currency,
        tipMinor: chosen.tipMinor,
        platformFeeMinor: chosen.platformFeeMinor,
        providerFeeMinor: chosen.providerFeeMinor,
        payerTotalMinor: chosen.payerTotalMinor,
        recipientNetMinor: chosen.recipientNetMinor,
        feePolicyVersion: version,
        waivedPlatformFeeMinor: waived,
        expiresAt,
      });
      return {
        waivedPlatformFeeMinor: waived,
        finalBreakdown: chosen,
        feePolicyVersion: version,
      };
    });
  breakdown = finalBreakdown;
  return {
    quoteId,
    profileId: profile.id,
    handle: profile.handle,
    displayName: profile.displayName,
    currency: input.currency,
    breakdown,
    feePolicyVersion,
    feeFree: waivedPlatformFeeMinor > 0n,
    expiresAt,
  };
}

/** What the provider must be asked to charge for a quote. */
export function findQuoteCharge(
  db: Database,
  quoteId: string,
): Promise<{ payerTotalMinor: bigint; currency: string } | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        payerTotalMinor: tipQuotes.payerTotalMinor,
        currency: tipQuotes.currency,
      })
      .from(tipQuotes)
      .where(eq(tipQuotes.id, quoteId));
    return row ?? null;
  });
}

/** Fee-free quotes still open (not expired, not paid, not failed): each holds a credit and its cost. */
async function openFeeFreeQuotes(
  tx: Tx,
  profileId: string,
  nowMs: number,
): Promise<{ count: number; waivedMinor: bigint }> {
  const result = await tx.execute<{ n: number; waived: string }>(sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(q.waived_platform_fee_minor), 0)::text AS waived
      FROM tip_quotes q
      LEFT JOIN payment_intents i ON i.quote_id = q.id
      LEFT JOIN tips t ON t.intent_id = i.id
     WHERE q.profile_id = ${profileId} AND q.waived_platform_fee_minor > 0
       AND q.expires_at > ${new Date(nowMs).toISOString()}::timestamptz
       AND (t.id IS NULL OR t.status IN ('AWAITING_PAYMENT', 'PENDING_VERIFICATION'))`);
  const row = result.rows[0];
  return { count: row?.n ?? 0, waivedMinor: BigInt(row?.waived ?? '0') };
}
