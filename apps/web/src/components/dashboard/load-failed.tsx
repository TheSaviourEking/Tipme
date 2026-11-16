'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Slip } from '@tipme/ui';

/**
 * A page-level read that failed (StatesMap: "Page-level", an error slip): what didn't load, and Try
 * again, which asks again in place. A retry that still fails says so instead of looking unanswered.
 * One pattern for every dashboard surface (UI audit, 15 Nov 2026, items 3 and 4).
 */
export function LoadFailed({
  title,
  children = 'This is usually brief. Please try again.',
  onRetry,
  dense = false,
}: {
  title: string;
  children?: string;
  /** Staff screens (`/ops`): the dense slip. */
  dense?: boolean;
  /** Reads again; settles once the read has answered (or failed). */
  onRetry: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [stillFailing, setStillFailing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retry = async () => {
    setBusy(true);
    await onRetry();
    // A read that worked replaces this slip; one that didn't leaves it here.
    if (!mounted.current) return;
    setBusy(false);
    setStillFailing(true);
  };
  return (
    <Slip
      dense={dense}
      tone="error"
      title={title}
      actions={
        <Button
          variant="secondary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void retry()}
        >
          Try again
        </Button>
      }
    >
      {stillFailing
        ? 'Still not loading. Please try again in a minute.'
        : children}
    </Slip>
  );
}
