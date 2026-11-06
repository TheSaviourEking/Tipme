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
