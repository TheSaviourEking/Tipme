'use client';
import Link from 'next/link';
import { Button } from '@tipme/ui';
import { QuietScreen } from '@/components/quiet-screen';

/**
 * Any page that fails unexpectedly: header and footer stay, and the person gets a way back. The
 * reference is the `digest` Next puts on a server failure and writes to the server log with the
 * error itself, so support can find the failure from it. A failure in the browser has none, so
 * none is shown: an id that appears in no log is no use to anyone.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <QuietScreen
      title="This page didn’t load."
      action={
        <Button variant="continue" onClick={reset}>
          Try again
        </Button>
      }
      foot={
        <>
          {error.digest && <span>Reference: {error.digest}</span>}
          <Link className="text-link" href="/">
            Go to TipMe
          </Link>
        </>
      }
    >
      <p>
        It’s a problem on our side and your account is fine. Try again in a
        moment. If you were sending a tip, nothing was charged without your
        confirmation.
      </p>
    </QuietScreen>
  );
}
