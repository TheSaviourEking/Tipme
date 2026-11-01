import { randomUUID } from 'node:crypto';

/** The two Redis commands the lock needs (an ioredis client has both). */
export interface LockClient {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  eval(
    script: string,
    keys: number,
    key: string,
    token: string,
  ): Promise<unknown>;
}

// Delete the key only while it still holds this run's token: a run that outlived its lock must not
// free the lock of the run that took over.
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Runs `work` unless a run with the same key is already going, in which case it does nothing and
 * says so. A scheduled job fires on a timer whether or not the last one has finished; this is how
 * a slow run makes the next one wait its turn (skipped, not queued). `ttlMs` frees the lock if the
 * process dies mid-run, so it must be longer than a run can take and shorter than the interval.
 */
export async function runUnlessRunning<T>(
  client: LockClient,
  options: { key: string; ttlMs: number },
  work: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const token = randomUUID();
  const got = await client.set(options.key, token, 'PX', options.ttlMs, 'NX');
  if (got !== 'OK') return { ran: false };
  try {
    return { ran: true, value: await work() };
  } finally {
    // A release that fails just leaves the lock to expire.
    await client.eval(RELEASE, 1, options.key, token).catch(() => undefined);
  }
}
