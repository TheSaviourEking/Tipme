import type { WithdrawalBank } from '@tipme/contracts';

/**
 * Where a withdrawal went, as recorded when it was requested. Nothing when the API has no bank
 * for it: never the bank the recipient has now.
 */
export const bankLine = (bank: WithdrawalBank | null): string | null =>
  bank ? `to ${bank.bankName} ••${bank.last4}` : null;
