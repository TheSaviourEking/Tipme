// Dates as the emails print them. Month names are ours, not the runtime's locale data, which
// varies ("Sep" or "Sept"). TipMe's market is Nigeria, so times are Lagos times.

const SHORT = [
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
const LONG = [
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
const DAY_MS = 86_400_000;

const lagos = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "5 Nov 2026, 14:32": an absolute Lagos time (an email can't know when "today" is read). */
export function lagosMinute(iso: string): string {
  const parts = Object.fromEntries(
    lagos.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  return `${Number(parts.day)} ${SHORT[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

/** "27 October to 2 November": Monday to Sunday of an ISO week ("2026-W44"). */
export function weekDays(isoWeek: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new RangeError('not an ISO week');
  // Week 1 is the week with 4 January in it.
  const jan4 = Date.UTC(Number(match[1]), 0, 4);
  const weekday = new Date(jan4).getUTCDay() || 7;
  const monday = new Date(
    jan4 + (1 - weekday + (Number(match[2]) - 1) * 7) * DAY_MS,
  );
  const sunday = new Date(monday.getTime() + 6 * DAY_MS);
  const day = (d: Date) => `${d.getUTCDate()} ${LONG[d.getUTCMonth()]}`;
  return `${day(monday)} to ${day(sunday)}`;
}
