'use client';
import { createContext, useContext } from 'react';

/** The signed-in staff member's role and permissions (the server checks them on every call). */
export interface OpsAccess {
  role: string;
  permissions: string[];
}
export const OpsAccessContext = createContext<OpsAccess | null>(null);

export function useOpsAccess(): OpsAccess {
  const access = useContext(OpsAccessContext);
  if (!access) throw new Error('useOpsAccess outside the admin area');
  return access;
}
export const can = (access: OpsAccess, permission: string) =>
  access.permissions.includes(permission);

/** "3 min ago", "2 h ago", "4 days ago": how long an issue has been waiting. */
export function age(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const dateTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
});
/** Lagos time, as staff read it. */
export const when = (iso: string) => dateTime.format(new Date(iso));

export const ISSUE_KIND_LABELS: Record<string, string> = {
  payment_mismatch: 'Amount mismatch',
  payment_conflict: 'Payment after the tip ended',
  payment_unresolved: 'Payment unknown to the provider',
  payout_failed: 'Withdrawal failed',
  payout_conflict: 'Withdrawal paid after failing',
  provider_event_conflict: 'Conflicting provider event',
  stuck_tip: 'Tip stuck confirming',
  unmatched_event: 'Unmatched provider event',
  pending_recovery: 'Pending phone recovery',
};
export const SEVERITY_LABELS: Record<string, string> = {
  money: 'Money',
  account: 'Account',
  info: 'Info',
};
