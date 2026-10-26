'use client';
import Link from 'next/link';
import { Button } from '@tipme/ui';
import { QuietScreen } from '@/components/quiet-screen';

export default function ProfileError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <QuietScreen
      title="Let’s try that again"
      actions={
        <>
          <Button onClick={reset}>Try again</Button>
          <Link className="text-link" href="/">
            Back to TipMe
          </Link>
        </>
      }
    >
      <p>
        We couldn’t load this page. No appreciation has been sent, so nothing is
        lost.
      </p>
    </QuietScreen>
  );
}
