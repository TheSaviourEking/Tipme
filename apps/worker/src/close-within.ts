import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Tries a graceful close; if it has not finished within `ms`, stops waiting for it and runs
 * `force`. Never awaits the abandoned graceful promise, so a hung job cannot block exit.
 */
export async function closeWithin(
  ms: number,
  graceful: () => Promise<void>,
  force: () => Promise<void>,
): Promise<'graceful' | 'forced'> {
  const outcome = await Promise.race([
    graceful().then(() => 'graceful' as const),
    // Unref'd so a pending timer never keeps the process alive after a graceful close.
    sleep(ms, 'forced' as const, { ref: false }),
  ]);
  if (outcome === 'forced') await force();
  return outcome;
}
