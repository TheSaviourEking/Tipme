'use client';
import { useEffect, useId, useState } from 'react';
import type { OpsStaffActivity } from '@tipme/contracts';
import { Notice, Skeleton } from '@tipme/ui';
import { when } from '@/lib/ops-client';
import { STAFF_ACTIVITY_WORDS } from '@/lib/ops-answers';
import { actionWords, opsFetch } from '@/lib/ops-staff-api';

/** Spec 6.4 on the Overview: who changed what among staff, and anything done alone. */
export function StaffActivity() {
  const id = useId();
  const [rows, setRows] = useState<OpsStaffActivity[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void opsFetch<OpsStaffActivity[]>('/v1/ops/staff-activity').then(
      (result) => (result.ok ? setRows(result.data) : setFailed(true)),
    );
  }, []);
  return (
    <section aria-labelledby={id} className="dashboard-section">
      <h2 id={id}>Staff activity</h2>
      {failed && (
        <Notice tone="error" title="Couldn’t read staff activity">
          The audit log has the full record.
        </Notice>
      )}
      {!rows && !failed && <Skeleton label="Loading staff activity" />}
      {rows?.length === 0 && (
        <p className="tm-hint">No staff changes recorded yet.</p>
      )}
      {rows && rows.length > 0 && (
        <ol className="ops-timeline">
          {rows.map((row) => (
            <li key={row.seq}>
              <strong>{STAFF_ACTIVITY_WORDS[row.action] ?? row.action}</strong>
              {row.seriousAction && (
                <>
                  {': '}
                  {actionWords(row.seriousAction)}
                </>
              )}{' '}
              <span className="tm-hint">
                {row.staffHint ?? 'The system'} · {when(row.at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
