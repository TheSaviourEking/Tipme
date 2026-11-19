import { feePolicyForPlan, priceTip } from '@tipme/domain';
import type { PlanFeePercents } from './fee-share';

/** The example tip in the Terms' Fees section, and the one in its refund example. */
export const TERMS_EXAMPLE_TIP_MINOR = BigInt(500000);
export const TERMS_REFUND_TIP_MINOR = BigInt(1000000);

/**
 * The figures the Terms print, worked out by the same pricing the quotes use from the live rates
 * (display percentages go back to whole basis points: 4.5 -> 450). A change in admin changes the
 * percentages and the example nets together.
 */
export function termsFeeFigures(percents: PlanFeePercents) {
  const rates = {
    freeBps: BigInt(Math.round(percents.freePercent * 100)),
    proBps: BigInt(Math.round(percents.proPercent * 100)),
  };
  const free = feePolicyForPlan('free', rates);
  const pro = feePolicyForPlan('pro', rates);
  const net = (tip: bigint) => ({
    free: priceTip(tip, free).recipientNetMinor,
    pro: priceTip(tip, pro).recipientNetMinor,
  });
  return {
    freePercent: percents.freePercent,
    proPercent: percents.proPercent,
    exampleNet: net(TERMS_EXAMPLE_TIP_MINOR),
    refundBack: net(TERMS_REFUND_TIP_MINOR),
  };
}
