'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { OpsCollectDispute } from '@tipme/contracts';
import { Badge, EmptyWell, Skeleton } from '@tipme/ui';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import { DISPUTE_STATUS_WORDS, EVIDENCE_WORDS } from '@/lib/collect-ops-words';
import { when } from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/collect/disputes';

/** Disputes on tips TipMe collected (spec §9): open ones first, with the deadline; then history. */
export default function CollectDisputesPage() {
  const [rows, setRows] = useState<OpsCollectDispute[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const result = await opsFetch<OpsCollectDispute[]>(PATH);
    setFailed(!result.ok);
    if (result.ok) setRows(result.data);
  }, []);
  useEffect(() => {
    void opsFetch<OpsCollectDispute[]>(PATH).then((result) => {
      setFailed(!result.ok);
      if (result.ok) setRows(result.data);
    });
  }, []);
  return (
    <section className="dashboard-section ops-page-body">
      <h1>Disputes</h1>
      {failed && (
        <LoadFailed dense title="Couldn’t load the disputes" onRetry={load}>
          Your role may not include them, or the connection failed.
        </LoadFailed>
      )}
      {!rows && !failed && <Skeleton label="Loading disputes" />}
      {rows?.length === 0 && (
        <EmptyWell title="No disputes">
          <p>No tip TipMe collected has been disputed.</p>
        </EmptyWell>
      )}
      {rows && rows.length > 0 && (
        <ul className="ops-list" aria-label="Disputes">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/ops/collect/disputes/${row.id}`}
                className="ops-row"
              >
                <span className="ops-row__head">
                  <Badge>
                    {DISPUTE_STATUS_WORDS[row.status] ?? row.status}
                  </Badge>
                  <strong>{row.handle ? `@${row.handle}` : 'No page'}</strong>
                  <Money minor={row.amountMinor} />
                </span>
                <span>
                  {row.status === 'open'
                    ? row.respondBy
                      ? `Answer by ${when(row.respondBy)}`
                      : 'No deadline given'
                    : row.settledAt
                      ? `Settled ${when(row.settledAt)}`
                      : 'Not settled yet'}
                  {' · '}Evidence: {EVIDENCE_WORDS[row.evidenceState]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
