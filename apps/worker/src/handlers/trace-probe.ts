import { setTimeout as sleep } from 'node:timers/promises';
import { traceProbeJobSchema } from '@tipme/contracts';
import { UnrecoverableError } from 'bullmq';

export interface JobContext {
  /** Attempts already made before this one (0 on first delivery). */
  attemptsMade: number;
  /** True when this idempotency key already completed. */
  isProcessed(key: string): Promise<boolean>;
  /** Atomically records the key; false when it was already recorded. */
  markProcessed(key: string): Promise<boolean>;
  signal: AbortSignal;
  delayMs?: number;
}

/** Rejects with `timeout` when the signal aborts, whatever the work is waiting on. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('timeout'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Diagnostic job: does no real work, but behaves like one so retries, idempotency and
 * timeouts can be observed. A delivery whose key already completed is skipped without
 * working. The marker is set only after success, so a failed attempt's retry is not mistaken
 * for a duplicate. Two concurrent deliveries can both work before either marks; real jobs get
 * transactional (database) idempotency in PR-005.
 */
export async function handleTraceProbe(
  payload: unknown,
  context: JobContext,
): Promise<'processed' | 'duplicate'> {
  // Redis data is untrusted input; a corrupt payload will never succeed, so do not retry it.
  const parsed = traceProbeJobSchema.safeParse(payload);
  if (!parsed.success) throw new UnrecoverableError('invalid_payload');
  const job = parsed.data;
  return bounded(
    (async () => {
      if (await context.isProcessed(job.idempotencyKey))
        return 'duplicate' as const;
      if (context.delayMs)
        await sleep(context.delayMs, undefined, { signal: context.signal });
      if (
        job.mode === 'fail-always' ||
        (job.mode === 'fail-once' && context.attemptsMade === 0)
      ) {
        throw new Error('probe_failure');
      }
      return (await context.markProcessed(job.idempotencyKey))
        ? 'processed'
        : 'duplicate';
    })(),
    context.signal,
  );
}
