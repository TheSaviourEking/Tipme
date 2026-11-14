'use client';
import { useEffect, useState } from 'react';
import {
  createReleaseFlagsReader,
  releaseFlags,
  type ReleaseFlags,
} from './business/available';
import { apiFetch } from './session-client';

// The business flags in the browser, from the API's public /health/release. Shared by every
// component on the page; unknown (null) until read, and all off if it can't be read.
const readFlags = createReleaseFlagsReader({
  read: async () => {
    const result = await apiFetch<unknown>('/health/release');
    if (!result.ok) throw new Error(`release lookup failed: ${result.status}`);
    return result.data;
  },
  now: Date.now,
});

export const readReleaseFlags = readFlags;
export const ALL_OFF: ReleaseFlags = releaseFlags(null);

/** The flags, or null while they are being read. */
export function useReleaseFlags(): ReleaseFlags | null {
  const [flags, setFlags] = useState<ReleaseFlags | null>(null);
  useEffect(() => {
    let live = true;
    void readFlags().then((read) => {
      if (live) setFlags(read);
    });
    return () => {
      live = false;
    };
  }, []);
  return flags;
}
