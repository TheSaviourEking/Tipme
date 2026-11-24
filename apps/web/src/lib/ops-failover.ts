import type { OpsMailProviders } from '@tipme/contracts';

/*
 * Words for automatic email failover on Ops → Providers (owner, 23 Nov 2026). Staff-only: users
 * never see a provider's name.
 */

const clock = new Intl.DateTimeFormat('en-GB', {
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
});
/** HH:MM, Lagos time, as staff read it. */
export const lagosTime = (iso: string) => clock.format(new Date(iso));

/** "Live now: Brevo (ZeptoMail is resting until 19:58)." The reason is named, never guessed. */
export function liveNowNote(
  data: Pick<OpsMailProviders, 'providers' | 'failover'>,
): string {
  const label = (name: string) =>
    data.providers.find((p) => p.name === name)?.label ?? name;
  const live = `Live now: ${label(data.failover.live)}`;
  const active = data.providers.find((p) => p.active);
  if (!active || active.name === data.failover.live) return `${live}.`;
  const health = active.health;
  if (health?.state === 'resting' && health.until)
    return `${live} (${active.label} is resting until ${lagosTime(health.until)}).`;
  if (health?.state === 'trial')
    return `${live} (${active.label} is on trial).`;
  return `${live}.`;
}

/** What decides a trial, by what tripped it. */
export function trialNote(kind: 'send' | 'codes' | null): string {
  return kind === 'codes'
    ? 'the next few sign-in and other codes go through it, and once people use them, it’s back'
    : 'one email goes through it, and once that works, it’s back';
}
