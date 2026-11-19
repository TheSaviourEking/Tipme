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
/** A You collect scenario's one answer, by the key it was set for (markCollectAnswer). */
export const collectAnswerKey = (prefix: string, key: string) =>
  `mockprovider:${prefix}:collect-answer:${key}`;
/** One You collect transfer, by its idempotency key (= its transfer_group). */
export const collectTransferKey = (prefix: string, key: string) =>
  `mockprovider:${prefix}:collect-transfer:${key}`;
/** The keys of every You collect transfer to one account, oldest first. */
export const accountTransfersKey = (prefix: string, accountRef: string) =>
  `mockprovider:${prefix}:account-transfers:${accountRef}`;
/** A pretend destination's review status (usable unless set). */
export const destinationKey = (prefix: string, destinationRef: string) =>
  `mockprovider:${prefix}:destination:${destinationRef}`;
/** TipMe's pretend balances, as set by markPlatformBalances. */
export const platformBalancesKey = (prefix: string) =>
  `mockprovider:${prefix}:platform-balances`;
