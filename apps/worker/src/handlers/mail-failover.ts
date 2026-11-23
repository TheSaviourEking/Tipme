import type { MailHealthChangeEvent, MailProviderName } from '@tipme/mail';
import { webhookAlert, type PaymentReserveLog } from './payment-reserve.js';

/*
 * Staff alerts for automatic email failover (owner, 23 Nov 2026), through the same alert route as
 * the reserve alerts (ALERT_WEBHOOK_URL). The breaker decides when (a trip, still down at most
 * every 6 hours, a recovery); this only words it. Provider names and our own reasons only.
 */

/**
 * The providers that stand in for each other: the server default, then MAIL_FALLBACK_PROVIDERS,
 * configured ones only, and never the pretend provider in production. The backup of one is the
 * first other provider here.
 */
export function mailFailoverGroup(
  defaultProvider: MailProviderName,
  fallbacks: readonly MailProviderName[],
  configured: ReadonlySet<MailProviderName>,
  production: boolean,
): MailProviderName[] {
  const group: MailProviderName[] = [];
  for (const name of [defaultProvider, ...fallbacks])
    if (
      !group.includes(name) &&
      configured.has(name) &&
      !(production && name === 'mock')
    )
      group.push(name);
  return group;
}

const time = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Lagos',
});

export function mailHealthAlertText(
  event: MailHealthChangeEvent,
  context: {
    labels: Record<MailProviderName, string>;
    backup: MailProviderName | null;
  },
): string {
  const name = context.labels[event.provider];
  const backup = context.backup ? context.labels[context.backup] : null;
  const until = event.until ? `${time.format(event.until)} (Lagos)` : 'later';
  const prefix = `TipMe staff alert: email provider ${name}`;
  if (event.change === 'recovered')
    return `${prefix} has recovered; mail goes through it again.`;
  const where = backup
    ? `goes through ${backup}`
    : 'still goes through it (no backup is set up)';
  if (event.change === 'still_down')
    return `${prefix} is still down (${event.reason ?? 'unknown'}), resting until ${until}. Mail ${where}.`;
  return `${prefix} is resting until ${until} after ${event.reason ?? 'failures'}. New mail ${where}. Ops → Providers shows it; staff can fix the provider or clear this.`;
}

/** Posts each breaker change to the alert route. Throws when it can't, for the breaker to log. */
export function mailHealthAlerter(options: {
  url: string | undefined;
  labels: Record<MailProviderName, string>;
  group: readonly MailProviderName[];
  fetchImpl?: typeof fetch;
  log?: PaymentReserveLog;
}): (event: MailHealthChangeEvent) => Promise<void> {
  const post = webhookAlert({
    url: options.url,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.log ? { log: options.log } : {}),
    unroutedEvent: 'mail.health_alert_unrouted',
  });
  return (event) =>
    post(
      mailHealthAlertText(event, {
        labels: options.labels,
        backup: options.group.find((name) => name !== event.provider) ?? null,
      }),
    );
}
