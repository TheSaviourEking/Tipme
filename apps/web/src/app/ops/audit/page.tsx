'use client';
import { useEffect, useState } from 'react';
import type { OpsAuditEntry } from '@tipme/contracts';
import { Button, EmptyState, Notice, Skeleton } from '@tipme/ui';
import { when } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

/** Every staff view, reveal and action, newest first. The log cannot be edited. */
export default function AuditPage() {
  const [rows, setRows] = useState<OpsAuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void apiFetch<OpsAuditEntry[]>('/v1/ops/audit').then((result) => {
      if (!result.ok) return setFailed(true);
      setRows(result.data);
      setMore(result.data.length === 50);
    });
  }, []);

  const loadMore = async () => {
    const last = rows?.at(-1);
    if (!last) return;
    const result = await apiFetch<OpsAuditEntry[]>(
      `/v1/ops/audit?cursor=${last.seq}`,
    );
    if (result.ok) {
      setRows([...(rows ?? []), ...result.data]);
      setMore(result.data.length === 50);
    }
  };

  return (
    <section className="dashboard-section">
      <h1>Audit log</h1>
      <p className="tm-hint">
        Who did what, when and why. Entries cannot be changed or removed.
      </p>
      {failed && (
        <Notice tone="error" title="Couldn’t load the audit log">
          Your role may not include it, or the connection failed.
        </Notice>
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
