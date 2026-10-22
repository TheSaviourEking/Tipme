'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  OpsHealth,
  OpsMetricsEnvelope,
  WebVitalSummary,
} from '@tipme/contracts';
import { Notice, Skeleton } from '@tipme/ui';
import { Funnel, Tile } from '@/components/ops/charts';
import { change, naira } from '@/lib/money';
import { apiFetch } from '@/lib/session-client';

const count = (n: { thisWeek: number; lastWeek: number }) => ({
  value: String(n.thisWeek),
  previous: `Last week ${n.lastWeek}`,
});
const amount = (n: { thisWeek: string; lastWeek: string }) => ({
  value: naira(n.thisWeek),
  previous: `Last week ${naira(n.lastWeek)}`,
});
const percent = (rate: number | null) =>
  rate === null ? '—' : `${Math.round(rate * 1000) / 10}%`;
const duration = (seconds: number | null) =>
  seconds === null
    ? '—'
    : seconds < 120
      ? `${seconds} s`
      : `${Math.round(seconds / 60)} min`;

const vitalNames: Record<WebVitalSummary['metric'], string> = {
  LCP: 'Largest paint (LCP)',
  INP: 'Response to taps (INP)',
  CLS: 'Layout shift (CLS)',
  FCP: 'First paint (FCP)',
  TTFB: 'Server response (TTFB)',
};
const vitalValue = (metric: WebVitalSummary['metric'], value: number | null) =>
  value === null
    ? '—'
    : metric === 'CLS'
      ? value.toFixed(3)
      : value >= 1000
        ? `${(value / 1000).toFixed(2)} s`
        : `${value} ms`;

/** Overall health: money, the tipping funnel, reliability and recipients, this week vs last. */
export default function OpsOverviewPage() {
  const [health, setHealth] = useState<OpsMetricsEnvelope<OpsHealth> | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void apiFetch<OpsMetricsEnvelope<OpsHealth>>('/v1/ops/metrics/health').then(
      (result) => (result.ok ? setHealth(result.data) : setFailed(true)),
    );
  }, []);
  if (failed)
    return (
      <Notice tone="error" title="Couldn’t load the overview">
        Your role may not include analytics, or the connection failed.{' '}
        <Link href="/ops/issues">Go to the issues inbox</Link>
      </Notice>
    );
  if (!health) return <Skeleton label="Loading the overview" />;
  // An API older than PR-011 sends no web vitals (the web app deploys first).
  const {
    money,
    reliability,
    recipients,
    funnel,
    webVitals = [],
  } = health.metrics;
  const tips = change(
    String(money.tipCount.thisWeek),
    String(money.tipCount.lastWeek),
  );
  const open =
    reliability.openIssues.money +
    reliability.openIssues.account +
    reliability.openIssues.info;
  return (
    <div className="ops-dashboard">
      <h1>Overview</h1>
      <p className="tm-hint">
        This week (from Monday, Lagos time) against all of last week. Pretend
        money only.
      </p>
      {!health.collecting && (
        <Notice tone="neutral" title="Anonymous collection is off">
          The funnel stays empty until the privacy decision (D-07) turns it on.
          Money, reliability and recipient numbers still come from TipMe’s own
          records.
        </Notice>
      )}
      <section aria-labelledby="ops-money" className="dashboard-section">
        <h2 id="ops-money">Money</h2>
        <div className="ops-tiles">
          <Tile
            label="Tips paid"
            {...count(money.tipCount)}
            previous={`Last week ${money.tipCount.lastWeek} · ${tips.text}`}
          />
          <Tile label="Amount tipped" {...amount(money.grossMinor)} />
          <Tile
            // Since PR-012, what TipMe keeps after paying processing out of its 10%.
            label="TipMe keeps (after processing)"
            {...amount(money.platformFeeMinor)}
          />
          <Tile label="Reward cost" {...amount(money.rewardCostMinor)} />
        </div>
      </section>
      <section aria-labelledby="ops-funnel" className="dashboard-section">
        <h2 id="ops-funnel">Tipping funnel</h2>
        <Funnel
          title="Tipping funnel this week"
          steps={[
            { label: 'Visits', value: funnel.visits },
            { label: 'Amount chosen', value: funnel.amountSelected },
            { label: 'Payment started', value: funnel.paymentStarted },
            { label: 'Paid', value: funnel.tipsCompleted },
          ]}
        />
      </section>
      <section aria-labelledby="ops-reliability" className="dashboard-section">
        <h2 id="ops-reliability">Reliability</h2>
        <div className="ops-tiles">
          <Tile
            label="Declined"
            value={percent(reliability.declinedRate.thisWeek)}
            previous={`Last week ${percent(reliability.declinedRate.lastWeek)}`}
          />
          <Tile
            label="Median time to confirm"
            value={duration(reliability.medianConfirmSeconds.thisWeek)}
            previous={`Last week ${duration(reliability.medianConfirmSeconds.lastWeek)}`}
          />
          <Tile
            label="Stuck confirming now"
            value={String(reliability.stuckNow)}
          />
          <Tile
            label="Open issues"
            value={String(open)}
            previous={`${reliability.openIssues.money} money · ${reliability.openIssues.account} account · ${reliability.openIssues.info} info`}
          />
        </div>
        <p>
          <Link href="/ops/issues">Go to the issues inbox</Link>
        </p>
      </section>
      {webVitals.length > 0 && (
        <section aria-labelledby="ops-vitals" className="dashboard-section">
          <h2 id="ops-vitals">Page speed (real visits)</h2>
          <p className="tm-hint">
            75th percentile on phones over the last 28 days, against the launch
            budgets.
          </p>
          <div className="ops-tiles">
            {webVitals.map((vital) => (
              <Tile
                key={vital.metric}
                label={vitalNames[vital.metric]}
                value={vitalValue(vital.metric, vital.p75)}
                previous={[
                  vital.budget === null
                    ? 'No budget'
                    : `Budget ${vitalValue(vital.metric, vital.budget)}`,
                  vital.withinBudget === null
                    ? null
                    : vital.withinBudget
                      ? 'within budget'
                      : 'over budget',
                  `${vital.samples} visits`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby="ops-recipients" className="dashboard-section">
        <h2 id="ops-recipients">Recipients</h2>
        <div className="ops-tiles">
          <Tile label="New sign-ups" {...count(recipients.newSignups)} />
          <Tile label="New pages" {...count(recipients.newPages)} />
          <Tile label="Live pages now" value={String(recipients.livePages)} />
          <Tile
            label="Recipients tipped"
            {...count(recipients.recipientsTipped)}
          />
          <Tile
            label="Tipped both weeks"
            value={String(recipients.recipientsReturning)}
          />
        </div>
      </section>
    </div>
  );
}
