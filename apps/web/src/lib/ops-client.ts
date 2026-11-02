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

/** The provider test link, and where its token waits while staff sign in. */
export const PROVIDER_TEST_CONFIRM_PATH = '/ops/providers/confirm';
export const PROVIDER_TEST_TOKEN_KEY = 'tipme.provider-test-token';

/** How staff say a money issue was settled. TipMe changes no balance by it. */
export const ISSUE_OUTCOME_CHOICES: Record<string, string> = {
  resolved_by_provider: 'Settled by the provider',
  recipient_owes: 'The recipient owes the money',
  written_off: 'Written off by TipMe',
  account_secured: 'The real owner has the account back',
};
/** Every outcome that can be shown. The last is only ever stated by the mark-failed tool. */
export const ISSUE_OUTCOME_LABELS: Record<string, string> = {
  ...ISSUE_OUTCOME_CHOICES,
  staff_confirmed_absent: 'Staff confirmed the provider has no such payout',
};

export const ISSUE_KIND_LABELS: Record<string, string> = {
  payment_mismatch: 'Amount mismatch',
  payment_conflict: 'Payment after the tip ended',
  payment_unresolved: 'Payment unknown to the provider',
  payment_attempt_unresolved: 'Bachs checkout outcome unknown',
  payment_account_unresolved: 'Bachs recipient account outcome unknown',
  payment_account_setup_failed: 'Manual payouts not set',
  payment_reversed: 'Refund or dispute reported',
  payment_settlement_currency: 'Settled in another currency',
  payout_failed: 'Withdrawal failed',
  payout_conflict: 'Withdrawal conflict',
  payout_unexpected: 'Unexpected payout',
  payout_unresolved: 'Withdrawal outcome unknown',
  payout_fee_short: 'Payout fee above what was covered',
  payout_held: 'Withdrawal waiting on a hold',
  account_takeover_reported: 'Reported account takeover',
  staff_acted_alone: 'Serious action without a second person',
  staff_approval_pending: 'Serious action waiting for approval',
  staff_last_approver_removed: 'Last second person removed',
  provider_in_debt: 'Provider account in debt',
  reserve_empty: 'Payment reserve empty',
  provider_key_refused: 'Provider refused our key',
  provider_event_conflict: 'Conflicting provider event',
  stuck_tip: 'Tip stuck confirming',
  unmatched_event: 'Unmatched provider event',
  pending_recovery: 'Pending phone recovery',
  message_reported: 'Reported message',
  profile_reported: 'Reported page',
};
export const SEVERITY_LABELS: Record<string, string> = {
  money: 'Money',
  account: 'Account',
  info: 'Info',
};

/** An emailed enrolment link: `/ops#enrol=<code>`. The fragment never reaches a server or a log. */
export const ENROL_LINK_PREFIX = '#enrol=';
export const ENROL_LINK_KEY = 'tipme.enrol-link';

/** Takes an enrolment code out of the address bar and this tab's storage, whatever happened next. */
export function clearEnrolLink(): void {
  if (location.hash.startsWith(ENROL_LINK_PREFIX))
    history.replaceState(null, '', location.pathname + location.search);
  try {
    sessionStorage.removeItem(ENROL_LINK_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}
