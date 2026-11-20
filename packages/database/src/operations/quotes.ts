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
import { planFeeRatesInForce } from './plan-fee-rates.js';
import {
  collectionModeOf,
  decideCollectionMode,
  type CollectionMode,
} from './collection-mode.js';
import { refuseOverHoldingCap } from './collect-guards.js';

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
  /** You collect (R7): the recipient's mode, fixed on this quote. */
  collectionMode: CollectionMode;
}

type QuoteInput = {
  handle: string;
  tipMinor: bigint;
  currency: string;
  now?: Date;
  /** The business membership the tip page is for (TipMe for businesses). */
  businessMemberId?: string;
  /** The `business` and `business_shares` switches. Off unless passed: no share is ever looked up. */
  sharesOn?: boolean;
} & (
  | {
      /**
       * The `you_collect` switch, read once for this quote. Off, the quote takes the recipient's
       * mode as it stands (undecided is `direct`) and decides nothing.
       */
      youCollectOn: false;
    }
  | {
      /** On, an undecided recipient is decided once (R7), against this provider's accounts. */
      youCollectOn: true;
      provider: string;
      environment: string;
    }
);

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
  // The recipient's plan picks the rate (owner, 12 Nov 2026), at the rates in force now: the admin
  // setting, Free 5% and Pro 3% to start (owner, 18 Nov 2026), or those coded defaults when none is
  // stored. The quote records the rate in its version and amounts, so a later plan or rate change
  // never alters this price. A share staff set for this account (ADR-0014) applies only below it.
  const plan = profile.plan === 'pro' ? 'pro' : 'free';
  const rates = await planFeeRatesInForce(db, input.now ?? new Date());
  const policy = feePolicyForPlan(plan, rates);
  const { bps: shareBps, custom } = planShareBps(
    plan,
    profile.customFeeBps === null ? null : BigInt(profile.customFeeBps),
    rates,
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
  const {
    waivedPlatformFeeMinor,
    finalBreakdown,
    feePolicyVersion,
    shared,
    collectionMode,
  } = await db.transaction(async (tx) => {
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
    // Fixed on the quote: every later step reads this, never the profile's mode then.
    const collectionMode = input.youCollectOn
      ? await decideCollectionMode(tx, {
          profileId: profile.id,
          switchOn: true,
          provider: input.provider,
          environment: input.environment,
        })
      : await collectionModeOf(tx, profile.id);
    // You collect (Task 12, spec §2.1 step 7, P31): a collect page takes no tip that would take
    // what is held, with its other open quotes, past the holding cap, until the recipient is
    // verified. A direct page is never asked. No reason is given (§2.2).
    if (collectionMode === 'collect')
      await refuseOverHoldingCap(tx, {
        profileId: profile.id,
        now: input.now ?? new Date(),
        addMinor: chosen.recipientNetMinor,
      });
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
      collectionMode,
      expiresAt,
    });
    return {
      waivedPlatformFeeMinor: waived,
      finalBreakdown: chosen,
      feePolicyVersion: version,
      shared,
      collectionMode,
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
    collectionMode,
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
  /** You collect: the mode the quote was made under, which the checkout follows. */
  collectionMode: CollectionMode;
} | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        profileId: tipQuotes.profileId,
        payerTotalMinor: tipQuotes.payerTotalMinor,
        platformFeeMinor: tipQuotes.platformFeeMinor,
        providerFeeMinor: tipQuotes.providerFeeMinor,
        currency: tipQuotes.currency,
        collectionMode: tipQuotes.collectionMode,
      })
      .from(tipQuotes)
      .where(eq(tipQuotes.id, quoteId));
    return row
      ? {
          ...row,
          profileId: personOf(row.profileId),
          collectionMode:
            row.collectionMode === 'collect' ? 'collect' : 'direct',
        }
      : null;
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
