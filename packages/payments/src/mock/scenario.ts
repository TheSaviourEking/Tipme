export const SCENARIOS = [
  'succeed',
  'decline',
  'pending-then-succeed',
  'duplicate',
  'out-of-order',
  'wrong-amount',
  'no-reply',
  'forged',
  'payout-paid',
  'payout-failed',
  'payout-review',
  'payout-timeout',
  // You collect (plan Task 4): one answer each, set with markCollectAnswer, then the partner pays.
  'collect-insufficient',
  'collect-forbidden',
  'collect-in-debt',
  'collect-not-found',
  'collect-mismatch',
  'collect-no-reply',
  'destination-pending-review',
  'destination-rejected',
  'balance-usd-negative',
  'auto-payout-on',
] as const;

/** The You collect scenarios: answered by markCollectAnswer, never by the pretend checkout page. */
export type CollectScenario = Extract<
  Scenario,
  | `collect-${string}`
  | `destination-${string}`
  | 'balance-usd-negative'
  | 'auto-payout-on'
>;

export type Scenario = (typeof SCENARIOS)[number];
