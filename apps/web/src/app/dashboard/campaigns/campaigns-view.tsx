'use client';
import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import type { CampaignList, CampaignResults } from '@tipme/contracts';
import { Card, Notice, Skeleton } from '@tipme/ui';
import { usePanel } from '@/components/dashboard/use-panel';
import { campaignLink } from '@/lib/campaign-link';
import { naira } from '@/lib/money';

const noSubscription = () => () => undefined;
export const useOrigin = () =>
  useSyncExternalStore(
    noSubscription,
    () => location.origin,
    () => '',
  );

const SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
/** "12 Oct" in Lagos time. */
export function madeOn(iso: string): string {
  const local = new Date(Date.parse(iso) + 3_600_000);
  return `${local.getUTCDate()} ${SHORT[local.getUTCMonth()] ?? ''}`;
}

/** Counts only. Under 3 tips the API sends neither the count nor the amount. */
export function ResultCells({ results }: { results: CampaignResults }) {
  return (
    <>
      <td className="n">{results.visits ?? 'Not counted yet'}</td>
      <td className="n">{results.tips ?? 'Fewer than 3'}</td>
      <td className="n">
        {results.receivedNetMinor === null ? (
          <span className="tm-hint">Hidden</span>
        ) : (
          <b>{naira(results.receivedNetMinor)}</b>
        )}
      </td>
    </>
  );
}

export default function CampaignsPage() {
  const origin = useOrigin();
  const panel = usePanel<CampaignList>('/v1/me/campaigns', {
    live: ['tips.changed'],
  });
  const [showStopped, setShowStopped] = useState(false);
  const list = panel.data;
  if (panel.error === 'load' && !list)
    return (
      <Notice tone="error" title="We couldn’t load your campaigns">
        Please reload the page.
      </Notice>
    );
  if (!list) return <Skeleton label="Loading your campaigns" />;
  const running = list.campaigns.filter((c) => !c.stoppedAt);
  const stopped = list.campaigns.filter((c) => c.stoppedAt);
  const rows = showStopped ? list.campaigns : running;
  const full = list.used >= list.limit;
  return (
    <div className="dashboard-section campaigns">
      <header className="campaigns-head">
        <div>
          <h1>Campaigns</h1>
          <p className="tm-hint">
            A link and QR code for each place you share. {list.used} of{' '}
            {list.limit} used.
          </p>
        </div>
        {full ? (
          <p className="tm-hint campaigns-full">
            {list.limit === 1
              ? 'Free pages have 1 campaign. Stop it to make another, or get up to 20 with TipMe Pro.'
              : 'You’ve used all your campaigns. Stop one to make another.'}
          </p>
        ) : (
          <Link
            className="tm-button tm-button--continue"
            href="/dashboard/campaigns/new"
          >
            New campaign
          </Link>
        )}
      </header>
      <Card className="campaigns-card">
        <div className="campaigns-table-wrap">
          <table className="campaigns-table">
            <caption>Last 30 days</caption>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Link</th>
                <th scope="col" className="n">
                  Visits
                </th>
                <th scope="col" className="n">
                  Tips
                </th>
                <th scope="col" className="n">
                  Received
                </th>
                <th scope="col">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((campaign) => (
                <tr key={campaign.id}>
                  <th scope="row">
                    <b>{campaign.name}</b>
                    <small>
                      Made {madeOn(campaign.createdAt)}
                      {campaign.stoppedAt
                        ? ` · Stopped ${madeOn(campaign.stoppedAt)}`
                        : ''}
                    </small>
                  </th>
                  <td className="tm-hint campaigns-link">
                    {origin
                      ? campaignLink(origin, list.handle, campaign.slug).label
                      : `/@${list.handle}/${campaign.slug}`}
                  </td>
                  <ResultCells results={campaign} />
                  <td className="n">
                    <Link
                      href={`/dashboard/campaigns/${campaign.id}`}
                      aria-label={`Open ${campaign.name}`}
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
              <tr className="campaigns-plain">
                <th scope="row">
                  <b>Your page link</b>
                  <small>Not from a campaign</small>
                </th>
                <td className="tm-hint campaigns-link">
                  {origin
                    ? `${origin.replace(/^https?:\/\//, '')}/@${list.handle}`
                    : `/@${list.handle}`}
                </td>
                <ResultCells results={list.pageLink} />
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        {stopped.length > 0 && (
          <p className="tm-hint">
            Stopped campaigns: {stopped.length} ·{' '}
            <button
              type="button"
              className="campaigns-show"
              aria-expanded={showStopped}
              onClick={() => setShowStopped(!showStopped)}
            >
              {showStopped ? 'Hide' : 'Show'}
            </button>
          </p>
        )}
      </Card>
      <p className="tm-hint">
        Counts only. TipMe doesn’t know who opened a link, and a tip’s supporter
        isn’t shown here. Under 3 tips shows “Fewer than 3”, so no single
        supporter can be picked out.
      </p>
    </div>
  );
}
