/**
 * Surprise moments and rewards (PR-008). Pretend money only until D-05 and legal review.
 * TipMe gives back at most half of the fees a recipient has earned it, over their lifetime:
 * cash bonuses plus waived fees together. All values here are the single place to tune them.
 */
export type MilestoneReward =
  'none' | 'cash' | { feeFree: number } | { cash: true; feeFree: number };

export const REWARDS = {
  /** A cash bonus is this share of the platform fees since the previous cash bonus. */
  cashShareBps: 5000n,
  /** Lifetime: cash bonuses + waived fees ≤ this share of the platform fees earned. */
  lifetimeCapBps: 5000n,
  /** Fee-free tips given when a cash bonus cannot be paid (no budget, or the cap reached). */
  fallbackFeeFree: 5,
  milestones: [
    { count: 1, reward: 'none' },
    { count: 10, reward: { feeFree: 5 } },
    { count: 50, reward: 'cash' },
    { count: 100, reward: { cash: true, feeFree: 10 } },
  ] as readonly { count: number; reward: MilestoneReward }[],
  bestPeriod: { minPriorWeeks: 4, minPriorMonths: 2, minTipsInPeriod: 5 },
  bestWeek: 'none' as MilestoneReward,
  bestMonth: 'cash' as MilestoneReward,
  /** A shared moment shows on the public page for this long. */
  publicWindowDays: 14,
} as const;

const min = (...values: bigint[]) => values.reduce((a, b) => (b < a ? b : a));

/** The cash bonus for a moment, never negative, never past the lifetime cap or the budget. */
export function cashBonusAmount(input: {
  feesSinceLastCashMinor: bigint;
  lifetimeFeesMinor: bigint;
  lifetimeRewardCostMinor: bigint;
  budgetRemainingMinor: bigint;
  /** Room kept for fee-free tips granted with the same reward, so they can really be used. */
  reserveMinor?: bigint;
}): bigint {
  const share = (input.feesSinceLastCashMinor * REWARDS.cashShareBps) / 10000n;
  const room =
    (input.lifetimeFeesMinor * REWARDS.lifetimeCapBps) / 10000n -
    input.lifetimeRewardCostMinor -
    (input.reserveMinor ?? 0n);
  const amount = min(share, room, input.budgetRemainingMinor);
  return amount > 0n ? amount : 0n;
}

/** Whether this tip may be fee-free: a credit is left and waiving its fee keeps within the cap. */
export function feeFreeAllowed(input: {
  credits: number;
  waivedFeeMinor: bigint;
  lifetimeFeesMinor: bigint;
  lifetimeRewardCostMinor: bigint;
}): boolean {
  return (
    input.credits > 0 &&
    (input.lifetimeRewardCostMinor + input.waivedFeeMinor) * 10000n <=
      input.lifetimeFeesMinor * REWARDS.lifetimeCapBps
  );
}
