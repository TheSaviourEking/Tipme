import { isReservedHandle } from './handles.js';

/**
 * Earnings analytics (Pro, the ProEarnings board). Dates are Lagos calendar dates (YYYY-MM-DD);
 * weeks start on Monday, as the weekly report does. A period that isn't over is compared with the
 * same days of the one before, never with a whole period. Notes state facts and counts only.
 */
export type EarningsPeriodKind = 'week' | 'month' | 'year';

export interface EarningsWindow {
  from: string;
  /** The last day counted: the period's end, or today while it isn't over. */
  to: string;
  complete: boolean;
  previous: { from: string; to: string };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function parse(date: string): Date | null {
  const match = DATE.exec(date);
  if (!match) return null;
  const value = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return value.toISOString().slice(0, 10) === date ? value : null;
}
const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY_MS);
const daysIn = (year: number, monthIndex: number) =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/** The Monday of the week holding `date`. */
export function mondayOfDate(date: string): string | null {
  const day = parse(date);
  if (!day) return null;
  return iso(addDays(day, -((day.getUTCDay() + 6) % 7)));
}

/** The window holding `at`, seen on `today`; null for a malformed date or one after today. */
export function earningsWindow(
  period: EarningsPeriodKind,
  at: string,
  today: string,
): EarningsWindow | null {
  const day = parse(at);
  const now = parse(today);
  if (!day || !now || day.getTime() > now.getTime()) return null;
  let start: Date;
  let end: Date;
  let previousStart: Date;
  if (period === 'week') {
    start = addDays(day, -((day.getUTCDay() + 6) % 7));
    end = addDays(start, 6);
    previousStart = addDays(start, -7);
  } else if (period === 'month') {
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth();
    start = new Date(Date.UTC(y, m, 1));
    end = new Date(Date.UTC(y, m, daysIn(y, m)));
    previousStart = new Date(Date.UTC(y, m - 1, 1));
  } else {
    const y = day.getUTCFullYear();
    start = new Date(Date.UTC(y, 0, 1));
    end = new Date(Date.UTC(y, 11, 31));
    previousStart = new Date(Date.UTC(y - 1, 0, 1));
  }
  const complete = end.getTime() < now.getTime();
  const to = complete ? end : now;
  // The same number of days into the previous period, clamped to its own end.
  const length = Math.round((to.getTime() - start.getTime()) / DAY_MS);
  let previousEnd: Date;
  if (period === 'week') previousEnd = addDays(previousStart, length);
  else if (period === 'month') {
    const y = previousStart.getUTCFullYear();
    const m = previousStart.getUTCMonth();
    const last = daysIn(y, m);
    previousEnd = complete
      ? new Date(Date.UTC(y, m, last))
      : new Date(Date.UTC(y, m, Math.min(to.getUTCDate(), last)));
  } else {
    const y = previousStart.getUTCFullYear();
    previousEnd = complete
      ? new Date(Date.UTC(y, 11, 31))
      : new Date(
          Date.UTC(
            y,
            to.getUTCMonth(),
            Math.min(to.getUTCDate(), daysIn(y, to.getUTCMonth())),
          ),
        );
  }
  return {
    from: iso(start),
    to: iso(to),
    complete,
    previous: { from: iso(previousStart), to: iso(previousEnd) },
  };
}

/** The average tip in kobo, rounded half up; null with no tips. */
export function averageTipMinor(netMinor: bigint, tips: number): bigint | null {
  if (tips <= 0) return null;
  const count = BigInt(tips);
  return (netMinor * 2n + count) / (count * 2n);
}

/** A note shows only with at least this many tips in the period. */
export const EARNINGS_NOTE_MIN_TIPS = 10;
/** The best day needs at least this many tips, and at least a quarter of the period's. */
export const BEST_DAY_MIN_TIPS = 5;

/**
 * The weekday (0 = Monday … 6 = Sunday) with the most tips, only when it has at least 5 and at
 * least a quarter of them; otherwise null (left out, not softened). Ties go to the earlier day.
 */
export function bestWeekday(
  byWeekday: readonly number[],
  total: number,
): { weekday: number; tips: number } | null {
  let best = -1;
  for (let day = 0; day < 7; day++)
    if (best < 0 || (byWeekday[day] ?? 0) > (byWeekday[best] ?? 0)) best = day;
  const tips = byWeekday[best] ?? 0;
  if (tips < BEST_DAY_MIN_TIPS || tips * 4 < total) return null;
  return { weekday: best, tips };
}

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** ₦4,111 for whole naira, ₦4,543.90 otherwise. */
export function nairaText(minor: bigint): string {
  const whole = new Intl.NumberFormat('en').format(minor / 100n);
  const kobo = minor % 100n;
  return kobo === 0n
    ? `₦${whole}`
    : `₦${whole}.${String(kobo).padStart(2, '0')}`;
}

export interface EarningsNotesInput {
  tips: number;
  averageMinor: bigint | null;
  /** `label` reads after the amount: "in September", "on the same days last week". */
  previous: { tips: number; averageMinor: bigint | null; label: string };
  best: { weekday: number; tips: number } | null;
  /** Opted-in supporters with two or more paid tips in the period; never names. */
  repeatSupporters: number;
}

/**
 * Two or three plain sentences from what TipMe holds. Facts and counts only: no cause ("because"),
 * no advice, no guesses, and none of the words AI, smart or predict. Fewer than 10 tips: none.
 */
export function earningsNotes(input: EarningsNotesInput): string[] {
  if (input.tips < EARNINGS_NOTE_MIN_TIPS) return [];
  const notes: string[] = [];
  if (input.best)
    notes.push(
      `Most of your tips came on ${WEEKDAY_NAMES[input.best.weekday]}s: ${input.best.tips} of ${input.tips}.`,
    );
  if (input.repeatSupporters > 0)
    notes.push(
      `${input.repeatSupporters} ${input.repeatSupporters === 1 ? 'person' : 'people'} tipped you more than once.`,
    );
  if (
    input.averageMinor !== null &&
    input.previous.averageMinor !== null &&
    input.previous.tips > 0 &&
    input.previous.averageMinor !== input.averageMinor
  )
    notes.push(
      `Your average tip went from ${nairaText(input.previous.averageMinor)} ${input.previous.label} to ${nairaText(input.averageMinor)}.`,
    );
  return notes;
}

/** Words a campaign link ending can't be, beyond TipMe's reserved handles: routes under /@handle/. */
const CAMPAIGN_ROUTE_WORDS = new Set(['share-card', 'c', 'tip', 'qr']);
const CAMPAIGN_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/**
 * A campaign's link ending (`/@handle/<ending>`): lower-case letters, digits and dashes, 1–30 long,
 * not starting or ending with a dash; never one of TipMe's own words. Another person's handle is
 * checked by the database (it needs the table).
 */
export function campaignSlugProblem(
  slug: string,
): 'format' | 'reserved' | null {
  if (!CAMPAIGN_SLUG.test(slug)) return 'format';
  if (CAMPAIGN_ROUTE_WORDS.has(slug) || isReservedHandle(slug))
    return 'reserved';
  return null;
}
