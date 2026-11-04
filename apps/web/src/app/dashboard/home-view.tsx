'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  ActivityRow,
  DashboardSummary,
  WeeklyReportData,
} from '@tipme/contracts';
import { Button, Notice, Skeleton } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { ActivityList } from '@/components/dashboard/activity-list';
import { Moments } from '@/components/dashboard/moments';
import { PageCard } from '@/components/dashboard/page-card';
import { TrendChart } from '@/components/dashboard/trend-chart';
import { usePanel } from '@/components/dashboard/use-panel';
import { change, naira } from '@/lib/money';
import { recipientReturned, track } from '@/lib/analytics';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { isPaymentAttention } from '@/lib/owner-attention';

function Tile({
  label,
  current,
  previous,
  versus,
}: {
  label: string;
  current: string;
  previous: string;
  versus: string;
}) {
  const delta = change(current, previous);
  return (
    <div className="perf-tile">
      <span>{label}</span>
      <strong>{naira(current)}</strong>
      <span className={`perf-tile__change perf-tile__change--${delta.tone}`}>
        {delta.text}
        {delta.text !== '—' && delta.text !== 'New' && (
          <span className="sr-only"> compared with</span>
        )}
      </span>{' '}
      <span className="tm-hint">{versus}</span>
    </div>
  );
}

export default function DashboardHome() {
  const { profile, attention, paymentsNeedSetup } = useRecipient();
  const copy = paymentModeCopy(usePaymentMode());
  // One loader per panel: each returns its data, an error and reload(), so a later live stream
  // can call reload() without reworking this page.
  const balance = usePanel<DashboardSummary>('/v1/me/dashboard');
  const recent = usePanel<ActivityRow[]>('/v1/me/activity');
  const week =
    usePanel<{ week: string; data: WeeklyReportData }[]>('/v1/me/reports');
  const summary = balance.data;
  const activity = recent.data;
  const latestWeek = week.data?.[0] ?? null;
  const [shared, setShared] = useState('');
  const firstName = profile.displayName.split(/\s+/)[0];

  // A recipient coming back counts once per Lagos day per browser, with no handle or id.
  useEffect(recipientReturned, []);

  const share = async () => {
    const url = `${location.origin}/@${profile.handle}`;
    track('recipient_shared_link', { surface: 'dashboard' });
    try {
      if (navigator.share)
        await navigator.share({ title: `Tip ${firstName} on TipMe`, url });
      else {
        await navigator.clipboard.writeText(url);
        setShared('Link copied');
      }
    } catch {
      // The supporter closed the share sheet.
    }
  };

  // Only a first load that failed blanks the page; a failed refresh keeps the last numbers.
  if (balance.error === 'load' || recent.error === 'load')
    return (
      <Notice tone="error" title="We couldn’t load your dashboard">
        Please reload the page.
      </Notice>
    );
  if (!summary || !activity) return <Skeleton label="Loading your numbers" />;
  const firstDay = activity.length === 0 && summary.availableMinor === '0';
  const profileDetailsComplete =
    profile.displayName !== profile.handle &&
    Boolean(profile.role?.trim() || profile.bio?.trim());
  // The first payment-related notice, if any (they are listed most urgent first).
  const paymentTodo = attention?.find(isPaymentAttention);
  const pageReady =
    profileDetailsComplete && profile.pageState === 'live' && !paymentTodo;
  const live = profile.pageState === 'live';
  const refreshFailed =
    balance.error === 'refresh' || recent.error === 'refresh';
  // Pending money is named only when the API reports some, and is never counted as available.
  const pending = summary.confirmingMinor !== '0';

  const shareStatus = (
    <p role="status" className="tm-hint dashboard-share-status">
      {shared}
    </p>
  );
  const refreshNote = refreshFailed && (
    <p className="tm-hint dashboard-refresh-note">Couldn’t refresh</p>
  );

  return (
    <div className="dashboard-home">
      <div className="dashboard-home__main">
        {firstDay ? (
          <section className="first-day recipient-setup" aria-labelledby="next">
            <div>
              <h1 id="next">
                {pageReady
                  ? 'Your page is ready to share'
                  : 'Get your page ready to share'}
              </h1>
              <p>
                {pageReady
                  ? 'Your page is live. Share your link or QR code so supporters can find you.'
                  : 'Set up the page supporters will see, then share your link or QR code.'}
              </p>
            </div>
            <ol className="recipient-setup__steps">
              <li>
                <div>
                  <strong>Make your page feel like you</strong>
                  <p>
                    Add what you do and a short introduction. A photo is
                    optional.
                  </p>
                </div>
                {profileDetailsComplete ? (
                  <span className="recipient-setup__done">Done</span>
                ) : (
                  <Link href="/dashboard/settings">Edit page</Link>
                )}
              </li>
              <li>
                <div>
                  <strong>Put your page online</strong>
                  <p>You can take it offline again whenever you want.</p>
                </div>
                {live ? (
                  <span className="recipient-setup__done">Live</span>
                ) : (
                  <Link
                    className="tm-button tm-button--continue"
                    href="/dashboard/settings"
                  >
                    Go live
                  </Link>
                )}
              </li>
              {/* Nothing until known, so the step never flips from one story to another. */}
              {paymentsNeedSetup === null ? null : paymentsNeedSetup ? (
                <li>
                  <div>
                    <strong>Set up payments</strong>
                    <p>
                      {paymentTodo
                        ? paymentTodo.body
                        : copy.dashboardPaymentStep}
                    </p>
                  </div>
                  {paymentTodo ? (
                    paymentTodo.action ? (
                      <Link href={paymentTodo.action.href}>
                        {paymentTodo.action.label}
                      </Link>
                    ) : (
                      <span>
                        {paymentTodo.id === 'payments_checking'
                          ? 'Checking'
                          : 'To do'}
                      </span>
                    )
                  ) : (
                    <span className="recipient-setup__done">Done</span>
                  )}
                </li>
              ) : (
                <li>
                  <div>
                    <strong>Set up payments and payouts</strong>
                    <p>
                      Account setup is not available yet. Real payments and
                      payouts remain disabled until provider and funds-flow
                      approvals are complete.
                    </p>
                  </div>
                  <span>Coming later</span>
                </li>
              )}
              <li className={live ? undefined : 'recipient-setup__later'}>
                <div>
                  <strong>Share your link or QR</strong>
                  <p>Let people know where to send their thanks.</p>
                </div>
                {live ? (
                  <Link href="/dashboard/qr">Sharing tools</Link>
                ) : (
                  <span>After going live</span>
                )}
              </li>
            </ol>
          </section>
        ) : (
          <>
            <header className="dashboard-greeting">
              <p>Hello, {firstName}.</p>
            </header>
            {/* The balance as an object, with the things you do with it inside. */}
            <section className="balance-card" aria-labelledby="balance-label">
              <div className="balance-card__figures">
                <h1 id="balance-label" className="balance-card__label">
                  Ready to withdraw
                </h1>
                {/* One element, never animated: a refetch must not imply money that is not confirmed. */}
                <strong data-testid="balance">
                  {naira(summary.availableMinor)}
                </strong>
                {pending && (
                  <span className="balance-card__note">
                    {naira(summary.confirmingMinor)} still being confirmed
                  </span>
                )}
                {refreshNote}
              </div>
              <nav className="dashboard-actions" aria-label="Actions">
                <Link
                  className="tm-button tm-button--continue balance-card__withdraw"
                  href="/dashboard/withdraw"
                >
                  Withdraw
                </Link>
                <Button variant="secondary" onClick={() => void share()}>
                  Share link
                </Button>
                <Link
                  className="tm-button tm-button--secondary"
                  href="/dashboard/qr"
                >
                  Show QR
                </Link>
              </nav>
              {shareStatus}
            </section>
            <section
              aria-labelledby="performance-title"
              className="performance"
            >
              <h2 id="performance-title" className="sr-only">
                Your numbers
              </h2>
              <div className="perf-tiles">
                <Tile
                  label="Today"
                  current={summary.today}
                  previous={summary.yesterday}
                  versus="vs yesterday"
                />
                <Tile
                  label="This week"
                  current={summary.thisWeek}
                  previous={summary.lastWeek}
                  versus="vs last week"
                />
              </div>
              <TrendChart days={summary.last7Days} />
            </section>
            <section
              aria-labelledby="recent-title"
              className="dashboard-recent"
            >
              <div className="dashboard-recent__head">
                <h2 id="recent-title">Your thanks</h2>
                <Link href="/dashboard/tips">See all tips</Link>
              </div>
              <ActivityList rows={activity} />
            </section>
          </>
        )}
      </div>
      <aside className="dashboard-home__side" aria-label="Your page">
        <PageCard profile={profile} />
        {firstDay && (
          <div className="first-day-balance">
            <span>Your balance:</span>{' '}
            <strong data-testid="balance">
              {naira(summary.availableMinor)}
            </strong>
            {shareStatus}
          </div>
        )}
        {latestWeek && (
          <Link
            className="week-teaser"
            href={`/dashboard/reports/${latestWeek.week}`}
          >
            <strong>Your week · {latestWeek.week}</strong>
            <span>
              {naira(latestWeek.data.totalNetMinor)} from{' '}
              {latestWeek.data.tipCount}{' '}
              {latestWeek.data.tipCount === 1 ? 'tip' : 'tips'}
              <b>See your week</b>
            </span>
          </Link>
        )}
        <Moments />
      </aside>
    </div>
  );
}
