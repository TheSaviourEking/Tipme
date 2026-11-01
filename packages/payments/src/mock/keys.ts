/** Redis layout for the mock provider's pretend ledger (namespaced; disposable). */
export const paymentKey = (prefix: string, reference: string) =>
  `mockprovider:${prefix}:payment:${reference}`;
export const payoutKey = (prefix: string, reference: string) =>
  `mockprovider:${prefix}:payout:${reference}`;
/** Which payout a payout id started, as a provider finds it by its reference. */
export const payoutIdKey = (prefix: string, payoutId: string) =>
  `mockprovider:${prefix}:payout-id:${payoutId}`;
/** Which payment an attempt started (TipMe's attempt id is the merchant reference). */
export const attemptKey = (prefix: string, attemptId: string) =>
  `mockprovider:${prefix}:attempt:${attemptId}`;
