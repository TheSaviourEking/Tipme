import { PLAN_FEE_MIN_BPS } from '@tipme/contracts';
import { cardFromNaira, type CardCostFigures } from './card-cost-view.ts';
import { bpsToPercent, percentToBps } from './fee-percent.ts';

/*
 * The 2% floor on the rates staff set (profit guards, Part 3, 26 Nov 2026): a plan rate or a page
 * rate is at least 2%, and a page may also be 0% (fee-free, a deliberate grant). Rates stored before
 * the floor (1 to 199 bps) stay and are flagged on the ops screens. Staff only; no React, so the
 * rules can be tested alone. The API checks everything again.
 */

/** The contracts' floor for plan rates (a test holds it equal to the page floor). */
export const RATE_FLOOR_BPS = PLAN_FEE_MIN_BPS;

/** "Below the 2% floor". */
export const BELOW_FLOOR = `Below the ${bpsToPercent(RATE_FLOOR_BPS)} floor`;

/** A plan rate under the floor (only a row stored before the floor can be). */
export const planRateBelowFloor = (bps: number): boolean =>
  bps < RATE_FLOOR_BPS;

/** A staff-set page rate under the floor: 0 (fee-free) and "none" (null) are allowed. */
export const pageRateBelowFloor = (bps: number | null): boolean =>
  bps !== null && bps > 0 && bps < RATE_FLOOR_BPS;

/**
 * Where card starts at this rate: "Card is offered on tips from ₦6,000." or "Card is not offered at
 * this rate." (the share never covers the card fee). Null when the card cost isn't known yet.
 */
export function rateCardLine(
  bps: number,
  cost: CardCostFigures | null,
): string | null {
  if (!cost) return null;
  const from = cardFromNaira(bps, cost);
  return from === null
    ? 'Card is not offered at this rate.'
    : `Card is offered on tips from ${from}.`;
}

/** The same, for a rate a person has typed as a percentage; null when it isn't an allowed rate yet. */
export function typedRateCardLine(
  raw: string,
  cost: CardCostFigures | null,
): string | null {
  const bps = percentToBps(raw);
  return bps === null || bps < RATE_FLOOR_BPS ? null : rateCardLine(bps, cost);
}
