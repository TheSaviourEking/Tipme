'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { MonthlyRecapListItem } from '@tipme/contracts';
import { monthNameOf } from '@/lib/month-share';
import { usePanel } from './use-panel';

const FRESH_MS = 14 * 86_400_000;

/** "Your October recap is ready" while the latest recap is under 14 days old (Pro only). */
export function RecapTeaser() {
  const recaps = usePanel<MonthlyRecapListItem[]>('/v1/me/recaps');
  const [openedAt] = useState(() => Date.now());
  const latest = recaps.data?.[0];
  if (!latest || openedAt - Date.parse(latest.createdAt) > FRESH_MS)
    return null;
  const month = monthNameOf(latest.month).split(' ')[0];
  return (
    <Link
      className="week-teaser"
      href={`/dashboard/reports/month/${latest.month}`}
    >
      <strong>Your {month} recap is ready</strong>
      <span>
        {latest.tipCount} {latest.tipCount === 1 ? 'tip' : 'tips'}
        <b>See your month</b>
      </span>
    </Link>
  );
}
