import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthStage } from '@/components/account/auth-stage';
import { ReleaseFlagsSlot } from '@/components/release-flags-slot';
import { SignInView } from './sign-in-view';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <AuthStage
      title="Welcome back."
      lede="Use the email you signed up with, and we’ll send you a code."
    >
      <Suspense>
        <ReleaseFlagsSlot fallback={<SignInView />}>
          {(flags) => <SignInView businessSignup={flags.businessSignup} />}
        </ReleaseFlagsSlot>
      </Suspense>
    </AuthStage>
  );
}
