'use client';
import Link from 'next/link';
import { Button } from '@tipme/ui';
import { QuietScreen } from '@/components/quiet-screen';

/** Any page that fails unexpectedly: header and footer stay, and the person gets a way back. */
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <QuietScreen
      title="Something went wrong on our side"
      actions={
        <>
          <Button onClick={reset}>Try again</Button>
          <Link className="text-link" href="/">
            Go to TipMe
          </Link>
        </>
      }
    >
      <p>
        This page didn’t load. Nothing you did caused it. If you were sending a
        tip, nothing was charged without your confirmation.
      </p>
    </QuietScreen>
  );
}
