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

type OpsStateAnswer = { step: string } | 'signed_out';

/**
 * The shell's stream-end recheck: asks, applies a real answer, backs off after a passing failure.
 * `stop` (the shell unmounting) ends it: a question still in flight then neither arms another
 * timer nor applies its answer, which could otherwise send someone who already left to sign in.
 * `apply` is called through as given each time, so the shell can pass the latest one (a ref).
 */
export function createStreamEndRecheck<A extends OpsStateAnswer>(o: {
  ask: () => Promise<A>;
  apply: (next: A) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}): { start: () => void; stop: () => void } {
  let stopped = false;
  let timer: unknown;
  const run = (attempt: number): void => {
    void o.ask().then((next) => {
      if (stopped) return;
      const what = afterStreamEnd(next, attempt);
      if ('apply' in what) o.apply(next);
      else if ('recheckInMs' in what)
        timer = o.setTimeout(() => {
          timer = undefined;
          run(attempt + 1);
        }, what.recheckInMs);
    });
  };
  return {
    start: () => {
      if (!stopped) run(0);
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) o.clearTimeout(timer);
      timer = undefined;
    },
  };
}
