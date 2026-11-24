'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { OpsCollectReserve } from '@tipme/contracts';
import { Badge, Card, EmptyWell, Skeleton } from '@tipme/ui';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import { RESERVE_LEVEL_WORDS } from '@/lib/collect-ops-words';
import { when } from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/collect/reserve';

/** What the latest check found of the payout schedule (I1): never "off" for an unread one. */
const SCHEDULE_WORDS: Record<
  OpsCollectReserve['autoPayouts'][number]['state'],
  string
> = {
  auto: 'Automatic payouts are on',
  manual: 'Automatic payouts are off',
  unread: 'Automatic payouts: couldn’t be read',
  not_checked: 'Automatic payouts: not checked (You collect isn’t in use)',
};
const SCHEDULE_HINTS: Partial<Record<keyof typeof SCHEDULE_WORDS, string>> = {
  auto: 'Turn them off in the partner dashboard: held money could leave with TipMe’s earnings.',
  unread:
    'Nobody can tell whether they are on. Check the payout setting in the partner dashboard.',
};

/** An amount in its currency: naira as everywhere, another currency in its minor units' value. */
function Amount({ minor, currency }: { minor: string; currency: string }) {
  if (currency === 'NGN') return <Money minor={minor} />;
  const value = Number(BigInt(minor)) / 100;
  return (
    <span className="money">
      {currency} {value.toLocaleString('en', { minimumFractionDigits: 2 })}
    </span>
  );
}

/**
 * The reserve (Task 15 follow-up, Task 11, spec §4 and §6.3): per currency, what the partner's
 * balance had available at the latest check, what TipMe holds for recipients, TipMe's own money (the
 * difference) and its level; whether automatic payouts are on; and the open reserve issues. Reads only:
 * acting on it (topping up, turning payouts off) happens at the partner and in Issues.
 */
export default function CollectReservePage() {
  const [state, setState] = useState<OpsCollectReserve | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const result = await opsFetch<OpsCollectReserve>(PATH);
    setFailed(!result.ok);
    if (result.ok) setState(result.data);
  }, []);
  useEffect(() => {
    void opsFetch<OpsCollectReserve>(PATH).then((result) => {
      setFailed(!result.ok);
      if (result.ok) setState(result.data);
    });
  }, []);
  return (
    <section className="dashboard-section ops-page-body">
      <h1>Reserve</h1>
      <p className="tm-hint">
        TipMe’s balance at its payment partner must always cover what it holds
        for recipients. What is left over is TipMe’s own money, for refunds,
        dispute fees and payout fees.
      </p>
      {failed && (
        <LoadFailed dense title="Couldn’t load the reserve" onRetry={load}>
          Your role may not include it, or the connection failed.
        </LoadFailed>
      )}
      {!state && !failed && <Skeleton label="Loading the reserve" />}
      {state && state.currencies.length === 0 && (
        <EmptyWell title="No reading yet">
          <p>
            The reserve is read every 15 minutes once You collect is in use.
          </p>
        </EmptyWell>
      )}
      {state && state.currencies.length > 0 && (
        <div className="ops-tiles">
          {state.currencies.map((row) => (
            <div
              className="ops-tile"
              key={`${row.provider}-${row.currency}`}
              data-testid={`reserve-${row.currency}`}
            >
              <span className="ops-tile__label">
                TipMe’s own money, {row.currency}
              </span>
              <span className="ops-tile__value">
                {row.ownMinor === null ? (
                  '—'
                ) : (
                  <Amount minor={row.ownMinor} currency={row.currency} />
                )}
              </span>
              <span>
                <Badge
                  className={`ops-reserve-level ops-reserve-level--${row.level}`}
                >
                  {RESERVE_LEVEL_WORDS[row.level]}
                </Badge>
              </span>
              <span className="ops-tile__previous">
                Available{' '}
                {row.availableMinor === null ? (
                  '—'
                ) : (
                  <Amount minor={row.availableMinor} currency={row.currency} />
                )}{' '}
                · held for recipients{' '}
                <Amount minor={row.heldMinor} currency={row.currency} />
              </span>
              {row.warningMinor !== '0' && (
                <span className="ops-tile__previous">
                  Warning below{' '}
                  <Amount minor={row.warningMinor} currency={row.currency} />,
                  critical below{' '}
                  <Amount minor={row.criticalMinor} currency={row.currency} />
                </span>
              )}
              <span className="ops-tile__previous">
                {row.provider} · read {when(row.readAt)}
              </span>
            </div>
          ))}
        </div>
      )}
      {state && (
        <Card className="settings-section">
          <h2>Automatic payouts</h2>
          <div data-testid="auto-payouts">
            {state.autoPayouts.length === 0 ? (
              <p className="tm-hint">Not read yet.</p>
            ) : (
              state.autoPayouts.map((row) => (
                <p key={row.provider} data-testid={`schedule-${row.state}`}>
                  <strong>{SCHEDULE_WORDS[row.state]}</strong> for TipMe’s own
                  balance at {row.provider}, as of {when(row.readAt)}.
                  {SCHEDULE_HINTS[row.state]
                    ? ` ${SCHEDULE_HINTS[row.state]}`
                    : ''}
                </p>
              ))
            )}
          </div>
        </Card>
      )}
      {state && (
        <Card className="settings-section">
          <h2>Open reserve issues</h2>
          {state.issues.length === 0 ? (
            <EmptyWell title="None open" headingLevel={3}>
              <p>Nothing about the reserve needs a person now.</p>
            </EmptyWell>
          ) : (
            <ul className="ops-list" aria-label="Open reserve issues">
              {state.issues.map((issue) => (
                <li key={issue.id}>
                  <Link href={`/ops/issues/${issue.id}`} className="ops-row">
                    <span className="tm-hint">
                      Opened {when(issue.openedAt)}
                    </span>
                    <span>{issue.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </section>
  );
}
