import { referrerChannel, shouldTrack } from './analytics-core';
import { newUuid } from './random-id';
import { MY_TIPS_KEY } from './recognition';
import type {
  AnalyticsChannel,
  AnalyticsClientEvent,
  AnalyticsSurface,
} from '@tipme/contracts';

// Anonymous first-party analytics (ADR-0010). Nothing is sent when the browser signals Global
// Privacy Control or Do Not Track; no cookies, and nothing is written to a supporter's device:
// the flow id lives in memory for one page visit. The API drops events while collection is off
// (production, until D-07).

const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';
let flow: string | null = null;

function storage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

const flowId = () => (flow ??= newUuid());

/**
 * "Returning" is known only for supporters who chose "Remember my tips" (their own record is
 * already on this device); for everyone else it stays unknown. Nothing is written here.
 */
export function returningVisitor(): true | undefined {
  return storage('local')?.getItem(MY_TIPS_KEY) ? true : undefined;
}

/** Fire-and-forget; failures are ignored (analytics never gets in a supporter's way). */
export function track(
  name: AnalyticsClientEvent,
  props: {
    surface?: AnalyticsSurface;
    channel?: AnalyticsChannel;
    handle?: string;
    returning?: boolean;
  } = {},
): void {
  if (typeof window === 'undefined') return;
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (!shouldTrack(nav)) return;
    void fetch(`${API_ORIGIN}/v1/events`, {
      method: 'POST',
      credentials: API_ORIGIN === '' ? 'same-origin' : 'omit',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, flowId: flowId(), ...props }),
    }).catch(() => undefined);
  } catch {
    // Analytics must never break a page.
  }
}

/** "Recipient came back": at most once per Lagos day per browser, no handle or id. */
export function recipientReturned(): void {
  const store = storage('local');
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
  }).format(new Date());
  if (!store || store.getItem('tipme.dash_day') === today) return;
  store.setItem('tipme.dash_day', today);
  track('recipient_returned', { surface: 'dashboard' });
}

/** A public page was opened: how the visitor arrived, and (from a QR code) a scan. */
export function profileViewed(handle: string): void {
  const channel = referrerChannel(document.referrer, location.search);
  track('profile_viewed', {
    surface: 'profile',
    channel,
    handle,
    returning: returningVisitor(),
  });
  if (channel === 'qr') {
    track('qr_scanned', { surface: 'profile', channel, handle });
    // Keep the address clean for copying and sharing; the canonical URL is /@handle anyway.
    const url = new URL(location.href);
    url.searchParams.delete('src');
    history.replaceState(history.state, '', url);
  }
}
