'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  ActivityRow,
  DashboardSummary,
  WeeklyReportData,
} from '@tipme/contracts';
import { Button, Card, Notice, Skeleton } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { ActivityList } from '@/components/dashboard/activity-list';
import { Moments } from '@/components/dashboard/moments';
import { PageCard } from '@/components/dashboard/page-card';
import { TrendChart } from '@/components/dashboard/trend-chart';
import { change, naira } from '@/lib/money';
import { recipientReturned, track } from '@/lib/analytics';
import { isPaymentAttention } from '@/lib/owner-attention';
import { apiFetch } from '@/lib/session-client';

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
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [latestWeek, setLatestWeek] = useState<{
    week: string;
    data: WeeklyReportData;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [shared, setShared] = useState('');
  const firstName = profile.displayName.split(/\s+/)[0];

  // A recipient coming back counts once per Lagos day per browser, with no handle or id.
  useEffect(recipientReturned, []);
  useEffect(() => {
    void Promise.all([
      apiFetch<DashboardSummary>('/v1/me/dashboard'),
      apiFetch<ActivityRow[]>('/v1/me/activity'),
      apiFetch<{ week: string; data: WeeklyReportData }[]>('/v1/me/reports'),
    ]).then(([s, a, r]) => {
      if (r.ok) setLatestWeek(r.data[0] ?? null);
      if (s.ok && a.ok) {
        setSummary(s.data);
        setActivity(a.data);
      } else setFailed(true);
    });
  }, []);

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

  if (failed)
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

  return (
    <div className="dashboard-home">
      <div className="dashboard-home__main">
        <header className="dashboard-greeting">
          <h1>Hello, {firstName}.</h1>
          <p>Here’s how your page is doing.</p>
        </header>
        {/* The balance as an object, with the things you do with it inside. */}
        <section className="balance-card" aria-labelledby="balance-label">
          <span id="balance-label" className="balance-card__label">
            Your balance
          </span>
          <strong data-testid="balance">{naira(summary.availableMinor)}</strong>
          {summary.confirmingMinor !== '0' && (
            <span className="balance-card__note">
              {naira(summary.confirmingMinor)} still being confirmed
            </span>
          )}
          <nav className="dashboard-actions" aria-label="Actions">
            <Link
              className="tm-button tm-button--primary balance-card__withdraw"
              href="/dashboard/withdraw"
            >
              Withdraw
            </Link>
            <Link
              className="tm-button tm-button--secondary"
              href="/dashboard/qr"
            >
              Show my QR
            </Link>
            <Button variant="secondary" onClick={() => void share()}>
              Share link
            </Button>
          </nav>
          <p role="status" className="tm-hint">
            {shared}
          </p>
        </section>
        {firstDay ? (
          <Card className="first-day recipient-setup">
            <div>
              <p className="eyebrow">Your next steps</p>
              <h2>
                {pageReady
                  ? 'Your page is ready to share'
                  : 'Get your page ready to share'}
              </h2>
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
                <span>{profileDetailsComplete ? 'Done' : 'To do'}</span>
                {!profileDetailsComplete && (
                  <Link href="/dashboard/settings">Edit page</Link>
                )}
              </li>
              <li>
                <div>
                  <strong>Put your page online</strong>
                  <p>You can take it offline again whenever you want.</p>
                </div>
                <span>{profile.pageState === 'live' ? 'Live' : 'To do'}</span>
                {profile.pageState !== 'live' && (
                  <Link href="/dashboard/settings">Page settings</Link>
                )}
              </li>
              <li>
                <div>
                  <strong>Share your link or QR</strong>
                  <p>Let people know where to send their thanks.</p>
                </div>
                <span>
                  {profile.pageState === 'live' ? 'Next' : 'After publishing'}
                </span>
                <Link href="/dashboard/qr">Sharing tools</Link>
              </li>
              {/* Nothing until known, so the step never flips from one story to another. */}
              {paymentsNeedSetup === null ? null : paymentsNeedSetup ? (
                <li>
                  <div>
                    <strong>Set up payments</strong>
                    <p>
                      {paymentTodo
                        ? paymentTodo.body
                        : 'Supporters can tip you. No real money moves in test mode.'}
                    </p>
                  </div>
                  <span>
                    {!paymentTodo
                      ? 'Done'
                      : paymentTodo.id === 'payments_checking'
                        ? 'Checking'
                        : 'To do'}
                  </span>
                  {paymentTodo?.action && (
                    <Link href={paymentTodo.action.href}>
                      {paymentTodo.action.label}
                    </Link>
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
            </ol>
          </Card>
        ) : (
          <section aria-labelledby="performance-title" className="performance">
            <h2 id="performance-title" className="sr-only">
              How you’re doing
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
        )}
        {!firstDay && (
          <section aria-labelledby="recent-title" className="dashboard-recent">
            <div className="dashboard-recent__head">
              <h2 id="recent-title">Recent tips</h2>
              <Link href="/dashboard/tips">See all tips</Link>
            </div>
            <ActivityList rows={activity} />
          </section>
        )}
      </div>
      <aside className="dashboard-home__side" aria-label="Your page">
        <PageCard profile={profile} />
        {latestWeek && (
          <Link
            className="week-teaser"
            href={`/dashboard/reports/${latestWeek.week}`}
          >
            <strong>Your week · {latestWeek.week}</strong>
            <span>
              {naira(latestWeek.data.totalNetMinor)} from{' '}
              {latestWeek.data.tipCount}{' '}
              {latestWeek.data.tipCount === 1 ? 'tip' : 'tips'} →
            </span>
          </Link>
        )}
        <Moments />
      </aside>
    </div>
  );
}
