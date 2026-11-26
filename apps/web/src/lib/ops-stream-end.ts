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
