/*
 * The clock of a username take-back (username reservation spec, section 5.5). Deadlines and dates
 * are in Lagos time, which has no daylight saving: West Africa Time is always UTC+1.
 */

const LAGOS_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The end of the Lagos calendar day `noticeDays` days after `noticedAt`'s Lagos date
 * (23:59:59.999 in Lagos, 22:59:59.999 UTC). So the user always has at least `noticeDays` full days.
 */
export function takeBackDueAt(noticedAt: Date, noticeDays: number): Date {
  const lagos = noticedAt.getTime() + LAGOS_OFFSET_MS;
  const startOfLagosDay = Math.floor(lagos / DAY_MS) * DAY_MS;
  return new Date(
    startOfLagosDay + (noticeDays + 1) * DAY_MS - LAGOS_OFFSET_MS - 1,
  );
}

const WORDS = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
});

/** The Lagos date written out, for emails and banners: "10 November 2026". */
export function lagosDateWords(at: Date): string {
  return WORDS.format(at);
}
