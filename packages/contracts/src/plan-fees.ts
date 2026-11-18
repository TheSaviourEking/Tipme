import { z } from 'zod';
import { opsReasonSchema } from './ops.js';

/**
 * TipMe's share of each tip per plan (owner, 18 Nov 2026): an admin setting, Free 5% and Pro 3% to
 * start, payment and withdrawal fees included. Rates are whole basis points sent as strings of
 * digits; the server is the only source of them.
 */

/** Bounds for each rate, in basis points (0% to 100%). */
export const PLAN_FEE_MIN_BPS = 0;
export const PLAN_FEE_MAX_BPS = 10000;

const bps = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,4})$/)
  .refine((value) => Number(value) <= PLAN_FEE_MAX_BPS);

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
 * staff member's own plan rate; the business payout fee is the `business_payout_fee_absorbed`
 * switch, shown here for reading.
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
  business: { payoutFeeAbsorbed: boolean };
}

/** `POST /v1/ops/plan-fees`: new rates for new quotes, with a reason. Pro may not be above Free. */
export const opsPlanFeesChangeSchema = opsReasonSchema
  .extend({ freeBps: bps, proBps: bps })
  .strict()
  .refine((value) => Number(value.proBps) <= Number(value.freeBps), {
    message: 'Pro’s rate may not be above Free’s',
    path: ['proBps'],
  });
export type OpsPlanFeesChangeRequest = z.infer<typeof opsPlanFeesChangeSchema>;
