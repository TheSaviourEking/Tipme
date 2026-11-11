import type { MonthlyRecapData } from '@tipme/contracts';
import { formatNaira } from './demo-amount.ts';

// The shareable monthly recap (ProAdditions §5): the person's own counts only, picked field by
// field, so a supporter's name or note can never reach the card. The total only when switched on.

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const SHORT = MONTHS.map((month) => month.slice(0, 3));
const DAYS = [
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
  'Sundays',
];

export interface ShareableMonth {
  displayName: string;
  handle: string;
  monthName: string;
  tipCount: number;
  total: string | null;
  bestWeek: string | null;
  bestDay: string | null;
}

export const monthNameOf = (month: string) =>
  `${MONTHS[Number(month.slice(5, 7)) - 1] ?? ''} ${month.slice(0, 4)}`;

/** "12–18 Oct", or "28 Sep – 4 Oct" across a month end (clipped weeks never cross one). */
export function dayRange(from: string, to: string): string {
  const day = (date: string) => Number(date.slice(8, 10));
  const mon = (date: string) => SHORT[Number(date.slice(5, 7)) - 1] ?? '';
  return mon(from) === mon(to)
    ? `${day(from)}–${day(to)} ${mon(to)}`
    : `${day(from)} ${mon(from)} – ${day(to)} ${mon(to)}`;
}

export function recapShareable(
  recap: MonthlyRecapData,
  owner: { displayName: string; handle: string },
  options: { showTotal: boolean },
): ShareableMonth {
  return {
    displayName: owner.displayName,
    handle: owner.handle,
    monthName: monthNameOf(recap.month),
    tipCount: recap.tipCount,
    total: options.showTotal ? formatNaira(recap.totalNetMinor) : null,
    bestWeek: recap.bestWeek
      ? `${dayRange(recap.bestWeek.from, recap.bestWeek.to)} · ${recap.bestWeek.tips} ${recap.bestWeek.tips === 1 ? 'tip' : 'tips'}`
      : null,
    bestDay: recap.bestDay ? (DAYS[recap.bestDay.weekday] ?? null) : null,
  };
}
