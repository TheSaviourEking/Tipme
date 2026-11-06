import type {
  WithdrawalQuoteLocalResponse,
  WithdrawalQuoteResponse,
  WithdrawalState,
} from '@tipme/contracts';

/**
 * What a live update does to the withdrawal quote on screen. A signal reads only TipMe's side of
 * the quote (`?scope=local`), so it never makes a call to the payment partner:
 * - a state TipMe's records decide (paused, setup, bank, collected elsewhere) replaces the old one;
 * - `unchecked` after a ready quote keeps its figures (the page clamps them to the fresh balance,
 *   and a withdrawal is always checked fresh, as before live updates);
 * - `unchecked` after anything else can't be sized without the partner, so the page asks the
 *   person to check, and only their tap reads the full quote.
 */
export function mergeLocalQuote(
  previous: WithdrawalQuoteResponse | null,
  local: WithdrawalQuoteLocalResponse,
): { quote: WithdrawalQuoteResponse | null; needsCheck: boolean } {
  if (local.state !== 'unchecked') return { quote: local, needsCheck: false };
  if (previous?.state === 'ready')
    return {
      quote: { ...previous, inReview: local.inReview },
      needsCheck: false,
    };
  return { quote: null, needsCheck: true };
}

const IN_FLIGHT: ReadonlySet<WithdrawalState | string> = new Set([
  'requested',
  'processing',
  'in_review',
]);

/** Whether any listed withdrawal is still on its way (its signal is for this person). */
export function withdrawalInFlight(
  rows: readonly { state: string }[] | null | undefined,
): boolean {
  return (rows ?? []).some((row) => IN_FLIGHT.has(row.state));
}
