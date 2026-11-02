export type FreezeRead =
  | { ok: true; data: { issueId: string | null; issueOpen: boolean } }
  | { ok: false }
  | null;

export interface FreezeView {
  state: 'frozen' | 'clear' | 'unknown';
  issueId: string | null;
  /** False when the issue holding it has closed: there is nothing to resolve until a new report. */
  issueOpen: boolean;
  open: string;
  submit: string;
  warning: string | null;
}

/**
 * What the takeover card shows. Not knowing is never shown as not frozen: during a takeover that
 * false picture is the danger. Freezing again is harmless, so the way to stop stays on offer.
 */
export function freezeView(read: FreezeRead): FreezeView {
  if (read?.ok && read.data.issueId)
    return {
      state: 'frozen',
      issueId: read.data.issueId,
      issueOpen: read.data.issueOpen,
      open: read.data.issueOpen
        ? 'Record another report…'
        : 'Record a new report…',
      submit: 'Record report',
      warning: null,
    };
  if (read?.ok)
    return {
      state: 'clear',
      issueId: null,
      issueOpen: false,
      open: 'Freeze withdrawals…',
      submit: 'Freeze withdrawals',
      warning: null,
    };
  return {
    state: 'unknown',
    issueId: null,
    issueOpen: false,
    open: 'Freeze or record a report…',
    submit: 'Freeze withdrawals',
    warning: read
      ? 'We couldn’t check whether this page is frozen. It may be. Freezing again is safe.'
      : null,
  };
}
