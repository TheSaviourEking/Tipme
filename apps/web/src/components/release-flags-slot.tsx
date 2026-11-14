import { Suspense, type ReactNode } from 'react';
import type { ReleaseFlags } from '@/lib/business/available';
import { getReleaseFlags } from '@/lib/business/available-api';
import { ReleaseFlagsProvider } from './release-flags-context';

async function Resolved({
  children,
}: {
  children: (flags: ReleaseFlags) => ReactNode;
}) {
  return children(await getReleaseFlags());
}

/**
 * Renders `children` with the business flags (business sign-up, Task D3). Read per request, so it
 * streams in a Suspense boundary while the rest stays prerendered; `fallback` shows until known
 * (today's words, the safe default).
 */
export function ReleaseFlagsSlot({
  children,
  fallback = null,
}: {
  children: (flags: ReleaseFlags) => ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <Resolved>{children}</Resolved>
    </Suspense>
  );
}

/** "Get tipped" with business sign-up on, else today's "Claim your username". */
export function GetTippedWords() {
  return (
    <ReleaseFlagsSlot fallback="Claim your username">
      {(flags) => (flags.businessSignup ? 'Get tipped' : 'Claim your username')}
    </ReleaseFlagsSlot>
  );
}

/**
 * Gives client views below the business flags (useReleaseFlags). Place it inside an existing
 * Suspense boundary: it waits for them.
 */
export async function ReleaseFlagsScope({ children }: { children: ReactNode }) {
  return (
    <ReleaseFlagsProvider flags={await getReleaseFlags()}>
      {children}
    </ReleaseFlagsProvider>
  );
}

/** The header's "For businesses" (business sign-up on): the business path of sign-up. */
export function HeaderBusinessStart() {
  return (
    <ReleaseFlagsSlot>
      {(flags) =>
        flags.businessSignup && (
          <a
            className="nav-guest nav-business-start"
            href="/sign-up?for=business"
          >
            For businesses
          </a>
        )
      }
    </ReleaseFlagsSlot>
  );
}
