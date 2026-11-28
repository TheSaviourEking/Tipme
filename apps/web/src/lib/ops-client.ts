'use client';
import { createContext, useContext } from 'react';
import {
  OPS_ISSUE_OUTCOME_WORDS,
  type OpsAccountFeeWaivers,
  type OpsFeeWaivers,
  type OpsFeeWaiverSetRequest,
} from '@tipme/contracts';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

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

/** "just now", "3 min ago", "2 h ago", "4 days ago": how long an issue has been waiting. */
export function age(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
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

/** A staff member as the money screens name them: the end of their id ("staff …a1b2c3"). */
export const staffWord = (id: string | null) =>
  id ? `staff …${id.slice(-6)}` : '';

// Who pays the fees (spec 2026-11-23 §6): the four calls. Reads need `fees.manage`; a change is
// the serious action `fee_waiver.set`, so it may wait for a second person.
const FEE_WAIVERS = '/v1/ops/fee-waivers';
export const loadFeeWaivers = () => opsFetch<OpsFeeWaivers>(FEE_WAIVERS);
export const loadPageFeeWaivers = (profileId: string) =>
  opsFetch<OpsAccountFeeWaivers>(
    `${FEE_WAIVERS}/profiles/${encodeURIComponent(profileId)}`,
  );
export const loadBusinessFeeWaivers = (businessId: string) =>
  opsFetch<OpsAccountFeeWaivers>(
    `${FEE_WAIVERS}/businesses/${encodeURIComponent(businessId)}`,
  );
/** Dates go as UTC `Z` strings (`toISOString()`); the API takes no offset. */
export const setFeeWaiver = (body: OpsFeeWaiverSetRequest) =>
  opsAct<OpsFeeWaivers>(FEE_WAIVERS, { method: 'POST', body });

/** The provider test link, and where its token waits while staff sign in. */
export const PROVIDER_TEST_CONFIRM_PATH = '/ops/providers/confirm';
export const PROVIDER_TEST_TOKEN_KEY = 'tipme.provider-test-token';

/** How staff say a money issue was settled. TipMe changes no balance by it. */
export const ISSUE_OUTCOME_CHOICES: Record<string, string> = {
  resolved_by_provider: OPS_ISSUE_OUTCOME_WORDS.resolved_by_provider,
  recipient_owes: OPS_ISSUE_OUTCOME_WORDS.recipient_owes,
  written_off: OPS_ISSUE_OUTCOME_WORDS.written_off,
  account_secured: OPS_ISSUE_OUTCOME_WORDS.account_secured,
};
/** Every outcome that can be shown. The last is only ever stated by the mark-failed tool. */
export const ISSUE_OUTCOME_LABELS: Record<string, string> = {
  ...OPS_ISSUE_OUTCOME_WORDS,
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
  payout_fee_adjusted: 'Payout fee differed; settled on the balance',
  payout_held: 'Withdrawal waiting on a hold',
  account_takeover_reported: 'Reported account takeover',
  staff_acted_alone: 'Serious action without a second person',
  staff_approval_pending: 'Serious action waiting for approval',
  staff_last_approver_removed: 'Last second person removed',
  username_take_back_unnoticed: 'Take-back notice not reached',
  username_take_back_overdue: 'Take-back past its deadline',
  business_waiting: 'Business waiting to be verified',
  business_note_reported: 'Note about business staff reported',
  share_report: 'Business reported over a share',
  balance_below_zero: 'Balance below zero after a reversal',
  pro_amount_mismatch: 'A Pro payment doesn’t match its purchase',
  pro_late_payment: 'A Pro payment arrived after its checkout ended',
  pro_conflict: 'A Pro payment’s status contradicts itself',
  pro_reversed: 'A refund or dispute on a Pro payment',
  support_request: 'Support request',
  pro_collect_unknown: 'A Pro payment from the balance is unconfirmed',
  pro_refund_failed: 'A Pro refund failed at the partner',
  share_transfer_stuck: 'A business share movement needs checking',
  tip_refund_failed: 'A tip refund didn’t happen at the partner',
  collect_transfer_stuck: 'Held money not transferring',
  collect_transfer_review: 'A held-money transfer needs checking',
  collect_in_debt: 'TipMe’s own account in debt',
  collect_invariant_broken: 'Held money not covered',
  collect_reserve_low: 'TipMe’s own money low',
  collect_auto_payout_on: 'Automatic payouts on for TipMe',
  collect_recon_mismatch: 'Held-money records don’t match',
  collect_same_bank: 'Bank account shared by two recipients',
  dispute_opened: 'Dispute opened on a collected tip',
  dispute_deadline: 'Dispute deadline near',
  dispute_fee_unposted: 'Dispute fee not booked',
  collect_refund_gap: 'Refund on a collected tip fell short',
  collect_own_money_wait: 'Waiting on TipMe’s own money',
  provider_split_short: 'Providers hold less than owed',
  provider_unconnected_money: 'Money at a disconnected provider',
  fee_waiver_ending: 'A fee waiver ends within a day',
  fee_waivers_paused: 'Fee waivers paused (low balance)',
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
/** Split accounts (spec §7): a daily check's result, in staff words. */
export const SPLIT_OUTCOME_LABELS: Record<string, string> = {
  ok: 'Matches',
  short: 'Short',
  over: 'Providers hold more',
  partial: 'A read failed',
};
/** A payment provider's role (spec §4). Staff screens may name providers; users never see this. */
export const PROVIDER_ROLE_LABELS: Record<string, string> = {
  active: 'Active',
  withdraw_only: 'Withdraw-only',
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
