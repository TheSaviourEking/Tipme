'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpsApproval } from '@tipme/contracts';
import { useLiveEvents } from '@/components/live/live-provider';
import { decidableCount } from '@/lib/approvals-count';
import type { LiveRead } from '@/lib/live-refetch';
import { opsFetch } from '@/lib/ops-staff-api';

export { decidableCount };

/** Moving between pages reads the list again at most this often. */
const AT_MOST_EVERY_MS = 30_000;
const APPROVALS_CHANGED = ['ops.approvals.changed'] as const;

/**
 * Waiting requests this person could decide now, read on arrival, when the page changes, and on
 * the staff stream's `ops.approvals.changed` (and its resyncs). A failed read is null: no count,
 * and no error (the Approvals page says so itself). `reload` reads at once.
 */
export function useApprovalsCount(pathname: string): {
  count: number | null;
  reload: () => void;
} {
  const [count, setCount] = useState<number | null>(null);
  const lastRead = useRef(0);
  const latest = useRef(0);
  // `live`: the stream started this read (not the person), so it is not staff activity.
  const read = useCallback(async (live?: LiveRead) => {
    lastRead.current = Date.now();
    const asked = ++latest.current;
    const result = await opsFetch<OpsApproval[]>(
      '/v1/ops/approvals?status=pending',
      live,
    );
    // An older answer arriving late never replaces a newer one.
    if (asked === latest.current)
      setCount(decidableCount(result.ok ? result.data : null));
  }, []);
  const reload = useCallback(() => void read(), [read]);
  useLiveEvents(APPROVALS_CHANGED, (live) => read(live));
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
