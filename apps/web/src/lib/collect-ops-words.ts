// You collect staff screens (Task 15): their words, in one place. Staff copy; no imports, so the
// words can be tested alone.

export const TRANSFER_STATUS_WORDS: Record<string, string> = {
  waiting: 'Waiting',
  ready: 'Ready to send',
  sent: 'Sent, answer due',
  unknown: 'Answer lost',
  review: 'In review',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

export const TRANSFER_KIND_WORDS: Record<string, string> = {
  share: 'To recipient',
  back: 'Back to TipMe',
  return: 'Returned to recipient',
};

/** Why a transfer is in review (P13). */
export const REVIEW_REASON_WORDS: Record<string, string> = {
  provider: 'the payment partner’s answer needs a person',
  staff: 'held by staff',
  same_bank: 'a shared bank account',
  dispute: 'an open dispute',
  refund: 'a refund',
};

export const DISPUTE_STATUS_WORDS: Record<string, string> = {
  open: 'Open',
  responded: 'Answered',
  won: 'Won',
  lost: 'Lost',
  closed: 'Closed, no ruling',
};

/** The evidence state from TipMe's own records (never guessed from the dispute's status). */
export const EVIDENCE_WORDS: Record<string, string> = {
  none: 'Not started',
  draft: 'Files added, not sent',
  sending: 'Approved, being submitted',
  submitted: 'Submitted',
  refused: 'Refused by the payment partner',
};

export const PAUSED_WORDS: Record<string, string> = {
  amount: 'Paused: holding cap amount reached',
  days: 'Paused: holding cap days passed',
};

/** The tabs of the You collect area, each shown to whoever can read it. */
export const COLLECT_TABS: { href: string; label: string; needs: string }[] = [
  { href: '/ops/collect', label: 'Overview', needs: 'collect.view' },
  { href: '/ops/collect/held', label: 'Held money', needs: 'collect.view' },
  { href: '/ops/collect/transfers', label: 'Transfers', needs: 'collect.view' },
  { href: '/ops/collect/disputes', label: 'Disputes', needs: 'collect.view' },
  { href: '/ops/collect/unclaimed', label: 'Unclaimed', needs: 'collect.view' },
  // TODO(Task 11 follow-up): the Reserve tab (/ops/collect/reserve) goes here once Task 11's
  // reserve readings are merged; until then there is no page to link to.
  { href: '/ops/collect/settings', label: 'Settings', needs: 'fees.manage' },
];

/** Whole days, for the held list: "3 days", "1 day", "today". */
export function daysWords(days: number): string {
  if (days <= 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

export const fileWords = (contentType: string, bytes: number) =>
  `${contentType === 'application/pdf' ? 'PDF' : contentType === 'image/png' ? 'PNG' : 'JPEG'}, ${
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }`;
