import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Container, Skeleton } from '@tipme/ui';
import { OpsShell } from './ops-shell';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin | TipMe' },
  robots: { index: false, follow: false },
};

/** Staff only. The shell reads the URL (for the sign-in redirect), so it sits in Suspense. */
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <main id="main" tabIndex={-1} className="dashboard-page">
          <Container>
            <Skeleton label="Loading the admin area" />
          </Container>
        </main>
      }
    >
      <OpsShell>{children}</OpsShell>
    </Suspense>
  );
}
