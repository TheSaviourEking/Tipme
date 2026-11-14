'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { ReleaseFlags } from '@/lib/business/available';

// The business flags for client views. They are read on the server (/health/release is not open to
// the browser) by ReleaseFlagsScope; outside a scope they are unknown (null), which reads as off.
const ReleaseFlagsContext = createContext<ReleaseFlags | null>(null);

export function ReleaseFlagsProvider({
  flags,
  children,
}: {
  flags: ReleaseFlags;
  children: ReactNode;
}) {
  return <ReleaseFlagsContext value={flags}>{children}</ReleaseFlagsContext>;
}

export const useReleaseFlags = (): ReleaseFlags | null =>
  useContext(ReleaseFlagsContext);
