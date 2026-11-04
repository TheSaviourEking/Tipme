const DAY = 86_400_000;
const LAGOS_OFFSET = 3_600_000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * An ISO week ("2026-W44") as the instants it covers in Lagos (Monday 00:00 to the next Monday)
 * and a plain label ("26 Oct to 1 Nov"). Null when the text is not an ISO week.
 */
export function isoWeekRange(
  week: string,
): { start: number; end: number; label: string } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  if (number < 1 || number > 53) return null;
  // Week 1 holds 4 January; its Monday is the start.
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay() || 7;
  const monday = jan4 - (jan4Weekday - 1) * DAY + (number - 1) * 7 * DAY;
  const sunday = new Date(monday + 6 * DAY);
  const first = new Date(monday);
  const text = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return {
    start: monday - LAGOS_OFFSET,
    end: monday + 7 * DAY - LAGOS_OFFSET,
    label: `${text(first)} to ${text(sunday)}`,
  };
}
