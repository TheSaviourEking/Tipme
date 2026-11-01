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
] as const;

export type Scenario = (typeof SCENARIOS)[number];
