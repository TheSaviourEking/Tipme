'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpsApproval } from '@tipme/contracts';
import { decidableCount } from '@/lib/approvals-count';
import { opsFetch } from '@/lib/ops-staff-api';

export { decidableCount };

/** Moving between pages reads the list again at most this often. */
const AT_MOST_EVERY_MS = 30_000;

/**
 * Waiting requests this person could decide now, read on arrival and when the page changes. A
 * failed read is null: no count, and no error (the Approvals page says so itself). `reload` reads
 * at once, for a live signal (live updates PR 3: `useLiveEvents([...], reload)`).
 */
export function useApprovalsCount(pathname: string): {
  count: number | null;
  reload: () => void;
} {
  const [count, setCount] = useState<number | null>(null);
  const lastRead = useRef(0);
  const latest = useRef(0);
  const reload = useCallback(() => {
    lastRead.current = Date.now();
    const asked = ++latest.current;
    void opsFetch<OpsApproval[]>('/v1/ops/approvals?status=pending').then(
      (result) => {
        // An older answer arriving late never replaces a newer one.
        if (asked === latest.current)
          setCount(decidableCount(result.ok ? result.data : null));
      },
    );
  }, []);
  useEffect(() => {
    if (Date.now() - lastRead.current < AT_MOST_EVERY_MS) return;
    reload();
  }, [pathname, reload]);
  return { count, reload };
}

/** The purple count on the Approvals link; nothing at all when there is nothing, or no answer. */
export function ApprovalsCount({ count }: { count: number | null }) {
  if (!count) return null;
  return (
    <>
      <span className="ops-frame__count" aria-hidden="true">
        {count}
      </span>
      {/* Hidden text is laid out as a block, so its name gets a space before it either way. */}
      <span className="sr-only">{` (${count} waiting for you)`}</span>
    </>
  );
}
