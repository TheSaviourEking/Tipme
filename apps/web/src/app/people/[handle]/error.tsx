'use client';
import Link from 'next/link';
import { Button, Container, Notice } from '@tipme/ui';
export default function ProfileError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="unavailable-page">
        <h1>Let’s try that again.</h1>
        <Notice tone="error" title="We couldn’t load this profile.">
          No appreciation has been sent. Please retry, or return to the home
          page.
        </Notice>
        <Button onClick={reset}>Try again</Button>
        <Link className="text-link" href="/">
          Back to TipMe
        </Link>
      </Container>
    </main>
  );
}
