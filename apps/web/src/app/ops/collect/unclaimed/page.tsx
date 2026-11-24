'use client';
import { useCallback, useEffect, useState } from 'react';
import type { OpsCollectUnclaimed } from '@tipme/contracts';
import { Card, EmptyWell, Skeleton } from '@tipme/ui';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import { PAUSED_WORDS } from '@/lib/collect-ops-words';
import { when } from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/collect/unclaimed';

/**
 * Recipients past the holding cap who haven't added bank details (spec §9, §15): for staff to
 * follow up by hand. Nothing happens to them or their money automatically.
 */
export default function CollectUnclaimedPage() {
  const [rows, setRows] = useState<OpsCollectUnclaimed[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const result = await opsFetch<OpsCollectUnclaimed[]>(PATH);
    setFailed(!result.ok);
    if (result.ok) setRows(result.data);
  }, []);
  useEffect(() => {
    void opsFetch<OpsCollectUnclaimed[]>(PATH).then((result) => {
      setFailed(!result.ok);
      if (result.ok) setRows(result.data);
    });
  }, []);
  return (
    <section className="dashboard-section ops-page-body">
      <h1>Unclaimed</h1>
      <p className="tm-hint">
        Recipients whose page paused at the holding cap. Nothing happens to
        their money automatically: follow up with them.
      </p>
      {failed && (
        <LoadFailed dense title="Couldn’t load the list" onRetry={load}>
          Your role may not include it, or the connection failed.
        </LoadFailed>
      )}
      {!rows && !failed && <Skeleton label="Loading recipients past the cap" />}
      {rows?.length === 0 && (
        <EmptyWell title="Nobody past the cap">
          <p>No recipient’s page has paused at the holding cap.</p>
        </EmptyWell>
      )}
      {rows && rows.length > 0 && (
        <Card className="settings-section">
          <ul className="ops-list" aria-label="Recipients past the holding cap">
            {rows.map((row) => (
              <li key={row.profileId} className="ops-row">
                <strong>{row.handle ? `@${row.handle}` : 'No page'}</strong>
                <span>
                  <Money minor={row.heldMinor} /> held ·{' '}
                  {PAUSED_WORDS[row.pausedReason]}
                </span>
                <span className="tm-hint">
                  Oldest tip {row.oldestTipAt ? when(row.oldestTipAt) : '—'} ·{' '}
                  {row.remindersSent} reminder
                  {row.remindersSent === 1 ? '' : 's'} sent
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
