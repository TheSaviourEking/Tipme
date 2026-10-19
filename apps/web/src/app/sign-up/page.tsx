import type { Metadata } from 'next';
import { Container } from '@tipme/ui';
import { SignUpFlow } from './sign-up-flow';

export const metadata: Metadata = {
  title: 'Create your page',
  robots: { index: false, follow: false },
};

export default function SignUpPage() {
  return (
    <main id="main" tabIndex={-1} className="auth-page">
      <Container className="auth-shell">
        <h1>Create your TipMe page</h1>
        <p className="auth-lede">
          A phone number and a handle is all it takes. Payments are pretend
          during the preview.
        </p>
        <SignUpFlow />
      </Container>
    </main>
  );
}
