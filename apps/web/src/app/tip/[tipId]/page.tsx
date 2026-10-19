import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Container, Skeleton } from '@tipme/ui';
import { StatusView } from './status-view';

export const metadata: Metadata = {
  title: 'Your tip',
  robots: { index: false, follow: false },
  // The receipt token lives in the URL fragment; never leak the page URL onward.
  referrer: 'no-referrer',
};

export default function TipStatusPage() {
  return (
    <main id="main" tabIndex={-1} className="tip-status-page">
      <Container>
        <noscript>
          <p className="tip-status-noscript">
            Your tip’s status needs JavaScript to load. Please turn it on and
            reload this page.
          </p>
        </noscript>
        <Suspense fallback={<Skeleton label="Loading your tip" />}>
          <StatusView />
        </Suspense>
      </Container>
    </main>
  );
}
