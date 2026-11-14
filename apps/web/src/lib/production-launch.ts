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
    path === '/icon.svg' ||
    // The home-screen icons and their manifest (exact paths only).
    path === '/apple-icon' ||
    path === '/manifest.webmanifest' ||
    path === '/icons/192.png' ||
    path === '/icons/512-maskable.png' ||
    path === '/opengraph-image' ||
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
