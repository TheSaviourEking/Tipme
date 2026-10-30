import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthStage } from '@/components/account/auth-stage';
import { UnsubscribeConfirm } from './unsubscribe-confirm';

export const metadata: Metadata = {
  title: 'Email settings',
  robots: { index: false, follow: false },
  // The link carries a token: it must not leak to other sites.
  referrer: 'no-referrer',
};

export default function UnsubscribedPage() {
  return (
    <AuthStage
      title="Turn off this email?"
      lede="Sign-in codes, security warnings and account emails always reach you."
    >
      <Suspense>
        <UnsubscribeConfirm />
      </Suspense>
    </AuthStage>
  );
}
