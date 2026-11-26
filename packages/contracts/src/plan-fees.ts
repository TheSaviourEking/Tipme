import { z } from 'zod';
import { opsReasonSchema } from './ops.js';

/**
 * TipMe's share of each tip per plan (owner, 18 Nov 2026): an admin setting, Free 5% and Pro 3% to
 * start, payment and withdrawal fees included. Rates are whole basis points sent as strings of
 * digits; the server is the only source of them.
 */

/** Bounds for each rate, in basis points (owner, 18 Nov 2026: 1.5% to 10%). */
export const PLAN_FEE_MIN_BPS = 150;
export const PLAN_FEE_MAX_BPS = 1000;
/** A move of more than this, on either plan, needs an explicit confirm (`confirmLargeChange`). */
export const PLAN_FEE_LARGE_CHANGE_BPS = 200;

const bps = z
  .string()
  .regex(/^[1-9][0-9]{0,3}$/)
  .refine(
    (value) =>
      Number(value) >= PLAN_FEE_MIN_BPS && Number(value) <= PLAN_FEE_MAX_BPS,
  );

/** `GET /v1/plan-fees`, for anyone: the rates new quotes use now. Copy reads these. */
export interface PublicPlanFees {
  freeBps: number;
  proBps: number;
}

/** One stored pair, for staff. */
export interface OpsPlanFeesRow {
  id: string;
  freeBps: number;
  proBps: number;
  effectiveFrom: string;
  /** Null for the starting rates, which a migration set. */
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  createdAt: string;
}

/**
 * `GET /v1/ops/plan-fees`: the rates in force (from the setting, or the coded defaults when none is
 * stored), their history, and a change waiting for a second person, if any. Business tips use the
 * staff member's own plan rate; who pays a business's withdrawal fee is a fee waiver rule (spec
 * 2026-11-23 §5), which replaced the `business_payout_fee_absorbed` switch.
 */
export interface OpsPlanFees {
  current: {
    freeBps: number;
    proBps: number;
    source: 'setting' | 'default';
    effectiveFrom: string | null;
  };
  history: OpsPlanFeesRow[];
  limits: { minBps: number; maxBps: number };
  waitingRequestId: string | null;
}

/**
 * `POST /v1/ops/plan-fees`: new rates for new quotes, with a reason. Pro may not be above Free. A
 * move of more than 200 bps on either plan from the rate in force is refused unless the request
 * carries `confirmLargeChange: true` (the ops screen asks the person to confirm).
 */
export const opsPlanFeesChangeSchema = opsReasonSchema
  .extend({
    freeBps: bps,
    proBps: bps,
    confirmLargeChange: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => Number(value.proBps) <= Number(value.freeBps), {
    message: 'Pro’s rate may not be above Free’s',
    path: ['proBps'],
  });
export type OpsPlanFeesChangeRequest = z.infer<typeof opsPlanFeesChangeSchema>;
