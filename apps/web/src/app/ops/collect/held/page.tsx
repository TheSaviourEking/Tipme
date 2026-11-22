'use client';
import { useCallback, useEffect, useState } from 'react';
import type { OpsCollectHeld } from '@tipme/contracts';
import { Badge, Card, EmptyWell, Skeleton } from '@tipme/ui';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import { PAUSED_WORDS, daysWords } from '@/lib/collect-ops-words';
import { when } from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/collect/held';

/**
 * Held money (spec §9): the total per currency is the ledger's own sum, then each recipient with
 * their amount, oldest tip, days left before their page pauses, reminders sent and whether it is
 * paused. Handles and amounts only.
 */
export default function CollectHeldPage() {
  const [state, setState] = useState<OpsCollectHeld | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const result = await opsFetch<OpsCollectHeld>(PATH);
    setFailed(!result.ok);
    if (result.ok) setState(result.data);
  }, []);
  useEffect(() => {
    void opsFetch<OpsCollectHeld>(PATH).then((result) => {
      setFailed(!result.ok);
      if (result.ok) setState(result.data);
    });
  }, []);
  return (
    <section className="dashboard-section ops-page-body">
      <h1>Held money</h1>
      {failed && (
        <LoadFailed dense title="Couldn’t load held money" onRetry={load}>
          Your role may not include it, or the connection failed.
        </LoadFailed>
      )}
      {!state && !failed && <Skeleton label="Loading held money" />}
      {state && (
        <>
          <div className="ops-tiles" data-testid="held-totals">
            {(state.totals.length
              ? state.totals
              : [{ currency: 'NGN', heldMinor: '0' }]
            ).map((total) => (
              <div className="ops-tile" key={total.currency}>
                <span className="ops-tile__label">
                  Total held, {total.currency}
                </span>
                <span className="ops-tile__value">
                  {total.currency === 'NGN' ? (
                    <Money minor={total.heldMinor} />
                  ) : (
                    <span className="money">{total.heldMinor}</span>
                  )}
                </span>
                <span className="ops-tile__previous">From the ledger</span>
              </div>
            ))}
          </div>
          <Card className="settings-section">
            <h2>Recipients</h2>
            {state.recipients.length === 0 ? (
              <EmptyWell title="Nothing held" headingLevel={3}>
                <p>TipMe holds no money for any recipient right now.</p>
              </EmptyWell>
            ) : (
              <div className="ops-table-wrap">
                <table
                  className="ops-table"
                  aria-label="Money held per recipient"
                >
                  <thead>
                    <tr>
                      <th scope="col">Recipient</th>
                      <th scope="col">Held</th>
                      <th scope="col">Oldest tip</th>
                      <th scope="col">Days left</th>
                      <th scope="col">Reminders</th>
                      <th scope="col">Page</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.recipients.map((row) => (
                      <tr key={row.profileId}>
                        <td>
                          {row.handle ? `@${row.handle}` : 'No page'}
                          {row.verified && (
                            <>
                              {' '}
                              <Badge>Verified</Badge>
                            </>
                          )}
                        </td>
                        <td>
                          <Money minor={row.heldMinor} />
                        </td>
                        <td>{row.oldestTipAt ? when(row.oldestTipAt) : '—'}</td>
                        <td>
                          {row.daysLeft === null
                            ? '—'
                            : daysWords(row.daysLeft)}
                        </td>
                        <td>{row.remindersSent}</td>
                        <td>
                          {row.pausedReason
                            ? PAUSED_WORDS[row.pausedReason]
                            : 'Taking tips'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {state.businesses.length > 0 && (
            <Card className="settings-section">
              <h2>Businesses</h2>
              <ul className="ops-list">
                {state.businesses.map((row) => (
                  <li key={row.businessId}>
                    {row.name ?? 'A business'} · <Money minor={row.heldMinor} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
