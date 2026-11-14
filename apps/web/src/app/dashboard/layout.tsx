import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Container, Skeleton } from '@tipme/ui';
import { PilotNotice } from '@/components/pilot-notice';
import { PaymentModeScope } from '@/components/payment-mode-slot';
import { ReleaseFlagsScope } from '@/components/release-flags-slot';
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
      <PaymentModeScope>
        {/* Business sign-up: the flags for the shell (account-only mode, the switcher). */}
        <ReleaseFlagsScope>
          <DashboardShell pilotNotice={<PilotNotice />}>
            {children}
          </DashboardShell>
        </ReleaseFlagsScope>
      </PaymentModeScope>
    </Suspense>
  );
}
