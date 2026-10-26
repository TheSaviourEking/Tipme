import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthStage } from '@/components/account/auth-stage';
import { SignInView } from './sign-in-view';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <AuthStage
      title="Welcome back."
      lede="Use the phone number you signed up with, and we’ll send you a code."
    >
      <Suspense>
        <SignInView />
      </Suspense>
    </AuthStage>
  );
}
