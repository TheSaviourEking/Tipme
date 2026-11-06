/** TipMe for businesses: the rules every lane shares (plan 2026-11-06-business, B0 Task 1). */

/** A shift ends by itself after this long, so a forgotten check-out never lasts for days (M4). */
export const SHIFT_MAX_HOURS = 14;
/** A supporter may write a note about the person for this long after paying (M9). */
export const NOTE_WINDOW_DAYS = 7;
/** An invitation works once, for this long. */
export const INVITATION_DAYS = 7;
/** The business's weeks are Lagos weeks, as the recipient dashboard's (`DASHBOARD_TIME_ZONE`). */
export const LAGOS_TIME_ZONE = 'Africa/Lagos';

export type SlugProblem = 'empty' | 'too_long' | 'characters';

// Lower-case letters and digits, with hyphens only inside (M7). The database checks the same.
const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function slugProblem(raw: string, max: number): SlugProblem | null {
  if (raw.length === 0) return 'empty';
  if (raw.length > max) return 'too_long';
  return SLUG.test(raw) ? null : 'characters';
}

/** A business's address part, `/b/<slug>`: 1 to 40 characters. */
export const businessSlugProblem = (raw: string) => slugProblem(raw, 40);
/** A location's address part, `/b/<business>/<slug>`: 1 to 30 characters. */
export const locationSlugProblem = (raw: string) => slugProblem(raw, 30);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** On shift now: open, started (not in the future), and started within SHIFT_MAX_HOURS. */
export function onShift(
  shift: { startedAt: Date; endedAt: Date | null } | null,
  now: Date,
): boolean {
  if (!shift || shift.endedAt !== null) return false;
  const age = now.getTime() - shift.startedAt.getTime();
  return age >= 0 && age <= SHIFT_MAX_HOURS * HOUR_MS;
}

// Nigeria keeps UTC+1 all year with no daylight saving, so Lagos time is a fixed shift; a test
// checks the assumption against the time zone database.
const LAGOS_OFFSET_MS = HOUR_MS;

/** The Monday (UTC midnight of the Lagos date) of ISO week 1 of an ISO year. */
function isoWeekOneMonday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const weekday = (new Date(jan4).getUTCDay() + 6) % 7; // Monday 0
  return jan4 - weekday * DAY_MS;
}

/** ISO week id ('2026-W45') of an instant, in Lagos time. */
export function lagosWeekOf(at: Date): string {
  const local = new Date(at.getTime() + LAGOS_OFFSET_MS);
  const day = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const weekday = (local.getUTCDay() + 6) % 7;
  // The ISO year is the year of this week's Thursday.
  const thursday = new Date(day + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week =
    Math.floor(
      (day - weekday * DAY_MS - isoWeekOneMonday(year)) / (7 * DAY_MS),
    ) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** A week id's instants, [from, to), Monday 00:00 Lagos to the next Monday; null when it is no week. */
export function lagosWeekRange(week: string): { from: Date; to: Date } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  const weeks =
    (isoWeekOneMonday(year + 1) - isoWeekOneMonday(year)) / (7 * DAY_MS);
  if (number < 1 || number > weeks) return null;
  const monday = isoWeekOneMonday(year) + (number - 1) * 7 * DAY_MS;
  return {
    from: new Date(monday - LAGOS_OFFSET_MS),
    to: new Date(monday + 7 * DAY_MS - LAGOS_OFFSET_MS),
  };
}

/** The first word of a display name, at most 30 code points (a staff card's default name). */
export function firstNameOf(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0] ?? '';
  return Array.from(first).slice(0, 30).join('');
}
