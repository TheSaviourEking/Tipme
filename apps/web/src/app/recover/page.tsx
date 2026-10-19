import type { Metadata } from 'next';
import { Container } from '@tipme/ui';
import { RecoverFlow } from './recover-flow';

export const metadata: Metadata = {
  title: 'Lost your number?',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function RecoverPage() {
  return (
    <main id="main" tabIndex={-1} className="auth-page">
      <Container className="auth-shell">
        <h1>Lost your number?</h1>
        <RecoverFlow />
      </Container>
    </main>
  );
}
