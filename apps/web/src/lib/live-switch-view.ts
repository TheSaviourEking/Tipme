import type { OpsLiveSwitch } from '@tipme/contracts';

const WHEN = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** The Overview's line on whether this copy takes real money, in Lagos time. */
export function liveSwitchText(
  latest: OpsLiveSwitch | null | undefined,
): string {
  if (!latest) return 'Live payments: off';
  return `Live payments: ${latest.live ? 'on' : 'off'} since ${WHEN.format(new Date(latest.switchedAt))}, by ${latest.version.slice(0, 7)}`;
}
