'use client';
import { useEffect, useState } from 'react';
import type { OpsMetricsEnvelope, OpsVisibility } from '@tipme/contracts';
import { Card, Notice, Skeleton } from '@tipme/ui';
import { BarChart, LineChart, Tile } from '@/components/ops/charts';
import { apiFetch } from '@/lib/session-client';

const CHANNELS: Record<string, string> = {
  qr: 'QR code',
  link: 'Shared link',
  instagram: 'Instagram',
  x: 'X',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  search: 'Search',
  direct: 'Direct',
  other: 'Other',
};
const SHARING: Record<string, string> = {
  qr_scanned: 'QR codes scanned',
  qr_downloaded: 'QR images saved',
  qr_printed: 'QR cards printed',
  recipient_shared_link: 'Links shared by recipients',
  report_shared: 'Weekly reports shared',
  moment_shared: 'Moments shared',
};
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
    new Date(`${iso}T12:00:00Z`),
  );

/** How people find recipients: arrivals, sharing and celebrations, over 28 days. */
export default function VisibilityPage() {
  const [data, setData] = useState<OpsMetricsEnvelope<OpsVisibility> | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void apiFetch<OpsMetricsEnvelope<OpsVisibility>>(
      '/v1/ops/metrics/visibility',
    ).then((result) => (result.ok ? setData(result.data) : setFailed(true)));
  }, []);
  if (failed)
    return (
      <Notice tone="error" title="Couldn’t load visibility">
        Your role may not include analytics, or the connection failed.
      </Notice>
    );
  if (!data) return <Skeleton label="Loading visibility" />;
  const v = data.metrics;
  const share =
    v.visits === 0
      ? '—'
      : `${Math.round((v.returningVisits / v.visits) * 100)}%`;
  return (
    <div className="ops-dashboard">
      <h1>Visibility</h1>
      <p className="tm-hint">
        {shortDate(v.from)} to {shortDate(v.to)} ({v.days} days). Anonymous: no
        names, numbers or ids that link visits together.
      </p>
      {!data.collecting && (
        <Notice tone="neutral" title="Anonymous collection is off">
          These numbers stay empty until the privacy decision (D-07) turns
          collection on.
        </Notice>
      )}
      <div className="ops-tiles">
        <Tile label="Visits" value={String(v.visits)} />
        <Tile
          label="From supporters who came back"
          value={share}
          previous="Only known for supporters who chose “Remember my tips”."
        />
        <Tile
          label="Tips added to celebrations"
          value={String(v.celebrationTips)}
        />
      </div>
      <Card className="settings-section">
        <LineChart
          title="Visits per day"
          unit="Visits"
          points={v.visitsPerDay.map((d) => ({
            label: shortDate(d.date),
            value: d.visits,
          }))}
        />
      </Card>
      <Card className="settings-section">
        <BarChart
          title="How visitors arrive"
          unit="Visits"
          rows={v.byChannel.map((c) => ({
            label: CHANNELS[c.channel] ?? c.channel,
            value: c.visits,
          }))}
        />
      </Card>
      <Card className="settings-section">
        <BarChart
          title="Sharing"
          unit="Times"
          rows={Object.entries(v.sharing).map(([name, value]) => ({
            label: SHARING[name] ?? name,
            value,
          }))}
        />
      </Card>
      <Card className="settings-section">
        <h2>Most visited pages</h2>
        <p className="tm-hint">Admin only; never published.</p>
        {v.topPages.length === 0 ? (
          <p className="tm-hint">No visits yet.</p>
        ) : (
          <ol className="ops-top">
            {v.topPages.map((page) => (
              <li key={page.handle}>
                <a href={`/@${page.handle}`}>@{page.handle}</a>{' '}
                <span className="tm-hint">{page.visits} visits</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
