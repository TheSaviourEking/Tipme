import {
  DEFAULT_PLAN_FEE_RATES,
  planFeeRatesProblem,
  type PlanFeeRates,
} from '@tipme/domain';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { approvalRequests, planFeeRates } from '../schema.js';
import { recordAudit } from './audit.js';
import { OperationError } from './errors.js';
import { newId } from './ids.js';
import { withAuditChange } from './staff.js';

/*
 * TipMe's share per plan as an admin setting (owner, 18 Nov 2026), exactly like the Pro price
 * (pro-price.ts): append-only history, the latest row whose `effective_from` has passed is in force,
 * a change is the serious action `plan_fees.change` (a second person approves), audited with from,
 * to and approver. Read on every quote, never cached, so a change applies to the next quote and a
 * quote already shown keeps the fee it recorded.
 */

export const PLAN_FEES_CHANGE_ACTION = 'plan_fees.change';

export interface PlanFeeRateRow {
  id: string;
  freeBps: number;
  proBps: number;
  effectiveFrom: Date;
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  createdAt: Date;
}

/** The rates new quotes use now, and whether they come from the setting or the coded defaults. */
export interface PlanFeeRatesInForce extends PlanFeeRates {
  source: 'setting' | 'default';
  row: PlanFeeRateRow | null;
}

/** The latest stored rates whose `effective_from` has passed; null when none was ever stored. */
export async function currentPlanFeeRates(
  db: Database | Tx,
  now: Date = new Date(),
): Promise<PlanFeeRateRow | null> {
  const [row] = await db
    .select()
    .from(planFeeRates)
    .where(lte(planFeeRates.effectiveFrom, now))
    .orderBy(desc(planFeeRates.effectiveFrom), desc(planFeeRates.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * What a new quote uses: the stored rates, or the coded defaults (Free 5%, Pro 3%) when none is
 * stored. The table's own checks keep a stored pair in bounds; a pair that somehow isn't falls back
 * too, so a quote is never priced from a bad row.
 */
export async function planFeeRatesInForce(
  db: Database | Tx,
  now: Date = new Date(),
): Promise<PlanFeeRatesInForce> {
  const row = await currentPlanFeeRates(db, now);
  if (row) {
    const rates = { freeBps: BigInt(row.freeBps), proBps: BigInt(row.proBps) };
    if (planFeeRatesProblem(rates) === null)
      return { ...rates, source: 'setting', row };
  }
  return { ...DEFAULT_PLAN_FEE_RATES, source: 'default', row: null };
}

/** Every stored pair, newest first, for staff. */
export function planFeeRateHistory(
  db: Database | Tx,
  limit = 50,
): Promise<PlanFeeRateRow[]> {
  return db
    .select()
    .from(planFeeRates)
    .orderBy(desc(planFeeRates.effectiveFrom), desc(planFeeRates.createdAt))
    .limit(limit);
}

/** "5%", "4.5%": basis points as staff read them in summaries. */
export const percentOf = (bps: bigint | number): string => {
  const value = Number(bps);
  const frac = String(value % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${Math.floor(value / 100)}${frac ? `.${frac}` : ''}%`;
};

/** A move of more than this many bps on either plan needs an explicit confirm (owner, 18 Nov 2026). */
export const PLAN_FEE_LARGE_CHANGE_BPS = 200n;

/** True when either plan's rate moves by more than 200 bps (up or down) from the rate in force. */
export function isLargePlanFeeChange(from: PlanFeeRates, to: PlanFeeRates) {
  const moved = (a: bigint, b: bigint) =>
    (a > b ? a - b : b - a) > PLAN_FEE_LARGE_CHANGE_BPS;
  return moved(from.freeBps, to.freeBps) || moved(from.proBps, to.proBps);
}

/** Refuses a big move that was not explicitly confirmed (`confirmLargeChange: true` in the request). */
export function requirePlanFeeConfirm(
  from: PlanFeeRates,
  to: PlanFeeRates,
  confirmed: unknown,
): void {
  if (isLargePlanFeeChange(from, to) && confirmed !== true)
    throw new OperationError('PLAN_FEES_CONFIRM_REQUIRED');
}

/** Parses the serious action's payload: whole basis points as digit strings, an allowed pair. */
export function checkedPlanFeeRates(payload: {
  freeBps: unknown;
  proBps: unknown;
}): PlanFeeRates {
  const digits = (value: unknown) =>
    typeof value === 'string' && /^(0|[1-9][0-9]{0,4})$/.test(value);
  if (!digits(payload.freeBps) || !digits(payload.proBps))
    throw new OperationError('INVALID_INPUT');
  const rates = {
    freeBps: BigInt(payload.freeBps as string),
    proBps: BigInt(payload.proBps as string),
  };
  if (planFeeRatesProblem(rates) !== null)
    throw new OperationError('INVALID_INPUT');
  return rates;
}

/**
 * Stores new rates from now, for new quotes only. Runs inside the serious action, so `approvedBy` is
 * the second person (or null when a lone admin acted alone, with the acted-alone alert). Refuses a
 * pair out of bounds, Pro above Free, the pair already in force, or a move of more than 200 bps
 * that was not confirmed.
 */
export async function setPlanFeeRates(
  tx: Tx,
  input: {
    freeBps: bigint;
    proBps: bigint;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
    /** The explicit confirm for a move of more than 200 bps on either plan. */
    confirmedLargeChange?: boolean;
  },
): Promise<{ id: string; freeBps: bigint; proBps: bigint }> {
  const rates = { freeBps: input.freeBps, proBps: input.proBps };
  if (planFeeRatesProblem(rates) !== null)
    throw new OperationError('INVALID_INPUT');
  const previous = await planFeeRatesInForce(tx, input.now);
  if (previous.freeBps === rates.freeBps && previous.proBps === rates.proBps)
    throw new OperationError('INVALID_INPUT');
  requirePlanFeeConfirm(previous, rates, input.confirmedLargeChange);
  const id = newId();
  await tx.insert(planFeeRates).values({
    id,
    freeBps: Number(rates.freeBps),
    proBps: Number(rates.proBps),
    effectiveFrom: input.now,
    setBy: input.staffUserId,
    approvedBy: input.approvedBy,
    reason: input.reason,
    createdAt: input.now,
  });
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: 'plan_fees.changed',
    permission: 'fees.manage',
    subjectType: 'plan_fee_rates',
    subjectId: id,
    reason: withAuditChange(input.reason, {
      from: {
        freeBps: String(previous.freeBps),
        proBps: String(previous.proBps),
      },
      to: { freeBps: String(rates.freeBps), proBps: String(rates.proBps) },
      approvedBy: input.approvedBy,
    }),
    now: input.now,
  });
  return { id, ...rates };
}

/** A rate change still waiting for a second person, so the screen says so. */
export async function waitingPlanFeesRequest(
  db: Database | Tx,
): Promise<string | null> {
  const [row] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.action, PLAN_FEES_CHANGE_ACTION),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  return row?.id ?? null;
}
