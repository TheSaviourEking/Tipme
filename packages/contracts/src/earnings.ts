import { z } from 'zod';

// Earnings analytics (Pro; the ProEarnings board, approved 11 Nov 2026). Counted only from what
// TipMe holds about each confirmed tip: its net amount (after the TipMe fee it recorded) and when it was
// confirmed. Lagos calendar dates; weeks start on Monday. Amounts are kobo as decimal strings.

export const EARNINGS_PERIODS = ['week', 'month', 'year'] as const;
export type EarningsPeriod = (typeof EARNINGS_PERIODS)[number];

export const earningsPeriodQuerySchema = z
  .object({
    period: z.enum(EARNINGS_PERIODS),
    /** Any Lagos date inside the period; today when absent. */
    at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
export type EarningsPeriodQuery = z.infer<typeof earningsPeriodQuerySchema>;

export const earningsTrendQuerySchema = z
  .object({ unit: z.enum(['week', 'month']) })
  .strict();
export type EarningsTrendQuery = z.infer<typeof earningsTrendQuerySchema>;

export interface EarningsTotal {
  netMinor: string;
  tips: number;
}

/** The basics everyone gets, Free and Pro alike (nothing is taken away from today's dashboard). */
export interface EarningsSummary {
  currency: 'NGN';
  today: string;
  /** Monday to today, against the same days last week. */
  thisWeek: EarningsTotal & { previous: EarningsTotal };
  /** The 1st to today, against the same days last month. */
  thisMonth: EarningsTotal & { from: string; previous: EarningsTotal };
  thisYear: EarningsTotal & { from: string };
  allTime: EarningsTotal;
  /** When the page was made (YYYY-MM-DD, Lagos), for "since you joined in March". */
  joinedOn: string;
}

/** One week, month or year (Pro). */
export interface EarningsPeriodView {
  currency: 'NGN';
  period: EarningsPeriod;
  from: string;
  /** The last day counted: the period's end, or today while it isn't over. */
  to: string;
  complete: boolean;
  netMinor: string;
  tips: number;
  /** Rounded half up to the kobo; null with no tips. */
  averageMinor: string | null;
  previous: EarningsTotal & {
    from: string;
    to: string;
    averageMinor: string | null;
  };
  /** Whole percent; null when the previous period had nothing. */
  changePct: number | null;
  /** Paid tips by weekday, Monday first (7 numbers). */
  byWeekday: number[];
  /** 0 = Monday; shown only with 5+ tips that are a quarter or more of the period's. */
  bestDay: { weekday: number; tips: number } | null;
  /** Opted-in supporters with 2+ paid tips in the period. Never names. */
  repeatSupporters: number;
  /** Plain facts; empty under 10 tips. */
  notes: string[];
  /** Whether an earlier period has any tips or the page existed then. */
  hasEarlier: boolean;
}

export interface EarningsTrendPoint {
  /** The first day of the week or month. */
  from: string;
  netMinor: string;
  tips: number;
  /** False for the current week or month (drawn open). */
  complete: boolean;
}

export interface EarningsTrend {
  currency: 'NGN';
  unit: 'week' | 'month';
  /** 12 points, oldest first, the last one the current week or month. */
  points: EarningsTrendPoint[];
}

// ---- Monthly recap (Pro; ProAdditions §5, approved 5 Nov 2026) ----

/**
 * What a month's recap holds, by type: counts and the private total only. No supporter name,
 * label, message or tip id. The total is shown privately, and on the share card only when the
 * person switches it on.
 */
export interface MonthlyRecapData {
  /** YYYY-MM, Lagos. */
  month: string;
  tipCount: number;
  totalNetMinor: string;
  averageMinor: string | null;
  /** The month before, for "up from". */
  previousNetMinor: string;
  /** The Monday-started week (clipped to the month) with the most paid tips. */
  bestWeek: { from: string; to: string; tips: number } | null;
  bestDay: { weekday: number; tips: number } | null;
  /** Notes on paid tips in the month the person can read (not hidden or reported). */
  notes: number;
}

export interface MonthlyRecapListItem {
  month: string;
  tipCount: number;
  createdAt: string;
}

export const RECAP_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
