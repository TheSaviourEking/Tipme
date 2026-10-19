import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Container } from '@tipme/ui';
import { SignInView } from './sign-in-view';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <main id="main" tabIndex={-1} className="auth-page">
      <Container className="auth-shell">
        <h1>Sign in to TipMe</h1>
        <p className="auth-lede">Use the phone number you signed up with.</p>
        <Suspense>
          <SignInView />
        </Suspense>
      </Container>
    </main>
  );
}
