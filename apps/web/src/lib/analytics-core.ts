import type {
  AnalyticsChannel,
  WebVital,
  WebVitalMetric,
  WebVitalPage,
} from '@tipme/contracts';

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

/** Rewrites preserve the requested pathname, so the holding-page marker is the source of truth. */
export function shouldReportWebVitals(hasCountdownPage: boolean): boolean {
  return !hasCountdownPage;
}

/** Device class only; the user agent itself never leaves the browser in an event. */
export const deviceIsMobile = (userAgent: string) =>
  /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent);

const VITAL_PAGES: [RegExp, WebVitalPage][] = [
  [/^\/$/, 'home'],
  [
    /^\/(how-it-works|for-creators|for-businesses|about-preview|legal)(\/|$)/,
    'marketing',
  ],
  [/^\/(people\/|@)[^/]+$/, 'profile'],
  [/^\/mock-checkout\//, 'checkout'],
  [/^\/tip\//, 'status'],
  [/^\/dashboard(\/|$)/, 'dashboard'],
  [/^\/(sign-in|sign-up|recover|verify-email)(\/|$)/, 'account'],
];

/** The kind of page for a web vital; null (send nothing) for staff, developer and other pages. */
export function vitalPage(pathname: string): WebVitalPage | null {
  return VITAL_PAGES.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
}

const VITAL_METRICS = new Set<string>(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);

/** What leaves the browser: the metric, a rounded value and the page kind. Nothing else. */
export function vitalPayload(
  metric: { name: string; value: number },
  page: WebVitalPage,
): WebVital | null {
  if (!VITAL_METRICS.has(metric.name) || !Number.isFinite(metric.value))
    return null;
  const value =
    metric.name === 'CLS'
      ? Math.round(metric.value * 1000) / 1000
      : Math.round(metric.value);
  return { metric: metric.name as WebVitalMetric, value, page };
}
