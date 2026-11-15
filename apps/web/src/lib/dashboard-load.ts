/**
 * What the dashboard does with its first profile read (UI audit, 15 Nov 2026, item 3). Only the
 * API's signed-out answer (401, `UNAUTHENTICATED` from the session guard) sends someone to Sign in.
 * A 404 is a login with no page yet. Anything else is a failure to read, not an answer about the
 * session: the dashboard says so and offers Try again, and never pretends the person signed out.
 */
export type ProfileReadOutcome =
  | 'page'
  | 'signed_out'
  | 'no_page'
  /** No answer at all: offline, a dropped connection, or a read that timed out (status 0). */
  | 'unreachable'
  /** An answer that isn't about the session: a 5xx, a 429, a refused origin. */
  | 'failed';

export function profileReadOutcome(result: {
  ok: boolean;
  status: number;
}): ProfileReadOutcome {
  if (result.ok) return 'page';
  if (result.status === 401) return 'signed_out';
  if (result.status === 404) return 'no_page';
  if (result.status === 0) return 'unreachable';
  return 'failed';
}

/** The words under "We couldn’t load your dashboard" for each failure. */
export function dashboardLoadFailedBody(
  outcome: 'unreachable' | 'failed',
): string {
  return outcome === 'unreachable'
    ? 'We couldn’t reach TipMe. Check your connection, then try again.'
    : 'This is usually brief. Please try again.';
}
