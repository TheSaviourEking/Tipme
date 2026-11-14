import { connection } from 'next/server';
import { API_ORIGIN } from '../profiles-api';
import { createReleaseFlagsReader, type ReleaseFlags } from './available';

const readFlags = createReleaseFlagsReader({
  read: async () => {
    const response = await fetch(`${API_ORIGIN}/health/release`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      throw new Error(`release lookup failed: ${response.status}`);
    return ((await response.json()) as { data?: unknown }).data;
  },
  now: Date.now,
});

/**
 * Whether TipMe for businesses is on for this copy. Read at request time only (never at build,
 * where there is no API to ask), so callers render it inside a Suspense boundary
 * (BusinessAvailableSlot).
 */
export async function getBusinessAvailable(): Promise<boolean> {
  return (await getReleaseFlags()).business;
}

/** Every business flag, read the same way (business sign-up, Task D1). */
export async function getReleaseFlags(): Promise<ReleaseFlags> {
  await connection();
  return readFlags();
}
