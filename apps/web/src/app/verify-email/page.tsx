import type { Metadata } from 'next';
import { Container } from '@tipme/ui';
import { VerifyEmail } from './verify-email';

export const metadata: Metadata = {
  title: 'Confirm your email',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function VerifyEmailPage() {
  return (
    <main id="main" tabIndex={-1} className="auth-page">
      <Container className="auth-shell">
        <VerifyEmail />
      </Container>
    </main>
  );
}
