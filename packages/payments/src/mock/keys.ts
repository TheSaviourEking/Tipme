/** Redis layout for the mock provider's pretend ledger (namespaced; disposable). */
export const paymentKey = (prefix: string, reference: string) =>
  `mockprovider:${prefix}:payment:${reference}`;
export const payoutKey = (prefix: string, reference: string) =>
  `mockprovider:${prefix}:payout:${reference}`;
