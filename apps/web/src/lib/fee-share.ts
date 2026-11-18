import {
  DEFAULT_PLAN_FEE_RATES,
  FREE_WITHDRAWALS_PER_DAY,
} from '@tipme/domain';

/**
 * Owner, 18 Nov 2026: the first withdrawals of each Lagos day are free; from the next one the partner's
 * transfer fee comes off the amount. The number is FREE_WITHDRAWALS_PER_DAY (domain), written once.
 */
export const FREE_WITHDRAWALS_COPY = `The first ${FREE_WITHDRAWALS_PER_DAY} withdrawals each day are free.`;

/**
 * TipMe's share per plan as percentages (owner, 18 Nov 2026: Free 5%, Pro 3%, payment and withdrawal
 * fees included). The rates are an admin setting: copy that can read it uses getPlanFees() (server) or
 * usePlanFees() (client). These coded defaults are for text that must stay fixed, such as the Terms,
 * and for the moment before the live rates are read.
 */
export const FREE_SHARE_PERCENT = Number(DEFAULT_PLAN_FEE_RATES.freeBps) / 100;
export const PRO_SHARE_PERCENT = Number(DEFAULT_PLAN_FEE_RATES.proBps) / 100;

/** The live rates as percentages, for copy. */
export interface PlanFeePercents {
  freePercent: number;
  proPercent: number;
}

export const DEFAULT_PLAN_FEE_PERCENTS: PlanFeePercents = {
  freePercent: FREE_SHARE_PERCENT,
  proPercent: PRO_SHARE_PERCENT,
};

const isBps = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 10000;

/**
 * The percentages in a `GET /v1/plan-fees` answer (`{ freeBps, proBps }`), or null when it isn't one.
 * Display only: basis points over 100 (450 → 4.5), never used to price anything.
 */
export function planFeePercentsOf(data: unknown): PlanFeePercents | null {
  if (typeof data !== 'object' || data === null) return null;
  const { freeBps, proBps } = data as Record<string, unknown>;
  if (!isBps(freeBps) || !isBps(proBps) || proBps > freeBps) return null;
  return { freePercent: freeBps / 100, proPercent: proBps / 100 };
}
