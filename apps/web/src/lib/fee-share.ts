import { FEE_POLICY_V1 } from '@tipme/domain';

/** TipMe's share of each tip, as a percentage (10), from the fee policy. */
export const TIPME_SHARE_PERCENT = Number(FEE_POLICY_V1.tipmeShareBps) / 100;
