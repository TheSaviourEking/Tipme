/**
 * Business Pro (owner's decisions, 14 Nov 2026; plan 2026-11-14-business-pro-and-signup, Task A2).
 * Business Free has 3 staff and 1 location; Business Pro 25 of each, and above that "Talk to us".
 * Owners never count toward the staff limit. A limit only stops adding: it never removes or blocks
 * anyone already there, and never stops a tip.
 */
export type BusinessPlan = 'free' | 'pro';

export const BUSINESS_LIMITS = {
  free: { staff: 3, locations: 1 },
  pro: { staff: 25, locations: 25 },
} as const satisfies Record<BusinessPlan, { staff: number; locations: number }>;

/** A business's limits on its plan (a fresh object each call). */
export function businessLimits(plan: BusinessPlan): {
  staff: number;
  locations: number;
} {
  const { staff, locations } = BUSINESS_LIMITS[plan];
  return { staff, locations };
}

/** Open owners plus open owner invitations (ruling R3; enforced by Phase E). */
export const BUSINESS_OWNER_LIMIT = 3;
/** Approved display-name changes per rolling 365 days, Business Pro only (ruling R5; Phase C). */
export const BUSINESS_NAME_CHANGES_PER_YEAR = 3;
/** The renewal reminder goes this many days before a Business Pro month ends (Phase B). */
export const BUSINESS_PRO_REMINDER_DAYS = 7;
