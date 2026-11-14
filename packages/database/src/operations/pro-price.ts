import { isAllowedProPrice } from '@tipme/contracts';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { approvalRequests, PRO_PRICE_PLANS, proPrices } from '../schema.js';
import { recordAudit } from './audit.js';
import { OperationError } from './errors.js';
import { newId } from './ids.js';
import { withAuditChange } from './staff.js';

/** Paid Pro (ADR-0015): the price lives here, never in the web app or mail. */
export interface ProPriceRow {
  id: string;
  amountMinor: bigint;
  currency: 'NGN';
  effectiveFrom: Date;
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  /** Which Pro the price is for (Business Pro, plan Task A3). */
  plan: ProPricePlan;
  createdAt: Date;
}

/** A person's page Pro, or Business Pro. */
export type ProPricePlan = (typeof PRO_PRICE_PLANS)[number];

const asRow = (row: typeof proPrices.$inferSelect): ProPriceRow => ({
  ...row,
  // The table only holds NGN (pro_prices_currency_ngn) and these plans (pro_prices_plan).
  currency: 'NGN',
  plan: row.plan as ProPricePlan,
});

/**
 * The latest price for `plan` whose `effective_from` has passed; null only if none was ever set.
 * Personal and business prices move separately.
 */
export async function currentProPrice(
  db: Database | Tx,
  now: Date = new Date(),
  plan: ProPricePlan = 'personal',
): Promise<ProPriceRow | null> {
  const [row] = await db
    .select()
    .from(proPrices)
    .where(and(lte(proPrices.effectiveFrom, now), eq(proPrices.plan, plan)))
    .orderBy(desc(proPrices.effectiveFrom), desc(proPrices.createdAt))
    .limit(1);
  return row ? asRow(row) : null;
}

/** Every price for one plan, newest first, for staff. */
export async function proPriceHistory(
  db: Database | Tx,
  limit = 50,
  plan: ProPricePlan = 'personal',
): Promise<ProPriceRow[]> {
  const rows = await db
    .select()
    .from(proPrices)
    .where(eq(proPrices.plan, plan))
    .orderBy(desc(proPrices.effectiveFrom), desc(proPrices.createdAt))
    .limit(limit);
  return rows.map(asRow);
}

/** "₦2,500": whole naira, for staff summaries. */
export const nairaOf = (amountMinor: bigint): string =>
  `₦${(amountMinor / 100n).toLocaleString('en-NG')}`;

/** Parses the serious action's payload: digits only, an allowed price. */
export function checkedProPrice(amountMinor: unknown): bigint {
  if (
    typeof amountMinor !== 'string' ||
    !/^[1-9][0-9]{0,11}$/.test(amountMinor)
  )
    throw new OperationError('INVALID_INPUT');
  const amount = BigInt(amountMinor);
  if (!isAllowedProPrice(amount)) throw new OperationError('INVALID_INPUT');
  return amount;
}

/**
 * Sets a new price from now, for new months only (purchases keep their own). Runs inside the
 * serious action, so `approvedBy` is the second person, or null when they acted alone.
 */
export async function setProPrice(
  tx: Tx,
  input: {
    amountMinor: bigint;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
    /** Business Pro's price (plan Task A3); personal when left out. */
    plan?: ProPricePlan;
  },
): Promise<{ id: string; amountMinor: bigint; previousMinor: bigint | null }> {
  const plan = input.plan ?? 'personal';
  if (!isAllowedProPrice(input.amountMinor))
    throw new OperationError('INVALID_INPUT');
  const previous = await currentProPrice(tx, input.now, plan);
  if (previous?.amountMinor === input.amountMinor)
    throw new OperationError('INVALID_INPUT');
  const id = newId();
  await tx.insert(proPrices).values({
    id,
    amountMinor: input.amountMinor,
    currency: 'NGN',
    effectiveFrom: input.now,
    setBy: input.staffUserId,
    approvedBy: input.approvedBy,
    reason: input.reason,
    plan,
    createdAt: input.now,
  });
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action:
      plan === 'business' ? 'business_pro.price_changed' : 'pro.price_changed',
    permission: 'pro.price',
    subjectType: 'pro_price',
    subjectId: id,
    reason: withAuditChange(input.reason, {
      from: previous ? String(previous.amountMinor) : null,
      to: String(input.amountMinor),
      approvedBy: input.approvedBy,
    }),
    now: input.now,
  });
  return {
    id,
    amountMinor: input.amountMinor,
    previousMinor: previous?.amountMinor ?? null,
  };
}

/** A price change still waiting for a second person, so the screen says so. */
export async function waitingProPriceRequest(
  db: Database | Tx,
  action: 'pro_price.change' | 'business_pro_price.change' = 'pro_price.change',
): Promise<string | null> {
  const [row] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.action, action),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  return row?.id ?? null;
}
