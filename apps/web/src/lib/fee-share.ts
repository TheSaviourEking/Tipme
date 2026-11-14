import { FEE_POLICY_V2_FREE, FEE_POLICY_V2_PRO } from '@tipme/domain';

/** TipMe's share of each tip on the Free plan, as a percentage (7), from the fee policy. */
export const FREE_SHARE_PERCENT =
  Number(FEE_POLICY_V2_FREE.tipmeShareBps) / 100;
/** TipMe's share of each tip on Pro, as a percentage (5), from the fee policy. */
export const PRO_SHARE_PERCENT = Number(FEE_POLICY_V2_PRO.tipmeShareBps) / 100;
