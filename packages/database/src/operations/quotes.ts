import {
  AmountOutOfRangeError,
  FEE_FREE_VERSION_SUFFIX,
  assertCurrency,
  feePolicyForPlan,
  planShareBps,
  priceTip,
  type FeeBreakdown,
} from '@tipme/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { feeFreeCredits, profiles, tipQuotes } from '../schema.js';
import { shareInForce } from './share-at-tip.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { opsPageByHandle, tipAmountsOf } from './profiles.js';
import { personOf } from './owner.js';

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
  /** Business release 2 (R2-C2): the share in force at the business, shown before paying. */
  share?: { businessBps: number; businessName: string };
}

type QuoteInput = {
  handle: string;
  tipMinor: bigint;
  currency: string;
  now?: Date;
  /** The business membership the tip page is for (TipMe for businesses). */
  businessMemberId?: string;
  /** The API's BUSINESS_SHARES_ENABLED. Off unless passed: no share is ever looked up. */
  sharesOn?: boolean;
};

/** Server-side price for a tip. Hidden, suspended and unknown profiles are indistinguishable. */
export function createQuote(
  db: Database,
  input: QuoteInput,
): Promise<QuoteResult> {
  return guarded(() => quote(db, input));
}

async function quote(db: Database, input: QuoteInput): Promise<QuoteResult> {
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
      plan: profiles.plan,
      tipPresetsMinor: profiles.tipPresetsMinor,
      minTipMinor: profiles.minTipMinor,
      customFeeBps: profiles.customFeeBps,
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
  const minTipMinor = BigInt(tipAmountsOf(profile).minMinor);
  // The recipient's plan now picks the rate (owner, 12 Nov 2026: Free 7%, Pro 5%), and the quote
  // records it in its version, so a later plan change never alters this price. A share staff set
  // for this account (ADR-0014) applies only below the plan's rate.
  const plan = profile.plan === 'pro' ? 'pro' : 'free';
  const policy = feePolicyForPlan(plan);
  const { bps: shareBps, custom } = planShareBps(
    plan,
    profile.customFeeBps === null ? null : BigInt(profile.customFeeBps),
  );
  const baseVersion =
    custom === null ? policy.version : `${policy.version}-custom-${custom}`;
  let breakdown: FeeBreakdown;
  try {
    // A Pro page's own minimum (PR-012), enforced here whatever the page showed.
    breakdown = priceTip(input.tipMinor, policy, { minTipMinor, shareBps });
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
  // Fee-free tips are granted by staff (ADR-0014) and honoured while credits last. Open
  // fee-free quotes reserve their credit, under a lock on the credits row, so quotes made before
  // any of them is paid can never use more credits than were granted.
  const { waivedPlatformFeeMinor, finalBreakdown, feePolicyVersion, shared } =
    await db.transaction(async (tx) => {
      const [credits] = await tx
        .select({ remaining: feeFreeCredits.remaining })
        .from(feeFreeCredits)
        .where(eq(feeFreeCredits.profileId, profile.id))
        .for('update');
      let waived = 0n;
      let chosen = priced;
      let version: string = baseVersion;
      const share = priced.platformFeeMinor + priced.providerFeeMinor;
      if ((credits?.remaining ?? 0) > 0 && share > 0n) {
        const open = await openFeeFreeQuotes(
          tx,
          profile.id,
          expiresAt.getTime() - QUOTE_TTL_MS,
        );
        if ((credits?.remaining ?? 0) - open.count > 0) {
          // TipMe gives up its whole share, the processing it would have paid from it included.
          waived = share;
          chosen = priceTip(input.tipMinor, policy, {
            feeFree: true,
            minTipMinor,
          });
          version = `${baseVersion}${FEE_FREE_VERSION_SUFFIX}`;
        }
      }
      // Fixed on the quote, so the intent can tell whether the supporter saw the split in force.
      const shared = input.sharesOn
        ? await shareInForce(tx, profile.id, input.businessMemberId)
        : null;
      await tx.insert(tipQuotes).values({
        id: quoteId,
        shareAgreementId: shared?.agreementId ?? null,
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
        shared,
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
    ...(shared
      ? {
          share: {
            businessBps: shared.businessBps,
            businessName: shared.businessName,
          },
        }
      : {}),
  };
}

/** What the provider must be asked to charge for a quote. */
export function findQuoteCharge(
  db: Database,
  quoteId: string,
): Promise<{
  profileId: string;
  payerTotalMinor: bigint;
  platformFeeMinor: bigint;
  providerFeeMinor: bigint;
  currency: string;
} | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        profileId: tipQuotes.profileId,
        payerTotalMinor: tipQuotes.payerTotalMinor,
        platformFeeMinor: tipQuotes.platformFeeMinor,
        providerFeeMinor: tipQuotes.providerFeeMinor,
        currency: tipQuotes.currency,
      })
      .from(tipQuotes)
      .where(eq(tipQuotes.id, quoteId));
    return row ? { ...row, profileId: personOf(row.profileId) } : null;
  });
}

/** Fee-free quotes still open (not expired, not paid, not failed): each holds a credit. */
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

/** The current handle, lower-cased, of the page a quote is for; null when there is no such quote. */
export function quoteHandleOf(
  db: Database,
  quoteId: string,
): Promise<string | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ handle: profiles.handleLower })
      .from(tipQuotes)
      .innerJoin(profiles, eq(profiles.id, tipQuotes.profileId))
      .where(eq(tipQuotes.id, quoteId));
    return row?.handle ?? null;
  });
}

/** A handle or old handle as the page's current handle, lower-cased; null when there is no page. */
export async function pageHandleOf(
  db: Database,
  raw: string,
): Promise<string | null> {
  const page = await opsPageByHandle(db, raw);
  return page ? page.handle.toLowerCase() : null;
}
