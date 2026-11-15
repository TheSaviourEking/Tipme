export const LAGOS_LAUNCH_TARGET = '2026-10-26T23:00:00Z';

// Lagos has no daylight saving, so West Africa Time is always UTC+1 and the
// "WAT" suffix is safe to write ourselves (Intl names it "GMT+1" in en-GB).
const lagosDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const lagosDayMonth = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'long',
});
const lagosTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "27 October 2026 · 00:00 WAT", from the launch instant. */
export function launchLabel(target: number): string {
  return `${lagosDate.format(target)} · ${lagosTime.format(target)} WAT`;
}

/** "27 October · 00:00 WAT", for the share card. */
export function launchShortLabel(target: number): string {
  return `${lagosDayMonth.format(target)} · ${lagosTime.format(target)} WAT`;
}

/** The instant for `<time dateTime>`. */
export function launchIso(target: number): string {
  return new Date(target).toISOString();
}

export type CountdownParts = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  complete: boolean;
};

export function countdownParts(target: number, now: number): CountdownParts {
  const remainingSeconds = Math.max(0, Math.ceil((target - now) / 1000));
  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  return {
    days,
    hours,
    minutes,
    seconds,
    complete: remainingSeconds === 0,
  };
}

export function launchMinuteBucket(target: number, now: number): number {
  return Math.max(0, Math.ceil((target - now) / 60_000));
}

export function countdownAnnouncement(parts: CountdownParts): string {
  if (parts.complete) return 'TipMe is open.';

  const values = [
    unit(parts.days, 'day'),
    unit(parts.hours, 'hour'),
    unit(parts.minutes, 'minute'),
  ].filter((value): value is string => value !== null);
  if (values.length === 0) return 'Less than 1 minute until TipMe opens.';
  if (values.length === 1) return `${values[0]} until TipMe opens.`;
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)} until TipMe opens.`;
}

function unit(value: number, label: string): string | null {
  if (value === 0) return null;
  return `${value} ${label}${value === 1 ? '' : 's'}`;
}
