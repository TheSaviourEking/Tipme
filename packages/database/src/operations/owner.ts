import { OperationError } from './errors.js';

/**
 * Release 1's tip, payout and payment-account paths are about a person. Business release 2 adds
 * rows with no person (a team tip, whose people are in team_tip_splits; a business's own account,
 * destination or withdrawal), which only their own PRs (R2-B, R2-D) handle. Until then, a path
 * that meets one stops here rather than treat it as somebody's. No such row exists while the
 * release 2 flags are off.
 */
export function personOf(profileId: string | null): string {
  if (profileId === null) throw new OperationError('NOT_A_PERSON');
  return profileId;
}

/**
 * Whose money a payout, a payment account or a payout destination is (business release 2, R2-B):
 * a person's page, or a business's own balance (its `business_payable`). Exactly one; the
 * database's `*_owner` checks refuse a row with both or neither.
 */
export type MoneyOwner = { profileId: string } | { businessId: string };

/** The owner of a row with both nullable columns. Neither is a broken row, never a guess. */
export function ownerOf(row: {
  profileId: string | null;
  businessId: string | null;
}): MoneyOwner {
  if (row.profileId !== null && row.businessId === null)
    return { profileId: row.profileId };
  if (row.businessId !== null && row.profileId === null)
    return { businessId: row.businessId };
  throw new OperationError('NOT_A_PERSON');
}

/** The columns to write for an owner: one set, the other null. */
export const ownerColumns = (owner: MoneyOwner) =>
  'businessId' in owner
    ? { profileId: null, businessId: owner.businessId }
    : { profileId: owner.profileId, businessId: null };
