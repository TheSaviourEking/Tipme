export type FreezeRead =
  { ok: true; data: { issueId: string | null } } | { ok: false } | null;

export interface FreezeView {
  state: 'frozen' | 'clear' | 'unknown';
  issueId: string | null;
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
      open: 'Record another report…',
      submit: 'Record report',
      warning: null,
    };
  if (read?.ok)
    return {
      state: 'clear',
      issueId: null,
      open: 'Freeze withdrawals…',
      submit: 'Freeze withdrawals',
      warning: null,
    };
  return {
    state: 'unknown',
    issueId: null,
    open: 'Freeze or record a report…',
    submit: 'Freeze withdrawals',
    warning: read
      ? 'We couldn’t check whether this page is frozen. It may be. Freezing again is safe.'
      : null,
  };
}
