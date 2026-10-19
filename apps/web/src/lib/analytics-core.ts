import type { AnalyticsChannel } from '@tipme/contracts';

// Pure helpers for anonymous analytics (no browser state), shared by the tracker and its tests.

/** How a visitor arrived: the QR tag first, then the referring site's category. */
export function referrerChannel(
  referrer: string,
  search: string,
): AnalyticsChannel {
  if (new URLSearchParams(search).get('src') === 'qr') return 'qr';
  if (!referrer) return 'direct';
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  const is = (...domains: string[]) =>
    domains.some((d) => host === d || host.endsWith(`.${d}`));
  if (is('instagram.com')) return 'instagram';
  if (is('x.com', 'twitter.com', 't.co')) return 'x';
  if (is('facebook.com', 'fb.com', 'fb.me')) return 'facebook';
  if (is('whatsapp.com', 'wa.me')) return 'whatsapp';
  if (
    is('google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'ecosia.org') ||
    /^(www\.)?google\.[a-z.]+$/.test(host)
  )
    return 'search';
  return 'link';
}

export function shouldTrack(nav: {
  globalPrivacyControl?: boolean;
  doNotTrack?: string | null;
}): boolean {
  return nav.globalPrivacyControl !== true && nav.doNotTrack !== '1';
}

/** Device class only; the user agent itself never leaves the browser in an event. */
export const deviceIsMobile = (userAgent: string) =>
  /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent);
