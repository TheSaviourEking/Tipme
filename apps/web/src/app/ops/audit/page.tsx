'use client';
import { useCallback, useEffect, useState } from 'react';
import type { OpsAuditEntry } from '@tipme/contracts';
import { Button, EmptyWell, Skeleton } from '@tipme/ui';
import { ReadFailureNotice } from '@/components/ops/read-failure-notice';
import { readFailure, type ReadFailure } from '@/lib/ops-answers';
import { auditWords } from '@/lib/ops-audit-words';
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
    <section className="dashboard-section ops-page-body">
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
        <EmptyWell title="Nothing recorded yet">
          <p>Actions appear here as staff work.</p>
        </EmptyWell>
      )}
      {rows && rows.length > 0 && (
        <div
          className="ops-table-wrap"
          role="region"
          aria-label="Audit entries"
          tabIndex={0}
        >
          <table className="ops-table ops-table--stack">
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
                  <td data-label="When">{when(row.createdAt)}</td>
                  <td data-label="Who">
                    {row.staffUserId
                      ? `Staff …${row.staffUserId.slice(-6)}`
                      : 'System'}
                  </td>
                  <td data-label="Action" className="ops-mono">
                    {row.action}
                  </td>
                  <td data-label="Subject">
                    {row.subjectType
                      ? `${row.subjectType} …${(row.subjectId ?? '').slice(-6)}`
                      : '—'}
                  </td>
                  <td data-label="Reason">
                    <AuditReason row={row} />
                  </td>
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

/** The written reason, then what changed in plain words (never the stored JSON). */
function AuditReason({ row }: { row: OpsAuditEntry }) {
  const { reason, detail } = auditWords(row);
  if (!reason && !detail) return <>—</>;
  // One wrapper, so on a phone (where the cell is a label | value grid) both lines sit in the value.
  return (
    <span>
      {reason ?? '—'}
      {detail && <span className="ops-audit__detail">{detail}</span>}
    </span>
  );
}
