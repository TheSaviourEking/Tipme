'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { WeeklyReportData } from '@tipme/contracts';
import { Button, Card, Notice, Skeleton } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { usePanel } from '@/components/dashboard/use-panel';
import { useWeekNotes, type WeekNote } from '@/components/dashboard/week-notes';
import { formatNaira } from '@/lib/demo-amount';
import { isoWeekRange } from '@/lib/iso-week';
import { track } from '@/lib/analytics';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { drawWeekCard } from '@/lib/week-card';
import { shareableWeek } from '@/lib/week-share';

/**
 * The week's notes, one on top of two behind. Pressing deals the next note and wraps after
 * the last. The note on top sits in a polite live region, so a screen reader hears each new one;
 * the button over the stack is a real button.
 */
function NoteStack({ notes }: { notes: WeekNote[] }) {
  const [index, setIndex] = useState(0);
  const note = notes[index % notes.length];
  if (!note) return null;
  return (
    <section className="week-stack" aria-labelledby="week-notes">
      <h2 id="week-notes">Notes from this week. Press to read the next one.</h2>
      <div className="stack">
        <span className="stack__card stack__card--3" aria-hidden="true" />
        <span className="stack__card stack__card--2" aria-hidden="true" />
        <div className="stack__live" aria-live="polite" aria-atomic="true">
          <div className="stack__card stack__card--top" key={note.tipId}>
            <p className="stack__note" data-testid="note-text">
              “{note.note}”
            </p>
            <p className="stack__from">
              From {note.who}, {formatNaira(Number(note.grossMinor))}
              <span className="stack__count">
                {' '}
                · {(index % notes.length) + 1} of {notes.length}
              </span>
            </p>
          </div>
        </div>
        <button
          type="button"
          className="stack__press"
          aria-label="Next note"
          onClick={() => setIndex((i) => (i + 1) % notes.length)}
        />
      </div>
    </section>
  );
}

export default function WeeklyReportPage() {
  const { week } = useParams<{ week: string }>();
  const { profile } = useRecipient();
  const copy = paymentModeCopy(usePaymentMode());
  // One loader: data, error and reload(). A failed refresh keeps the week on screen.
  const { data: report, error } = usePanel<WeeklyReportData>(
    `/v1/me/reports/${encodeURIComponent(week)}`,
  );
  const notes = useWeekNotes(week);

  const share = async () => {
    if (!report) return;
    const canvas = document.createElement('canvas');
    drawWeekCard(canvas, shareableWeek(report, profile), copy.weekCardSuffix);
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

  if (error === 'load' && !report)
    return (
      <Notice tone="error" title="We couldn’t find that week">
        <Link href="/dashboard">Back to your dashboard</Link>
      </Notice>
    );
  if (!report) return <Skeleton label="Loading your week" />;
  const range = isoWeekRange(report.week);
  const compared =
    report.changePct === null
      ? null
      : `${report.changePct >= 0 ? '▲' : '▼'} ${Math.abs(report.changePct)}%`;
  return (
    <div className="dashboard-section report">
      <section className="week-hero" aria-label="What you received">
        <h1 className="week-hero__title">
          Your week{range ? `, ${range.label}` : ` · ${report.week}`}
        </h1>
        <p className="week-hero__headline">
          {report.tipCount === 0
            ? 'A quiet week.'
            : report.tipCount === 1
              ? 'You were thanked once.'
              : `You were thanked ${report.tipCount} times.`}
        </p>
        <div className="week-hero__stats">
          <div>
            <span>You received</span>
            <strong>{formatNaira(Number(report.totalNetMinor))}</strong>
          </div>
          <div>
            <span>Tips</span>
            <strong>{report.tipCount}</strong>
          </div>
          {compared && (
            <div>
              <span>Compared with last week</span>
              <strong>{compared}</strong>
            </div>
          )}
        </div>
      </section>
      {notes && notes.length > 0 && <NoteStack notes={notes} />}
      <Card>
        <ul className="report-facts">
          {report.bestDay && (
            <li>
              Best day:{' '}
              {new Date(`${report.bestDay.date}T12:00:00Z`).toLocaleDateString(
                'en-NG',
                { weekday: 'long', day: 'numeric', month: 'long' },
              )}{' '}
              ({formatNaira(Number(report.bestDay.netMinor))})
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
      {error === 'refresh' && <p className="tm-hint">Couldn’t refresh</p>}
      <div className="week-actions">
        <Button variant="continue" onClick={() => void share()}>
          Share my week
        </Button>
        <Link href="/dashboard/tips">See all tips</Link>
      </div>
    </div>
  );
}
