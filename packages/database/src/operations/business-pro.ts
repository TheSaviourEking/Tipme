import type { BusinessPlan } from '@tipme/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { businesses, proPeriods, proPurchases } from '../schema.js';
import { OperationError } from './errors.js';
import { currentProPrice, type ProPriceRow } from './pro-price.js';
import { type ProPurchaseView, view } from './pro-purchases.js';

/*
 * Business Pro (owner, 14 Nov 2026; plan Task A3): a business's own plan, reusing personal Pro's
 * months, purchases and prices with the business as their subject. `businesses.plan` is a cache of
 * the paid months (recomputeBusinessPlan); a business's Pro never makes its owners' pages Pro.
 */

export interface BusinessPeriodView {
  startsAt: Date;
  endsAt: Date;
  graceEndsAt: Date;
  paidBy: string;
}

/** Everything the business's Plan section reads, at `now`. */
export async function businessProState(
  db: Database | Tx,
  businessId: string,
  now: Date = new Date(),
): Promise<{
  plan: BusinessPlan;
  current: BusinessPeriodView | null;
  next: BusinessPeriodView | null;
  openPurchase: ProPurchaseView | null;
  price: ProPriceRow | null;
  lapsedAt: Date | null;
}> {
  const [business] = await db
    .select({ plan: businesses.plan, proLapsedAt: businesses.proLapsedAt })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!business) throw new OperationError('BUSINESS_NOT_FOUND');
  const periods = await db
    .select()
    .from(proPeriods)
    .where(eq(proPeriods.businessId, businessId))
    .orderBy(asc(proPeriods.startsAt));
  const asView = (row: (typeof periods)[number]): BusinessPeriodView => ({
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    graceEndsAt: row.graceEndsAt,
    paidBy: row.paidBy,
  });
  const current =
    periods.find((row) => row.startsAt <= now && now < row.graceEndsAt) ?? null;
  const next = periods.find((row) => row.status === 'SCHEDULED') ?? null;
  const [open] = await db
    .select()
    .from(proPurchases)
    .where(
      and(
        eq(proPurchases.businessId, businessId),
        inArray(proPurchases.status, ['PENDING', 'COLLECTING', 'UNKNOWN']),
      ),
    );
  return {
    plan: business.plan === 'pro' ? 'pro' : 'free',
    current: current ? asView(current) : null,
    next: next ? asView(next) : null,
    openPurchase: open ? view(open) : null,
    price: await currentProPrice(db, now, 'business'),
    lapsedAt: business.proLapsedAt,
  };
}
