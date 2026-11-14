/**
 * Paid Pro periods (ADR-0015; the owner's decisions of 5 and 9 Nov 2026). A month is a calendar
 * month on the Lagos clock: Africa/Lagos is UTC+1 all year, with no daylight saving, so a fixed
 * offset is exact.
 */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** Days of grace after an unpaid month, before the page is Free. */
export const PRO_GRACE_DAYS = 3;

/** Reminders before a month ends: 7 days and 1 day. */
export const PRO_REMINDER_DAYS = [7, 1] as const;

const daysIn = (year: number, monthIndex: number) =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * One calendar month later on the Lagos clock, at the same time of day, clamped to the end of a
 * shorter month: 31 Jan ends 28 Feb (29 in a leap year).
 */
export function proPeriodEnd(startsAt: Date): Date {
  const local = new Date(startsAt.getTime() + LAGOS_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = month % 12;
  const day = Math.min(local.getUTCDate(), daysIn(targetYear, targetMonth));
  const end = Date.UTC(
    targetYear,
    targetMonth,
    day,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(end - LAGOS_OFFSET_MS);
}

/** When the grace after a month ends: 3 days after it. */
export function proGraceEnd(endsAt: Date): Date {
  return new Date(endsAt.getTime() + PRO_GRACE_DAYS * DAY_MS);
}

/**
 * Where a newly paid month starts. While the latest month is running or in its grace, at its end,
 * so months never overlap or leave a gap, and grace is not free time (the owner's default). After
 * grace, or with no month before, now.
 */
export function nextPeriodStart(
  now: Date,
  latest: { endsAt: Date; graceEndsAt: Date } | null,
): Date {
  if (latest && now.getTime() < latest.graceEndsAt.getTime())
    return latest.endsAt;
  return now;
}
