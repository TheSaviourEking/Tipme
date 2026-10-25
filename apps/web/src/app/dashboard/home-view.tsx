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
import { TrendChart } from '@/components/dashboard/trend-chart';
import { change, naira } from '@/lib/money';
import { recipientReturned, track } from '@/lib/analytics';
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
  const { profile } = useRecipient();
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

  return (
    <div className="dashboard-home">
      <h1>Hello, {firstName}</h1>
      <section className="balance-card" aria-labelledby="balance-label">
        <span id="balance-label">Your balance</span>
        <strong data-testid="balance">{naira(summary.availableMinor)}</strong>
        {summary.confirmingMinor !== '0' && (
          <span>{naira(summary.confirmingMinor)} still being confirmed</span>
        )}
      </section>
      {firstDay ? (
        <Card className="first-day">
          <h2>Show your QR to get your first tip</h2>
          <p>
            Put your code on the counter, or show it on your phone. Your tips
            will appear here.
          </p>
          <Link className="tm-button tm-button--primary" href="/dashboard/qr">
            Show my QR
          </Link>
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
      <Moments />
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
      <nav className="dashboard-actions" aria-label="Actions">
        <Link href="/dashboard/qr">Show my QR</Link>
        <Button variant="secondary" onClick={() => void share()}>
          Share link
        </Button>
        <Link href="/dashboard/withdraw">Withdraw</Link>
      </nav>
      <p role="status" className="tm-hint">
        {shared}
      </p>
      {!firstDay && (
        <section aria-labelledby="recent-title">
          <h2 id="recent-title">Recent</h2>
          <ActivityList rows={activity} />
          <Link href="/dashboard/tips">See all tips</Link>
        </section>
      )}
    </div>
  );
}
