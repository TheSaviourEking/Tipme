import type { Metadata } from 'next';
import { Suspense } from 'react';
import BusinessCodesPrintView from './print-view';

export const metadata: Metadata = { title: 'Print your codes' };

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default function BusinessCodesPrintPage() {
  return (
    <Suspense>
      <BusinessCodesPrintView />
    </Suspense>
  );
}
