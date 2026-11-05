'use client';
import { useEffect, useState } from 'react';
import type { ActivityRow, DashboardSummary } from '@tipme/contracts';
import {
  arrivals,
  balanceRose,
  idsOf,
  newlyConfirmed,
  statesOf,
} from '@/lib/live-merge';

const NONE: ReadonlySet<string> = new Set();
const HIGHLIGHT_MS = 1000;

interface Seen {
  rows: readonly ActivityRow[] | null;
  ids: ReadonlySet<string> | null;
  states: ReadonlyMap<string, string> | null;
  arriving: ReadonlySet<string>;
  highlighted: ReadonlySet<string>;
}

/**
 * Compares each new list the API returns with the last one (state kept from the previous render,
 * React's documented pattern), and clears the marks after 1 s.
 */
export function useArrivals(rows: readonly ActivityRow[] | null): {
  arriving: ReadonlySet<string>;
  highlighted: ReadonlySet<string>;
} {
  const [seen, setSeen] = useState<Seen>({
    rows: null,
    ids: null,
    states: null,
    arriving: NONE,
    highlighted: NONE,
  });
  if (rows && rows !== seen.rows)
    setSeen({
      rows,
      ids: idsOf(rows),
      states: statesOf(rows),
      arriving: arrivals(seen.ids, rows),
      highlighted: newlyConfirmed(seen.states, rows),
    });
  const marked = seen.arriving.size > 0 || seen.highlighted.size > 0;
  useEffect(() => {
    if (!marked) return;
    const timer = setTimeout(
      () => setSeen((s) => ({ ...s, arriving: NONE, highlighted: NONE })),
      HIGHLIGHT_MS,
    );
    return () => clearTimeout(timer);
  }, [marked, seen.rows]);
  return { arriving: seen.arriving, highlighted: seen.highlighted };
}

/** True for 1 s after availableMinor rose. The number itself changes in one render. */
export function useBalanceRose(summary: DashboardSummary | null): boolean {
  const [seen, setSeen] = useState<{
    summary: DashboardSummary | null;
    rose: boolean;
  }>({ summary: null, rose: false });
  if (summary && summary !== seen.summary)
    setSeen({ summary, rose: balanceRose(seen.summary, summary) });
  useEffect(() => {
    if (!seen.rose) return;
    const timer = setTimeout(
      () => setSeen((s) => ({ ...s, rose: false })),
      HIGHLIGHT_MS,
    );
    return () => clearTimeout(timer);
  }, [seen.rose, seen.summary]);
  return seen.rose;
}
