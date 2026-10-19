import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Container, Skeleton } from '@tipme/ui';
import { DashboardShell } from './dashboard-shell';

export const metadata: Metadata = {
  title: { default: 'Dashboard', template: '%s · Dashboard | TipMe' },
  robots: { index: false, follow: false },
};

/** The shell reads the URL (for the sign-in redirect), so it renders inside a Suspense boundary. */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <main id="main" tabIndex={-1} className="dashboard-page">
          <Container>
            <Skeleton label="Loading your dashboard" />
          </Container>
        </main>
      }
    >
      <DashboardShell>{children}</DashboardShell>
    </Suspense>
  );
}
