'use client';
import { useCallback, useEffect, useState } from 'react';
import type { OpsAuditEntry } from '@tipme/contracts';
import { Button, EmptyState, Skeleton } from '@tipme/ui';
import { ReadFailureNotice } from '@/components/ops/read-failure-notice';
import { readFailure, type ReadFailure } from '@/lib/ops-answers';
import { when } from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';

/** Every staff view, reveal and action, newest first. The log cannot be edited. */
export default function AuditPage() {
  const [rows, setRows] = useState<OpsAuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState<ReadFailure | null>(null);

  // opsFetch asks for a fresh code when the server wants one, then reads again. Only if that is
  // turned down (or the role truly lacks the log) does this say why it didn't load.
  const load = useCallback(async () => {
    const result = await opsFetch<OpsAuditEntry[]>('/v1/ops/audit');
    if (!result.ok) return setFailed(readFailure(result, 'the audit log'));
    setFailed(null);
    setRows(result.data);
    setMore(result.data.length === 50);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing is set before the await
    void load();
  }, [load]);

  const loadMore = async () => {
    const last = rows?.at(-1);
    if (!last) return;
    const result = await opsFetch<OpsAuditEntry[]>(
      `/v1/ops/audit?cursor=${last.seq}`,
    );
    if (!result.ok) return setFailed(readFailure(result, 'the audit log'));
    setFailed(null);
    setRows([...(rows ?? []), ...result.data]);
    setMore(result.data.length === 50);
  };

  return (
    <section className="dashboard-section">
      <h1>Audit log</h1>
      <p className="tm-hint">
        Who did what, when and why. Entries cannot be changed or removed.
      </p>
      {failed && (
        <ReadFailureNotice
          failure={failed}
          title="Couldn’t load the audit log"
          onRetry={() => void load()}
        />
      )}
      {!rows && !failed && <Skeleton label="Loading the audit log" />}
      {rows?.length === 0 && (
        <EmptyState title="Nothing recorded yet">
          Actions appear here as staff work.
        </EmptyState>
      )}
      {rows && rows.length > 0 && (
        <div
          className="ops-table-wrap"
          role="region"
          aria-label="Audit entries"
          tabIndex={0}
        >
          <table className="ops-table">
            <caption className="sr-only">Audit entries, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Subject</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.seq}>
                  <td>{when(row.createdAt)}</td>
                  <td>
                    {row.staffUserId
                      ? `Staff …${row.staffUserId.slice(-6)}`
                      : 'System'}
                  </td>
                  <td>{row.action}</td>
                  <td>
                    {row.subjectType
                      ? `${row.subjectType} …${(row.subjectId ?? '').slice(-6)}`
                      : '—'}
                  </td>
                  <td>{row.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && (
        <Button variant="secondary" onClick={() => void loadMore()}>
          Show older entries
        </Button>
      )}
    </section>
  );
}
