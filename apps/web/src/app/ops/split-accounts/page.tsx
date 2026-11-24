'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type {
  OpsSplitAccount,
  OpsSplitAccountReading,
  OpsSplitAccounts,
} from '@tipme/contracts';
import { Badge, Button, EmptyWell, Skeleton, Slip } from '@tipme/ui';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import {
  PROVIDER_ROLE_LABELS,
  SPLIT_OUTCOME_LABELS,
  when,
} from '@/lib/ops-client';
import { opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/split-accounts';

const ownerKey = (item: OpsSplitAccount) =>
  item.owner.profileId ?? item.owner.businessId ?? '';

/**
 * Split accounts (per-provider balances, spec §7): each owner whose money is at more than one
 * configured payment provider, with the ledger's available, what is queued at each provider and the
 * last daily check. Staff may read each provider's balance now (audited). Staff screens may name
 * providers; users never see them.
 */
export default function SplitAccountsPage() {
  const [items, setItems] = useState<OpsSplitAccount[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const show = useCallback(
    (result: Awaited<ReturnType<typeof opsFetch<OpsSplitAccounts>>>) => {
      setFailed(!result.ok);
      if (result.ok) {
        setItems(result.data.items);
        setCursor(result.data.nextCursor);
      }
    },
    [],
  );
  const load = useCallback(
    async () => show(await opsFetch<OpsSplitAccounts>(PATH)),
    [show],
  );
  useEffect(() => {
    void opsFetch<OpsSplitAccounts>(PATH).then(show);
  }, [show]);
  const more = async () => {
    if (!cursor) return;
    const result = await opsFetch<OpsSplitAccounts>(
      `${PATH}?cursor=${encodeURIComponent(cursor)}`,
    );
    if (!result.ok) return setFailed(true);
    setItems((now) => [...(now ?? []), ...result.data.items]);
    setCursor(result.data.nextCursor);
  };

  return (
    <section className="dashboard-section ops-page-body">
      <h1>Split accounts</h1>
      <p>
        People and businesses whose money is held at more than one payment
        provider. Withdrawals are always capped by the ledger; each provider’s
        figures are read once a day, and you can read them now.
      </p>
      {failed && (
        <LoadFailed dense title="Couldn’t load split accounts" onRetry={load}>
          Your role may not include them, or the connection failed.
        </LoadFailed>
      )}
      {!items && !failed && <Skeleton label="Loading split accounts" />}
      {items?.length === 0 && (
        <EmptyWell title="No split accounts">
          <p>Everyone’s money is at one payment provider.</p>
        </EmptyWell>
      )}
      {items && items.length > 0 && (
        <div className="ops-table-wrap">
          <table
            className="ops-table ops-table--stack"
            aria-label="Split accounts"
          >
            <thead>
              <tr>
                <th scope="col">Owner</th>
                <th scope="col">Ledger available</th>
                <th scope="col">Providers</th>
                <th scope="col">Last check</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <SplitRow key={ownerKey(item)} item={item} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <Button variant="secondary" onClick={() => void more()}>
          Show more
        </Button>
      )}
    </section>
  );
}

function SplitRow({ item }: { item: OpsSplitAccount }) {
  const [reading, setReading] = useState<
    OpsSplitAccountReading[] | 'busy' | 'failed' | null
  >(null);
  const business = Boolean(item.owner.businessId);
  const name = item.owner.handle
    ? `${business ? '' : '@'}${item.owner.handle}`
    : business
      ? 'A business'
      : 'No page';
  const read = async () => {
    setReading('busy');
    const result = await opsFetch<OpsSplitAccountReading[]>(`${PATH}/read`, {
      method: 'POST',
      body: business
        ? { businessId: item.owner.businessId }
        : { profileId: item.owner.profileId },
    });
    setReading(result.ok ? result.data : 'failed');
  };
  const now = Array.isArray(reading)
    ? new Map(reading.map((row) => [row.provider, row.availableMinor]))
    : null;
  return (
    <tr data-testid="split-account">
      <td data-label="Owner">
        <span className="ops-split-owner">
          <strong>{name}</strong>
          {business && <Badge>Business</Badge>}
        </span>
      </td>
      <td data-label="Ledger available">
        <Money minor={item.ledgerMinor} />
      </td>
      <td data-label="Providers">
        <ul className="ops-split-providers">
          {item.providers.map((row) => (
            <li key={row.provider}>
              <span className="ops-split-providers__name">
                <span className="ops-mono">{row.provider}</span>
                <Badge>{PROVIDER_ROLE_LABELS[row.role] ?? row.role}</Badge>
              </span>
              <span className="tm-hint">
                Queued <Money minor={row.queuedMinor} />
                {now && (
                  <>
                    {' · holds '}
                    {now.get(row.provider) == null ? (
                      'couldn’t be read'
                    ) : (
                      <Money minor={now.get(row.provider)!} />
                    )}
                    {' now'}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </td>
      <td data-label="Last check">
        <CheckResult item={item} />
      </td>
      <td className="ops-table__action">
        <Button
          variant="secondary"
          className="ops-split-read"
          disabled={reading === 'busy'}
          onClick={() => void read()}
        >
          {reading === 'busy' ? 'Reading…' : 'Read balances now'}
        </Button>
        {reading === 'failed' && (
          <Slip dense tone="error" title="Couldn’t read the balances">
            Please try again in a minute.
          </Slip>
        )}
      </td>
    </tr>
  );
}

/**
 * The latest daily check. A short check opens an issue only when its re-read agrees, so a short
 * with no open issue says it wasn't confirmed, rather than leaving staff to look for one.
 */
function CheckResult({ item }: { item: OpsSplitAccount }) {
  const check = item.lastCheck;
  if (!check) return <span className="tm-hint">Not checked yet</span>;
  return (
    <span className="ops-split-check">
      <span className="ops-split-providers__name">
        <Badge>{SPLIT_OUTCOME_LABELS[check.outcome] ?? check.outcome}</Badge>
        <span className="tm-hint">{when(check.checkedAt)}</span>
      </span>
      {check.outcome === 'short' &&
        (item.openIssueId ? (
          <Link href={`/ops/issues/${item.openIssueId}`}>
            See the open issue
          </Link>
        ) : (
          <span className="tm-hint">
            No open issue: not confirmed on recheck, or already resolved
          </span>
        ))}
    </span>
  );
}
