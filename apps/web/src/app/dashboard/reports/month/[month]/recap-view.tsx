'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { MonthlyRecapData } from '@tipme/contracts';
import { Button, Card, Skeleton, Slip } from '@tipme/ui';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { useRecipient } from '@/components/account/recipient-context';
import { usePanel } from '@/components/dashboard/use-panel';
import { usePaymentMode } from '@/components/payment-mode-context';
import { track } from '@/lib/analytics';
import { naira } from '@/lib/money';
import { drawMonthCard } from '@/lib/month-card';
import { monthNameOf, recapShareable } from '@/lib/month-share';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { Money } from '@/components/money';

// A per-viewer convenience: whether this browser shows the total on the card. Nothing is sent.
const TOTAL_STORAGE_NAME = 'tipme.recapTotal.v1';
const readTotal = () => {
  try {
    return localStorage.getItem(TOTAL_STORAGE_NAME) === '1';
  } catch {
    return false;
  }
};

export default function MonthlyRecapPage() {
  const { month } = useParams<{ month: string }>();
  const { profile } = useRecipient();
  const copy = paymentModeCopy(usePaymentMode());
  const pro = profile.plan === 'pro';
  const {
    data: recap,
    error,
    failedStatus,
    reload,
  } = usePanel<MonthlyRecapData>(`/v1/me/recaps/${encodeURIComponent(month)}`);
  // The dashboard renders only in the browser (dashboard-shell), so this reads no server value.
  const [showTotal, setShowTotal] = useState(readTotal);
  const preview = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!recap || !preview.current) return;
    drawMonthCard(
      preview.current,
      recapShareable(recap, profile, { showTotal }),
      copy.weekCardSuffix,
      540,
    );
  }, [recap, profile, showTotal, copy.weekCardSuffix]);

  const share = async () => {
    if (!recap) return;
    const canvas = document.createElement('canvas');
    drawMonthCard(
      canvas,
      recapShareable(recap, profile, { showTotal }),
      copy.weekCardSuffix,
    );
    track('report_shared', { surface: 'report' });
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) return;
    const name = `tipme-month-${recap.month}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (
      typeof navigator.share === 'function' &&
      navigator.canShare?.({ files: [file] })
    ) {
      await navigator
        .share({ files: [file], title: 'My month on TipMe' })
        .catch(() => undefined);
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  if (!pro)
    return (
      <Slip tone="neutral" title="The monthly recap is part of TipMe Pro">
        <p>
          <Link href="/dashboard/earnings">See your earnings</Link>
        </p>
      </Slip>
    );
  // No recap for the month (404) is not a fault: it isn't made yet, so it is said neutrally
  // (DECISION-LOG 2026-10-27). Only a failed read is an error, with Try again (UI audit, 15 Nov 2026).
  if (error === 'load' && !recap)
    return failedStatus === 404 ? (
      <Slip tone="neutral" title="This month’s recap isn’t ready yet">
        Recaps are made on the 1st for the month before.{' '}
        <Link href="/dashboard/earnings">See your earnings</Link>
      </Slip>
    ) : (
      <LoadFailed title="We couldn’t load your recap" onRetry={reload} />
    );
  if (!recap) return <Skeleton label="Loading your recap" />;
  const shareable = recapShareable(recap, profile, { showTotal: true });
  return (
    <div className="dashboard-section report recap">
      <section className="week-hero" aria-label="Your month">
        <h1 className="week-hero__title">
          {profile.displayName}’s {monthNameOf(recap.month)} on TipMe
        </h1>
        <p className="week-hero__headline">
          {recap.tipCount === 1
            ? 'You got 1 tip.'
            : `You got ${recap.tipCount} tips.`}
        </p>
        <div className="week-hero__stats">
          <div>
            <span>You received</span>
            <strong>
              <Money minor={recap.totalNetMinor} />
            </strong>
          </div>
          <div>
            <span>Tips</span>
            <strong>{recap.tipCount}</strong>
          </div>
          {recap.averageMinor && (
            <div>
              <span>Average tip</span>
              <strong>
                <Money minor={recap.averageMinor} />
              </strong>
            </div>
          )}
        </div>
        <p className="tm-hint">
          Only you can see the amounts. They’re on your card only if you switch
          them on.
        </p>
      </section>
      <Card>
        <ul className="report-facts">
          {shareable.bestWeek && <li>Best week: {shareable.bestWeek}</li>}
          {shareable.bestDay && (
            <li>Most of your tips came on {shareable.bestDay}</li>
          )}
          <li>
            {recap.notes} {recap.notes === 1 ? 'note' : 'notes'} from supporters
          </li>
          <li>
            <Money minor={recap.previousNetMinor} /> the month before
          </li>
        </ul>
      </Card>
      <section className="recap-card" aria-labelledby="recap-card-title">
        <h2 id="recap-card-title">Your card</h2>
        <canvas
          ref={preview}
          className="recap-card__preview"
          role="img"
          aria-label={`Card: ${profile.displayName}, ${monthNameOf(recap.month)}, ${recap.tipCount} tips${showTotal ? `, ${naira(recap.totalNetMinor)}` : ''}`}
        />
        <label className="recap-card__switch">
          <input
            type="checkbox"
            checked={showTotal}
            onChange={(event) => {
              setShowTotal(event.target.checked);
              try {
                localStorage.setItem(
                  TOTAL_STORAGE_NAME,
                  event.target.checked ? '1' : '0',
                );
              } catch {
                // Only this browser's choice; the card still works without it.
              }
            }}
          />
          Show my total on the card
        </label>
        <div className="week-actions">
          <Button variant="continue" onClick={() => void share()}>
            Share my month
          </Button>
          <Link href="/dashboard/earnings">See your earnings</Link>
        </div>
      </section>
    </div>
  );
}
