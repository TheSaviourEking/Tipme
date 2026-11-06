// Connection failures (states plan, Task 16): offline detection, a send on reconnect and one quiet
// retry, only where repeating the request is safe. Plain TypeScript so Node's tests can load it.

type Answer = { ok: boolean; code?: string };

/**
 * Where a request may be retried once quietly and sent again on reconnect. Nothing else is:
 * - the tip intent replays the original tip for the same idempotency key (intents.ts);
 * - a quote is a read;
 * - a used sign-in code comes back invalid before the lockout counter (email-sign-in.ts);
 * - the welcome PATCH and PUT leave the same state when repeated.
 * Withdrawals, sending a code (a second code replaces the first), staff actions and bank-account
 * changes are never on this list (financial invariant: no blind retries of money movements).
 */
export const QUIET_RETRY = [
  'tip-intent',
  'tip-quote',
  'sign-in-verify',
  'welcome-profile',
  'welcome-live',
] as const;
export type RetrySurface = (typeof QUIET_RETRY)[number];

export function retryable(surface: string): surface is RetrySurface {
  return (QUIET_RETRY as readonly string[]).includes(surface);
}

const isNetwork = (answer: Answer) => !answer.ok && answer.code === 'NETWORK';

/** 'offline' when the browser says so; 'no-answer' when online but the API couldn't be reached; else null. */
export function connectionProblem(
  answer: Answer,
  online: boolean,
): 'offline' | 'no-answer' | null {
  if (!isNetwork(answer)) return null;
  return online ? 'no-answer' : 'offline';
}

const RETRY_MS = 400;
const browserOnline = () =>
  typeof navigator === 'undefined' ? true : navigator.onLine;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends; on NETWORK while online, waits 400–800 ms (jittered, like session-client.ts) and sends
 * the SAME request once more. Never retries when offline (the caller waits for reconnect instead),
 * and never for a surface outside QUIET_RETRY.
 */
export async function sendWithOneRetry<R extends Answer>(
  surface: RetrySurface,
  send: () => Promise<R>,
  options: {
    online?: () => boolean;
    wait?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<{ result: R; retried: boolean; firstWasNetwork: boolean }> {
  // The type already says so; this holds for a cast or plain JS too.
  if (!retryable(surface))
    throw new TypeError(`${String(surface)} is never retried quietly`);
  const online = options.online ?? browserOnline;
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  const first = await send();
  const firstWasNetwork = isNetwork(first);
  if (!firstWasNetwork || !online())
    return { result: first, retried: false, firstWasNetwork };
  await wait(RETRY_MS + random() * RETRY_MS);
  return { result: await send(), retried: true, firstWasNetwork };
}

/** Runs `run` once on the next 'online' event. Returns a cancel function. */
export function onReconnect(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  run: () => void,
): () => void {
  const fire = () => {
    target.removeEventListener('online', fire);
    run();
  };
  target.addEventListener('online', fire);
  return () => target.removeEventListener('online', fire);
}
