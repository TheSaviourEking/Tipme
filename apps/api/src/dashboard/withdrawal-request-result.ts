import type { WithdrawalRequestResult } from '@tipme/contracts';
import type { RequestResult } from '@tipme/database';

/**
 * A withdrawal request's answer for the person or a business: its payouts in order, amounts as
 * strings. The parts carry no provider, so the answer never names one.
 */
export function withdrawalRequestResult(
  result: RequestResult,
): WithdrawalRequestResult {
  return {
    payoutId: result.payoutId,
    status: result.status,
    groupId: result.groupId,
    parts: result.parts.map((part) => ({
      payoutId: part.payoutId,
      amountMinor: part.amountMinor.toString(),
      status: part.status,
    })),
  };
}
