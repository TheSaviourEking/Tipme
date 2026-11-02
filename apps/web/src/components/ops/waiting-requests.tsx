'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { OpsApproval } from '@tipme/contracts';
import { Notice, Skeleton } from '@tipme/ui';
import { actionWords, opsFetch } from '@/lib/ops-staff-api';

/**
 * What is waiting for a second person, on the Overview and on People and Roles (which pass the one
 * permission they show). Says plainly when nothing is, and when it can't tell.
 */
export function WaitingRequests({
  title = 'Pending approvals',
  permission,
  refresh = 0,
}: {
  title?: string;
  permission?: string;
  /** Change it to read the list again. */
  refresh?: number;
}) {
  const id = useId();
  const [rows, setRows] = useState<OpsApproval[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void opsFetch<OpsApproval[]>('/v1/ops/approvals?status=pending').then(
      (result) => {
        if (!current) return;
        setFailed(!result.ok);
        if (result.ok) setRows(result.data);
      },
    );
    return () => {
      current = false;
    };
  }, [refresh]);
  const shown = rows?.filter((row) =>
    permission ? row.permission === permission : true,
  );
  // On People and Roles this is an extra: nothing waiting needs no words.
  if (permission && !failed && !shown?.length) return null;
  return (
    <section aria-labelledby={id} className="dashboard-section">
      <h2 id={id}>{title}</h2>
      {failed && (
        <Notice tone="error" title="Couldn’t read what’s waiting">
          There may be requests waiting.{' '}
          <Link href="/ops/approvals">Open approvals</Link>
        </Notice>
      )}
      {!shown && !failed && <Skeleton label="Loading pending approvals" />}
      {shown?.length === 0 && (
        <p className="tm-hint">Nothing is waiting for a second person.</p>
      )}
      {shown && shown.length > 0 && (
        <>
          <ul className="ops-list">
            {shown.slice(0, 5).map((row) => (
              <li key={row.id} className="ops-row">
                <strong>{actionWords(row.action)}</strong>
                <span>{row.summary}</span>
                <span className="tm-hint">
                  {row.mine
                    ? 'You asked for this'
                    : row.canDecide
                      ? 'You can decide this'
                      : `Asked by ${row.requestedByHint ?? 'staff'}`}
                </span>
              </li>
            ))}
          </ul>
          {shown.length > 5 && (
            <p className="tm-hint">And {shown.length - 5} more.</p>
          )}
          <p>
            <Link href="/ops/approvals">Open approvals</Link>
          </p>
        </>
      )}
    </section>
  );
}
