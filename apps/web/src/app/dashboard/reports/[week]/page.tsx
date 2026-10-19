'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { WeeklyReportData } from '@tipme/contracts';
import { Button, Card, Notice, Skeleton } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { naira } from '@/lib/money';
import { track } from '@/lib/analytics';
import { apiFetch } from '@/lib/session-client';
import { drawWeekCard } from '@/lib/week-card';
import { shareableWeek } from '@/lib/week-share';

export default function WeeklyReportPage() {
  const { week } = useParams<{ week: string }>();
  const { profile } = useRecipient();
  const [report, setReport] = useState<WeeklyReportData | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void apiFetch<WeeklyReportData>(
      `/v1/me/reports/${encodeURIComponent(week)}`,
    ).then((result) => {
      if (result.ok) setReport(result.data);
      else setMissing(true);
    });
  }, [week]);

  const share = async () => {
    if (!report) return;
    const canvas = document.createElement('canvas');
    drawWeekCard(canvas, shareableWeek(report, profile));
    track('report_shared', { surface: 'report' });
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) return;
    const name = `tipme-week-${report.week}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (
      typeof navigator.share === 'function' &&
      navigator.canShare?.({ files: [file] })
    ) {
      await navigator
        .share({ files: [file], title: 'My week on TipMe' })
        .catch(() => undefined);
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  if (missing)
    return (
      <Notice tone="error" title="We couldn’t find that week">
        <Link href="/dashboard">Back to your dashboard</Link>
      </Notice>
    );
  if (!report) return <Skeleton label="Loading your week" />;
  const shared = shareableWeek(report, profile);
  return (
    <div className="dashboard-section report">
      <h1>Your week · {report.week}</h1>
      <section className="balance-card" aria-label="What you received">
        <span>You received</span>
        <strong>{naira(report.totalNetMinor)}</strong>
        <span>
          from {report.tipCount} {report.tipCount === 1 ? 'tip' : 'tips'}
          {shared.changeText ? ` · ${shared.changeText}` : ''}
        </span>
      </section>
      <Card>
        <ul className="report-facts">
          {report.bestDay && (
            <li>
              Best day:{' '}
              {new Date(`${report.bestDay.date}T12:00:00Z`).toLocaleDateString(
                'en-NG',
                { weekday: 'long', day: 'numeric', month: 'long' },
              )}{' '}
              ({naira(report.bestDay.netMinor)})
            </li>
          )}
          <li>
            {report.notesCount} {report.notesCount === 1 ? 'note' : 'notes'}{' '}
            from supporters
          </li>
          {report.moments.map((moment) => (
            <li key={moment.key}>✳ {moment.title}</li>
          ))}
        </ul>
      </Card>
      {report.topSupporterLabel && (
        <Card className="report-private">
          <p>Most frequent supporter: {report.topSupporterLabel}</p>
          <p className="tm-hint">
            Only you can see this. It never appears on anything you share.
          </p>
        </Card>
      )}
      <Button onClick={() => void share()}>Share my week</Button>
    </div>
  );
}
