import type { OpsApproval } from '@tipme/contracts';

/**
 * Waiting requests this person could decide now, for the count on the menu's Approvals link. Their
 * own requests never count. Null when the list couldn't be read: no count is better than a wrong 0.
 */
export function decidableCount(
  rows: readonly Pick<OpsApproval, 'mine' | 'canDecide'>[] | null,
): number | null {
  if (!rows) return null;
  return rows.filter((row) => row.canDecide && !row.mine).length;
}
