import { normaliseHandle } from '@tipme/domain';

// One parser for the web's old setting and the admin value (owner, 14 Nov 2026, #216).
export { parseProductionLaunchAt } from '@tipme/contracts';

export type LaunchDecision = 'pass' | 'rewrite' | 'redirect-home' | 'exempt';

export function launchDecision({
  path,
  target,
  now,
}: {
  path: string;
  target: number | null;
  now: number;
}): LaunchDecision {
  const isPlainPath = !/(?:\/\/|%|\.\.|\\)/.test(path);
  const isHoldingPage = isPlainPath && path === '/coming-soon';

  if (target === null || now >= target)
    return isHoldingPage ? 'redirect-home' : 'pass';

  if (!isPlainPath) return 'rewrite';
  if (
    isHoldingPage ||
    path === '/api/revalidate' ||
    path === '/robots.txt' ||
    path === '/sitemap.xml' ||
    path === '/favicon.ico' ||
    // The tab, home-screen and Apple icons and their manifest (exact paths only).
    path === '/manifest.webmanifest' ||
    /^\/icons\/(favicon-(32|48)|apple-touch-icon|192|512-maskable)\.png$/.test(
      path,
    ) ||
    // The masks the holding page's logo is drawn from (globals.css .wordmark, .brandmark).
    /^\/brand\/tipme-(wordmark|mark)-(ink|accent)\.png$/.test(path) ||
    path === '/opengraph-image' ||
    // The logo every email loads (packages/mail layout.ts), exact names only.
    // The old names stay for emails already sent (they ask for them at 120 x 45).
    /^\/email\/tipme-logo-(2026-)?(light|dark)-(2x|3x)\.png$/.test(path) ||
    path.startsWith('/coming-soon/opengraph-image')
  )
    return 'exempt';

  return 'rewrite';
}

export function legacyProfileTarget(
  path: string,
  searchParams: URLSearchParams,
): string | null {
  const match = /^\/people\/([^/]+)$/.exec(path);
  if (!match?.[1]) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const handle = normaliseHandle(decoded);
  if (!handle) return null;
  const preserveQrSource =
    searchParams.getAll('src').length === 1 && searchParams.get('src') === 'qr';
  return `/@${handle}${preserveQrSource ? '?src=qr' : ''}`;
}
