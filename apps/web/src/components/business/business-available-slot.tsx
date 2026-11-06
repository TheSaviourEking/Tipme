import { Suspense, type ReactNode } from 'react';
import { getBusinessAvailable } from '@/lib/business/available-api';

async function Resolved({
  children,
}: {
  children: (on: boolean) => ReactNode;
}) {
  return children(await getBusinessAvailable());
}

/**
 * Renders `children` with whether TipMe for businesses is on (PR B1). It is read per request, so
 * whatever depends on it streams in a Suspense boundary while the rest stays prerendered;
 * `fallback` shows until it is known (the coming-soon version, the safe default).
 */
export function BusinessAvailableSlot({
  children,
  fallback = null,
}: {
  children: (on: boolean) => ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <Resolved>{children}</Resolved>
    </Suspense>
  );
}
