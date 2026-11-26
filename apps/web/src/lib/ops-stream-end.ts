/**
 * After the staff stream ends with 404 the shell asks /v1/ops/me again. A passing failure there
 * ('retry': no response, rate limit, server error) keeps the admin area showing, with the page's
 * filters and pages; only an answer (signed out, the code step, not staff, granted) is applied.
 */
export function keepsGrantedView(
  next: { step: string } | 'signed_out',
): boolean {
  return next !== 'signed_out' && next.step === 'retry';
}

/** After a passing failure, ask /v1/ops/me again after each of these waits (backoff). */
export const STREAM_END_RECHECK_MS = [5_000, 15_000, 45_000] as const;

/**
 * What the shell does with /v1/ops/me's answer after the staff stream ended (401/404): apply a
 * real answer; after a passing failure ask again later; after the last retry keep the admin area
 * (its screens then use their own timers until the page reloads).
 */
export function afterStreamEnd(
  next: { step: string } | 'signed_out',
  attempt: number,
): { apply: true } | { recheckInMs: number } | { keep: true } {
  if (!keepsGrantedView(next)) return { apply: true };
  const wait = STREAM_END_RECHECK_MS[attempt];
  return wait === undefined ? { keep: true } : { recheckInMs: wait };
}
