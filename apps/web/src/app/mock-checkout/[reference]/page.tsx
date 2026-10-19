import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Container, Skeleton } from '@tipme/ui';
import { MockCheckoutView } from './mock-checkout-view';

export const metadata: Metadata = {
  title: 'Pretend payment provider',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function MockCheckoutPage() {
  return (
    <main id="main" tabIndex={-1} className="mock-checkout-page">
      <Container>
        <Suspense fallback={<Skeleton label="Loading the payment" />}>
          <MockCheckoutView />
        </Suspense>
      </Container>
    </main>
  );
}
